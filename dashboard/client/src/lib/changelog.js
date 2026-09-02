/**
 * Patch notes / changelog — authoring source.
 *
 * This file is NOT bundled into the client. It is the source from which
 * `dashboard/scripts/generate-release-md.mjs` produces RELEASE.md, which is
 * what both the repository visitor and the running dashboard actually read.
 *
 * Keep entries ordered NEWEST FIRST — add new releases at the top.
 *
 * Each entry: {
 *   version, date (YYYY-MM-DD),
 *   title:   { fr, en },
 *   changes: { fr: string[], en: string[] }
 * }
 *
 * Both languages are required: RELEASE.md publishes a French and an English
 * section, and the dashboard shows whichever matches the user's language.
 */
export const CHANGELOG = [
  {
    version: "0.12.0",
    date: "2026-09-01",
    title: {
      fr: "Métriques des machines, sécurité des paquets et interface mobile",
      en: "Host metrics, package security and mobile interface",
    },
    changes: {
      fr: [
        "Signes vitaux en direct : chaque machine rapporte son CPU, sa mémoire, son disque et sa charge à chaque contact, visibles sur les cartes du tableau de bord et détaillés sur la page de la machine avec un historique de 24 heures.",
        "Nouveau panneau « Machines gérées » : moyennes du parc et liste des machines sous pression (CPU, mémoire ou disque au-delà des seuils).",
        "Les mises à jour de sécurité sont maintenant identifiées et mises en avant dans la vue Paquets, avec le nombre de machines concernées et un bouton pour appliquer uniquement les correctifs de sécurité.",
        "Rétention des logs configurable (par âge et par taille), appliquée localement par chaque agent. Le log du jour n'est jamais supprimé.",
        "Page Logs repensée : recherche, coloration par niveau, téléchargement et nettoyage immédiat d'une machine.",
        "Notification de nouvelle version : le tableau de bord signale discrètement qu'une version plus récente est publiée, avec vérification manuelle depuis cette fenêtre.",
        "Notes de version bilingues, publiées sur le dépôt et mises en cache localement pour rester consultables hors ligne.",
        "Interface utilisable sur mobile et tablette : le menu ne recouvre plus la page, se ferme à la navigation et le contenu s'adapte aux petits écrans.",
        "Interface web de l'agent : mise en page corrigée, fenêtres de confirmation intégrées à la page, et nouvelle action de redémarrage protégée par mot de passe administrateur.",
        "Correctif : les fenêtres modales s'affichaient hors écran sur les pages longues.",
        "Correctif : les paquets Homebrew versionnés (openssl@3) étaient refusés et faisaient échouer toute la mise à jour groupée.",
        "Correctif : la mise à jour groupée annonçait « 0 machine » sans expliquer que la gestion des paquets n'était pas activée sur les machines.",
        "Correctif : l'installation Windows s'interrompait sur une erreur pip ; Python est désormais détecté correctement et installé automatiquement si absent.",
        "Correctif : l'installation échouait silencieusement lorsque npm bloquait la compilation des modules natifs (sqlite3, bcrypt).",
        "Correctif : plusieurs libellés s'affichaient en anglais ou sous forme de clé brute en français.",
      ],
      en: [
        "Live vital signs: every machine reports CPU, memory, disk and load on each check-in, shown on the fleet cards and detailed on the machine page with 24 hours of history.",
        "New \"Managed machines\" panel: fleet averages and the list of hosts under pressure (CPU, memory or disk above threshold).",
        "Security updates are now identified and highlighted in the Packages view, with the number of affected machines and a button to apply only the security fixes.",
        "Configurable log retention (by age and by size), enforced locally by each agent. The current day's log is never deleted.",
        "Redesigned Logs page: search, level highlighting, download, and immediate cleanup of a machine.",
        "New-version notification: the dashboard discreetly reports when a newer version has been published, with a manual check from this window.",
        "Bilingual release notes, published in the repository and cached locally so they stay readable offline.",
        "Usable on phones and tablets: the menu no longer covers the page, closes on navigation, and content adapts to small screens.",
        "Agent web interface: layout fixed, confirmations moved into the page, and a new reboot action protected by an administrator password.",
        "Fix: modal windows opened off-screen on long pages.",
        "Fix: versioned Homebrew packages (openssl@3) were rejected and made the whole fleet update fail.",
        "Fix: the fleet update reported \"0 machines\" without explaining that package management was not enabled on them.",
        "Fix: the Windows install stopped on a pip error; Python is now detected properly and installed automatically when missing.",
        "Fix: the install failed silently when npm blocked the build of native modules (sqlite3, bcrypt).",
        "Fix: several labels appeared in English, or as a raw key in French.",
      ],
    },
  },
  {
    version: "0.11.0",
    date: "2026-08-14",
    title: {
      fr: "Gestion des paquets à l'échelle de la flotte",
      en: "Fleet-wide package management",
    },
    changes: {
      fr: [
        "Nouvelle vue « Tout » dans la section Paquets : agrégation des paquets installés et des mises à jour sur toutes les machines.",
        "Onglet « Installés » (vue Tout) : liste consolidée des paquets, avec indication des machines où chacun est installé.",
        "Onglet « Mises à jour » (vue Tout) : liste des paquets à mettre à jour avec le nombre de machines concernées, et détail des machines via une fenêtre dédiée.",
        "Mise à jour sélective ou complète des paquets sur toutes les machines ciblées, en un clic.",
        "Correctif : les fenêtres modales s'ouvrent désormais centrées à l'écran (le contenu long ne les poussait plus vers le bas).",
      ],
      en: [
        "New \"All\" view in the Packages section: installed packages and available updates aggregated across every machine.",
        "\"Installed\" tab (All view): consolidated package list, showing which machines have each one.",
        "\"Updates\" tab (All view): packages to update with the number of affected machines, and the machine list in a dedicated window.",
        "Update selected or all packages on every targeted machine in one click.",
        "Fix: modal windows now open centred on screen (long content no longer pushed them down).",
      ],
    },
  },
  {
    version: "0.10.9",
    date: "2026-07-13",
    title: { fr: "Notes de version complètes", en: "Complete release notes" },
    changes: {
      fr: [
        "Ajout des notes de version manquantes de 0.10.2 à 0.10.8.",
        "La version actuellement installée est maintenant correctement identifiée dans les patch notes.",
      ],
      en: [
        "Added the missing release notes from 0.10.2 to 0.10.8.",
        "The currently installed version is now correctly identified in the patch notes.",
      ],
    },
  },
  {
    version: "0.10.8",
    date: "2026-07-13",
    title: { fr: "Configuration Email & SMS", en: "Email & SMS configuration" },
    changes: {
      fr: [
        "Restauration de la configuration SMTP complète : serveur, port, TLS, identifiants, expéditeur et destinataires.",
        "Restauration de la configuration Twilio : Account SID, Auth Token et numéros d'envoi et de destination.",
        "Ajout du routage des alertes, de la validation des champs et de messages d'erreur utiles lors des tests Email et SMS.",
      ],
      en: [
        "Restored the full SMTP configuration: server, port, TLS, credentials, sender and recipients.",
        "Restored the Twilio configuration: Account SID, Auth Token, and sending and destination numbers.",
        "Added alert routing, field validation, and useful error messages during Email and SMS tests.",
      ],
    },
  },
  {
    version: "0.10.7",
    date: "2026-07-13",
    title: { fr: "Liste complète des agents", en: "Complete agent list" },
    changes: {
      fr: [
        "La liste détaillée affiche maintenant tous les agents dans la page, sans zone de défilement vertical interne.",
        "Le défilement horizontal demeure disponible pour consulter toutes les colonnes du mode détaillé.",
      ],
      en: [
        "The detailed list now shows every agent in the page, without an inner vertical scroll area.",
        "Horizontal scrolling remains available to reach all columns of the detailed mode.",
      ],
    },
  },
  {
    version: "0.10.6",
    date: "2026-07-13",
    title: {
      fr: "Ergonomie du tableau et de la navigation",
      en: "Table and navigation ergonomics",
    },
    changes: {
      fr: [
        "Amélioration de l'affichage compact du tableau détaillé et de son défilement horizontal.",
        "Le bloc utilisateur et le bouton de déconnexion ont été remontés sous la navigation pour rester facilement accessibles.",
      ],
      en: [
        "Improved the compact rendering of the detailed table and its horizontal scrolling.",
        "The user block and the logout button moved up under the navigation so they stay easy to reach.",
      ],
    },
  },
  {
    version: "0.10.5",
    date: "2026-07-13",
    title: { fr: "Correctifs de l'écran vide", en: "Blank-screen fixes" },
    changes: {
      fr: [
        "Correctif : ajout de l'icône Activity manquante qui faisait disparaître l'interface après la connexion.",
        "Correctif : suppression d'une référence invalide dans la barre d'information de l'hôte.",
      ],
      en: [
        "Fix: added the missing Activity icon that made the interface disappear after sign-in.",
        "Fix: removed an invalid reference in the host information bar.",
      ],
    },
  },
  {
    version: "0.10.4",
    date: "2026-07-13",
    title: {
      fr: "Stabilité de la mise à jour automatique",
      en: "Auto-update stability",
    },
    changes: {
      fr: [
        "Correction de la validation des commandes UPDATE_AGENT générées par le dashboard.",
        "Ajout de tests de régression et détection par l'installateur d'un service qui plante après son redémarrage.",
      ],
      en: [
        "Fixed validation of the UPDATE_AGENT commands generated by the dashboard.",
        "Added regression tests, and installer detection of a service that crashes after being restarted.",
      ],
    },
  },
  {
    version: "0.10.3",
    date: "2026-07-13",
    title: { fr: "Installation de Node.js", en: "Node.js installation" },
    changes: {
      fr: [
        "Correction de l'installation NodeSource lorsque install.sh est déjà exécuté en tant que root.",
        "Mise à niveau automatique vers une version de Node.js compatible avec le build du dashboard.",
      ],
      en: [
        "Fixed the NodeSource installation when install.sh is already running as root.",
        "Automatic upgrade to a Node.js version compatible with the dashboard build.",
      ],
    },
  },
  {
    version: "0.10.2",
    date: "2026-07-13",
    title: {
      fr: "Nouvelle interface et pipeline de release",
      en: "New interface and release pipeline",
    },
    changes: {
      fr: [
        "Intégration de la nouvelle interface du dashboard.",
        "Amélioration des modes installation et mise à jour afin de préserver la configuration et de reconstruire le dashboard et le bundle agent.",
        "Les archives de release incluent maintenant les artefacts de production validés. Agent mis à jour en version 0.7.6.",
      ],
      en: [
        "Integrated the new dashboard interface.",
        "Improved the install and update modes so they preserve the configuration and rebuild both the dashboard and the agent bundle.",
        "Release archives now include the validated production artifacts. Agent updated to 0.7.6.",
      ],
    },
  },
  {
    version: "0.10.1",
    date: "2026-06-03",
    title: {
      fr: "Cohérence MAJ & versionnage pré-1.0",
      en: "Update consistency & pre-1.0 versioning",
    },
    changes: {
      fr: [
        "Correctif : l'onglet « Mises à jour » relance un scan à l'ouverture (depuis le badge « MAJ requise ») pour afficher l'état réel et resynchroniser le badge du tableau de bord.",
        "Versionnage : le produit étant encore en développement (non officiellement disponible en production), la numérotation repasse en pré-1.0 (dashboard 0.x, agent 0.x). La 1.0 marquera la sortie officielle.",
      ],
      en: [
        "Fix: the \"Updates\" tab re-runs a scan when opened (from the \"Update required\" badge) to show the real state and resynchronise the dashboard badge.",
        "Versioning: as the product is still in development (not officially available in production), numbering returns to pre-1.0 (dashboard 0.x, agent 0.x). 1.0 will mark the official release.",
      ],
    },
  },
  {
    version: "0.10.0",
    date: "2026-06-03",
    title: {
      fr: "Groupes, vues & ordre personnalisé",
      en: "Groups, views & custom ordering",
    },
    changes: {
      fr: [
        "Vues par onglets : Tout · Par OS · Par groupe.",
        "Groupes de machines : créer / renommer / supprimer, et affecter chaque machine à un groupe.",
        "Actions de groupe : lancer Rechercher MAJ / Mettre à jour / Rafraîchir infos / MAJ agent sur toutes les machines d'un groupe en un clic.",
        "Vue « Tout » : réordonner les machines par glisser-déposer (ordre global persistant).",
      ],
      en: [
        "Tabbed views: All · By OS · By group.",
        "Machine groups: create / rename / delete, and assign each machine to a group.",
        "Group actions: run Check updates / Update / Refresh info / Update agent on every machine of a group in one click.",
        "\"All\" view: reorder machines by drag and drop (persistent global ordering).",
      ],
    },
  },
  {
    version: "0.9.7",
    date: "2026-06-03",
    title: {
      fr: "Recherche & application des mises à jour",
      en: "Finding & applying updates",
    },
    changes: {
      fr: [
        "Nouvelle action « Rechercher des MAJ » : scanne chaque appareil pour les mises à jour disponibles, sans rien installer.",
        "Les appareils avec des MAJ affichent « Mise à jour requise » → clic = onglet « Mises à jour » de la machine.",
        "Onglet « Mises à jour » : cocher des paquets et « Mettre à jour la sélection », ou « Tout mettre à jour » (mise à jour système complète).",
        "Carte « Agents obsolètes » renommée et affichée uniquement s'il y en a ; nouvelle carte « Mise à jour requise ».",
        "Correctif macOS : le nombre de paquets installés (Homebrew) s'affiche correctement.",
      ],
      en: [
        "New \"Check for updates\" action: scans every device for available updates without installing anything.",
        "Devices with updates show \"Update required\" — clicking opens that machine's \"Updates\" tab.",
        "\"Updates\" tab: tick packages and \"Update selection\", or \"Update all\" (full system update).",
        "The \"Outdated agents\" card was renamed and only appears when there are any; new \"Update required\" card.",
        "macOS fix: the installed package count (Homebrew) now displays correctly.",
      ],
    },
  },
  {
    version: "0.9.6",
    date: "2026-06-02",
    title: { fr: "Agent multi-tâche (heartbeat)", en: "Multitasking agent (heartbeat)" },
    changes: {
      fr: [
        "L'agent reste désormais « En ligne » pendant l'exécution d'une commande longue (mise à jour système…) : un battement de cœur rafraîchit l'état en continu, tandis que la commande s'exécute dans un thread dédié (une seule à la fois).",
        "Plus aucune fausse alerte « hors-ligne » pendant les updates, et les ressources/état restent à jour en temps réel.",
      ],
      en: [
        "The agent now stays \"Online\" while a long command runs (a system update…): a heartbeat keeps refreshing the state while the command executes in a dedicated thread (one at a time).",
        "No more false \"offline\" alerts during updates, and resources and state stay current in real time.",
      ],
    },
  },
  {
    version: "0.9.5",
    date: "2026-06-02",
    title: { fr: "Journaux de l'interface locale", en: "Local interface logs" },
    changes: {
      fr: [
        "Correctif : l'onglet « Journaux » de l'interface web locale de l'agent était vide — il lisait un fichier inexistant. Il affiche désormais le journal daté le plus récent.",
      ],
      en: [
        "Fix: the \"Logs\" tab of the agent's local web interface was empty — it read a file that did not exist. It now shows the most recent dated log.",
      ],
    },
  },
  {
    version: "0.9.4",
    date: "2026-06-02",
    title: {
      fr: "macOS (brew) & faux « hors-ligne »",
      en: "macOS (brew) & false \"offline\"",
    },
    changes: {
      fr: [
        "Correctif macOS : Homebrew est désormais détecté même quand l'agent tourne en root (chemins /opt/homebrew, /usr/local) et exécuté sous le bon utilisateur (brew refuse root). Lister/installer/désinstaller via brew fonctionne.",
        "Correctif : un agent occupé par une commande longue (ex. mise à jour système) n'est plus signalé « hors-ligne » à tort — donc plus de fausse alerte pendant les updates.",
      ],
      en: [
        "macOS fix: Homebrew is now detected even when the agent runs as root (/opt/homebrew, /usr/local paths) and executed as the right user (brew refuses root). Listing, installing and removing through brew works.",
        "Fix: an agent busy with a long command (e.g. a system update) is no longer wrongly reported \"offline\" — so no more false alerts during updates.",
      ],
    },
  },
  {
    version: "0.9.3",
    date: "2026-06-02",
    title: {
      fr: "Correctif signatures (FETCH_INFO & co.)",
      en: "Signature fix (FETCH_INFO and others)",
    },
    changes: {
      fr: [
        "Correctif : les commandes renvoyant des données avec caractères non-ASCII ou nombres décimaux (ex. FETCH_INFO : modèle CPU « Intel® », % d'utilisation) n'aboutissaient pas — la signature de la requête était rejetée. Le serveur vérifie désormais les octets bruts du corps (insensible au formatage JSON Python/Node).",
        "Compatibilité conservée avec les agents déjà déployés (double vérification).",
        "Agent mis à jour en 0.7.1.",
      ],
      en: [
        "Fix: commands returning data with non-ASCII characters or decimal numbers (e.g. FETCH_INFO: CPU model \"Intel®\", usage percentages) never completed — the request signature was rejected. The server now verifies the raw body bytes (insensitive to Python/Node JSON formatting).",
        "Compatibility kept with already deployed agents (dual verification).",
        "Agent updated to 0.7.1.",
      ],
    },
  },
  {
    version: "0.9.2",
    date: "2026-06-02",
    title: {
      fr: "Notifications typées & anti-spam",
      en: "Typed notifications & anti-spam",
    },
    changes: {
      fr: [
        "Notifications par type : hors-ligne, retour en ligne, mise à jour disponible, autres — chacune activable et routable par canal (Email / SMS).",
        "Anti-spam : une seule alerte par problème. Pour « hors-ligne », ré-alerte au plus une fois par intervalle configurable (ex. 60 min) ; 0 = une seule fois.",
        "Le retour en ligne ré-arme l'alerte hors-ligne (la prochaine panne notifie à nouveau).",
      ],
      en: [
        "Notifications by type: offline, back online, update available, other — each one can be enabled and routed per channel (Email / SMS).",
        "Anti-spam: one alert per problem. For \"offline\", re-alert at most once per configurable interval (e.g. 60 min); 0 = once only.",
        "Coming back online re-arms the offline alert (the next outage notifies again).",
      ],
    },
  },
  {
    version: "0.9.1",
    date: "2026-06-02",
    title: {
      fr: "Correctif communication agents",
      en: "Agent communication fix",
    },
    changes: {
      fr: [
        "Correctif majeur : le dashboard signe désormais ses réponses à l'agent (HMAC). Les agents qui exigeaient une réponse signée (versions antérieures) cessaient sinon tout poll (« response signature verification failed ») — bloquant updates, paquets et toutes les commandes. Ils se mettent maintenant à jour et fonctionnent à nouveau.",
      ],
      en: [
        "Major fix: the dashboard now signs its responses to the agent (HMAC). Agents that required a signed response (earlier versions) otherwise stopped polling entirely (\"response signature verification failed\") — blocking updates, packages and every command. They now update themselves and work again.",
      ],
    },
  },
  {
    version: "0.9.0",
    date: "2026-06-02",
    title: {
      fr: "Surveillance, notifications & gestion de paquets",
      en: "Monitoring, notifications & package management",
    },
    changes: {
      fr: [
        "Nouveau : gestion de paquets à distance par agent — lister, rechercher, installer/désinstaller (opt-in par agent, paquets critiques au boot bloqués), aussi disponible depuis l'interface web locale de l'agent. Accessible via l'entrée « Paquets » du menu ou la fiche d'un agent.",
        "Correctif : la mise à jour des agents ne boucle plus indéfiniment (plus de re-création d'UPDATE_AGENT tant qu'une commande est en cours).",
        "Nouveau : surveillance des appareils hors-ligne (activable/désactivable, globalement et par appareil).",
        "Nouveau : notifications par Email (SMTP) et SMS (Twilio) sur perte/retour d'un agent.",
        "Nouveau : patch notes intégrés (cette fenêtre) accessibles depuis le pied de page.",
        "Sécurité : rejet des connexions console sans en-tête Origin, politique de mot de passe renforcée.",
        "Correctif : les mises à jour longues ne sont plus marquées en erreur prématurément.",
        "Agent mis à jour en version 0.7.0.",
      ],
      en: [
        "New: remote per-agent package management — list, search, install and remove (per-agent opt-in, boot-critical packages blocked), also available from the agent's local web interface. Reachable from the \"Packages\" menu entry or an agent's page.",
        "Fix: agent updates no longer loop forever (no more re-creating UPDATE_AGENT while a command is running).",
        "New: offline device monitoring (can be enabled or disabled globally and per device).",
        "New: Email (SMTP) and SMS (Twilio) notifications when an agent goes down or comes back.",
        "New: built-in patch notes (this window), reachable from the footer.",
        "Security: console connections without an Origin header are rejected, and the password policy was strengthened.",
        "Fix: long updates are no longer marked as failed prematurely.",
        "Agent updated to 0.7.0.",
      ],
    },
  },
  {
    version: "0.8.4",
    date: "2026-05-20",
    title: { fr: "Alignement des versions", en: "Version alignment" },
    changes: {
      fr: [
        "Maintenance : harmonisation des numéros de version dashboard/agent et script de release.",
      ],
      en: [
        "Maintenance: harmonised the dashboard and agent version numbers, and the release script.",
      ],
    },
  },
  {
    version: "0.5.0",
    date: "2026-05-01",
    title: { fr: "Console & plugins", en: "Console & plugins" },
    changes: {
      fr: [
        "Console locale interactive (terminal) réservée aux administrateurs.",
        "Système de plugins installables (.pg) avec activation/désactivation.",
        "Interface web locale par agent (état système, journaux, mise à jour).",
      ],
      en: [
        "Interactive local console (terminal), restricted to administrators.",
        "Installable plugin system (.pg) with enable and disable.",
        "Per-agent local web interface (system state, logs, update).",
      ],
    },
  },
  {
    version: "0.3.0",
    date: "2026-03-15",
    title: { fr: "Multi-plateforme", en: "Multi-platform" },
    changes: {
      fr: [
        "Support des agents macOS et Windows en plus de Linux.",
        "Auto-update des agents via bundle signé.",
        "Tableau de bord temps réel (SSE).",
      ],
      en: [
        "Support for macOS and Windows agents in addition to Linux.",
        "Agent auto-update through a signed bundle.",
        "Real-time dashboard (SSE).",
      ],
    },
  },
];
