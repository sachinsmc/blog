// One-off generator: builds matching .excalidraw (editable source) and .svg
// (rendered, embeddable) for the blog diagrams from a shared layout.
// Run: node gen-diagrams.mjs
import { writeFileSync } from "node:fs";

let seq = 0;
const idx = () => "a" + (seq++).toString(36).padStart(2, "0");

// ---- Excalidraw element builders (valid v2 elements) ----
let nonce = 1000;
const base = (over) => ({
  angle: 0, strokeColor: "#1e293b", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
  opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 },
  seed: ++nonce, version: 1, versionNonce: ++nonce, isDeleted: false,
  boundElements: [], updated: 1, link: null, locked: false, index: idx(),
  ...over,
});
const rect = (x, y, w, h, stroke, fill) => base({
  type: "rectangle", x, y, width: w, height: h, strokeColor: stroke,
  backgroundColor: fill, roundness: { type: 3 },
});
const text = (x, y, w, s, color, size = 16) => base({
  type: "text", x, y, width: w, height: size * 1.25 * s.split("\n").length,
  strokeColor: color, text: s, fontSize: size, fontFamily: 1,
  textAlign: "center", verticalAlign: "middle", containerId: null,
  originalText: s, lineHeight: 1.25, autoResize: true, roundness: null,
});
const arrow = (x, y, dx, dy, color, dashed) => base({
  type: "arrow", x, y, width: Math.abs(dx), height: Math.abs(dy),
  strokeColor: color, strokeStyle: dashed ? "dashed" : "solid",
  points: [[0, 0], [dx, dy]], lastCommittedPoint: null, startBinding: null,
  endBinding: null, startArrowhead: null, endArrowhead: "arrow",
  roundness: null,
});

const scene = (elements) => JSON.stringify({
  type: "excalidraw", version: 2, source: "https://sachinsmc.me",
  elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null },
  files: {},
}, null, 2);

// ---- SVG renderer (clean light card, reads on dark + light pages) ----
const PALETTE = {
  client: { fill: "#eef2ff", stroke: "#6366f1", text: "#312e81" },
  core:   { fill: "#e0f2fe", stroke: "#0284c7", text: "#0c4a6e" },
  node:   { fill: "#f1f5f9", stroke: "#475569", text: "#334155" },
  good:   { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" },
  bad:    { fill: "#fee2e2", stroke: "#dc2626", text: "#7f1d1d" },
};
function svg(W, H, boxes, arrows, title) {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const box = (b) => {
    const p = PALETTE[b.role];
    const lines = b.label.split("\n");
    const ty = b.y + b.h / 2 - (lines.length - 1) * 9;
    const txt = lines.map((l, i) =>
      `<text x="${b.x + b.w / 2}" y="${ty + i * 18}" text-anchor="middle" `
      + `dominant-baseline="middle" font-size="${i ? 12 : 14}" `
      + `font-weight="${i ? 400 : 600}" fill="${p.text}" `
      + `font-family="ui-sans-serif,system-ui,sans-serif">${esc(l)}</text>`).join("");
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" `
      + `fill="${p.fill}" stroke="${p.stroke}" stroke-width="2"/>${txt}`;
  };
  const arr = (a) => {
    const col = a.role === "bad" ? "#dc2626" : a.role === "good" ? "#16a34a" : "#64748b";
    const dash = a.dashed ? ` stroke-dasharray="6 5"` : "";
    const mid = `${(a.x1 + a.x2) / 2}`;
    const lbl = a.label
      ? `<text x="${a.lx ?? mid}" y="${a.ly ?? (a.y1 + a.y2) / 2 - 6}" `
        + `text-anchor="${a.anchor ?? "middle"}" font-size="12" fill="${col}" `
        + `font-family="ui-sans-serif,system-ui,sans-serif">${esc(a.label)}</text>` : "";
    return `<line x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}" `
      + `stroke="${col}" stroke-width="2"${dash} marker-end="url(#ah-${a.role || "n"})"/>${lbl}`;
  };
  const marker = (id, c) =>
    `<marker id="ah-${id}" markerWidth="9" markerHeight="9" refX="7" refY="3" `
    + `orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3 L0,6 Z" fill="${c}"/></marker>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<defs>${marker("n", "#64748b")}${marker("good", "#16a34a")}${marker("bad", "#dc2626")}</defs>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="#ffffff" stroke="#e2e8f0" stroke-width="2"/>
${arrows.map(arr).join("\n")}
${boxes.map(box).join("\n")}
</svg>`;
}

// ============ Diagram 1: llm-relay failover flow ============
{
  const W = 760, H = 440;
  const cx = W / 2;
  const boxes = [
    { id: "client", x: cx - 130, y: 30, w: 260, h: 56, role: "client", label: "Client (OpenAI SDK)\nPOST /v1/chat/completions" },
    { id: "relay", x: cx - 110, y: 160, w: 220, h: 56, role: "core", label: "llm-relay\nquota + model + key" },
    { id: "primary", x: 70, y: 300, w: 250, h: 60, role: "node", label: "Primary provider\ne.g. Groq" },
    { id: "fallback", x: 440, y: 300, w: 250, h: 60, role: "node", label: "Fallback provider(s)\ne.g. OpenAI" },
  ];
  const arrows = [
    { x1: cx, y1: 86, x2: cx, y2: 158, role: "n" },
    { x1: cx - 40, y1: 216, x2: 200, y2: 298, role: "n", label: "1. try primary", lx: 150, ly: 256 },
    { x1: 320, y1: 330, x2: 438, y2: 330, role: "bad", dashed: true, label: "2. 429 / 5xx / down", ly: 322 },
    { x1: cx + 60, y1: 216, x2: 560, y2: 298, role: "n", label: "3. fail over", lx: 560, ly: 256, anchor: "start" },
    { x1: cx + 70, y1: 158, x2: cx + 70, y2: 88, role: "good", label: "SSE stream", lx: cx + 80, ly: 124, anchor: "start" },
  ];
  const note = { id: "note", x: cx - 255, y: 388, w: 510, h: 40, role: "good", label: "failover completes BEFORE the first byte reaches the client" };
  writeFileSync("content/blog/llm-relay-openai-gateway-go/failover-flow.svg",
    svg(W, H, [...boxes, note], arrows, "llm-relay failover flow"));

  seq = 0; nonce = 1000;
  const els = [];
  for (const b of boxes.concat(note)) {
    const p = PALETTE[b.role];
    els.push(rect(b.x, b.y, b.w, b.h, p.stroke, p.fill));
    els.push(text(b.x, b.y + b.h / 2 - 10, b.w, b.label, p.text, 14));
  }
  for (const a of arrows) els.push(arrow(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1,
    a.role === "bad" ? "#dc2626" : a.role === "good" ? "#16a34a" : "#64748b", a.dashed));
  writeFileSync("content/blog/llm-relay-openai-gateway-go/failover-flow.excalidraw", scene(els));
}

// ============ Diagram 2: RAG authorization decision-flow ============
{
  const W = 760, H = 520;
  const cx = 300;
  const boxes = [
    { id: "client", x: cx - 130, y: 30, w: 260, h: 54, role: "client", label: "Client\nquery + JWT" },
    { id: "policy", x: cx - 140, y: 140, w: 280, h: 58, role: "core", label: "Policy engine\nVerified Permissions / Cedar" },
    { id: "deny", x: 600, y: 142, w: 130, h: 54, role: "bad", label: "403\nnothing retrieved" },
    { id: "kb", x: cx - 150, y: 258, w: 300, h: 62, role: "node", label: "Knowledge base .retrieve\nfilter: tenant_id = <scope>" },
    { id: "docs", x: 600, y: 262, w: 130, h: 54, role: "node", label: "tenant docs\n+ .metadata.json" },
    { id: "llm", x: cx - 120, y: 378, w: 240, h: 54, role: "core", label: "LLM\ngrounded generation" },
    { id: "answer", x: cx - 130, y: 458, w: 260, h: 48, role: "good", label: "tenant-scoped answer" },
  ];
  const arrows = [
    { x1: cx, y1: 84, x2: cx, y2: 138, role: "n" },
    { x1: cx + 140, y1: 169, x2: 598, y2: 169, role: "bad", dashed: true, label: "deny", ly: 161 },
    { x1: cx, y1: 198, x2: cx, y2: 256, role: "good", label: "allow + tenant scope", lx: cx + 10, ly: 230, anchor: "start" },
    { x1: 598, y1: 289, x2: 452, y2: 289, role: "n", dashed: true, label: "tag source", ly: 281 },
    { x1: cx, y1: 320, x2: cx, y2: 376, role: "n", label: "scoped chunks", lx: cx + 10, ly: 352, anchor: "start" },
    { x1: cx, y1: 432, x2: cx, y2: 456, role: "good" },
  ];
  writeFileSync("content/blog/multi-tenant-rag-authorization-boundary/decision-flow.svg",
    svg(W, H, boxes, arrows, "multi-tenant RAG authorization decision flow"));

  seq = 0; nonce = 2000;
  const els = [];
  for (const b of boxes) {
    const p = PALETTE[b.role];
    els.push(rect(b.x, b.y, b.w, b.h, p.stroke, p.fill));
    els.push(text(b.x, b.y + b.h / 2 - 10, b.w, b.label, p.text, 14));
  }
  for (const a of arrows) els.push(arrow(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1,
    a.role === "bad" ? "#dc2626" : a.role === "good" ? "#16a34a" : "#64748b", a.dashed));
  writeFileSync("content/blog/multi-tenant-rag-authorization-boundary/decision-flow.excalidraw", scene(els));
}

// ============ Diagram 3: TurboQuant pipeline ============
{
  const W = 640, H = 560, cx = 320;
  const boxes = [
    { id: "in", x: cx - 150, y: 30, w: 300, h: 54, role: "client", label: "Input vectors\nKV cache / embeddings" },
    { id: "rot", x: cx - 160, y: 138, w: 320, h: 58, role: "core", label: "Random rotation (Qx)\nisotropic geometry, data-free" },
    { id: "polar", x: cx - 160, y: 250, w: 320, h: 58, role: "node", label: "PolarQuant\nradius + angles, 3-4 bit, ~no constants" },
    { id: "qjl", x: cx - 160, y: 362, w: 320, h: 58, role: "node", label: "QJL residual\n1-bit sign projections, 0 overhead" },
    { id: "out", x: cx - 150, y: 474, w: 300, h: 56, role: "good", label: "Compressed code\n3-4 bits/value, >=6x smaller, training-free" },
  ];
  const arrows = [
    { x1: cx, y1: 84, x2: cx, y2: 136, role: "n" },
    { x1: cx, y1: 196, x2: cx, y2: 248, role: "n", label: "looks Gaussian", lx: cx + 10, ly: 226, anchor: "start" },
    { x1: cx, y1: 308, x2: cx, y2: 360, role: "n", label: "small residual", lx: cx + 10, ly: 338, anchor: "start" },
    { x1: cx, y1: 420, x2: cx, y2: 472, role: "good" },
  ];
  writeFileSync("content/blog/turboquant-data-free-quantization/pipeline.svg",
    svg(W, H, boxes, arrows, "TurboQuant two-stage pipeline"));

  seq = 0; nonce = 3000;
  const els = [];
  for (const b of boxes) {
    const p = PALETTE[b.role];
    els.push(rect(b.x, b.y, b.w, b.h, p.stroke, p.fill));
    els.push(text(b.x, b.y + b.h / 2 - 10, b.w, b.label, p.text, 14));
  }
  for (const a of arrows) els.push(arrow(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1,
    a.role === "good" ? "#16a34a" : "#64748b", a.dashed));
  writeFileSync("content/blog/turboquant-data-free-quantization/pipeline.excalidraw", scene(els));
}

// ============ Diagram 4: read/write path architecture ============
{
  const W = 820, H = 470;
  const boxes = [
    // write path (left to center)
    { id: "src", x: 30, y: 40, w: 150, h: 56, role: "client", label: "Producers\nsignups, logins, devices" },
    { id: "stream", x: 30, y: 150, w: 150, h: 50, role: "node", label: "Event stream\n(Kafka)" },
    { id: "ingest", x: 30, y: 258, w: 150, h: 56, role: "core", label: "Ingestion\nidempotent upsert" },
    // core store
    { id: "store", x: 320, y: 150, w: 180, h: 70, role: "core", label: "Graph store\ncompute / persistence split" },
    { id: "cache", x: 340, y: 285, w: 140, h: 48, role: "node", label: "KV cache\nhot subgraphs" },
    // read path (center to right)
    { id: "api", x: 640, y: 40, w: 150, h: 50, role: "client", label: "Read API\n/resolve, /neighbors" },
    { id: "rcompute", x: 640, y: 150, w: 150, h: 70, role: "core", label: "Read service\nparallel fan-out" },
    { id: "client2", x: 640, y: 285, w: 150, h: 48, role: "good", label: "Trust & Safety\nconsumers" },
  ];
  const arrows = [
    { x1: 105, y1: 96, x2: 105, y2: 148, role: "n" },
    { x1: 105, y1: 200, x2: 105, y2: 256, role: "n" },
    { x1: 180, y1: 282, x2: 318, y2: 200, role: "n", label: "writes", ly: 232 },
    { x1: 410, y1: 220, x2: 410, y2: 283, role: "n", label: "warm", lx: 420, ly: 256, anchor: "start" },
    { x1: 715, y1: 90, x2: 715, y2: 148, role: "n" },
    { x1: 638, y1: 185, x2: 502, y2: 185, role: "good", label: "reads", ly: 177 },
    { x1: 488, y1: 305, x2: 638, y2: 305, role: "n", dashed: true, label: "cache hit", ly: 297 },
    { x1: 715, y1: 220, x2: 715, y2: 283, role: "good" },
  ];
  const note = { id: "n2", x: 235, y: 392, w: 350, h: 38, role: "good", label: "write path and read path scale independently" };
  writeFileSync("content/blog/distributed-systems-field-guide/architecture.svg",
    svg(W, H, [...boxes, note], arrows, "read/write path architecture"));
  seq = 0; nonce = 4000;
  const els = [];
  for (const b of [...boxes, note]) {
    const p = PALETTE[b.role];
    els.push(rect(b.x, b.y, b.w, b.h, p.stroke, p.fill));
    els.push(text(b.x, b.y + b.h / 2 - 10, b.w, b.label, p.text, 13));
  }
  for (const a of arrows) els.push(arrow(a.x1, a.y1, a.x2 - a.x1, a.y2 - a.y1,
    a.role === "good" ? "#16a34a" : "#64748b", a.dashed));
  writeFileSync("content/blog/distributed-systems-field-guide/architecture.excalidraw", scene(els));
}

console.log("wrote 4 .svg + 4 .excalidraw");
