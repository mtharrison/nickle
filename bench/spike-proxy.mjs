// Spike 2.1: Proxy view over a hand-built buffer with D3 key lookup.
// Builds an array of objects (5 keys = linear scan, 12 keys = sortIdx binary
// search) whose values are int32 slots, then times property reads.

const T_INT = 3, T_ARRAY = 6, T_OBJECT = 7;
const KEYS = Array.from({ length: 40 }, (_, i) => `key${i}`);

function build(nObjs, nKeys) {
  const words = [];
  const push32 = (v) => words.push(v >>> 0);
  const pad8 = () => { if (words.length & 1) push32(0); };
  const offsets = [];
  for (let o = 0; o < nObjs; o++) {
    offsets.push(words.length * 4);
    push32(T_OBJECT); push32(nKeys);
    // Insertion order is reversed ids so sortIdx is a non-trivial permutation.
    const ids = Array.from({ length: nKeys }, (_, i) => (nKeys - 1 - i) * 3);
    for (const id of ids) push32(id);
    pad8();
    for (let i = 0; i < nKeys; i++) { push32(T_INT); push32(o * 100 + i); }
    if (nKeys > 8) {
      const perm = ids.map((id, i) => [id, i]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
      for (const p of perm) push32(p);
      pad8();
    }
  }
  const arrOff = words.length * 4;
  push32(T_ARRAY); push32(nObjs);
  for (const off of offsets) { push32(off | T_OBJECT); push32(0); }
  return { u32: Uint32Array.from(words), arrOff };
}

class Ctx {
  constructor(u32) {
    this.u32 = u32;
    this.keyMap = new Map(KEYS.map((k, i) => [k, i]));
    this.closed = false;
  }
}

function findPos(u32, w, count, id) {
  const ids = w + 2;
  if (count <= 8) {
    for (let i = 0; i < count; i++) if (u32[ids + i] === id) return i;
    return -1;
  }
  const sort = ids + ((count + 1) & ~1) + count * 2;
  let lo = 0, hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const p = u32[sort + mid];
    const k = u32[ids + p];
    if (k === id) return p;
    if (k < id) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

function decode(ctx, view, slotW, pos) {
  const u32 = ctx.u32;
  const lo = u32[slotW + pos * 2];
  switch (lo & 7) {
    case T_INT: return u32[slotW + pos * 2 + 1] | 0;
    case T_OBJECT: {
      let cache = view.cache;
      if (cache === undefined) cache = view.cache = new Map();
      let v = cache.get(pos);
      if (v === undefined) { v = objView(ctx, (lo & ~7) >>> 2); cache.set(pos, v); }
      return v;
    }
  }
}

class ObjHandler {
  constructor(ctx, w) {
    this.ctx = ctx; this.w = w; this.count = ctx.u32[w + 1]; this.cache = undefined;
    this.slotW = w + 2 + ((this.count + 1) & ~1);
  }
  get(target, key, receiver) {
    const ctx = this.ctx;
    if (ctx.closed) throw new Error("closed");
    if (typeof key === "string") {
      const id = ctx.keyMap.get(key);
      if (id !== undefined) {
        const pos = findPos(ctx.u32, this.w, this.count, id);
        if (pos >= 0) return decode(ctx, this, this.slotW, pos);
      }
    }
    return Reflect.get(target, key, receiver);
  }
}

class ArrHandler {
  constructor(ctx, w) { this.ctx = ctx; this.w = w; this.len = ctx.u32[w + 1]; this.cache = undefined; }
  get(target, key, receiver) {
    const ctx = this.ctx;
    if (ctx.closed) throw new Error("closed");
    if (typeof key === "string") {
      const c = key.charCodeAt(0);
      if (c >= 48 && c <= 57) {
        const i = +key;
        if (i < this.len && String(i) === key) return decode(ctx, this, this.w + 2, i);
      }
    }
    return Reflect.get(target, key, receiver);
  }
}

const objView = (ctx, w) => new Proxy({}, new ObjHandler(ctx, w));
const arrView = (ctx, w) => {
  const t = []; t.length = ctx.u32[w + 1];
  return new Proxy(t, new ArrHandler(ctx, w));
};

function time(label, iters, fn) {
  for (let i = 0; i < 3; i++) fn(Math.min(iters, 200_000)); // warm up
  const t0 = process.hrtime.bigint();
  const sink = fn(iters);
  const ns = Number(process.hrtime.bigint() - t0) / iters;
  console.log(`${label.padEnd(44)} ${ns.toFixed(1).padStart(7)} ns/read  (sink ${sink})`);
  return ns;
}

const N = 10_000, ITERS = 5_000_000;
const results = {};
for (const nKeys of [5, 12]) {
  const { u32, arrOff } = build(N, nKeys);
  const ctx = new Ctx(u32);
  const root = arrView(ctx, arrOff >>> 2);
  const hot = root[0];
  const k = `key${(nKeys - 1) * 3}`, k2 = "key0";
  results[`hot-${nKeys}`] = time(`same view, ${nKeys} keys: v.${k}`, ITERS, (n) => {
    let s = 0; for (let i = 0; i < n; i++) s += hot[i & 1 ? k : k2]; return s;
  });
  results[`missing-${nKeys}`] = time(`same view, ${nKeys} keys: missing key`, ITERS, (n) => {
    let s = 0; for (let i = 0; i < n; i++) s += hot.nope === undefined ? 1 : 0; return s;
  });
  results[`walk-${nKeys}`] = time(`root[i].${k} across ${N} cached views (2 reads)`, ITERS, (n) => {
    let s = 0; for (let i = 0; i < n; i++) s += root[i % N][k]; return s;
  });
  // Cold: fresh root each pass, so every object view is created on first touch.
  results[`cold-${nKeys}`] = time(`cold: first touch root[i].${k} (view alloc)`, N * 50, (n) => {
    let s = 0, r = arrView(ctx, arrOff >>> 2);
    for (let i = 0; i < n; i++) { if (i % N === 0) r = arrView(ctx, arrOff >>> 2); s += r[i % N][k]; }
    return s;
  });
  const plain = Array.from({ length: N }, (_, o) => Object.fromEntries(
    Array.from({ length: nKeys }, (_, i) => [`key${(nKeys - 1 - i) * 3}`, o * 100 + i])));
  results[`plain-${nKeys}`] = time(`baseline plain objects: arr[i].${k}`, ITERS, (n) => {
    let s = 0; for (let i = 0; i < n; i++) s += plain[i % N][k]; return s;
  });
}
console.log(JSON.stringify(results));
