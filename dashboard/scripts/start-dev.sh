#!/bin/bash
# Script de démarrage du dashboard en mode développement
# Détecte automatiquement si SSL est activé et ajuste les ports

cd "$(dirname "$0")/.."

# Vérifier si SSL est activé
SSL_ENABLED=$(jq -r '.ssl.enabled' config/config.json 2>/dev/null || echo "false")

if [ "$SSL_ENABLED" = "true" ]; then
    echo "🔒 Mode HTTPS activé"
    echo "📡 API Server: HTTPS sur port 3001"
    echo "🌐 Dashboard: HTTPS sur port 5174"
else
    echo "🔓 Mode HTTP activé"
    echo "📡 API Server: HTTP sur port 3001"
    echo "🌐 Dashboard: HTTP sur port 5173"
fi

echo ""
echo "Démarrage du serveur API..."
node server/index.js &
API_PID=$!

# Attendre que l'API démarre
sleep 2

echo "Démarrage de Vite..."
cd client
npm run dev &
VITE_PID=$!

# Gérer la fermeture propre
trap "kill $API_PID $VITE_PID 2>/dev/null" EXIT

echo ""
echo "✅ Dashboard démarré !"
echo "   Appuyez sur Ctrl+C pour arrêter"

wait
