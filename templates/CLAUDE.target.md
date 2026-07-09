# CLAUDE.md — repo piloté par roue-libre

Ce repo est orchestré par **roue-libre** : un orchestrateur local qui pilote trois rôles
Claude Code (Prompteur / Coder / Testeur-Merge) sur une machine d'états à **gates
objectives**. Si tu es un agent Claude Code lancé dans ce repo, les règles ci-dessous
s'appliquent à toi.

## L'espace de l'orchestrateur : `.orchestration/`

- `.orchestration/` appartient au moteur : `status.json` (état courant, écrit atomiquement
  par le moteur SEUL), `events.ndjson` (journal), `spec.md` (spec de la tâche),
  `worktrees/` (isolation par rôle).
- **Ne modifie JAMAIS ces fichiers à la main pendant une tâche.**
- `spec.md` est **FIGÉE** : son hash est vérifié à chaque étape. Toute altération en cours
  de cycle bloque la tâche (motif « spec altérée »). Changer d'avis = annuler et relancer
  un nouveau cycle, explicitement.

## Les transitions ne t'appartiennent pas

**Aucun agent ne décide d'une transition d'état.** Tu travailles, tu rends ton résultat,
tu t'arrêtes. Le moteur vérifie par des gates shell (exit code) et c'est LUI qui fait
avancer la machine d'états. Déclarer « j'ai fini » ne fait rien bouger — seule une gate
qui passe compte.

## Les 4 principes de travail

1. **Penser avant de coder** — toute hypothèse non triviale est écrite explicitement
   avant l'implémentation.
2. **Simplicité d'abord** — rien de spéculatif, aucune feature hors spec. Le code le plus
   simple qui passe les gates gagne.
3. **Changements chirurgicaux** — chaque ligne modifiée trace vers la spec. Pas de
   refactor opportuniste.
4. **Exécution pilotée par le but** — chaque tâche a un critère de succès vérifiable ;
   on boucle jusqu'à preuve (gate qui passe), jamais jusqu'à déclaration.
