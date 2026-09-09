#!/usr/bin/env node
// Sets one version on every package (and the root) and points the inter-package
// ranges at it, so a tag vX.Y.Z publishes a consistent set:
//   node scripts/set-version.mjs 0.1.1
// Text replacement, not a JSON rewrite: the files keep their formatting.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
	console.error("usage: node scripts/set-version.mjs <x.y.z>");
	process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publishable = ["types", "auth", "sdk", "core", "mcp", "server"];
const files = [...publishable, "web", "pi-extension"].map((w) => resolve(root, "packages", w, "package.json"));
files.push(resolve(root, "package.json"));

for (const file of files) {
	const before = readFileSync(file, "utf8");
	let after = before.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);
	for (const w of publishable) {
		// A range on a sibling package follows the version; "*" (the web app) stays.
		after = after.replace(new RegExp(`("@agentdox/${w}":\\s*")\\^[^"]*(")`, "g"), `$1^${version}$2`);
	}
	if (after !== before) writeFileSync(file, after);
	const name = /"name":\s*"([^"]+)"/.exec(after)?.[1] ?? file;
	console.log(`${name} → ${version}${after === before ? " (unchanged)" : ""}`);
}
console.log(`now: npm install (refreshes package-lock.json), commit, git tag v${version}, git push origin main v${version}`);
