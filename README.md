# Home Assistant

Service météo personnel pour Home Assistant à Saint-Georges, Québec.

Le projet utilise Firebase Functions v2 et Firestore. Les conditions courantes et les prévisions viennent d'Open-Meteo; les alertes proviennent exclusivement de l'API officielle MétéoCAN d'Environnement et Changement climatique Canada.

## Fonctions Firebase

- `refreshWeather` récupère les données météo toutes les 15 minutes et écrit l'état normalisé dans `weather/home`.
- `getWeather` retourne le document `WeatherState` en JSON.
- `getHomeAssistantWeather` retourne une version JSON adaptée à une intégration météo Home Assistant, protégée par un Bearer token.
- `getDailyWellness` retourne les données Wellness quotidiennes de deux comptes Intervals.icu, protégées par un Bearer token.
- `resetDailyWellness` invalide le cache Wellness du jour pour un seul compte, protégée par le même token.
- `getDailyWellnessWhoop` retourne le même contrat Wellness, alimenté directement par l'API WHOOP V2.
- `resetDailyWellnessWhoop` invalide uniquement le cache WHOOP du jour pour un compte.
- `whoopAuth` démarre la connexion OAuth WHOOP d'un compte; `whoopCallback` reçoit la redirection OAuth.

La météo utilise explicitement le modèle Open-Meteo `best_match`.

## Prérequis

- Node.js 22
- npm
- Firebase CLI
- `curl` pour les commandes de test manuel

Installer la Firebase CLI si elle n'est pas déjà disponible :

```bash
npm install --global firebase-tools
```

## Installation

Depuis la racine du projet :

```bash
npm install
```

## Lancement local

Lancer les émulateurs Functions et Firestore :

```bash
npm run dev
```

Cette commande compile le TypeScript, utilise le projet Firebase local `demo-home-assistant`, puis démarre :

- Functions : `http://127.0.0.1:5001`
- Firestore : `http://127.0.0.1:8080`
- Emulator UI : l'adresse affichée par la Firebase CLI, généralement `http://127.0.0.1:4000`

Le projet local `demo-home-assistant` ne nécessite pas de vrai projet Firebase ni de connexion à un compte Google.

## Test manuel

Garder `npm run dev` actif dans un premier terminal. Dans un deuxième terminal, commencer par alimenter Firestore :

```bash
npm run refresh
```

Cette commande déclenche manuellement `refreshWeather`. Elle appelle les API Open-Meteo et MétéoCAN, puis écrit le résultat dans l'émulateur Firestore.

Lire ensuite l'état météo normalisé :

```bash
npm run weather
```

Les routes `getWeather` et `getHomeAssistantWeather` retournent une erreur `503` tant que `refreshWeather` n'a pas créé le document `weather/home`.

## URL locales

Les commandes npm utilisent les URL suivantes :

```text
POST http://127.0.0.1:5001/demo-home-assistant/northamerica-northeast1/refreshWeather
GET  http://127.0.0.1:5001/demo-home-assistant/northamerica-northeast1/getWeather
GET  http://127.0.0.1:5001/demo-home-assistant/northamerica-northeast1/getHomeAssistantWeather
```

## Home Assistant

Le endpoint `getHomeAssistantWeather` lit le document privé `weather/home` via l'Admin SDK Firebase et retourne une réponse alignée sur les champs attendus par `WeatherEntity` (https://developers.home-assistant.io/docs/core/entity/weather/) :

- `current` contient les conditions courantes, température, ressenti, point de rosée, humidité, précipitation, pression, visibilité, vent, rafales, UV et unités natives.
- `forecast.hourly` contient les 24 prochaines heures avec condition, température, ressenti, point de rosée, humidité, précipitation, pression, couverture nuageuse, vent, rafales, UV, direction du vent et probabilité de précipitation.
- `forecast.daily` contient 7 jours avec maximum/minimum, ressenti max, point de rosée moyen, humidité moyenne, pression moyenne, couverture nuageuse moyenne, précipitation totale, vent maximal, rafales maximales, UV maximal, direction dominante et probabilité de précipitation.
- `supplemental` contient les données utiles aux widgets HA custom mais hors contrat météo standard : modèle Open-Meteo, code météo brut, libellé français, sunrise/sunset, durée du jour, ensoleillement, pression de surface, visibilité brute, alertes MétéoCAN et futurs capteurs `indoor`/`outdoor`.

Créer le secret utilisé par Home Assistant avant le déploiement :

```bash
# créer un token aléatoire de 48 octets en base64
openssl rand -base64 48

firebase functions:secrets:set HOME_ASSISTANT_WEATHER_TOKEN
```

En local, l'émulateur peut lire le token depuis `.secret.local` :

```text
HOME_ASSISTANT_WEATHER_TOKEN=dev-token
```

Sur HA, il faudra mettre le Bearer token dans la configuration dans `secrets.yaml`.

Exemple d'appel local :

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer dev-token" \
  http://127.0.0.1:5001/demo-home-assistant/northamerica-northeast1/getHomeAssistantWeather
```

## Daily Wellness Intervals.icu

Les endpoints Wellness lisent les données quotidiennes de deux comptes Intervals.icu fixes : `me` et `partner`. Ils utilisent toujours le jour courant dans le fuseau Québec `America/Toronto`. Aucun client Home Assistant particulier n'est requis : tout client peut interroger l'endpoint GET avec son Bearer token.

Les clés Intervals et le token d'endpoint sont des secrets Firebase. Ne les ajoutez jamais au code, à Firestore, aux logs ou au README :

```bash
firebase functions:secrets:set INTERVALS_API_KEY_ME
firebase functions:secrets:set INTERVALS_API_KEY_PARTNER
firebase functions:secrets:set HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN
```

Pour le développement local, copiez `.secret.local.example` vers `.secret.local` et remplacez les valeurs d'exemple. La configuration non sensible est définie dans `.env` :

```text
WELLNESS_TIMEZONE=America/Toronto
```

Ce fuseau est aussi la valeur par défaut du paramètre Firebase ; il est préférable de le conserver afin que les clés de cache et le jour Intervals correspondent au Québec.

### GET `/getDailyWellness`

Seule la méthode `GET` est acceptée. L'endpoint n'accepte aucun paramètre de date et retourne toujours le jour courant Québec :

```bash
curl \
  -H "Authorization: Bearer $HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN" \
  "https://<function-url>/getDailyWellness"
```

Exemple de réponse :

```json
{
  "apiVersion": "1",
  "date": "2026-08-17",
  "timezone": "America/Toronto",
  "generatedAt": "2026-08-17T07:00:03.000Z",
  "accounts": {
    "me": {
      "status": "available",
      "cache": {
        "hit": true,
        "stale": false,
        "fetchedAt": "2026-08-17T06:45:00.000Z",
        "expiresAt": "2026-08-17T07:45:00.000Z"
      },
      "sourceUpdatedAt": "2026-08-17T06:42:00.000Z",
      "wellness": {
        "id": "2026-08-17",
        "readiness": 78,
        "hrv": 54.7,
        "futureIntervalsField": null
      }
    },
    "partner": {
      "status": "pending",
      "cache": {
        "hit": false,
        "stale": false,
        "fetchedAt": "2026-08-17T07:00:03.000Z",
        "expiresAt": "2026-08-17T07:05:03.000Z"
      },
      "sourceUpdatedAt": null,
      "wellness": null
    }
  }
}
```

`wellness` est l'objet Intervals.icu complet, sans liste blanche : les propriétés inconnues, futures et les valeurs `null` sont conservées dans Firestore puis renvoyées telles quelles. Les statuts sont `available`, `pending`, `missing`, `error` et `invalidated`. Une réponse 404 d'Intervals devient `missing`; une réponse 200 sans objet Wellness exploitable devient `pending`.

Le cache est séparé par date et compte dans `wellnessCache/{yyyy-MM-dd}__{accountId}`. Il dure 60 minutes pour `available`, 5 minutes pour `pending` et `missing`, et 2 minutes pour `error`. Lorsqu'un rafraîchissement échoue mais qu'une ancienne donnée est disponible, elle est renvoyée avec `cache.stale: true` et sera retentée après 2 minutes. L'échec d'un compte ne bloque jamais l'autre. Les statuts métier renvoient HTTP 200; seuls un token incorrect (401), une méthode incorrecte (405) ou une erreur globale (500) donnent une erreur HTTP.

### DELETE `/resetDailyWellness`

Seule la méthode `DELETE` est acceptée. Elle invalide le cache Firestore du jour courant pour `me` ou `partner`, sans appeler ni modifier Intervals.icu :

```bash
curl \
  -X DELETE \
  -H "Authorization: Bearer $HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN" \
  "https://<function-url>/resetDailyWellness?account=me"
```

La réponse confirme l'invalidation :

```json
{
  "ok": true,
  "account": "me",
  "date": "2026-08-17",
  "status": "invalidated"
}
```

Le reset est répétable sans erreur, ne touche jamais l'autre compte et incrémente une génération de cache. Cette génération empêche une requête commencée avant le reset de réécrire une ancienne réponse. Le prochain GET relira donc immédiatement Intervals.icu pour le compte invalidé.

## Daily Wellness WHOOP direct

L'intégration WHOOP fonctionne en parallèle d'Intervals.icu. Elle utilise les comptes fixes `me` et `partner`, le même fuseau `America/Toronto`, le même Bearer token `HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN` et le même contrat JSON que `getDailyWellness`. Ses caches sont isolés dans `wellnessWhoopCache`; les tokens OAuth restent dans `whoopAccounts` et ne sont jamais renvoyés ni journalisés.

Créer les deux secrets WHOOP :

```bash
firebase functions:secrets:set WHOOP_CLIENT_ID
firebase functions:secrets:set WHOOP_CLIENT_SECRET
```

Définir aussi l'URI publique HTTPS exacte de callback dans `.env` pour le développement et dans la configuration Firebase pour le déploiement :

```text
WHOOP_REDIRECT_URI=https://<function-url>/whoopCallback
```

Dans le WHOOP Developer Dashboard, créer/configurer le client avec cette même URI de redirection, puis autoriser les scopes `read:sleep`, `read:recovery` et `offline`. `offline` est indispensable : WHOOP crée alors un refresh token, automatiquement renouvelé et remplacé par la Function. Ne copiez jamais ce token manuellement.

### Connecter les comptes WHOOP

Pour `me`, demander l'URL OAuth puis l'ouvrir dans un navigateur :

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN" \
  "https://<function-url>/whoopAuth?account=me"
```

Connectez-vous à WHOOP et acceptez les scopes. WHOOP redirige alors vers `whoopCallback`, qui confirme `{ "ok": true, "account": "me" }` sans exposer les tokens. Répétez exactement la même procédure avec `account=partner` et le compte WHOOP partenaire.

### GET `/getDailyWellnessWhoop`

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN" \
  "https://<function-url>/getDailyWellnessWhoop"
```

La réponse a la même structure que `getDailyWellness`. WHOOP utilise le sommeil principal non-nap terminé durant le jour courant Québec et sa Recovery associée. Un score WHOOP encore en calcul donne `pending`; l'absence de sommeil du jour ou un score non calculable donne `missing`. Les métriques WHOOP indisponibles restent présentes avec `null` dans `wellness`.

### DELETE `/resetDailyWellnessWhoop`

```bash
curl --fail --silent --show-error \
  -X DELETE \
  -H "Authorization: Bearer $HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN" \
  "https://<function-url>/resetDailyWellnessWhoop?account=me"

curl --fail --silent --show-error \
  -X DELETE \
  -H "Authorization: Bearer $HOME_ASSISTANT_WELLNESS_ENDPOINT_TOKEN" \
  "https://<function-url>/resetDailyWellnessWhoop?account=partner"
```

Le reset invalide seulement le cache WHOOP demandé. Il ne déconnecte pas WHOOP, ne supprime pas les tokens OAuth, ne touche ni l'autre compte ni le cache Intervals; le GET WHOOP suivant relit l'API.

Déployer uniquement cette intégration quand les secrets et l'URI sont configurés :

```bash
firebase deploy --only functions:getDailyWellnessWhoop,functions:resetDailyWellnessWhoop,functions:whoopAuth,functions:whoopCallback
```

## Commandes disponibles

```bash
npm run build    # Compile TypeScript dans lib/
npm run clean    # Supprime lib/
npm run dev      # Compile et lance les émulateurs locaux
npm run refresh  # Récupère la météo et remplit Firestore local
npm run weather  # Affiche le WeatherState local en JSON
```

## Notes techniques

- Le filtre MétéoCAN utilise `INTERSECTS(geometry,POINT(-70.67 46.117))`, dans l'ordre longitude puis latitude.
- L'API GeoMet annonce une syntaxe CQL2, mais son déploiement actuel accepte `filter-lang=cql-text` et rejette `cql2-text`.
- Les alertes conservent la couleur de risque officielle MétéoCAN (`risk_colour_fr`) et leur date de publication.
- Les blocs `INT` et `EXT` sont prêts pour deux futurs capteurs Govee et affichent uniquement température et humidité.
- Le tableau normalisé `hourly` contient les 24 prochaines heures à partir de l'observation Open-Meteo courante.
- Aucun framework ni script de tests automatisés n'est inclus dans le projet.
