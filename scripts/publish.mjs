// Publishes the platform packages in npm/, skipping versions already on the
// registry, then the root package with matching optionalDependencies.
// Safe to re-run after a partial failure. Pass --dry-run to try it out.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, cwd) => execFileSync(npm, args, { cwd, stdio: "inherit" });
const published = (name, version) => {
  try {
    execFileSync(npm, ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

const root = JSON.parse(readFileSync("package.json", "utf8"));
const { version } = root;
const optionalDependencies = {};

for (const dir of readdirSync("npm").sort()) {
  const cwd = join("npm", dir);
  const { name } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  optionalDependencies[name] = version;
  if (published(name, version)) {
    console.log(`skip ${name}@${version}: already published`);
    continue;
  }
  console.log(`publish ${name}@${version}`);
  run(["publish", ...(dryRun ? ["--dry-run"] : [])], cwd);
}

if (published(root.name, version)) {
  console.log(`skip ${root.name}@${version}: already published`);
} else {
  writeFileSync("package.json", JSON.stringify({ ...root, optionalDependencies }, null, 2) + "\n");
  console.log(`publish ${root.name}@${version} with`, optionalDependencies);
  run(["publish", ...(dryRun ? ["--dry-run"] : [])], ".");
}
