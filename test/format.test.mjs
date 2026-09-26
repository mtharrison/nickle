import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEADER_SIZE, MAGIC, VERSION, T_ARRAY, T_FALSE, T_FLOAT, T_INT, T_NULL, T_OBJECT, T_STRING, T_TRUE,
  isInt32, readHeader, setInlineSlot, setOffsetSlot, slotOffset, slotTag, writeHeader,
} from "../dist/format.js";
import { decodeLeaf } from "../dist/decode.js";
import { encode } from "../dist/encoder.js";
import { parse } from "./helpers.mjs";

const roundTrip = (v) => {
  const { ctx, header } = parse(encode(v));
  return decodeLeaf(ctx, header.rootLo, header.rootHi);
};

test("tags are the eight 3-bit values", () => {
  assert.deepEqual([T_NULL, T_FALSE, T_TRUE, T_INT, T_FLOAT, T_STRING, T_ARRAY, T_OBJECT], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("inline slots round-trip null, booleans and int32 edges", () => {
  const u32 = new Uint32Array(2);
  for (const [tag, payload, expected] of [
    [T_NULL, 0, null], [T_FALSE, 0, false], [T_TRUE, 0, true],
    [T_INT, 0, 0], [T_INT, 1, 1], [T_INT, -1, -1],
    [T_INT, 2 ** 31 - 1, 2 ** 31 - 1], [T_INT, -(2 ** 31), -(2 ** 31)],
  ]) {
    setInlineSlot(u32, 0, tag, payload);
    assert.equal(slotTag(u32[0]), tag);
    assert.equal(decodeLeaf({}, u32[0], u32[1]), expected);
  }
});

test("isInt32 excludes -0, fractions and out-of-range integers", () => {
  for (const n of [0, -1, 2 ** 31 - 1, -(2 ** 31)]) assert.ok(isInt32(n), String(n));
  for (const n of [-0, 0.5, 2 ** 31, -(2 ** 31) - 1, NaN, Infinity]) assert.ok(!isInt32(n), String(n));
});

test("offset slots round-trip offsets above 2^31 and 2^32", () => {
  const u32 = new Uint32Array(2);
  for (const off of [0, 8, 2 ** 31, 2 ** 32 - 8, 2 ** 32, 2 ** 40 + 64]) {
    for (const tag of [T_FLOAT, T_STRING, T_ARRAY, T_OBJECT]) {
      setOffsetSlot(u32, 0, tag, off);
      assert.equal(slotTag(u32[0]), tag);
      assert.equal(slotOffset(u32[0], u32[1]), off);
    }
  }
});

test("every leaf type round-trips through encode", () => {
  for (const v of [null, false, true, 0, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, -(2 ** 31) - 1,
    0.1, 2 ** 53 - 1, Infinity, -Infinity, "", "hi", "longer ascii string", "ключ 🎉"]) {
    assert.ok(Object.is(roundTrip(v), v), String(v));
  }
});

test("-0 and NaN round-trip as floats", () => {
  assert.ok(Object.is(roundTrip(-0), -0));
  assert.ok(Object.is(roundTrip(NaN), NaN));
  const { header } = parse(encode(-0));
  assert.equal(slotTag(header.rootLo), T_FLOAT);
});

test("header round-trips", () => {
  const dv = new DataView(new ArrayBuffer(HEADER_SIZE));
  writeHeader(dv, { flags: 3, rootLo: 0x1234567f, rootHi: 9, keyTableOffset: 2 ** 33, fileLength: 2 ** 33 + 16 });
  assert.deepEqual(readHeader(dv), {
    magic: MAGIC, version: VERSION, flags: 3, rootLo: 0x1234567f, rootHi: 9,
    keyTableOffset: 2 ** 33, fileLength: 2 ** 33 + 16,
  });
  assert.equal(Buffer.from(dv.buffer, 0, 4).toString("latin1"), "NKL\0");
});
