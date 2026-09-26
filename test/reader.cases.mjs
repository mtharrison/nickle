// Reader tests, imported by reader.test.mjs (native) and reader-fallback.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { write, open, materialize } from "../dist/index.js";
import { mode } from "../dist/native.js";
import { encode } from "../dist/encoder.js";
import { tempDir } from "./helpers.mjs";

const M = `[${mode()}]`;
const dir = tempDir();
let n = 0;
const fresh = (value) => {
  const p = join(dir, `f${n++}.nkl`);
  write(p, value);
  return p;
};
const users = () => ({ users: [{ name: "alice" }, { name: "bob" }] });
const openUsers = () => open(fresh(users()));
const code = (c) => (err) => err.code === c;

// 5.1 open() and file validation

test(`${M} missing file throws ENOENT`, () => {
  assert.throws(() => open(join(dir, "missing.nkl")), code("ENOENT"));
});

test(`${M} JSON text file is NICKLE_BAD_MAGIC`, () => {
  const p = join(dir, "text.json");
  writeFileSync(p, JSON.stringify(users()));
  assert.throws(() => open(p), code("NICKLE_BAD_MAGIC"));
});

test(`${M} empty and tiny files are NICKLE_BAD_MAGIC`, () => {
  for (const [name, body] of [["empty", ""], ["tiny", "{}"]]) {
    const p = join(dir, name);
    writeFileSync(p, body);
    assert.throws(() => open(p), code("NICKLE_BAD_MAGIC"), name);
  }
});

test(`${M} other format version is NICKLE_BAD_VERSION`, () => {
  const buf = Buffer.from(encode(users()));
  buf.writeUInt16LE(2, 4);
  const p = join(dir, "v2.nkl");
  writeFileSync(p, buf);
  assert.throws(() => open(p), code("NICKLE_BAD_VERSION"));
});

test(`${M} file cut to half its length is NICKLE_TRUNCATED`, () => {
  const full = readFileSync(fresh(users()));
  const p = join(dir, "half.nkl");
  writeFileSync(p, full.subarray(0, full.length >> 1));
  assert.throws(() => open(p), code("NICKLE_TRUNCATED"));
  writeFileSync(p, full.subarray(0, 10));
  assert.throws(() => open(p), code("NICKLE_TRUNCATED"), "cut inside the header");
});

test(`${M} primitive roots read back`, () => {
  for (const v of ["hello", 42, -0, null, true, 1.5]) {
    const h = open(fresh(v));
    assert.ok(Object.is(h.root, v), String(v));
    h.close();
  }
});

// 5.2 views

test(`${M} nested read returns a primitive`, () => {
  const { root } = openUsers();
  assert.equal(root.users[1].name, "bob");
});

test(`${M} array view is an array`, () => {
  const { root } = openUsers();
  assert.equal(Array.isArray(root.users), true);
  assert.equal(root.users.length, 2);
  assert.equal(Array.isArray(root), false);
});

test(`${M} missing keys and out-of-range indices are undefined`, () => {
  const { root } = openUsers();
  assert.equal(root.nope, undefined);
  assert.equal(root.users[2], undefined);
  assert.equal(root.users[-1], undefined);
  assert.equal(root.users["01"], undefined);
  assert.equal("nope" in root, false);
  assert.equal("users" in root, true);
  assert.equal(1 in root.users, true);
  assert.equal(2 in root.users, false);
});

test(`${M} enumeration matches the original`, () => {
  const { root } = open(fresh({ z: 1, a: { y: 2, b: 3 }, m: [4, 5], 10: "ten", 2: "two" }));
  const original = { z: 1, a: { y: 2, b: 3 }, m: [4, 5], 10: "ten", 2: "two" };
  assert.deepEqual(Object.keys(root), Object.keys(original));
  assert.deepEqual(Object.keys(root.a), ["y", "b"]);
  assert.deepEqual(Object.entries(root.a), [["y", 2], ["b", 3]]);
  const forIn = [];
  for (const k in root) forIn.push(k);
  assert.deepEqual(forIn, Object.keys(original));
  assert.deepEqual(Object.keys(root.m), ["0", "1"]);
  assert.deepEqual(Object.keys(openUsers().root.users[0]), ["name"]);
});

test(`${M} for...of and array methods`, () => {
  const { root } = open(fresh({ xs: [1, "two", { three: 3 }, [4]] }));
  const seen = [];
  for (const x of root.xs) seen.push(x);
  assert.equal(seen.length, 4);
  assert.equal(seen[2].three, 3);
  assert.deepEqual(root.xs.map((x) => typeof x), ["number", "string", "object", "object"]);
  assert.deepEqual([...root.xs].slice(0, 2), [1, "two"]);
  assert.equal(root.xs.indexOf("two"), 1);
});

test(`${M} JSON.stringify of a view equals the original`, () => {
  const original = { a: [1, "x", true, null, -0, 2.5, { "ключ": "emoji 🎉 and 中文" }], b: { c: [] , d: {} }, e: "" };
  const { root } = open(fresh(original));
  assert.equal(JSON.stringify(root), JSON.stringify(original));
  assert.equal(JSON.stringify(root.a), JSON.stringify(original.a));
});

test(`${M} strings of every decode path read back`, () => {
  const strings = ["", "a", "abcdefg", "abcdefgh", "x".repeat(300), "é", "中文", "🎉 party", "mixed ascii and ü"];
  const { root } = open(fresh(strings));
  assert.deepEqual([...root], strings);
});

test(`${M} wide objects use the sorted lookup`, () => {
  const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${(i * 37) % 50}`, i]));
  const { root } = open(fresh({ first: { k49: "x" }, wide }));
  for (const [k, v] of Object.entries(wide)) assert.equal(root.wide[k], v, k);
  assert.equal(root.wide.first, undefined, "known key, not in this node");
  assert.deepEqual(Object.keys(root.wide), Object.keys(wide));
});

test(`${M} inherited Object.prototype members still resolve`, () => {
  const { root } = open(fresh({ toString: "own", a: 1 }));
  assert.equal(root.toString, "own");
  assert.equal(typeof root.hasOwnProperty, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(root, "a"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(root, "hasOwnProperty"), false);
});

// 5.3 identity and immutability

test(`${M} repeated access is identical`, () => {
  const { root } = openUsers();
  assert.equal(root.users, root.users);
  assert.equal(root.users[0], root.users[0]);
  assert.notEqual(root.users[0], root.users[1]);
});

test(`${M} assignment throws in strict mode and leaves the value`, () => {
  const { root } = openUsers();
  assert.throws(() => { root.users[0].name = "eve"; }, TypeError);
  assert.equal(root.users[0].name, "alice");
  assert.throws(() => { root.users[5] = {}; }, TypeError);
  assert.throws(() => { root.added = 1; }, TypeError);
});

test(`${M} delete, define and other mutations throw`, () => {
  const { root } = openUsers();
  assert.throws(() => { delete root.users; }, TypeError);
  assert.throws(() => Object.defineProperty(root, "x", { value: 1 }), TypeError);
  assert.throws(() => Object.setPrototypeOf(root, null), TypeError);
  assert.throws(() => Object.freeze(root), TypeError);
  assert.throws(() => root.users.push({}), TypeError);
  assert.throws(() => root.users.sort(), TypeError);
  assert.equal(root.users.length, 2);
  assert.ok(root.users);
});

test(`${M} assignment and delete throw in sloppy mode`, () => {
  const { root } = openUsers();
  const sloppy = (src) => runInNewContext(`(function (root) { ${src} })`)(root);
  assert.throws(() => sloppy(`root.users[0].name = "eve";`), (e) => e.name === "TypeError");
  assert.throws(() => sloppy(`delete root.users;`), (e) => e.name === "TypeError");
  assert.throws(() => sloppy(`root.users.length = 0;`), (e) => e.name === "TypeError");
  assert.equal(root.users[0].name, "alice");
  assert.equal(root.users.length, 2);
});

// 5.4 materialize

test(`${M} materialized copy is plain, deep-equal and mutable`, () => {
  const { root } = openUsers();
  const copy = materialize(root.users);
  assert.equal(Object.getPrototypeOf(copy), Array.prototype);
  assert.equal(Object.getPrototypeOf(copy[0]), Object.prototype);
  assert.deepEqual(copy, users().users);
  assert.notEqual(copy, root.users);
  copy[0].name = "eve";
  copy.push({ name: "carol" });
  delete copy[1].name;
  assert.equal(root.users[0].name, "alice");
  assert.equal(root.users.length, 2);
});

test(`${M} materialize of the root, primitives and non-views`, () => {
  const original = { a: [1, { b: "c" }], d: null };
  const { root } = open(fresh(original));
  assert.deepEqual(materialize(root), original);
  for (const v of [1, "s", null, true, undefined]) assert.equal(materialize(v), v);
  const plain = { x: 1 };
  assert.equal(materialize(plain), plain);
  assert.equal(materialize(root.a[0]), 1);
});

test(`${M} materialize keeps a __proto__ key as own data`, () => {
  const original = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const { root } = open(fresh(original));
  const copy = materialize(root);
  assert.equal(Object.getPrototypeOf(copy), Object.prototype);
  assert.deepEqual(Object.keys(copy), ["__proto__", "a"]);
  assert.equal(copy.polluted, undefined);
  assert.equal(root.__proto__.polluted, true);
});

// 5.5 close

test(`${M} access after close throws NICKLE_CLOSED`, () => {
  const h = openUsers();
  const u = h.root.users;
  const r = h.root;
  h.close();
  assert.throws(() => u[0], code("NICKLE_CLOSED"));
  assert.throws(() => r.users, code("NICKLE_CLOSED"));
  assert.throws(() => Object.keys(r), code("NICKLE_CLOSED"));
  assert.throws(() => "users" in r, code("NICKLE_CLOSED"));
  assert.throws(() => JSON.stringify(r), code("NICKLE_CLOSED"));
  assert.throws(() => materialize(u), code("NICKLE_CLOSED"));
  assert.throws(() => { u[0] = 1; }, code("NICKLE_CLOSED"));
});

test(`${M} materialized data survives close`, () => {
  const h = openUsers();
  const copy = materialize(h.root.users);
  h.close();
  assert.equal(copy[1].name, "bob");
  assert.deepEqual(copy, users().users);
});

test(`${M} double close is a no-op`, () => {
  const h = openUsers();
  h.close();
  h.close();
  assert.throws(() => h.root.users, code("NICKLE_CLOSED"));
});
