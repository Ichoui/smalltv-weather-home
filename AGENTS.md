# Repository Guidelines

## Règles de collaboration

Communiquer exclusivement en français avec le contributeur. Ne jamais lancer une commande, un script, une compilation, un déploiement, un formatage ou un émulateur sans son autorisation explicite préalable, même si la commande paraît sans risque. Expliquer brièvement l’objectif et l’effet attendu avant de demander cette autorisation.

Ne pas créer, modifier ni exécuter de tests automatisés. Ne pas ajouter de dépendance ou de framework de test. Les changements doivent être relus statiquement et présentés clairement au contributeur; il décide seul des vérifications à exécuter.

## Structure du projet et modules

Ce dépôt Firebase Functions v2 alimente des intégrations Home Assistant. Les exports de Functions et les handlers HTTP sont dans `src/index.ts`. Placer l’orchestration métier dans `src/services/`, les types et transformations pures dans `src/domain/`, et les clients d’API externes dans `src/providers/` — par exemple `src/providers/jokes/`.

Les clients OAuth et spécifiques aux fournisseurs vivent dans `src/whoop/` et `src/intervals/`. Les ressources statiques et outils de rendu sont dans `src/assets/` et `src/render/`. Le dossier `lib/` est généré par TypeScript : ne jamais le modifier manuellement.

## Commandes du projet

Les commandes suivantes ne sont données qu’à titre de référence et ne doivent être exécutées qu’après accord explicite du contributeur :

- `npm run build` compile TypeScript vers `lib/`.
- `npm run dev` compile puis démarre les émulateurs Functions et Firestore avec `demo-home-assistant`.
- `npm run refresh` et `npm run weather` interrogent les endpoints météo locaux.
- `npm run deploy` déploie les Firebase Functions; préférer une cible précise, par exemple `firebase deploy --only functions:selectDailyJoke`.

Utiliser Node.js 22, comme déclaré dans `package.json`.

## Style et conventions

Écrire du TypeScript strict avec deux espaces d’indentation, points-virgules, guillemets doubles et imports ESM se terminant par `.js`. Utiliser `camelCase` pour les valeurs et fonctions, `PascalCase` pour les types, avec des noms descriptifs tels que `fetchBlablaguesJoke`.

Traiter tout JSON externe comme `unknown`, valider sa structure avant usage et ne jamais journaliser une réponse sensible, un token ou un secret. Garder les accès Firestore dans les services et utiliser une transaction lorsque plusieurs documents portent une même invariance.

## Sécurité, commits et PR

Firestore est privé par conception. Utiliser `defineSecret` et Firebase Secret Manager pour les identifiants; ne mettre que des noms ou valeurs factices dans `.secret.local.example`. Ne jamais versionner `.secret.local`, tokens ou identifiants OAuth.

Les commits récents utilisent des résumés courts à l’impératif, par exemple `Adding new function for whoop`. Garder les commits ciblés. Une PR décrit les changements de comportement, les secrets ou configurations requis et les endpoints affectés; ajouter des captures seulement pour un rendu utilisateur.
