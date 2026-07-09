#!/usr/bin/env bash
# Gate coder — preuve OBJECTIVE côté coder (garde-fou 1 : zéro confiance déclarative).
# Exécutée avec cwd = worktree du coder. Exit 0 seulement si tout passe.
#
# Branche cible : l'interface GateRunner.run(gate, cwd) est figée (pas d'env par
# appel), donc le moteur écrit la branche cible dans .orchestration/target-branch
# du repo PRINCIPAL. Depuis le worktree, on retrouve la racine principale via
# `git rev-parse --git-common-dir` (le .git commun vit dans le repo principal).
set -euo pipefail

common_dir=$(git rev-parse --git-common-dir)
main_root=$(cd "$common_dir/.." && pwd)
ROUE_TARGET_BRANCH="${ROUE_TARGET_BRANCH:-$(cat "$main_root/.orchestration/target-branch" 2>/dev/null || echo main)}"
ROUE_TARGET_BRANCH="$(printf '%s' "$ROUE_TARGET_BRANCH" | tr -d '[:space:]')"

echo "[gate coder] worktree : $(pwd)"
echo "[gate coder] branche cible : $ROUE_TARGET_BRANCH"

# 1a) Aucune modification non commitée ne doit traîner — commits atomiques exigés.
if [ -n "$(git status --porcelain)" ]; then
  echo "[gate coder] ÉCHEC : modifications non commitées présentes — commits atomiques exigés."
  git status --porcelain
  exit 1
fi
echo "[gate coder] arbre de travail propre : OK"

# 1b) Diff non vide vs la branche cible : sans commit, rien ne bouge.
set +e
git diff --quiet "${ROUE_TARGET_BRANCH}...HEAD"
diff_rc=$?
set -e
if [ "$diff_rc" -eq 0 ]; then
  echo "[gate coder] ÉCHEC : aucun diff vs ${ROUE_TARGET_BRANCH} — aucun travail commité."
  exit 1
elif [ "$diff_rc" -gt 1 ]; then
  echo "[gate coder] ÉCHEC : comparaison impossible avec ${ROUE_TARGET_BRANCH} (git diff exit $diff_rc)."
  exit 1
fi
echo "[gate coder] diff non vide vs ${ROUE_TARGET_BRANCH} : OK"

# 2) Typecheck + tests du repo cible s'ils sont définis dans package.json.
has_script() {
  node -e "const s=(require('./package.json').scripts||{})[process.argv[1]];process.exit(s?0:1)" "$1"
}

if [ -f package.json ]; then
  if has_script typecheck; then
    echo "[gate coder] npm run typecheck"
    npm run typecheck
  else
    echo "[gate coder] pas de script typecheck — ignoré"
  fi
  if has_script test; then
    echo "[gate coder] npm test"
    npm test
  else
    echo "[gate coder] pas de script test — ignoré"
  fi
else
  echo "[gate coder] pas de package.json — typecheck/tests ignorés"
fi

echo "[gate coder] OK — toutes les preuves passent."
