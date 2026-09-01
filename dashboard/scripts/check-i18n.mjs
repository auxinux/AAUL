#!/usr/bin/env node
/**
 * Check that every translation key used in the client actually exists.
 *
 * Why this exists: `t("dashboard.stats.updateRequired")` falls back to printing
 * the raw key when it is missing, so the UI shows
 * "DASHBOARD.STATS.UPDATEREQUIRED" to the user. Nothing fails at build time.
 *
 * Rules:
 *   - a key used in the code but absent from `en` is an ERROR (English is the
 *     ultimate fallback in i18n.jsx, so a missing key there is always visible);
 *   - a key present in `en` but missing from another locale is a WARNING (it
 *     degrades to English rather than to a raw key).
 *
 * Usage: node scripts/check-i18n.mjs [clientSrcDir]
 */
import fs from "fs";
import path from "path";

const srcDir = process.argv[2] || path.join(process.cwd(), "client", "src");
const i18nFile = path.join(srcDir, "lib", "i18n.jsx");

if (!fs.existsSync(i18nFile)) {
  console.error(`check-i18n: translation file not found: ${i18nFile}`);
  process.exit(1);
}

// Load the dictionaries by evaluating just the `translations` object literal.
// Parsing it by hand would drift; importing the module would pull in React.
const raw = fs.readFileSync(i18nFile, "utf8");
const start = raw.indexOf("const translations = {");
if (start === -1) {
  console.error("check-i18n: could not locate the translations object");
  process.exit(1);
}
let depth = 0;
let end = -1;
for (let i = raw.indexOf("{", start); i < raw.length; i += 1) {
  if (raw[i] === "{") depth += 1;
  else if (raw[i] === "}") {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
if (end === -1) {
  console.error("check-i18n: could not parse the translations object");
  process.exit(1);
}
// eslint-disable-next-line no-eval
const translations = eval(`(${raw.slice(raw.indexOf("{", start), end)})`);

function flatten(obj, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, full, out);
    else out.add(full);
  }
  return out;
}

const locales = Object.keys(translations);
const keysByLocale = Object.fromEntries(
  locales.map((locale) => [locale, flatten(translations[locale])])
);

// Collect every t("...") used in the client.
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full);
    } else if (/\.jsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
})(srcDir);

const used = new Map(); // key -> [files]
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/\bt\(\s*["']([A-Za-z0-9_.]+)["']/g)) {
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(path.relative(process.cwd(), file));
  }
}

let errors = 0;
for (const [key, where] of [...used].sort()) {
  if (!keysByLocale.en.has(key)) {
    console.error(`MISSING (en): ${key}  <- ${[...new Set(where)].join(", ")}`);
    errors += 1;
  }
}

let warnings = 0;
for (const locale of locales.filter((l) => l !== "en")) {
  for (const key of used.keys()) {
    if (keysByLocale.en.has(key) && !keysByLocale[locale].has(key)) {
      console.warn(`untranslated (${locale}): ${key}`);
      warnings += 1;
    }
  }
}

if (errors > 0) {
  console.error(`\n${errors} key(s) missing from 'en' — these render as raw keys in the UI.`);
  process.exit(1);
}
console.log(
  `check-i18n: OK (${used.size} keys used, ${locales.join("/")})` +
    (warnings ? ` — ${warnings} untranslated key(s), falling back to English` : "")
);
