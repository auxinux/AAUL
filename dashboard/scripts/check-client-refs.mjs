#!/usr/bin/env node
/**
 * Catch undefined component / icon references in the React client.
 *
 * Why this exists: `vite build` succeeds on code that references a variable
 * which was never imported. The failure only shows up in the browser, as a
 * `ReferenceError: Can't find variable: X`, and it blanks the whole page — a
 * missing `Cpu` import in the fleet-health panel took the dashboard down in
 * production even though the build was green.
 *
 * The check is deliberately narrow: it only looks at identifiers used as JSX
 * elements (`<Foo ...>`) or passed as an icon prop (`icon={Foo}`), because
 * those are unambiguous. It is a safety net for the mistake that actually
 * happens, not a replacement for a full linter.
 *
 * Usage: node scripts/check-client-refs.mjs [srcDir]
 * Exit code 1 if any problem is found.
 */
import fs from "fs";
import path from "path";

const root = process.argv[2] || path.join(process.cwd(), "client", "src");

if (!fs.existsSync(root)) {
  console.error(`check-client-refs: directory not found: ${root}`);
  process.exit(1);
}

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
})(root);

// Names that are always available or handled by the JSX runtime.
const ALWAYS_DEFINED = new Set(["React", "Fragment"]);

function collectDeclared(src) {
  const declared = new Set();

  // import Default, { Named, Aliased as Local } from "..."
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s*["'][^"']+["']/g)) {
    for (const part of m[1].replace(/[{}]/g, ",").split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && /^[A-Za-z_$]/.test(name)) declared.add(name);
    }
  }
  // const Foo = ..., function Foo(), class Foo
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Za-z0-9_$]*)/g)) {
    declared.add(m[1]);
  }
  // Destructuring / object shorthand renames: { icon: Icon }
  for (const m of src.matchAll(/([A-Za-z]+)\s*:\s*([A-Z][A-Za-z0-9_$]*)/g)) {
    declared.add(m[2]);
  }
  // Capitalized parameters of arrow functions and function declarations.
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[=:\s]/)[0];
      if (/^[A-Z][A-Za-z0-9_$]*$/.test(name)) declared.add(name);
    }
  }
  return declared;
}

function collectUsed(src) {
  const used = new Map();
  for (const m of src.matchAll(/<([A-Z][A-Za-z0-9_$]*)/g)) {
    used.set(m[1], "JSX element");
  }
  for (const m of src.matchAll(/icon=\{([A-Z][A-Za-z0-9_$]*)\}/g)) {
    used.set(m[1], "icon prop");
  }
  return used;
}

let problems = 0;
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const declared = collectDeclared(src);
  for (const [name, kind] of collectUsed(src)) {
    if (declared.has(name) || ALWAYS_DEFINED.has(name)) continue;
    const rel = path.relative(process.cwd(), file);
    console.error(`${rel}: '${name}' is used as a ${kind} but never imported or declared`);
    problems += 1;
  }
}

if (problems > 0) {
  console.error(
    `\n${problems} undefined reference(s). These build fine but crash the page at runtime.`
  );
  process.exit(1);
}
console.log(`check-client-refs: OK (${files.length} files, no undefined references)`);
