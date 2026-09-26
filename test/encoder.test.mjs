import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADER_SIZE, STR_ASCII, T_ARRAY, T_FLOAT, T_INT, T_OBJECT, T_STRING, T_TRUE, slotOffset, slotTag } from "../dist/format.js";
import { encode } from "../dist/encoder.js";
import { parse } from "./helpers.mjs";

test("object layout: header, keyIds, padding, slots", () => {
  const { ctx, header, keys } = parse(encode({ a: 1, b: true, c: "x" }));
  assert.deepEqual(keys, ["a", "b", "c"]);
  assert.equal(slotTag(header.rootLo), T_OBJECT);
  const off = slotOffset(header.rootLo, header.rootHi);
  assert.equal(off, HEADER_SIZE);
  const w = off / 4, u32 = ctx.u32;
  assert.equal(ctx.u8[off], T_OBJECT);
  assert.equal(u32[w + 1], 3);
  assert.deepEqual([...u32.subarray(w + 2, w + 5)], [0, 1, 2]);
  assert.equal(u32[w + 5], 0, "keyIds padded to 8 bytes");
  const s = w + 6;
  assert.equal(slotTag(u32[s]), T_INT);
  assert.equal(u32[s + 1], 1);
  assert.equal(slotTag(u32[s + 2]), T_TRUE);
  assert.equal(slotTag(u32[s + 4]), T_STRING);
  const strOff = slotOffset(u32[s + 4], u32[s + 5]);
  assert.equal(strOff, (s + 6) * 4, "string node follows its parent");
  assert.equal(ctx.u8[strOff], T_STRING);
  assert.equal(ctx.u8[strOff + 1], STR_ASCII);
  assert.equal(u32[strOff / 4 + 1], 1);
  assert.equal(String.fromCharCode(ctx.u8[strOff + 8]), "x");
});

test("keys are interned once across objects", () => {
  const { ctx, keys, header } = parse(encode([{ k: 1, j: 2 }, { j: 3, k: 4 }]));
  assert.deepEqual(keys, ["k", "j"]);
  const w = slotOffset(header.rootLo, header.rootHi) / 4;
  const second = slotOffset(ctx.u32[w + 4], ctx.u32[w + 5]) / 4;
  assert.deepEqual([...ctx.u32.subarray(second + 2, second + 4)], [1, 0], "insertion order kept");
});

test("sortIdx only for objects with more than 8 keys", () => {
  const eight = Object.fromEntries("hgfedcba".split("").map((k, i) => [k, i]));
  const nine = Object.fromEntries("ihgfedcba".split("").map((k, i) => [k, i]));
  const small = parse(encode(eight));
  const w8 = slotOffset(small.header.rootLo, small.header.rootHi) / 4;
  assert.equal(small.header.keyTableOffset, (w8 + 2 + 8 + 16) * 4, "no sortIdx for 8 keys");

  // Intern a..i in ascending order first, so the 9-key object's ids are descending.
  const big = parse(encode({ z: 0, p: Object.fromEntries(Object.entries(nine).reverse()), o: nine }));
  const root = slotOffset(big.header.rootLo, big.header.rootHi) / 4;
  const w = slotOffset(big.ctx.u32[root + 10], big.ctx.u32[root + 11]) / 4;
  const u32 = big.ctx.u32;
  assert.equal(u32[w + 1], 9);
  const ids = [...u32.subarray(w + 2, w + 11)];
  const sortW = w + 2 + 10 + 18;
  const perm = [...u32.subarray(sortW, sortW + 9)];
  assert.deepEqual(perm.map((p) => ids[p]), [...ids].sort((a, b) => a - b));
  assert.deepEqual(perm.map((p) => big.keys[ids[p]]), big.keys.slice(3));
  assert.deepEqual(perm, [8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test("array layout and 8-byte alignment of every node", () => {
  const value = [1.5, "é", [2], { a: "abcdefghij" }, -0];
  const { ctx, header } = parse(encode(value));
  const w = slotOffset(header.rootLo, header.rootHi) / 4;
  assert.equal(ctx.u8[w * 4], T_ARRAY);
  assert.equal(ctx.u32[w + 1], 5);
  const offs = [];
  const walk = (lo, hi) => {
    const tag = slotTag(lo);
    if (tag < T_FLOAT) return;
    const off = slotOffset(lo, hi);
    offs.push(off);
    if (tag === T_ARRAY || tag === T_OBJECT) {
      const n = ctx.u32[off / 4 + 1];
      const s = off / 4 + 2 + (tag === T_OBJECT ? n + (n & 1) : 0);
      for (let i = 0; i < n; i++) walk(ctx.u32[s + 2 * i], ctx.u32[s + 2 * i + 1]);
    }
  };
  walk(header.rootLo, header.rootHi);
  assert.equal(offs.length, 7);
  for (const off of offs) assert.equal(off % 8, 0);
  assert.equal(ctx.f64[slotOffset(ctx.u32[w + 2], ctx.u32[w + 3]) / 8], 1.5);
  const e = slotOffset(ctx.u32[w + 4], ctx.u32[w + 5]);
  assert.equal(ctx.u8[e + 1], 0, "non-ASCII flag clear");
  assert.equal(ctx.u32[e / 4 + 1], 2, "utf8 byte length");
  assert.equal(header.fileLength % 8, 0);
  assert.equal(header.fileLength, ctx.u8.length);
});
