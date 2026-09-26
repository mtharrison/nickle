import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { setImmediate as tick } from "node:timers/promises";
import { tempDir } from "./helpers.mjs";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");
const native = createRequire(import.meta.url)("../native/index.cjs");
const dir = tempDir();
const file = join(dir, "known.bin");
const bytes = Buffer.from("NKL\0 known bytes ÿ", "latin1");
writeFileSync(file, bytes);

test("mapFile returns the file's bytes", () => {
  const ab = native.mapFile(file);
  assert.ok(ab instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(ab), bytes);
  native.unmap(ab);
});

test("mapFile of an empty file is an empty buffer", () => {
  const empty = join(dir, "empty.bin");
  writeFileSync(empty, "");
  const ab = native.mapFile(empty);
  assert.equal(ab.byteLength, 0);
  native.unmap(ab);
});

test("mapFile of a missing file throws", () => {
  assert.throws(() => native.mapFile(join(dir, "missing.bin")));
});

test("unmap detaches: length 0, no crash, idempotent", () => {
  const before = native.mappingCount();
  const ab = native.mapFile(file);
  const view = new Uint8Array(ab);
  assert.equal(native.mappingCount(), before + 1);
  native.unmap(ab);
  assert.equal(native.mappingCount(), before);
  assert.equal(ab.byteLength, 0);
  assert.equal(view.length, 0);
  assert.equal(view[0], undefined);
  native.unmap(ab);
  assert.equal(native.mappingCount(), before);
});

test("finalizer unmaps a buffer that was never unmapped", async () => {
  const before = native.mappingCount();
  (() => { native.mapFile(file); })();
  assert.equal(native.mappingCount(), before + 1);
  for (let i = 0; i < 20 && native.mappingCount() > before; i++) {
    gc();
    await tick();
  }
  assert.equal(native.mappingCount(), before);
});
