/* Expression Search Reloaded - expression language.
 *
 * Original tokenizer/parser (c) 2005 Ken Mixter (GMailUI, "completely free to
 * use as you wish"), extended by Opera Wang (GPL v3 / MPL), maintained for
 * Thunderbird 78 by Klaus Buecher/opto. Rewritten for Thunderbird 153+.
 *
 * This file is pure JavaScript without any platform dependency. It is loaded
 *  - by the privileged experiment via Services.scriptloader.loadSubScript(),
 *  - by the unit tests via require().
 *
 * Pipeline:
 *   text --tokenize--> tokens --parse--> AST
 *        --distribute specifiers / expand bare words--> AST of literals
 *        --negation normal form--> --conjunctive normal form--> clauses
 *        --describeLiteral--> term descriptors (attrib/op/value by *name*)
 *
 * The term descriptors refer to nsMsgSearchAttrib / nsMsgSearchOp constants
 * by name; the experiment maps them onto real nsIMsgSearchTerm objects. That
 * keeps all of the parsing and value-normalisation logic testable here.
 */

"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module == "object" && module.exports) {
    module.exports = api;
  } else {
    root.ExpressionSearchParser = api;
  }
})(this || globalThis, function () {
  /**
   * Canonical operator names and their aliases. Operators are recognised
   * case-sensitively (all lower case) so that subjects such as "Re: foo" are
   * not mistaken for the "re:" (regex) operator.
   */
  const TOKENS = {
    from: ["f"],
    fromre: ["fr"],
    to: ["t", "toorcc"],
    tore: ["tr"],
    tonocc: ["tn"],
    cc: ["c"],
    bcc: ["bc"],
    only: ["o"],
    subject: ["s"],
    simple: [],
    regex: ["re", "r", "subre"],
    size: ["si", "larger"],
    smaller: ["sm"],
    body: ["b"],
    bodyre: ["br"],
    attachment: ["a"],
    filename: ["fi", "fn", "file"],
    tag: ["l", "label"],
    before: ["be"],
    after: ["af"],
    date: ["d"],
    days: ["da", "age", "ag", "ot", "older_than"],
    newer_than: ["n", "nt"],
    headerre: ["h", "hr"],
    status: ["u", "is", "i"],
    all: ["al"],
    fromto: ["ft", "ftc", "fromtocc", "alladdresses"],
    gloda: ["g"],
  };

  /** alias or canonical name -> canonical name */
  const TOKEN_MAP = new Map();
  for (const [name, aliases] of Object.entries(TOKENS)) {
    TOKEN_MAP.set(name, name);
    for (const alias of aliases) {
      TOKEN_MAP.set(alias, name);
    }
  }

  // Longest names first, so that "fromre" wins over "from" and "f".
  const ALL_TOKEN_NAMES = [...TOKEN_MAP.keys()].sort(
    (a, b) => b.length - a.length || a.localeCompare(b)
  );
  const OPERATOR_RE = new RegExp(`^(${ALL_TOKEN_NAMES.join("|")}):`);

  /**
   * Operators whose value is the complete remainder of the input, taken
   * verbatim (no further parsing). They must therefore be the last operator.
   */
  const REST_OF_INPUT_TOKENS = new Set([
    "simple",
    "regex",
    "headerre",
    "bodyre",
    "fromre",
    "tore",
  ]);

  /** Operators that have to read the message body; they are evaluated last. */
  const SLOW_TOKENS = new Set(["body", "filename", "bodyre"]);

  /** Limits that protect against pathological input. */
  const MAX_INPUT_LENGTH = 2048;
  const MAX_CLAUSES = 256;
  const MAX_LITERALS_PER_CLAUSE = 64;

  class ExpressionError extends Error {
    constructor(message, detail) {
      super(message);
      this.name = "ExpressionError";
      this.detail = detail;
    }
  }

  // ---------------------------------------------------------------------------
  // Tokenizer

  /**
   * @param {string} input
   * @returns {{tokens: object[], hasOperators: boolean, looksLikeCalc: boolean}}
   */
  function tokenize(input) {
    const tokens = [];
    let str = input;
    let hasOperators = false;
    let seemsLikeCalc = false;
    let cantBeCalc = false;

    while (str.length) {
      const ws = /^\s+/.exec(str);
      if (ws) {
        str = str.substring(ws[0].length);
        continue;
      }

      const ch = str[0];
      if (ch == "(" || ch == ")") {
        tokens.push({ kind: "group", tok: ch });
        str = str.substring(1);
        continue;
      }
      if (ch == "-") {
        tokens.push({ kind: "not", tok: "-" });
        str = str.substring(1);
        continue;
      }
      if (ch == '"') {
        cantBeCalc = true;
        let end = str.indexOf('"', 1);
        if (end == -1) {
          // An unterminated quote extends to the end of the input; this keeps
          // the result stable while the user is still typing.
          end = str.length;
        }
        tokens.push({ kind: "str", tok: str.substring(1, end), quoted: true });
        str = str.substring(end + 1);
        continue;
      }

      const op = OPERATOR_RE.exec(str);
      if (op) {
        const name = TOKEN_MAP.get(op[1]);
        hasOperators = true;
        cantBeCalc = true;
        tokens.push({ kind: "spec", tok: name });
        str = str.substring(op[0].length);
        if (REST_OF_INPUT_TOKENS.has(name)) {
          tokens.push({ kind: "str", tok: str.trim(), verbatim: true });
          str = "";
        }
        continue;
      }

      const word = /^[^\s()]+/.exec(str)[0];
      str = str.substring(word.length);
      if (word == "and" || word == "or") {
        tokens.push({ kind: "bool", tok: word });
        cantBeCalc = true;
        continue;
      }
      if (/[a-zA-Z]/.test(word)) {
        cantBeCalc = true;
      } else if (/[+\-*/=]/.test(word)) {
        seemsLikeCalc = true;
      }
      tokens.push({ kind: "str", tok: word });
    }

    return {
      tokens,
      hasOperators,
      looksLikeCalc: seemsLikeCalc && !cantBeCalc,
    };
  }

  // ---------------------------------------------------------------------------
  // Parser
  //
  // Grammar (unchanged from GMailUI):
  //   expr   := orExpr ( ["and"] orExpr )*        -- implicit AND
  //   orExpr := notExpr ( "or" notExpr )*
  //   notExpr:= ["-"] specExpr
  //   specExpr := spec ( notExpr | leaf ) | leaf  -- "from:-foo" is allowed
  //   leaf   := "(" expr ")" | str+              -- adjacent words form a phrase
  //
  // AST nodes: {type:"and"|"or", left, right}, {type:"not", expr},
  //            {type:"spec", name, expr}, {type:"str", value}

  class TokenStream {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
    }
    peek() {
      return this.tokens[this.pos] || { kind: "end", tok: "" };
    }
    next() {
      const token = this.peek();
      this.pos++;
      return token;
    }
    is(kind, tok) {
      const t = this.peek();
      return t.kind == kind && (tok === undefined || t.tok == tok);
    }
    atEnd() {
      return this.pos >= this.tokens.length;
    }
  }

  function parseExpr(ts, depth) {
    if (depth > 64) {
      throw new ExpressionError("tooDeep");
    }
    let e = parseOr(ts, depth);
    for (;;) {
      if (ts.is("group", ")")) {
        ts.next();
        break;
      }
      if (ts.atEnd()) {
        break;
      }
      if (ts.is("bool", "and")) {
        ts.next();
        if (ts.atEnd()) {
          break;
        }
      }
      const e2 = parseOr(ts, depth);
      e = makeBinary("and", e, e2);
    }
    return e;
  }

  function parseOr(ts, depth) {
    let e = parseNot(ts, depth);
    while (ts.is("bool", "or")) {
      ts.next();
      if (ts.atEnd() || ts.is("group", ")")) {
        break;
      }
      e = makeBinary("or", e, parseNot(ts, depth));
    }
    return e;
  }

  function parseNot(ts, depth) {
    if (ts.is("not")) {
      ts.next();
      return makeNot(parseSpec(ts, depth));
    }
    return parseSpec(ts, depth);
  }

  function parseSpec(ts, depth) {
    if (ts.is("spec")) {
      const name = ts.next().tok;
      const expr = ts.is("not") ? parseNot(ts, depth) : parseLeaf(ts, depth);
      return { type: "spec", name, expr };
    }
    return parseLeaf(ts, depth);
  }

  function parseLeaf(ts, depth) {
    if (ts.is("group", "(")) {
      ts.next();
      return parseExpr(ts, depth + 1);
    }
    // An operator without a value ("f:" at the end, "f: t:bob" or "(f:)") is
    // incomplete; it is ignored rather than swallowing what follows.
    if (ts.atEnd() || ts.is("group", ")") || ts.is("spec")) {
      return { type: "str", value: "" };
    }
    // Anything else (a word or a misplaced and/or) is treated as text.
    // Adjacent words are concatenated into one phrase.
    const first = ts.next();
    const words = [first.tok];
    let quoted = !!first.quoted;
    while (ts.is("str")) {
      const t = ts.next();
      quoted = quoted || !!t.quoted;
      words.push(t.tok);
    }
    return { type: "str", value: words.join(" "), quoted };
  }

  function makeBinary(type, left, right) {
    return { type, left, right };
  }

  function makeNot(expr) {
    return { type: "not", expr };
  }

  // ---------------------------------------------------------------------------
  // Transformations

  /**
   * Push specifiers down to the strings they apply to and expand strings
   * without a specifier (and "all:") into a search over the address and
   * subject fields. Result consists of and/or/not nodes over literals:
   *   {type:"lit", token, value} or {type:"empty"} (an incomplete term).
   */
  function toLiterals(node, spec) {
    switch (node.type) {
      case "and":
      case "or":
        return {
          type: node.type,
          left: toLiterals(node.left, spec),
          right: toLiterals(node.right, spec),
        };
      case "not":
        return makeNot(toLiterals(node.expr, spec));
      case "spec":
        return toLiterals(node.expr, node.name);
      case "str": {
        const value = node.quoted ? node.value : node.value.trim();
        if (value == "" || spec == "gloda") {
          return { type: "empty" };
        }
        if (!spec || spec == "all") {
          let e = makeBinary(
            "or",
            makeBinary(
              "or",
              { type: "lit", token: "from", value },
              { type: "lit", token: "to", value }
            ),
            { type: "lit", token: "subject", value }
          );
          if (spec == "all") {
            e = makeBinary("or", e, { type: "lit", token: "body", value });
          }
          return e;
        }
        return { type: "lit", token: spec, value };
      }
    }
    throw new ExpressionError("internal", `unexpected node ${node.type}`);
  }

  /** Remove incomplete terms: they neither restrict nor widen the search. */
  function prune(node) {
    switch (node.type) {
      case "and":
      case "or": {
        const left = prune(node.left);
        const right = prune(node.right);
        if (left.type == "empty") {
          return right;
        }
        if (right.type == "empty") {
          return left;
        }
        return { type: node.type, left, right };
      }
      case "not": {
        const expr = prune(node.expr);
        return expr.type == "empty" ? expr : makeNot(expr);
      }
      default:
        return node;
    }
  }

  /** Negation normal form: negations only directly above literals. */
  function toNNF(node, negate = false) {
    switch (node.type) {
      case "not":
        return toNNF(node.expr, !negate);
      case "and":
      case "or": {
        const type = negate ? (node.type == "and" ? "or" : "and") : node.type;
        return {
          type,
          left: toNNF(node.left, negate),
          right: toNNF(node.right, negate),
        };
      }
      case "lit":
        return { ...node, negate };
    }
    throw new ExpressionError("internal", `unexpected node ${node.type}`);
  }

  /**
   * Conjunctive normal form, as a list of clauses (each a list of literals
   * that are OR'ed together; clauses are AND'ed). This is exactly what the
   * Thunderbird search term model can express: one level of grouping.
   */
  function toCNF(node) {
    switch (node.type) {
      case "lit":
        return [[node]];
      case "and": {
        const clauses = [...toCNF(node.left), ...toCNF(node.right)];
        if (clauses.length > MAX_CLAUSES) {
          throw new ExpressionError("tooComplex");
        }
        return clauses;
      }
      case "or": {
        const left = toCNF(node.left);
        const right = toCNF(node.right);
        if (left.length * right.length > MAX_CLAUSES) {
          throw new ExpressionError("tooComplex");
        }
        const clauses = [];
        for (const l of left) {
          for (const r of right) {
            const clause = [...l, ...r];
            if (clause.length > MAX_LITERALS_PER_CLAUSE) {
              throw new ExpressionError("tooComplex");
            }
            clauses.push(clause);
          }
        }
        return clauses;
      }
    }
    throw new ExpressionError("internal", `unexpected node ${node.type}`);
  }

  function literalKey(lit) {
    return `${lit.negate ? "-" : ""}${lit.token}\u0000${lit.value}`;
  }

  /** Drop duplicate literals/clauses and order cheap tests first. */
  function simplify(clauses) {
    const cost = lit => (SLOW_TOKENS.has(lit.token) ? 1 : 0);
    const seen = new Set();
    const result = [];
    for (const clause of clauses) {
      const unique = new Map();
      for (const lit of clause) {
        unique.set(literalKey(lit), lit);
      }
      const sorted = [...unique.values()].sort((a, b) => cost(a) - cost(b));
      const key = sorted.map(literalKey).sort().join("\u0001");
      if (!seen.has(key)) {
        seen.add(key);
        result.push(sorted);
      }
    }
    const clauseCost = clause => Math.max(...clause.map(cost));
    return result.sort((a, b) => clauseCost(a) - clauseCost(b));
  }

  // ---------------------------------------------------------------------------
  // Value normalisation: literal -> term descriptor

  const CUSTOM = {
    bcc: "expressionsearch#Bcc",
    only: "expressionsearch#toSomebodyOnly",
    simple: "expressionsearch#subjectSimple",
    regex: "expressionsearch#subjectRegex",
    headerre: "expressionsearch#headerRegex",
    date: "expressionsearch#dateMatch",
    dayTime: "expressionsearch#dayTime",
    filename: "expressionsearch#attachmentNameOrType",
    bodyre: "expressionsearch#bodyRegex",
    fromre: "expressionsearch#fromRegex",
    tore: "expressionsearch#toRegex",
  };

  const HEADER_ATTRIBS = {
    from: "Sender",
    fromto: "AllAddresses",
    to: "ToOrCC",
    tonocc: "To",
    cc: "CC",
    subject: "Subject",
    body: "Body",
  };

  /**
   * Parse a regular expression given either as "/source/flags" or as a bare
   * source. Throws ExpressionError("badRegex") if it is invalid.
   *
   * @returns {RegExp}
   */
  function parseRegExp(text) {
    let source = text;
    let flags = "";
    if (text.startsWith("/")) {
      let last = text.lastIndexOf("/");
      if (last == 0) {
        last = text.length;
      }
      source = text.substring(1, last);
      flags = text.substring(last + 1);
    }
    try {
      return new RegExp(source, flags.replace(/[gy]/g, ""));
    } catch (e) {
      throw new ExpressionError("badRegex", `${text}: ${e.message}`);
    }
  }

  /** Validate "Header", "Header=regex" or "Header~regex". */
  function parseHeaderRegex(text) {
    const split = text.search(/[~=]/);
    if (split == -1) {
      const header = text.trim().toLowerCase();
      if (!header) {
        throw new ExpressionError("badHeader", text);
      }
      return { header, regex: null };
    }
    const header = text.substring(0, split).trim().toLowerCase();
    if (!header) {
      throw new ExpressionError("badHeader", text);
    }
    const regex = text.substring(split + 1);
    parseRegExp(regex);
    return { header, regex };
  }

  const TIME_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/;
  const DATE_RE =
    /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;

  /** "3:5" -> "03:05:00", or null if the value is not a time of day. */
  function parseTimeOfDay(value) {
    const m = TIME_RE.exec(value.trim());
    if (!m) {
      return null;
    }
    const [h, min, s = "0"] = m.slice(1);
    if (+h > 23 || +min > 59 || +s > 60) {
      throw new ExpressionError("badTime", value);
    }
    return [h, min, s].map(x => x.padStart(2, "0")).join(":");
  }

  /**
   * Parse a date. "yyyy/mm/dd [hh:mm[:ss]]" (also with - or .) is interpreted
   * in local time; anything else is handed to Date.parse(). Returns
   * milliseconds since the epoch.
   */
  function parseDate(value) {
    const m = DATE_RE.exec(value.trim());
    let date;
    if (m) {
      const [y, mo, d = "1", h = "0", mi = "0", s = "0"] = m.slice(1);
      date = new Date(+y, +mo - 1, +d, +h, +mi, +s);
      if (date.getMonth() != +mo - 1) {
        throw new ExpressionError("badDate", value);
      }
    } else {
      date = new Date(value);
    }
    if (isNaN(date.getTime())) {
      throw new ExpressionError("badDate", value);
    }
    return date.getTime();
  }

  /** "3", "2w", "1.5month", "today", "yesterday" -> {days, relative} */
  function parseAge(value) {
    const m = /^(-?[\d.]*)\s*([a-z]*)$/i.exec(value.trim());
    if (!m) {
      throw new ExpressionError("badAge", value);
    }
    let [, count, unit] = m;
    unit = unit.toLowerCase();
    if (unit == "today" || unit == "yesterday") {
      if (count) {
        throw new ExpressionError("badAge", value);
      }
      return { days: unit == "today" ? 1 : 2, within: true };
    }
    let days = count === "" ? 1 : parseFloat(count);
    if (isNaN(days)) {
      throw new ExpressionError("badAge", value);
    }
    if (unit == "" || /^d(ays?)?$/.test(unit)) {
      // days
    } else if (/^w(eeks?)?$/.test(unit)) {
      days *= 7;
    } else if (/^m(onths?)?$/.test(unit)) {
      days *= 30.4369;
    } else if (/^y(ears?)?$/.test(unit)) {
      days *= 365.2425;
    } else {
      throw new ExpressionError("badAge", value);
    }
    return { days, within: false };
  }

  /** "10" (KB), "1.4M", "1G", "512k" -> size in KB */
  function parseSize(value) {
    const m = /^([\d.]+)\s*([kmg]?)b?$/i.exec(value.trim());
    if (!m || isNaN(parseFloat(m[1]))) {
      throw new ExpressionError("badSize", value);
    }
    const scale = { "": 1, k: 1, m: 1024, g: 1024 * 1024 }[m[2].toLowerCase()];
    return Math.round(parseFloat(m[1]) * scale);
  }

  /** status name -> {flag, invert} (flag = nsMsgMessageFlags name) */
  function parseStatus(value) {
    const v = value.trim();
    const table = [
      [/^unr/i, "Read", true],
      [/^rep/i, "Replied", false],
      [/^rea/i, "Read", false],
      [/^(m|star|fl)/i, "Marked", false],
      [/^f/i, "Forwarded", false],
      [/^n/i, "New", false],
      [/^(i|d)/i, "IMAPDeleted", false],
      [/^a/i, "Attachment", false],
    ];
    for (const [re, flag, invert] of table) {
      if (re.test(v)) {
        return { flag, invert };
      }
    }
    throw new ExpressionError("badStatus", value);
  }

  /**
   * Turn a literal into a term descriptor:
   *   { attrib, op, value, valueType, customId?, tag?, display }
   * attrib/op are names of nsMsgSearchAttrib / nsMsgSearchOp constants,
   * valueType says which nsIMsgSearchValue field receives `value`.
   *
   * @throws {ExpressionError}
   */
  function describeLiteral(lit) {
    let { token, value } = lit;
    let negate = !!lit.negate;
    const d = {
      token,
      negate,
      source: value,
    };
    const text = (pos, neg) => (negate ? neg : pos);

    if (token == "attachment" && !/^(y|yes|n|no|1|0)$/i.test(value.trim())) {
      token = "filename";
    }

    if (token in HEADER_ATTRIBS) {
      return {
        ...d,
        attrib: HEADER_ATTRIBS[token],
        op: text("Contains", "DoesntContain"),
        valueType: "str",
        value,
      };
    }

    switch (token) {
      case "bcc":
      case "only":
      case "simple":
      case "filename":
      case "date":
        return {
          ...d,
          attrib: "Custom",
          customId: CUSTOM[token],
          op: text("Contains", "DoesntContain"),
          valueType: "str",
          value,
        };
      case "regex":
      case "bodyre":
      case "fromre":
      case "tore":
        parseRegExp(value);
        return {
          ...d,
          attrib: "Custom",
          customId: CUSTOM[token],
          op: text("Matches", "DoesntMatch"),
          valueType: "str",
          value,
        };
      case "headerre":
        parseHeaderRegex(value);
        return {
          ...d,
          attrib: "Custom",
          customId: CUSTOM.headerre,
          op: text("Matches", "DoesntMatch"),
          valueType: "str",
          value,
        };
      case "attachment": {
        const wanted = /^(y|yes|1)$/i.test(value.trim());
        negate = negate == wanted; // "a:no" is "not has attachment"
        return {
          ...d,
          negate,
          attrib: "HasAttachmentStatus",
          op: negate ? "Isnt" : "Is",
          valueType: "status",
          value: "Attachment",
        };
      }
      case "status": {
        const { flag, invert } = parseStatus(value);
        const neg = negate != invert;
        return {
          ...d,
          attrib: "MsgStatus",
          op: neg ? "Isnt" : "Is",
          valueType: "status",
          value: flag,
        };
      }
      case "size":
      case "smaller": {
        const kb = parseSize(value);
        const smaller = (token == "smaller") != negate;
        return {
          ...d,
          attrib: "Size",
          op: smaller ? "IsLessThan" : "IsGreaterThan",
          valueType: "size",
          value: kb,
        };
      }
      case "days":
      case "newer_than": {
        const { days, within } = parseAge(value);
        // older_than:N  -> age > N ; newer_than:N -> age < N
        // "today"/"yesterday" mean "within" the last 1/2 days.
        const newer = (token == "newer_than") != within != negate;
        return {
          ...d,
          attrib: "AgeInDays",
          op: newer ? "IsLessThan" : "IsGreaterThan",
          valueType: "age",
          value: days,
        };
      }
      case "before":
      case "after": {
        const isBefore = (token == "before") != negate;
        const time = parseTimeOfDay(value);
        if (time) {
          return {
            ...d,
            attrib: "Custom",
            customId: CUSTOM.dayTime,
            op: isBefore ? "IsBefore" : "IsAfter",
            valueType: "str",
            value: time,
          };
        }
        // Thunderbird compares dates by calendar day and only offers strict
        // IsBefore/IsAfter. The negation of "after day X" is "on or before
        // X" = "before X+1" (and vice versa), so shift by one calendar day.
        const date = new Date(parseDate(value));
        if (negate) {
          date.setDate(date.getDate() + (token == "after" ? 1 : -1));
        }
        return {
          ...d,
          attrib: "Date",
          op: isBefore ? "IsBefore" : "IsAfter",
          valueType: "date",
          // PRTime: microseconds since the epoch.
          value: date.getTime() * 1000,
        };
      }
      case "tag": {
        const v = value.trim();
        if (/^na$/i.test(v)) {
          return {
            ...d,
            attrib: "Keywords",
            op: negate ? "IsntEmpty" : "IsEmpty",
            valueType: "str",
            value: "",
          };
        }
        return {
          ...d,
          attrib: "Keywords",
          op: text("Contains", "DoesntContain"),
          valueType: "str",
          // Resolved to a tag key by the caller (needs the tag service).
          tag: v,
          value: v,
        };
      }
    }
    throw new ExpressionError("unknownOperator", token);
  }

  // ---------------------------------------------------------------------------
  // Calculator (input like "1+2*3")

  function calcTokens(input) {
    const tokens = [];
    let str = input;
    while (str.length) {
      const ws = /^\s+/.exec(str);
      if (ws) {
        str = str.substring(ws[0].length);
        continue;
      }
      if (str[0] == "=") {
        break; // "1+2 = 3" -> evaluate the left side again
      }
      if ("()+-*/".includes(str[0])) {
        tokens.push({ kind: "op", tok: str[0] });
        str = str.substring(1);
        continue;
      }
      const num = /^[^\s()+\-*/=]+/.exec(str)[0];
      tokens.push({ kind: "num", tok: num });
      str = str.substring(num.length);
    }
    return tokens;
  }

  function calculate(input) {
    const ts = new TokenStream(calcTokens(input));
    const isOp = t => ts.is("op", t);
    function expr() {
      let v = term();
      while (isOp("+") || isOp("-")) {
        const op = ts.next().tok;
        const r = term();
        v = op == "+" ? v + r : v - r;
      }
      return v;
    }
    function term() {
      let v = unary();
      while (isOp("*") || isOp("/")) {
        const op = ts.next().tok;
        const r = unary();
        v = op == "*" ? v * r : v / r;
      }
      return v;
    }
    function unary() {
      if (isOp("-")) {
        ts.next();
        return -unary();
      }
      if (isOp("+")) {
        ts.next();
        return unary();
      }
      return leaf();
    }
    function leaf() {
      if (isOp("(")) {
        ts.next();
        const v = expr();
        if (isOp(")")) {
          ts.next();
        }
        return v;
      }
      const t = ts.next();
      const v = Number(t.tok);
      if (t.kind != "num" || isNaN(v)) {
        throw new ExpressionError("badNumber", t.tok);
      }
      return v;
    }
    const value = expr();
    if (!ts.atEnd()) {
      throw new ExpressionError("badNumber", ts.peek().tok);
    }
    const lhs = input.split("=")[0].trim();
    return { value, text: `${lhs} = ${value}` };
  }

  // ---------------------------------------------------------------------------
  // Public entry points

  /**
   * Compile a user expression.
   *
   * @param {string} input
   * @returns {{
   *   kind: "empty"|"calc"|"gloda"|"search",
   *   hasOperators: boolean,
   *   clauses: object[][],   // term descriptors, CNF
   *   errors: {code: string, detail?: string}[],
   *   glodaQuery?: string,
   * }}
   */
  function compile(input) {
    const result = {
      kind: "empty",
      hasOperators: false,
      clauses: [],
      errors: [],
    };
    if (typeof input != "string") {
      return result;
    }
    if (input.length > MAX_INPUT_LENGTH) {
      input = input.substring(0, MAX_INPUT_LENGTH);
    }
    if (!input.trim()) {
      return result;
    }

    if (/^\s*g:/.test(input)) {
      result.kind = "gloda";
      result.glodaQuery = toGlodaQuery(input);
      return result;
    }

    try {
      const { tokens, hasOperators, looksLikeCalc } = tokenize(input);
      result.hasOperators = hasOperators;
      if (looksLikeCalc) {
        result.kind = "calc";
        return result;
      }
      const ts = new TokenStream(tokens);
      let ast = parseExpr(ts, 0);
      while (!ts.atEnd()) {
        // Unbalanced ")": keep going, the remainder is AND'ed.
        ast = makeBinary("and", ast, parseExpr(ts, 0));
      }
      const literals = prune(toLiterals(ast));
      if (literals.type == "empty") {
        return result;
      }
      const clauses = simplify(toCNF(toNNF(literals)));
      for (const clause of clauses) {
        const described = [];
        for (const lit of clause) {
          try {
            described.push(describeLiteral(lit));
          } catch (e) {
            if (!(e instanceof ExpressionError)) {
              throw e;
            }
            result.errors.push({ code: e.message, detail: e.detail });
          }
        }
        if (described.length) {
          result.clauses.push(described);
        }
      }
      result.kind = result.clauses.length ? "search" : "empty";
    } catch (e) {
      if (!(e instanceof ExpressionError)) {
        throw e;
      }
      result.errors.push({ code: e.message, detail: e.detail });
      result.kind = "empty";
      result.clauses = [];
    }
    return result;
  }

  /** Strip operators and boolean syntax for a gloda (global) full text search. */
  function toGlodaQuery(input) {
    let s = input.replace(/^\s*g:\s*/, "");
    s = s.replace(new RegExp(`(?:^|\\s|\\()(?:${ALL_TOKEN_NAMES.join("|")}):`, "g"), " ");
    s = s.replace(/(?:^|\s)(?:and|or)(?=\s|$)/g, " ");
    s = s.replace(/[()]/g, " ");
    s = s.replace(/(^|\s)-(?=\S)/g, "$1");
    return s.replace(/\s+/g, " ").trim();
  }

  /** Human readable form of the compiled clauses, used in the help popup. */
  function describeClauses(clauses) {
    return clauses
      .map(clause => {
        const parts = clause.map(t => {
          const v =
            t.valueType == "date"
              ? new Date(t.value / 1000).toLocaleString()
              : String(t.value);
          const name = t.attrib == "Custom" ? t.customId.split("#")[1] : t.attrib;
          return `${name} ${t.op} "${v}"`;
        });
        return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
      })
      .join(" AND ");
  }

  /**
   * Best matching operator for the word the user is typing (for the help
   * popup), e.g. "fr" -> "fromre" candidates.
   *
   * @returns {{best: ?string, matches: string[]}}
   */
  function matchOperator(prefix) {
    const matches = new Set();
    let best = null;
    let bestDistance = Infinity;
    for (const name of TOKEN_MAP.keys()) {
      if (prefix && !name.startsWith(prefix)) {
        continue;
      }
      const canonical = TOKEN_MAP.get(name);
      matches.add(canonical);
      const distance = name.length - prefix.length;
      if (prefix && distance < bestDistance) {
        bestDistance = distance;
        best = canonical;
      }
    }
    return { best, matches: [...matches].sort() };
  }

  /** The operator word around a caret position, without the trailing ':'. */
  function wordAt(text, caret) {
    const before = text.substring(0, caret);
    const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("(")) + 1;
    const word = text.substring(start).replace(/[\s:].*$/s, "");
    return word.replace(/^-/, "");
  }

  /**
   * Quote an arbitrary (untrusted) string so that it is always parsed as a
   * single literal value, never as expression syntax.
   */
  function quote(value) {
    const cleaned = String(value).replace(/["\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
    return `"${cleaned}"`;
  }

  return {
    TOKENS,
    TOKEN_MAP,
    REST_OF_INPUT_TOKENS,
    ExpressionError,
    tokenize,
    compile,
    calculate,
    describeLiteral,
    describeClauses,
    matchOperator,
    wordAt,
    quote,
    parseRegExp,
    parseHeaderRegex,
    parseDate,
    parseTimeOfDay,
    parseAge,
    parseSize,
    parseStatus,
    toGlodaQuery,
  };
});
