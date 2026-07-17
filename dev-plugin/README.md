# AAUL Plugins Development Guide

## English

### Overview
Plugins extend the Agent Auto Update Linux (AAUL) dashboard. A plugin is a folder with a `package.json` and an entry file (usually `index.js`). You can package it as `.pg` (zip) and install it from the Plugins page.

### Structure
```
my-plugin/
  package.json
  index.js
  README.md (optional)
```

### package.json (minimum)
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Short description",
  "author": "Your Name",
  "license": "MIT",
  "main": "index.js",
  "type": "module",
  "aaul": {
    "displayName": "My Plugin",
    "category": "monitoring",
    "minVersion": "1.0.0",
    "permissions": []
  }
}
```

### Entry point (index.js)
```js
export default {
  name: "my-plugin",
  version: "1.0.0",
  displayName: "My Plugin",
  description: "Does something useful",

  async onLoad(context) {
    const { registerRoute, registerHook, registerUI, log } = context;

    registerRoute("/api/my-plugin/ping", {
      method: "GET",
      handler: (req, res) => res.json({ ok: true })
    });

    registerUI("dashboard:after-agents", {
      type: "custom",
      variant: "my-widget"
    });

    log("info", "My Plugin loaded");
  },

  async onUnload() {
    // cleanup
  }
};
```

### Packaging (.pg)
1. Create your plugin folder (e.g. `my-plugin/`).
2. Zip the folder.
3. Rename `.zip` to `.pg`.
4. Upload in Dashboard → Plugins → Install.

### Tips & Best Practices
- Keep routes under a unique namespace: `/api/<plugin-name>/...`
- Validate input and handle errors.
- Use `registerUI` to add widgets or nav items.
- Keep UI light; avoid blocking the main thread.
- Use `log("info"|"warn"|"error", ...)` for visibility.

### Permissions (aaul.permissions)
Declare the access your plugin needs in `package.json` under `aaul.permissions`.
Available values:
- `agents:read`, `agents:write`
- `settings:read`, `settings:write`
- `users:read`, `users:write`
- `plugins:manage`

Example:
```json
"permissions": ["agents:read", "settings:read"]
```

### Warnings
- The server restarts after install/enable/disable/delete.
- Avoid naming conflicts with existing routes.
- System plugins are not deletable.
- In dev mode, Vite proxying is required for plugin routes.

---

## Français

### Vue d’ensemble
Les plugins étendent le tableau de bord AAUL. Un plugin est un dossier avec un `package.json` et un fichier d’entrée (souvent `index.js`). Il peut être empaqueté en `.pg` (zip) et installé depuis la page Plugins.

### Structure
```
mon-plugin/
  package.json
  index.js
  README.md (optionnel)
```

### package.json (minimum)
```json
{
  "name": "mon-plugin",
  "version": "1.0.0",
  "description": "Petite description",
  "author": "Votre Nom",
  "license": "MIT",
  "main": "index.js",
  "type": "module",
  "aaul": {
    "displayName": "Mon Plugin",
    "category": "monitoring",
    "minVersion": "1.0.0",
    "permissions": []
  }
}
```

### Fichier d’entrée (index.js)
```js
export default {
  name: "mon-plugin",
  version: "1.0.0",
  displayName: "Mon Plugin",
  description: "Fait quelque chose d’utile",

  async onLoad(context) {
    const { registerRoute, registerHook, registerUI, log } = context;

    registerRoute("/api/mon-plugin/ping", {
      method: "GET",
      handler: (req, res) => res.json({ ok: true })
    });

    registerUI("dashboard:after-agents", {
      type: "custom",
      variant: "mon-widget"
    });

    log("info", "Mon Plugin charge");
  },

  async onUnload() {
    // nettoyage
  }
};
```

### Empaquetage (.pg)
1. Créez le dossier du plugin (ex. `mon-plugin/`).
2. Zippez le dossier.
3. Renommez `.zip` en `.pg`.
4. Téléversez dans Dashboard → Plugins → Installer.

### Astuces & Bonnes pratiques
- Utilisez un préfixe de routes unique : `/api/<nom-plugin>/...`
- Validez les entrées et gérez les erreurs.
- Utilisez `registerUI` pour ajouter des widgets ou un lien de menu.
- Gardez l’UI légère (ne bloquez pas le thread principal).
- Utilisez `log("info"|"warn"|"error", ...)` pour tracer.

### Permissions (aaul.permissions)
Déclarez les accès nécessaires dans `package.json` sous `aaul.permissions`.
Valeurs possibles :
- `agents:read`, `agents:write`
- `settings:read`, `settings:write`
- `users:read`, `users:write`
- `plugins:manage`

Exemple :
```json
"permissions": ["agents:read", "settings:read"]
```

### Avertissements
- Le serveur redémarre après install/activation/désactivation/suppression.
- Évitez les conflits de routes.
- Les plugins système ne sont pas supprimables.
- En dev, le proxy Vite est nécessaire pour les routes plugins.
