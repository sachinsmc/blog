+++
title = "Separations and the Tail: A Field Guide to Distributed Backend Design"
date = 2026-06-22T21:00:00+04:00
draft = false
summary = "Most of what makes a distributed system good is a handful of disciplined separations plus a real respect for the tail. To make that concrete, we design a small identity graph service from scratch, the same shape of system Airbnb runs at 7 billion nodes, and watch each principle earn its place. Node.js snippets included."
tags = ["distributed-systems", "backend", "architecture", "system-design", "scalability"]
ShowToc = true
TocOpen = true
+++

> **What this is.** A practical guide to distributed backend design, built around one worked example. The example is inspired by [Airbnb's identity graph](https://medium.com/airbnb-engineering/scaling-airbnbs-identity-graph-with-a-unified-knowledge-graph-infrastructure-ebac467b7836), which runs at 7 billion nodes and 11 billion edges, but the design here is my own and deliberately smaller. The Node.js snippets are illustrative, not production code.

## The query that breaks your database

Start with an innocent question from a Trust and Safety team: "is this new account the same person as a banned one?"

On day one you answer it with a join. Accounts share a device, a payment fingerprint, an address, so you join `accounts` to `devices` to `accounts` and call it identity resolution. On day two the question becomes "is this account connected, within four hops, to any banned account through any shared signal?" Now you are writing a recursive self-join across a table with hundreds of millions of rows, and your database is doing a graph traversal while pretending to be a relational store. It works until it doesn't, and when it stops working it does so at exactly the worst time, under a P99 you cannot explain.

That is the moment a single-box, single-model design ends and a distributed system begins. The rest of this post is about doing that transition deliberately. The thesis is simple: a good distributed system is mostly a few **separations**, plus a real **respect for the tail**. Get those right and scaling is mechanical. Get them wrong and no amount of hardware saves you.

We will build the thing that answers the identity question: a graph service where accounts and signals are nodes, observations are edges, and the questions are multi-hop traversals.

{{< figure src="architecture.svg" alt="Producers emit events to a stream; an idempotent ingestion service writes to a graph store with a separate cache; a read service answers API queries with parallel fan-out; write and read paths scale independently" caption="The shape we are building toward. Note that the write path (left) and the read path (right) only meet at the store, and otherwise scale on their own." >}}

## Model for the access pattern, not the data

The first separation is between how data *is* and how it is *queried*. Identity data is relationships, and the queries are "walk the relationships." A relational store can hold that, but every query pays for the mismatch in joins. A graph store (a labeled property graph, queried with traversals) makes the access pattern native: nodes have labels and properties, edges have types, and "four hops from here" is one traversal instead of four joins.

Our model is small on purpose:

```js
// nodes: an account or a signal (device, payment fingerprint, address)
const node = { id: "acct:9f2", label: "account", props: { createdAt, country } };

// edges: an observed link, typed, directional, with provenance
const edge = { from: "acct:9f2", to: "dev:abc", type: "USED_DEVICE", observedAt };
```

Picking the model first is not a database-shopping decision, it is the decision that determines every later one: how you shard, what you cache, where the tail latency comes from. Airbnb landed on JanusGraph over a key-value backend for exactly this reason. You do not need their stack. You need their order of operations: model, then store.

## Separate storage from compute

The second separation is the one most teams skip and later regret. The thing that runs your traversals (the compute layer) and the thing that durably holds your bytes (the persistence layer) have different lifecycles, different scaling curves, and different failure modes. Couple them and you scale both when you need one, and you cannot replace either without replacing the other.

So put a seam there. The graph engine speaks traversals; behind a storage interface it reads and writes from whatever persists best (a managed key-value store, say). This is precisely the JanusGraph pattern: a pluggable backend so the graph layer and the storage layer evolve independently. The payoff is concrete. When writes spike you scale ingestion and storage without touching query nodes. When a gnarly traversal needs more CPU you scale compute without resharding your data.

The principle generalizes past graphs: **a stateless compute tier in front of a stateful storage tier** is the most reliable shape in distributed systems, because stateless things are trivial to scale and stateful things are where all the hard problems live. Keep the hard problems in one place.

## Split the read and write paths

Reads and writes in this system could not be more different. Writes are a firehose of small, independent observations: Airbnb takes about 5 million new edges per day. Reads are bursty, latency-sensitive, and expensive, since one read can fan out across thousands of edges. Sizing one path for the other wastes money on a good day and falls over on a bad one.

So isolate them. The write path is asynchronous: producers emit events, a stream buffers them, an ingestion service applies them.

```js
// write path: events arrive on a stream and are applied asynchronously.
// producers never block on the graph; the stream absorbs spikes.
stream.subscribe("identity-events", async (evt) => {
  await ingest.applyEdge(evt);   // upsert into the graph store
});
```

The read path is synchronous and tuned for latency, with its own service, its own cache, and its own scaling. They meet only at the store. Airbnb isolates read and write traffic in the compute layer for the same reason: a slow, resource-hungry write must not be able to degrade a user-facing read. Two paths, two budgets, one source of truth.

## Go async at the edges, strict at the core

Asynchrony buys you throughput and decoupling, but it hands you two problems: messages arrive more than once, and they arrive out of order. A good distributed system answers both at the boundary so the core stays simple.

**Idempotency.** If an edge event is delivered twice, applying it twice must equal applying it once. Key the edge deterministically and make the write conditional:

```js
// the same observation may be delivered more than once. Deterministic id
// + conditional write = applying it twice equals applying it once.
async function upsertEdge(db, { from, to, type, observedAt }) {
  const edgeId = `${type}:${from}->${to}`;
  await db.put({
    Item: { edgeId, from, to, type, observedAt },
    ConditionExpression:
      "attribute_not_exists(edgeId) OR observedAt < :t",   // newer wins, retries no-op
    ExpressionAttributeValues: { ":t": observedAt },
  }).catch(ignoreConditionalFailure);
}
```

**Strictness where it counts.** Most of the system is happily eventually consistent: a new edge showing up a second late is fine. But some writes are correctness-critical. Merging two identities into one must not interleave with another merge, or you corrupt the graph. That is where you spend a strong guarantee, with a compare-and-set on a version:

```js
// merging identities IS correctness-critical: compare-and-set on a version
// so two concurrent merges cannot interleave and corrupt the node.
async function mergeInto(db, survivor, merged, expectedVersion) {
  await db.update({
    Key: { id: survivor },
    UpdateExpression: "SET aliases = list_append(aliases, :m), version = :nv",
    ConditionExpression: "version = :ev",                  // optimistic concurrency
    ExpressionAttributeValues: {
      ":m": [merged], ":ev": expectedVersion, ":nv": expectedVersion + 1,
    },
  });
}
```

This is the real lesson behind Airbnb's "custom transaction strategy on top of conditional writes." You do not make the whole system strongly consistent; that is slow and usually pointless. You find the few writes that must be atomic and spend a conditional write there, and you let everything else be eventually consistent. Strong guarantees are a budget. Spend them where corruption is unrecoverable, nowhere else.

## Design for the tail, not the average

Here is the principle people learn last and wish they had learned first. At scale your average latency is a comforting lie. What pages you is P99, and in a graph the P99 has a name: the high-fanout node. Most accounts touch a handful of signals. A shared corporate IP or a popular device touches millions. A traversal that wanders into one of those tries to expand millions of edges and drags your tail to the floor.

Two defenses, both mandatory.

**Batch the fan-out.** Never do one query per neighbor. Expand a whole frontier in one batched call per hop:

```js
// expand a 2-hop neighborhood in batched waves: one call per hop,
// not one call per neighbor (which melts the tail on high-fanout nodes).
async function neighborsWithin2Hops(store, root) {
  const hop1 = await store.batchGetNeighbors([root]);
  const frontier = dedupe(hop1.flatMap((e) => e.to));
  const hop2 = await store.batchGetNeighbors(frontier);   // batched, deduped
  return { hop1, hop2 };
}
```

**Cap the fan-out.** A synchronous, user-facing read has no business expanding a million-edge node in full. Bound it, and be honest that you did:

```js
const MAX_FANOUT = 1000;
function expand(node) {
  if (node.degree > MAX_FANOUT) {
    return { neighbors: node.topEdgesByRecency(MAX_FANOUT), truncated: true };
  }
  return { neighbors: node.allEdges(), truncated: false };
}
```

The `truncated` flag matters as much as the cap. Silent truncation is a correctness bug wearing a performance costume; a surfaced flag lets the caller decide whether to push the heavy expansion to an offline path. Airbnb attacks the same tail with parallel query execution and client-side rewrites that strip expensive steps. Same goal: bound the worst case, do not just hope you never hit it.

## The things you only value during an incident

Three more, quickly, because they do not announce themselves until 3 a.m.

- **Multi-tenancy and isolation.** One shared graph serving many teams needs isolated namespaces with enforced schemas, or one team's bad write becomes everyone's incident. Isolation is not a feature you add later; retrofitting it means re-keying your data.
- **Observability is part of the system, not a dashboard you bolt on.** A four-to-eight-hop traversal that is slow is undebuggable without distributed tracing that shows you *which hop* and *which storage call* hurt. If you cannot see per-hop latency, you cannot fix the tail you just spent a section learning to fear.
- **Build versus buy is a real, ongoing cost.** Airbnb forked JanusGraph and took on operational ownership to get performance control and escape vendor lock-in. That is a legitimate trade, but it is a trade: you are buying control with engineer-years. Make it on purpose, not by drift.

## Putting it together, then making it smaller

The full shape is now: producers to a stream, an idempotent ingestion service writing through a storage seam into a graph store with a hot-subgraph cache, a separate read service doing batched, bounded, parallel fan-out behind an API, tenants isolated by namespace, tracing through every hop. That is a system that answers the four-hop identity question at scale without paging you.

And you should not build all of it on day one. The honest move is to start with the smallest thing that respects the principles without paying for the scale you do not have yet:

- One graph store, no separate cache, until reads actually hurt.
- Idempotent writes from the very first commit. This one is free and un-retrofittable, so never skip it.
- A fan-out cap from the very first read path, for the same reason.
- Read and write as separate *services* only once their scaling curves visibly diverge. Before that, separate *modules* with a clean seam is enough.

Every separation in this post is something you can add at the seam later *if* you put the seam in now. That is the whole craft: cheap seams early, expensive scaling late, and a fan-out cap before you think you need one. For the version of this system that runs at 7 billion nodes, with the war stories that justify each choice, read [Airbnb's writeup](https://medium.com/airbnb-engineering/scaling-airbnbs-identity-graph-with-a-unified-knowledge-graph-infrastructure-ebac467b7836). Then go build the small version, with the seams in the right places.
