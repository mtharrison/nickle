// Two-process test: a writer loop against a reader that opens and materializes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { write, open, materialize } from "../dist/index.js";
import { mode } from "../dist/native.js";
import { generate } from "../bench/gen.mjs";
import { tempDir } from "./helpers.mjs";

const posix = process.platform !== "win32";
const skip = posix ? false : "atomic replacement over open files is POSIX-only";
const dir = tempDir();
const M = `[${mode()}]`;

test(`${M} a concurrent reader only ever sees intact trees`, { skip, timeout: 120_000 }, async (t) => {
  const path = join(dir, "shared.nkl");
  const expected = [JSON.stringify(generate(1, 3000)), JSON.stringify(generate(2, 3000))];
  write(path, generate(1, 3000));

  const writer = spawn(process.execPath, [fileURLToPath(new URL("fixtures/writer-loop.mjs", import.meta.url)), path, "200"], { stdio: "inherit" });
  let running = true;
  const exited = new Promise((resolve) => writer.on("exit", (code) => { running = false; resolve(code); }));

  const seen = [0, 0];
  while (running) {
    const h = open(path);
    const json = JSON.stringify(materialize(h.root));
    h.close();
    const which = expected.indexOf(json);
    assert.notEqual(which, -1, "read a tree that was never written");
    seen[which]++;
    await new Promise(setImmediate); // let the exit event through
  }
  assert.equal(await exited, 0);
  t.diagnostic(`reads of tree A, B: ${seen}`);
  assert.ok(seen[0] + seen[1] > 10, `too few reads: ${seen}`);
  assert.ok(seen[0] > 0 && seen[1] > 0, `reads should see both trees: ${seen}`);
});

test(`${M} an open handle keeps its snapshot after the path is replaced`, { skip }, () => {
  const path = join(dir, "snapshot.nkl");
  const before = { version: 1, items: Array.from({ length: 1000 }, (_, i) => ({ i, s: `old-${i}` })) };
  const after = { version: 2, items: [{ i: 0, s: "new" }] };
  write(path, before);
  const old = open(path);
  const lazyItems = old.root.items; // a view obtained before the replace
  write(path, after);

  assert.deepEqual(materialize(old.root), before);
  assert.equal(lazyItems[999].s, "old-999");
  const fresh = open(path);
  assert.deepEqual(materialize(fresh.root), after);
  old.close();
  fresh.close();
});
