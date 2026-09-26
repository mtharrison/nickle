import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { write } from "../dist/index.js";
import { encode } from "../dist/encoder.js";
import { tempDir } from "./helpers.mjs";

const dir = tempDir();

test("nested tree is written", () => {
  const p = join(dir, "tree.nkl");
  write(p, { a: [1, "x", true, null], b: { c: 2.5 } });
  assert.ok(existsSync(p));
  assert.deepEqual(readFileSync(p), encode({ a: [1, "x", true, null], b: { c: 2.5 } }));
});

test("no file on failure", () => {
  const p = join(dir, "never.nkl");
  assert.throws(() => write(p, { a: { b: [0, new Date()] } }), TypeError);
  assert.ok(!existsSync(p));
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("never")), []);
});

test("existing file intact on failure", () => {
  const p = join(dir, "keep.nkl");
  write(p, { v: 1 });
  const before = readFileSync(p);
  assert.throws(() => write(p, { v: () => 2 }), TypeError);
  assert.deepEqual(readFileSync(p), before);
});

test("an existing file is replaced", () => {
  const p = join(dir, "replace.nkl");
  writeFileSync(p, "old contents");
  write(p, [1, 2, 3]);
  assert.deepEqual(readFileSync(p), encode([1, 2, 3]));
});

test("temp file is removed when the rename fails", () => {
  const p = join(dir, "is-a-dir");
  mkdirSync(join(p, "child"), { recursive: true });
  assert.throws(() => write(p, { v: 1 }));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("missing directory fails without leaving files", () => {
  assert.throws(() => write(join(dir, "nope", "x.nkl"), 1), { code: "ENOENT" });
});
