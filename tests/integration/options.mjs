// End-to-end test of the options and help pages.
//
// Extension pages normally run in a separate process that Marionette cannot
// script in Thunderbird, so this test starts Thunderbird with
// extensions.webextensions.remote=false: the page logic is identical, only the
// process boundary (standard WebExtension plumbing) is skipped.
//
//   node tests/integration/options.mjs [path/to/thunderbird]

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchThunderbird } from "./marionette.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const binary = process.argv[2] || process.env.THUNDERBIRD_BIN || "/snap/bin/thunderbird";
const profileRoot = process.env.ES_PROFILE_ROOT || path.join(root, "tests/.profiles");
fs.mkdirSync(profileRoot, { recursive: true });

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
  }
}

const { child, client } = await launchThunderbird({
  binary,
  profileDir: path.join(profileRoot, "options"),
  logFile: path.join(profileRoot, "options.log"),
  extraPrefs: { "extensions.webextensions.remote": false },
});
const run = (body, ...args) => client.exec(body, args);

try {
  console.log(`Thunderbird ${await run("return Services.appinfo.version;")}`);
  await run(fs.readFileSync(path.join(here, "chrome-helpers.js"), "utf8"));
  await run("return ES_TEST.setupFolder();");
  const addonPath = process.env.ES_ADDON ? path.resolve(process.env.ES_ADDON) : path.join(root, "src");
  await client.installAddon(addonPath);
  await run(`await ES_TEST.waitFor(() => ES_TEST.input, "search box");`);

  // Open the options page in a tab and expose its document to later scripts.
  await run(`
    const ext = ES_TEST.extension();
    const tabmail = ES_TEST.win.gTabmail;
    const tab = tabmail.openTab("contentTab", { url: ext.baseURI.resolve("options/options.html") });
    ES_TEST.optionsTab = tab;
    await ES_TEST.waitFor(() => {
      const doc = tab.browser.contentDocument;
      return doc?.readyState == "complete" && doc.documentElement.dataset.ready == "true" && doc;
    }, "options page populated");
    ES_TEST.optDoc = () => tab.browser.contentDocument;
  `);

  console.log("Options page");
  await check("is localized and shows the stored options", async () => {
    const r = await run(`
      const doc = ES_TEST.optDoc();
      return {
        legend: doc.querySelector("legend").textContent,
        hide: doc.querySelector("[name=hideNormalFilter]").checked,
        timeout: doc.querySelector("[name=searchTimeout]").value,
        folders: [...doc.querySelector("select[name=virtualFolderParent]").options].map(o => o.textContent.trim()),
        headers: doc.getElementById("customDBHeaders").value,
      };`);
    assert.equal(r.legend, "Search box");
    assert.equal(r.hide, true);
    assert.equal(r.timeout, "1000");
    assert.ok(r.folders.includes("Local Folders"), r.folders.join(","));
    assert.ok(r.folders.includes("es-test"), r.folders.join(","));
  });

  await check("changing an option reaches the experiment", async () => {
    const r = await run(`
      const doc = ES_TEST.optDoc();
      const box = doc.querySelector("[name=hideNormalFilter]");
      box.click();
      const api = ES_TEST.api();
      await ES_TEST.waitFor(() => api.controller.options.hideNormalFilter === false, "option applied", 10000);
      const normalHidden = ES_TEST.about3Pane.document.getElementById("qfb-qs-textbox").classList.contains("esr-normal-hidden");
      return [normalHidden, doc.getElementById("status").textContent];`);
    assert.deepEqual(r, [false, "Saved"]);
  });

  await check("saved search location is stored as a folder id and used", async () => {
    const r = await run(`
      const doc = ES_TEST.optDoc();
      const select = doc.querySelector("select[name=virtualFolderParent]");
      const option = [...select.options].find(o => o.textContent.trim() == "es-test");
      select.value = option.value;
      select.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      const api = ES_TEST.api();
      await ES_TEST.waitFor(() => api.controller.options.virtualFolderParent == option.value, "folder option", 10000);
      return [option.value, api.controller.savedSearchParent(ES_TEST.folder)?.URI == ES_TEST.folder.URI];`);
    assert.match(r[0], /es-test/);
    assert.equal(r[1], true);
  });

  await check("an invalid subject regex is rejected and not saved", async () => {
    const r = await run(`
      const doc = ES_TEST.optDoc();
      const input = doc.querySelector("[name=c2sRegexpMatch]");
      input.value = "Bug (";
      input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      await ES_TEST.sleep(500);
      const status = doc.getElementById("status");
      return [status.textContent, status.classList.contains("error"), ES_TEST.api().controller.options.c2sRegexpMatch];`);
    assert.deepEqual(r, ["Invalid regular expression", true, ""]);
  });

  await check("searchable headers are written to mailnews.customDBHeaders", async () => {
    const r = await run(`
      const doc = ES_TEST.optDoc();
      const input = doc.getElementById("customDBHeaders");
      input.value = "List-Id, X-Mailer  x-mailer";
      input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      await ES_TEST.waitFor(() => Services.prefs.getStringPref("mailnews.customDBHeaders", "") == "list-id x-mailer", "pref written", 5000);
      const ok = Services.prefs.getStringPref("mailnews.customDBHeaders");
      input.value = "bad header!";
      input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
      await ES_TEST.sleep(300);
      return [ok, input.value, Services.prefs.getStringPref("mailnews.customDBHeaders")];`);
    assert.deepEqual(r, ["list-id x-mailer", "bad header!", "list-id x-mailer"]);
  });

  await check("restore defaults", async () => {
    const r = await run(`
      const doc = ES_TEST.optDoc();
      doc.getElementById("reset").click();
      const api = ES_TEST.api();
      await ES_TEST.waitFor(() => api.controller.options.hideNormalFilter === true && api.controller.options.virtualFolderParent === "", "defaults applied", 10000);
      return [doc.querySelector("[name=hideNormalFilter]").checked, doc.querySelector("select[name=virtualFolderParent]").value];`);
    assert.deepEqual(r, [true, ""]);
  });

  await check("no errors from the add-on pages in the console", async () => {
    const errors = await run(`
      return Services.console.getMessageArray()
        .filter(m => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
        .map(m => m.errorMessage + " @ " + m.sourceName + ":" + m.lineNumber)
        .filter(s => /expression|moz-extension/i.test(s))
        // In this in-process test mode the help tab opened at install time can
        // load before the extension's page support is ready (not the case with
        // Thunderbird's default out-of-process extension pages, see run.mjs).
        .filter(s => !s.includes("/help/help.js"))
        .filter(s => !(s.startsWith("sendRemoveListener on closed conduit") && s.includes("ConduitsChild.sys.mjs")));`);
    assert.deepEqual(errors, []);
  });
} catch (e) {
  results.push(["harness", false]);
  console.error(e);
} finally {
  await client.quit();
  await new Promise(r => setTimeout(r, 1500));
  child.kill();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
