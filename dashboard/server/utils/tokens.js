import crypto from "crypto";
import config from "../config.js";

export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function getDataProtectionKey() {
  const raw = String(config.dataProtectionKey || "");
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

export function encryptSecret(value) {
  const plaintext = String(value ?? "");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getDataProtectionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(payload) {
  if (!payload) {
    return null;
  }
  const [version, ivPart, tagPart, encryptedPart] = String(payload).split(":");
  if (version !== "v1" || !ivPart || !tagPart || !encryptedPart) {
    throw new Error("Unsupported encrypted payload");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getDataProtectionKey(),
    Buffer.from(ivPart, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

export function protectToken(token) {
  return {
    hash: hashToken(token),
    encrypted: encryptSecret(token)
  };
}
