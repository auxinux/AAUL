# Plugin System

The Agent Auto Update dashboard supports plugins to extend functionality.

## Plugin Structure

Each plugin is a directory under `plugins/` with the following structure:

```
plugins/
  my-plugin/
    package.json      # Plugin metadata
    index.js          # Main entry point (ES module)
    routes/           # Optional: Express routes
    components/       # Optional: React components (for UI)
    README.md         # Documentation
```

## Plugin package.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Description of what this plugin does",
  "author": "Your Name",
  "license": "MIT",
  "main": "index.js",
  "aaul": {
    "displayName": "My Plugin",
    "category": "monitoring",
    "minVersion": "1.0.0",
    "permissions": ["agents:read", "agents:write", "settings:read"]
  }
}
```

## Plugin Entry Point (index.js)

```javascript
/**
 * Plugin lifecycle hooks
 */
export default {
  // Plugin metadata (can also be read from package.json)
  name: 'my-plugin',
  version: '1.0.0',
  displayName: 'My Plugin',
  description: 'Extends the dashboard with custom features',
  
  /**
   * Called when the plugin is loaded
   * @param {Object} context - Plugin context
   * @param {Object} context.app - Express app instance
   * @param {Object} context.db - Database operations
   * @param {Object} context.config - Server configuration
   * @param {Function} context.registerRoute - Register API routes
   * @param {Function} context.registerHook - Register lifecycle hooks
   * @param {Function} context.registerUI - Register UI components
   */
  async onLoad(context) {
    const { app, db, config, registerRoute, registerHook, registerUI } = context;
    
    // Register custom API routes
    registerRoute('/api/my-plugin/status', {
      method: 'GET',
      handler: async (req, res) => {
        res.json({ ok: true, message: 'Plugin is working!' });
      }
    });
    
    // Register hooks into agent lifecycle
    registerHook('agent:poll', async (agent, payload) => {
      // Called whenever an agent polls
      console.log(`Agent ${agent.id} polled`);
    });
    
    registerHook('agent:command:complete', async (agent, command, result) => {
      // Called when an agent completes a command
    });
    
    // Register UI components (for dashboard)
    registerUI('dashboard:card', {
      component: 'MyStatusCard',
      props: { title: 'Custom Status' }
    });
  },
  
  /**
   * Called when the plugin is unloaded
   */
  async onUnload() {
    // Cleanup resources
  },
  
  /**
   * Called when plugin settings are updated
   */
  async onSettingsChange(newSettings) {
    // React to settings changes
  }
};
```

## Available Hooks

| Hook Name | Description | Parameters |
|-----------|-------------|------------|
| `agent:poll` | Agent sends a poll request | (agent, payload) |
| `agent:registered` | New agent is registered | (agent) |
| `agent:command:queued` | Command queued for agent | (agent, command) |
| `agent:command:complete` | Command completed | (agent, command, result) |
| `agent:uninstalled` | Agent uninstalled | (agentId) |
| `server:start` | Server is starting | (config) |
| `server:ready` | HTTP/HTTPS servers are listening | (context) |
| `server:stop` | Server is stopping | () |
| `settings:changed` | Dashboard settings were updated | (settings) |

## Available Permissions

- `agents:read` - Read agent information
- `agents:write` - Modify agents, queue commands
- `settings:read` - Read server settings
- `settings:write` - Modify server settings
- `users:read` - Read user information
- `users:write` - Modify users
- `plugins:manage` - Install/uninstall plugins

## Security Notes

- Plugins run with the same privileges as the main server
- Only install plugins from trusted sources
- Review plugin code before installation
- Plugins are validated on load for required structure
