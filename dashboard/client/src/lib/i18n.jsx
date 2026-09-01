import React, { createContext, useContext, useMemo, useState } from "react";

const translations = {
  en: {
    app: {
      name: "Agent Auto Update Linux",
      shortName: "AAUL"
    },
    footer: {
      version: "AAUL Ver. {version}",
      by: "by the community"
    },
    nav: {
      control: "Control",
      dashboard: "Dashboard",
      addAgent: "Add Agent",
      packages: "Packages",
      tasks: "Tasks",
      logs: "Logs",
      users: "Users",
      plugins: "Plugins",
      admin: "Admin",
      console: "Console",
      logout: "Logout",
      signedIn: "Signed in as {name}",
      signedInAs: "Signed in as",
      hide: "Hide",
      showMenu: "Show menu"
    },
    login: {
      secureConsole: "Secure Console",
      title: "Sign in",
      subtitle: "Use your admin credentials to access the dashboard.",
      username: "Username",
      password: "Password",
      login: "Login",
      signingIn: "Signing in...",
      defaultCredentials: ""
    },
    passwordChange: {
      required: "Password update required",
      title: "Change temporary password",
      subtitle: "The account {name} must set a new password before continuing.",
      currentPassword: "Current password",
      newPassword: "New password",
      confirmPassword: "Confirm new password",
      passwordTooShort: "The new password must contain at least 10 characters.",
      passwordMismatch: "The new passwords do not match.",
      failed: "Failed to change the password.",
      logout: "Logout",
      save: "Update password",
      saving: "Updating..."
    },
    errors: {
      loadAgents: "Failed to load agents",
      loadAgentInfo: "Failed to load agent info",
      loadInstallInfo: "Failed to load install info",
      addAgent: "Failed to add agent",
      loadUsers: "Failed to load users",
      createUser: "Failed to create user",
      loadSettings: "Failed to load admin settings",
      saveSettings: "Failed to save settings",
      loadLogs: "Failed to load logs",
      loadFailed: "Could not load the data. Try again in a moment.",
      saveFailed: "Could not save your changes.",
      loadLogContent: "Failed to load log content",
      commandFailed: "Command failed",
      commandTimeout: "Command timed out. The agent may not have polled yet."
    },
    details: {
      title: "Agent details",
      subtitle: "Hardware and OS information reported by the agent.",
      back: "Back",
      refresh: "Refresh info",
      refreshing: "Refreshing...",
      waiting: "Waiting for agent response...",
      system: "System",
      cpu: "CPU",
      memory: "Memory",
      disks: "Disks",
      ips: "IPs",
      gpu: "GPU",
      packages: "Packages",
      repositories: "Repositories",
      noInfo: "No information available yet.",
      noDisks: "No disks reported.",
      noIps: "No IPs reported.",
      noGpu: "No GPU reported.",
      noRepos: "No repositories reported.",
      osName: "Name",
      osVersion: "Version",
      packageManager: "Package manager",
      uptime: "Uptime",
      rebootRequired: "Reboot required",
      updateRequired: "Update required",
      cores: "Cores",
      threads: "Threads",
      total: "Total",
      used: "Used",
      available: "Available",
      lastUpdated: "Last updated: {time}",
      packageCount: "{count} packages installed",
      // Install command card
      installTitle: "Install Command",
      installPlatform: "Platform",
      installCopy: "Copy",
      installCopied: "Copied!",
      installWindowsNote: "Run PowerShell as Administrator on the target machine.",
      installScriptUrl: "Script URL",
      // Local web interface
      localWebTitle: "Local Web Interface",
      localWebDescription: "Enable a local web interface on this agent for direct management without going through the dashboard.",
      enableLocalWeb: "Enable local web interface",
      localWebPort: "Local Web Port",
      allowedPorts: "Allowed ports",
      localWebSaved: "Local web settings saved. Agent will apply on next poll.",
      openLocalWeb: "Open local interface",
      localWebInfo: "When enabled:",
      localWebFirewall: "Agent will automatically configure the firewall (ufw/firewalld/iptables)",
      localWebAuth: "Authentication uses Linux system users (PAM)",
      localWebUrl: "Access URL"
    },
    confirm: {
      deleteUser: "Delete user {name}?"
    },
    dashboard: {
      layoutMode: "View Mode",
      layoutSimple: "Simple",
      updatesShort: "updates",
      badgeReboot: "Reboot",
      badgeOutdated: "Outdated",
      layoutDetailed: "Detailed",
      title: "Fleet Status",
      subtitle: "Monitor agent heartbeat, latest updates, and queued commands.",
      refresh: "Refresh",
      loadingAgents: "Loading agents...",
      columns: "Columns",
      searchPlaceholder: "Search by name, host, IP or agent ID",
      noAgentsMatch: "No agents match the current filters.",
      filters: {
        all: "All",
        online: "Online",
        offline: "Offline",
        outdated: "Outdated",
        reboot: "Needs reboot"
      },
      stats: {
        total: "Total agents",
        online: "Online",
        outdated: "Outdated",
        rebootRequired: "Reboot required"
      },
      updateOutdated: "Update all outdated",
      updateOutdatedNone: "All agents are up to date",
      versionOutdated: "Outdated",
      table: {
        name: "Name",
        hostIp: "Host/IP",
        lastSeen: "Last seen",
        lastRun: "Last run",
        status: "Status",
        state: "State",
        exit: "Exit",
        version: "Version",
        schedule: "Schedule",
        command: "Command",
        actions: "Actions"
      },
      schedule: {
        enabled: "Enabled",
        disabled: "Disabled"
      },
      command: {
        none: "None"
      },
      actions: {
        runNow: "Run now",
        schedule: "Schedule",
        updateAgent: "Update agent",
        uninstall: "Uninstall",
        installInfo: "Install info",
        remove: "Remove",
        removeDevice: "Remove device",
        cancelPending: "Cancel pending",
        cancelUninstall: "Cancel uninstall"
      },
      scheduleModal: {
        title: "Schedule: {name}",
        enableDaily: "Enable daily schedule",
        dailyTime: "Daily time",
        cancel: "Cancel",
        save: "Save"
      },
      installModal: {
        title: "Install info: {name}",
        loading: "Loading install info...",
        agentId: "Agent ID",
        installCommand: "Install command",
        copyCommand: "Copy command",
        scriptUrl: "Script URL"
      },
      uninstallModal: {
        title: "Confirm uninstall: {name}",
        description: "This will queue an uninstall command on the agent.",
        confirm: "Confirm uninstall",
        cancel: "Cancel"
      },
      confirm: {
        runNow: "Run update now for this agent?",
        updateAgent: "Queue agent update?",
        updateOutdated: "Queue an update for all outdated agents?",
        cancelPending: "Cancel pending command?",
        cancelUninstall: "Cancel uninstall command?",
        remove: "Remove {name}?",
        removeDevice: "Remove {name} from the dashboard? This does not uninstall the agent."
      }
    },
    logs: {
      title: "Logs",
      subtitle: "Browse agent logs and view output on demand.",
      agents: "Agents",
      refreshAgents: "Refresh agents",
      selectAgent: "Select an agent",
      availableLogs: "Available logs for {name}",
      instructions: "Request the log list from the agent, then open any log.",
      waiting: "Waiting for agent response...",
      loadLogs: "Load logs",
      loadingLogs: "Loading logs...",
      noLogs: "No logs available yet.",
      view: "View",
      content: "Log content",
      loadingContent: "Loading log content...",
      truncated: "Truncated",
      noContent: "No log content loaded.",
      noContentHint: "Pick a log file above to read it here.",
      noAgents: "No agents available.",
      noLogsHint: "Click \u201cLoad logs\u201d to ask this host for its log files.",
      filterAgents: "Filter agents\u2026",
      searchInLog: "Search in this log\u2026",
      noMatchingLines: "No line matches your search.",
      lineCount: "{n} lines",
      diskUsage: "{n} file(s) \u00b7 {size} on disk",
      download: "Download",
      toggleWrap: "Toggle line wrapping",
      jumpToEnd: "Jump to the end",
      levelAll: "All",
      levelError: "Errors",
      levelWarn: "Warnings",
      levelSuccess: "Success",
      levelInfo: "Info",
      retentionTitle: "Log retention",
      retentionHint: "Applies to every agent. Each host enforces the policy locally on its next check-in: logs older than the age limit are deleted, then the oldest are removed until the total fits the size limit. The current day\u2019s log is never deleted.",
      retentionDays: "Keep logs for (days)",
      retentionMaxMb: "Max total size (MB)",
      retentionSaved: "Retention policy saved. Agents will apply it on their next check-in.",
      pruneNow: "Clean up now",
      pruning: "Cleaning up\u2026",
      pruneHint: "Apply the retention policy on this host immediately.",
      pruneConfirm: "Apply the retention policy to this host now? Log files outside the policy will be deleted permanently.",
      pruneDone: "{n} file(s) removed, {size} freed."
    },
    admin: {
      title: "Admin settings",
      subtitle: "Select the network IP used to build installation commands.",
      loading: "Loading...",
      networkIp: "Network IP",
      selectIp: "Select IP",
      ipHint: "Choose the IP reachable by your clients.",
      apiPort: "API port",
      clientPort: "Client port",
      defaultPoll: "Default poll interval (seconds)",
      defaultPollHint: "Applies to new installs. Existing agents need an update or reinstall.",
      pollingTitle: "Agent check-in",
      pollInterval: "Interval (seconds)",
      pollHint: "How often each agent contacts the dashboard. Shorter means fresher metrics and faster commands, at the cost of more requests.",
      baseUrl: "Install base URL",
      baseUrlPlaceholder: "Select a network IP",
      internetBaseUrl: "Internet URL (external access)",
      internetBaseUrlPlaceholder: "https://aaul.yourdomain.com",
      internetBaseUrlHint: "Optional. Pre-filled when adding agents in Internet mode. Leave empty if you only use local installs.",
      save: "Save settings",
      refreshIps: "Refresh IP list",
      saved: "Settings saved.",
      note: "Port changes are managed in Server Management. Restart the server after changing ports.",
      // Server management
      serverManagement: "Server Management",
      serverControls: "Server Controls",
      restartServer: "Restart Server",
      restarting: "Restarting...",
      restartHint: "Apply configuration changes",
      confirmRestart: "Are you sure you want to restart the server? The dashboard will be unavailable briefly.",
      httpConfig: "HTTP/HTTPS Configuration",
      webPort: "Web Dashboard Port",
      disableHttp: "Disable HTTP (HTTPS only)",
      disableHttpHint: "When enabled, the server will only accept HTTPS connections",
      saveConfig: "Save Configuration"
    },
    users: {
      title: "Admin users",
      subtitle: "Manage who can access the dashboard.",
      create: "Create admin",
      loading: "Loading...",
      created: "Created",
      actions: "Actions",
      setPassword: "Set password",
      delete: "Delete",
      modalTitle: "Set password: {name}",
      newPassword: "New password",
      save: "Save"
    },
    newAgent: {
      title: "Add a new agent",
      subtitle: "Generate an installer for Linux, macOS or Windows.",
      modeLabel: "Installation mode",
      modeLocal: "Local (LAN)",
      modeLocalDesc: "Same network as the dashboard",
      modeLocalInfo: "The agent will contact the dashboard using the configured local address.",
      modeInternet: "Internet (external URL)",
      modeInternetDesc: "Server accessible from the internet",
      baseUrlLabel: "External dashboard URL",
      baseUrlPlaceholder: "https://aaul.yourdomain.com",
      baseUrlHint: "The agent will use this URL to reach the dashboard. Make sure it is publicly accessible.",
      baseUrlRequired: "Please enter the external URL.",
      platformLabel: "Operating system",
      platform_linux: "Linux",
      platform_macos: "macOS",
      platform_windows: "Windows",
      windowsAdminNote: "Run PowerShell as Administrator on the target machine.",
      displayName: "Display name",
      creating: "Creating...",
      addAgent: "Add agent",
      agentId: "Agent ID",
      installCommand: "Install command",
      scriptUrl: "Script URL",
      safeInstallHint: "The installer is downloaded locally first, then executed with the platform-appropriate shell.",
      copyCommand: "Copy command",
      copied: "Copied!"
    },
    status: {
      ok: "OK",
      error: "ERROR",
      queued: "QUEUED",
      inProgress: "IN_PROGRESS",
      done: "DONE",
      rebootRequired: "REBOOT REQUIRED"
    },
    state: {
      online: "Online",
      offline: "Offline"
    },
    common: {
      loading: "Loading...",
      saving: "Saving...",
      cancel: "Cancel",
      save: "Save",
      confirm: "Confirm",
      ok: "OK",
      clear: "Clear"
    },
    plugins: {
      title: "Plugins",
      subtitle: "Extend the dashboard with community and professional plugins.",
      loading: "Loading plugins...",
      noPlugins: "No plugins installed",
      noPluginsHint: "Place plugin folders in the server/plugins directory to get started. Check the documentation for creating your own plugins.",
      activePlugins: "Active Plugins",
      availablePlugins: "Available Plugins",
      enable: "Enable",
      disable: "Disable",
      enabled: "Plugin {name} has been enabled",
      disabled: "Plugin {name} has been disabled",
      deleted: "Plugin {name} has been deleted",
      installTitle: "Install Plugin",
      installHint: "Upload a .pg plugin package to install it on the server.",
      installButton: "Install",
      installing: "Installing...",
      installMissing: "Please select a .pg file first.",
      delete: "Delete",
      deleteConfirm: "Delete plugin {name}?",
      system: "SYSTEM",
      active: "Active",
      author: "Author",
      permissions: "Permissions",
      validationErrors: "Validation errors",
      developingTitle: "Develop Your Own Plugin",
      developingHint: "Create custom integrations, monitoring tools, or automation features. Professional plugins with enterprise support are also available.",
      documentation: "Plugin Documentation",
      professional: "Professional Plugins"
    },
    ssl: {
      title: "SSL/TLS Configuration",
      enabled: "HTTPS Enabled",
      keyPath: "Private Key Path",
      certPath: "Certificate Path",
      caPath: "CA Chain Path (optional)",
      httpsPort: "HTTPS Port",
      redirectHttp: "Redirect HTTP to HTTPS",
      generateSelfSigned: "Generate Self-Signed Certificate",
      letsEncrypt: "Let's Encrypt Instructions"
    },
    agentLocalWeb: {
      title: "Agent Local Web Interface",
      enabled: "Enable Local Web Interface",
      port: "Local Web Port",
      portHint: "Allowed ports: 8080, 8090, 8180, 8190",
      perAgentInfo: "The local web interface is now configured per-agent. Go to an agent's details page to enable/disable the local web interface for that specific agent.",
      feature1: "Enable/disable individually for each agent",
      feature2: "Automatic firewall configuration (ufw, firewalld, iptables)",
      feature3: "Authentication with Linux system users (PAM)",
      feature4: "Direct access at http://AGENT_IP:PORT",
      configureHint: "Navigate to Dashboard → Agent Details to configure local web for each agent."
    },
    packagesAll: {
      title: "All packages",
      subtitle: "Aggregated view of installed packages and updates across every machine.",
      scanFleet: "Scan fleet",
      scanning: "Scanning...",
      scanHint: "Refresh package data on all machines (online devices only).",
      tabInstalled: "Installed",
      tabUpdates: "Updates",
      noDataInstalled: "No package data yet. Launch a fleet scan to list installed packages across all machines.",
      noDataUpdates: "No update data yet. Launch a fleet scan (or check updates) to see packages to update.",
      noUpdates: "All machines are up to date.",
      pkgCol: "Package",
      machinesCol: "Machines",
      affectedMachines: "Affected machines",
      installedOn: "Installed on",
      selectPkg: "Select",
      selectAll: "Select all",
      clearSelection: "Clear selection",
      updateSelected: "Update selected",
      updateAll: "Update all",
      updateAllDesc: "Launch the update of the selected packages on every affected machine?",
      updateAllDescAll: "Launch the update of ALL listed packages on every affected machine?",
      noSelection: "Select at least one package to update.",
      updateQueued: "Update queued on {n} machine(s).",
      updateQueuedShort: "Queued",
      machines: "machine(s)",
      machinesListTitle: "Affected machines",
      details: "Details",
      close: "Close",
      versions: "Versions",
      scanned: "{scanned}/{total} machines scanned",
      onePerLine: "One package per line",
      updated: "Updated",
      hosts: "hosts",
      security: "Security",
      securityOnly: "Security only",
      searchPlaceholder: "Search a package\u2026",
      sortImpact: "Most impacted first",
      sortName: "Alphabetical",
      sortHint: "Switch between blast radius and alphabetical order",
      patchSecurity: "Patch security updates",
      patchSecurityDesc: "Queue the {n} security update(s) on every affected machine. This is the fastest way to close known vulnerabilities across the fleet.",
      tileSecurity: "Security updates",
      tileSecurityHint: "{n} host(s) affected",
      tileUpdates: "Updates available",
      tileUpdatesHint: "{n} host(s) affected",
      tileScanned: "Hosts scanned",
      tileInstalled: "Distinct packages",
      noMatch: "No package matches your filters.",
      noMatchHint: "Try a different search term, or turn off the security-only filter.",
      noUpdatesHint: "Every scanned machine is running the latest packages its repositories offer.",
      noDataInstalledHint: "Run a fleet scan to collect the installed package list from every machine.",
      scanPhaseList: "{n} machine(s) \u2014 listing packages\u2026",
      scanPhaseUpdates: "Looking for available updates\u2026",
      scanDone: "Fleet scan complete.",
      scanFailed: "The fleet scan did not complete."
    },
    packagesHub: {
      subtitle: "Pick a machine to list, search and install or remove its software. Looking for the whole fleet at once? Use the fleet view.",
      viewFleet: "See the whole fleet",
      filterPlaceholder: "Filter by name, host or IP\u2026",
      noAgents: "No machine matches your search",
      noAgentsHint: "Try another name, hostname or IP \u2014 or add a machine from the Add Agent page.",
      manage: "Manage software"
    },
    metrics: {
      cpu: "CPU",
      memory: "RAM",
      disk: "Disk",
      load: "Load",
      swap: "Swap",
      noData: "No metrics reported yet",
      noDataHint: "This host has not checked in with an agent new enough to report vital signs. Update the agent to start collecting them.",
      title: "Live vital signs",
      subtitle: "Reported by the agent on every check-in.",
      updatedAt: "Updated {time}",
      history: "Last 24 hours",
      processes: "Processes",
      sessions: "Sessions",
      fleetTitle: "Fleet health",
      underPressure: "Hosts under pressure",
      allHealthy: "Every reporting host is within normal limits.",
      retentionTitle: "Metric history retention",
      retentionDays: "Keep metric history for (days)",
      retentionHint: "How long the dashboard keeps per-host CPU, memory and disk samples. One sample is stored per host every 5 minutes."
    },
    language: {
      toggle: "FR"
    }
  },
  fr: {
    app: {
      name: "Agent Auto Update Linux",
      shortName: "AAUL"
    },
    footer: {
      version: "AAUL Ver. {version}",
      by: "par la communaute"
    },
    nav: {
      control: "Contrôle",
      dashboard: "Tableau de bord",
      addAgent: "Ajouter un agent",
      packages: "Paquets",
      tasks: "Tâches",
      logs: "Logs",
      users: "Utilisateurs",
      plugins: "Plugins",
      admin: "Admin",
      console: "Console",
      logout: "Déconnexion",
      signedIn: "Connecté en tant que {name}",
      signedInAs: "Connecté en tant que",
      hide: "Masquer",
      showMenu: "Afficher le menu"
    },
    login: {
      secureConsole: "Console securisee",
      title: "Connexion",
      subtitle: "Utilisez vos identifiants admin pour acceder au dashboard.",
      username: "Utilisateur",
      password: "Mot de passe",
      login: "Se connecter",
      signingIn: "Connexion...",
      defaultCredentials: ""
    },
    passwordChange: {
      required: "Changement requis",
      title: "Changer le mot de passe temporaire",
      subtitle: "Le compte {name} doit definir un nouveau mot de passe avant de continuer.",
      currentPassword: "Mot de passe actuel",
      newPassword: "Nouveau mot de passe",
      confirmPassword: "Confirmer le nouveau mot de passe",
      passwordTooShort: "Le nouveau mot de passe doit contenir au moins 10 caracteres.",
      passwordMismatch: "Les nouveaux mots de passe ne correspondent pas.",
      failed: "Impossible de changer le mot de passe.",
      logout: "Se deconnecter",
      save: "Mettre a jour",
      saving: "Mise a jour..."
    },
    errors: {
      loadAgents: "Impossible de charger les agents",
      loadAgentInfo: "Impossible de charger les infos agent",
      loadInstallInfo: "Impossible de charger les infos d'installation",
      addAgent: "Impossible d'ajouter l'agent",
      loadUsers: "Impossible de charger les utilisateurs",
      createUser: "Impossible de creer l'utilisateur",
      loadSettings: "Impossible de charger les parametres admin",
      saveSettings: "Impossible d'enregistrer les parametres",
      loadLogs: "Impossible de charger les logs",
      loadFailed: "Impossible de charger les données. Réessayez dans un instant.",
      saveFailed: "Impossible d’enregistrer vos modifications.",
      loadLogContent: "Impossible de charger le contenu",
      commandFailed: "Commande en erreur",
      commandTimeout: "Delai depasse. L'agent n'a peut-etre pas encore repondu."
    },
    details: {
      title: "Details agent",
      subtitle: "Infos materiel et OS remontees par l'agent.",
      back: "Retour",
      refresh: "Rafraichir",
      refreshing: "Rafraichissement...",
      waiting: "En attente de la reponse de l'agent...",
      system: "Systeme",
      cpu: "CPU",
      memory: "Memoire",
      disks: "Disques",
      ips: "IPs",
      gpu: "GPU",
      packages: "Packages",
      repositories: "Depots",
      noInfo: "Aucune information disponible.",
      noDisks: "Aucun disque remonte.",
      noIps: "Aucune IP remontee.",
      noGpu: "Aucun GPU detecte.",
      noRepos: "Aucun depot remonte.",
      osName: "Nom",
      osVersion: "Version",
      packageManager: "Gestionnaire",
      uptime: "Uptime",
      rebootRequired: "Redémarrage requis",
      updateRequired: "Mise à jour requise",
      cores: "Cores",
      threads: "Threads",
      total: "Total",
      used: "Utilise",
      available: "Disponible",
      lastUpdated: "Derniere mise a jour : {time}",
      packageCount: "{count} packages installes",
      // Install command card
      installTitle: "Commande d'installation",
      installPlatform: "Plateforme",
      installCopy: "Copier",
      installCopied: "Copie !",
      installWindowsNote: "Lancez PowerShell en tant qu'Administrateur sur la machine cible.",
      installScriptUrl: "URL du script",
      // Local web interface
      localWebTitle: "Interface web locale",
      localWebDescription: "Activer une interface web locale sur cet agent pour la gestion directe sans passer par le dashboard.",
      enableLocalWeb: "Activer l'interface web locale",
      localWebPort: "Port web local",
      allowedPorts: "Ports autorises",
      localWebSaved: "Parametres web local sauvegardes. L'agent appliquera au prochain poll.",
      openLocalWeb: "Ouvrir l'interface locale",
      localWebInfo: "Lorsqu'activee :",
      localWebFirewall: "L'agent configurera automatiquement le pare-feu (ufw/firewalld/iptables)",
      localWebAuth: "L'authentification utilise les utilisateurs Linux du systeme (PAM)",
      localWebUrl: "URL d'acces"
    },
    confirm: {
      deleteUser: "Supprimer l'utilisateur {name} ?"
    },
    dashboard: {
      layoutMode: "Mode d'affichage",
      layoutSimple: "Simple",
      layoutDetailed: "Détaillé",
      updatesShort: "MAJ",
      badgeReboot: "Redémarrage",
      badgeOutdated: "Obsolète",
      title: "État de la flotte",
      subtitle: "Surveillez le heartbeat, les mises à jour et la file de commandes.",
      refresh: "Rafraîchir",
      loadingAgents: "Chargement des agents...",
      columns: "Colonnes",
      searchPlaceholder: "Rechercher par nom, hote, IP ou ID agent",
      noAgentsMatch: "Aucun agent ne correspond aux filtres actifs.",
      filters: {
        all: "Tous",
        online: "En ligne",
        offline: "Hors ligne",
        outdated: "Obsoletes",
        reboot: "Reboot requis"
      },
      stats: {
        total: "Total agents",
        online: "En ligne",
        outdated: "Obsoletes",
        rebootRequired: "Reboot requis"
      },
      updateOutdated: "Mettre a jour les obsoletes",
      updateOutdatedNone: "Tous les agents sont a jour",
      versionOutdated: "Obsolete",
      table: {
        name: "Nom",
        hostIp: "Hote/IP",
        lastSeen: "Dernier contact",
        lastRun: "Derniere execution",
        status: "Statut",
        state: "Etat",
        exit: "Code",
        version: "Version",
        schedule: "Horaire",
        command: "Commande",
        actions: "Actions"
      },
      schedule: {
        enabled: "Active",
        disabled: "Desactive"
      },
      command: {
        none: "Aucune"
      },
      actions: {
        runNow: "Executer",
        schedule: "Horaire",
        updateAgent: "Mettre a jour",
        uninstall: "Desinstaller",
        installInfo: "Infos d'installation",
        remove: "Retirer",
        removeDevice: "Retirer l'appareil",
        cancelPending: "Annuler en attente",
        cancelUninstall: "Annuler la desinstallation"
      },
      scheduleModal: {
        title: "Horaire : {name}",
        enableDaily: "Activer l'horaire quotidien",
        dailyTime: "Heure quotidienne",
        cancel: "Annuler",
        save: "Enregistrer"
      },
      installModal: {
        title: "Infos d'installation : {name}",
        loading: "Chargement des infos d'installation...",
        agentId: "ID agent",
        installCommand: "Commande d'installation",
        copyCommand: "Copier la commande",
        scriptUrl: "URL du script"
      },
      uninstallModal: {
        title: "Confirmer la desinstallation : {name}",
        description: "Cela va mettre en file une desinstallation sur l'agent.",
        confirm: "Confirmer",
        cancel: "Annuler"
      },
      confirm: {
        runNow: "Executer la mise a jour maintenant ?",
        updateAgent: "Mettre en file la mise a jour de l'agent ?",
        updateOutdated: "Mettre en file la mise a jour de tous les agents obsoletes ?",
        cancelPending: "Annuler la commande en attente ?",
        cancelUninstall: "Annuler la desinstallation ?",
        remove: "Retirer {name} ?",
        removeDevice: "Retirer {name} du dashboard ? Cela ne desinstalle pas l'agent."
      }
    },
    logs: {
      title: "Logs",
      subtitle: "Consultez les logs des agents sur demande.",
      agents: "Agents",
      refreshAgents: "Rafraichir les agents",
      selectAgent: "Selectionner un agent",
      availableLogs: "Logs disponibles pour {name}",
      instructions: "Demandez la liste des logs puis ouvrez celui qui vous interesse.",
      waiting: "En attente de la reponse de l'agent...",
      loadLogs: "Charger les logs",
      loadingLogs: "Chargement des logs...",
      noLogs: "Aucun log disponible.",
      view: "Voir",
      content: "Contenu du log",
      loadingContent: "Chargement du contenu...",
      truncated: "Tronque",
      noContent: "Aucun contenu charge.",
      noAgents: "Aucun agent disponible."
    },
    admin: {
      title: "Parametres admin",
      subtitle: "Selectionnez l'IP utilisee pour generer les commandes d'installation.",
      loading: "Chargement...",
      networkIp: "IP reseau",
      selectIp: "Choisir une IP",
      ipHint: "Choisissez l'IP joignable par vos clients.",
      apiPort: "Port API",
      clientPort: "Port client",
      defaultPoll: "Intervalle de poll par defaut (secondes)",
      defaultPollHint: "Applique aux nouvelles installations. Les agents existants doivent etre mis a jour ou reinstalles.",
      pollingTitle: "Contact des agents",
      pollInterval: "Intervalle (secondes)",
      pollHint: "Fréquence à laquelle chaque agent contacte le tableau de bord. Plus court signifie des métriques plus fraîches et des commandes plus rapides, au prix de davantage de requêtes.",
      baseUrl: "URL d'installation",
      baseUrlPlaceholder: "Choisir une IP reseau",
      internetBaseUrl: "URL internet (accès externe)",
      internetBaseUrlPlaceholder: "https://aaul.votredomaine.com",
      internetBaseUrlHint: "Optionnel. Pré-remplie lors de l'ajout d'un agent en mode Internet. Laisser vide si vous n'utilisez que des installations locales.",
      save: "Enregistrer",
      refreshIps: "Rafraichir la liste",
      saved: "Parametres enregistres.",
      note: "Les ports se configurent dans Gestion du serveur. Redemarrez le serveur apres changement.",
      // Server management
      serverManagement: "Gestion du serveur",
      serverControls: "Contrôles du serveur",
      restartServer: "Redémarrer le serveur",
      restarting: "Redémarrage...",
      restartHint: "Appliquer les changements de configuration",
      confirmRestart: "Êtes-vous sûr de vouloir redémarrer le serveur ? Le dashboard sera brièvement indisponible.",
      httpConfig: "Configuration HTTP/HTTPS",
      webPort: "Port du dashboard web",
      disableHttp: "Désactiver HTTP (HTTPS uniquement)",
      disableHttpHint: "Si activé, le serveur n'acceptera que les connexions HTTPS",
      saveConfig: "Enregistrer la configuration"
    },
    users: {
      title: "Utilisateurs admin",
      subtitle: "Gerez qui peut acceder au dashboard.",
      create: "Creer un admin",
      loading: "Chargement...",
      created: "Cree",
      actions: "Actions",
      setPassword: "Changer le mot de passe",
      delete: "Supprimer",
      modalTitle: "Mot de passe : {name}",
      newPassword: "Nouveau mot de passe",
      save: "Enregistrer"
    },
    newAgent: {
      title: "Ajouter un agent",
      subtitle: "Generez un installateur pour Linux, macOS ou Windows.",
      modeLabel: "Mode d'installation",
      modeLocal: "Local (réseau local)",
      modeLocalDesc: "Meme réseau que le dashboard",
      modeLocalInfo: "L'agent contactera le dashboard via l'adresse locale configurée.",
      modeInternet: "Internet (URL externe)",
      modeInternetDesc: "Serveur accessible depuis internet",
      baseUrlLabel: "URL externe du dashboard",
      baseUrlPlaceholder: "https://aaul.votredomaine.com",
      baseUrlHint: "L'agent utilisera cette URL pour contacter le dashboard. Assurez-vous qu'elle est accessible publiquement.",
      baseUrlRequired: "Veuillez entrer l'URL externe.",
      platformLabel: "Système d'exploitation",
      platform_linux: "Linux",
      platform_macos: "macOS",
      platform_windows: "Windows",
      windowsAdminNote: "Lancez PowerShell en tant qu'Administrateur sur la machine cible.",
      displayName: "Nom affiche",
      creating: "Creation...",
      addAgent: "Ajouter",
      agentId: "ID agent",
      installCommand: "Commande d'installation",
      scriptUrl: "URL du script",
      safeInstallHint: "Le script est d'abord téléchargé localement, puis exécuté avec le shell adapté à la plateforme.",
      copyCommand: "Copier la commande",
      copied: "Copié !"
    },
    status: {
      ok: "OK",
      error: "ERREUR",
      queued: "EN_ATTENTE",
      inProgress: "EN_COURS",
      done: "TERMINE",
      rebootRequired: "REBOOT REQUIS"
    },
    state: {
      online: "En ligne",
      offline: "Hors ligne"
    },
    common: {
      loading: "Chargement...",
      saving: "Enregistrement...",
      cancel: "Annuler",
      save: "Enregistrer",
      confirm: "Confirmer",
      ok: "OK",
      clear: "Effacer"
    },
    plugins: {
      title: "Plugins",
      subtitle: "Etendez le dashboard avec des plugins communautaires et professionnels.",
      loading: "Chargement des plugins...",
      noPlugins: "Aucun plugin installe",
      noPluginsHint: "Placez les dossiers de plugins dans server/plugins pour commencer. Consultez la documentation pour creer vos propres plugins.",
      activePlugins: "Plugins actifs",
      availablePlugins: "Plugins disponibles",
      enable: "Activer",
      disable: "Desactiver",
      enabled: "Le plugin {name} a ete active",
      disabled: "Le plugin {name} a ete desactive",
      deleted: "Le plugin {name} a ete supprime",
      installTitle: "Installer un plugin",
      installHint: "Televersez un package .pg pour l'installer sur le serveur.",
      installButton: "Installer",
      installing: "Installation...",
      installMissing: "Veuillez selectionner un fichier .pg.",
      delete: "Supprimer",
      deleteConfirm: "Supprimer le plugin {name} ?",
      system: "SYSTEME",
      active: "Actif",
      author: "Auteur",
      permissions: "Permissions",
      validationErrors: "Erreurs de validation",
      developingTitle: "Developpez votre propre plugin",
      developingHint: "Creez des integrations personnalisees, des outils de surveillance ou des fonctions d'automatisation. Des plugins professionnels avec support entreprise sont aussi disponibles.",
      documentation: "Documentation Plugins",
      professional: "Plugins Professionnels"
    },
    ssl: {
      title: "Configuration SSL/TLS",
      enabled: "HTTPS active",
      keyPath: "Chemin cle privee",
      certPath: "Chemin certificat",
      caPath: "Chemin chaine CA (optionnel)",
      httpsPort: "Port HTTPS",
      redirectHttp: "Rediriger HTTP vers HTTPS",
      generateSelfSigned: "Generer certificat auto-signe",
      letsEncrypt: "Instructions Let's Encrypt"
    },
    agentLocalWeb: {
      title: "Interface web locale de l'agent",
      enabled: "Activer l'interface web locale",
      port: "Port web local",
      portHint: "Ports autorises: 8080, 8090, 8180, 8190",
      perAgentInfo: "L'interface web locale est maintenant configuree par agent. Allez dans les details d'un agent pour activer/desactiver l'interface web locale pour cet agent specifique.",
      feature1: "Activer/desactiver individuellement pour chaque agent",
      feature2: "Configuration automatique du pare-feu (ufw, firewalld, iptables)",
      feature3: "Authentification avec les utilisateurs Linux du systeme (PAM)",
      feature4: "Acces direct a http://AGENT_IP:PORT",
      configureHint: "Naviguez vers Dashboard → Details de l'agent pour configurer le web local pour chaque agent."
    },
    packagesAll: {
      title: "Tous les paquets",
      subtitle: "Vue agrégée des paquets installés et des mises à jour sur toutes les machines.",
      scanFleet: "Scanner la flotte",
      scanning: "Scan en cours...",
      scanHint: "Actualise les données de paquets sur toutes les machines (appareils en ligne uniquement).",
      tabInstalled: "Installés",
      tabUpdates: "Mises à jour",
      noDataInstalled: "Aucune donnée de paquets pour le moment. Lancez un scan de la flotte pour lister les paquets installés sur toutes les machines.",
      noDataUpdates: "Aucune donnée de mise à jour pour le moment. Lancez un scan de la flotte (ou une recherche de MAJ) pour voir les paquets à mettre à jour.",
      noUpdates: "Toutes les machines sont à jour.",
      pkgCol: "Paquet",
      machinesCol: "Machines",
      affectedMachines: "Machines affectées",
      installedOn: "Installé sur",
      selectPkg: "Sélectionner",
      selectAll: "Tout sélectionner",
      clearSelection: "Effacer la sélection",
      updateSelected: "Mettre à jour la sélection",
      updateAll: "Tout mettre à jour",
      updateAllDesc: "Lancer la mise à jour des paquets sélectionnés sur toutes les machines affectées ?",
      updateAllDescAll: "Lancer la mise à jour de TOUS les paquets listés sur toutes les machines affectées ?",
      noSelection: "Sélectionnez au moins un paquet à mettre à jour.",
      updateQueued: "Mise à jour en file sur {n} machine(s).",
      updateQueuedShort: "En file",
      machines: "machine(s)",
      machinesListTitle: "Machines affectées",
      details: "Détails",
      close: "Fermer",
      versions: "Versions",
      scanned: "{scanned}/{total} machines scannées",
      onePerLine: "Un paquet par ligne",
      updated: "Mis \u00e0 jour",
      hosts: "h\u00f4tes",
      security: "S\u00e9curit\u00e9",
      securityOnly: "S\u00e9curit\u00e9 seulement",
      searchPlaceholder: "Rechercher un paquet\u2026",
      sortImpact: "Les plus impactants d\u2019abord",
      sortName: "Alphab\u00e9tique",
      sortHint: "Basculer entre l\u2019impact et l\u2019ordre alphab\u00e9tique",
      patchSecurity: "Appliquer les correctifs de s\u00e9curit\u00e9",
      patchSecurityDesc: "Mettre en file les {n} mise(s) \u00e0 jour de s\u00e9curit\u00e9 sur toutes les machines concern\u00e9es. C\u2019est le moyen le plus rapide de fermer les vuln\u00e9rabilit\u00e9s connues sur le parc.",
      tileSecurity: "Mises \u00e0 jour de s\u00e9curit\u00e9",
      tileSecurityHint: "{n} h\u00f4te(s) concern\u00e9(s)",
      tileUpdates: "Mises \u00e0 jour disponibles",
      tileUpdatesHint: "{n} h\u00f4te(s) concern\u00e9(s)",
      tileScanned: "H\u00f4tes analys\u00e9s",
      tileInstalled: "Paquets distincts",
      noMatch: "Aucun paquet ne correspond \u00e0 vos filtres.",
      noMatchHint: "Essayez un autre terme, ou d\u00e9sactivez le filtre \u00ab\u00a0s\u00e9curit\u00e9 seulement\u00a0\u00bb.",
      noUpdatesHint: "Toutes les machines analys\u00e9es ont les derniers paquets offerts par leurs d\u00e9p\u00f4ts.",
      noDataInstalledHint: "Lancez une analyse du parc pour r\u00e9cup\u00e9rer la liste des paquets install\u00e9s sur chaque machine.",
      scanPhaseList: "{n} machine(s) \u2014 liste des paquets en cours\u2026",
      scanPhaseUpdates: "Recherche des mises \u00e0 jour en cours\u2026",
      scanDone: "Analyse du parc termin\u00e9e.",
      scanFailed: "L\u2019analyse du parc n\u2019a pas abouti."
    },
    packagesHub: {
      subtitle: "Choisissez une machine pour lister, chercher et installer ou retirer ses logiciels. Vous cherchez tout le parc d\u2019un coup\u00a0? Utilisez la vue flotte.",
      viewFleet: "Voir tout le parc",
      filterPlaceholder: "Filtrer par nom, h\u00f4te ou IP\u2026",
      noAgents: "Aucune machine ne correspond \u00e0 votre recherche",
      noAgentsHint: "Essayez un autre nom, h\u00f4te ou IP \u2014 ou ajoutez une machine depuis la page Ajouter un agent.",
      manage: "G\u00e9rer les logiciels"
    },
    metrics: {
      cpu: "CPU",
      memory: "RAM",
      disk: "Disque",
      load: "Charge",
      swap: "Swap",
      noData: "Aucune métrique reçue pour l’instant",
      noDataHint: "Cette machine n’a pas encore contacté le tableau de bord avec un agent assez récent pour rapporter ses signes vitaux. Mettez l’agent à jour pour commencer la collecte.",
      title: "Signes vitaux en direct",
      subtitle: "Rapportés par l’agent à chaque contact.",
      updatedAt: "Mis à jour {time}",
      history: "Dernières 24 heures",
      processes: "Processus",
      sessions: "Sessions",
      fleetTitle: "Santé du parc",
      underPressure: "Machines sous pression",
      allHealthy: "Toutes les machines qui rapportent sont dans les limites normales.",
      retentionTitle: "Rétention de l’historique des métriques",
      retentionDays: "Conserver l’historique (jours)",
      retentionHint: "Durée pendant laquelle le tableau de bord conserve les relevés CPU, mémoire et disque de chaque machine. Un relevé est stocké toutes les 5 minutes par machine."
    },
    language: {
      toggle: "EN"
    }
  }
};

const I18nContext = createContext(null);

function getInitialLang() {
  if (typeof window === "undefined") {
    return "en";
  }
  const saved = window.localStorage.getItem("aaul.lang");
  if (saved) {
    return saved;
  }
  const browserLang = navigator.language || "en";
  return browserLang.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function resolveMessage(lang, key) {
  const dictionary = translations[lang] || translations.en;
  return key.split(".").reduce((acc, part) => {
    if (!acc || acc[part] === undefined) {
      return null;
    }
    return acc[part];
  }, dictionary);
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(getInitialLang());

  const setLang = (value) => {
    setLangState(value);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aaul.lang", value);
    }
  };

  const toggleLang = () => {
    setLang(lang === "fr" ? "en" : "fr");
  };

  const t = (key, vars = {}) => {
    const template = resolveMessage(lang, key) || resolveMessage("en", key) || key;
    return Object.entries(vars).reduce((result, [name, value]) => {
      return result.split(`{${name}}`).join(String(value));
    }, template);
  };

  const value = useMemo(
    () => ({ lang, setLang, toggleLang, t }),
    [lang]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
