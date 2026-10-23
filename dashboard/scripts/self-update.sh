#!/usr/bin/env bash
# ===========================================================================
#  AAUL — mise à jour du dashboard demandée depuis l'interface
#
#  Lancé en root par aaul-self-update.service, lui-même déclenché par
#  aaul-self-update.path quand le dashboard dépose son fichier de demande.
#  Installé par install.sh dans /usr/local/lib/aaul/ (root:root 0755).
#
#  Le dashboard tourne sous un compte ordinaire qui possède /opt/AAUL. Rien de
#  ce que ce compte peut modifier n'est donc exécuté ici en root :
#    - la configuration vient de /etc/aaul/self-update.conf (root) ;
#    - le code est récupéré dans /var/lib/aaul/src (root), depuis le dépôt
#      configuré, et c'est son install.sh qui est lancé ;
#    - le fichier de demande n'est jamais lu, seulement supprimé ;
#    - l'état est écrit dans /var/lib/aaul/self-update (root, lisible par tous).
#  Le dashboard ne peut donc que demander « installe la version publiée ».
# ===========================================================================
set -uo pipefail

CONF_FILE="${AAUL_SELF_UPDATE_CONF:-/etc/aaul/self-update.conf}"

# Valeurs par défaut, remplacées par la configuration écrite par install.sh.
REPO_URL="https://github.com/auxinux/AAUL.git"
BRANCH="main"
INSTALL_DIR="/opt/AAUL"
SERVICE_USER=""
NODE_BIN=""
REQUEST_FILE=""
STATE_DIR="/var/lib/aaul/self-update"
SRC_DIR="/var/lib/aaul/src"

if [ -f "$CONF_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONF_FILE"
fi
REQUEST_FILE="${REQUEST_FILE:-$INSTALL_DIR/dashboard/.self-update/request}"

STATUS_FILE="$STATE_DIR/status.json"
LOG_FILE="$STATE_DIR/log.txt"

mkdir -p "$STATE_DIR"
chmod 755 "$STATE_DIR"

# La demande est consommée avant tout : sinon l'unité .path relancerait la
# mise à jour en boucle. rm sur un lien symbolique retire le lien, pas sa cible.
rm -f "$REQUEST_FILE"

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FROM_VERSION="$(tr -d '[:space:]' < "$INSTALL_DIR/dashboard/VERSION" 2>/dev/null || true)"
TO_VERSION=""

# État lu par le dashboard (utils/self-update.js). Écrit dans un fichier
# temporaire puis renommé, pour ne jamais être lu à moitié.
write_status() {
  local state="$1" message="${2:-}" exit_code="${3:-null}" finished="null"
  [ "$state" = "running" ] || finished="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  cat > "$STATUS_FILE.tmp" <<JSON
{
  "state": "$state",
  "message": "$(json_escape "$message")",
  "from": "$(json_escape "$FROM_VERSION")",
  "to": "$(json_escape "$TO_VERSION")",
  "startedAt": "$STARTED_AT",
  "finishedAt": $finished,
  "exitCode": $exit_code
}
JSON
  chmod 644 "$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

fail() {
  echo "ERREUR: $1"
  write_status "failed" "$1" "${2:-1}"
  exit "${2:-1}"
}

: > "$LOG_FILE"
chmod 644 "$LOG_FILE"
exec >>"$LOG_FILE" 2>&1

echo "== Mise à jour demandée depuis le dashboard — $STARTED_AT"
write_status "running" "Récupération de la version publiée"

command -v git >/dev/null 2>&1 || fail "git est requis pour la mise à jour depuis le dashboard"
[ -n "$SERVICE_USER" ] || fail "Configuration incomplète ($CONF_FILE) : relancer install.sh à la main une fois"

# Le Node utilisé par le service, et non celui que trouverait le PATH minimal
# de systemd : sinon install.sh croirait Node absent et tenterait de l'installer.
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  PATH="$(dirname "$NODE_BIN"):$PATH"
fi
export PATH

# --- Code source ------------------------------------------------------------
mkdir -p "$(dirname "$SRC_DIR")"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" remote set-url origin "$REPO_URL" \
    && git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" \
    && git -C "$SRC_DIR" checkout -q -B "$BRANCH" FETCH_HEAD \
    && git -C "$SRC_DIR" reset -q --hard FETCH_HEAD \
    && git -C "$SRC_DIR" clean -q -fdx \
    || fail "Impossible de récupérer $REPO_URL ($BRANCH)"
else
  rm -rf "$SRC_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" \
    || fail "Impossible de cloner $REPO_URL ($BRANCH)"
fi
echo "Source : $REPO_URL ($BRANCH) — $(git -C "$SRC_DIR" log -1 --format='%h %s')"

TO_VERSION="$(tr -d '[:space:]' < "$SRC_DIR/dashboard/VERSION" 2>/dev/null || true)"
[ -n "$TO_VERSION" ] || fail "Version publiée illisible (dashboard/VERSION absent)"

if [ "$TO_VERSION" = "$FROM_VERSION" ]; then
  echo "Déjà à jour ($FROM_VERSION)."
  write_status "up-to-date" "Déjà à jour" 0
  exit 0
fi

# --- Installation -----------------------------------------------------------
echo "Mise à jour $FROM_VERSION -> $TO_VERSION"
write_status "running" "Installation de la version $TO_VERSION"

# install.sh sauvegarde l'installation, la met à jour, redémarre le service et
# revient à la sauvegarde si quoi que ce soit échoue.
AAUL_SERVICE_USER="$SERVICE_USER" bash "$SRC_DIR/install.sh" --update
rc=$?

INSTALLED="$(tr -d '[:space:]' < "$INSTALL_DIR/dashboard/VERSION" 2>/dev/null || true)"
if [ "$rc" -ne 0 ]; then
  fail "L'installation a échoué (code $rc) ; version en place : ${INSTALLED:-inconnue}" "$rc"
fi
if [ "$INSTALLED" != "$TO_VERSION" ]; then
  fail "L'installation s'est terminée mais la version installée est $INSTALLED" 1
fi

echo "== Terminé : version $INSTALLED"
write_status "success" "Version $INSTALLED installée" 0
