// End-to-end tests in a real, headless Thunderbird (separate throw-away
// profile, -no-remote, Marionette on a private port).
//
//   node tests/integration/run.mjs [path/to/thunderbird]
//   THUNDERBIRD_BIN=/path/to/thunderbird node tests/integration/run.mjs
//
// The add-on is installed temporarily from src/.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launchThunderbird } from "./marionette.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const binary = process.argv[2] || process.env.THUNDERBIRD_BIN || "/snap/bin/thunderbird";
const profileRoot = process.env.ES_PROFILE_ROOT || path.join(root, "tests/.profiles");
const profileDir = path.join(profileRoot, "integration");
const logFile = path.join(profileRoot, "integration.log");
fs.mkdirSync(profileRoot, { recursive: true });

const ALL = ["M01", "M02", "M03", "M04", "M05", "M06"];
const not = ids => ALL.filter(id => !ids.includes(id));

const CASES = [
  ["f:alice", ["M01", "M06"]],
  ["t:alice", ["M02", "M03", "M05"]],
  ["f:alice t:bob", ["M01", "M06"]],
  ["s:report", ["M01", "M02"]],
  ["s:report -f:bob", ["M01"]],
  ["f:(carol or dave)", ["M03", "M04"]],
  ["-(f:alice or f:bob)", ["M03", "M04", "M05"]],
  ["(f:alice s:plan) or f:dave", ["M04", "M06"]],
  ["(f:alice or f:bob) (s:report or s:photos)", ["M01", "M02"]],
  ["f:alice or s:photos or t:carol", ["M01", "M02", "M04", "M06"]],
  ["weekly", ["M01", "M02"]],
  ["s:weekly", ["M01", "M02"]],
  ["a:yes", ["M03", "M04", "M06"]],
  ["a:no", ["M01", "M02", "M05"]],
  ["fi:pdf", ["M03"]],
  ["-fi:pdf", ["M04", "M06"]],
  ["fi:original message", ["M06"]],
  ["fi:image/jpeg", ["M04"]],
  ["b:tracking", ["M01"]],
  ["bodyre:tracking number is \\d+", ["M01"]],
  ["bodyre:/hello\\s+world/i", ["M02"]],
  ["-bodyre:/hello\\s+world/i", not(["M02"])],
  ["all:tracking", ["M01"]],
  ["regex:^Re: M02", ["M02"]],
  ["simple:Invoice (urgent) - pay", ["M03"]],
  ["fromre:^Carol", ["M03"]],
  ["-fromre:^Carol", not(["M03"])],
  ["tore:dave@", ["M02"]],
  ["-tore:dave@", not(["M02"])],
  ["bcc:eve", ["M06"]],
  ["only:bob", ["M01", "M04", "M06"]],
  ["only:alice,carol", ["M02"]],
  ["tn:carol", ["M02"]],
  ["c:dave", ["M02"]],
  ["ft:dave", ["M02", "M04"]],
  ["tag:important", ["M01"]],
  ["tag:na", ["M02", "M03", "M05", "M06"]],
  ["-tag:na", ["M01", "M04"]],
  ["tag:#4", ["M04"]],
  ["tag:nonexistent", []],
  ["is:unread", ["M03"]],
  ["-is:unread", not(["M03"])],
  ["is:starred", ["M05"]],
  ["is:replied", ["M02"]],
  ["before:2024/01/01", ["M03"]],
  ["after:2025/01/01", ["M04", "M05", "M06"]],
  // Thunderbird compares dates by day: after 03-01 and not after 03-02.
  ["af:(2024/03/01 -2024/03/02)", ["M02"]],
  ["af:2024/03/01", ["M02", "M04", "M05", "M06"]],
  ["af:(3:00 -4:00)", ["M03"]],
  ["date:2024/03", ["M01", "M02"]],
  ["-date:2024/03", not(["M01", "M02"])],
  ["older_than:1y", ["M01", "M02", "M03", "M04"]],
  ["newer_than:7", ["M05", "M06"]],
  ["days:today", ["M05"]],
  ["h:list-id", ["M04"]],
  ["h:List-Id=/team/", ["M04"]],
  ["-h:list-id", not(["M04"])],
  ["size:100000", []],
  ["smaller:100000", ALL],
  ["f:alice g:x", ["M01", "M06"]],
  ["simple:", ALL],
];

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push([name, false, e]);
    console.log(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}`);
  }
}

const { child, client } = await launchThunderbird({
  binary,
  profileDir,
  logFile,
  extraPrefs: {
    "mailnews.customDBHeaders": "list-id",
    // Settings of Expression Search 2.x, to be migrated on install.
    "extensions.expressionsearch.statusbar_info_showtime": 7,
    "extensions.expressionsearch.c2s_removeDomainName": false,
  },
});
const run = (body, ...args) => client.exec(body, args);

try {
  const version = await run("return Services.appinfo.version;");
  console.log(`Thunderbird ${version} (${binary})`);
  await run(fs.readFileSync(path.join(here, "chrome-helpers.js"), "utf8"));
  await run("return ES_TEST.setupFolder();");

  // ES_ADDON=dist/....xpi tests the packaged add-on instead of src/.
  const addonPath = process.env.ES_ADDON ? path.resolve(process.env.ES_ADDON) : path.join(root, "src");
  console.log(`Add-on: ${path.relative(root, addonPath)}`);
  await client.installAddon(addonPath);
  await run(`return ES_TEST.waitFor(() => ES_TEST.input, "search box");`);
  await run("return ES_TEST.showFolder();");

  console.log("Integration");
  await check("2.x settings are migrated on install", async () => {
    const r = await run(`
      const api = ES_TEST.api();
      await ES_TEST.waitFor(() => api.controller?.options.helpShowSeconds == 7, "migrated options", 10000);
      const o = api.controller.options;
      return [o.helpShowSeconds, o.c2sRemoveDomain, o.hideNormalFilter];`);
    assert.deepEqual(r, [7, false, true]);
  });

  await check("search box injected next to the quick filter text box", async () => {
    const r = await run(`
      const doc = ES_TEST.about3Pane.document;
      const box = doc.getElementById("esr-search-container");
      return {
        afterNormal: box.previousElementSibling.id,
        hidden: doc.getElementById("qfb-qs-textbox").classList.contains("esr-normal-hidden"),
        textBoxDomId: ES_TEST.QuickFilterManager.textBoxDomId,
        filterDefined: !!ES_TEST.QuickFilterManager.filterDefsByName.expressionSearchReloaded,
      };`);
    assert.deepEqual(r, {
      afterNormal: "qfb-qs-textbox",
      hidden: true,
      textBoxDomId: "esr-search-textbox",
      filterDefined: true,
    });
  });

  await check("custom search terms registered", async () => {
    const terms = await run("return ES_TEST.customTermState();");
    assert.equal(terms.length, 11);
    assert.ok(terms.every(([, active]) => active));
  });

  console.log("Expressions");
  for (const [expression, expected] of CASES) {
    await check(`${expression}  ->  ${expected.join(" ") || "(none)"}`, async () => {
      const listed = await run("return ES_TEST.search(arguments[0]);", expression);
      assert.deepEqual(listed, [...expected].sort());
    });
  }
  await run("return ES_TEST.clear();");

  console.log("Behaviour");
  await check("help popup explains the operator being typed", async () => {
    const r = await run(`
      const input = ES_TEST.input;
      input.focus();
      input.value = "f:bob fromr";
      input.setSelectionRange(11, 11);
      input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
      await ES_TEST.sleep(50);
      return ES_TEST.helpText();`);
    assert.equal(r.hidden, false);
    assert.match(r.text, /fromre \(fr\)/);
    assert.match(r.text, /From matches a regular expression/);
  });

  await check("invalid regex is reported and does not filter", async () => {
    const listed = await run("return ES_TEST.search('regex:/a(/');");
    const help = await run("return ES_TEST.helpText();");
    assert.deepEqual(listed, ALL);
    assert.match(help.text, /Invalid regular expression/);
    const cls = await run("return ES_TEST.input.parentNode.classList.contains('esr-error');");
    assert.equal(cls, true);
  });

  await check("calculator", async () => {
    await run("return ES_TEST.search('3*(4+5)');");
    assert.equal(await run("return ES_TEST.input.value;"), "3*(4+5) = 27");
  });

  await check("Escape clears the expression and the filter", async () => {
    await run("return ES_TEST.search('f:carol');");
    const r = await run(`
      ES_TEST.key(ES_TEST.input, "Escape");
      await ES_TEST.settle();
      return [ES_TEST.input.value, ES_TEST.listed()];`);
    assert.deepEqual(r, ["", ALL]);
  });

  await check("Escape in the empty box still reaches the quick filter bar", async () => {
    const r = await run(`
      const a3 = ES_TEST.about3Pane;
      a3.quickFilterBar.filterer.setFilterValue("unread", true);
      a3.quickFilterBar.updateSearch();
      await ES_TEST.settle();
      const before = ES_TEST.listed();
      ES_TEST.key(ES_TEST.input, "Escape");
      await ES_TEST.settle();
      return [before, ES_TEST.listed()];`);
    assert.deepEqual(r, [["M03"], ALL]);
  });

  await check("combines with the other quick filter buttons", async () => {
    const r = await run(`
      const a3 = ES_TEST.about3Pane;
      await ES_TEST.search("t:alice");
      a3.quickFilterBar.filterer.setFilterValue("starred", true);
      a3.quickFilterBar.updateSearch();
      await ES_TEST.settle();
      const listed = ES_TEST.listed();
      a3.quickFilterBar.filterer.setFilterValue("starred", null);
      await ES_TEST.clear();
      return listed;`);
    assert.deepEqual(r, ["M05"]);
  });

  await check("click-to-search on a subject (Ctrl + right click)", async () => {
    const r = await run(`
      const a3 = ES_TEST.about3Pane;
      const row = await ES_TEST.rowFor("M03");
      const target = row.querySelector(".subject, .subjectcol-column");
      target.dispatchEvent(new a3.MouseEvent("contextmenu", { button: 2, ctrlKey: true, bubbles: true, cancelable: true }));
      await ES_TEST.settle();
      return [ES_TEST.input.value, ES_TEST.listed(), a3.document.getElementById("mailContext").state];`);
    assert.equal(r[0], "simple:M03 Invoice (urgent) - pay now");
    assert.deepEqual(r[1], ["M03"]);
    assert.notEqual(r[2], "open", "Thunderbird's context menu must not open");
  });

  await check("click-to-search on a sender", async () => {
    const r = await run(`
      await ES_TEST.clear();
      const a3 = ES_TEST.about3Pane;
      const row = await ES_TEST.rowFor("M01");
      const target = row.querySelector(".sender, .correspondentcol-column, .sendercol-column");
      target.dispatchEvent(new a3.MouseEvent("contextmenu", { button: 2, ctrlKey: true, bubbles: true, cancelable: true }));
      await ES_TEST.settle();
      return [ES_TEST.input.value, ES_TEST.listed()];`);
    assert.equal(r[0], 'f:"Alice Smith"');
    assert.deepEqual(r[1], ["M01", "M06"]);
  });

  await check("plain right click is left alone", async () => {
    const r = await run(`
      await ES_TEST.clear();
      const a3 = ES_TEST.about3Pane;
      const row = a3.threadTree.getRowAtIndex(0);
      const ev = new a3.MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
      row.querySelector("td").dispatchEvent(ev);
      await ES_TEST.sleep(100);
      const menu = a3.document.getElementById("mailContext");
      const state = menu.state;
      menu.hidePopup();
      return [ES_TEST.input.value, state];`);
    assert.equal(r[0], "");
    assert.notEqual(r[1], "closed");
  });

  await check("context menu path (searchFromMessage) on tags", async () => {
    const r = await run(`
      await ES_TEST.clear();
      const a3 = ES_TEST.about3Pane;
      let hdr;
      for (let i = 0; i < a3.gDBView.rowCount; i++) {
        const h = a3.gDBView.getMsgHdrAt(i);
        if (h.mime2DecodedSubject.startsWith("M04")) hdr = h;
      }
      await ES_TEST.api().getController().searchFromMessage(ES_TEST.win.gTabmail.currentTabInfo, hdr, "tags");
      await ES_TEST.settle();
      return [ES_TEST.input.value, ES_TEST.listed()];`);
    assert.equal(r[0], 'tag:"To Do"');
    assert.deepEqual(r[1], ["M04"]);
  });

  await check("Shift+Enter reports that global search is disabled", async () => {
    await run("await ES_TEST.clear(); return ES_TEST.search('f:alice', { shiftKey: true });");
    const help = await run("return ES_TEST.helpText();");
    assert.match(help.text, /Global search is disabled/);
  });

  await check("Ctrl+Enter creates the ExpressionSearch saved search", async () => {
    const r = await run(`
      await ES_TEST.search("f:alice", { ctrlKey: true });
      const a3 = ES_TEST.about3Pane;
      await ES_TEST.waitFor(() => a3.gFolder?.name == "ExpressionSearch", "saved search displayed");
      await ES_TEST.waitFor(() => !a3.gViewWrapper.searching && a3.gDBView.rowCount == 2, "saved search results", 10000).catch(() => {});
      const flags = a3.gFolder.flags;
      return [a3.gFolder.name, !!(flags & Ci.nsMsgFolderFlags.Virtual), ES_TEST.listed()];`);
    assert.deepEqual(r, ["ExpressionSearch", true, ["M01", "M06"]]);
  });

  await check("saved search with one OR group is exact (group stored first)", async () => {
    const r = await run(`
      await ES_TEST.showFolder();
      await ES_TEST.search("s:report f:(alice or dave)", { ctrlKey: true });
      const a3 = ES_TEST.about3Pane;
      await ES_TEST.waitFor(() => a3.gFolder?.name == "ExpressionSearch", "saved search displayed");
      await ES_TEST.sleep(500);
      await ES_TEST.settle();
      return [ES_TEST.listed(), ES_TEST.helpText().text];`);
    assert.deepEqual(r[0], ["M01"]);
    assert.doesNotMatch(r[1], /cannot store parentheses/);
  });

  await check("Ctrl+Enter updates the saved search (mixed and/or)", async () => {
    const r = await run(`
      await ES_TEST.showFolder();
      await ES_TEST.search("(f:alice or f:bob) (s:report or s:photos)", { ctrlKey: true });
      const a3 = ES_TEST.about3Pane;
      await ES_TEST.waitFor(() => a3.gFolder?.name == "ExpressionSearch", "saved search displayed");
      await ES_TEST.sleep(500);
      await ES_TEST.settle();
      const { VirtualFolderHelper } = ChromeUtils.importESModule("resource:///modules/VirtualFolderWrapper.sys.mjs");
      const searchString = VirtualFolderHelper.wrapVirtualFolder(a3.gFolder).searchString;
      return [ES_TEST.listed(), searchString, ES_TEST.helpText().text];`);
    console.log(`       saved search string: ${r[1]}`);
    console.log(`       saved search lists: ${r[0].join(" ")} (message list gives M01 M02)`);
    assert.ok(r[0].includes("M01") && r[0].includes("M02"));
    assert.match(r[2], /cannot store parentheses/, "user is warned");
  });

  await check("option hideNormalFilter=false shows the normal box again", async () => {
    const r = await run(`
      await ES_TEST.showFolder();
      const api = ES_TEST.api();
      const doc = ES_TEST.about3Pane.document;
      api.getController().setOptions({ hideNormalFilter: false });
      const a = [doc.getElementById("qfb-qs-textbox").classList.contains("esr-normal-hidden"), ES_TEST.QuickFilterManager.textBoxDomId];
      api.getController().setOptions({});
      const b = [doc.getElementById("qfb-qs-textbox").classList.contains("esr-normal-hidden"), ES_TEST.QuickFilterManager.textBoxDomId];
      return [a, b];`);
    assert.deepEqual(r, [
      [false, "qfb-qs-textbox"],
      [true, "esr-search-textbox"],
    ]);
  });

  await check("actAsNormalFilter=false searches From/To/Subject itself", async () => {
    const r = await run(`
      const api = ES_TEST.api();
      api.getController().setOptions({ actAsNormalFilter: false });
      const listed = await ES_TEST.search("bob");
      api.getController().setOptions({});
      await ES_TEST.clear();
      return listed;`);
    assert.deepEqual(r, ["M01", "M02", "M04", "M06"]);
  });

  await check("selectFirstOnEnter selects the first result", async () => {
    const r = await run(`
      const api = ES_TEST.api();
      api.getController().setOptions({ selectFirstOnEnter: true });
      await ES_TEST.search("f:carol");
      await ES_TEST.sleep(200);
      const a3 = ES_TEST.about3Pane;
      const selected = a3.gDBView.hdrForFirstSelectedMessage?.mime2DecodedSubject;
      api.getController().setOptions({});
      await ES_TEST.clear();
      return selected;`);
    assert.match(r, /^M03/);
  });

  await check("extension pages run with the WebExtension APIs (help and options)", async () => {
    const r = await run(`
      const ext = ES_TEST.extension();
      const tabmail = ES_TEST.win.gTabmail;
      const title = t => t.browser?.contentTitle;
      // Both pages set their title from messages.json via messenger.i18n,
      // i.e. only if their scripts ran with the extension APIs available.
      const installed = await ES_TEST.waitFor(
        () => tabmail.tabInfo.find(t => t.mode.name == "contentTab" && title(t) == "Expression Search Reloaded help"),
        "help tab from onInstalled", 10000);
      const options = tabmail.openTab("contentTab", { url: ext.baseURI.resolve("options/options.html") });
      await ES_TEST.waitFor(() => title(options) == "Expression Search Reloaded options", "options page scripted", 10000);
      const result = [title(installed), title(options), options.browser.isRemoteBrowser];
      tabmail.closeTab(options);
      return result;`);
    assert.deepEqual(r, ["Expression Search Reloaded help", "Expression Search Reloaded options", true]);
  });

  await check("background: help button wakes the event page and opens help", async () => {
    const r = await run(`
      const tabmail = ES_TEST.win.gTabmail;
      const helpTabs = () => tabmail.tabInfo.filter(t => t.mode.name == "contentTab" && /\\/help\\/help\\.html$/.test(t.browser?.currentURI?.spec || "")).length;
      await ES_TEST.waitFor(() => helpTabs() >= 1, "help tab from onInstalled", 10000).catch(() => {});
      const before = helpTabs();
      const ext = ES_TEST.extension();
      // Suspend the event page first (MV3), then click the button.
      await ext.terminateBackground?.({ ignoreDevToolsAttached: true }).catch?.(() => {});
      await ES_TEST.sleep(300);
      tabmail.switchToTab(0);
      ES_TEST.about3Pane.document.getElementById("esr-search-help-button").click();
      await ES_TEST.waitFor(() => helpTabs() > before, "help tab from button", 15000);
      const after = helpTabs();
      for (const t of [...tabmail.tabInfo]) if (t.mode.name == "contentTab") tabmail.closeTab(t);
      tabmail.switchToTab(0);
      return [before, after];`);
    assert.equal(r[0], 1, "help page opened once after install");
    assert.equal(r[1], r[0] + 1);
  });

  await check("options saved in storage reach the experiment via the event page", async () => {
    const r = await run(`
      const { ExtensionStorageIDB } = ChromeUtils.importESModule("resource://gre/modules/ExtensionStorageIDB.sys.mjs");
      const ext = ES_TEST.extension();
      const api = ES_TEST.api();
      const db = await ExtensionStorageIDB.open(ExtensionStorageIDB.getStoragePrincipal(ext));
      const { options } = await db.get(["options"]);
      await ext.terminateBackground?.({ ignoreDevToolsAttached: true });
      const changes = await db.set({ options: { ...options, searchTimeout: 1234, bogus: "x", showHelp: "yes" } });
      ExtensionStorageIDB.notifyListeners(ext.id, changes);
      await ES_TEST.waitFor(() => api.controller.options.searchTimeout == 1234, "options applied", 15000);
      const applied = { ...api.controller.options };
      const restore = await db.set({ options });
      ExtensionStorageIDB.notifyListeners(ext.id, restore);
      await ES_TEST.waitFor(() => api.controller.options.searchTimeout == options.searchTimeout, "options restored", 15000);
      return [applied.searchTimeout, "bogus" in applied, applied.showHelp];`);
    assert.deepEqual(r, [1234, false, true], "sanitised: unknown key dropped, bad type replaced");
  });

  await check("a second messenger window gets the search box", async () => {
    const r = await run(`
      const win2 = ES_TEST.win.open("chrome://messenger/content/messenger.xhtml", "_blank", "chrome,all,dialog=no");
      const box = await ES_TEST.waitFor(() => {
        const a3 = win2.gTabmail?.tabInfo?.[0]?.chromeBrowser?.contentDocument;
        return a3?.getElementById("esr-search-textbox");
      }, "box in second window", 20000);
      const ok = !!box;
      win2.close();
      await ES_TEST.sleep(500);
      const panes = ES_TEST.api().controller.panes.size;
      return [ok, panes];`);
    assert.deepEqual(r, [true, 1], "pane of the closed window is released");
  });

  await check("a newly opened mail tab gets the search box too", async () => {
    const r = await run(`
      const tabmail = ES_TEST.win.gTabmail;
      const tab = tabmail.openTab("mail3PaneTab", { folderURI: ES_TEST.folder.URI, background: false });
      await ES_TEST.waitFor(() => tab.chromeBrowser.contentDocument?.getElementById("esr-search-textbox"), "box in new tab");
      const ok = !!tab.chromeBrowser.contentDocument.getElementById("esr-search-textbox");
      tabmail.closeTab(tab);
      tabmail.switchToTab(0);
      return ok;`);
    assert.equal(r, true);
  });

  await check("uninstall removes everything and leaves the quick filter working", async () => {
    const r = await run(`
      await ES_TEST.showFolder();
      await ES_TEST.search("f:alice");
      await ES_TEST.uninstall();
      await ES_TEST.settle();
      const a3 = ES_TEST.about3Pane;
      const doc = a3.document;
      const state = {
        box: !!doc.getElementById("esr-search-container"),
        normalHidden: doc.getElementById("qfb-qs-textbox").classList.contains("esr-normal-hidden"),
        textBoxDomId: ES_TEST.QuickFilterManager.textBoxDomId,
        filterDefined: !!ES_TEST.QuickFilterManager.filterDefsByName.expressionSearchReloaded,
        stateLeft: "expressionSearchReloaded" in a3.quickFilterBar.filterer.filterValues,
        listed: ES_TEST.listed(),
        terms: ES_TEST.customTermState(),
      };
      // The quick filter bar must keep working, including Escape.
      a3.quickFilterBar.filterer.setFilterValue("starred", true);
      a3.quickFilterBar.updateSearch();
      await ES_TEST.settle();
      state.starred = ES_TEST.listed();
      ES_TEST.key(doc.getElementById("qfb-qs-textbox"), "Escape");
      await ES_TEST.settle();
      state.afterEscape = ES_TEST.listed();
      return state;`);
    assert.equal(r.box, false);
    assert.equal(r.normalHidden, false);
    assert.equal(r.textBoxDomId, "qfb-qs-textbox");
    assert.equal(r.filterDefined, false);
    assert.equal(r.stateLeft, false);
    assert.deepEqual(r.listed, ALL);
    assert.ok(r.terms.every(([, active]) => !active), "custom terms deactivated");
    assert.deepEqual(r.starred, ["M05"]);
    assert.deepEqual(r.afterEscape, ALL);
  });

  await check("reinstall works without restart", async () => {
    await client.installAddon(addonPath);
    const r = await run(`
      await ES_TEST.waitFor(() => ES_TEST.input, "search box after reinstall");
      await ES_TEST.showFolder();
      const listed = await ES_TEST.search("bodyre:tracking");
      return [listed, ES_TEST.customTermState().every(([, a]) => a)];`);
    assert.deepEqual(r, [["M01"], true]);
  });

  await check("no errors from the add-on in the console", async () => {
    const errors = await run(`
      return Services.console.getMessageArray()
        .filter(m => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
        .map(m => m.errorMessage + " @ " + m.sourceName + ":" + m.lineNumber)
        .filter(s => /expression|ExpressionSearch|moz-extension|es-test/i.test(s))
        // Platform noise when extension pages are torn down on uninstall
        // (seen on 153 ESR); not caused by add-on code.
        .filter(s => !(s.startsWith("sendRemoveListener on closed conduit") && s.includes("ConduitsChild.sys.mjs")));`);
    assert.deepEqual(errors, []);
  });
} catch (e) {
  results.push(["harness", false, e]);
  console.error(e);
} finally {
  await client.quit();
  await new Promise(r => setTimeout(r, 1500));
  child.kill();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
