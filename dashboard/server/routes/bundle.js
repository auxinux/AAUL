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

router.get("/version", (req, res) => {
  res.json({ version: readVersion() });
});

router.get("/latest.tar.gz", requireAgentAuth, async (req, res) => {
  const bundlePath = path.join(publicDir, "latest.tar.gz");
  if (!fs.existsSync(bundlePath)) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  try {
    const sha256 = await computeFileSha256(bundlePath);
    const agentToken = req.agentAuthToken || req.agent.agent_api_token;
    if (!agentToken) {
      res.status(500).json({ error: "Agent token unavailable" });
      return;
    }
    const signature = signBundleHash(sha256, agentToken);
    res.setHeader("X-Bundle-Sha256", sha256);
    res.setHeader("X-Bundle-Signature", signature);
    res.setHeader("X-Bundle-Version", readVersion());
  } catch {
    res.status(500).json({ error: "Failed to prepare bundle metadata" });
    return;
  }
  res.sendFile(bundlePath);
});

export default router;
