// Chrome-context helpers for the integration tests. Evaluated once inside
// Thunderbird through Marionette; defines globalThis.ES_TEST.
/* eslint-env browser */
/* global Services, ChromeUtils, Ci, Cc */

const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const { QuickFilterManager } = ChromeUtils.importESModule("resource:///modules/QuickFilterManager.sys.mjs");
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

const ADDON_ID = "expression-search-reloaded@buengenio.github.io";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch (e) {
      value = null;
    }
    if (value) {
      return value;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(100);
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}
/** RFC 2822 date in local time. */
function rfcDate(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${days[d.getDay()]}, ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

function message({ id, from, to, cc, bcc, subject, date, body, html, attachments = [], headers = {} }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`,
    `Date: ${rfcDate(date)}`,
    `Message-ID: <${id}@es-test.invalid>`,
    "MIME-Version: 1.0",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  const textPart = html
    ? ["Content-Type: text/html; charset=UTF-8", "", html]
    : ["Content-Type: text/plain; charset=UTF-8", "", body || ""];
  if (!attachments.length) {
    return [...lines, ...textPart, ""].join("\r\n");
  }
  const parts = [...lines, 'Content-Type: multipart/mixed; boundary="es-boundary"', "", "--es-boundary", ...textPart];
  for (const a of attachments) {
    parts.push("--es-boundary");
    if (a.type == "message/rfc822") {
      parts.push("Content-Type: message/rfc822", "Content-Disposition: attachment", "", ...a.content.split(/\r?\n/));
    } else {
      parts.push(
        `Content-Type: ${a.type}; name="${a.name}"`,
        `Content-Disposition: attachment; filename="${a.name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        "SGVsbG8gd29ybGQ="
      );
    }
  }
  parts.push("--es-boundary--", "");
  return parts.join("\r\n");
}

const now = new Date();
const daysAgo = n => new Date(now.getTime() - n * 86400000);

const MESSAGES = [
  {
    id: "M01",
    from: "Alice Smith <alice@example.com>",
    to: "Bob <bob@example.org>",
    subject: "M01 Weekly report",
    date: new Date(2024, 2, 1, 9, 15),
    body: "The tracking number is 123456.",
    tags: ["$label1"],
    read: true,
  },
  {
    id: "M02",
    from: "Bob <bob@example.org>",
    to: "Alice <alice@example.com>, Carol <carol@example.net>",
    cc: "Dave <dave@example.com>",
    subject: "Re: M02 Weekly report",
    date: new Date(2024, 2, 2, 15, 30),
    html: "<html><body><p>Hello <b>World</b></p></body></html>",
    replied: true,
    read: true,
  },
  {
    id: "M03",
    from: "Carol <carol@example.net>",
    to: "Alice <alice@example.com>",
    subject: "M03 Invoice (urgent) - pay now",
    date: new Date(2023, 0, 10, 3, 30),
    body: "Please pay.",
    attachments: [{ type: "application/pdf", name: "invoice.pdf" }],
  },
  {
    id: "M04",
    from: "Dave <dave@example.com>",
    to: "Bob <bob@example.org>",
    subject: "M04 Photos",
    date: new Date(2025, 5, 1, 12, 0),
    body: "Photos attached.",
    attachments: [{ type: "image/jpeg", name: "beach.jpg" }],
    headers: { "List-Id": "Team list <team.example.com>" },
    tags: ["$label4"],
    read: true,
  },
  {
    id: "M05",
    from: "Prize <spam@spam.example>",
    to: "Alice <alice@example.com>",
    subject: "M05 You won",
    date: daysAgo(0.01),
    body: "Click here.",
    starred: true,
    read: true,
  },
  {
    id: "M06",
    from: "Alice Smith <alice@example.com>",
    to: "Bob <bob@example.org>",
    bcc: "Eve <eve@example.com>",
    subject: "M06 Secret plan",
    date: daysAgo(3),
    body: "See the forwarded message.",
    attachments: [
      {
        type: "message/rfc822",
        content: "From: x@example.com\r\nSubject: Original Message\r\n\r\nInner body",
      },
    ],
    read: true,
  },
];

const T = {
  ADDON_ID,
  sleep,
  waitFor,
  MailServices,
  QuickFilterManager,

  get win() {
    return Services.wm.getMostRecentWindow("mail:3pane");
  },
  /** about:3pane of the first mail tab (the help tab may be in front). */
  get about3Pane() {
    const tab = this.win.gTabmail.tabInfo.find(t => t.mode.name == "mail3PaneTab");
    return tab?.chromeBrowser.contentWindow;
  },

  setupFolder() {
    try {
      MailServices.accounts.localFoldersServer;
    } catch (e) {
      MailServices.accounts.createLocalMailAccount();
    }
    const root = MailServices.accounts.localFoldersServer.rootFolder;
    const name = "es-test";
    if (root.containsChildNamed(name)) {
      this.folder = root.getChildNamed(name);
      return this.folder.URI;
    }
    const folder = root.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder(name);
    const local = folder.QueryInterface(Ci.nsIMsgLocalMailFolder);
    for (const m of MESSAGES) {
      const hdr = local.addMessage(message(m));
      if (m.tags) {
        folder.addKeywordsToMessages([hdr], m.tags.join(" "));
      }
      folder.markMessagesRead([hdr], !!m.read);
      if (m.starred) {
        folder.markMessagesFlagged([hdr], true);
      }
      if (m.replied) {
        folder.addMessageDispositionState(hdr, Ci.nsIMsgFolder.nsMsgDispositionState_Replied);
      }
    }
    this.folder = folder;
    return folder.URI;
  },

  async showFolder() {
    this.win.gTabmail.switchToTab(0);
    const a3 = this.about3Pane;
    await waitFor(() => a3.document.readyState == "complete" && a3.folderPane?.getRowForFolder(this.folder.URI), "folder row");
    a3.displayFolder(this.folder.URI);
    await waitFor(() => a3.gFolder?.URI == this.folder.URI && a3.gDBView, "folder displayed");
    a3.quickFilterBar._resetFilterState();
    if (this.input) {
      this.input.value = "";
    }
    a3.gViewWrapper.showUnthreaded = true;
    await waitFor(() => a3.gDBView.rowCount == MESSAGES.length, "all messages listed");
    if (!a3.quickFilterBar.filterer.visible) {
      a3.quickFilterBar._showFilterBar(true);
    }
    return a3.gDBView.rowCount;
  },

  get input() {
    return this.about3Pane.document.getElementById("esr-search-textbox");
  },

  listed() {
    const view = this.about3Pane.gDBView;
    const ids = [];
    for (let i = 0; i < view.rowCount; i++) {
      try {
        ids.push(/M\d\d/.exec(view.getMsgHdrAt(i).mime2DecodedSubject)?.[0]);
      } catch (e) {}
    }
    return ids.filter(Boolean).sort();
  },

  async settle() {
    const a3 = this.about3Pane;
    await sleep(50);
    let quiet = 0;
    while (quiet < 3) {
      await sleep(60);
      quiet = a3.gViewWrapper.searching ? 0 : quiet + 1;
    }
  },

  key(target, key, modifiers = {}) {
    const keyCode = { Enter: 13, Escape: 27, ArrowDown: 40 }[key] || 0;
    target.dispatchEvent(
      new target.ownerDocument.defaultView.KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true, ...modifiers })
    );
  },

  /** Row element of the message whose subject starts with `id`. */
  async rowFor(id) {
    const a3 = this.about3Pane;
    return waitFor(() => {
      const view = a3.gDBView;
      for (let i = 0; i < view.rowCount; i++) {
        if (view.getMsgHdrAt(i).mime2DecodedSubject.startsWith(id)) {
          return a3.threadTree.getRowAtIndex(i);
        }
      }
      return null;
    }, `row ${id}`);
  },

  /** Type an expression, press Enter, return the listed message ids. */
  async search(text, modifiers = {}) {
    const input = this.input;
    input.focus();
    input.value = text;
    input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
    this.key(input, "Enter", modifiers);
    await this.settle();
    return this.listed();
  },

  async clear() {
    return this.search("");
  },

  helpText() {
    const help = this.about3Pane.document.getElementById("esr-search-help");
    return help ? { hidden: help.hidden, text: help.innerText } : null;
  },

  api() {
    const ext = ExtensionParent.GlobalManager.getExtension(ADDON_ID);
    return ext?.apiManager.getAPI("ExpressionSearch", ext, "addon_parent");
  },

  extension() {
    return ExtensionParent.GlobalManager.getExtension(ADDON_ID);
  },

  async uninstall() {
    const addon = await AddonManager.getAddonByID(ADDON_ID);
    await addon.uninstall();
  },

  customTermState() {
    return MailServices.filters
      .getCustomTerms()
      .filter(t => t.id.startsWith("expressionsearch#"))
      .map(t => [t.id, !!t.wrappedJSObject?.delegate]);
  },
};

globalThis.ES_TEST = T;
