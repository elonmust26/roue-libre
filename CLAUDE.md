# roue-libre — principes de développement

1. **Penser avant de coder** : toute hypothèse non triviale est écrite explicitement (commentaire ou PR) avant l'implémentation.
2. **Simplicité d'abord** : rien de spéculatif, aucune feature hors spec. Le code le plus simple qui passe les gates gagne.
3. **Changements chirurgicaux** : chaque ligne modifiée trace vers la spec (`docs/PRD.md` ou spec de tâche). Pas de refactor opportuniste.
4. **Exécution pilotée par le but** : chaque tâche a un critère de succès vérifiable ; on boucle jusqu'à preuve (gate qui passe), jamais jusqu'à déclaration.

## Repères

- Contrat de types : `src/core/types.ts` — source de vérité des interfaces (état, événements, runner, config, API).
- Les transitions d'état passent UNIQUEMENT par le moteur + gates shell (`gates/*.sh`). Aucun agent ne décide d'une transition.
- `status.json` s'écrit atomiquement (tmp + rename), jamais en direct.
- Tests : `npm test` (vitest). Typecheck : `npm run typecheck`.
