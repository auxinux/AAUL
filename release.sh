#!/usr/bin/env bash
# ===========================================================================
#  AAUL — Script de release
#
#  Met à jour les numéros de version (dashboard + agent), installe les
#  dépendances verrouillées, exécute les tests, construit l'interface et le
#  bundle agent, puis produit une archive .zip prête pour la production.
#
#  Versionnage : tant que le projet est en beta, dashboard et agent restent
#  en 0.x.x (pré-1.0 au sens semver). Ne pas passer en 1.x avant la sortie
#  officielle stable.
#
#  Usage:
#    ./release.sh                          # utilise les versions actuelles des fichiers
#    ./release.sh -d 0.11.0 -a 0.8.0       # fixe dashboard=0.11.0, agent=0.8.0
#    ./release.sh --dashboard 0.11.0       # ne change que la version dashboard
#    ./release.sh --agent 0.8.0            # ne change que la version agent
#    ./release.sh --no-bump                # ne touche à aucune version, zippe tel quel
#    ./release.sh --skip-build              # archive sans rebuilder (builds existants requis)
#
#  Sortie:
#    release/AAUL-<dashboard_version>.zip
# ===========================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$ROOT_DIR/release"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${CYAN}▸${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

DASHBOARD_VER=""
AGENT_VER=""
NO_BUMP=false
SKIP_BUILD=false

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dashboard) DASHBOARD_VER="${2:-}"; shift 2;;
    -a|--agent)     AGENT_VER="${2:-}"; shift 2;;
    --no-bump)      NO_BUMP=true; shift;;
    --skip-build)   SKIP_BUILD=true; shift;;
    -h|--help)
      awk '
        NR == 1 { next }
        /^# =+/ { separators++; if (separators == 2) exit; next }
        /^#/ { sub(/^# ?/, ""); print }
      ' "$0"
      exit 0;;
    *) die "Argument inconnu: $1 (voir --help)";;
  esac
done

# ---------------------------------------------------------------------------
#  Fichiers porteurs de version
# ---------------------------------------------------------------------------
DASH_PKG="$ROOT_DIR/dashboard/package.json"
DASH_LOCK="$ROOT_DIR/dashboard/package-lock.json"
CLIENT_PKG="$ROOT_DIR/dashboard/client/package.json"
CLIENT_LOCK="$ROOT_DIR/dashboard/client/package-lock.json"
APP_VERSION_JS="$ROOT_DIR/dashboard/client/src/lib/appVersion.js"
CLIENT_ENV_EXAMPLE="$ROOT_DIR/dashboard/client/.env.example"
AGENT_VERSION_FILE="$ROOT_DIR/agent/app/VERSION"

validate_semver() {
  echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "Version invalide: '$1' (attendu X.Y.Z)"
}

# Remplace la 1re occurrence de "version": "..." dans un package.json
set_pkg_version() {
  local file="$1" ver="$2" tmp
  tmp="$(mktemp)"
  awk -v ver="$ver" '
    !done && /"version"[[:space:]]*:/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" ver "\"");
      done=1
    }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Un package-lock v3 porte la version du projet à la racine et dans packages[""].
set_lock_version() {
  local file="$1" ver="$2" tmp
  tmp="$(mktemp)"
  awk -v ver="$ver" '
    replacements < 2 && /"version"[[:space:]]*:/ {
      sub(/"version"[[:space:]]*:[[:space:]]*"[^"]*"/, "\"version\": \"" ver "\"");
      replacements++
    }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

if [ "$NO_BUMP" = false ]; then
  # Valeurs par défaut = versions déjà présentes dans les fichiers
  [ -n "$DASHBOARD_VER" ] || DASHBOARD_VER="$(grep '"version"' "$DASH_PKG" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  [ -n "$AGENT_VER" ]     || AGENT_VER="$(tr -d '[:space:]' < "$AGENT_VERSION_FILE")"

  validate_semver "$DASHBOARD_VER"
  validate_semver "$AGENT_VER"

  info "Mise à jour des versions → dashboard ${BOLD}$DASHBOARD_VER${NC}, agent ${BOLD}$AGENT_VER${NC}"

  set_pkg_version "$DASH_PKG"   "$DASHBOARD_VER"
  set_pkg_version "$CLIENT_PKG" "$DASHBOARD_VER"
  set_lock_version "$DASH_LOCK"   "$DASHBOARD_VER"
  set_lock_version "$CLIENT_LOCK" "$DASHBOARD_VER"
  # Le footer affiche clientPkg.version au build (cf. vite.config.js). On
  # aligne aussi le fallback et le .env.example pour rester cohérent.
  sed -i.bak "s/|| \"[0-9]*\.[0-9]*\.[0-9]*\"/|| \"$DASHBOARD_VER\"/" "$APP_VERSION_JS" && rm -f "$APP_VERSION_JS.bak"
  sed -i.bak "s/^VITE_APP_VERSION=.*/VITE_APP_VERSION=$DASHBOARD_VER/" "$CLIENT_ENV_EXAMPLE" && rm -f "$CLIENT_ENV_EXAMPLE.bak"
  echo "$AGENT_VER" > "$AGENT_VERSION_FILE"

  ok "Versions écrites"
else
  DASHBOARD_VER="$(grep '"version"' "$DASH_PKG" | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  AGENT_VER="$(tr -d '[:space:]' < "$AGENT_VERSION_FILE")"
  warn "--no-bump : versions inchangées (dashboard=$DASHBOARD_VER, agent=$AGENT_VER)"
fi

# ---------------------------------------------------------------------------
#  Vérification de cohérence
# ---------------------------------------------------------------------------
DASH_V="$(grep '"version"' "$DASH_PKG" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')"
CLIENT_V="$(grep '"version"' "$CLIENT_PKG" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')"
DASH_LOCK_V="$(grep '"version"' "$DASH_LOCK" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')"
DASH_LOCK_ROOT_V="$(grep '"version"' "$DASH_LOCK" | head -2 | tail -1 | sed 's/.*"\([0-9.]*\)".*/\1/')"
CLIENT_LOCK_V="$(grep '"version"' "$CLIENT_LOCK" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')"
CLIENT_LOCK_ROOT_V="$(grep '"version"' "$CLIENT_LOCK" | head -2 | tail -1 | sed 's/.*"\([0-9.]*\)".*/\1/')"
for version in "$CLIENT_V" "$DASH_LOCK_V" "$DASH_LOCK_ROOT_V" "$CLIENT_LOCK_V" "$CLIENT_LOCK_ROOT_V"; do
  [ "$DASH_V" = "$version" ] || \
    die "Incohérence de version dashboard/client/lockfiles (attendu $DASH_V, trouvé $version)"
done
ok "Cohérence vérifiée — dashboard $DASH_V / agent $AGENT_VER"

# ---------------------------------------------------------------------------
#  Validation et builds de production
# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" = false ]; then
  command -v npm >/dev/null 2>&1 || die "npm requis pour construire la release."

  info "Installation des dépendances verrouillées…"
  (cd "$ROOT_DIR/dashboard" && npm ci)
  (cd "$ROOT_DIR/dashboard/client" && npm ci)
  ok "Dépendances installées"

  info "Tests et build de l'interface…"
  (cd "$ROOT_DIR/dashboard" && npm run test:security && npm run build:client)
  ok "Interface de production construite"

  info "Construction du bundle agent…"
  bash "$ROOT_DIR/dashboard/scripts/build-agent-bundle.sh"
  ok "Bundle agent construit"
else
  warn "--skip-build : réutilisation des builds locaux existants"
fi

[ -f "$ROOT_DIR/dashboard/client/dist/index.html" ] || \
  die "Build client absent : dashboard/client/dist/index.html"
[ -f "$ROOT_DIR/dashboard/public/agent/latest.tar.gz" ] || \
  die "Bundle agent absent : dashboard/public/agent/latest.tar.gz"
[ -f "$ROOT_DIR/dashboard/public/agent/VERSION" ] || \
  die "Version du bundle agent absente."

BUNDLED_AGENT_VER="$(tr -d '[:space:]' < "$ROOT_DIR/dashboard/public/agent/VERSION")"
[ "$BUNDLED_AGENT_VER" = "$AGENT_VER" ] || \
  die "Bundle agent incohérent ($BUNDLED_AGENT_VER != $AGENT_VER)."

# ---------------------------------------------------------------------------
#  Construction de l'archive (sources + builds validés)
# ---------------------------------------------------------------------------
mkdir -p "$OUT_DIR"
ZIP_NAME="AAUL-$DASHBOARD_VER.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"
rm -f "$ZIP_PATH"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
STAGE_DIR="$STAGING/AAUL"
mkdir -p "$STAGE_DIR"

# Source of truth = files TRACKED by git. Working-tree content is used, so the
# version bumps above are included before commit. Les deux artefacts de build
# validés sont ajoutés explicitement ensuite ; node_modules et secrets restent
# exclus par construction.
command -v rsync >/dev/null 2>&1 || die "rsync requis pour construire l'archive."

if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  info "Copie des fichiers suivis par git (seulement le nécessaire)…"
  # Tracked files + cached (staged) files, NUL-separated for safety.
  git -C "$ROOT_DIR" ls-files -z --cached > "$STAGING/filelist"
  COUNT="$(tr -cd '\0' < "$STAGING/filelist" | wc -c | tr -d ' ')"
  rsync -a --from0 --files-from="$STAGING/filelist" "$ROOT_DIR/" "$STAGE_DIR/"
  ok "$COUNT fichiers suivis copiés"
else
  warn "Pas un dépôt git — repli sur une liste d'exclusions."
  rsync -a \
    --exclude='.git/' --exclude='.claude/' --exclude='node_modules/' \
    --exclude='dashboard/client/dist/' --exclude='dashboard/public/agent/' \
    --exclude='release/' --exclude='*.zip' \
    --exclude='*.sqlite*' --exclude='.env' --exclude='.env.*' \
    --exclude='.session-secret' --exclude='.data-protection-key' \
    --exclude='.initial-admin-password' \
    --exclude='dashboard/ssl/*' --exclude='dashboard/server/ssl/*' \
    --exclude='__pycache__/' --exclude='*.pyc' \
    --exclude='.DS_Store' --exclude='*.log' \
    "$ROOT_DIR/." "$STAGE_DIR/"
fi

rsync -a "$ROOT_DIR/dashboard/client/dist/" \
  "$STAGE_DIR/dashboard/client/dist/"
rsync -a "$ROOT_DIR/dashboard/public/agent/" \
  "$STAGE_DIR/dashboard/public/agent/"
ok "Build client et bundle agent ajoutés à l'archive"

info "Création de l'archive…"
( cd "$STAGING" && zip -rq "$ZIP_PATH" "AAUL" )

SIZE="$(du -h "$ZIP_PATH" | cut -f1)"
echo ""
ok "Release prête : ${BOLD}$ZIP_PATH${NC} ($SIZE)"
echo ""
echo -e "${CYAN}Prochaine étape (sur le serveur de prod) :${NC}"
echo "  1. Uploader $ZIP_NAME puis : unzip $ZIP_NAME"
echo "  2. cd AAUL && sudo ./install.sh"
echo "     (ou sudo ./install.sh --no-build pour utiliser l'interface précompilée)"
echo ""
echo -e "${CYAN}Versions embarquées :${NC} dashboard $DASHBOARD_VER · agent $AGENT_VER"
