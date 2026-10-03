# Contributing

Bug reports, feature requests and pull requests are welcome. Please open an issue first for larger changes.

## Set-up

* Node.js 22+ (no npm dependencies) and a Thunderbird in the supported range (`strict_min_version` …
  `strict_max_version` in `src/manifest.json`).
* `npm test` runs the unit and static checks. Run it before every commit.
* `npm run test:integration` runs the end-to-end suites in a headless Thunderbird. Pass the binary with
  `node tests/integration/run.mjs /path/to/thunderbird` or set `THUNDERBIRD_BIN`. Snap installs can only use
  profile directories inside your home directory; other builds can use any `ES_PROFILE_ROOT`.
* To try changes interactively: *Add-ons Manager › gear › Debug Add-ons › Load Temporary Add-on* → `src/manifest.json`.

## Architecture rules

* **Use WebExtension APIs whenever possible.** The Experiment (`src/api/ExpressionSearch/`) only does what has no
  WebExtension API: the search box in the quick filter bar, custom search terms, saved-search creation and global
  search. Settings, menus, pages and anything else belong in the WebExtension part.
* The Experiment runs with full privileges. Keep it small, validate every parameter in `schema.json`, and never
  pass message content (subjects, addresses, bodies) into an expression without `ExpressionSearchParser.quote()`.
* The parser (`src/shared/parser.js`) is pure JavaScript and has no platform access. Language changes go there,
  together with unit tests in `tests/unit/parser.test.mjs`.
* Pages: no inline scripts or event handlers, no remote resources, no `innerHTML`. `tests/unit/static.test.mjs`
  enforces this, along with "no network APIs".
* Every user-visible string goes into `src/_locales/en/messages.json`. Other locales may contain a subset of its
  keys.
* Clean up completely on shutdown: the add-on must be disable/enable-able without a restart (covered by the
  integration tests).

## Updating for a new Thunderbird version

CI runs weekly against the current release, the newest ESR and the beta. The beta job ignores
`strict_max_version` and is allowed to fail, so it serves as an early warning.

1. Run `node tests/integration/run.mjs <new thunderbird>` and `tests/integration/options.mjs`.
2. If something fails, check the Thunderbird internals the Experiment relies on (search for them in
   [searchfox](https://searchfox.org/comm-central/)):
   * `QuickFilterManager` (`defineFilter`, `killFilter`, `filterDefsByName`, `textBoxDomId`), `MessageTextFilter`
   * In `about:3pane`:
     * `quickFilterBar` (`filterer`, `_filterer`, `_showFilterBar`, `updateSearch`, `reflectFiltererState`)
     * `QuickFilterState`, `gViewWrapper.search._session`, `gDBView`, `gFolder`
     * `threadTree` (`getRowAtIndex`, `table.body`, `selectedIndex`), `displayFolder`, `hasDOMContentLoaded`
   * Markup:
     * `#quickFilterBarContainer`, `#qfb-qs-textbox` (`<search-bar>`), `#quick-filter-bar-filter-text-bar`
     * thread rows `tr[is^="thread-"]` with `td.<column>col-column`
     * card rows with `.subject` / `.sender` / `.date` / `thread-card-tags`
   * Modules: `VirtualFolderWrapper`, `GlodaMsgSearcher` / `GlodaIndexer`, `ExtensionAccounts.getFolder`, `mimeParser`
   * XPCOM: `nsIMsgSearchCustomTerm`, `nsIMsgFolder.getMsgInputStream`
3. Raise `strict_max_version` only after both suites pass, then release.

## Releasing

1. Update `version` in `src/manifest.json` and `package.json`, and add a section to `CHANGELOG.md`.
2. Commit, then tag `vX.Y.Z` and push the tag. The release workflow runs the tests, checks that the tag matches the
   manifest version, builds the XPI and attaches it to a GitHub release.
3. For addons.thunderbird.net: upload the same XPI (Developer Hub › your add-on › *Upload New Version*) and paste the
   release notes. Add-ons with Experiments are reviewed manually; the source in the package is the readable source,
   so no extra source upload is needed. Listing texts, reviewer notes and screenshot captions are in
   [docs/atn-listing.md](docs/atn-listing.md); refresh the screenshots with `node scripts/screenshots.mjs` when the
   UI changes.

## Commit and PR conventions

* One logical change per commit, with an imperative subject line ("Add acc: operator").
* PRs need green CI. Behaviour changes need tests: a unit test for parser changes, an integration test for UI and
  search behaviour.
