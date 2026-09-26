// Runs every ```js block in README.md, and checks each `console.log(...); // x`
// line printed `x`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.mjs";

const root = new URL("..", import.meta.url);
const dist = new URL("../dist/index.js", import.meta.url).href;
const readme = readFileSync(new URL("README.md", root), "utf8");
const blocks = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
const dir = tempDir();

for (const env of [{}, { NICKLE_NO_NATIVE: "1" }]) {
  const mode = env.NICKLE_NO_NATIVE ? "fallback" : "native";
  blocks.forEach((code, i) => {
    test(`README example ${i + 1} runs (${mode})`, () => {
      const file = join(dir, `example-${i}.mjs`);
      writeFileSync(file, code.replaceAll('from "nickle"', `from ${JSON.stringify(dist)}`));
      const out = execFileSync(process.execPath, [file], { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8" });
      const expected = [...code.matchAll(/console\.log\(.*\);\s*\/\/ (.*)$/gm)].map((m) => m[1]);
      assert.deepEqual(out.trimEnd().split("\n").filter(Boolean), expected);
    });
  });
}
