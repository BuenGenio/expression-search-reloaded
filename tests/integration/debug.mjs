// Debug helper: start Thunderbird, install the add-on from src/, then run a
// chrome script from a file (with ES_TEST helpers loaded) and print the result.
//   node tests/integration/debug.mjs script.js [thunderbird-binary]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchThunderbird } from "./marionette.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const profileRoot = process.env.ES_PROFILE_ROOT || path.join(root, "tests/.profiles");
const { child, client } = await launchThunderbird({
  binary: process.argv[3] || process.env.THUNDERBIRD_BIN || "/snap/bin/thunderbird",
  profileDir: path.join(profileRoot, "debug"),
  logFile: path.join(profileRoot, "debug.log"),
  extraPrefs: { "mailnews.customDBHeaders": "list-id" },
});
try {
  await client.exec(fs.readFileSync(path.join(here, "chrome-helpers.js"), "utf8"));
  await client.exec("return ES_TEST.setupFolder();");
  await client.installAddon(path.join(root, "src"));
  console.log(JSON.stringify(await client.exec(fs.readFileSync(process.argv[2], "utf8")), null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.quit();
  await new Promise(r => setTimeout(r, 1000));
  child.kill();
}
