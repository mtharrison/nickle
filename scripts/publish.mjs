// Publishes the platform packages in npm/, skipping versions already on the
// registry, then the root package with matching optionalDependencies.
// Safe to re-run after a partial failure. Pass --dry-run to try it out.
//
// A platform package that fails to publish is left out of optionalDependencies
// with a warning: users on that platform get the pure-JS fallback until a later
// release publishes it.

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
const failed = [];

for (const dir of readdirSync("npm").sort()) {
  const cwd = join("npm", dir);
  const { name } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  if (published(name, version)) {
    console.log(`skip ${name}@${version}: already published`);
    optionalDependencies[name] = version;
    continue;
  }
  console.log(`publish ${name}@${version}`);
  try {
    run(["publish", ...(dryRun ? ["--dry-run"] : [])], cwd);
    optionalDependencies[name] = version;
  } catch {
    failed.push(name);
    console.log(`::warning::${name}@${version} failed to publish; that platform will use the JS fallback`);
  }
}
if (Object.keys(optionalDependencies).length === 0) throw new Error("no platform package could be published");

if (published(root.name, version)) {
  console.log(`skip ${root.name}@${version}: already published`);
} else {
  writeFileSync("package.json", JSON.stringify({ ...root, optionalDependencies }, null, 2) + "\n");
  console.log(`publish ${root.name}@${version} with`, optionalDependencies);
  run(["publish", ...(dryRun ? ["--dry-run"] : [])], ".");
}
