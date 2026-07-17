/**
 * Patch notes / changelog.
 *
 * Single source of truth for the in-app changelog shown when clicking the
 * version in the footer. Keep entries ordered NEWEST FIRST — add new releases
 * at the top of the array.
 *
 * Each entry: { version, date (YYYY-MM-DD), title?, changes: string[] }
 */
export const CHANGELOG = [
  {
    version: "0.10.9",
    date: "2026-07-13",
    title: "Notes de version complètes",
    changes: [
      "Ajout des notes de version manquantes de 0.10.2 à 0.10.8.",
      "La version actuellement installée est maintenant correctement identifiée dans les patch notes.",
    ],
  },
  {
    version: "0.10.8",
    date: "2026-07-13",
    title: "Configuration Email & SMS",
    changes: [
      "Restauration de la configuration SMTP complète : serveur, port, TLS, identifiants, expéditeur et destinataires.",
      "Restauration de la configuration Twilio : Account SID, Auth Token et numéros d'envoi et de destination.",
      "Ajout du routage des alertes, de la validation des champs et de messages d'erreur utiles lors des tests Email et SMS.",
    ],
  },
  {
    version: "0.10.7",
    date: "2026-07-13",
    title: "Liste complète des agents",
    changes: [
      "La liste détaillée affiche maintenant tous les agents dans la page, sans zone de défilement vertical interne.",
      "Le défilement horizontal demeure disponible pour consulter toutes les colonnes du mode détaillé.",
    ],
  },
  {
    version: "0.10.6",
    date: "2026-07-13",
    title: "Ergonomie du tableau et de la navigation",
    changes: [
      "Amélioration de l'affichage compact du tableau détaillé et de son défilement horizontal.",
      "Le bloc utilisateur et le bouton de déconnexion ont été remontés sous la navigation pour rester facilement accessibles.",
    ],
  },
  {
    version: "0.10.5",
    date: "2026-07-13",
    title: "Correctifs de l'écran vide",
    changes: [
      "Correctif : ajout de l'icône Activity manquante qui faisait disparaître l'interface après la connexion.",
      "Correctif : suppression d'une référence invalide dans la barre d'information de l'hôte.",
    ],
  },
  {
    version: "0.10.4",
    date: "2026-07-13",
    title: "Stabilité de la mise à jour automatique",
    changes: [
      "Correction de la validation des commandes UPDATE_AGENT générées par le dashboard.",
      "Ajout de tests de régression et détection par l'installateur d'un service qui plante après son redémarrage.",
    ],
  },
  {
    version: "0.10.3",
    date: "2026-07-13",
    title: "Installation de Node.js",
    changes: [
      "Correction de l'installation NodeSource lorsque install.sh est déjà exécuté en tant que root.",
      "Mise à niveau automatique vers une version de Node.js compatible avec le build du dashboard.",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-07-13",
    title: "Nouvelle interface et pipeline de release",
    changes: [
      "Intégration de la nouvelle interface du dashboard.",
      "Amélioration des modes installation et mise à jour afin de préserver la configuration et de reconstruire le dashboard et le bundle agent.",
      "Les archives de release incluent maintenant les artefacts de production validés. Agent mis à jour en version 0.7.6.",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-06-03",
    title: "Cohérence MAJ & versionnage pré-1.0",
    changes: [
      "Correctif : l'onglet « Mises à jour » relance un scan à l'ouverture (depuis le badge « MAJ requise ») pour afficher l'état réel et resynchroniser le badge du tableau de bord.",
      "Versionnage : le produit étant encore en développement (non officiellement disponible en production), la numérotation repasse en pré-1.0 (dashboard 0.x, agent 0.x). La 1.0 marquera la sortie officielle.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-06-03",
    title: "Groupes, vues & ordre personnalisé",
    changes: [
      "Vues par onglets : Tout · Par OS · Par groupe.",
      "Groupes de machines : créer / renommer / supprimer, et affecter chaque machine à un groupe.",
      "Actions de groupe : lancer Rechercher MAJ / Mettre à jour / Rafraîchir infos / MAJ agent sur toutes les machines d'un groupe en un clic.",
      "Vue « Tout » : réordonner les machines par glisser-déposer (ordre global persistant).",
    ],
  },
  {
    version: "0.9.7",
    date: "2026-06-03",
    title: "Recherche & application des mises à jour",
    changes: [
      "Nouvelle action « Rechercher des MAJ » : scanne chaque appareil pour les mises à jour disponibles, sans rien installer.",
      "Les appareils avec des MAJ affichent « Mise à jour requise » → clic = onglet « Mises à jour » de la machine.",
      "Onglet « Mises à jour » : cocher des paquets et « Mettre à jour la sélection », ou « Tout mettre à jour » (mise à jour système complète).",
      "Carte « Agents obsolètes » renommée et affichée uniquement s'il y en a ; nouvelle carte « Mise à jour requise ».",
      "Correctif macOS : le nombre de paquets installés (Homebrew) s'affiche correctement.",
    ],
  },
  {
    version: "0.9.6",
    date: "2026-06-02",
    title: "Agent multi-tâche (heartbeat)",
    changes: [
      "L'agent reste désormais « En ligne » pendant l'exécution d'une commande longue (mise à jour système…) : un battement de cœur rafraîchit l'état en continu, tandis que la commande s'exécute dans un thread dédié (une seule à la fois).",
      "Plus aucune fausse alerte « hors-ligne » pendant les updates, et les ressources/état restent à jour en temps réel.",
    ],
  },
  {
    version: "0.9.5",
    date: "2026-06-02",
    title: "Journaux de l'interface locale",
    changes: [
      "Correctif : l'onglet « Journaux » de l'interface web locale de l'agent était vide — il lisait un fichier inexistant. Il affiche désormais le journal daté le plus récent.",
    ],
  },
  {
    version: "0.9.4",
    date: "2026-06-02",
    title: "macOS (brew) & faux « hors-ligne »",
    changes: [
      "Correctif macOS : Homebrew est désormais détecté même quand l'agent tourne en root (chemins /opt/homebrew, /usr/local) et exécuté sous le bon utilisateur (brew refuse root). Lister/installer/désinstaller via brew fonctionne.",
      "Correctif : un agent occupé par une commande longue (ex. mise à jour système) n'est plus signalé « hors-ligne » à tort — donc plus de fausse alerte pendant les updates.",
    ],
  },
  {
    version: "0.9.3",
    date: "2026-06-02",
    title: "Correctif signatures (FETCH_INFO & co.)",
    changes: [
      "Correctif : les commandes renvoyant des données avec caractères non-ASCII ou nombres décimaux (ex. FETCH_INFO : modèle CPU « Intel® », % d'utilisation) n'aboutissaient pas — la signature de la requête était rejetée. Le serveur vérifie désormais les octets bruts du corps (insensible au formatage JSON Python/Node).",
      "Compatibilité conservée avec les agents déjà déployés (double vérification).",
      "Agent mis à jour en 0.7.1.",
    ],
  },
  {
    version: "0.9.2",
    date: "2026-06-02",
    title: "Notifications typées & anti-spam",
    changes: [
      "Notifications par type : hors-ligne, retour en ligne, mise à jour disponible, autres — chacune activable et routable par canal (Email / SMS).",
      "Anti-spam : une seule alerte par problème. Pour « hors-ligne », ré-alerte au plus une fois par intervalle configurable (ex. 60 min) ; 0 = une seule fois.",
      "Le retour en ligne ré-arme l'alerte hors-ligne (la prochaine panne notifie à nouveau).",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-06-02",
    title: "Correctif communication agents",
    changes: [
      "Correctif majeur : le dashboard signe désormais ses réponses à l'agent (HMAC). Les agents qui exigeaient une réponse signée (versions antérieures) cessaient sinon tout poll (« response signature verification failed ») — bloquant updates, paquets et toutes les commandes. Ils se mettent maintenant à jour et fonctionnent à nouveau.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-06-02",
    title: "Surveillance, notifications & gestion de paquets",
    changes: [
      "Nouveau : gestion de paquets à distance par agent — lister, rechercher, installer/désinstaller (opt-in par agent, paquets critiques au boot bloqués), aussi disponible depuis l'interface web locale de l'agent. Accessible via l'entrée « Paquets » du menu ou la fiche d'un agent.",
      "Correctif : la mise à jour des agents ne boucle plus indéfiniment (plus de re-création d'UPDATE_AGENT tant qu'une commande est en cours).",
      "Nouveau : surveillance des appareils hors-ligne (activable/désactivable, globalement et par appareil).",
      "Nouveau : notifications par Email (SMTP) et SMS (Twilio) sur perte/retour d'un agent.",
      "Nouveau : patch notes intégrés (cette fenêtre) accessibles depuis le pied de page.",
      "Sécurité : rejet des connexions console sans en-tête Origin, politique de mot de passe renforcée.",
      "Correctif : les mises à jour longues ne sont plus marquées en erreur prématurément.",
      "Agent mis à jour en version 0.7.0.",
    ],
  },
  {
    version: "0.8.4",
    date: "2026-05-20",
    title: "Alignement des versions",
    changes: [
      "Maintenance : harmonisation des numéros de version dashboard/agent et script de release.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-05-01",
    title: "Console & plugins",
    changes: [
      "Console locale interactive (terminal) réservée aux administrateurs.",
      "Système de plugins installables (.pg) avec activation/désactivation.",
      "Interface web locale par agent (état système, journaux, mise à jour).",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-03-15",
    title: "Multi-plateforme",
    changes: [
      "Support des agents macOS et Windows en plus de Linux.",
      "Auto-update des agents via bundle signé.",
      "Tableau de bord temps réel (SSE).",
    ],
  },
];
