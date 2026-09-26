// Lists test files explicitly: Node 20's `node --test` doesn't expand globs.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const files = readdirSync("test").filter((f) => f.endsWith(".test.mjs")).map((f) => `test/${f}`);
const { status } = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(status ?? 1);
