// Benchmark suite on the reference tree. Run with `npm run bench`.
// Spawns itself with NICKLE_NO_NATIVE=1 to measure the fallback's open time.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { write, open, materialize } from "../dist/index.js";
import { mode } from "../dist/native.js";
import { countNodes, generate, rng, KEYS } from "./gen.mjs";

const gc = globalThis.gc ?? (() => {});
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

function runs(n, fn) {
  const times = [];
  for (let i = 0; i < n; i++) {
    gc();
    const t0 = process.hrtime.bigint();
    fn();
    times.push(ms(t0));
  }
  times.sort((a, b) => a - b);
  return { min: times[0], median: times[n >> 1], max: times[n - 1] };
}

function openTime(path) {
  return runs(21, () => open(path).close());
}

if (process.argv[2] === "--first-open") {
  const t0 = process.hrtime.bigint();
  open(process.argv[3]);
  console.log(JSON.stringify({ mode: mode(), ms: ms(t0) }));
  process.exit(0);
}

/** Median time of the first open() in a fresh process with a small heap. */
function firstOpen(path, env) {
  const times = [];
  for (let i = 0; i < 9; i++) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--first-open", path],
      { env: { ...process.env, ...env }, encoding: "utf8" });
    times.push(JSON.parse(out).ms);
  }
  return times.sort((a, b) => a - b)[4];
}

const dir = mkdtempSync(join(tmpdir(), "nickle-bench-"));
const path = join(dir, "ref.nkl");
try {
  const tree = generate();
  const json = JSON.stringify(tree);
  let t0 = process.hrtime.bigint();
  write(path, tree);
  const writeMs = ms(t0);
  const size = statSync(path).size;
  console.log(`reference tree: ${countNodes(tree).toLocaleString()} nodes, JSON ${(json.length / 1e6).toFixed(1)} MB, nickle ${(size / 1e6).toFixed(1)} MB (write ${writeMs.toFixed(0)} ms)`);
  console.log(`mode: ${mode()}\n`);

  const freshNative = firstOpen(path, { NICKLE_NO_NATIVE: "" });
  const freshFallback = firstOpen(path, { NICKLE_NO_NATIVE: "1" });
  // Repeated opens here, in a process holding the tree and its JSON (~300 MB of heap).
  const heavyOpen = openTime(path);

  const h = open(path);
  const parse = runs(7, () => JSON.parse(json));
  const mat = runs(7, () => materialize(h.root));

  // Lazy reads: items[i][key] for random (i, key), two property reads each.
  // The same loop over the plain tree is the baseline: it shows how much of
  // the cost is random memory access rather than the views.
  const r = rng(42);
  const OPS = 1_000_000;
  const n = tree.items.length;
  const idx = Int32Array.from({ length: OPS }, () => Math.floor(r() * n));
  const kid = Uint8Array.from({ length: OPS }, () => Math.floor(r() * KEYS.length));
  const readAll = (root) => {
    const items = root.items;
    let sink = 0;
    for (let j = 0; j < OPS; j++) if (items[idx[j]][KEYS[kid[j]]] !== undefined) sink++;
    return sink;
  };
  const perRead = (root) => {
    const t = process.hrtime.bigint();
    readAll(root);
    return (ms(t) * 1e6) / (OPS * 2);
  };
  h.close();
  const plainNs = perRead(tree);
  const lazy = open(path);
  const coldNs = perRead(lazy.root);
  const warmNs = perRead(lazy.root);
  lazy.close();

  const f = (x) => x.toFixed(2);
  console.log(`open, fresh process (native)    median ${f(freshNative)} ms`);
  console.log(`open, fresh process (fallback)  median ${f(freshFallback)} ms`);
  console.log(`open, ~300 MB heap (${mode()})    min ${f(heavyOpen.min)} ms, median ${f(heavyOpen.median)} ms, max ${f(heavyOpen.max)} ms`);
  console.log(`JSON.parse         min ${parse.min.toFixed(0)} ms, median ${parse.median.toFixed(0)} ms`);
  console.log(`materialize        min ${mat.min.toFixed(0)} ms, median ${mat.median.toFixed(0)} ms`);
  console.log(`plain objects      ${plainNs.toFixed(0)} ns/read (baseline, same loop)`);
  console.log(`lazy read, cold    ${coldNs.toFixed(0)} ns/read (first touch, includes view creation)`);
  console.log(`lazy read, warm    ${warmNs.toFixed(0)} ns/read (views cached)`);

  const checks = [
    [freshNative < 5, "open under 5 ms with native (fresh process)"],
    [mat.median < parse.median, "materialize beats JSON.parse"],
    [coldNs - plainNs < 200 && warmNs - plainNs < 200, "lazy reads add under ~200 ns over plain objects"],
  ];
  console.log("");
  for (const [ok, label] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (checks.some(([ok]) => !ok)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
