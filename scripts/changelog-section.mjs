// Print the CHANGELOG.md section of one version (used for release notes).
//   node scripts/changelog-section.mjs 5.0.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
const lines = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").split("\n");
const start = lines.findIndex(l => l.startsWith(`## ${version} `) || l == `## ${version}`);
if (!version || start == -1) {
  console.error(`No CHANGELOG.md section for version ${version}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end == -1) {
  end = lines.length;
}
console.log(lines.slice(start + 1, end).join("\n").trim());
