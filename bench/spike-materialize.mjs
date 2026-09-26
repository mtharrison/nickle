// Spike 2.3: materialize decoder on the reference tree vs JSON.parse.
// Run after `npm run build`.

import { generate, countNodes } from "./gen.mjs";
import { encode } from "../dist/encoder.js";
import { Ctx, materializeSlot } from "../dist/decode.js";
import { readHeader } from "../dist/format.js";

const tree = generate();
const json = JSON.stringify(tree);
const bin = encode(tree);
const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
console.log(`nodes ${countNodes(tree)}, json ${(json.length / 1e6).toFixed(1)} MB, nickle ${(bin.length / 1e6).toFixed(1)} MB`);

const dv = new DataView(ab);
const h = readHeader(dv);
const keys = [];
let p = h.keyTableOffset + 4;
for (let i = 0, n = dv.getUint32(h.keyTableOffset, true); i < n; i++) {
  const len = dv.getUint32(p, true);
  keys.push(Buffer.from(ab, p + 4, len).toString("utf8"));
  p += 4 + len;
}
const ctx = new Ctx(ab, keys);

function best(label, runs, fn) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    globalThis.gc?.();
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${label.padEnd(14)} min ${times[0].toFixed(0)} ms, median ${times[runs >> 1].toFixed(0)} ms`);
  return { min: times[0], median: times[runs >> 1] };
}

const m = materializeSlot(ctx, h.rootLo, h.rootHi);
if (JSON.stringify(m) !== json) throw new Error("materialize mismatch");

const r = {
  jsonParse: best("JSON.parse", 7, () => JSON.parse(json)),
  materialize: best("materialize", 7, () => materializeSlot(ctx, h.rootLo, h.rootHi)),
};
console.log(JSON.stringify(r));
