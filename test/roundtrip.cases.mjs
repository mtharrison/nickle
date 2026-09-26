// Seeded property test: random trees -> write -> open -> compare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { write, open, materialize } from "../dist/index.js";
import { mode } from "../dist/native.js";
import { rng } from "../bench/gen.mjs";
import { tempDir } from "./helpers.mjs";

const CASES = 1000;
const dir = tempDir();

const NUMBERS = [0, -0, 1, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, -(2 ** 31) - 1, 2 ** 53 - 1, -(2 ** 53),
  0.1, -1.5e-300, 5e-324, Number.MAX_VALUE, NaN, Infinity, -Infinity];
const CHARS = ["a", "Z", "0", " ", "_", "\n", "\0", "é", "ß", "中", "ключ", "🎉", "\u{10FFFF}", "�", "\u007F", "\u0080"];
const KEYS = ["", "a", "b", "id", "name", "0", "1", "10", "01", "-1", "__proto__", "constructor", "toString", "length", "ключ", "🎉", "a b"];

function randomTree(seed) {
  const r = rng(seed);
  const int = (n) => Math.floor(r() * n);
  const str = () => {
    let s = "";
    for (let i = 0, n = int(r() < 0.8 ? 10 : 300); i < n; i++) s += CHARS[int(CHARS.length)];
    return s;
  };
  const value = (depth) => {
    const p = depth === 0 ? r() * 0.4 : r(); // roots are always containers
    if (depth < 5 && p < 0.2) {
      const a = [];
      for (let i = 0, n = int(r() < 0.9 ? 6 : 40); i < n; i++) a.push(value(depth + 1));
      return a;
    }
    if (depth < 5 && p < 0.4) {
      const o = r() < 0.05 ? Object.create(null) : {};
      for (let i = 0, n = int(r() < 0.8 ? 6 : 30); i < n; i++) {
        const k = r() < 0.7 ? KEYS[int(KEYS.length)] : str();
        Object.defineProperty(o, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return o;
    }
    if (p < 0.55) return NUMBERS[int(NUMBERS.length)];
    if (p < 0.7) return int(2 ** 32) - 2 ** 31;
    if (p < 0.8) return (r() - 0.5) * 10 ** int(20);
    if (p < 0.93) return str();
    return [null, true, false][int(3)];
  };
  return value(0);
}

/** Deep equality with Object.is leaves, key order and array-ness. Works on views too. */
function same(a, b, path = "root") {
  if (typeof a !== "object" || a === null) {
    assert.ok(Object.is(a, b), `${path}: ${String(a)} !== ${String(b)}`);
    return;
  }
  assert.equal(typeof b, "object", path);
  assert.notEqual(b, null, path);
  assert.equal(Array.isArray(a), Array.isArray(b), `${path}: array-ness`);
  const ka = Object.keys(a), kb = Object.keys(b);
  assert.deepEqual(kb, ka, `${path}: keys`);
  for (const k of ka) same(a[k], b[k], `${path}[${JSON.stringify(k)}]`);
}

test(`[${mode()}] ${CASES} seeded random trees round-trip`, () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const tree = randomTree(seed);
    const p = join(dir, `rt-${seed}.nkl`);
    write(p, tree);
    const h = open(p);
    try {
      same(tree, materialize(h.root), `seed ${seed}: materialized`);
      same(tree, h.root, `seed ${seed}: view`);
    } finally {
      h.close();
    }
  }
});
