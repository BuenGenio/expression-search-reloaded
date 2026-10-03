// Ad-hoc probe: start headless Thunderbird and evaluate a chrome script given
// on the command line (or from a file). Useful while developing.
//   node tests/integration/probe.mjs 'return Services.appinfo.version'
//   node tests/integration/probe.mjs --file some-script.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchThunderbird } from "./marionette.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
let script = process.argv[2] || "return Services.appinfo.version;";
if (script == "--file") {
  script = fs.readFileSync(process.argv[3], "utf8");
}
const profileDir = path.join(root, "tests/.profiles/probe");
const { child, client } = await launchThunderbird({
  profileDir,
  logFile: path.join(root, "tests/.profiles/probe.log"),
});
try {
  const value = await client.exec(script);
  console.log(JSON.stringify(value, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.quit();
  await new Promise(r => setTimeout(r, 1000));
  child.kill();
}
