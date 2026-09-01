---
dashboard: 0.12.0
agent: 0.9.1
date: 2026-09-01
---

<!--
  Fichier GENERE - ne pas modifier a la main.
  Source : dashboard/client/src/lib/changelog.js + les fichiers VERSION.
  Regenerer avec :  cd dashboard && npm run gen:release
-->

# AAUL — Versions publiées

Ce fichier est la référence de version consultée par chaque installation AAUL pour savoir si une mise à jour est disponible.

| Composant | Version publiée |
|-----------|-----------------|
| Dashboard | `0.12.0` |
| Agent     | `0.9.1` |

Pour mettre à jour une installation existante :

```bash
cd ~/AAUL && git pull && ./install.sh
```

## Notes de version

### v0.12.0 — 2026-09-01 — Métriques des machines, sécurité des paquets et interface mobile

- Signes vitaux en direct : chaque machine rapporte son CPU, sa mémoire, son disque et sa charge à chaque contact, visibles sur les cartes du tableau de bord et détaillés sur la page de la machine avec un historique de 24 heures.
- Nouveau panneau « Machines gérées » : moyennes du parc et liste des machines sous pression (CPU, mémoire ou disque au-delà des seuils).
- Les mises à jour de sécurité sont maintenant identifiées et mises en avant dans la vue Paquets, avec le nombre de machines concernées et un bouton pour appliquer uniquement les correctifs de sécurité.
- Rétention des logs configurable (par âge et par taille), appliquée localement par chaque agent. Le log du jour n'est jamais supprimé.
- Page Logs repensée : recherche, coloration par niveau, téléchargement et nettoyage immédiat d'une machine.
- Notification de nouvelle version : le tableau de bord signale discrètement qu'une version plus récente est publiée, avec vérification manuelle depuis cette fenêtre.
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
