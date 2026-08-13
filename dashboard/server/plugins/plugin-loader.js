// Discovery, validation, loading, and lifecycle management of plugins.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dbOps } from "../db/index.js";
import config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const loadedPlugins = new Map();
const hooks = new Map();
const pluginRoutes = [];
const uiComponents = [];
// AAUL-Cloud: points d'extension génériques (migrations, filtres, session)
const pluginMigrations = new Map();   // pluginName -> [ {up, down} ]
const agentFilters = [];              // [{ plugin, filter }]
const sessionEnrichers = [];          // [{ plugin, enricher }]

const VALID_HOOKS = new Set([
  "agent:poll",
  "agent:registered",
  "agent:command:queued",
  "agent:command:complete",
  "agent:uninstalled",
  "server:start",
  "server:ready",
  "server:stop",
  "settings:changed"
]);

const VALID_PERMISSIONS = new Set([
  "agents:read",
  "agents:write",
  "settings:read",
  "settings:write",
  "users:read",
  "users:write",
  "plugins:manage"
]);

function validatePluginPackage(pkg) {
  const errors = [];

  if (!pkg.name || typeof pkg.name !== "string") {
    errors.push("Missing or invalid 'name' field");
  }

  if (!pkg.version || typeof pkg.version !== "string") {
    errors.push("Missing or invalid 'version' field");
  }

  if (!pkg.main || typeof pkg.main !== "string") {
    errors.push("Missing or invalid 'main' field");
  }

  if (pkg.aaul) {
    if (pkg.aaul.permissions && Array.isArray(pkg.aaul.permissions)) {
      for (const perm of pkg.aaul.permissions) {
        if (!VALID_PERMISSIONS.has(perm)) {
          errors.push(`Invalid permission: ${perm}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Context object handed to a plugin's onLoad(), exposing the app, db,
// sanitized config, and registration helpers.
function createPluginContext(app, pluginMeta) {
  return {
    app,
    db: dbOps,
    config: { ...config, sessionSecret: undefined },

    registerRoute(routePath, options) {
      const { method = "GET", handler, middleware = [] } = options;
      pluginRoutes.push({
        plugin: pluginMeta.name,
        path: routePath,
        method: method.toUpperCase(),
        handler,
        middleware
      });
    },

    registerHook(hookName, callback) {
      if (!VALID_HOOKS.has(hookName)) {
        console.warn(`[Plugin:${pluginMeta.name}] Invalid hook: ${hookName}`);
        return;
      }
      if (!hooks.has(hookName)) {
        hooks.set(hookName, []);
      }
      hooks.get(hookName).push({
        plugin: pluginMeta.name,
        callback
      });
    },

    registerUI(slot, component) {
      uiComponents.push({
        plugin: pluginMeta.name,
        slot,
        ...component
      });
    },

    // AAUL-Cloud: enregistre une migration DB (up/down) pour ce plugin.
    // up  -> exécuté à l'installation/activation (création tables/colonnes)
    // down-> exécuté uniquement à la purge (suppression explicite des données)
    registerMigration(migration) {
      if (!migration || typeof migration.up !== "function") {
        console.warn(`[Plugin:${pluginMeta.name}] Invalid migration (missing 'up')`);
        return;
      }
      if (!pluginMigrations.has(pluginMeta.name)) {
        pluginMigrations.set(pluginMeta.name, []);
      }
      pluginMigrations.get(pluginMeta.name).push({
        up: migration.up,
        down: typeof migration.down === "function" ? migration.down : null
      });
    },

    // AAUL-Cloud: enregistre un filtre d'agents. Retourne false pour exclure
    // un agent des routes agents du cœur (GET /api/agents, pending, history, :id).
    registerAgentFilter(filter) {
      if (typeof filter !== "function") {
        console.warn(`[Plugin:${pluginMeta.name}] Invalid agent filter`);
        return;
      }
      agentFilters.push({ plugin: pluginMeta.name, filter });
    },

    // AAUL-Cloud: enregistre un enrichisseur de session. Reçoit l'objet user
    // (req.session.user / req.user) et peut y ajouter des champs (ex: clientId).
    registerSessionEnricher(enricher) {
      if (typeof enricher !== "function") {
        console.warn(`[Plugin:${pluginMeta.name}] Invalid session enricher`);
        return;
      }
      sessionEnrichers.push({ plugin: pluginMeta.name, enricher });
    },

    log(level, message) {
      const prefix = `[Plugin:${pluginMeta.name}]`;
      if (level === "error") {
        console.error(prefix, message);
      } else if (level === "warn") {
        console.warn(prefix, message);
      } else {
        console.log(prefix, message);
      }
    }
  };
}

export async function discoverPlugins() {
  const plugins = [];
  const pluginsDir = __dirname;

  try {
    const entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const pluginDir = path.join(pluginsDir, entry.name);
      const packagePath = path.join(pluginDir, "package.json");

      if (!fs.existsSync(packagePath)) {
        continue;
      }

      try {
        const pkg = JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
        const validation = validatePluginPackage(pkg);

        plugins.push({
          name: pkg.name,
          version: pkg.version,
          displayName: pkg.aaul?.displayName || pkg.name,
          description: pkg.description || "",
          author: pkg.author || "Unknown",
          category: pkg.aaul?.category || "other",
          system: pkg.aaul?.system === true,
          permissions: pkg.aaul?.permissions || [],
          minVersion: pkg.aaul?.minVersion || "0.0.0",
          main: pkg.main,
          path: pluginDir,
          valid: validation.valid,
          errors: validation.errors,
          enabled: false
        });
      } catch (err) {
        console.error(`Failed to read plugin package.json: ${entry.name}`, err.message);
      }
    }
  } catch (err) {
    console.error("Failed to discover plugins:", err.message);
  }

  return plugins;
}

export async function loadPlugin(pluginMeta, app) {
  if (loadedPlugins.has(pluginMeta.name)) {
    console.warn(`Plugin already loaded: ${pluginMeta.name}`);
    return false;
  }

  if (!pluginMeta.valid) {
    console.error(`Cannot load invalid plugin: ${pluginMeta.name}`, pluginMeta.errors);
    return false;
  }

  try {
    const mainPath = path.resolve(pluginMeta.path, pluginMeta.main);
    const pluginDir = path.resolve(pluginMeta.path);
    // A plugin's "main" field is untrusted input from its package.json;
    // reject anything that resolves outside the plugin's own directory.
    if (!mainPath.startsWith(pluginDir + path.sep) && mainPath !== pluginDir) {
      console.error(`[Plugins] BLOCKED: path traversal in plugin main: ${pluginMeta.main}`);
      return false;
    }
    const pluginModule = await import(`file://${mainPath}`);
    const plugin = pluginModule.default || pluginModule;

    if (typeof plugin.onLoad !== "function") {
      console.error(`Plugin missing onLoad function: ${pluginMeta.name}`);
      return false;
    }

    const context = createPluginContext(app, pluginMeta);
    await plugin.onLoad(context);

    loadedPlugins.set(pluginMeta.name, {
      meta: pluginMeta,
      instance: plugin,
      context
    });

    console.log(`[Plugins] Loaded: ${pluginMeta.name} v${pluginMeta.version}`);
    return true;
  } catch (err) {
    console.error(`Failed to load plugin: ${pluginMeta.name}`, err.message);
    return false;
  }
}

export async function unloadPlugin(pluginName) {
  const loaded = loadedPlugins.get(pluginName);
  if (!loaded) {
    return false;
  }

  try {
    if (typeof loaded.instance.onUnload === "function") {
      await loaded.instance.onUnload();
    }

    for (const [hookName, callbacks] of hooks.entries()) {
      hooks.set(
        hookName,
        callbacks.filter((cb) => cb.plugin !== pluginName)
      );
    }

    const routeCount = pluginRoutes.length;
    pluginRoutes.splice(
      0,
      routeCount,
      ...pluginRoutes.filter((r) => r.plugin !== pluginName)
    );

    const uiCount = uiComponents.length;
    uiComponents.splice(
      0,
      uiCount,
      ...uiComponents.filter((c) => c.plugin !== pluginName)
    );

    loadedPlugins.delete(pluginName);
    console.log(`[Plugins] Unloaded: ${pluginName}`);
    return true;
  } catch (err) {
    console.error(`Failed to unload plugin: ${pluginName}`, err.message);
    return false;
  }
}

export async function loadAllPlugins(app) {
  const discovered = await discoverPlugins();

  let enabledPlugins = [];
  try {
    const row = await dbOps.get("SELECT value FROM settings WHERE key = 'enabledPlugins'");
    if (row && row.value) {
      enabledPlugins = JSON.parse(row.value);
    }
  } catch (err) {
    // settings table doesn't exist yet on a fresh install
  }

  for (const plugin of discovered) {
    if (enabledPlugins.includes(plugin.name)) {
      plugin.enabled = true;
      await loadPlugin(plugin, app);
    }
  }

  for (const route of pluginRoutes) {
    const method = route.method.toLowerCase();
    if (typeof app[method] === "function") {
      app[method](route.path, ...route.middleware, route.handler);
    }
  }

  // AAUL-Cloud: exécute les migrations 'up' des plugins après chargement,
  // après initDb() et avant que le serveur écoute.
  await runPluginMigrations();

  console.log(`[Plugins] Loaded ${loadedPlugins.size} plugin(s)`);
}

export async function triggerHook(hookName, ...args) {
  const callbacks = hooks.get(hookName);
  if (!callbacks || callbacks.length === 0) {
    return;
  }

  for (const { plugin, callback } of callbacks) {
    try {
      await callback(...args);
    } catch (err) {
      console.error(`[Plugin:${plugin}] Hook error (${hookName}):`, err.message);
    }
  }
}

export function getLoadedPlugins() {
  return Array.from(loadedPlugins.values()).map((p) => p.meta);
}

export async function getAllPlugins() {
  const discovered = await discoverPlugins();

  return discovered.map((plugin) => ({
    ...plugin,
    loaded: loadedPlugins.has(plugin.name)
  }));
}

export function getUIComponents(slot) {
  return uiComponents.filter((c) => c.slot === slot);
}

export async function enablePlugin(pluginName, app) {
  const discovered = await discoverPlugins();
  const plugin = discovered.find((p) => p.name === pluginName);

  if (!plugin) {
    return false;
  }

  let enabledPlugins = [];
  try {
    const row = await dbOps.get("SELECT value FROM settings WHERE key = 'enabledPlugins'");
    if (row && row.value) {
      enabledPlugins = JSON.parse(row.value);
    }
  } catch (err) {
    // ignore, table may not exist yet
  }

  if (!enabledPlugins.includes(pluginName)) {
    enabledPlugins.push(pluginName);
    await dbOps.run(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      ["enabledPlugins", JSON.stringify(enabledPlugins)]
    );
  }

  return await loadPlugin(plugin, app);
}

export async function disablePlugin(pluginName) {
  let enabledPlugins = [];
  try {
    const row = await dbOps.get("SELECT value FROM settings WHERE key = 'enabledPlugins'");
    if (row && row.value) {
      enabledPlugins = JSON.parse(row.value);
    }
  } catch (err) {
    // ignore, table may not exist yet
  }

  enabledPlugins = enabledPlugins.filter((p) => p !== pluginName);
  await dbOps.run(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    ["enabledPlugins", JSON.stringify(enabledPlugins)]
  );

  return await unloadPlugin(pluginName);
}

// Calls onServerReady on plugins that define it, then fires the
// equivalent hook for hook-based listeners.
export async function notifyServerReady(context) {
  for (const [name, loaded] of loadedPlugins) {
    try {
      if (typeof loaded.instance.onServerReady === "function") {
        const pluginContext = {
          ...context,
          log: (level, message) => {
            const prefix = `[Plugin:${name}]`;
            if (level === "error") {
              console.error(prefix, message);
            } else if (level === "warn") {
              console.warn(prefix, message);
            } else {
              console.log(prefix, message);
            }
          }
        };
        await loaded.instance.onServerReady(pluginContext);
      }
    } catch (err) {
      console.error(`[Plugin:${name}] onServerReady error:`, err);
    }
  }

  await triggerHook("server:ready", context);
}

// AAUL-Cloud: exécute les migrations 'up' de tous les plugins chargés.
// Appelé dans loadAllPlugins, après initDb() et avant que le serveur écoute.
export async function runPluginMigrations() {
  for (const [pluginName, migrations] of pluginMigrations) {
    for (const migration of migrations) {
      try {
        await migration.up(dbOps);
        console.log(`[Plugins] Migration up: ${pluginName}`);
      } catch (err) {
        console.error(`[Plugins] Migration up failed for ${pluginName}:`, err.message);
      }
    }
  }
}

// AAUL-Cloud: applique les filtres d'agents enregistrés. Retourne true si
// l'agent doit être conservé (aucun filtre ne l'exclut).
export async function applyAgentFilters(agent, req) {
  for (const { plugin, filter } of agentFilters) {
    try {
      const keep = await filter(agent, req);
      if (keep === false) {
        return false;
      }
    } catch (err) {
      console.error(`[Plugin:${plugin}] Agent filter error:`, err.message);
    }
  }
  return true;
}

// AAUL-Cloud: applique les enrichisseurs de session enregistrés sur l'objet user.
export async function enrichSession(user, req) {
  for (const { plugin, enricher } of sessionEnrichers) {
    try {
      await enricher(user, req);
    } catch (err) {
      console.error(`[Plugin:${plugin}] Session enricher error:`, err.message);
    }
  }
  return user;
}

// AAUL-Cloud: purge les données d'un plugin (exécute les migrations 'down').
// Action destructive et explicite — jamais appelée automatiquement.
export async function purgePluginData(pluginName) {
  const migrations = pluginMigrations.get(pluginName) || [];
  let purged = false;
  for (const migration of migrations) {
    if (typeof migration.down === "function") {
      try {
        await migration.down(dbOps);
        purged = true;
        console.log(`[Plugins] Migration down (purge): ${pluginName}`);
      } catch (err) {
        console.error(`[Plugins] Migration down failed for ${pluginName}:`, err.message);
      }
    }
  }
  return purged;
}

export default {
  discoverPlugins,
  loadPlugin,
  unloadPlugin,
  loadAllPlugins,
  triggerHook,
  notifyServerReady,
  getLoadedPlugins,
  getAllPlugins,
  getUIComponents,
  enablePlugin,
  disablePlugin,
  runPluginMigrations,
  applyAgentFilters,
  enrichSession,
  purgePluginData
};
