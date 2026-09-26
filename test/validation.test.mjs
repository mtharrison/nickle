import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "../dist/encoder.js";

const rejects = (value, pathText, extra) => {
  assert.throws(() => encode(value), (err) => {
    assert.ok(err instanceof TypeError, `TypeError expected, got ${err}`);
    assert.ok(err.message.includes(pathText), `"${err.message}" should contain ${pathText}`);
    if (extra) assert.match(err.message, extra);
    return true;
  });
};

class Point { constructor() { this.x = 1; } }

test("nested Date is rejected with its path", () => rejects({ a: { b: [0, new Date()] } }, "a.b[1]", /Date/));
test("undefined property is rejected", () => rejects({ a: undefined }, "at a", /undefined/));
test("undefined root is rejected", () => rejects(undefined, "<root>"));
test("function is rejected", () => rejects({ f: () => 1 }, "at f", /function/));
test("symbol is rejected", () => rejects({ s: Symbol("x") }, "at s", /symbol/));
test("BigInt is rejected", () => rejects({ n: 1n }, "at n", /BigInt/));
test("class instance is rejected", () => rejects({ p: new Point() }, "at p", /Point/));
test("Map, Set and typed arrays are rejected", () => {
  rejects({ m: new Map() }, "at m", /Map/);
  rejects([new Set()], "[0]", /Set/);
  rejects({ t: new Uint8Array(2) }, "at t", /Uint8Array/);
});
test("array subclass is rejected", () => rejects({ a: new (class Arr extends Array {})() }, "at a", /Arr/));
test("non-plain prototype is rejected", () => rejects({ o: Object.create({ inherited: 1 }) }, "at o", /prototype|Object/));
test("null-prototype object is accepted", () => assert.ok(encode({ o: Object.assign(Object.create(null), { a: 1 }) })));

test("cycle is rejected with its path", () => {
  const o = { a: 1 };
  o.self = o;
  rejects(o, "self", /cycle/);
  const deep = { x: [{}] };
  deep.x[0].back = deep.x;
  rejects(deep, "x[0].back", /cycle/);
});

test("shared references are not cycles", () => {
  const s = { v: 1 };
  assert.ok(encode({ x: s, y: s, z: [s, s] }));
});

test("sparse array hole is rejected", () => rejects([1, , 3], "[1]", /sparse/));
test("explicit undefined in an array is rejected", () => rejects([1, undefined], "[1]", /undefined/));
test("lone surrogate in a value is rejected", () => rejects({ s: "\uD800" }, "at s", /surrogate/));
test("lone surrogate in a key is rejected", () => rejects({ ok: { "a\uDC00": 1 } }, "ok", /surrogate/));
test("non-identifier keys are quoted in paths", () => rejects({ "a b": { "0x": [undefined] } }, '["a b"]["0x"][0]'));
test("deep nesting does not overflow the stack", () => {
  let v = 0;
  for (let i = 0; i < 100_000; i++) v = [v];
  assert.ok(encode(v));
});
