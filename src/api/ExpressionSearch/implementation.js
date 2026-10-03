/* Expression Search Reloaded - experiment API implementation (parent process).
 *
 * Based on Expression Search / GMailUI by Ken Mixter and Opera Wang
 * (GPL v3 / MPL) and the Thunderbird 78 port by Klaus Buecher/opto.
 * Rewritten for Thunderbird 153+ (about:3pane, ES modules, MV3).
 *
 * Responsibilities (everything else lives in WebExtension code):
 *  - add the expression search box to the quick filter bar of every
 *    about:3pane (mail tab), and remove it again on shutdown;
 *  - contribute the search terms through QuickFilterManager.defineFilter(),
 *    so they combine with the other quick filter buttons;
 *  - register the custom search terms (also usable in message filters,
 *    the search dialog and saved searches);
 *  - click-to-search, saved search (virtual folder) creation and global
 *    (gloda) search.
 *
 * No network access, no data leaves the profile.
 */

"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var { ExtensionError } = ExtensionUtils;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  QuickFilterManager: "resource:///modules/QuickFilterManager.sys.mjs",
  MessageTextFilter: "resource:///modules/QuickFilterManager.sys.mjs",
  VirtualFolderHelper: "resource:///modules/VirtualFolderWrapper.sys.mjs",
  GlodaMsgSearcher: "resource:///modules/gloda/GlodaMsgSearcher.sys.mjs",
  GlodaIndexer: "resource:///modules/gloda/GlodaIndexer.sys.mjs",
  getFolder: "resource:///modules/ExtensionAccounts.sys.mjs",
});

const FILTER_NAME = "expressionSearchReloaded";
const CONTAINER_ID = "esr-search-container";
const INPUT_ID = "esr-search-textbox";
const HELP_ID = "esr-search-help";
const HELP_BUTTON_ID = "esr-search-help-button";
const NORMAL_TEXTBOX_ID = "qfb-qs-textbox";
const TEXT_FILTER_BAR_ID = "quick-filter-bar-filter-text-bar";
const MESSENGER_URL = "chrome://messenger/content/messenger.xhtml";
const VIRTUAL_FOLDER_NAME = "ExpressionSearch";
const MSG_VIEW_FLAG_DUMMY = 0x20000000;

/**
 * Load our plain scripts (parser, defaults, terms) into one scope object.
 *
 * The subscript loader only accepts trusted schemes, so the add-on root is
 * mapped to a private resource:// host for the duration of the load. The
 * mapping is created without ALLOW_CONTENT_ACCESS (web content and messages
 * can never load it) and removed again right away.
 */
function loadScripts(extension) {
  const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(
    Ci.nsISubstitutingProtocolHandler
  );
  const host = `expressionsearchreloaded-${extension.uuid}`;
  const scope = {};
  resProto.setSubstitution(host, extension.rootURI);
  try {
    for (const path of [
      "shared/defaults.js",
      "shared/parser.js",
      "api/ExpressionSearch/terms.js",
    ]) {
      Services.scriptloader.loadSubScriptWithOptions(`resource://${host}/${path}`, {
        target: scope,
        ignoreCache: true,
      });
    }
  } finally {
    resProto.setSubstitution(host, null);
  }
  return scope;
}

/**
 * One instance per about:3pane document (i.e. per mail tab).
 */
class Pane {
  /**
   * @param {Controller} controller
   * @param {Window} win - The about:3pane window.
   */
  constructor(controller, win) {
    this.controller = controller;
    this.win = win;
    this.doc = win.document;
    this.listeners = [];
    this.searchTimer = 0;
    this.helpTimer = 0;
    this.pendingSelectFirst = false;
    this.normalFilterMode = false;
    this.statusText = "";
  }

  get qfb() {
    return this.win.quickFilterBar;
  }

  get options() {
    return this.controller.options;
  }

  listen(target, type, handler, options = false) {
    target.addEventListener(type, handler, options);
    this.listeners.push([target, type, handler, options]);
  }

  attach() {
    const doc = this.doc;
    const container = doc.getElementById("quickFilterBarContainer");
    const normal = doc.getElementById(NORMAL_TEXTBOX_ID);
    if (!container || !normal) {
      throw new Error("Quick filter bar not found in about:3pane");
    }
    const C = this.controller;

    this.win.windowUtils.loadSheetUsingURIString(
      C.cssURL,
      this.win.windowUtils.AUTHOR_SHEET
    );

    const box = doc.createElement("div");
    box.id = CONTAINER_ID;

    const input = doc.createElement("input");
    input.id = INPUT_ID;
    input.type = "search";
    input.maxLength = 2048;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", C.localize("searchBoxLabel"));
    input.setAttribute("aria-describedby", HELP_ID);

    const helpButton = doc.createElement("button");
    helpButton.id = HELP_BUTTON_ID;
    helpButton.type = "button";
    helpButton.textContent = "?";
    helpButton.title = C.localize("helpButtonTooltip");
    helpButton.setAttribute("aria-label", C.localize("helpButtonTooltip"));

    const help = doc.createElement("div");
    help.id = HELP_ID;
    help.setAttribute("role", "status");
    help.hidden = true;
    this.helpLines = {};
    for (const name of ["token", "info", "matches", "terms", "error", "stats"]) {
      const line = doc.createElement("div");
      line.className = `es-help-${name}`;
      help.append(line);
      this.helpLines[name] = line;
    }

    box.append(input, helpButton, help);
    normal.after(box);
    this.box = box;
    this.input = input;
    this.help = help;
    this.normal = normal;

    this.listen(input, "input", () => this.onInput());
    this.listen(input, "keydown", event => this.onKeyDown(event));
    this.listen(input, "focus", () => this.updateHelp());
    this.listen(input, "blur", () => this.scheduleHideHelp(this.options.helpHideSeconds));
    this.listen(input, "click", () => this.updateHelp());
    this.listen(input, "keyup", event => {
      if (event.key.startsWith("Arrow") || event.key == "Home" || event.key == "End") {
        this.updateHelp();
      }
    });
    this.listen(helpButton, "click", () => C.emitCommand("openHelp"));

    const threadTree = doc.getElementById("threadTree");
    if (threadTree) {
      this.listen(threadTree, "contextmenu", event => this.onThreadContextMenu(event), true);
    }
    this.listen(this.win, "unload", () => C.detachPane(this.win, false), { once: true });

    this.applyOptions();
    const value = this.qfb?._filterer?.filterValues?.[FILTER_NAME];
    input.value = value?.text ?? "";
  }

  detach(removeDom) {
    this.win.clearTimeout(this.searchTimer);
    this.win.clearTimeout(this.helpTimer);
    for (const [target, type, handler, options] of this.listeners) {
      try {
        target.removeEventListener(type, handler, options);
      } catch (e) {}
    }
    this.listeners = [];
    if (!removeDom) {
      return;
    }
    try {
      this.box?.remove();
      this.normal?.classList.remove("esr-normal-hidden");
      this.win.windowUtils.removeSheetUsingURIString(
        this.controller.cssURL,
        this.win.windowUtils.AUTHOR_SHEET
      );
    } catch (e) {
      console.error(e);
    }
    // Drop our state from the quick filter so that nothing refers to the
    // filter definition after it has been removed.
    const qfb = this.qfb;
    if (qfb?._filterer && FILTER_NAME in qfb._filterer.filterValues) {
      const values = { ...qfb._filterer.filterValues };
      delete values[FILTER_NAME];
      qfb._filterer = new this.win.QuickFilterState(null, {
        filterValues: values,
        visible: qfb._filterer.visible,
      });
      qfb.updateSearch();
      qfb.reflectFiltererState();
    }
  }

  applyOptions() {
    const o = this.options;
    const C = this.controller;
    const hide = o.hideNormalFilter;
    this.normal.classList.toggle("esr-normal-hidden", hide);
    if (hide && this.normal.value) {
      this.normal.reset?.();
    }
    const key = Services.appinfo.OS == "Darwin" ? "⇧⌘K" : "Ctrl+Shift+K";
    this.input.placeholder = hide
      ? C.localize("searchBoxPlaceholderWithKey", [key])
      : C.localize("searchBoxPlaceholder");
    if (!o.showHelp) {
      this.help.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Typing and keys

  onInput() {
    this.win.clearTimeout(this.searchTimer);
    const text = this.input.value;
    if (!text.trim()) {
      this.apply("");
    } else if (this.options.searchTimeout > 0) {
      this.searchTimer = this.win.setTimeout(() => this.apply(this.input.value), this.options.searchTimeout);
    }
    this.updateHelp();
  }

  onKeyDown(event) {
    const C = this.controller;
    switch (event.key) {
      case "Enter": {
        event.preventDefault();
        this.win.clearTimeout(this.searchTimer);
        const text = this.input.value;
        if (!text.trim()) {
          this.apply("");
          return;
        }
        const compiled = C.compile(text);
        if (event.ctrlKey || event.metaKey) {
          C.createSavedSearch(this, text);
        } else if (event.shiftKey || compiled.kind == "gloda") {
          C.openGlobalSearch(this, text);
        } else if (compiled.kind == "calc") {
          this.showCalculation(text);
        } else {
          this.pendingSelectFirst = this.options.selectFirstOnEnter;
          this.apply(text);
          this.input.select();
        }
        break;
      }
      case "ArrowDown": {
        if (event.altKey) {
          return;
        }
        const tree = this.win.threadTree;
        if (!tree) {
          return;
        }
        event.preventDefault();
        tree.table.body.focus();
        if (tree.selectedIndex == -1 && this.win.gDBView?.rowCount) {
          tree.selectedIndex = 0;
        }
        break;
      }
      case "Escape":
        if (this.input.value) {
          // Like Thunderbird's own search bar: the first Escape clears the
          // box, the next ones are handled by the quick filter bar.
          event.preventDefault();
          event.stopPropagation();
          this.input.value = "";
          this.apply("");
          this.updateHelp();
        }
        break;
    }
  }

  /** Apply the expression to the current view. */
  apply(text) {
    this.win.clearTimeout(this.searchTimer);
    const qfb = this.qfb;
    if (!qfb || !this.win.gViewWrapper) {
      return;
    }
    const value = text.trim() ? { text } : null;
    const current = qfb.filterer.filterValues[FILTER_NAME];
    if ((current?.text ?? null) === (value?.text ?? null) && !this.pendingSelectFirst) {
      return;
    }
    if (value && !qfb.filterer.visible) {
      qfb._showFilterBar(true);
    }
    this.controller.Terms.resetBodyStats();
    this.statusText = "";
    qfb.filterer.setFilterValue(FILTER_NAME, value);
    qfb.updateSearch();
    this.controller.log("search", text);
  }

  /** Put an expression into the box and run it (click-to-search, menus). */
  setExpression(text) {
    const qfb = this.qfb;
    if (qfb && !qfb.filterer.visible) {
      qfb._showFilterBar(true);
    }
    this.input.value = text;
    this.pendingSelectFirst = this.options.selectFirstOnEnter;
    this.apply(text);
    this.input.focus();
    this.input.setSelectionRange(text.length, text.length);
    this.updateHelp();
  }

  showCalculation(text) {
    try {
      const { text: result } = this.controller.Parser.calculate(text);
      const lhs = result.split(" = ")[0];
      this.input.value = result;
      this.input.setSelectionRange(lhs.length + 3, result.length);
      this.setError("");
    } catch (e) {
      this.setError(this.controller.errorMessage({ code: e.message, detail: e.detail }));
    }
  }

  // ---------------------------------------------------------------------------
  // Help popup

  updateHelp() {
    const C = this.controller;
    const P = C.Parser;
    const text = this.input.value;
    const compiled = C.compile(text);

    const caret = this.input.selectionEnd ?? text.length;
    const word = P.wordAt(text, caret);
    const { best, matches } = P.matchOperator(word);
    const L = this.helpLines;
    if (best) {
      L.token.textContent = `${best} (${P.TOKENS[best].join(", ")})`;
      L.info.textContent = C.localize(`info_${best}`);
      L.matches.textContent = matches.length > 1 ? matches.join(", ") : "";
    } else {
      L.token.textContent = "";
      L.info.textContent = text.trim() ? "" : C.localize("helpBlank");
      L.matches.textContent = text.trim() ? "" : P.matchOperator("").matches.join(", ");
    }

    let terms = "";
    switch (compiled.kind) {
      case "search":
        terms =
          this.options.actAsNormalFilter && !compiled.hasOperators
            ? C.localize("helpNormalFilter")
            : P.describeClauses(compiled.clauses);
        break;
      case "calc":
        terms = C.localize("helpCalc");
        break;
      case "gloda":
        terms = C.localize("helpGloda", [compiled.glodaQuery]);
        break;
    }
    L.terms.textContent = terms;
    this.setError(compiled.errors.map(e => C.errorMessage(e)).join("\n"));
    L.stats.textContent = this.statusText;
    this.showHelp();
  }

  setError(message) {
    this.helpLines.error.textContent = message;
    this.box.classList.toggle("esr-error", !!message);
  }

  setStatus(text) {
    this.statusText = text;
    this.helpLines.stats.textContent = text;
    if (text && this.doc.activeElement == this.input) {
      this.showHelp();
    }
  }

  showHelp() {
    if (!this.options.showHelp) {
      this.help.hidden = true;
      return;
    }
    this.help.hidden = false;
    this.scheduleHideHelp(this.options.helpShowSeconds);
  }

  scheduleHideHelp(seconds) {
    this.win.clearTimeout(this.helpTimer);
    this.helpTimer = this.win.setTimeout(() => {
      this.help.hidden = true;
    }, Math.max(0, seconds) * 1000);
  }

  // ---------------------------------------------------------------------------
  // Click-to-search (Ctrl/Shift + right click in the message list)

  onThreadContextMenu(event) {
    const o = this.options;
    if (event.button != 2) {
      return;
    }
    const viaCtrl = o.c2sEnableCtrl && event.ctrlKey;
    const viaShift = o.c2sEnableShift && event.shiftKey;
    if (!viaCtrl && !viaShift) {
      return;
    }
    const row = event.target.closest?.('tr[is^="thread-"]');
    const field = row && this.controller.fieldFromTarget(event.target);
    if (!field) {
      return;
    }
    let hdr = null;
    try {
      if (!(this.win.gDBView.getFlagsAt(row.index) & MSG_VIEW_FLAG_DUMMY)) {
        hdr = this.win.gDBView.getMsgHdrAt(row.index);
      }
    } catch (e) {}
    if (!hdr) {
      return;
    }
    const replace = (viaCtrl && o.c2sCtrlReplace) || (viaShift && o.c2sShiftReplace);
    const text = this.controller.expressionForMessage(hdr, field, { replace });
    if (!text) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.setExpression(text);
  }

  // ---------------------------------------------------------------------------
  // Quick filter callbacks

  reflectState(value) {
    const text = value?.text ?? "";
    const typing = this.doc.activeElement == this.input && value;
    if (this.input.value != text && !typing) {
      this.input.value = text;
    }
    if (!value) {
      this.pendingSelectFirst = false;
      this.setError("");
    }
    this.updateNormalFilterBar(value);
  }

  /** Show the sender/recipient/subject/body toggles in "normal filter" mode. */
  updateNormalFilterBar(value) {
    const compiled = value ? this.controller.compile(value.text) : null;
    this.normalFilterMode =
      !!compiled &&
      compiled.kind == "search" &&
      !compiled.hasOperators &&
      this.options.actAsNormalFilter;
    const bar = this.doc.getElementById(TEXT_FILTER_BAR_ID);
    if (bar) {
      const textFilterActive = !!this.qfb?._filterer?.filterValues?.text?.text;
      bar.hidden = !(textFilterActive || this.normalFilterMode);
    }
  }

  afterFilter(filtering) {
    const C = this.controller;
    const active = !!this.qfb?._filterer?.filterValues?.[FILTER_NAME];
    if (!filtering || !active) {
      this.pendingSelectFirst = false;
      return;
    }
    const view = this.win.gDBView;
    const count = view?.numMsgsInView ?? 0;
    const lines = [];
    const stats = C.Terms.bodyStats;
    if (stats.checked > 0 && stats.available < stats.checked) {
      lines.push(C.localize("helpBodyStats", [stats.available, stats.checked]));
    }
    if (count == 0 && C.glodaEnabled) {
      lines.push(C.localize("helpNoResultsGloda"));
    }
    this.setStatus(lines.join("\n"));

    if (this.pendingSelectFirst) {
      this.pendingSelectFirst = false;
      this.win.setTimeout(() => this.selectFirstMessage(), 0);
    }
  }

  selectFirstMessage() {
    const view = this.win.gDBView;
    const tree = this.win.threadTree;
    if (!view || !tree || !view.rowCount) {
      return;
    }
    let index = 0;
    while (index < view.rowCount && view.getFlagsAt(index) & MSG_VIEW_FLAG_DUMMY) {
      index++;
    }
    if (index >= view.rowCount) {
      return;
    }
    tree.table.body.focus();
    tree.selectedIndex = index;
    tree.scrollToIndex?.(index, true);
  }
}

class Controller {
  constructor(extension, emitCommand) {
    this.extension = extension;
    this.emitCommand = emitCommand;
    const scope = loadScripts(extension);
    this.Parser = scope.ExpressionSearchParser;
    this.Terms = scope.ExpressionSearchTerms;
    this.Defaults = scope.ExpressionSearchDefaults;
    this.options = this.Defaults.sanitizeOptions({});
    this.cssURL = extension.rootURI.resolve("api/ExpressionSearch/expression-search.css");
    this.panes = new Map();
    this.compileCache = new Map();
    this.started = false;
    this.windowListenerId = `expression-search-reloaded-${extension.uuid}`;
    this.onDocumentLoaded = this.onDocumentLoaded.bind(this);
  }

  localize(name, substitutions) {
    const message = this.extension.localizeMessage(name, substitutions);
    return message || name;
  }

  log(...args) {
    if (this.options.verbose) {
      console.log("Expression Search:", ...args);
    }
  }

  errorMessage({ code, detail }) {
    const message = this.extension.localizeMessage(`error_${code}`, [detail ?? ""]);
    return message || `${code}${detail ? `: ${detail}` : ""}`;
  }

  get glodaEnabled() {
    try {
      return lazy.GlodaIndexer.enabled;
    } catch (e) {
      return false;
    }
  }

  compile(text) {
    let compiled = this.compileCache.get(text);
    if (!compiled) {
      compiled = this.Parser.compile(text);
      if (this.compileCache.size > 64) {
        this.compileCache.clear();
      }
      this.compileCache.set(text, compiled);
    }
    return compiled;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  setOptions(raw) {
    this.options = this.Defaults.sanitizeOptions(raw);
    if (!this.started) {
      this.start();
    }
    lazy.QuickFilterManager.textBoxDomId = this.options.hideNormalFilter
      ? INPUT_ID
      : NORMAL_TEXTBOX_ID;
    for (const pane of this.panes.values()) {
      if (!pane.input) {
        continue; // still attaching; picks up the options in attach()
      }
      try {
        pane.applyOptions();
      } catch (e) {
        console.error(e);
      }
    }
  }

  start() {
    this.started = true;
    const conflicts = this.Terms.register(name => this.localize(name));
    if (conflicts.length) {
      console.warn(
        "Expression Search: these custom search terms are registered by another add-on " +
          "and will be used until Thunderbird is restarted:",
        conflicts
      );
    }

    const QFM = lazy.QuickFilterManager;
    if (QFM.filterDefsByName[FILTER_NAME]) {
      QFM.killFilter(FILTER_NAME);
    }
    QFM.defineFilter(this.createFilterDefinition());

    ExtensionSupport.registerWindowListener(this.windowListenerId, {
      chromeURLs: [MESSENGER_URL],
      onLoadWindow: win => this.attachWindow(win),
      onUnloadWindow: win => this.detachWindow(win),
    });
  }

  shutdown() {
    if (!this.started) {
      return;
    }
    this.started = false;
    try {
      ExtensionSupport.unregisterWindowListener(this.windowListenerId);
    } catch (e) {
      console.error(e);
    }
    for (const win of ExtensionSupport.openWindows) {
      if (win.location?.href == MESSENGER_URL) {
        win.removeEventListener("DOMContentLoaded", this.onDocumentLoaded, true);
      }
    }
    for (const win of [...this.panes.keys()]) {
      this.detachPane(win, true);
    }
    const QFM = lazy.QuickFilterManager;
    if (QFM.filterDefsByName[FILTER_NAME]) {
      QFM.killFilter(FILTER_NAME);
    }
    if (QFM.textBoxDomId == INPUT_ID) {
      QFM.textBoxDomId = NORMAL_TEXTBOX_ID;
    }
    this.Terms.unregister();
    this.compileCache.clear();
  }

  attachWindow(win) {
    // DOMContentLoaded of the about:3pane in a mail tab propagates to the
    // messenger window ("load" stops at the <browser>).
    win.addEventListener("DOMContentLoaded", this.onDocumentLoaded, true);
    for (const tab of win.gTabmail?.tabInfo ?? []) {
      if (tab.mode?.name != "mail3PaneTab") {
        continue;
      }
      const cw = tab.chromeBrowser?.contentWindow;
      // Once past "loading", DOMContentLoaded has fired and we would miss it.
      if (cw?.location.href == "about:3pane" && cw.document.readyState != "loading") {
        this.attachPane(cw);
      }
    }
  }

  detachWindow(win) {
    win.removeEventListener("DOMContentLoaded", this.onDocumentLoaded, true);
    for (const paneWin of [...this.panes.keys()]) {
      let gone = true;
      try {
        gone = paneWin.closed || paneWin.top == win;
      } catch (e) {
        // dead object
      }
      if (gone) {
        this.detachPane(paneWin, false);
      }
    }
  }

  /** Capturing listener on messenger windows: new about:3pane tabs. */
  onDocumentLoaded(event) {
    const doc = event.target;
    if (doc?.location?.href == "about:3pane" && doc.defaultView) {
      this.attachPane(doc.defaultView);
    }
  }

  async attachPane(win) {
    if (this.panes.has(win)) {
      return;
    }
    const pane = new Pane(this, win);
    this.panes.set(win, pane);
    try {
      // Wait for about:3pane's own (asynchronous) initialisation.
      await win.hasDOMContentLoaded?.promise;
      if (this.panes.get(win) != pane) {
        return;
      }
      if (!this.started || win.closed) {
        this.panes.delete(win);
        return;
      }
      pane.attach();
      this.log("attached to", win.tabOrWindow?.title ?? "about:3pane");
    } catch (e) {
      console.error("Expression Search: could not attach to mail tab", e);
      this.panes.delete(win);
      pane.detach(true);
    }
  }

  detachPane(win, removeDom) {
    const pane = this.panes.get(win);
    if (!pane) {
      return;
    }
    this.panes.delete(win);
    try {
      pane.detach(removeDom && !win.closed);
    } catch (e) {
      console.error(e);
    }
  }

  /** First fully attached pane whose window matches. */
  paneFor(predicate) {
    for (const pane of this.panes.values()) {
      if (!pane.input) {
        continue;
      }
      try {
        if (predicate(pane.win)) {
          return pane;
        }
      } catch (e) {}
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Quick filter integration

  createFilterDefinition() {
    return {
      name: FILTER_NAME,
      domId: CONTAINER_ID,
      appendTerms: (termCreator, terms, state) => this.appendTerms(termCreator, terms, state),
      getDefaults: () => null,
      // Keep the expression on folder change only if "sticky" is active.
      propagateState: (old, sticky) => (sticky && old?.text ? { text: old.text } : null),
      clearState: state => [null, !!state?.text],
      // quickFilterBar._bindUI() adds a click handler on our container in
      // newly opened tabs; the input handles everything itself.
      onCommand: state => [state, false],
      reflectInDOM: (node, value, doc) => {
        this.paneFor(w => w.document == doc)?.reflectState(value);
      },
      postFilterProcess: (state, viewWrapper, filtering) => {
        this.paneFor(w => w.gViewWrapper == viewWrapper)?.afterFilter(filtering);
        return [state, false, false];
      },
    };
  }

  appendTerms(termCreator, terms, state) {
    const text = state?.text;
    if (!text) {
      return;
    }
    const compiled = this.compile(text);
    if (compiled.kind != "search") {
      return;
    }
    if (this.options.actAsNormalFilter && !compiled.hasOperators) {
      // Behave like Thunderbird's own text filter, honouring its
      // sender/recipients/subject/body toggles of the tab that searches.
      const pane = this.paneFor(w => w.gViewWrapper?.search?._session == termCreator);
      const states =
        pane?.qfb?._filterer?.filterValues?.text?.states ??
        lazy.MessageTextFilter.getDefaults().states;
      lazy.MessageTextFilter.appendTerms(termCreator, terms, { text, states });
      return;
    }
    this.buildTerms(termCreator, compiled.clauses, terms);
    this.log("terms", this.Parser.describeClauses(compiled.clauses));
  }

  /**
   * Turn CNF clauses into nsIMsgSearchTerms: every clause becomes one group
   * of OR'ed terms; groups are AND'ed. This is the only grouping the search
   * code supports (one level; the first term of each group has booleanAnd),
   * see SearchSpec._groupifyTerms().
   */
  buildTerms(termCreator, clauses, terms) {
    for (const clause of clauses) {
      const group = [];
      for (const descriptor of clause) {
        const term = this.createTerm(termCreator, descriptor);
        if (term) {
          group.push(term);
        }
      }
      group.forEach((term, i) => {
        term.booleanAnd = i == 0;
        term.beginsGrouping = group.length > 1 && i == 0;
        term.endsGrouping = group.length > 1 && i == group.length - 1;
      });
      terms.push(...group);
    }
    return terms;
  }

  createTerm(termCreator, d) {
    const attrib =
      d.attrib == "Custom" ? Ci.nsMsgSearchAttrib.Custom : Ci.nsMsgSearchAttrib[d.attrib];
    const op = Ci.nsMsgSearchOp[d.op];
    if (attrib === undefined || op === undefined) {
      console.error("Expression Search: unsupported term", d);
      return null;
    }
    const term = termCreator.createTerm();
    term.attrib = attrib;
    const value = term.value;
    // value.attrib must be set before the actual value.
    value.attrib = attrib;
    switch (d.valueType) {
      case "str":
        value.str = d.tag !== undefined ? this.resolveTagKey(d.tag) : d.value;
        break;
      case "status":
        value.status = Ci.nsMsgMessageFlags[d.value];
        break;
      case "size":
        value.size = d.value;
        break;
      case "age":
        value.age = Math.round(d.value);
        break;
      case "date":
        value.date = d.value;
        break;
    }
    term.value = value;
    term.op = op;
    if (attrib == Ci.nsMsgSearchAttrib.Custom) {
      term.customId = d.customId;
    }
    return term;
  }

  /** Tag name (substring, best fit), "#3"/"3" (n-th tag) or key -> key. */
  resolveTagKey(name) {
    const wanted = name.toLowerCase();
    const tags = MailServices.tags.getAllTags();
    let best = null;
    let bestDiff = Infinity;
    for (const t of tags) {
      const tag = t.tag.toLowerCase();
      if (tag.includes(wanted) && tag.length - wanted.length < bestDiff) {
        best = t.key;
        bestDiff = tag.length - wanted.length;
        if (!bestDiff) {
          break;
        }
      }
    }
    if (best) {
      return best;
    }
    const m = /^#?(\d+)$/.exec(wanted);
    if (m && +m[1] >= 1 && +m[1] <= tags.length) {
      return tags[+m[1] - 1].key;
    }
    if (MailServices.tags.isValidKey(name)) {
      return name;
    }
    return "..unknown..";
  }

  // ---------------------------------------------------------------------------
  // Click-to-search

  fieldFromTarget(target) {
    if (target.closest('tr[is="thread-card"]')) {
      if (target.closest(".subject")) {
        return "subject";
      }
      if (target.closest(".sender")) {
        return "correspondent";
      }
      if (target.closest(".date")) {
        return "date";
      }
      if (target.closest("thread-card-tags")) {
        return "tags";
      }
      return null;
    }
    const cell = target.closest("td");
    if (!cell) {
      return null;
    }
    const columns = {
      "subjectcol-column": "subject",
      "sendercol-column": "from",
      "recipientcol-column": "recipients",
      "correspondentcol-column": "correspondent",
      "tagscol-column": "tags",
      "datecol-column": "date",
    };
    for (const cls of cell.classList) {
      if (cls in columns) {
        return columns[cls];
      }
    }
    return null;
  }

  isOutgoing(hdr) {
    const author = MailServices.headerParser.parseDecodedHeader(hdr.mime2DecodedAuthor || "")[0];
    if (!author?.email) {
      return false;
    }
    const email = author.email.toLowerCase();
    return MailServices.accounts.allIdentities.some(i => i.email?.toLowerCase() == email);
  }

  /** Expression that finds messages sharing `field` with `hdr`. */
  expressionForMessage(hdr, field, { replace = false } = {}) {
    const Q = this.Parser.quote;
    switch (field) {
      case "subject": {
        let subject = (hdr.mime2DecodedSubject || "").trim();
        if (replace) {
          const replaced = this.regexpReplace(subject);
          if (replaced != subject && replaced.startsWith("(")) {
            return `s:${replaced}`;
          }
          subject = replaced;
        }
        // Strip "Re:", "Fwd:", "AW:", "回复：" and "[list]" prefixes.
        for (;;) {
          const stripped = subject
            .replace(/^\s*\S{2,3}[:：]\s*/, "")
            .replace(/^\s*\[[^\]]+\]:*\s*/, "")
            .trim();
          if (!stripped || stripped == subject) {
            break;
          }
          subject = stripped;
        }
        return subject ? `simple:${subject.replace(/[\r\n]+/g, " ")}` : null;
      }
      case "from":
        return this.addressExpression("f", hdr.mime2DecodedAuthor);
      case "recipients":
        return this.addressExpression("t", hdr.mime2DecodedRecipients);
      case "correspondent":
        return this.isOutgoing(hdr)
          ? this.addressExpression("t", hdr.mime2DecodedRecipients)
          : this.addressExpression("f", hdr.mime2DecodedAuthor);
      case "tags": {
        const names = hdr
          .getStringProperty("keywords")
          .split(/\s+/)
          .filter(key => key && MailServices.tags.isValidKey(key))
          .map(key => MailServices.tags.getTagForKey(key));
        if (!names.length) {
          return null;
        }
        return names.length == 1
          ? `tag:${Q(names[0])}`
          : `tag:(${names.map(Q).join(" and ")})`;
      }
      case "date": {
        const d = new Date(hdr.date / 1000);
        const p = n => String(n).padStart(2, "0");
        return `date:${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
      }
    }
    return null;
  }

  addressExpression(op, header) {
    const values = MailServices.headerParser
      .parseDecodedHeader(header || "")
      .map(a => {
        const name = (a.name || "").trim();
        if (name) {
          return name;
        }
        const email = (a.email || "").trim();
        return this.options.c2sRemoveDomain ? email.replace(/@.*$/, "") : email;
      })
      .filter(Boolean);
    if (!values.length) {
      return null;
    }
    const Q = this.Parser.quote;
    return values.length == 1 ? `${op}:${Q(values[0])}` : `${op}:(${values.map(Q).join(" and ")})`;
  }

  /**
   * Apply the user's "subject replace" regex. Every match is replaced; more
   * than one match produces an OR group, e.g. "(Bug 1 or Bug 2)".
   */
  regexpReplace(subject) {
    const pattern = this.options.c2sRegexpMatch;
    if (!pattern) {
      return subject;
    }
    try {
      const re = new RegExp(pattern, "gi");
      const matches = subject.match(re);
      if (!matches) {
        return subject;
      }
      const replaced = matches.map(m => m.replace(new RegExp(pattern, "i"), this.options.c2sRegexpReplace));
      return replaced.length > 1 ? `(${replaced.join(" or ")})` : replaced[0];
    } catch (e) {
      console.warn("Expression Search: invalid subject replace regex", pattern, e);
      return subject;
    }
  }

  // ---------------------------------------------------------------------------
  // Saved search (Ctrl+Enter) and global search (Shift+Enter)

  /** Folder below which the saved search is created. */
  savedSearchParent(currentFolder) {
    const id = this.options.virtualFolderParent;
    if (!id) {
      return currentFolder.rootFolder;
    }
    try {
      return lazy.getFolder(id).folder;
    } catch (e) {
      return null;
    }
  }

  createSavedSearch(pane, text) {
    const compiled = this.compile(text);
    const currentFolder = pane.win.gFolder;
    if (compiled.kind != "search" || !currentFolder) {
      pane.setStatus(this.localize("savedSearchUnavailable"));
      return;
    }
    const parent = this.savedSearchParent(currentFolder);
    if (!parent) {
      pane.setStatus(this.localize("savedSearchBadParent"));
      return;
    }

    const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(
      Ci.nsIMsgSearchSession
    );
    const terms = [];
    let exact = true;
    if (this.options.actAsNormalFilter && !compiled.hasOperators) {
      lazy.MessageTextFilter.appendTerms(session, terms, {
        text,
        states:
          pane.qfb?._filterer?.filterValues?.text?.states ??
          lazy.MessageTextFilter.getDefaults().states,
      });
      exact = terms.filter(t => t.beginsGrouping).length <= 1;
    } else {
      // Saved searches are stored without grouping and evaluated strictly
      // left to right. One OR group is still exact if it comes first:
      // (a OR b) AND c AND d == ((a OR b) AND c) AND d. Two or more cannot
      // be expressed; the user is told so.
      const clauses = [...compiled.clauses].sort((a, b) => b.length - a.length);
      exact = clauses.filter(c => c.length > 1).length <= 1;
      this.buildTerms(session, clauses, terms);
    }

    // Search every real (non-virtual, non-news) folder of the account.
    const root = currentFolder.rootFolder;
    const folders = [root, ...root.descendants].filter(
      f =>
        !f.isServer &&
        !(f.flags & Ci.nsMsgFolderFlags.Virtual) &&
        !(f.flags & Ci.nsMsgFolderFlags.Newsgroup)
    );

    let folder;
    if (parent.containsChildNamed(VIRTUAL_FOLDER_NAME)) {
      folder = parent.getChildNamed(VIRTUAL_FOLDER_NAME);
      if (!(folder.flags & Ci.nsMsgFolderFlags.Virtual)) {
        pane.setStatus(this.localize("savedSearchNameTaken", [VIRTUAL_FOLDER_NAME]));
        return;
      }
      const wrapper = lazy.VirtualFolderHelper.wrapVirtualFolder(folder);
      wrapper.searchTerms = terms;
      if (!this.options.reuseExistingFolder) {
        wrapper.searchFolders = folders;
      }
      wrapper.onlineSearch = false;
      wrapper.cleanUpMessageDatabase();
      MailServices.accounts.saveVirtualFolders();
    } else {
      folder = lazy.VirtualFolderHelper.createNewVirtualFolder(
        VIRTUAL_FOLDER_NAME,
        parent,
        folders,
        terms,
        false
      ).virtualFolder;
    }

    pane.setStatus(exact ? "" : this.localize("savedSearchNotExact"));

    if (this.options.virtualFolderInNewTab) {
      pane.win.top.document.getElementById("tabmail")?.openTab("mail3PaneTab", {
        folderURI: folder.URI,
      });
      return;
    }
    if (pane.win.gFolder?.URI == folder.URI) {
      // Re-open the folder so that the changed search is applied.
      const inbox = root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox) || root;
      pane.win.displayFolder(inbox.URI);
    }
    pane.win.displayFolder(folder.URI);
  }

  openGlobalSearch(pane, text) {
    const compiled = this.compile(text);
    const query = compiled.kind == "gloda" ? compiled.glodaQuery : this.Parser.toGlodaQuery(text);
    if (!this.glodaEnabled) {
      pane.setStatus(this.localize("glodaDisabled"));
      return;
    }
    if (!query) {
      return;
    }
    const tabmail = pane.win.top.document.getElementById("tabmail");
    const mode =
      Services.prefs.getBoolPref("gloda.show_as_list_by_default", false) &&
      tabmail.tabModes.glodaTableList
        ? "glodaTableList"
        : "glodaFacet";
    tabmail.openTab(mode, { searcher: new lazy.GlodaMsgSearcher(null, query) });
  }

  async searchFromMessage(nativeTab, hdr, field) {
    const win = nativeTab.chromeBrowser?.contentWindow;
    if (win?.location.href != "about:3pane") {
      throw new ExtensionError("The tab is not a mail tab");
    }
    if (!this.panes.has(win)) {
      await this.attachPane(win);
    }
    const pane = this.panes.get(win);
    if (!pane?.input) {
      throw new ExtensionError("Expression Search is not available in this tab");
    }
    const text = this.expressionForMessage(hdr, field);
    if (text) {
      pane.setExpression(text);
    }
  }
}

/** Expression Search 2.x preferences, mapped to the current option names. */
function readLegacyPrefs(extension) {
  const branch = Services.prefs.getBranch("extensions.expressionsearch.");
  const map = {
    hide_normal_filer: "hideNormalFilter",
    act_as_normal_filter: "actAsNormalFilter",
    reuse_existing_folder: "reuseExistingFolder",
    load_virtual_folder_in_tab: "virtualFolderInNewTab",
    select_msg_on_enter: "selectFirstOnEnter",
    enable_verbose_info: "verbose",
    enable_statusbar_info: "showHelp",
    statusbar_info_showtime: "helpShowSeconds",
    statusbar_info_hidetime: "helpHideSeconds",
    search_timeout: "searchTimeout",
    c2s_enableCtrl: "c2sEnableCtrl",
    c2s_enableShift: "c2sEnableShift",
    c2s_enableCtrlReplace: "c2sCtrlReplace",
    c2s_enableShiftReplace: "c2sShiftReplace",
    c2s_regexpMatch: "c2sRegexpMatch",
    c2s_regexpReplace: "c2sRegexpReplace",
    c2s_removeDomainName: "c2sRemoveDomain",
  };
  const result = {};
  for (const [pref, option] of Object.entries(map)) {
    if (!branch.prefHasUserValue(pref)) {
      continue;
    }
    switch (branch.getPrefType(pref)) {
      case branch.PREF_BOOL:
        result[option] = branch.getBoolPref(pref);
        break;
      case branch.PREF_INT:
        result[option] = branch.getIntPref(pref);
        break;
      case branch.PREF_STRING:
        result[option] = branch.getStringPref(pref);
        break;
    }
  }
  if (branch.prefHasUserValue("virtual_folder_path")) {
    try {
      const folder = MailServices.folderLookup.getFolderForURL(
        branch.getStringPref("virtual_folder_path")
      );
      if (folder && extension.folderManager) {
        result.virtualFolderParent = extension.folderManager.convert(folder).id;
      }
    } catch (e) {}
  }
  return Object.keys(result).length ? result : null;
}

var ExpressionSearch = class extends ExtensionCommon.ExtensionAPIPersistent {
  constructor(extension) {
    super(extension);
    this.controller = null;
    this.commandListeners = new Set();
  }

  getController() {
    if (!this.controller) {
      this.controller = new Controller(this.extension, command => this.emitCommand(command));
    }
    return this.controller;
  }

  emitCommand(command) {
    for (const listener of this.commandListeners) {
      listener(command);
    }
  }

  /**
   * "events": ["startup"] in the manifest: start right away with default
   * options so that the search box is there even before the (event page)
   * background has woken up and pushed the stored options.
   */
  onStartup() {
    try {
      const controller = this.getController();
      if (!controller.started) {
        controller.setOptions({});
      }
    } catch (e) {
      console.error("Expression Search: startup failed", e);
    }
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    this.controller?.shutdown();
    this.controller = null;
  }

  PERSISTENT_EVENTS = {
    onCommand({ fire }) {
      const listener = async command => {
        if (fire.wakeup) {
          await fire.wakeup();
        }
        fire.async(command);
      };
      this.commandListeners.add(listener);
      return {
        unregister: () => this.commandListeners.delete(listener),
        convert(newFire) {
          fire = newFire;
        },
      };
    },
  };

  getAPI(context) {
    const self = this;
    const extension = this.extension;
    return {
      ExpressionSearch: {
        async setOptions(options) {
          self.getController().setOptions(options);
        },
        async searchFromMessage(tabId, messageId, field) {
          const nativeTab = extension.tabManager.get(tabId).nativeTab;
          const hdr = extension.messageManager?.get(messageId);
          if (!hdr) {
            throw new ExtensionError(`Message not found: ${messageId}`);
          }
          await self.getController().searchFromMessage(nativeTab, hdr, field);
        },
        async getLegacyPrefs() {
          return readLegacyPrefs(extension);
        },
        async getCustomDBHeaders() {
          return Services.prefs.getStringPref("mailnews.customDBHeaders", "");
        },
        async setCustomDBHeaders(headers) {
          // Also validated by the schema pattern; normalise case and spacing.
          const names = headers.split(" ").filter(Boolean);
          if (!names.every(n => /^[A-Za-z0-9-]+$/.test(n))) {
            throw new ExtensionError("Invalid header name");
          }
          const unique = [...new Set(names.map(n => n.toLowerCase()))];
          Services.prefs.setStringPref("mailnews.customDBHeaders", unique.join(" "));
        },
        onCommand: new ExtensionCommon.EventManager({
          context,
          module: "ExpressionSearch",
          event: "onCommand",
          extensionApi: self,
        }).api(),
      },
    };
  }
};
