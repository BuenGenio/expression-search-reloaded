# Expression Search NG 2.4beta: audit and port to current Thunderbird

Date: 2026-10-03. Audited artifact: `expression-search-NG2.4beta.xpi`, the only content of the upstream repository
[opto/Expression-Search-NG](https://github.com/opto/Expression-Search-NG). It is kept in
[`legacy/`](legacy/), extracted into [`legacy/2.4beta-extracted/`](legacy/2.4beta-extracted/), which is what the
line references below point to. The result of the work is the rewrite in [`src/`](src/), published as
**Expression Search Reloaded 5.0.0**.

## 1. Summary

| Area | Verdict for 2.4beta |
|---|---|
| Compatibility | **Does not load on any supported Thunderbird.** Every module calls `ChromeUtils.import()`, which no longer exists (verified on 156.0.1: `typeof ChromeUtils.import == "undefined"`), and the UI it patches was removed in Thunderbird 115. |
| Security | No malicious code found. Seven weaknesses, the most relevant: the add-on root was exposed to web content, an unrestricted privileged "open any URL" API, a chrome-privileged help page with remote links, and expression injection from message headers via click-to-search (S1–S7). |
| Privacy | No network access, telemetry or data collection. A help/donation window opened on **every** Thunderbird start; donation buttons misrepresent their target (P1–P3). |
| Functionality | Even on Thunderbird 78 several advertised features were broken: saved search (Ctrl+Enter), global search (Shift+Enter, `g:`), the Ctrl+B hotkey, several negations, `headerre:` with a value, `2y` ages, unary minus, and cleanup on disable (F1–F14). |
| Licensing | Two files claim CC BY-ND 4.0 (no derivatives) for the Thunderbird 78 changes, which conflicts with the GPL v3 the rest is under (L1). |

Thunderbird today (sources: product-details.mozilla.org, thunderbird.net release notes): release **157.0.1**
(2026-10-01), ESR **153.4.0** and **140.17.0**. Firefox's schedule ends 140 ESR on 2026-10-13; Thunderbird
did not publish its own date.

**Upstream status.** The add-on is still maintained by opto on addons.thunderbird.net as **4.9.56** (Sep 2026,
Thunderbird 140–157, Manifest V2 with four Experiment APIs), but that source was never pushed to this
repository; GitHub only has XPI release assets up to 4.6.36. This audit covers 2.4beta only. A brief look at the
4.9.56 package during this audit (not a review) showed it still uses AOP hooks into Thunderbird internals and
registers its own `resource://` mapping, so findings S1, S5 and F12 are worth re-checking there.

## 2. Security findings (2.4beta)

| # | Severity | Finding | Where | Fixed in 5.0 by |
|---|---|---|---|---|
| S1 | Medium | **Add-on files readable by web content.** `resource://expressionsearch/` was mapped to the add-on root with `ALLOW_CONTENT_ACCESS`, so web pages (RSS articles, web content tabs) and remote-content-enabled mail can load every file of the add-on. That allows fingerprinting the add-on and reading its code and configuration. | `ex-background.js:13`, `api/BootstrapLoader/implementation.js:485-489` | No web-accessible resources. The experiment maps a private `resource://` host **without** content access only for the instant it loads its three scripts, then removes the mapping. |
| S2 | Medium | **Unrestricted privileged URL launcher.** The `Utilities` experiment exposes `openLinkExternally(url)` (any scheme goes to `nsIExternalProtocolService.loadURI`, including `file:` and arbitrary protocol handlers) and `showXhtmlPage(uri)` (opens any URL with `openDialog`, i.e. as a chrome dialog). The second is unused. Any script injection into an extension page would escalate to launching local programs. | `api/Utilities/implementation.js:31-47` | Removed. Help and options are normal extension pages opened through `tabs.create` / `runtime.openOptionsPage`. |
| S3 | Low–Medium | **Help page runs with full chrome privileges.** `help.html` is opened as `chrome://` in a chrome window or tab, and its script uses `ChromeUtils`/`Components` (system principal). The page links to many external sites, which is a privileged document hosting navigation to the web. | `content/common.js:26-32,47-59`, `content/help.js:8-24`, `content/es.js:1169` | Help is an unprivileged `moz-extension://` page under the MV3 default CSP (no inline script). |
| S4 | Low | **Expression injection from untrusted mail (click-to-search).** Ctrl+right-click copied the sender name or subject of the clicked message into the expression unquoted. Only `'"<>` were stripped from names, and subjects starting with `(` were parsed as expressions. A crafted sender or subject can inject any operator, e.g. a catastrophic `bodyre:` pattern that freezes Thunderbird when clicked. | `content/es.js:885-886, 913-924, 942` | Values are wrapped with an injection-safe `quote()`, and subjects use the literal `simple:` operator (unit test "quote() makes untrusted values inert"). |
| S5 | Low | **Unbounded main-thread work.** Body and attachment terms read whole messages synchronously (`readInputStreamToString(stream, messageSize)`), and the parser has no limits on nesting or expansion. The help text itself warns that `bodyre:` "may crash your Thunderbird". | `content/ExpressionSearchFilter.js:324-337`, `content/gmailuiParse.js` | Caps of 32 MB per message and 4 MB per text part, a nesting limit of 64, and a CNF size limit (256 clauses / 64 literals). Invalid regexes are reported instead of silently matching nothing. Regex run time itself cannot be bounded in JS; this is documented. |
| S6 | Low | **Inline event-handler strings injected into chrome documents** (`oncommand`/`onclick` attributes). They don't hold untrusted data, but they prevent CSP hardening and evaluate strings in the window scope. | `content/es.js:979, 983, 1011, 1199, 1202`, `about.xhtml`, `esPrefDialog.xhtml` | `addEventListener` only. A static test fails the build on inline handlers or scripts. |
| S7 | Info | **Debug leftovers.** `debugger;` statements; status-bar menu items for `about:config`, `about:memory` and `about:crashes`; exception popups in alert windows; devtools loader imported at startup. | `content/es.js:119, 598, 1164-1166`; `content/log.js:7, 289` | Removed. Errors go to the Error Console only. |

No `eval`, remote script loading, network requests, or credential or message exfiltration was found in 2.4beta.

## 3. Privacy findings

| # | Finding | Where | 5.0 |
|---|---|---|---|
| P1 | Positive: no network access, no tracking or telemetry. Settings live in local prefs. | – | Unchanged: no network APIs (enforced by a static test), settings in `storage.local`. |
| P2 | A help page containing a donation appeal opened in a popup window **on every Thunderbird start**. A second "first run" tab could also open. | `ex-background.js:21-23`, `content/es.js:953-968` | Help opens once, on first install only. |
| P3 | The "Alipay", "PayPal" and "Mozilla" donate buttons, and the Alipay QR-code tooltip, all lead to the same PayPal donation link, so the UI misrepresents where a donation goes. | `content/common.js:73-81`, `content/esPrefDialog.xhtml:154-174` | No payment links. Credits are kept. |
| P4 | Verbose mode logged attachment file names and search details to the Error Console. | `content/ExpressionSearchFilter.js:253, 265, 279, 421` | Opt-in verbose mode logs only the expression and its parsed terms; no message content. |

## 4. Functional defects found in 2.4beta

| # | Defect | Where |
|---|---|---|
| F1 | Ctrl+Enter (saved search) and Shift+Enter / `g:` (global search) throw `ReferenceError`: `ExperssionSearchFilter` is a local variable of `importModules()` but is used at module level. | `content/es.js:154, 566, 569` |
| F2 | Saved search also uses the undefined `fixIterator` and `alert`. The same applies to the virtual-folder dialog helpers and the SearchSpec clone path. | `content/es.js:326, 686, 693, 699, 722, 1251, 1265` |
| F3 | Ctrl+B (focus) throws with the default settings: bare `QuickFilterBarMuxer` inside a JS module. | `content/es.js:1127` |
| F4 | Calculator unary minus throws: `calculateResult` is called without `this.`. | `content/es.js:798` |
| F5 | `tag:` with a name matching no tag throws (`null.length`), killing the whole search. | `content/ExpressionSearchFilter.js:611-612` |
| F6 | These negations silently had no effect, because the term checked a different operator than the one the converter set: `-filename:` / `-a:name` (Contains vs DoesntMatch), `-date:` (Matches vs DoesntContain), `-fromre:` and `-tore:` (Contains vs DoesntMatch). | `content/ExpressionSearchFilter.js:184, 194, 202, 344, 660, 818-823` |
| F7 | `headerre:Header=regex` never matched, because the header name wasn't lower-cased. | `content/ExpressionSearchFilter.js:160-162` |
| F8 | Age units `y` / `2y` (documented) produced `NaN`; only `yea…` was recognised. | `content/ExpressionSearchFilter.js:777-790` |
| F9 | The alias `si` was defined for both `size` and `simple`. The help documents `si:` as size, but it searched the subject. | `content/gmailuiParse.js:24, 27` |
| F10 | Mixed and/or expressions were mis-grouped. The CNF transform was a single top-down pass, and top-level ORs produced a first term with `booleanAnd=false`, which Thunderbird flattens. 2.4beta papered over this by globally patching `SearchSpec._flattenGroupifyTerms`, which affected every search in the window. | `content/gmailuiParse.js:636-650`, `content/es.js:316-344` |
| F11 | "Select first message on Enter" and ↓ to the message list did nothing on TB 78 (`treeBoxObject` was already removed). | `content/es.js:752-753` |
| F12 | Disabling the add-on left hooks behind: the listener-removal typo `RemoveEventListener`, the quick filter definition never removed, `textBoxDomId` never restored, modules never unloaded, and custom terms pointing at unloaded code. | `content/es.js:373-374`, `content/ExpressionSearchFilter.js:878-879`, `bootstrap.js:97-99` |
| F13 | The zh-CN translation is shipped but not registered; "de" is a copy of English; the options dialog references an unregistered `skin` package. | `ex-background.js:3-15`, `locale/de/*`, `content/esPrefDialog.xhtml:3` |
| F14 | Dead or broken code paths: `autoArchive.addMenuItem`, `aArbitraryHeader`/`aHdrProperty`, a discarded `replace()` result. The `installed_version` default equals the current version, so first-install detection never fires. | `content/es.js:1142`; `content/ExpressionSearchFilter.js:412, 587-589`; `content/defaults.js:1` |

## 5. Compatibility with current Thunderbird

* **JSM loader removed.** `ChromeUtils.import()` was removed in Gecko 136 (bug 1881888). `Services.jsm`, `iteratorUtils.jsm`, `QuickFilterManager.jsm`, `SearchSpec.jsm`, `VirtualFolderWrapper.jsm`, `GlodaUtils.jsm`, `MimeMessage.jsm`, `jsmime.jsm`, `NetUtil.jsm` and the devtools `Loader.jsm` no longer exist; the replacements are `.sys.mjs` modules via `ChromeUtils.importESModule`.
* **Wrapped WebExtension unsupported.** The BootstrapLoader approach has been unsupported since Thunderbird 128, and the helper repository removed it.
* **3-pane rewrite (Thunderbird 115+).** Every UI target 2.4beta patches is gone or changed:
  * `QuickFilterBarMuxer`, `gFolderDisplay` and the outer-window `gDBView`;
  * the XUL thread tree and `treeBoxObject`;
  * the XUL `search-textbox` (now `<search-bar>` inside `about:3pane`);
  * the `mail-bar3` and `mail-toolbar-menubar2` placements (now the unified toolbar);
  * the virtual-folder picker internals (`gSelectVirtual._toggle`, `gFolderTreeView`).
* **Manifest.** It uses the deprecated `applications` key, Manifest V2 and no `strict_max_version`, even though it depends heavily on Thunderbird internals.

## 6. The port (version 5.0.0, `src/`)

**Architecture.** A Manifest V3 MailExtension does everything that WebExtension APIs can do:
* settings in `storage.local`, with an options page;
* the help page;
* the message-list context menu (`menus`);
* migration of 2.x settings.

One small Experiment (`api/ExpressionSearch/`) covers what has no WebExtension API. Thunderbird offers no API to put an input field into the quick filter bar, to add custom search terms, or to create saved searches (verified against the 156 API docs):
* adds the search box to the quick filter bar of every mail tab and window, and removes it on shutdown;
* contributes its terms through Thunderbird's own extension point, `QuickFilterManager.defineFilter()`, so they combine with Unread/Starred/Tags/… with no monkey-patching;
* registers the eleven custom search terms behind proxies whose implementation is swapped in and out, because Thunderbird cannot unregister custom terms;
* click-to-search, saved search and global search.

**Security properties.**
* No network APIs, no remote code, no web-accessible resources, and no content-accessible `resource://` mapping.
* Pages use the MV3 default CSP: no inline scripts or handlers.
* Experiment parameters are validated by the schema (enums, patterns, lengths); options are sanitised to known keys, types and ranges before the privileged code sees them.
* Untrusted message data is quoted before it becomes an expression.
* Resource limits as listed in S5.
* Static tests in `tests/unit/static.test.mjs` enforce most of these.

**Feature mapping.**

| 2.4beta feature | 5.0 |
|---|---|
| Expression box, operators, aliases, calculator, `g:` | Kept. The parser is rewritten with correct CNF and fixes F4–F9 (36 unit tests including a fuzz test). |
| Quick filter integration, "act as normal filter", hide normal filter, search delay, select first on Enter, ↓ / Esc keys | Kept. Ctrl+Shift+K focuses the box when the normal box is hidden. |
| Help tooltip while typing | Now a popup under the box. It shows operator help, the parsed terms, errors, how many messages could be body-searched, and a hint to use global search when nothing matches. |
| 11 custom search terms (also in filters, the search dialog and saved searches) | Kept and fixed (F6, F7), with size limits. |
| Ctrl+Enter saved search (location, keep folders, open in tab) | Kept and fixed (F1, F2). With one OR group it is now stored exactly; Thunderbird's saved-search format cannot store parentheses, so expressions with two or more OR groups are flagged to the user. |
| Shift+Enter global search | Kept and fixed (F1). |
| Ctrl/Shift + right-click to search, subject regex replace, remove domain | Kept, for table and cards view; injection-safe (S4). Also available as an *Expression Search* submenu of the message-list context menu. |
| Searchable headers for `headerre:` | Options page field for `mailnews.customDBHeaders`, with validation. |
| Options dialog (XUL), about dialog, status-bar icon and menu | Replaced by the options page, the help page and a **?** button next to the box. |
| Move box to toolbar/menubar/tabbar, button-label and results-label sizing | **Dropped.** They manipulated the pre-115 XUL quick filter bar; the current bar is responsive and the unified toolbar does not accept foreign input fields. |
| Ctrl+B, Ctrl+Alt+← (back to the original folder) | **Dropped** in favour of Thunderbird's own Ctrl+Shift+K and normal folder navigation. |
| Select all / clear all / child-selection mode in the saved-search folder picker | **Dropped**, because it patched a dialog Thunderbird has since rewritten. It can be re-added as a separate hook if needed. |
| Donation links, startup popup | Removed (P2, P3). |
| Locales | `en` and `zh_CN` (the original Chinese strings, now actually registered). |

**Testing (all on Linux aarch64, separate throw-away profiles, never the user's profile):**

* `npm test`: 36 unit and static tests, covering the parser and the security and locale rules.
* `tests/integration/run.mjs`: 89 end-to-end checks in headless Thunderbird via Marionette. They cover:
  * 61 expressions against a seeded folder with attachments, a forwarded message, HTML bodies, tags, flags, dates, Bcc and a custom DB header;
  * click-to-search, saved search, global search, Escape, the calculator and error display;
  * combination with the other quick filter buttons;
  * options flowing from storage through the suspended event page to the experiment, and 2.x settings migration;
  * help and options pages running with their APIs, new tabs and windows, and a clean uninstall plus reinstall without restart.
* `tests/integration/options.mjs`: 7 checks that drive the options page DOM (localization, folder picker, validation, custom headers, restore defaults).
* Final results with the packaged XPI (the unpacked `src/` passed the same main suite):

| Thunderbird | unit/static | run.mjs | options.mjs |
|---|---|---|---|
| 157.0 (current release) | 36/36 | **89/89** | **7/7** |
| 156.0.1 | 36/36 | **89/89** | **7/7** |
| 153.3.1esr (current ESR) | 36/36 | **89/89** | **7/7** |

**Residual risks and limitations.**
* Experiments run with full privileges and depend on Thunderbird internals: `QuickFilterManager`, `quickFilterBar`, `about:3pane` markup and thread-row classes. The manifest therefore pins `strict_min_version` 153.0 and `strict_max_version` 157.*. Re-run the integration suite before raising the maximum (Thunderbird ships every 2 weeks; 158 is in beta).
* ESR 140 was not tested. It is end-of-life within days, so it is excluded.
* User-entered regular expressions can still be slow (catastrophic backtracking); this is documented.
* Body, attachment-name and body-regex searches need offline copies of the messages.
* After disabling or updating the add-on, custom terms used in message filters keep the old behaviour until restart.
* Saved searches with several OR groups are approximate (Thunderbird format limitation; the user is told).

## 7. Recommendations

1. **Add-on identity (done).** The rewrite is published as a separate add-on, *Expression Search Reloaded*, with
   its own ID `expression-search-reloaded@buengenio.github.io`, its own DOM and quick-filter names, and the same
   custom search term IDs (`expressionsearch#…`) so that existing filters and saved searches keep working.
   Settings in `extensions.expressionsearch.*` preferences are migrated on first install.
2. Settle the licence question (L1) with upstream before redistributing. The rewrite contains no code from the two CC BY-ND files; everything else derives from GPL v3/MPL code and is distributed as GPL v3.
3. Because 4.9.56 is what users actually run today, consider auditing it too. Its source is only available as the ATN XPI.
4. Experiment add-ons are reviewed manually on ATN. Keep the source readable (no bundling or minification), as it is now.

## L1. Licensing note

`content/help.js:1-6` and `content/help_bckg.js:1-6` state that the Thunderbird 78 additions are under CC BY-ND 4.0 (no derivatives). The rest of the code is GPL v3 / MPL, and the shipped `LICENSE` is GPL v3. A no-derivatives licence is incompatible with modifying and redistributing the code under the GPL. This is not legal advice.
