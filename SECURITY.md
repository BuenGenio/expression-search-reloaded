# Security policy

## Reporting a vulnerability

Please report security problems **privately** via
[GitHub's private vulnerability reporting](https://github.com/BuenGenio/expression-search-reloaded/security/advisories/new),
not in public issues. You should receive a response within a week. Fixes are released as soon as possible and
credited unless you prefer otherwise.

Supported: the latest release.

## Security model

* The add-on makes **no network connections** and collects no data. Settings are stored in Thunderbird's local
  extension storage; with the opt-in verbose mode, search expressions are written to the local Error Console.
* The privileged part (the Experiment in `src/api/ExpressionSearch/`) is kept minimal:
  * its API parameters are validated by `schema.json`;
  * options are sanitised to known keys, types and ranges before use;
  * text taken from messages is quoted before it becomes part of a search expression.
* No web-accessible resources. The add-on root is mapped to a `resource://` URL only while the Experiment loads its
  scripts, without content access.
* Extension pages use the Manifest V3 default Content Security Policy: no inline scripts, no remote code.
* Searches are bounded: message size limits for body and attachment searches, expression nesting and
  complexity limits. Regular expressions are user-supplied and run by Thunderbird's JavaScript engine;
  a pathological pattern on a large folder can still make Thunderbird slow.

These rules are enforced by `tests/unit/static.test.mjs` where possible.
