// Render the screenshots for the add-on listing and README in a headless,
// throw-away Thunderbird with a fictional demo mailbox.
//
//   npm run build && node scripts/screenshots.mjs [path/to/thunderbird]
//
// Output: docs/screenshots/*.png

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchThunderbird } from "../tests/integration/marionette.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json"), "utf8"));
const xpi = path.join(root, "dist", `expression-search-reloaded-${manifest.version}.xpi`);
const outDir = path.join(root, "docs/screenshots");
const profileRoot = process.env.ES_PROFILE_ROOT || path.join(root, "tests/.profiles");
if (!fs.existsSync(xpi)) {
  console.error(`Build first: ${xpi} is missing`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const { child, client } = await launchThunderbird({
  binary: process.argv[2] || process.env.THUNDERBIRD_BIN || "/snap/bin/thunderbird",
  profileDir: path.join(profileRoot, "screenshots"),
  logFile: path.join(profileRoot, "screenshots.log"),
  // In-process extension pages, so that they are part of the window capture.
  extraPrefs: { "extensions.webextensions.remote": false, "mail.threadpane.listview": 1 },
});
const run = (body, ...args) => client.exec(body, args);

/** Capture one chrome element (by id), e.g. the browser of a tab. */
async function shot(name, elementId) {
  await new Promise(r => setTimeout(r, 400));
  const found = await client.send("WebDriver:FindElement", { using: "css selector", value: `#${elementId}` });
  const ref = found.value ?? found;
  const id = typeof ref == "string" ? ref : Object.values(ref)[0];
  const { value } = await client.send("WebDriver:TakeScreenshot", { id, full: false, hash: false });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(value, "base64"));
  console.log(`docs/screenshots/${name}.png`);
}

try {
  await client.send("WebDriver:SetWindowRect", { x: 0, y: 0, width: 1280, height: 800 });
  await run(fs.readFileSync(path.join(root, "tests/integration/chrome-helpers.js"), "utf8"));

  // A fictional mailbox (example.* domains only).
  await run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    try { MailServices.accounts.localFoldersServer; } catch (e) { MailServices.accounts.createLocalMailAccount(); }
    const root = MailServices.accounts.localFoldersServer.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    const folder = root.createLocalSubfolder("Projects");
    for (const name of ["Archive", "Receipts", "Travel"]) root.createLocalSubfolder(name);
    const local = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    const now = Date.now();
    const day = 86400000;
    const pad = n => String(n).padStart(2, "0");
    const rfc = d => d.toUTCString().replace("GMT", "+0000");
    const msgs = [
      ["Alice Johnson <alice@example.com>", "Q3 budget review - final numbers", 0.2, "Hi team, attached are the final Q3 numbers.", "budget-q3.xlsx", ["$label1"], false],
      ["Bob Martinez <bob@example.org>", "Re: Offsite agenda", 0.6, "Looks good, see you on Thursday.", null, [], true],
      ["Northwind Traders <billing@northwind.example>", "Invoice #2041 for September", 1.2, "Please find your invoice attached.", "invoice-2041.pdf", ["$label4"], false],
      ["Carol Nguyen <carol@example.net>", "Design review: onboarding flow", 2, "Here are the mock-ups for tomorrow.", "onboarding-v3.pdf", [], true],
      ["Contoso Cloud <receipts@contoso.example>", "Your receipt from Contoso Cloud", 3, "Thanks for your payment.", "receipt-88412.pdf", [], true],
      ["Alice Johnson <alice@example.com>", "Re: Hiring plan for 2027", 4, "I added two roles to the plan.", null, ["$label2"], true],
      ["Dave Okafor <dave@example.com>", "Release notes 5.2 draft", 5, "Draft is ready for review.", "release-notes.docx", [], true],
      ["Fabrikam Air <noreply@fabrikam.example>", "Flight confirmation FA 723 to Lisbon", 8, "Your booking is confirmed.", "eticket.pdf", [], true],
      ["Bob Martinez <bob@example.org>", "Lunch on Friday?", 9, "The new place around the corner?", null, [], true],
      ["Erin Walsh <erin@example.org>", "Contract renewal - please sign", 12, "Two copies attached.", "contract-2027.pdf", ["$label1"], false],
      ["Alice Johnson <alice@example.com>", "Quarterly report draft", 20, "First draft, comments welcome.", "q2-report.pdf", [], true],
      ["Northwind Traders <billing@northwind.example>", "Invoice #1987 for August", 34, "Please find your invoice attached.", "invoice-1987.pdf", [], true],
      ["Carol Nguyen <carol@example.net>", "Usability test results", 41, "Summary inside.", null, [], true],
      ["Contoso Cloud <receipts@contoso.example>", "Your receipt from Contoso Cloud", 33, "Thanks for your payment.", "receipt-80117.pdf", [], true],
      ["Dave Okafor <dave@example.com>", "Re: Performance regression in search", 50, "Fixed in the nightly build.", null, [], true],
      ["Alice Johnson <alice@example.com>", "Board deck - July", 62, "Slides for the board meeting.", "board-july.pptx", [], true],
      ["Northwind Traders <billing@northwind.example>", "Invoice #1932 for July", 65, "Please find your invoice attached.", "invoice-1932.pdf", [], true],
      ["Alice Johnson <alice@example.com>", "Team photos from the offsite", 70, "As promised!", "offsite.zip", [], true],
      ["Northwind Traders <billing@northwind.example>", "Invoice #1874 for June", 96, "Please find your invoice attached.", "invoice-1874.pdf", [], true],
      ["Bob Martinez <bob@example.org>", "Re: Parking permits", 101, "Done, thanks.", null, [], true],
      ["Alice Johnson <alice@example.com>", "Signed NDA - Fabrikam", 120, "Scan attached.", "nda-fabrikam.pdf", [], true],
    ];
    for (const [from, subject, ago, body, file, tags, read] of msgs) {
      const date = new Date(now - ago * day);
      const lines = ["From: " + from, "To: You <you@example.com>", "Subject: " + subject, "Date: " + rfc(date),
        "Message-ID: <" + Math.random().toString(36).slice(2) + "@example.com>", "MIME-Version: 1.0"];
      let raw;
      if (file) {
        raw = [...lines, 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain; charset=UTF-8", "", body,
          "--b", 'Content-Type: application/octet-stream; name="' + file + '"', 'Content-Disposition: attachment; filename="' + file + '"',
          "Content-Transfer-Encoding: base64", "", "SGVsbG8=", "--b--", ""].join("\\r\\n");
      } else {
        raw = [...lines, "Content-Type: text/plain; charset=UTF-8", "", body, ""].join("\\r\\n");
      }
      const hdr = local.addMessage(raw);
      if (tags.length) folder.addKeywordsToMessages([hdr], tags.join(" "));
      folder.markMessagesRead([hdr], read);
    }
    ES_TEST.folder = folder;
  `);

  await client.installAddon(xpi);
  await run(`
    await ES_TEST.waitFor(() => ES_TEST.input, "search box");
    const tabmail = ES_TEST.win.gTabmail;
    for (const t of [...tabmail.tabInfo]) if (t.mode.name == "contentTab") tabmail.closeTab(t);
    tabmail.switchToTab(0);
    const a3 = ES_TEST.about3Pane;
    await ES_TEST.waitFor(() => a3.folderPane?.getRowForFolder(ES_TEST.folder.URI), "folder row");
    a3.displayFolder(ES_TEST.folder.URI);
    await ES_TEST.waitFor(() => a3.gFolder?.URI == ES_TEST.folder.URI && a3.gDBView?.rowCount == 21, "demo folder");
    a3.paneLayout.messagePaneVisible = false;
    a3.gViewWrapper.showUnthreaded = true;
    if (!a3.quickFilterBar.filterer.visible) a3.quickFilterBar._showFilterBar(true);
  `);

  // 1. Typing an expression: live help, parsed terms, filtered list.
  await run(`
    const input = ES_TEST.input;
    input.focus();
    input.value = "from:(alice or northwind) a:yes older_than:1w";
    input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
    ES_TEST.api().controller.panes.values().next().value.apply(input.value);
    input.setSelectionRange(input.value.length, input.value.length);
    await ES_TEST.settle();
    input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
    await ES_TEST.sleep(200);
  `);
  await shot("1-expression-search", await run("return ES_TEST.win.gTabmail.tabInfo[0].chromeBrowser.id;"));

  // 2. Combined with Thunderbird's own quick filter buttons.
  await run(`
    await ES_TEST.search("s:(invoice or receipt or contract) -f:contoso");
    ES_TEST.about3Pane.threadTree.table.body.focus();
  `);
  await shot("2-results", await run("return ES_TEST.win.gTabmail.tabInfo[0].chromeBrowser.id;"));

  // 3. Options, 4. Help.
  for (const [page, name] of [["options/options.html", "3-options"], ["help/help.html", "4-help"]]) {
    await run(`
      const ext = ES_TEST.extension();
      const tab = ES_TEST.win.gTabmail.openTab("contentTab", { url: ext.baseURI.resolve(arguments[0]) });
      await ES_TEST.waitFor(() => tab.browser.contentDocument?.readyState == "complete", "page");
      await ES_TEST.sleep(800);
      if (!tab.browser.id) tab.browser.id = "es-shot-" + Date.now();
      return tab.browser.id;
    `, page);
    await shot(name, (await run(`
      const t = ES_TEST.win.gTabmail.currentTabInfo;
      return t.browser.id;`)));
  }
} finally {
  await client.quit();
  await new Promise(r => setTimeout(r, 1000));
  child.kill();
}
