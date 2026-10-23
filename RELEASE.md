---
dashboard: 0.16.1
agent: 0.13.0
date: 2026-10-23
---

<!--
  Fichier GENERE - ne pas modifier a la main.
  Source : dashboard/client/src/lib/changelog.js + les fichiers VERSION.
  Regenerer avec :  cd dashboard && npm run gen:release
-->

# AAUL — Notes de version / Release notes

Ce fichier est la référence de version consultée par chaque installation AAUL pour savoir si une mise à jour est disponible. Il est aussi la source des notes affichées dans l'application.

| Composant / Component | Version |
|-----------------------|---------|
| Dashboard | `0.16.1` |
| Agent     | `0.13.0` |

```bash
cd ~/AAUL && git pull && ./install.sh
```

## Français

### v0.16.1 — 2026-10-23 — Vérification des nouvelles versions depuis GitHub

- Correctif : la vérification des nouvelles versions échouait avec « HTTP 502 », car elle interrogeait encore l'ancien serveur git.auxinux.ca, qui n'existe plus. Elle lit désormais RELEASE.md sur le dépôt GitHub du projet.
- Une source de version enregistrée à la main qui pointe vers l'ancien serveur est ignorée au profit du dépôt officiel, au lieu d'échouer à chaque vérification.
- Un échec « HTTP 404 » précise désormais que le fichier est introuvable ou que le dépôt n'est pas public.
- Les liens vers le dépôt du projet et le signalement de vulnérabilités pointent vers GitHub.

### v0.16.0 — 2026-09-11 — File d'attente de commandes par machine

- Nouveau : plusieurs commandes peuvent être envoyées à une même machine. Elles attendent leur tour dans une file et s'exécutent l'une après l'autre, dans l'ordre d'envoi, au lieu d'être refusées parce qu'une commande est déjà en cours.
- La file compte au plus 10 commandes par machine. Une commande identique déjà en attente n'est pas ajoutée une seconde fois, et plus rien n'est accepté après une désinstallation.
- L'agent enchaîne les commandes dès que la précédente est terminée, sans attendre son intervalle de contact.
- Le tableau de bord indique combien de commandes attendent derrière celle en cours, et la page Tâches permet d'annuler chacune d'elles. Une commande qui attend son tour n'est plus annoncée comme un délai dépassé.
- Les actions en masse — mise à jour des agents, vérification des mises à jour, inventaire des paquets, actions de groupe — rejoignent la file des machines occupées au lieu de les ignorer.
- L'enchaînement immédiat nécessite l'agent 0.13.0, que les machines récupèrent d'elles-mêmes. Avec un agent plus ancien la file fonctionne aussi, à raison d'une commande par intervalle de contact.

### v0.15.1 — 2026-09-11 — Vérification horaire sans antivirus

- Correctif : sur une machine sans antivirus, la vérification toutes les 60 minutes pouvait être activée alors qu'il n'y avait rien à vérifier. Elle est désormais désactivée et verrouillée tant qu'aucun antivirus n'est détecté.
- Si un antivirus apparaît ensuite — installé par AAUL, ou à la main puis détecté par une vérification — la vérification horaire se réactive d'elle-même. Tant qu'un antivirus est présent, le réglage choisi à la main est conservé.

### v0.15.0 — 2026-09-11 — Surveillance de l'antivirus : vérification horaire, temps réel et ClamAV

- Nouveau : la santé de l'antivirus est vérifiée automatiquement toutes les 60 minutes, réglable machine par machine. Au premier contact, le tableau de bord vérifie si la machine a un antivirus : la vérification horaire est activée s'il en trouve un, désactivée sinon. Un réglage fait à la main n'est jamais écrasé.
- Nouveau : lorsque la protection en temps réel est inactive et que l'antivirus le permet, le tableau de bord propose de l'activer ou d'ignorer. Ignorer est réversible : l'activation reste disponible. Microsoft Defender et le scan à l'accès de ClamAV (clamonacc) sont pris en charge ; une protection coupée par une stratégie de groupe Windows n'est pas proposée à la réactivation.
- Sécurité : la protection en temps réel ne peut pas être désactivée depuis le tableau de bord. Aucune commande ne le permet : cela reste une opération à faire sur la machine elle-même.
- Nouveau : sur une machine Linux sans antivirus, la fiche propose d'installer ClamAV — une proposition discrète, jamais automatique, qui peut être masquée. L'installation reste légère : l'analyse à la demande et la mise à jour des signatures, sans le service résident qui occupe environ 1 Go de mémoire. Aucun dépôt n'est ajouté : si ClamAV n'est pas disponible dans les dépôts de la machine (Red Hat sans EPEL, par exemple), rien n'est proposé.
- Nouveau : la surveillance de l'antivirus peut être désactivée pour toute l'installation depuis la page Admin. Plus aucune vérification ni proposition n'est alors faite.
- Correctif : les boutons de la carte Antivirus (vérifier, scan rapide, scan complet) s'affichaient sans leur mise en forme.
- Nécessite l'agent 0.12.0, que les machines récupèrent d'elles-mêmes par la mise à jour automatique des agents.

### v0.14.0 — 2026-09-11 — Santé de l'antivirus et scan à distance

- Nouveau : la fiche de chaque machine affiche la santé de son antivirus — produit, protection en temps réel, fraîcheur des signatures, dernier scan et menaces détectées — avec la raison de chaque alerte. ClamAV sous Linux, Microsoft Defender sous Windows, XProtect sous macOS. Une suite tierce qui remplace Defender est reconnue comme telle au lieu d'être signalée « aucun antivirus ».
- Nouveau : un scan rapide ou complet peut être lancé à distance depuis la fiche machine. Un scan complet peut durer des heures : il n'est plus déclaré en échec au bout de 30 minutes.
- Correctif : l'intervalle de contact des agents pouvait être réglé sous 5 secondes, ce qui figeait le tableau de bord. Le minimum de 5 secondes s'applique désormais au réglage global comme aux nouvelles installations, et les agents l'imposent aussi eux-mêmes.
- Sécurité : lorsqu'un plugin d'isolation multi-tenant est installé, la configuration du serveur, la gestion des plugins, les notifications et les réglages globaux sont réservés à l'administrateur système. Les événements en temps réel d'une machine ne sont plus envoyés qu'aux utilisateurs autorisés à la voir.
- Nécessite l'agent 0.11.0, que les machines récupèrent d'elles-mêmes par la mise à jour automatique des agents.

### v0.13.8 — 2026-09-03 — Recherche de paquets et comptage sur Windows

- Correctif : une recherche de paquets sans résultat était présentée comme une panne, avec un code d'erreur brut à la place de « Aucun résultat ». winget signale l'absence de correspondance par un code de sortie dédié, désormais reconnu comme une réponse valide — pour la recherche comme pour la vérification des mises à jour.
- Correctif : quand une commande winget échouait, l'agent ne remontait que « exit status » suivi d'un nombre, en jetant le message de winget. L'erreur transmise au tableau de bord contient maintenant la sortie réelle.
- La carte « Paquets » d'une machine affiche « aucune information » au lieu de « 0 installés » lorsque le comptage a échoué. Un zéro était indiscernable d'une machine réellement vide.

### v0.13.7 — 2026-09-03 — Liste des paquets Windows enfin fonctionnelle

- Correctif : la liste, la recherche et les mises à jour de paquets ne renvoyaient jamais rien sur Windows. L'agent découpait la sortie de winget en supprimant tout ce qui précédait le dernier retour chariot de chaque ligne — ce qui est juste pour les barres de progression, mais vide intégralement toute ligne terminée par un retour chariot, c'est-à-dire toutes les lignes produites par Windows.
- Les paquets dont l'identifiant contient des espaces (pilotes, entrées de désinstallation Windows) sont désormais lus correctement.

### v0.13.6 — 2026-09-03 — Liste des paquets Windows : un échec silencieux

- Correctif : sur Windows, « Charger la liste » pouvait sembler ne rien faire. Quand l'agent n'arrivait pas à lire la sortie de winget, il renvoyait une liste vide sans erreur — et l'écran affichait alors le même message que si le bouton n'avait jamais été cliqué.
- L'agent distingue désormais « aucun paquet » de « sortie illisible ». Dans le second cas il remonte une erreur contenant le binaire winget utilisé et sa sortie brute, de quoi diagnostiquer sans deviner.
- L'interface indique explicitement quand la machine a répondu sans signaler aucun paquet, au lieu de réafficher l'invitation initiale.

### v0.13.5 — 2026-09-03 — Un seul endroit pour le numéro de version

- Correctif : le numéro de version affiché en bas de l'interface pouvait rester une version en retard. Un fichier .env créé au premier déploiement et jamais mis à jour figeait la valeur utilisée à la compilation.
- Le numéro de version n'existe plus qu'à un seul endroit par composant : dashboard/VERSION et agent/app/VERSION. L'installateur, l'interface et les notes de version lisent ces fichiers directement, au lieu d'en recopier la valeur. Une vérification échoue désormais si une copie dérive.

### v0.13.4 — 2026-09-03 — Résolution de winget sous le compte système

- Correctif : sur Windows, les commandes de paquets lancées depuis le tableau de bord pouvaient échouer sur « Le chemin d'accès spécifié est introuvable », alors que la même opération fonctionnait depuis une console d'administrateur. Le service tourne sous le compte système, pour lequel le raccourci « winget » du PATH n'existe pas ; l'agent retombait sur le dossier d'App Installer sans vérifier que ce chemin était réellement exécutable dans ce contexte.
- L'agent essaie désormais tous les emplacements possibles et valide chacun en exécutant réellement winget, au lieu de se fier au premier chemin trouvé. En cas d'échec total, l'erreur remontée au tableau de bord liste chaque chemin essayé et la raison de son refus.

### v0.13.3 — 2026-09-03 — L'agent Windows ne lisait pas sa configuration

- Correctif : l'agent Windows s'installait correctement mais refusait ensuite sa propre configuration (« invalid character \ufeff »). Windows PowerShell 5.1 ajoute une marque d'ordre d'octets aux fichiers qu'il écrit, contrairement à PowerShell 7 — le fichier dépendait donc du shell utilisé. L'installateur écrit maintenant un fichier propre, et l'agent accepte cette marque quelle que soit sa provenance, y compris sur un fichier ouvert dans le Bloc-notes.
- L'installateur signale désormais explicitement l'échec du premier contact avec le dashboard au lieu d'annoncer une réussite.

### v0.13.2 — 2026-09-03 — Commande d'installation Windows

- Correctif : sur certaines machines, la commande d'installation Windows ne faisait rien et Windows affichait « Sélectionnez une application pour ouvrir powershell ». Elle relançait un PowerShell imbriqué, inutile puisque la commande se lance déjà depuis PowerShell, et dépendait donc du nom « powershell » résolvable dans le PATH. Elle s'exécute maintenant directement dans la session en cours.
- Correctif : l'installation échouait aussi lorsque le profil de l'utilisateur contenait une espace (« C:\Users\Jean Dupont »), le chemin du script temporaire étant alors coupé en deux. Le chemin est désormais protégé, et le script est supprimé après l'installation puisqu'il contient le jeton de l'agent.

### v0.13.1 — 2026-09-03 — Consigne d'installation Windows périmée

- Correctif : la page d'ajout d'une machine annonçait encore que Python serait installé automatiquement sur Windows. L'agent Windows est un exécutable autonome depuis la version 0.13.0 : seuls des droits d'administrateur sont nécessaires.

### v0.13.0 — 2026-09-03 — Agent Windows réécrit en Go

- L'agent Windows est désormais un exécutable autonome unique. Il n'y a plus rien à installer au préalable : ni Python, ni environnement virtuel, ni pip, ni tar. C'était la cause de la quasi-totalité des échecs d'installation sur Windows.
- L'agent tourne comme un vrai service Windows (« AgentAutoUpdate »), visible dans services.msc, démarré au démarrage de la machine et relancé automatiquement par Windows en cas d'arrêt anormal — au lieu d'une tâche planifiée.
- La mise à jour quotidienne est gérée par le service lui-même et rattrapée si la machine était éteinte au moment prévu. Il n'y a plus de seconde tâche planifiée susceptible de se désynchroniser de la configuration.
- Mise à niveau depuis l'ancien agent : lancez simplement la nouvelle commande d'installation. Les anciennes tâches planifiées et l'environnement Python sont supprimés, la configuration et l'historique des logs sont conservés, et la machine reste le même agent dans le tableau de bord.
- Les mesures (processeur, mémoire, disque) et l'inventaire sont lus directement auprès de Windows. L'ancien agent lançait PowerShell à chaque relève, soit environ 5 700 démarrages d'interpréteur par jour sur chaque machine.
- L'inventaire Windows est plus précis : version exacte de Windows, redémarrage en attente détecté dans les trois emplacements où Windows l'enregistre, et tous les disques fixes suivis au lieu du seul lecteur C:.
- La liste et la recherche de paquets renvoient enfin des identifiants winget exploitables : installer un paquet trouvé par la recherche fonctionne désormais sur Windows.
- La commande « aaul-agent run --console » exécute l'agent au premier plan avec son journal à l'écran, pour diagnostiquer une machine sans passer par le service.
- Correctif : winget est introuvable pour le compte système sous lequel tourne le service ; il est maintenant localisé dans le dossier d'App Installer en plus du PATH.
- Correctif : un nom d'affichage accentué réintroduisait des caractères non-ASCII dans le script d'installation Windows. Ces valeurs sont désormais encodées, et le script reste lisible par PowerShell 5.1 même si la marque d'ordre d'octets est perdue.

### v0.12.4 — 2026-09-02 — Tests réels de l'installateur Windows

- L'installateur Windows est désormais analysé par le vrai analyseur PowerShell et couvert par des tests fonctionnels (détection de Python, rejet de l'alias du Microsoft Store, sortie de winget correctement isolée). Ces vérifications s'exécutent quand PowerShell est présent sur la machine de développement et sont ignorées sinon.

### v0.12.3 — 2026-09-02 — Installateur Windows : chemin de Python

- Correctif : après l'installation automatique de Python, l'installateur Windows utilisait le rapport de winget comme chemin d'interpréteur et échouait sur « n'est pas reconnu comme nom d'applet de commande ». La sortie de winget est désormais capturée, et le chemin retourné est validé avant usage.

### v0.12.2 — 2026-09-02 — Correctif de l'installateur Windows

- Correctif : le script d'installation Windows ne s'exécutait pas (« Le terminateur ' est manquant dans la chaîne »). PowerShell 5.1 lit un .ps1 sans marque d'ordre d'octets comme du Windows-1252 : un seul caractère accentué se transformait en guillemet typographique, que PowerShell prend pour un délimiteur de chaîne. Le script est désormais servi avec une marque UTF-8 et ne contient que de l'ASCII.

### v0.12.1 — 2026-09-02 — Alignement du menu réduit

- Correctif : dans la barre latérale réduite, la surbrillance de l'élément sélectionné ou survolé était décalée par rapport à l'icône. Les entrées du menu, le bouton de déconnexion et le bouton de repli sont maintenant centrés.

### v0.12.0 — 2026-09-01 — Métriques des machines, sécurité des paquets et interface mobile

- Signes vitaux en direct : chaque machine rapporte son CPU, sa mémoire, son disque et sa charge à chaque contact, visibles sur les cartes du tableau de bord et détaillés sur la page de la machine avec un historique de 24 heures.
- Nouveau panneau « Machines gérées » : moyennes du parc et liste des machines sous pression (CPU, mémoire ou disque au-delà des seuils).
- Les mises à jour de sécurité sont maintenant identifiées et mises en avant dans la vue Paquets, avec le nombre de machines concernées et un bouton pour appliquer uniquement les correctifs de sécurité.
- Rétention des logs configurable (par âge et par taille), appliquée localement par chaque agent. Le log du jour n'est jamais supprimé.
- Page Logs repensée : recherche, coloration par niveau, téléchargement et nettoyage immédiat d'une machine.
- Notification de nouvelle version : le tableau de bord signale discrètement qu'une version plus récente est publiée, avec vérification manuelle depuis cette fenêtre.
- Notes de version bilingues, publiées sur le dépôt et mises en cache localement pour rester consultables hors ligne.
- Interface utilisable sur mobile et tablette : le menu ne recouvre plus la page, se ferme à la navigation et le contenu s'adapte aux petits écrans.
- Interface web de l'agent : mise en page corrigée, fenêtres de confirmation intégrées à la page, et nouvelle action de redémarrage protégée par mot de passe administrateur.
- Correctif : les fenêtres modales s'affichaient hors écran sur les pages longues.
- Correctif : les paquets Homebrew versionnés (openssl@3) étaient refusés et faisaient échouer toute la mise à jour groupée.
- Correctif : la mise à jour groupée annonçait « 0 machine » sans expliquer que la gestion des paquets n'était pas activée sur les machines.
- Correctif : l'installation Windows s'interrompait sur une erreur pip ; Python est désormais détecté correctement et installé automatiquement si absent.
- Correctif : l'installation échouait silencieusement lorsque npm bloquait la compilation des modules natifs (sqlite3, bcrypt).
- Correctif : plusieurs libellés s'affichaient en anglais ou sous forme de clé brute en français.

### v0.11.0 — 2026-08-14 — Gestion des paquets à l'échelle de la flotte

- Nouvelle vue « Tout » dans la section Paquets : agrégation des paquets installés et des mises à jour sur toutes les machines.
- Onglet « Installés » (vue Tout) : liste consolidée des paquets, avec indication des machines où chacun est installé.
- Onglet « Mises à jour » (vue Tout) : liste des paquets à mettre à jour avec le nombre de machines concernées, et détail des machines via une fenêtre dédiée.
- Mise à jour sélective ou complète des paquets sur toutes les machines ciblées, en un clic.
- Correctif : les fenêtres modales s'ouvrent désormais centrées à l'écran (le contenu long ne les poussait plus vers le bas).

### v0.10.9 — 2026-07-13 — Notes de version complètes

- Ajout des notes de version manquantes de 0.10.2 à 0.10.8.
- La version actuellement installée est maintenant correctement identifiée dans les patch notes.

### v0.10.8 — 2026-07-13 — Configuration Email & SMS

- Restauration de la configuration SMTP complète : serveur, port, TLS, identifiants, expéditeur et destinataires.
- Restauration de la configuration Twilio : Account SID, Auth Token et numéros d'envoi et de destination.
- Ajout du routage des alertes, de la validation des champs et de messages d'erreur utiles lors des tests Email et SMS.

### v0.10.7 — 2026-07-13 — Liste complète des agents

- La liste détaillée affiche maintenant tous les agents dans la page, sans zone de défilement vertical interne.
- Le défilement horizontal demeure disponible pour consulter toutes les colonnes du mode détaillé.

### v0.10.6 — 2026-07-13 — Ergonomie du tableau et de la navigation

- Amélioration de l'affichage compact du tableau détaillé et de son défilement horizontal.
- Le bloc utilisateur et le bouton de déconnexion ont été remontés sous la navigation pour rester facilement accessibles.

### v0.10.5 — 2026-07-13 — Correctifs de l'écran vide

- Correctif : ajout de l'icône Activity manquante qui faisait disparaître l'interface après la connexion.
- Correctif : suppression d'une référence invalide dans la barre d'information de l'hôte.

### v0.10.4 — 2026-07-13 — Stabilité de la mise à jour automatique

- Correction de la validation des commandes UPDATE_AGENT générées par le dashboard.
- Ajout de tests de régression et détection par l'installateur d'un service qui plante après son redémarrage.

### v0.10.3 — 2026-07-13 — Installation de Node.js

- Correction de l'installation NodeSource lorsque install.sh est déjà exécuté en tant que root.
- Mise à niveau automatique vers une version de Node.js compatible avec le build du dashboard.

### v0.10.2 — 2026-07-13 — Nouvelle interface et pipeline de release

- Intégration de la nouvelle interface du dashboard.
- Amélioration des modes installation et mise à jour afin de préserver la configuration et de reconstruire le dashboard et le bundle agent.
- Les archives de release incluent maintenant les artefacts de production validés. Agent mis à jour en version 0.7.6.

### v0.10.1 — 2026-06-03 — Cohérence MAJ & versionnage pré-1.0

- Correctif : l'onglet « Mises à jour » relance un scan à l'ouverture (depuis le badge « MAJ requise ») pour afficher l'état réel et resynchroniser le badge du tableau de bord.
- Versionnage : le produit étant encore en développement (non officiellement disponible en production), la numérotation repasse en pré-1.0 (dashboard 0.x, agent 0.x). La 1.0 marquera la sortie officielle.

### v0.10.0 — 2026-06-03 — Groupes, vues & ordre personnalisé

- Vues par onglets : Tout · Par OS · Par groupe.
- Groupes de machines : créer / renommer / supprimer, et affecter chaque machine à un groupe.
- Actions de groupe : lancer Rechercher MAJ / Mettre à jour / Rafraîchir infos / MAJ agent sur toutes les machines d'un groupe en un clic.
- Vue « Tout » : réordonner les machines par glisser-déposer (ordre global persistant).

### v0.9.7 — 2026-06-03 — Recherche & application des mises à jour

- Nouvelle action « Rechercher des MAJ » : scanne chaque appareil pour les mises à jour disponibles, sans rien installer.
- Les appareils avec des MAJ affichent « Mise à jour requise » → clic = onglet « Mises à jour » de la machine.
- Onglet « Mises à jour » : cocher des paquets et « Mettre à jour la sélection », ou « Tout mettre à jour » (mise à jour système complète).
- Carte « Agents obsolètes » renommée et affichée uniquement s'il y en a ; nouvelle carte « Mise à jour requise ».
- Correctif macOS : le nombre de paquets installés (Homebrew) s'affiche correctement.

### v0.9.6 — 2026-06-02 — Agent multi-tâche (heartbeat)

- L'agent reste désormais « En ligne » pendant l'exécution d'une commande longue (mise à jour système…) : un battement de cœur rafraîchit l'état en continu, tandis que la commande s'exécute dans un thread dédié (une seule à la fois).
- Plus aucune fausse alerte « hors-ligne » pendant les updates, et les ressources/état restent à jour en temps réel.

### v0.9.5 — 2026-06-02 — Journaux de l'interface locale

- Correctif : l'onglet « Journaux » de l'interface web locale de l'agent était vide — il lisait un fichier inexistant. Il affiche désormais le journal daté le plus récent.

### v0.9.4 — 2026-06-02 — macOS (brew) & faux « hors-ligne »

- Correctif macOS : Homebrew est désormais détecté même quand l'agent tourne en root (chemins /opt/homebrew, /usr/local) et exécuté sous le bon utilisateur (brew refuse root). Lister/installer/désinstaller via brew fonctionne.
- Correctif : un agent occupé par une commande longue (ex. mise à jour système) n'est plus signalé « hors-ligne » à tort — donc plus de fausse alerte pendant les updates.

### v0.9.3 — 2026-06-02 — Correctif signatures (FETCH_INFO & co.)

- Correctif : les commandes renvoyant des données avec caractères non-ASCII ou nombres décimaux (ex. FETCH_INFO : modèle CPU « Intel® », % d'utilisation) n'aboutissaient pas — la signature de la requête était rejetée. Le serveur vérifie désormais les octets bruts du corps (insensible au formatage JSON Python/Node).
- Compatibilité conservée avec les agents déjà déployés (double vérification).
- Agent mis à jour en 0.7.1.

### v0.9.2 — 2026-06-02 — Notifications typées & anti-spam

- Notifications par type : hors-ligne, retour en ligne, mise à jour disponible, autres — chacune activable et routable par canal (Email / SMS).
- Anti-spam : une seule alerte par problème. Pour « hors-ligne », ré-alerte au plus une fois par intervalle configurable (ex. 60 min) ; 0 = une seule fois.
- Le retour en ligne ré-arme l'alerte hors-ligne (la prochaine panne notifie à nouveau).

### v0.9.1 — 2026-06-02 — Correctif communication agents

- Correctif majeur : le dashboard signe désormais ses réponses à l'agent (HMAC). Les agents qui exigeaient une réponse signée (versions antérieures) cessaient sinon tout poll (« response signature verification failed ») — bloquant updates, paquets et toutes les commandes. Ils se mettent maintenant à jour et fonctionnent à nouveau.

### v0.9.0 — 2026-06-02 — Surveillance, notifications & gestion de paquets

- Nouveau : gestion de paquets à distance par agent — lister, rechercher, installer/désinstaller (opt-in par agent, paquets critiques au boot bloqués), aussi disponible depuis l'interface web locale de l'agent. Accessible via l'entrée « Paquets » du menu ou la fiche d'un agent.
- Correctif : la mise à jour des agents ne boucle plus indéfiniment (plus de re-création d'UPDATE_AGENT tant qu'une commande est en cours).
- Nouveau : surveillance des appareils hors-ligne (activable/désactivable, globalement et par appareil).
- Nouveau : notifications par Email (SMTP) et SMS (Twilio) sur perte/retour d'un agent.
- Nouveau : patch notes intégrés (cette fenêtre) accessibles depuis le pied de page.
- Sécurité : rejet des connexions console sans en-tête Origin, politique de mot de passe renforcée.
- Correctif : les mises à jour longues ne sont plus marquées en erreur prématurément.
- Agent mis à jour en version 0.7.0.

### v0.8.4 — 2026-05-20 — Alignement des versions

- Maintenance : harmonisation des numéros de version dashboard/agent et script de release.

### v0.5.0 — 2026-05-01 — Console & plugins

- Console locale interactive (terminal) réservée aux administrateurs.
- Système de plugins installables (.pg) avec activation/désactivation.
- Interface web locale par agent (état système, journaux, mise à jour).

### v0.3.0 — 2026-03-15 — Multi-plateforme

- Support des agents macOS et Windows en plus de Linux.
- Auto-update des agents via bundle signé.
- Tableau de bord temps réel (SSE).

## English

### v0.16.1 — 2026-10-23 — New-version check from GitHub

- Fix: the new-version check failed with "HTTP 502" because it still queried the former git.auxinux.ca server, which no longer exists. It now reads RELEASE.md from the project's GitHub repository.
- A version source saved by hand that points at the former server is ignored in favour of the official repository, instead of failing every check.
- An "HTTP 404" failure now says that the file was not found or that the repository is not public.
- Links to the project repository and to vulnerability reporting point at GitHub.

### v0.16.0 — 2026-09-11 — Per-machine command queue

- New: several commands can be sent to the same machine. They wait their turn in a queue and run one after another, in the order they were sent, instead of being refused because a command is already running.
- The queue holds at most 10 commands per machine. An identical command already waiting is not added twice, and nothing is accepted after an uninstall.
- The agent chains commands as soon as the previous one finishes, without waiting for its check-in interval.
- The dashboard shows how many commands are waiting behind the running one, and the Tasks page can cancel each of them. A command waiting its turn is no longer reported as timed out.
- Bulk actions -- agent updates, update checks, package inventory, group actions -- join the queue of busy machines instead of skipping them.
- Chaining commands immediately requires agent 0.13.0, which machines pick up on their own. With an older agent the queue works too, one command per check-in interval.

### v0.15.1 — 2026-09-11 — Hourly check without an antivirus

- Fix: on a machine without an antivirus, the 60-minute check could be turned on although there was nothing to check. It is now off and locked for as long as no antivirus is detected.
- If an antivirus shows up later -- installed through AAUL, or by hand and then picked up by a check -- the hourly check turns itself back on. While an antivirus is present, a setting chosen by hand is kept.

### v0.15.0 — 2026-09-11 — Antivirus monitoring: hourly checks, real-time protection and ClamAV

- New: antivirus health is checked automatically every 60 minutes, configurable machine by machine. On first contact the dashboard checks whether the machine has an antivirus: the hourly check is turned on if one is found, off otherwise. A setting changed by hand is never overwritten.
- New: when real-time protection is off and the antivirus allows it, the dashboard offers to turn it on or to ignore it. Ignoring is reversible: the enable action stays available. Microsoft Defender and ClamAV on-access scanning (clamonacc) are supported; protection turned off by a Windows Group Policy is not offered for re-enabling.
- Security: real-time protection cannot be turned off from the dashboard. No command allows it -- it remains something to do on the machine itself.
- New: on a Linux machine without an antivirus, the machine's page offers to install ClamAV -- a discreet offer, never automatic, that can be dismissed. The install stays light: on-demand scanning and signature updates, without the resident service that takes around 1 GB of memory. No repository is ever added: if ClamAV is not available from the machine's repositories (Red Hat without EPEL, for instance), nothing is offered.
- New: antivirus monitoring can be turned off for the whole installation from the Admin page. No check or offer is made at all then.
- Fix: the Antivirus card buttons (check, quick scan, full scan) were displayed without their styling.
- Requires agent 0.12.0, which machines pick up on their own through automatic agent updates.

### v0.14.0 — 2026-09-11 — Antivirus health and remote scans

- New: each machine's page shows the health of its antivirus -- product, real-time protection, signature freshness, last scan and detected threats -- with the reason behind every alert. ClamAV on Linux, Microsoft Defender on Windows, XProtect on macOS. A third-party suite that replaces Defender is recognised as such instead of being reported as "no antivirus".
- New: a quick or full scan can be started remotely from the machine's page. A full scan can take hours: it is no longer reported as failed after 30 minutes.
- Fix: the agent check-in interval could be set below 5 seconds, which froze the dashboard. The 5-second minimum now applies to the global setting and to new installs alike, and the agents enforce it themselves as well.
- Security: when a multi-tenant isolation plugin is installed, server configuration, plugin management, notifications and global settings are restricted to the system administrator. A machine's real-time events are only sent to users allowed to see it.
- Requires agent 0.11.0, which machines pick up on their own through automatic agent updates.

### v0.13.8 — 2026-09-03 — Package search and count on Windows

- Fix: a package search with no match was presented as a failure, showing a raw error code instead of "no results". winget signals a lack of matches with a dedicated exit code, now recognised as a valid answer -- for search as well as for update checks.
- Fix: when a winget command failed, the agent reported only "exit status" followed by a number, discarding winget's message. The error sent to the dashboard now carries the real output.
- A machine's "Packages" card shows "no info" rather than "0 installed" when the count failed. A zero was indistinguishable from a genuinely empty machine.

### v0.13.7 — 2026-09-03 — Windows package list finally works

- Fix: package listing, search and updates never returned anything on Windows. The agent split winget's output by dropping everything before the last carriage return on each line -- correct for progress bars, but it emptied every line ending in a carriage return, which is every line Windows produces.
- Packages whose identifier contains spaces (drivers, Windows uninstall entries) are now read correctly.

### v0.13.6 — 2026-09-03 — Windows package list: a silent failure

- Fix: on Windows, "Load list" could look like it did nothing. When the agent could not read winget's output it returned an empty list with no error -- and the screen then showed the same message as if the button had never been clicked.
- The agent now tells "no packages" apart from "unreadable output". In the second case it reports an error carrying the winget binary it used and the raw output, enough to diagnose without guessing.
- The interface now says explicitly when the machine answered but reported no packages, instead of showing the initial prompt again.

### v0.13.5 — 2026-09-03 — One place for the version number

- Fix: the version shown at the bottom of the interface could stay a release behind. A .env file created on first deployment and never refreshed pinned the value used at build time.
- The version number now exists in exactly one place per component: dashboard/VERSION and agent/app/VERSION. The installer, the interface and the release notes read those files directly instead of copying the value. A check now fails if any copy drifts.

### v0.13.4 — 2026-09-03 — winget resolution under the system account

- Fix: on Windows, package commands issued from the dashboard could fail with "the specified path could not be found" while the same operation worked from an administrator console. The service runs under the system account, for which the `winget` PATH shortcut does not exist; the agent fell back to the App Installer folder without checking that the path was actually executable in that context.
- The agent now tries every possible location and validates each by actually running winget, instead of trusting the first path it finds. When none works, the error reported to the dashboard lists every path tried and why each was refused.

### v0.13.3 — 2026-09-03 — The Windows agent could not read its configuration

- Fix: the Windows agent installed correctly but then rejected its own configuration ("invalid character \ufeff"). Windows PowerShell 5.1 adds a byte-order mark to the files it writes, unlike PowerShell 7 -- so the file depended on which shell ran the installer. The installer now writes a clean file, and the agent accepts that mark whatever wrote it, including a file opened in Notepad.
- The installer now reports a failed first contact with the dashboard explicitly, instead of announcing success.

### v0.13.2 — 2026-09-03 — Windows install command

- Fix: on some machines the Windows install command did nothing and Windows showed "Select an app to open powershell". It spawned a nested PowerShell -- pointless, since the command is already run from PowerShell -- and therefore depended on the name "powershell" resolving on PATH. It now runs directly in the current session.
- Fix: the install also failed when the user profile contained a space ("C:\Users\Jean Dupont"), because the temporary script path was split in two. The path is now quoted, and the script is deleted after the install since it carries the agent token.

### v0.13.1 — 2026-09-03 — Stale Windows install note

- Fix: the add-machine page still announced that Python would be installed automatically on Windows. The Windows agent has been a self-contained executable since 0.13.0: administrator rights are the only requirement.

### v0.13.0 — 2026-09-03 — Windows agent rewritten in Go

- The Windows agent is now a single self-contained executable. There is nothing to install first: no Python, no virtual environment, no pip, no tar. That bootstrap was the cause of nearly every failed Windows installation.
- The agent runs as a real Windows service ("AgentAutoUpdate"), visible in services.msc, started at boot and automatically restarted by Windows if it ever stops unexpectedly — instead of a scheduled task.
- The daily update is handled by the service itself, and caught up if the machine was off when the window passed. There is no second scheduled task that can drift out of sync with the configuration.
- Upgrading from the previous agent: just run the new install command. The old scheduled tasks and Python environment are removed, the configuration and log history are kept, and the machine stays the same agent in the dashboard.
- Metrics (CPU, memory, disk) and inventory are read directly from Windows. The previous agent launched PowerShell on every check-in, roughly 5,700 interpreter starts per day on each machine.
- Windows inventory is more accurate: exact Windows version, pending reboot detected in all three places Windows records it, and every fixed disk tracked instead of only the C: drive.
- Package listing and search finally return usable winget identifiers, so installing a package found through search now works on Windows.
- The new "aaul-agent run --console" command runs the agent in the foreground with its log on screen, to diagnose a machine without going through the service.
- Fix: winget was not resolvable from the system account the service runs under; it is now located in the App Installer folder as well as on PATH.
- Fix: an accented display name put non-ASCII characters back into the Windows install script. Those values are now encoded, so the script stays readable by PowerShell 5.1 even if the byte-order mark is lost.

### v0.12.4 — 2026-09-02 — Real tests for the Windows installer

- The Windows installer is now parsed by PowerShell's own parser and covered by functional tests (Python detection, Microsoft Store alias rejection, winget output correctly isolated). These checks run when PowerShell is present on the development machine and are skipped otherwise.

### v0.12.3 — 2026-09-02 — Windows installer: Python path

- Fix: after installing Python automatically, the Windows installer used winget's report as the interpreter path and failed with "is not recognized as the name of a cmdlet". winget's output is now captured, and the returned path is validated before use.

### v0.12.2 — 2026-09-02 — Windows installer fix

- Fix: the Windows installer script failed to run ("The string is missing the terminator"). PowerShell 5.1 reads a .ps1 without a byte-order mark as Windows-1252, so a single accented character turned into a typographic quote, which PowerShell treats as a string delimiter. The script is now served with a UTF-8 mark and contains ASCII only.

### v0.12.1 — 2026-09-02 — Collapsed menu alignment

- Fix: in the collapsed sidebar, the highlight of the selected or hovered item was offset from its icon. Menu entries, the logout button and the collapse button are now centred.

### v0.12.0 — 2026-09-01 — Host metrics, package security and mobile interface

- Live vital signs: every machine reports CPU, memory, disk and load on each check-in, shown on the fleet cards and detailed on the machine page with 24 hours of history.
- New "Managed machines" panel: fleet averages and the list of hosts under pressure (CPU, memory or disk above threshold).
- Security updates are now identified and highlighted in the Packages view, with the number of affected machines and a button to apply only the security fixes.
- Configurable log retention (by age and by size), enforced locally by each agent. The current day's log is never deleted.
- Redesigned Logs page: search, level highlighting, download, and immediate cleanup of a machine.
- New-version notification: the dashboard discreetly reports when a newer version has been published, with a manual check from this window.
- Bilingual release notes, published in the repository and cached locally so they stay readable offline.
- Usable on phones and tablets: the menu no longer covers the page, closes on navigation, and content adapts to small screens.
- Agent web interface: layout fixed, confirmations moved into the page, and a new reboot action protected by an administrator password.
- Fix: modal windows opened off-screen on long pages.
- Fix: versioned Homebrew packages (openssl@3) were rejected and made the whole fleet update fail.
- Fix: the fleet update reported "0 machines" without explaining that package management was not enabled on them.
- Fix: the Windows install stopped on a pip error; Python is now detected properly and installed automatically when missing.
- Fix: the install failed silently when npm blocked the build of native modules (sqlite3, bcrypt).
- Fix: several labels appeared in English, or as a raw key in French.

### v0.11.0 — 2026-08-14 — Fleet-wide package management

- New "All" view in the Packages section: installed packages and available updates aggregated across every machine.
- "Installed" tab (All view): consolidated package list, showing which machines have each one.
- "Updates" tab (All view): packages to update with the number of affected machines, and the machine list in a dedicated window.
- Update selected or all packages on every targeted machine in one click.
- Fix: modal windows now open centred on screen (long content no longer pushed them down).

### v0.10.9 — 2026-07-13 — Complete release notes

- Added the missing release notes from 0.10.2 to 0.10.8.
- The currently installed version is now correctly identified in the patch notes.

### v0.10.8 — 2026-07-13 — Email & SMS configuration

- Restored the full SMTP configuration: server, port, TLS, credentials, sender and recipients.
- Restored the Twilio configuration: Account SID, Auth Token, and sending and destination numbers.
- Added alert routing, field validation, and useful error messages during Email and SMS tests.

### v0.10.7 — 2026-07-13 — Complete agent list

- The detailed list now shows every agent in the page, without an inner vertical scroll area.
- Horizontal scrolling remains available to reach all columns of the detailed mode.

### v0.10.6 — 2026-07-13 — Table and navigation ergonomics

- Improved the compact rendering of the detailed table and its horizontal scrolling.
- The user block and the logout button moved up under the navigation so they stay easy to reach.

### v0.10.5 — 2026-07-13 — Blank-screen fixes

- Fix: added the missing Activity icon that made the interface disappear after sign-in.
- Fix: removed an invalid reference in the host information bar.

### v0.10.4 — 2026-07-13 — Auto-update stability

- Fixed validation of the UPDATE_AGENT commands generated by the dashboard.
- Added regression tests, and installer detection of a service that crashes after being restarted.

### v0.10.3 — 2026-07-13 — Node.js installation

- Fixed the NodeSource installation when install.sh is already running as root.
- Automatic upgrade to a Node.js version compatible with the dashboard build.

### v0.10.2 — 2026-07-13 — New interface and release pipeline

- Integrated the new dashboard interface.
- Improved the install and update modes so they preserve the configuration and rebuild both the dashboard and the agent bundle.
- Release archives now include the validated production artifacts. Agent updated to 0.7.6.

### v0.10.1 — 2026-06-03 — Update consistency & pre-1.0 versioning

- Fix: the "Updates" tab re-runs a scan when opened (from the "Update required" badge) to show the real state and resynchronise the dashboard badge.
- Versioning: as the product is still in development (not officially available in production), numbering returns to pre-1.0 (dashboard 0.x, agent 0.x). 1.0 will mark the official release.

### v0.10.0 — 2026-06-03 — Groups, views & custom ordering

- Tabbed views: All · By OS · By group.
- Machine groups: create / rename / delete, and assign each machine to a group.
- Group actions: run Check updates / Update / Refresh info / Update agent on every machine of a group in one click.
- "All" view: reorder machines by drag and drop (persistent global ordering).

### v0.9.7 — 2026-06-03 — Finding & applying updates

- New "Check for updates" action: scans every device for available updates without installing anything.
- Devices with updates show "Update required" — clicking opens that machine's "Updates" tab.
- "Updates" tab: tick packages and "Update selection", or "Update all" (full system update).
- The "Outdated agents" card was renamed and only appears when there are any; new "Update required" card.
- macOS fix: the installed package count (Homebrew) now displays correctly.

### v0.9.6 — 2026-06-02 — Multitasking agent (heartbeat)

- The agent now stays "Online" while a long command runs (a system update…): a heartbeat keeps refreshing the state while the command executes in a dedicated thread (one at a time).
- No more false "offline" alerts during updates, and resources and state stay current in real time.

### v0.9.5 — 2026-06-02 — Local interface logs

- Fix: the "Logs" tab of the agent's local web interface was empty — it read a file that did not exist. It now shows the most recent dated log.

### v0.9.4 — 2026-06-02 — macOS (brew) & false "offline"

- macOS fix: Homebrew is now detected even when the agent runs as root (/opt/homebrew, /usr/local paths) and executed as the right user (brew refuses root). Listing, installing and removing through brew works.
- Fix: an agent busy with a long command (e.g. a system update) is no longer wrongly reported "offline" — so no more false alerts during updates.

### v0.9.3 — 2026-06-02 — Signature fix (FETCH_INFO and others)

- Fix: commands returning data with non-ASCII characters or decimal numbers (e.g. FETCH_INFO: CPU model "Intel®", usage percentages) never completed — the request signature was rejected. The server now verifies the raw body bytes (insensitive to Python/Node JSON formatting).
- Compatibility kept with already deployed agents (dual verification).
- Agent updated to 0.7.1.

### v0.9.2 — 2026-06-02 — Typed notifications & anti-spam

- Notifications by type: offline, back online, update available, other — each one can be enabled and routed per channel (Email / SMS).
- Anti-spam: one alert per problem. For "offline", re-alert at most once per configurable interval (e.g. 60 min); 0 = once only.
- Coming back online re-arms the offline alert (the next outage notifies again).

### v0.9.1 — 2026-06-02 — Agent communication fix

- Major fix: the dashboard now signs its responses to the agent (HMAC). Agents that required a signed response (earlier versions) otherwise stopped polling entirely ("response signature verification failed") — blocking updates, packages and every command. They now update themselves and work again.

### v0.9.0 — 2026-06-02 — Monitoring, notifications & package management

- New: remote per-agent package management — list, search, install and remove (per-agent opt-in, boot-critical packages blocked), also available from the agent's local web interface. Reachable from the "Packages" menu entry or an agent's page.
- Fix: agent updates no longer loop forever (no more re-creating UPDATE_AGENT while a command is running).
- New: offline device monitoring (can be enabled or disabled globally and per device).
- New: Email (SMTP) and SMS (Twilio) notifications when an agent goes down or comes back.
- New: built-in patch notes (this window), reachable from the footer.
- Security: console connections without an Origin header are rejected, and the password policy was strengthened.
- Fix: long updates are no longer marked as failed prematurely.
- Agent updated to 0.7.0.

### v0.8.4 — 2026-05-20 — Version alignment

- Maintenance: harmonised the dashboard and agent version numbers, and the release script.

### v0.5.0 — 2026-05-01 — Console & plugins

- Interactive local console (terminal), restricted to administrators.
- Installable plugin system (.pg) with enable and disable.
- Per-agent local web interface (system state, logs, update).

### v0.3.0 — 2026-03-15 — Multi-platform

- Support for macOS and Windows agents in addition to Linux.
- Agent auto-update through a signed bundle.
- Real-time dashboard (SSE).
