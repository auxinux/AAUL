import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { requireAgentAuth } from "../middleware/auth.js";

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..", "..");
const publicDir = path.join(rootDir, "public", "agent");
const fallbackVersionPath = path.join(rootDir, "..", "agent", "app", "VERSION");

export function readVersion() {
  const publicVersion = path.join(publicDir, "VERSION");
  if (fs.existsSync(publicVersion)) {
    return fs.readFileSync(publicVersion, "utf8").trim();
  }
  if (fs.existsSync(fallbackVersionPath)) {
    return fs.readFileSync(fallbackVersionPath, "utf8").trim();
  }
  return "0.0.0";
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function signBundleHash(bundleSha256, agentApiToken) {
  return crypto
    .createHmac("sha256", agentApiToken)
    .update(bundleSha256)
    .digest("hex");
}

// Serve one agent artifact with the integrity metadata the agent verifies
// before running it: the SHA-256 of the file, plus an HMAC of that hash keyed
// with the requesting agent's own API token. A proxy that can serve bytes still
// cannot serve a payload any agent will accept.
async function sendSignedArtifact(req, res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  try {
    const sha256 = await computeFileSha256(filePath);
    const agentToken = req.agentAuthToken || req.agent.agent_api_token;
    if (!agentToken) {
      res.status(500).json({ error: "Agent token unavailable" });
      return;
    }
    res.setHeader("X-Bundle-Sha256", sha256);
    res.setHeader("X-Bundle-Signature", signBundleHash(sha256, agentToken));
    res.setHeader("X-Bundle-Version", readVersion());
  } catch {
    res.status(500).json({ error: "Failed to prepare bundle metadata" });
    return;
  }
  res.sendFile(filePath);
}

router.get("/version", (req, res) => {
  res.json({ version: readVersion() });
});

// Python agent bundle (Linux and macOS).
router.get("/latest.tar.gz", requireAgentAuth, async (req, res) => {
  await sendSignedArtifact(req, res, path.join(publicDir, "latest.tar.gz"));
});

// Windows agent: a single static Go binary rather than a source bundle, so
// there is no interpreter to install and nothing to extract. Self-update
// downloads it from here (agent/windows/internal/selfupdate).
router.get("/windows/latest.exe", requireAgentAuth, async (req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");
  await sendSignedArtifact(req, res, path.join(publicDir, "windows", "aaul-agent.exe"));
});

export default router;
