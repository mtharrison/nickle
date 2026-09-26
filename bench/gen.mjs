// Reference tree generator: seeded, ~2.9M nodes, 40 recurring keys.
// A node is any value in the tree (containers and leaves).

export const KEYS = [
  "id", "name", "type", "status", "createdAt", "updatedAt", "owner", "tags",
  "count", "score", "enabled", "parent", "children", "path", "size", "hash",
  "version", "labels", "meta", "value", "unit", "min", "max", "avg",
  "source", "target", "weight", "flags", "region", "zone", "priority", "notes",
  "email", "url", "lang", "title", "index", "ratio", "active", "deps",
];

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789-_./";
const UNI = ["é", "ü", "中", "文", "ключ", "🎉"];

export function generate(seed = 1, records = 94_000) {
  const r = rng(seed);
  const int = (n) => Math.floor(r() * n);
  const str = () => {
    const len = 3 + int(24);
    let s = "";
    for (let i = 0; i < len; i++) s += ALPHA[int(ALPHA.length)];
    if (r() < 0.03) s += UNI[int(UNI.length)];
    return s;
  };
  const leaf = () => {
    const p = r();
    if (p < 0.45) return str();
    if (p < 0.72) return int(1_000_000) - 1000;
    if (p < 0.85) return r() * 1000;
    if (p < 0.95) return r() < 0.5;
    return null;
  };
  const obj = (depth) => {
    const o = {};
    const n = depth === 0 ? 8 + int(9) : 2 + int(5);
    let k = int(KEYS.length);
    for (let i = 0; i < n; i++) {
      k = (k + 1 + int(3)) % KEYS.length;
      o[KEYS[k]] = value(depth);
    }
    return o;
  };
  const value = (depth) => {
    const p = r();
    if (depth < 2 && p < 0.1) {
      const a = [];
      const n = 1 + int(6);
      for (let i = 0; i < n; i++) a.push(r() < 0.3 && depth < 1 ? obj(depth + 1) : leaf());
      return a;
    }
    if (depth < 2 && p < 0.17) return obj(depth + 1);
    return leaf();
  };
  const items = [];
  for (let i = 0; i < records; i++) items.push(obj(0));
  return { meta: { seed, records, generator: "nickle-bench" }, items };
}

export function countNodes(v) {
  if (v === null || typeof v !== "object") return 1;
  let n = 1;
  for (const c of Array.isArray(v) ? v : Object.values(v)) n += countNodes(c);
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = generate();
  console.log(`nodes: ${countNodes(t)}`);
  console.log(`json bytes: ${Buffer.byteLength(JSON.stringify(t))}`);
}
