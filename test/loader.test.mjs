import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers.mjs";

const dir = tempDir();
const file = join(dir, "data.bin");
writeFileSync(file, "NKL\0 some bytes");
const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

// Prints the loader mode and the mapped bytes of `file`.
const probe = (nativeJs, env = {}) => {
  const script = `
    import { mapFile, mode } from ${JSON.stringify(pathToFileURL(nativeJs).href)};
    const m = mapFile(${JSON.stringify(file)});
    console.log(mode(), Buffer.from(m.ab).toString("latin1"));
    m.release();
    try { mapFile(${JSON.stringify(join(dir, "missing"))}); } catch (e) { console.log(e.code); }`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NICKLE_NO_NATIVE: "", ...env }, encoding: "utf8",
  }).trim().split("\n");
};

test("native path is used by default", () => {
  assert.deepEqual(probe(join(distDir, "native.js")), ["native NKL\0 some bytes", "ENOENT"]);
});

test("NICKLE_NO_NATIVE=1 forces the readFileSync fallback", () => {
  assert.deepEqual(probe(join(distDir, "native.js"), { NICKLE_NO_NATIVE: "1" }), ["fallback NKL\0 some bytes", "ENOENT"]);
});

test("falls back when the addon cannot be loaded", () => {
  const copy = join(dir, "pkg", "dist");
  mkdirSync(copy, { recursive: true });
  cpSync(distDir, copy, { recursive: true });
  assert.deepEqual(probe(join(copy, "native.js")), ["fallback NKL\0 some bytes", "ENOENT"]);
});
