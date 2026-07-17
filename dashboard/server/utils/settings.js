import { dbOps } from "../db/index.js";

export async function getSettings() {
  const rows = await dbOps.all("SELECT key, value FROM settings");
  const settings = {};
  rows.forEach((row) => {
    settings[row.key] = row.value;
  });
  return settings;
}

export async function getSetting(key) {
  const row = await dbOps.get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  await dbOps.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

export async function setSettings(values) {
  const entries = Object.entries(values);
  for (const [key, value] of entries) {
    await setSetting(key, value);
  }
}