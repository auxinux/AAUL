#!/usr/bin/env node
/**
 * Sanity-check the generated installer scripts.
 *
 * The Windows installer is the fragile one. Windows PowerShell 5.1 reads a .ps1
 * without a byte-order mark as ANSI (Windows-1252), so a single non-ASCII
 * character decodes to mojibake — and some of those bytes are typographic
 * quotes, which PowerShell accepts as string delimiters. One accented word was
 * enough to open a string that never closed and make the whole file
 * unparseable, with errors pointing 130 lines away from the real cause.
 *
 * We serve a BOM now, but the script is also kept pure ASCII so it survives
 * being saved or proxied by something that drops it.
 *
 * Usage: node scripts/check-install-scripts.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(dashboardDir, "server", "routes", "install.js"),
  "utf8"
);

// Isolate the Windows builder: everything from its declaration to the closing
// backtick of its template literal.
const start = source.indexOf("function buildWindowsScript");
if (start === -1) {
  console.error("check-install-scripts: buildWindowsScript not found");
  process.exit(1);
}
const templateStart = source.indexOf("`", start);
const templateEnd = source.indexOf("\n`;", templateStart);
if (templateStart === -1 || templateEnd === -1) {
  console.error("check-install-scripts: could not delimit the PowerShell template");
  process.exit(1);
}
const template = source.slice(templateStart + 1, templateEnd);

let problems = 0;

// 1. Pure ASCII.
const lines = template.split("\n");
lines.forEach((line, index) => {
  // eslint-disable-next-line no-control-regex
  const match = line.match(/[^\x00-\x7F]/g);
  if (match) {
    console.error(
      `install.js (PowerShell, line ${index + 1}): non-ASCII ${JSON.stringify(
        [...new Set(match)].join("")
      )} — Windows PowerShell 5.1 will mis-decode this`
    );
    console.error(`  ${line.trim().slice(0, 100)}`);
    problems += 1;
  }
});

// 2. A trailing space after a line-continuation backtick silently breaks it.
lines.forEach((line, index) => {
  if (/`[ \t]+$/.test(line)) {
    console.error(
      `install.js (PowerShell, line ${index + 1}): whitespace after a line-continuation backtick`
    );
    problems += 1;
  }
});

// 3. Here-string terminators must sit at column 0.
lines.forEach((line, index) => {
  if (/^\s+['"]@\s*$/.test(line)) {
    console.error(
      `install.js (PowerShell, line ${index + 1}): here-string terminator must start at column 0`
    );
    problems += 1;
  }
});

// 4. An external call inside a function must not leak into its return value.
//    PowerShell functions return EVERYTHING written to the output stream, so an
//    uncaptured `& something` makes the function hand back that program's text
//    alongside -- or instead of -- the intended value. This shipped once
//    already: Get-PythonCommand returned winget's install report, not a path.
let insideFunction = false;
let depth = 0;
lines.forEach((line, index) => {
  const trimmed = line.trim();
  if (/^function\s+[A-Za-z-]+/.test(trimmed)) {
    insideFunction = true;
    depth = 0;
  }
  if (insideFunction) {
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
  }

  if (insideFunction && /^&\s*[$"']/.test(trimmed)) {
    const captured =
      /\|\s*Out-Null/.test(line) ||
      /\|\s*Out-String/.test(line) ||
      /^\$\w+\s*=/.test(trimmed);
    if (!captured) {
      console.error(
        `install.js (PowerShell, line ${index + 1}): uncaptured external call inside a function`
      );
      console.error(`  ${trimmed.slice(0, 100)}`);
      console.error(
        "  assign it to a variable or pipe it to Out-Null, or it leaks into the return value"
      );
      problems += 1;
    }
  }

  if (insideFunction && depth <= 0 && /\}/.test(line)) {
    insideFunction = false;
  }
});

if (problems > 0) {
  console.error(`\n${problems} problem(s) in the generated Windows installer.`);
  process.exit(1);
}
console.log(`check-install-scripts: OK (${lines.length} PowerShell lines, pure ASCII)`);
