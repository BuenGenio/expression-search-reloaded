# addons.thunderbird.net listing

Copy-paste source for the listing of Expression Search Reloaded on
[addons.thunderbird.net](https://addons.thunderbird.net) (ATN). Keep it in sync with the add-on. Only the HTML tags
`a, b, i, em, strong, code, ul, ol, li, blockquote` are allowed in ATN text fields; line breaks are preserved.

## Basic information

| Field | Value |
|---|---|
| Name | Expression Search Reloaded |
| Add-on URL (slug) | `expression-search-reloaded` |
| Categories | Message and News Reading · Folders and Filters |
| Tags | search, quick filter, filter, regex, gmail |
| Homepage | https://github.com/BuenGenio/expression-search-reloaded |
| Support site | https://github.com/BuenGenio/expression-search-reloaded/issues |
| License | GNU General Public License v3.0 |
| Privacy policy | none needed (no data collection); see the description |
| Requires source code submission? | No: the package contains the plain, unminified source |

### Summary (max. 250 characters)

```
Gmail-style search in Thunderbird's quick filter bar: type from:alice a:yes older_than:1w. And/or/not, regular expressions, click-to-search, saved searches. Open-source continuation of Expression Search / GMailUI.
```

### Description

```
Search your mail the way you think: type an <b>expression</b> into the quick filter bar and the message list filters instantly.

<code>from:alice a:yes older_than:1w</code> — mail from Alice with an attachment, older than a week
<code>s:(invoice or receipt) -is:read</code> — unread invoices and receipts
<code>t:(team -bob) after:2026/09/01</code> — sent to the team but not to Bob, since September
<code>bodyre:/order #\d{6}/i</code> — regular expression on the message body

<b>Features</b>
<ul>
<li>29 operators: from, to, cc, bcc, only, subject, body, all, attachment, filename, tag, account, status (is:unread, is:unreplied, is:starred, …), before/after (dates and time of day), date, older_than/newer_than, size/smaller, header — with short aliases (f:, t:, s:, a:, …)</li>
<li><b>and</b>, <b>or</b>, <b>-</b> (not), parentheses and quotes, evaluated correctly in any combination</li>
<li>Regular expressions for subject, sender, recipients, headers and body</li>
<li>Works together with Thunderbird's Unread / Starred / Contact / Tags / Attachment buttons; Ctrl+Shift+K focuses the box</li>
<li>Live help while you type: explains the operator and shows how the expression was understood</li>
<li><b>Click to search</b>: Ctrl+right-click a subject, sender, recipient, tag or date — or use the "Expression Search" context menu</li>
<li><b>Ctrl+Enter</b> turns the expression into a saved search across the whole account; <b>Shift+Enter</b> runs a global search</li>
<li>An "Unreplied" button in the quick filter bar</li>
<li>Adds 12 criteria (Subject/From/Recipients/Body/Header RegEx, Bcc, attachment name, time of day, account, …) to message filters and the Search Messages dialog</li>
<li>A built-in calculator: <code>3*(4+5)</code> + Enter</li>
</ul>
<b>Privacy</b>: no network access, no data collection. Everything runs inside Thunderbird; settings stay in your profile.

<b>Open source</b>: developed in the open with automated tests against the current Thunderbird release, ESR and beta — <a href="https://github.com/BuenGenio/expression-search-reloaded">source, issues and roadmap on GitHub</a>.

Expression Search Reloaded continues Expression Search / GMailUI by Opera Wang (based on GMailUI by Ken Mixter) and Expression Search NG 2.4 by Klaus Buecher (opto). It is a separate add-on from "Expression Search NG" — please don't install both. Existing message filters that use Expression Search criteria keep working when you switch, and settings stored in Expression Search preferences are taken over.

Why the add-on asks for full access: Thunderbird has no WebExtension API to add a search field to the quick filter bar or to add search criteria, so a small, documented Experiment does exactly that.
```

## Screenshots

Upload in this order (from [`docs/screenshots/`](screenshots/); regenerate with `node scripts/screenshots.mjs`):

| File | Caption |
|---|---|
| `1-expression-search.png` | Type an expression: the list filters as you type, and the help explains every operator. |
| `2-results.png` | Combine words with or, and, - (not) and parentheses; works with Thunderbird's quick filter buttons. |
| `3-options.png` | Options: typing behaviour, saved searches, click-to-search and searchable headers. |
| `4-help.png` | The built-in guide lists all operators with examples. |

## Version 5.0.2 (first ATN release)

### Release notes (ATN "Version notes")

```
First release of Expression Search Reloaded: the classic Gmail-style expression search, rebuilt for Thunderbird 153–157.

<b>New</b>
<ul>
<li>Works with the current quick filter bar (table and cards view, every mail tab and window) and combines with the Unread / Starred / Contact / Tags / Attachment buttons</li>
<li>Live help while typing: explains the operator and shows how the expression was understood; closes on Enter, Escape or when you leave the box</li>
<li>"Expression Search" submenu in the message list context menu: same sender, recipients, subject, tags or day</li>
<li>Options page, including the extra headers that headerre: can search</li>
<li>Settings of Expression Search 2.x / NG are taken over on first install</li>
</ul>
<b>Fixed</b> (compared with Expression Search NG 2.4)
<ul>
<li>Mixed and/or expressions are evaluated correctly; saved searches warn when Thunderbird cannot store an expression exactly</li>
<li>Negations work for -filename:, -a:name, -date:, -fromre: and -tore:; -before: / -after: are no longer off by one day</li>
<li>headerre:Header=regex, older_than:2y, si: (size), tag: with an unknown name, calculator negation</li>
<li>Ctrl+Enter (saved search) and Shift+Enter / g: (global search)</li>
</ul>
<b>Security and privacy</b>
<ul>
<li>No network access, no data collection</li>
<li>No web-accessible files, no privileged URL opener; text taken from messages can no longer inject search syntax</li>
<li>Limits on message size and expression complexity</li>
</ul>
Full changelog: <a href="https://github.com/BuenGenio/expression-search-reloaded/blob/main/CHANGELOG.md">CHANGELOG.md</a>
```

### Notes for reviewers

```
Test account: none needed. The add-on uses no website or online service; any mail folder with a few messages (Local Folders are fine) is enough to test it.

Source: the package is the plain source (no build step besides zipping): https://github.com/BuenGenio/expression-search-reloaded (tag v5.0.2). An audit of the add-on this is based on, and the reasons for each design decision, are in AUDIT.md.

Why an Experiment: there is no WebExtension API to (1) add an input to the quick filter bar of about:3pane, (2) register nsIMsgSearchCustomTerm search criteria, (3) create saved searches (virtual folders) from search terms. The Experiment (api/ExpressionSearch/) only does these things; settings, options/help pages and the context menu use WebExtension APIs. It uses QuickFilterManager.defineFilter() (Thunderbird's extension point) instead of patching Thunderbird code, and removes everything on disable (custom terms are deactivated, as they cannot be unregistered).

Security: no network access, no remote code, no eval/innerHTML, no web-accessible resources. The add-on root is mapped to a resource:// URL without content access only while the Experiment loads its three scripts (loadSubScript requires a trusted scheme), then the mapping is removed. Schema-validated API parameters; options are sanitised; text from messages is quoted before it becomes part of a search expression.

Permissions: storage (settings), menus + messagesRead (message list context menu: search by sender/subject/…), accountsRead (choose the folder for saved searches in the options).

How to test: open a folder, show the quick filter bar (Ctrl+Shift+K), type "f:<some sender>" or "s:(word1 or word2) -is:read" into the Expression Search box; Ctrl+right-click a sender in the message list; press "?" for the help page. Automated tests: npm test; npm run test:integration (headless Thunderbird via Marionette).

Validator: "Invalid permissions messagesRead / accountsRead" are Thunderbird permissions that the Firefox-based linter does not know; both are used (see Permissions). strict_max_version is intentional: the Experiment depends on Thunderbird internals, and every new release is tested in CI before the maximum is raised.

The name: this is an open-source continuation (GPL v3) of Expression Search / GMailUI by Opera Wang and Expression Search NG 2.4 by Klaus Buecher, credited in the description, help page and README; it has its own add-on id.
```
