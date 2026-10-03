// Download and unpack a Thunderbird build for the integration tests (CI).
//
//   node scripts/get-thunderbird.mjs <release|esr|beta|X.Y[.Z][esr|bN]> <dest-dir>
//
// Prints the path of the thunderbird binary. Versions are resolved through
// https://product-details.mozilla.org; "esr" means the newest ESR line.
// Linux x86_64 builds only (archive.mozilla.org).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [channel = "release", dest = "thunderbird-ci"] = process.argv.slice(2);

async function resolveVersion(name) {
  if (/^\d/.test(name)) {
    return name;
  }
  const res = await fetch("https://product-details.mozilla.org/1.0/thunderbird_versions.json");
  if (!res.ok) {
    throw new Error(`product-details: HTTP ${res.status}`);
  }
  const v = await res.json();
  switch (name) {
    case "release":
      return v.LATEST_THUNDERBIRD_VERSION;
    case "beta":
      return v.LATEST_THUNDERBIRD_DEVEL_VERSION;
    case "esr": {
      const esrs = [v.THUNDERBIRD_ESR, v.THUNDERBIRD_ESR_NEXT].filter(Boolean);
      return esrs.sort((a, b) => parseInt(b) - parseInt(a))[0];
    }
  }
  throw new Error(`Unknown channel ${name}`);
}

const version = await resolveVersion(channel);
const url = `https://archive.mozilla.org/pub/thunderbird/releases/${version}/linux-x86_64/en-US/thunderbird-${version}.tar.xz`;
console.error(`Thunderbird ${channel} = ${version}\n${url}`);

if (process.env.GET_THUNDERBIRD_DRY_RUN) {
  console.log(version);
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
const archive = path.join(dest, `thunderbird-${version}.tar.xz`);
const res = await fetch(url);
if (!res.ok) {
  throw new Error(`${url}: HTTP ${res.status}`);
}
fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
execFileSync("tar", ["-xf", archive, "-C", dest]);
fs.rmSync(archive);
console.log(path.resolve(dest, "thunderbird", "thunderbird"));
