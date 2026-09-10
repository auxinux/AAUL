// Endpoints for managing plugins from the dashboard UI: list, enable,
// disable, install from a .pg package, and delete.

import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";
import multer from "multer";
import { fileURLToPath } from "url";
import { requireAdmin, requireSystemAdmin } from "../middleware/auth.js";
import pluginLoader from "../plugins/plugin-loader.js";

const router = express.Router();

const upload = multer({
  dest: path.join(os.tmpdir(), "aaul-plugin-uploads"),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

function scheduleRestart() {
  setTimeout(() => {
    console.log("[Plugins] Restarting server to apply plugin changes...");
    process.exit(0);
  }, 500);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function getPluginsDir() {
  return path.join(__dirname, "..", "plugins");
}

function isSafeZipEntry(entry) {
  const entryName = typeof entry === "string" ? entry : entry?.entryName;
  if (!entryName || typeof entryName !== "string") return false;
  if (entryName.includes("..")) return false;
  if (entryName.startsWith("/") || entryName.startsWith("\\")) return false;
  // SECURITY: Block symlinks in ZIP to prevent arbitrary file read/write
  if (typeof entry === "object" && entry !== null) {
    const attr = entry.header?.attr || 0;
    const isSymlink = (attr >>> 28) === 0xA;
    if (isSymlink) return false;
  }
  return true;
}

/**
 * GET /api/plugins
 * List all discovered plugins with their status
 */
router.get("/", requireAdmin, requireSystemAdmin, async (req, res) => {
  try {
    const plugins = await pluginLoader.getAllPlugins();
    res.json({ ok: true, plugins });
  } catch (err) {
    console.error("Failed to list plugins:", err);
    res.status(500).json({ error: "Failed to list plugins" });
  }
});

/**
 * POST /api/plugins/:name/enable
 * Enable a plugin
 */
router.post("/:name/enable", requireAdmin, requireSystemAdmin, async (req, res) => {
  const { name } = req.params;
  
  try {
    const app = req.app;
    const success = await pluginLoader.enablePlugin(name, app);
    
    if (success) {
      res.json({ ok: true, message: `Plugin ${name} enabled. Restarting server...` });
      scheduleRestart();
      return;
    } else {
      res.status(400).json({ error: `Failed to enable plugin ${name}` });
    }
  } catch (err) {
    console.error(`Failed to enable plugin ${name}:`, err);
    res.status(500).json({ error: "Failed to enable plugin" });
  }
});

/**
 * POST /api/plugins/:name/disable
 * Disable a plugin
 */
router.post("/:name/disable", requireAdmin, requireSystemAdmin, async (req, res) => {
  const { name } = req.params;
  
  try {
    const success = await pluginLoader.disablePlugin(name);
    
    if (success) {
      res.json({ ok: true, message: `Plugin ${name} disabled. Restarting server...` });
      scheduleRestart();
      return;
    } else {
      res.status(400).json({ error: `Failed to disable plugin ${name}` });
    }
  } catch (err) {
    console.error(`Failed to disable plugin ${name}:`, err);
    res.status(500).json({ error: "Failed to disable plugin" });
  }
});

/**
 * POST /api/plugins/install
 * Install a plugin from a .pg package (zip)
 */
router.post("/install", requireAdmin, requireSystemAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Missing plugin file" });
    return;
  }

  const filePath = req.file.path;
  const originalName = req.file.originalname || "";
  const ext = path.extname(originalName).toLowerCase();

  if (ext !== ".pg") {
    res.status(400).json({ error: "Invalid plugin file. Expected .pg" });
    return;
  }

  const pluginsDir = getPluginsDir();
  const extractDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aaul-plugin-"));

  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (!isSafeZipEntry(entry)) {
        res.status(400).json({ error: "Invalid plugin package structure" });
        return;
      }
    }

    zip.extractAllTo(extractDir, true);

    let pluginRoot = extractDir;
    const rootPackage = path.join(extractDir, "package.json");
    if (!fs.existsSync(rootPackage)) {
      const entries = await fs.promises.readdir(extractDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length === 1) {
        const candidate = path.join(extractDir, dirs[0].name);
        if (fs.existsSync(path.join(candidate, "package.json"))) {
          pluginRoot = candidate;
        }
      }
    }

    const pkgPath = path.join(pluginRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      res.status(400).json({ error: "Plugin package.json not found" });
      return;
    }

    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, "utf8"));
    const pluginName = pkg.name;

    if (!pluginName || /[\\/]/.test(pluginName)) {
      res.status(400).json({ error: "Invalid plugin name" });
      return;
    }

    const targetDir = path.join(pluginsDir, pluginName);
    if (fs.existsSync(targetDir)) {
      res.status(409).json({ error: "Plugin already exists" });
      return;
    }

    await fs.promises.cp(pluginRoot, targetDir, { recursive: true });

    res.json({ ok: true, plugin: pluginName, message: `Plugin ${pluginName} installed. Restarting server...` });
    scheduleRestart();
  } catch (err) {
    console.error("Failed to install plugin:", err);
    res.status(500).json({ error: "Failed to install plugin" });
  } finally {
    try {
      await fs.promises.rm(extractDir, { recursive: true, force: true });
    } catch {}
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch {}
  }
});

/**
 * DELETE /api/plugins/:name
 * Delete a plugin (non-system only)
 */
router.delete("/:name", requireAdmin, requireSystemAdmin, async (req, res) => {
  const { name } = req.params;

  try {
    const plugins = await pluginLoader.discoverPlugins();
    const plugin = plugins.find((p) => p.name === name);

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    if (plugin.system) {
      res.status(403).json({ error: "System plugins cannot be deleted" });
      return;
    }

    await pluginLoader.disablePlugin(name);

    if (fs.existsSync(plugin.path)) {
      await fs.promises.rm(plugin.path, { recursive: true, force: true });
    }

    res.json({ ok: true, message: `Plugin ${name} deleted. Restarting server...` });
    scheduleRestart();
  } catch (err) {
    console.error(`Failed to delete plugin ${name}:`, err);
    res.status(500).json({ error: "Failed to delete plugin" });
  }
});

/**
 * GET /api/plugins/ui/:slot
 * Get UI components registered for a specific slot
 */
router.get("/ui/:slot", requireAdmin, requireSystemAdmin, (req, res) => {
  const { slot } = req.params;
  const components = pluginLoader.getUIComponents(slot);
  res.json({ ok: true, components });
});

/**
 * GET /api/plugins/:name
 * Get details about a specific plugin
 */
router.get("/:name", requireAdmin, requireSystemAdmin, async (req, res) => {
  const { name } = req.params;
  
  try {
    const plugins = await pluginLoader.getAllPlugins();
    const plugin = plugins.find((p) => p.name === name);
    
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    
    res.json({ ok: true, plugin });
  } catch (err) {
    console.error(`Failed to get plugin ${name}:`, err);
    res.status(500).json({ error: "Failed to get plugin details" });
  }
});

export default router;
