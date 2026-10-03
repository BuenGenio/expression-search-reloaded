// Static checks over src/: manifest, locales and a few security rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = path.join(root, "src");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}
const files = walk(src);
const read = f => fs.readFileSync(f, "utf8");
const textFiles = files.filter(f => /\.(js|mjs|html|css|json)$/.test(f));
const en = JSON.parse(read(path.join(src, "_locales/en/messages.json")));

test("all JSON files parse", () => {
  for (const f of files.filter(f => f.endsWith(".json"))) {
    assert.doesNotThrow(() => JSON.parse(read(f)), f);
  }
});

test("manifest", () => {
  const m = JSON.parse(read(path.join(src, "manifest.json")));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.browser_specific_settings.gecko.id, "expression-search-reloaded@buengenio.github.io");
  assert.ok(!("applications" in m), "deprecated 'applications' key");
  for (const f of [
    ...m.background.scripts,
    m.options_ui.page,
    ...Object.values(m.icons),
    m.experiment_apis.ExpressionSearch.schema,
    m.experiment_apis.ExpressionSearch.parent.script,
  ]) {
    assert.ok(fs.existsSync(path.join(src, f)), `missing ${f}`);
  }
  for (const key of [m.name, m.description]) {
    const msg = /^__MSG_(\w+)__$/.exec(key)?.[1];
    assert.ok(msg in en, `manifest message ${msg}`);
  }
  assert.ok(!m.permissions.some(p => /:\/\//.test(p) || p == "<all_urls>"), "no host permissions");
});

test("every referenced locale key exists in en", () => {
  const keys = new Set();
  for (const f of textFiles) {
    const s = read(f);
    for (const re of [
      /data-i18n="([\w]+)"/g,
      /getMessage\(\s*"([\w]+)"/g,
      /localize\(\s*"([\w]+)"/g,
      /getMessage\(`([\w]+)\$\{/g,
    ]) {
      for (const m of s.matchAll(re)) {
        keys.add(m[1]);
      }
    }
  }
  // Dynamic keys
  const parser = read(path.join(src, "shared/parser.js"));
  const tokens = [...parser.matchAll(/^ {4}(\w+): \[/gm)].map(m => m[1]);
  for (const t of tokens) {
    keys.add(`info_${t}`);
  }
  for (const code of parser.matchAll(/new ExpressionError\("(\w+)"/g)) {
    keys.add(`error_${code[1]}`);
  }
  for (const field of ["from", "recipients", "subject", "tags", "date"]) {
    keys.add(`menuSearchFor_${field}`);
  }
  const missing = [...keys].filter(k => !k.endsWith("_") && !(k in en));
  assert.deepEqual(missing, []);
});

test("locales only contain keys of the default locale", () => {
  for (const dir of fs.readdirSync(path.join(src, "_locales"))) {
    const messages = JSON.parse(read(path.join(src, "_locales", dir, "messages.json")));
    for (const k of Object.keys(messages)) {
      assert.ok(k in en, `${dir}: unknown key ${k}`);
    }
  }
});

test("no inline event handlers or inline scripts in HTML", () => {
  for (const f of files.filter(f => f.endsWith(".html"))) {
    const s = read(f);
    assert.doesNotMatch(s, /\son[a-z]+\s*=/i, `${f}: inline handler`);
    assert.doesNotMatch(s, /<script(?![^>]*\bsrc=)[^>]*>/i, `${f}: inline script`);
    assert.doesNotMatch(s, /<script[^>]+src="https?:/i, `${f}: remote script`);
  }
});

test("no dangerous sinks or network access in code", () => {
  for (const f of files.filter(f => /\.m?js$/.test(f))) {
    const s = read(f);
    assert.doesNotMatch(s, /\beval\(|new Function\(|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(s, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|navigator\.sendBeacon/, f);
    assert.doesNotMatch(s, /ChromeUtils\.import\(|\.jsm"/, `${f}: legacy JSM`);
    assert.doesNotMatch(s, /\.ALLOW_CONTENT_ACCESS|setSubstitutionWithFlags/, `${f}: web-accessible resource substitution`);
  }
});
