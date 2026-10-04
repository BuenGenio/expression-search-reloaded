/* Expression Search Reloaded - custom search terms (nsIMsgSearchCustomTerm).
 *
 * Original terms by Opera Wang (GPL v3 / MPL), partly based on FiltaQuilla by
 * Kent James. Rewritten for Thunderbird 153+.
 *
 * Loaded by implementation.js with Services.scriptloader.loadSubScript() into
 * a scope that also contains ExpressionSearchParser. Defines
 * ExpressionSearchTerms in that scope.
 *
 * Custom terms cannot be unregistered from the filter service. To make
 * disabling/updating the add-on safe without a restart, every term is
 * registered once per application session as a small proxy object; the
 * actual implementation is a "delegate" that is swapped in on startup and
 * removed on shutdown. Without a delegate the proxy reports itself as
 * unavailable and never matches.
 */

"use strict";

var ExpressionSearchTerms = (function () {
  const { MailServices } = ChromeUtils.importESModule(
    "resource:///modules/MailServices.sys.mjs"
  );
  const { MimeParser } = ChromeUtils.importESModule(
    "resource:///modules/mimeParser.sys.mjs"
  );
  const Parser = ExpressionSearchParser;

  const Op = Ci.nsMsgSearchOp;
  const Scope = Ci.nsMsgSearchScope;
  const Flags = Ci.nsMsgMessageFlags;

  /** Hard limits so that a single huge message cannot stall the search. */
  const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
  const MAX_TEXT_PART_CHARS = 4 * 1024 * 1024;

  const NO_BODY_SCOPES = new Set(
    [Scope.LDAP, Scope.LDAPAnd, Scope.LocalAB, Scope.LocalABAnd].filter(
      s => s !== undefined
    )
  );
  const BODY_SCOPES = new Set(
    [
      Scope.offlineMail,
      Scope.offlineMailFilter,
      Scope.localNewsBody,
      Scope.localNewsJunkBody,
    ].filter(s => s !== undefined)
  );

  // ---------------------------------------------------------------------------
  // Helpers

  const regexCache = new Map();
  /** Compiled RegExp for a value, or null if it is invalid. Cached. */
  function getRegExp(value) {
    if (regexCache.has(value)) {
      return regexCache.get(value);
    }
    let re = null;
    try {
      re = Parser.parseRegExp(value);
    } catch (e) {
      // Reported to the user by the parser; saved filters just don't match.
    }
    if (regexCache.size > 256) {
      regexCache.clear();
    }
    regexCache.set(value, re);
    return re;
  }

  function decodeHeader(value) {
    if (!value) {
      return "";
    }
    try {
      return MailServices.mimeConverter.decodeMimeHeader(value, null, false, true);
    } catch (e) {
      return value;
    }
  }

  function decodedSubject(hdr) {
    const subject = hdr.mime2DecodedSubject || "";
    // On import Thunderbird strips "Re:" from the subject and sets a flag.
    return hdr.flags & Flags.HasRe ? `Re: ${subject}` : subject;
  }

  function decodedRecipients(hdr) {
    return [hdr.mime2DecodedRecipients, decodeHeader(hdr.ccList), decodeHeader(hdr.bccList)]
      .filter(Boolean)
      .join(", ");
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /** Message date as {date: "yyyy/mm/dd", time: "hh:mm:ss"} in local time. */
  function messageDateParts(hdr) {
    const d = new Date(hdr.date / 1000);
    return {
      date: `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      locale: d.toLocaleString(),
    };
  }

  /**
   * Text that identifies the account of a folder's server: the account name
   * plus the addresses and names of its identities, lower-cased. Cached per
   * server for a short time (searches call this for every message).
   */
  const accountTextCache = new WeakMap();
  function accountText(server) {
    if (!server) {
      return "";
    }
    const now = Date.now();
    const cached = accountTextCache.get(server);
    if (cached && now - cached.time < 30000) {
      return cached.text;
    }
    const parts = [server.prettyName];
    try {
      for (const identity of MailServices.accounts.getIdentitiesForServer(server)) {
        parts.push(identity.email, identity.fullName);
      }
    } catch (e) {}
    const text = parts.filter(Boolean).join("\n").toLowerCase();
    accountTextCache.set(server, { text, time: now });
    return text;
  }

  /**
   * Statistics of the last body search, shown to the user: messages without
   * an offline copy cannot be searched by body terms.
   */
  const bodyStats = { checked: 0, available: 0 };

  /**
   * Read the raw message as a binary string, or null if no local/offline copy
   * exists.
   */
  function readMessage(hdr) {
    const folder = hdr.folder;
    if (!folder) {
      return null;
    }
    const isLocal = folder instanceof Ci.nsIMsgLocalMailFolder;
    if (!isLocal && !(hdr.flags & Flags.Offline)) {
      return null;
    }
    let stream;
    try {
      stream = folder.getMsgInputStream(hdr);
    } catch (e) {
      try {
        // Older signature with an out parameter for "reusable".
        stream = folder.getMsgInputStream(hdr, {});
      } catch (e2) {
        return null;
      }
    }
    const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    try {
      sis.init(stream);
      const chunks = [];
      let total = 0;
      for (;;) {
        let available = 0;
        try {
          available = sis.available();
        } catch (e) {
          break; // NS_BASE_STREAM_CLOSED at end of the message
        }
        if (!available || total >= MAX_MESSAGE_BYTES) {
          break;
        }
        const chunk = sis.readBytes(Math.min(available, MAX_MESSAGE_BYTES - total, 1 << 20));
        if (!chunk.length) {
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
      return chunks.join("");
    } catch (e) {
      return null;
    } finally {
      try {
        sis.close();
      } catch (e) {}
    }
  }

  /**
   * Walk the MIME structure of a raw message.
   *
   * @param {string} raw - Binary string.
   * @param {object} what - {attachment: lowercased needle} or {regex: RegExp}
   * @returns {{found: boolean, hasAttachment: boolean}}
   */
  function scanMessage(raw, what) {
    const attachmentSearch = "attachment" in what;
    const needle = what.attachment;
    const regex = what.regex;
    const contentTypes = new Map();
    const textParts = new Map();
    const rfc822Parts = new Set();
    const state = { found: false, hasAttachment: false };

    const contains = s => typeof s == "string" && s.toLowerCase().includes(needle);

    const emitter = {
      startPart(partNum, headers) {
        const contentType = headers.get("content-type");
        contentTypes.set(partNum, contentType);
        if (!attachmentSearch) {
          return;
        }
        if (contentType) {
          if (contains(contentType.type)) {
            state.found = true;
          }
          if (contentType.type == "message/rfc822") {
            rfc822Parts.add(`${partNum}$`);
          }
          if (contentType.has("name")) {
            state.hasAttachment = true;
            if (contains(contentType.get("name"))) {
              state.found = true;
            }
          }
        }
        for (const disposition of headers.getRawHeader("content-disposition") || []) {
          const parsed = MimeParser.parseHeaderField(
            disposition,
            MimeParser.HEADER_PARAMETER | MimeParser.HEADER_OPTION_ALL_I18N,
            ""
          );
          if (parsed.preSemi && parsed.preSemi.toLowerCase() == "attachment") {
            state.hasAttachment = true;
          }
          if (parsed.has("filename")) {
            state.hasAttachment = true;
            if (contains(parsed.get("filename"))) {
              state.found = true;
            }
          }
        }
        // A forwarded message has no file name; Thunderbird shows its subject
        // with an .eml extension, so search for that.
        if (rfc822Parts.has(partNum)) {
          state.hasAttachment = true;
          let name = headers.has("subject") ? String(headers.get("subject")).trim() : "";
          name = name ? `${name}.eml` : "ForwardedMessage.eml";
          if (contains(name)) {
            state.found = true;
          }
        }
      },
      deliverPartData(partNum, data) {
        if (state.found || attachmentSearch) {
          return;
        }
        const contentType = contentTypes.get(partNum);
        if (contentType?.mediatype != "text") {
          return;
        }
        const previous = textParts.get(partNum) || "";
        if (previous.length < MAX_TEXT_PART_CHARS) {
          textParts.set(partNum, previous + data);
        }
      },
      endPart(partNum) {
        if (state.found || attachmentSearch || !textParts.has(partNum)) {
          return;
        }
        const body = textParts.get(partNum);
        textParts.delete(partNum);
        const contentType = contentTypes.get(partNum);
        regex.lastIndex = 0;
        if (regex.test(body)) {
          state.found = true;
          return;
        }
        if (contentType?.subtype == "html") {
          const parserUtils = Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils);
          const plain = parserUtils.convertToPlainText(
            body,
            Ci.nsIDocumentEncoder.OutputLFLineBreak |
              Ci.nsIDocumentEncoder.OutputNoScriptContent |
              Ci.nsIDocumentEncoder.OutputNoFramesContent |
              Ci.nsIDocumentEncoder.OutputBodyOnly,
            0
          );
          regex.lastIndex = 0;
          state.found = regex.test(plain);
        }
      },
    };

    MimeParser.parseSync(
      raw,
      emitter,
      attachmentSearch
        ? { bodyformat: "none" }
        : { bodyformat: "decode", strformat: "unicode" }
    );
    return state;
  }

  // ---------------------------------------------------------------------------
  // Term implementations (delegates)

  function term(name, operators, match, needsBody = false) {
    return {
      name,
      operators,
      needsBody,
      isValid(scope) {
        if (NO_BODY_SCOPES.has(scope)) {
          return false;
        }
        return !needsBody || BODY_SCOPES.has(scope);
      },
      match,
    };
  }

  const MATCH_OPS = [Op.Matches, Op.DoesntMatch];
  const CONTAINS_OPS = [Op.Contains, Op.DoesntContain];
  const TIME_OPS = [Op.IsBefore, Op.IsAfter];

  /** XOR the result with the negating operator. */
  const apply = (result, op, negatingOp) => (op == negatingOp ? !result : result);

  function regexTerm(name, getText) {
    return term(name, MATCH_OPS, (hdr, value, op) => {
      const re = getRegExp(value);
      if (!re) {
        return false;
      }
      re.lastIndex = 0;
      return apply(re.test(getText(hdr)), op, Op.DoesntMatch);
    });
  }

  function bodyTerm(name, operators, scan) {
    return term(
      name,
      operators,
      (hdr, value, op) => {
        bodyStats.checked++;
        const raw = readMessage(hdr);
        if (raw === null) {
          return false;
        }
        bodyStats.available++;
        return scan(raw, value, op);
      },
      true
    );
  }

  function createDelegates(localize) {
    const delegates = {
      Bcc: term(localize("term_Bcc"), CONTAINS_OPS, (hdr, value, op) =>
        apply(
          decodeHeader(hdr.bccList).toLowerCase().includes(value.toLowerCase()),
          op,
          Op.DoesntContain
        )
      ),

      toSomebodyOnly: term(localize("term_toSomebodyOnly"), CONTAINS_OPS, (hdr, value, op) => {
        const recipients = MailServices.headerParser
          .parseDecodedHeader(hdr.mime2DecodedRecipients || "")
          .map(a => `${a.name} <${a.email}>`.toLowerCase());
        const wanted = value
          .toLowerCase()
          .split(/[,;]/)
          .map(s => s.trim())
          .filter(Boolean);
        const result =
          wanted.length > 0 &&
          recipients.length == wanted.length &&
          wanted.every(w => recipients.some(r => r.includes(w)));
        return apply(result, op, Op.DoesntContain);
      }),

      subjectRegex: regexTerm(localize("term_subjectRegex"), decodedSubject),

      // Long/special-character safe, case sensitive "subject contains".
      subjectSimple: term(localize("term_subjectSimple"), CONTAINS_OPS, (hdr, value, op) =>
        apply((hdr.mime2DecodedSubject || "").includes(value), op, Op.DoesntContain)
      ),

      // "List-Id" (header present) or "List-Id=/regex/" / "List-Id~regex".
      // Only works for headers listed in mailnews.customDBHeaders.
      headerRegex: term(localize("term_headerRegex"), MATCH_OPS, (hdr, value, op) => {
        let spec;
        try {
          spec = Parser.parseHeaderRegex(value);
        } catch (e) {
          return false;
        }
        const raw = hdr.getStringProperty(spec.header);
        if (spec.regex === null) {
          return apply(raw != "", op, Op.DoesntMatch);
        }
        const re = getRegExp(spec.regex);
        if (!re) {
          return false;
        }
        re.lastIndex = 0;
        return apply(re.test(raw.includes("=?") ? decodeHeader(raw) : raw), op, Op.DoesntMatch);
      }),

      fromRegex: regexTerm(localize("term_fromRegex"), hdr => hdr.mime2DecodedAuthor || ""),

      toRegex: regexTerm(localize("term_toRegex"), decodedRecipients),

      // Time of day, compared as "hh:mm:ss" in local time.
      dayTime: term(localize("term_dayTime"), TIME_OPS, (hdr, value, op) => {
        const { time } = messageDateParts(hdr);
        return op == Op.IsBefore ? time < value : time > value;
      }),

      // "2011/01/03 10:" style partial match on the local date/time.
      dateMatch: term(localize("term_dateMatch"), CONTAINS_OPS, (hdr, value, op) => {
        const { date, time, locale } = messageDateParts(hdr);
        const result = `${date} ${time}`.includes(value) || locale.includes(value);
        return apply(result, op, Op.DoesntContain);
      }),

      // "acc:work": the account name or one of its addresses contains "work".
      account: term(localize("term_account"), CONTAINS_OPS, (hdr, value, op) =>
        apply(accountText(hdr.folder?.server).includes(value.toLowerCase()), op, Op.DoesntContain)
      ),

      attachmentNameOrType: bodyTerm(
        localize("term_attachmentNameOrType"),
        CONTAINS_OPS,
        (raw, value, op) => {
          const state = scanMessage(raw, { attachment: value.toLowerCase() });
          // Messages without attachments never match, also not negated.
          if (!state.hasAttachment) {
            return false;
          }
          return apply(state.found, op, Op.DoesntContain);
        }
      ),

      bodyRegex: bodyTerm(localize("term_bodyRegex"), MATCH_OPS, (raw, value, op) => {
        const re = getRegExp(value);
        if (!re) {
          return false;
        }
        return apply(scanMessage(raw, { regex: re }).found, op, Op.DoesntMatch);
      }),
    };
    return delegates;
  }

  // ---------------------------------------------------------------------------
  // Registration with swappable delegates

  class TermProxy {
    constructor(id, delegate) {
      this._id = id;
      this._name = delegate.name;
      this.delegate = delegate;
      this.isExpressionSearchProxy = true;
      this.wrappedJSObject = this;
      this.QueryInterface = ChromeUtils.generateQI(["nsIMsgSearchCustomTerm"]);
    }
    get id() {
      return this._id;
    }
    get name() {
      return this.delegate?.name ?? this._name;
    }
    get needsBody() {
      return this.delegate?.needsBody ?? false;
    }
    getEnabled(scope, op) {
      return !!this.delegate?.isValid(scope);
    }
    getAvailable(scope, op) {
      return !!this.delegate?.isValid(scope);
    }
    getAvailableOperators(scope, length) {
      const ops = this.delegate?.isValid(scope) ? this.delegate.operators : [];
      if (length && typeof length == "object") {
        length.value = ops.length; // pre-Array<> signature
      }
      return ops;
    }
    match(msgHdr, searchValue, searchOp) {
      const delegate = this.delegate;
      if (!delegate) {
        return false;
      }
      try {
        return !!delegate.match(msgHdr, searchValue, searchOp);
      } catch (e) {
        console.error(`Expression Search: custom term ${this._id} failed`, e);
        return false;
      }
    }
  }

  const ID_PREFIX = "expressionsearch#";

  /**
   * Register (or re-activate) all terms.
   *
   * @returns {string[]} ids that could not be registered because a foreign
   *   term with the same id exists.
   */
  function register(localize) {
    const conflicts = [];
    for (const [name, delegate] of Object.entries(createDelegates(localize))) {
      const id = ID_PREFIX + name;
      let existing = null;
      try {
        existing = MailServices.filters.getCustomTerm(id);
      } catch (e) {}
      const proxy = existing?.wrappedJSObject;
      if (proxy?.isExpressionSearchProxy) {
        proxy.delegate = delegate;
        continue;
      }
      if (existing) {
        conflicts.push(id);
        continue;
      }
      MailServices.filters.addCustomTerm(new TermProxy(id, delegate));
    }
    return conflicts;
  }

  /** Deactivate all terms (they stay registered until restart). */
  function unregister() {
    for (const term of MailServices.filters.getCustomTerms()) {
      if (!term.id.startsWith(ID_PREFIX)) {
        continue;
      }
      const proxy = term.wrappedJSObject;
      if (proxy?.isExpressionSearchProxy) {
        proxy.delegate = null;
      }
    }
    regexCache.clear();
  }

  function resetBodyStats() {
    bodyStats.checked = 0;
    bodyStats.available = 0;
  }

  return {
    ID_PREFIX,
    register,
    unregister,
    bodyStats,
    resetBodyStats,
    // exported for tests
    _scanMessage: scanMessage,
    _readMessage: readMessage,
  };
})();
