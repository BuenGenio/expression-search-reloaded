# Expression Search Reloaded

[![CI](https://github.com/BuenGenio/expression-search-reloaded/actions/workflows/ci.yml/badge.svg)](https://github.com/BuenGenio/expression-search-reloaded/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

Gmail-like search expressions for Thunderbird's quick filter bar. Type `from:fred to:tom a:yes` to see all
messages from Fred to Tom with an attachment. It also offers regular expressions, click-to-search, saved searches
and global search.

Expression Search Reloaded is an **open-source continuation** of
[Expression Search / GMailUI](https://github.com/wangvisual/expression-search) by Opera Wang and its Thunderbird 78
port *Expression Search NG* by Klaus Buecher (opto). The NG add-on is still published on addons.thunderbird.net,
but its source is only available inside the packaged add-on. This project is developed in the open, with tests,
for current Thunderbird releases.

* **Thunderbird:** 153 ESR – 157 (tested on 153.3.1esr, 156.0.1 and 157.0)
* **User guide:** [src/help/help.html](src/help/help.html), also opened by the **?** button next to the search box
* **Why this fork, and what was fixed:** [AUDIT.md](AUDIT.md), a security/privacy/compatibility audit of the 2.4beta code
* **Changes:** [CHANGELOG.md](CHANGELOG.md)

## Features

* An expression search box in the quick filter bar. It combines with Thunderbird's Unread / Starred / Tags /
  Attachment buttons. Ctrl+Shift+K focuses it.
* Operators for addresses, subject, body, dates, age, size, status, tags and attachments, with regular-expression
  variants: `from:`, `to:`, `cc:`, `bcc:`, `only:`, `subject:`, `simple:`, `regex:`, `body:`, `bodyre:`,
  `headerre:`, `a:`, `filename:`, `is:`, `tag:`, `before:`, `after:`, `date:`, `older_than:`, `newer_than:`,
  `size:`, `smaller:` …
* `and`, `or`, `-` (not), parentheses and quotes. Any combination is evaluated correctly.
* **Enter** searches now, **Ctrl+Enter** creates a saved search over the whole account, **Shift+Enter** runs a
  global (gloda) search, and arithmetic like `3*(4+5)` is calculated.
* **Click to search:** Ctrl+right-click a subject, sender, recipient, tag or date in the message list, or use the
  *Expression Search* context submenu.
* Eleven extra search criteria for message filters, the Search Messages dialog and saved searches. They include
  Subject/From/Recipients/Body/Header RegEx, Bcc, attachment name or type, and time of day.
* No network access and no data collection. See [SECURITY.md](SECURITY.md).

## Installation

Download the `.xpi` from the [releases](https://github.com/BuenGenio/expression-search-reloaded/releases) page and
install it via *Add-ons and Themes › gear menu › Install Add-on From File* (Thunderbird does not require add-ons to
be signed). Installs from GitHub do **not** update automatically, so watch the releases. The add-on declares the
Thunderbird versions it was tested with and is disabled on newer ones until an update is installed. For a quick
try without installing, use *Debug Add-ons › Load Temporary Add-on* with `src/manifest.json`.

Do not install it alongside *Expression Search NG*. Both add the same search criteria. On first install, settings
of Expression Search 2.x/NG (`extensions.expressionsearch.*` preferences) are taken over.

## Development

Requires Node.js 22 or newer; there are no npm dependencies.

```sh
npm test                    # parser, locale and static security checks
npm run build               # -> dist/expression-search-reloaded-<version>.xpi
npm run test:integration    # end-to-end in a headless Thunderbird (default /snap/bin/thunderbird)
node tests/integration/run.mjs /path/to/thunderbird
ES_ADDON=dist/expression-search-reloaded-5.0.0.xpi npm run test:integration
```

The integration tests start a **separate** headless Thunderbird with `-no-remote` and a throw-away profile under
`tests/.profiles/` (or `$ES_PROFILE_ROOT`), driven via Marionette. They never touch your profile or a running
Thunderbird. CI runs them against the current release, the current ESR and the beta.

```
src/                         the add-on (no build step besides zipping)
  manifest.json              Manifest V3
  background.js              settings, context menu, help page (event page)
  shared/parser.js           expression language: tokenizer, parser, CNF, value normalisation (pure JS)
  shared/defaults.js         option defaults and validation
  api/ExpressionSearch/      Experiment: quick filter bar UI, custom search terms, saved/global search
  options/  help/  _locales/ icons/
tests/unit/                  node --test
tests/integration/           Marionette harness, run.mjs (main suite), options.mjs (options page)
scripts/build.mjs            XPI packager
legacy/                      the original 2.4beta package and its extracted sources (reference only)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to work on it, and how to update for a new Thunderbird version.

## License and credits

GNU GPL v3 (see [LICENSE](LICENSE)). Based on GMailUI by Ken Mixter, Expression Search / GMailUI by Opera Wang and
Expression Search NG 2.4beta by Klaus Buecher (opto). Maintained by Yevgen Trotsan.
