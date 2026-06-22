+++
title = "Failover Before the First Byte: An OpenAI-Compatible LLM Gateway in Pure Go"
date = 2026-06-22T20:00:00+04:00
draft = false
summary = "I just shipped llm-relay, a small OpenAI-compatible LLM gateway in pure Go (zero third-party dependencies). The interesting part is the failover: when a provider is rate-limited or down, it switches to the next one BEFORE any bytes reach the client, so the caller never sees half a stream and then a different model. Here is how it works, with the real code."
tags = ["go", "llm", "openai", "infrastructure", "streaming", "open-source"]
ShowToc = true
TocOpen = true
+++

> **New project.** I just open-sourced [`llm-relay`](https://github.com/sachinsmc/llm-relay), an OpenAI-compatible LLM gateway and proxy written in pure Go. Zero third-party dependencies, just the standard library. MIT licensed, with a prebuilt multi-arch image on GHCR. This post is the design tour, focused on the part I find most interesting: failover that happens before the first byte.

## The problem

You are building something that talks to an LLM. The naive setup is to call the provider straight from your app:

```
mobile / web client  ──►  api.some-provider.com
```

That is fine until it isn't, and it fails in four predictable ways:

1. **Your API key ships with the client.** Anything in a mobile binary or a browser bundle can be extracted. Now your key is everyone's key.
2. **You are married to one provider.** The model id and base URL are baked into the client. Switching providers, or even models, means a client release and an app-store review cycle.
3. **Outages hit your users directly.** When the provider returns 429 or 503, your users get the error. You have no second option in the loop.
4. **There is no abuse ceiling.** One user (or one leaked key) can run up your bill with no per-user cap.

A relay in the middle fixes all four:

```
client (OpenAI SDK)  ──POST /v1/chat/completions──►  llm-relay  ──►  primary provider
   ▲                                                    │  fail over │
   └──────────────  SSE stream  ◄───────────────────────┘            ▼
                                                              fallback provider(s)
```

The client only ever talks to your relay. The upstream key and model live on the server. You can swap providers with an env var, you fail over on outages, and you cap usage per user. Every upstream speaks the OpenAI chat-completions wire format, so to the client nothing changes except the `base_url`.

## What llm-relay is

It is a single Go package (`relay`) plus a thin `cmd/llm-relay` server. You can run it three ways: a static binary, a distroless Docker image, or embedded directly in your own Go service as an `http.Handler`. It does four things:

- Keeps provider keys server-side and forces the model server-side.
- Streams the upstream's Server-Sent Events straight back to the caller.
- Fails over across an ordered chain of providers.
- Enforces a per-user daily turn quota.

The whole thing is the Go standard library and nothing else. Let me start with the failover, because that is the design decision everything else bends around.

## Failover before the first byte

{{< figure src="failover-flow.svg" alt="Client posts to llm-relay, which tries the primary provider, fails over to a fallback on 429/5xx/down, and streams SSE back to the client" caption="The relay tries the primary, fails over on 429/5xx/unreachable, and only then streams back. The switch happens before any bytes reach the client." >}}

Here is the subtle bug in most hand-rolled LLM proxies. They start streaming the response to the client, and only when the upstream errors do they try a fallback. But by then the client has already received part of an SSE stream. You cannot cleanly switch now: the caller has half a response from model A, and you are about to append tokens from model B. The result is a corrupted turn.

`llm-relay` avoids this by making failover happen entirely before it returns the stream to the transport. The core loop, in `StartStream`:

```go
// Try the primary, then fail over to each fallback when the upstream is
// exhausted (rate-limited) or down. Failover happens before any bytes reach
// the client, so it never sees a partial stream then a switch.
var lastErr error
for i, up := range s.upstreams {
    body, err := s.buildUpstreamBody(req, up)
    if err != nil {
        return nil, ErrBadRequest
    }
    rc, retryable, err := s.callUpstream(ctx, up, body)
    if err == nil {
        if i > 0 {
            s.logger.Info("served by fallback provider",
                slog.String("provider", up.name), slog.Int("attempt", i+1))
        }
        return rc, nil // a live, already-200 stream
    }
    lastErr = err
    if !retryable {
        break
    }
}
return nil, lastErr
```

The function only returns a reader once a provider has answered with `200 OK`. Until that happens, no bytes have been written to the client at all. So the caller gets a clean stream from whichever provider answered first, never a Frankenstream stitched from two.

The other half of this is deciding *when* failover is even appropriate. Not every error is worth retrying on the next provider. `callUpstream` classifies the failure and returns a `retryable` flag:

```go
resp, err := s.client.Do(httpReq)
if err != nil {
    // Network error or timeout: provider unreachable, fail over.
    return nil, true, fmt.Errorf("%w: %s: %v", ErrUpstream, up.name, err)
}
if resp.StatusCode != http.StatusOK {
    snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
    _ = resp.Body.Close()
    retryable := resp.StatusCode == http.StatusTooManyRequests ||
        resp.StatusCode == http.StatusRequestTimeout ||
        resp.StatusCode >= http.StatusInternalServerError
    return nil, retryable, fmt.Errorf("%w: %s: status %d: %s",
        ErrUpstream, up.name, resp.StatusCode, string(snippet))
}
return resp.Body, false, nil // success: hand back the live body
```

The rule: network failures, timeouts, `429`, and `5xx` are retryable, so the loop moves to the next provider. A `4xx` like `400`, `401`, or `403` is not. Those mean the payload or the credentials are wrong, and the next provider cannot fix a malformed request. Failing over on a `400` would just burn every provider in the chain on the same broken input, so the loop breaks and surfaces the error.

Note also that the upstream body is capped with `io.LimitReader(resp.Body, 2048)` before logging. An error body from a provider can be large or hostile, so only a snippet is read for the log line.

## Streaming passthrough

Once `StartStream` returns a live reader, the transport's only job is to shovel bytes and flush. But the ordering matters: any error has to be turned into a proper HTTP status *before* streaming starts, and once the first byte is out, you are committed. `ServeHTTP` reflects exactly that split.

First, errors map to status codes while it is still safe to set one:

```go
stream, err := h.svc.StartStream(r.Context(), h.userFunc(r), body)
if err != nil {
    switch {
    case errors.Is(err, ErrQuotaExceeded):
        writeError(w, http.StatusTooManyRequests, "rate_limited", "daily quota reached; it resets tomorrow")
    case errors.Is(err, ErrBadRequest):
        writeError(w, http.StatusBadRequest, "bad_request", "invalid request")
    case errors.Is(err, ErrUpstream):
        writeError(w, http.StatusBadGateway, "upstream_error", "the upstream provider is temporarily unavailable")
    // ...
    }
    return
}
```

Those sentinel errors (`ErrQuotaExceeded`, `ErrUpstream`, and friends) are defined in the `relay` package precisely so the transport can branch on them with `errors.Is` and pick a sensible status. This is why `StartStream` guarantees its errors come before any bytes: the contract is "you can still choose an HTTP status code."

Then the actual stream loop:

```go
w.Header().Set("Content-Type", "text/event-stream")
w.Header().Set("Cache-Control", "no-cache")
w.Header().Set("X-Accel-Buffering", "no") // don't let nginx buffer SSE
w.WriteHeader(http.StatusOK)

flusher, _ := w.(http.Flusher)
buf := make([]byte, 4096)
for {
    n, readErr := stream.Read(buf)
    if n > 0 {
        if _, writeErr := w.Write(buf[:n]); writeErr != nil {
            return // client gone
        }
        if flusher != nil {
            flusher.Flush()
        }
    }
    if readErr != nil {
        return // EOF or upstream/context error: stream is done
    }
}
```

Two details that matter in production. The `X-Accel-Buffering: no` header tells nginx not to buffer the response, which otherwise defeats streaming entirely (the client would get the whole answer at once). And the upstream call is tied to `r.Context()`, so when the client disconnects mid-stream, the context cancels, the upstream read returns an error, and the loop exits. No goroutine keeps draining tokens from the provider for a client that already left.

The relay does not parse the SSE frames. It does not need to. The bytes are already in OpenAI's wire format, so they pass through untouched, which also means tool-call deltas stream through with zero special handling.

## Provider-agnostic by design

Every supported provider speaks the same chat-completions format. The only real differences are the URL and a couple of header or body quirks. So the provider layer is deliberately tiny: a registry of known endpoints, and a resolve step.

```go
var knownProviders = map[string]providerQuirks{
    "openai":     {baseURL: "https://api.openai.com/v1/chat/completions"},
    "openrouter": {baseURL: "https://openrouter.ai/api/v1/chat/completions", supportsNoTrain: true, attribution: true},
    "groq":       {baseURL: "https://api.groq.com/openai/v1/chat/completions"},
    "cerebras":   {baseURL: "https://api.cerebras.ai/v1/chat/completions"},
    "gemini":     {baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"},
    // together, fireworks, deepseek, mistral ...
}
```

The registry exists only to save you from typing a URL for common cases. Any OpenAI-compatible endpoint works by setting `BaseURL` directly, including a local vLLM or Ollama. `resolve` turns a public `Provider` into an internal `upstream`, filling in the default URL for known names and erroring only when an unknown name has no explicit `BaseURL`:

```go
func resolve(p Provider) (upstream, error) {
    q, known := knownProviders[p.Name]
    baseURL := p.BaseURL
    if baseURL == "" {
        if !known {
            return upstream{}, fmt.Errorf("provider %q: BaseURL is required for unknown providers", p.Name)
        }
        baseURL = q.baseURL
    }
    return upstream{
        name:    p.Name,
        baseURL: baseURL,
        apiKey:  p.APIKey,
        model:   p.Model,
        noTrain: p.NoTrain && known && q.supportsNoTrain,
    }, nil
}
```

The two quirks worth calling out: `supportsNoTrain` gates the OpenRouter-style `{"provider":{"data_collection":"deny"}}` routing hint so it is only sent to providers that understand it, and `attribution` gates the optional `HTTP-Referer` / `X-Title` dashboard headers. Everything else is identical across providers.

Crucially, the model is forced server-side. `buildUpstreamBody` sets `"model": up.model` and `"stream": true` itself and forwards the client's `messages` and `tools` verbatim. The client cannot pick the model, and the key never leaves the server.

## What counts as a "turn"

The quota is per user per UTC day, and the unit is a *turn*, not an HTTP request. That distinction is the whole design of the limiter. The interface is one method:

```go
type Limiter interface {
    // Allow atomically reserves one turn for user on the given UTC date.
    // Returns false when the user is already at or above cap.
    // A cap of 0 means unlimited.
    Allow(ctx context.Context, user, date string, cap int) (bool, error)
}
```

The subtlety is in deciding when to call it. Two things must *not* count again:

- A **tool-result continuation.** When the model asks to call a tool, the client runs the tool and re-POSTs the result to continue the same turn. That second request should not cost a second turn.
- A **failover.** Switching providers mid-attempt is one logical turn, not two.

Failover is naturally free because the quota check runs once, before the failover loop. Tool continuations are handled by only counting when the last message is a fresh user message:

```go
func (s *Service) isUserTurn(messages []json.RawMessage) bool {
    var last struct {
        Role string `json:"role"`
    }
    if err := json.Unmarshal(messages[len(messages)-1], &last); err != nil {
        return true // be conservative: a parse miss never relays for free
    }
    return last.Role == "user"
}
```

If the final message is a `tool` result, it is a continuation and is not billed. If parsing fails, it counts, so an attacker cannot dodge the quota with a malformed final message.

The default `MemoryLimiter` is a mutex-guarded `map[date]map[user]int` that drops stale dates as the day rolls over, so it never grows unbounded. It is perfect for a single instance. Run more than one replica behind a load balancer and you swap in a shared `Limiter` (Redis, Postgres) so the cap holds across the fleet. The interface is the entire contract, so that swap is a few lines.

## Why zero dependencies

Modern Go makes the standard library enough for this whole job. A few things that used to need a framework or a library:

- **Routing.** Go 1.22+ `net/http.ServeMux` does method and path patterns, so `mux.Handle("POST /v1/chat/completions", svc.Handler())` is the entire router.
- **Structured logging.** `log/slog` gives JSON logs with no dependency.
- **Discard logger.** `slog.DiscardHandler` is the default when you embed the package and do not want its logs.

The payoff is a single static binary with nothing to audit but your own code and the Go toolchain, which goes straight into a distroless image and starts instantly. No transitive dependency tree, no supply-chain surface beyond stdlib.

## Using it

Point any OpenAI SDK at the relay and change only the base URL:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="unused")
stream = client.chat.completions.create(
    model="ignored-the-relay-sets-it",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
    extra_headers={"X-User-Id": "user-123"},  # the per-user quota key
)
```

Run it from the prebuilt image, with a primary and a fallback:

```sh
docker run --rm -p 8080:8080 \
  -e PROVIDER=groq    -e GROQ_API_KEY=$GROQ_KEY    -e GROQ_MODEL=llama-3.3-70b-versatile \
  -e FALLBACK=openai  -e OPENAI_API_KEY=$OPENAI_KEY -e OPENAI_MODEL=gpt-4o-mini \
  -e DAILY_CAP=50 \
  ghcr.io/sachinsmc/llm-relay:latest
```

`PROVIDER` is the primary, `FALLBACK` is a comma-separated chain, and each provider `N` reads `N_API_KEY`, `N_MODEL`, and optional `N_BASE_URL`. Or skip the server entirely and embed the package: `relay.New(cfg)` gives you a `*Service`, and `svc.Handler()` is a plain `http.Handler` you can mount on any router, with `WithUserFunc` to derive the quota key from a JWT or session instead of a header.

## Production touches

A few things that come in the box, because a gateway that holds your keys should not be a toy:

- **Distroless image** with no shell, built multi-arch, published to GHCR with SLSA build provenance and an SBOM.
- **Curl-less healthcheck.** The distroless image has no shell or curl, so the binary probes itself: `llm-relay --healthcheck` hits `/healthz` and returns an exit code for the container `HEALTHCHECK`.
- **Graceful shutdown.** `SIGINT` / `SIGTERM` trigger `srv.Shutdown` with a 10s deadline so in-flight streams can drain.
- **`ReadHeaderTimeout`** set on the server to blunt slow-loris style header attacks.

## Limitations and what is next

Being honest about the edges:

- The default limiter is in-memory and single-instance. Behind a load balancer you need a shared store; the `Limiter` interface is there for exactly that, but I have not shipped a Redis implementation yet.
- There is no in-provider retry or backoff. A `429` fails straight over to the next provider rather than retrying the same one after a delay. For a chain with a good fallback that is usually what you want, but it is a choice.
- No response caching and no token accounting beyond turn counting. Cost-based quotas would need to parse usage out of the stream.

If any of that is useful to you, the code is small enough to read in one sitting:

- **Repo:** [github.com/sachinsmc/llm-relay](https://github.com/sachinsmc/llm-relay)
- **Image:** `ghcr.io/sachinsmc/llm-relay:latest`
- **License:** MIT

It is new, so issues and PRs are very welcome. If you point it at a provider I have not listed and it just works, tell me, and I will add the name to the registry.
