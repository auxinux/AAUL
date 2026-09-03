#!/usr/bin/env node
/**
 * Propagate the dashboard version from its single source of truth.
 *
 * THE RULE: `dashboard/VERSION` is the only file a human edits for the
 * dashboard version (`agent/app/VERSION` for the agent). Everything else either
 * reads those files directly or is written by this script.
 *
 * That rule exists because the alternative was tried and failed three times in
 * four releases: the version used to live in eight places, and a bump that
 * missed one shipped an installation reporting "v0.12.4 -> v0.12.4" while the
 * release notes announced 0.13.0, then a footer stuck an entire version behind.
 *
 * Who reads the source directly, and therefore can never drift:
 *
 *   install.sh              reads dashboard/VERSION for its install report
 *   client/vite.config.js   reads dashboard/VERSION, injects __APP_VERSION__
 *   generate-release-md.mjs reads dashboard/VERSION and agent/app/VERSION
 *
 * What this script writes, because npm insists on carrying its own copy:
 *
 *   dashboard/package.json, dashboard/client/package.json
 *   the "version" field of both package-lock.json files
 *
 * Nothing user-facing reads those; they are kept in step for tidiness and so
 * `npm pack` metadata is not misleading.
 *
 * Usage:
 *   node scripts/sync-versions.mjs           rewrite the derived files
 *   node scripts/sync-versions.mjs --check   exit 1 if any of them has drifted
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(dashboardDir, "..");

const SOURCE = "dashboard/VERSION";

// Files carrying a derived copy of the dashboard version. `key` is the path to
// the version field inside the parsed JSON.
const DERIVED = [
  { file: "dashboard/package.json", keys: [["version"]] },
  { file: "dashboard/client/package.json", keys: [["version"]] },
  // A lockfile v3 repeats the project version at the root and in packages[""].
  { file: "dashboard/package-lock.json", keys: [["version"], ["packages", "", "version"]] },
  { file: "dashboard/client/package-lock.json", keys: [["version"], ["packages", "", "version"]] },
];

function readVersion() {
  const full = path.join(repoRoot, SOURCE);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${SOURCE}`);
  }
  const value = fs.readFileSync(full, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid version in ${SOURCE}: "${value}"`);
  }
  return value;
}

function getIn(object, keyPath) {
  return keyPath.reduce((current, key) => (current == null ? current : current[key]), object);
}

function setIn(object, keyPath, value) {
  const parent = getIn(object, keyPath.slice(0, -1));
  if (parent == null) {
    return false;
  }
  parent[keyPath.at(-1)] = value;
  return true;
}

function main() {
  const check = process.argv.includes("--check");
  const version = readVersion();
  const drifted = [];
  let rewritten = 0;

  for (const target of DERIVED) {
    const full = path.join(repoRoot, target.file);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing ${target.file}`);
    }
    const parsed = JSON.parse(fs.readFileSync(full, "utf8"));

    let changed = false;
    for (const keyPath of target.keys) {
      if (getIn(parsed, keyPath) === version) {
        continue;
      }
      drifted.push(`${target.file} (${keyPath.join(".") || "version"}): ${getIn(parsed, keyPath)}`);
      if (setIn(parsed, keyPath, version)) {
        changed = true;
      }
    }

    if (changed && !check) {
      // JSON.stringify preserves key order, so the diff stays limited to the
      // version fields.
      fs.writeFileSync(full, `${JSON.stringify(parsed, null, 2)}\n`);
      rewritten += 1;
    }
  }

  if (check) {
    if (drifted.length > 0) {
      console.error(`sync-versions: ${SOURCE} is ${version} but these have drifted:`);
      drifted.forEach((entry) => console.error(`  ${entry}`));
      console.error("Run: npm run sync:versions");
      process.exit(1);
    }
    console.log(`sync-versions: OK (everything on ${version})`);
    return;
  }

  if (rewritten === 0) {
    console.log(`sync-versions: already on ${version}, nothing to do`);
    return;
  }
  console.log(`sync-versions: ${rewritten} file(s) aligned on ${version}`);
}

main();
