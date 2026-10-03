/* Expression Search Reloaded - option defaults and validation.
 *
 * Shared by the background page, the options page, the experiment (loaded
 * with loadSubScript) and the unit tests (require()).
 */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module == "object" && module.exports) {
    module.exports = api;
  } else {
    root.ExpressionSearchDefaults = api;
  }
})(this || globalThis, function () {
  /**
   * name -> [default, type, min, max]
   * Options of 2.x that no longer apply to the Thunderbird 115+ quick filter
   * bar (move2bar, showbuttonlabel, results_label_size) were dropped.
   */
  const SCHEMA = {
    // Search box
    hideNormalFilter: [true, "boolean"],
    actAsNormalFilter: [true, "boolean"],
    searchTimeout: [1000, "integer", 0, 60000],
    selectFirstOnEnter: [false, "boolean"],
    showHelp: [true, "boolean"],
    helpShowSeconds: [10, "integer", 0, 3600],
    helpHideSeconds: [2, "integer", 0, 3600],
    // Saved search (Ctrl+Enter)
    virtualFolderParent: ["", "string"],
    reuseExistingFolder: [false, "boolean"],
    virtualFolderInNewTab: [false, "boolean"],
    // Click to search
    c2sEnableCtrl: [true, "boolean"],
    c2sEnableShift: [false, "boolean"],
    c2sCtrlReplace: [true, "boolean"],
    c2sShiftReplace: [false, "boolean"],
    c2sRegexpMatch: ["", "string"],
    c2sRegexpReplace: ["", "string"],
    c2sRemoveDomain: [true, "boolean"],
    // Diagnostics
    verbose: [false, "boolean"],
  };

  const MAX_STRING_LENGTH = 1024;

  const DEFAULT_OPTIONS = Object.freeze(
    Object.fromEntries(Object.entries(SCHEMA).map(([k, [v]]) => [k, v]))
  );

  /**
   * Return a complete, type-correct options object. Unknown keys are
   * dropped, invalid values replaced by their defaults.
   */
  function sanitizeOptions(raw) {
    const input = raw && typeof raw == "object" ? raw : {};
    const result = {};
    for (const [key, [def, type, min, max]] of Object.entries(SCHEMA)) {
      let value = input[key];
      switch (type) {
        case "boolean":
          value = typeof value == "boolean" ? value : def;
          break;
        case "integer":
          value = Number.isFinite(value) ? Math.round(value) : def;
          value = Math.min(max, Math.max(min, value));
          break;
        case "string":
          value = typeof value == "string" ? value.substring(0, MAX_STRING_LENGTH) : def;
          break;
      }
      result[key] = value;
    }
    return result;
  }

  return { DEFAULT_OPTIONS, SCHEMA, sanitizeOptions };
});
