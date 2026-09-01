#!/usr/bin/env node
/**
 * Generate RELEASE.md at the repository root.
 *
 * RELEASE.md is what every AAUL installation fetches to learn whether a newer
 * version exists (see server/utils/update-check.js). It must therefore always
 * agree with the versions actually shipped — so it is generated, never edited
 * by hand, from the files that already hold the truth:
 *
 *   dashboard/VERSION                   the published dashboard version
 *   agent/app/VERSION                   the published agent version
 *   client/src/lib/changelog.js         the release notes shown in the app
 *
 * `release.sh` runs this right after it bumps the version files, so the two
 * cannot drift apart.
 *
 * Usage: node scripts/generate-release-md.mjs [--check]
 *   --check  exit 1 if RELEASE.md is out of date instead of rewriting it
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(dashboardDir, "..");

const OUTPUT = path.join(repoRoot, "RELEASE.md");

function readVersionFile(relativePath) {
  const full = path.join(repoRoot, relativePath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing version file: ${relativePath}`);
  }
  const value = fs.readFileSync(full, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Invalid version in ${relativePath}: "${value}"`);
  }
  return value;
}

/** Collapse newlines so one changelog entry stays one Markdown list item. */
function flattenChange(text) {
  return String(text).replace(/\r?\n/g, " ").trim();
}

async function build() {
  const dashboardVersion = readVersionFile("dashboard/VERSION");
  const agentVersion = readVersionFile("agent/app/VERSION");

  const changelogUrl = pathToFileURL(
    path.join(dashboardDir, "client", "src", "lib", "changelog.js")
  );
  const { CHANGELOG } = await import(changelogUrl.href);
  if (!Array.isArray(CHANGELOG) || CHANGELOG.length === 0) {
    throw new Error("CHANGELOG is empty or not an array");
  }

  const releaseDate = CHANGELOG[0].date || new Date().toISOString().slice(0, 10);
  const lines = [];

  // Front matter: the machine-readable part. Gitea renders it as a table, and
  // update-check.js parses it with a simple per-line regex.
  lines.push("---");
  lines.push(`dashboard: ${dashboardVersion}`);
  lines.push(`agent: ${agentVersion}`);
  lines.push(`date: ${releaseDate}`);
  lines.push("---");
  lines.push("");
  lines.push("<!--");
  lines.push("  Fichier GENERE - ne pas modifier a la main.");
  lines.push("  Source : dashboard/client/src/lib/changelog.js + les fichiers VERSION.");
  lines.push("  Regenerer avec :  cd dashboard && npm run gen:release");
  lines.push("-->");
  lines.push("");
  lines.push("# AAUL — Versions publiées");
  lines.push("");
  lines.push(
    "Ce fichier est la référence de version consultée par chaque installation " +
      "AAUL pour savoir si une mise à jour est disponible."
  );
  lines.push("");
  lines.push("| Composant | Version publiée |");
  lines.push("|-----------|-----------------|");
  lines.push(`| Dashboard | \`${dashboardVersion}\` |`);
  lines.push(`| Agent     | \`${agentVersion}\` |`);
  lines.push("");
  lines.push("Pour mettre à jour une installation existante :");
  lines.push("");
  lines.push("```bash");
  lines.push("cd ~/AAUL && git pull && ./install.sh");
  lines.push("```");
  lines.push("");
  lines.push("## Notes de version");
  lines.push("");

  for (const entry of CHANGELOG) {
    const heading = [`### v${entry.version}`, entry.date, entry.title]
      .filter(Boolean)
      .join(" — ");
    lines.push(heading);
    lines.push("");
    for (const change of entry.changes || []) {
      lines.push(`- ${flattenChange(change)}`);
    }
    lines.push("");
  }

  return { content: lines.join("\n"), dashboardVersion, agentVersion };
}

const checkOnly = process.argv.includes("--check");
const { content, dashboardVersion, agentVersion } = await build();

if (checkOnly) {
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  if (existing !== content) {
    console.error(
      "RELEASE.md est desynchronise. Regenerez-le : cd dashboard && npm run gen:release"
    );
    process.exit(1);
  }
  console.log("RELEASE.md est a jour.");
} else {
  fs.writeFileSync(OUTPUT, content, "utf8");
  console.log(`RELEASE.md genere (dashboard ${dashboardVersion}, agent ${agentVersion})`);
}
