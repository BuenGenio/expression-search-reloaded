# Changelog

All notable changes are documented here. Versions follow [semantic versioning](https://semver.org/).

## 5.0.0 – 2026-10-03

First release of **Expression Search Reloaded**, a rewrite of Expression Search NG 2.4beta for current Thunderbird.
See [AUDIT.md](AUDIT.md) for the full audit of 2.4beta.

### Added
* Support for Thunderbird 153 ESR – 157 (Manifest V3; one small Experiment instead of the wrapped legacy add-on).
* Help popup under the search box. It shows operator help, the parsed terms, errors, how many messages could be
  body-searched, and a hint to use global search when nothing matches.
* *Expression Search* submenu in the message list context menu (search by sender, recipients, subject, tags, date).
* Click-to-search also works in cards view.
* Options page field for the extra headers that `headerre:` can search (`mailnews.customDBHeaders`).
* `is:flagged` as an alias of `is:starred`.
* Settings of Expression Search 2.x/NG are migrated on first install.
* Unit, static and end-to-end tests; CI against Thunderbird release, ESR and beta.

### Fixed (compared with 2.4beta)
* Ctrl+Enter (saved search) and Shift+Enter / `g:` (global search) failed with errors.
* Mixed `and`/`or` expressions could return wrong results (incomplete CNF conversion, wrong grouping). A saved search
  with one OR group is now stored exactly, and the user is warned when a saved search cannot represent the expression.
* Negations had no effect for `-filename:`, `-a:<name>`, `-date:`, `-fromre:` and `-tore:`.
* `-before:`/`-after:` were off by one day (Thunderbird compares dates by calendar day).
* `headerre:Header=regex` never matched; `older_than:2y` produced no result; `si:` meant `simple:` although
  documented as `size:`; `tag:` with an unknown name broke the search; calculator negation failed.
* Select-first-message on Enter and ↓ to the message list did nothing.
* Disabling the add-on left hooks, filters and listeners behind.

### Security
* The add-on root is no longer exposed to web content (`resource://` mapping with content access removed).
* The unrestricted privileged "open URL" API was removed; help and options are unprivileged extension pages.
* Values taken from messages for click-to-search are quoted and can no longer inject expression syntax.
* Size, nesting and complexity limits for searches; invalid regular expressions are reported.

### Removed
* Options for moving the box to other toolbars and for button/result label sizes (only applied to the old,
  pre-115 quick filter bar).
* Status-bar icon and menu, about dialog, Ctrl+B and Ctrl+Alt+← shortcuts, the folder-picker helpers in the
  saved-search properties dialog.
* The help/donation window that opened on every start, and the donation links.
