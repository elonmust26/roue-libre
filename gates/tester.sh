#!/usr/bin/env bash
# Gate testeur — tests À FROID (garde-fou 1), cwd = worktree du testeur.
# Installation propre + tests + build. Exit 0 seulement si tout passe.
set -euo pipefail

# Racine du repo principal (le worktree ne contient pas .orchestration, ignoré par git).
common_dir=$(git rev-parse --git-common-dir)
main_root=$(cd "$common_dir/.." && pwd)

echo "[gate tester] worktree : $(pwd)"

if [ ! -f package.json ]; then
  echo "[gate tester] aucun harnais de test détecté (pas de package.json)."
  if [ -f "$main_root/.orchestration/allow-no-tests" ]; then
    echo "[gate tester] .orchestration/allow-no-tests présent — absence de tests tolérée explicitement."
    exit 0
  fi
  echo "[gate tester] ÉCHEC : zéro confiance — crée .orchestration/allow-no-tests dans le repo cible pour tolérer l'absence de harnais."
  exit 1
fi

# Installation à froid : npm ci si lockfile, sinon npm install.
if [ -f package-lock.json ]; then
  echo "[gate tester] npm ci (installation à froid)"
  npm ci
else
  echo "[gate tester] npm install (pas de package-lock.json)"
  npm install
fi

has_script() {
  node -e "const s=(require('./package.json').scripts||{})[process.argv[1]];process.exit(s?0:1)" "$1"
}

if has_script test; then
  echo "[gate tester] npm test"
  npm test
else
  echo "[gate tester] pas de script test — ignoré"
fi

if has_script build; then
  echo "[gate tester] npm run build"
  npm run build
else
  echo "[gate tester] pas de script build — ignoré"
fi

echo "[gate tester] OK — tests à froid concluants."
