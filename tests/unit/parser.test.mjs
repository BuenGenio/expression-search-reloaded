import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../../src/shared/parser.js");

/** Compact representation of the compiled clauses for assertions. */
function cnf(input) {
  const r = P.compile(input);
  return r.clauses.map(clause =>
    clause.map(t => {
      const name = t.attrib == "Custom" ? t.customId.split("#")[1] : t.attrib;
      return `${name} ${t.op} ${t.tag ?? t.value}`;
    })
  );
}

test("empty and whitespace input", () => {
  assert.equal(P.compile("").kind, "empty");
  assert.equal(P.compile("   ").kind, "empty");
  assert.equal(P.compile(null).kind, "empty");
});

test("bare words search from/to/subject as one phrase", () => {
  assert.deepEqual(cnf("hello world"), [
    ["Sender Contains hello world", "ToOrCC Contains hello world", "Subject Contains hello world"],
  ]);
  assert.equal(P.compile("hello").hasOperators, false);
});

test("operators and aliases", () => {
  assert.deepEqual(cnf("from:fred to:tom"), [["Sender Contains fred"], ["ToOrCC Contains tom"]]);
  assert.deepEqual(cnf("f:fred t:tom"), cnf("from:fred to:tom"));
  assert.equal(P.compile("f:fred").hasOperators, true);
  assert.deepEqual(cnf("tn:a"), [["To Contains a"]]);
  assert.deepEqual(cnf("c:a"), [["CC Contains a"]]);
  assert.deepEqual(cnf("ft:a"), [["AllAddresses Contains a"]]);
  assert.deepEqual(cnf("b:a"), [["Body Contains a"]]);
  assert.deepEqual(cnf("bc:x"), [["Bcc Contains x"]]);
  assert.deepEqual(cnf("o:tom"), [["toSomebodyOnly Contains tom"]]);
});

test("operators are case sensitive so 'Re:' stays text", () => {
  assert.equal(P.compile("Re: meeting").hasOperators, false);
  assert.deepEqual(cnf("Re: meeting")[0][2], "Subject Contains Re: meeting");
});

test("grouping, negation and OR (documented example)", () => {
  // "s:bbb t:(oo -pp)": subject bbb, sent to oo but not to pp
  assert.deepEqual(cnf("s:bbb t:(oo -pp)"), [
    ["Subject Contains bbb"],
    ["ToOrCC Contains oo"],
    ["ToOrCC DoesntContain pp"],
  ]);
  assert.deepEqual(cnf("from:(alice or bob)"), [["Sender Contains alice", "Sender Contains bob"]]);
  assert.deepEqual(cnf("f:-spam"), [["Sender DoesntContain spam"]]);
  assert.deepEqual(cnf("-f:spam"), [["Sender DoesntContain spam"]]);
});

test("De Morgan and CNF distribution are complete", () => {
  // -(a or b) => -a and -b
  assert.deepEqual(cnf("-(f:a or f:b)"), [["Sender DoesntContain a"], ["Sender DoesntContain b"]]);
  // (a and b) or c => (a or c) and (b or c)
  assert.deepEqual(cnf("(f:a f:b) or s:c"), [
    ["Sender Contains a", "Subject Contains c"],
    ["Sender Contains b", "Subject Contains c"],
  ]);
  // Nested case that the old single-pass distribution left un-normalised:
  // ((a and b) or c) or d
  const clauses = cnf("((f:a f:b) or s:c) or t:d");
  assert.equal(clauses.length, 2);
  for (const clause of clauses) {
    assert.equal(clause.length, 3);
  }
});

test("every clause is a flat OR group (TB grouping model)", () => {
  const r = P.compile("(f:a or (t:b s:c)) -(b:d or f:e)");
  for (const clause of r.clauses) {
    assert.ok(clause.length >= 1);
  }
  assert.equal(r.kind, "search");
  assert.deepEqual(r.errors, []);
});

test("explosive expressions are rejected instead of hanging", () => {
  const big = Array.from({ length: 12 }, (_, i) => `(f:a${i} f:b${i})`).join(" or ");
  const r = P.compile(big);
  assert.equal(r.kind, "empty");
  assert.equal(r.errors[0].code, "tooComplex");
});

test("incomplete input while typing is ignored", () => {
  assert.deepEqual(cnf("f:fred t:"), [["Sender Contains fred"]]);
  assert.deepEqual(cnf("f:fred and"), [["Sender Contains fred"]]);
  assert.deepEqual(cnf("f:fred or"), [["Sender Contains fred"]]);
  assert.deepEqual(cnf("f: t:bob"), [["ToOrCC Contains bob"]]);
  assert.deepEqual(cnf("(f:) s:x"), [["Subject Contains x"]]);
  assert.equal(P.compile("f:").kind, "empty");
  assert.equal(P.compile("-f:").kind, "empty");
});

test("quoted strings are literal", () => {
  assert.deepEqual(cnf('s:"a or b"'), [["Subject Contains a or b"]]);
  assert.deepEqual(cnf('f:"x) or t:(y"'), [["Sender Contains x) or t:(y"]]);
  assert.deepEqual(cnf('s:"unterminated'), [["Subject Contains unterminated"]]);
});

test("rest-of-input operators take the remainder verbatim", () => {
  assert.deepEqual(cnf("f:me regex:^a (b|c) and d$"), [
    ["Sender Contains me"],
    ["subjectRegex Matches ^a (b|c) and d$"],
  ]);
  assert.deepEqual(cnf("simple:hello (world)"), [["subjectSimple Contains hello (world)"]]);
  assert.deepEqual(cnf("-bodyre:/x/i"), [["bodyRegex DoesntMatch /x/i"]]);
});

test("regex negation uses Matches/DoesntMatch for every regex operator", () => {
  // In 2.4beta -fromre/-tore used DoesntContain and were never negated.
  assert.deepEqual(cnf("-fromre:^a"), [["fromRegex DoesntMatch ^a"]]);
  assert.deepEqual(cnf("-tore:^a"), [["toRegex DoesntMatch ^a"]]);
  assert.deepEqual(cnf("-h:list-id"), [["headerRegex DoesntMatch list-id"]]);
});

test("invalid regex is reported", () => {
  const r = P.compile("regex:/a(/");
  assert.equal(r.errors[0].code, "badRegex");
  assert.equal(r.kind, "empty");
});

test("header regex validation", () => {
  assert.deepEqual(P.parseHeaderRegex("List-Id=/all-test/i"), { header: "list-id", regex: "/all-test/i" });
  assert.deepEqual(P.parseHeaderRegex("X-Foo"), { header: "x-foo", regex: null });
  assert.throws(() => P.parseHeaderRegex("=x"), /badHeader/);
});

test("attachment", () => {
  assert.deepEqual(cnf("a:yes"), [["HasAttachmentStatus Is Attachment"]]);
  assert.deepEqual(cnf("a:no"), [["HasAttachmentStatus Isnt Attachment"]]);
  assert.deepEqual(cnf("-a:y"), [["HasAttachmentStatus Isnt Attachment"]]);
  assert.deepEqual(cnf("-a:n"), [["HasAttachmentStatus Is Attachment"]]);
  // anything else is an attachment name/type search
  assert.deepEqual(cnf("a:pdf"), [["attachmentNameOrType Contains pdf"]]);
  assert.deepEqual(cnf("-fi:pdf"), [["attachmentNameOrType DoesntContain pdf"]]);
});

test("status", () => {
  assert.deepEqual(cnf("is:unread"), [["MsgStatus Isnt Read"]]);
  assert.deepEqual(cnf("-is:unread"), [["MsgStatus Is Read"]]);
  assert.deepEqual(cnf("is:replied"), [["MsgStatus Is Replied"]]);
  assert.deepEqual(cnf("is:read"), [["MsgStatus Is Read"]]);
  assert.deepEqual(cnf("is:starred"), [["MsgStatus Is Marked"]]);
  assert.deepEqual(cnf("is:flagged"), [["MsgStatus Is Marked"]]);
  assert.deepEqual(cnf("is:F"), [["MsgStatus Is Forwarded"]]);
  assert.deepEqual(cnf("u:new"), [["MsgStatus Is New"]]);
  assert.deepEqual(cnf("i:deleted"), [["MsgStatus Is IMAPDeleted"]]);
  assert.equal(P.compile("is:bogus").errors[0].code, "badStatus");
  // #5: unreplied (and the other "un-" states)
  assert.deepEqual(cnf("is:unreplied"), [["MsgStatus Isnt Replied"]]);
  assert.deepEqual(cnf("status:unreplied"), [["MsgStatus Isnt Replied"]]);
  assert.deepEqual(cnf("-is:unreplied"), [["MsgStatus Is Replied"]]);
  assert.deepEqual(cnf("is:unstarred"), [["MsgStatus Isnt Marked"]]);
  assert.deepEqual(cnf("is:unflagged"), [["MsgStatus Isnt Marked"]]);
  assert.deepEqual(cnf("is:unread"), [["MsgStatus Isnt Read"]]);
});

test("size", () => {
  assert.deepEqual(cnf("size:10"), [["Size IsGreaterThan 10"]]);
  assert.deepEqual(cnf("larger:1.4M"), [["Size IsGreaterThan 1434"]]);
  assert.deepEqual(cnf("sm:1G"), [["Size IsLessThan 1048576"]]);
  assert.deepEqual(cnf("-size:2m"), [["Size IsLessThan 2048"]]);
  assert.equal(P.compile("size:big").errors[0].code, "badSize");
});

test("age (older_than/newer_than), including the 'y' unit that 2.4beta broke", () => {
  assert.deepEqual(cnf("days:3"), [["AgeInDays IsGreaterThan 3"]]);
  assert.deepEqual(cnf("older_than:2w"), [["AgeInDays IsGreaterThan 14"]]);
  assert.deepEqual(cnf("n:7"), [["AgeInDays IsLessThan 7"]]);
  assert.deepEqual(cnf("days:today"), [["AgeInDays IsLessThan 1"]]);
  assert.deepEqual(cnf("days:yesterday"), [["AgeInDays IsLessThan 2"]]);
  assert.deepEqual(cnf("-days:3"), [["AgeInDays IsLessThan 3"]]);
  assert.deepEqual(cnf("nt:1y"), [["AgeInDays IsLessThan 365.2425"]]);
  assert.deepEqual(cnf("nt:2year"), [["AgeInDays IsLessThan 730.485"]]);
  assert.equal(P.compile("days:3fortnights").errors[0].code, "badAge");
});

test("dates are local time and validated", () => {
  const r = P.compile("before:2011/03/09");
  const t = r.clauses[0][0];
  assert.equal(t.attrib, "Date");
  assert.equal(t.op, "IsBefore");
  assert.equal(t.value, new Date(2011, 2, 9).getTime() * 1000);
  // ISO-ish dates are local time too (Date.parse would use UTC)
  assert.equal(P.compile("af:2011-03-09").clauses[0][0].value, new Date(2011, 2, 9).getTime() * 1000);
  // Day granularity: "not before Mar 9" == "after Mar 8"; "not after Mar 9" == "before Mar 10"
  const nb = P.compile("-before:2011/03/09").clauses[0][0];
  assert.equal(nb.op, "IsAfter");
  assert.equal(nb.value, new Date(2011, 2, 8).getTime() * 1000);
  const na = P.compile("-after:2011/03/09").clauses[0][0];
  assert.equal(na.op, "IsBefore");
  assert.equal(na.value, new Date(2011, 2, 10).getTime() * 1000);
  // Month boundary
  assert.equal(P.compile("-after:2011/02/28").clauses[0][0].value, new Date(2011, 2, 1).getTime() * 1000);
  assert.equal(P.compile("after:2011/02/30").errors[0].code, "badDate");
  assert.equal(P.compile("after:Mon, 25 Dec 1995 13:30:00 GMT").clauses[0][0].value, Date.UTC(1995, 11, 25, 13, 30) * 1000);
});

test("time of day uses the dayTime term (documented 'between 3 and 4' example)", () => {
  assert.deepEqual(cnf("af:(3:0 -4:0)"), [["dayTime IsAfter 03:00:00"], ["dayTime IsBefore 04:00:00"]]);
  assert.equal(P.compile("before:25:00").errors[0].code, "badTime");
});

test("account operator (#6)", () => {
  assert.deepEqual(cnf("acc:work"), [["account Contains work"]]);
  assert.deepEqual(cnf("account:work"), [["account Contains work"]]);
  assert.deepEqual(cnf("-acc:work f:bob"), [["account DoesntContain work"], ["Sender Contains bob"]]);
  assert.deepEqual(cnf("acc:(work or private)"), [["account Contains work", "account Contains private"]]);
  assert.equal(P.compile("acc:work").hasOperators, true);
});

test("date match and tags", () => {
  assert.deepEqual(cnf("date:2011/01"), [["dateMatch Contains 2011/01"]]);
  assert.deepEqual(cnf("-date:2011/01"), [["dateMatch DoesntContain 2011/01"]]);
  assert.deepEqual(cnf("tag:Important"), [["Keywords Contains Important"]]);
  assert.deepEqual(cnf("tag:na"), [["Keywords IsEmpty "]]);
  assert.deepEqual(cnf("-tag:NA"), [["Keywords IsntEmpty "]]);
  assert.deepEqual(cnf('tag:("To Do")'), [["Keywords Contains To Do"]]);
});

test("all: also searches the body, slow terms are evaluated last", () => {
  assert.deepEqual(cnf("all:x"), [
    ["Sender Contains x", "ToOrCC Contains x", "Subject Contains x", "Body Contains x"],
  ]);
  const order = cnf("b:x f:y");
  assert.deepEqual(order, [["Sender Contains y"], ["Body Contains x"]]);
});

test("the 'si' alias means size, as documented (2.4beta silently used simple)", () => {
  assert.deepEqual(cnf("si:(0.5M -2M)"), [["Size IsGreaterThan 512"], ["Size IsLessThan 2048"]]);
});

test("gloda prefix", () => {
  const r = P.compile("g: f:fred (hello or world) -spam");
  assert.equal(r.kind, "gloda");
  assert.equal(r.glodaQuery, "fred hello world spam");
  // "g:" in the middle of an expression is ignored, not an error
  assert.deepEqual(cnf("f:a g:b"), [["Sender Contains a"]]);
});

test("calculator", () => {
  assert.equal(P.compile("1+2*3").kind, "calc");
  assert.equal(P.compile("f:1+2").kind, "search");
  assert.equal(P.calculate("1+2*3").value, 7);
  assert.equal(P.calculate("(1+2)*3").value, 9);
  // unary minus was a ReferenceError in 2.4beta
  assert.equal(P.calculate("-3*2").value, -6);
  assert.equal(P.calculate("10/4 = 99").text, "10/4 = 2.5");
  assert.throws(() => P.calculate("1+"), /badNumber/);
});

test("unbalanced parentheses do not throw", () => {
  assert.equal(P.compile("f:(a or b").kind, "search");
  assert.equal(P.compile("f:a) s:b").clauses.length, 2);
  assert.equal(P.compile(")))").kind, "empty");
  assert.equal(P.compile("((((").kind, "empty");
});

test("deep nesting is rejected", () => {
  const r = P.compile("(".repeat(100) + "a");
  assert.equal(r.errors[0].code, "tooDeep");
});

test("quote() makes untrusted values inert", () => {
  const evil = 'x" or bodyre:(a+)+$ "';
  const r = P.compile(`f:${P.quote(evil)}`);
  assert.equal(r.clauses.length, 1);
  assert.equal(r.clauses[0].length, 1);
  assert.equal(r.clauses[0][0].attrib, "Sender");
  assert.equal(r.clauses[0][0].value, "x or bodyre:(a+)+$");
});

test("operator help matching", () => {
  assert.equal(P.matchOperator("fr").best, "fromre");
  assert.equal(P.matchOperator("f").best, "from");
  assert.ok(P.matchOperator("f").matches.includes("filename"));
  assert.equal(P.matchOperator("").best, null);
  assert.equal(P.wordAt("s:abc fro", 9), "fro");
  assert.equal(P.wordAt("(-from:x", 3), "from");
});

test("fuzz: compile never throws on arbitrary input", () => {
  const alphabet = ['f', ':', '(', ')', '-', '"', ' ', 'a', 'or', 'and', 're:', 'is:', '/', '*', '1', 'tag:', 'b:'];
  let seed = 42;
  const rand = n => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 5000; i++) {
    let s = "";
    const len = rand(20);
    for (let j = 0; j < len; j++) {
      s += alphabet[rand(alphabet.length)];
    }
    const r = P.compile(s);
    assert.ok(["empty", "search", "calc", "gloda"].includes(r.kind), s);
    if (r.kind == "calc") {
      try {
        P.calculate(s);
      } catch (e) {
        assert.equal(e.name, "ExpressionError", s);
      }
    }
  }
});
