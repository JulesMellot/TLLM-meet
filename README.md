# TLLM\*meet

Visioconférence privée, en français, pour des réunions jusqu'à une trentaine de personnes.

- Seul l'administrateur crée les visios.
- Les invités rejoignent par lien, sans compte.
- Ni ChatGPT ni DeepSeek : aucune intégration d'IA conversationnelle.

TLLM\*meet est un fork de [MiroTalk SFU](https://github.com/miroslavpejic85/mirotalksfu) (v2.6.25)
de Miroslav Pejic, sous licence [AGPL-3.0](LICENSE).

## Fonctionnalités

- Audio, vidéo et partage d'écran, via [mediasoup](https://mediasoup.org).
- Chat, sondages, partage de vidéos et de fichiers pendant la visio.
- Tableau blanc, éditeur de texte partagé, sous-salles.
- Salle d'attente, verrouillage de la visio, mot de passe optionnel.
- Enregistrement dans le navigateur, sous-titres (reconnaissance vocale du navigateur).
- Fond flou ou virtuel, réduction de bruit.
- Interface sobre, utilisable sur téléphone ; pages en mode clair ou sombre.

## Fonctionnement

1. L'admin se connecte sur `/login` avec un compte défini dans `HOST_USERS`.
2. Il donne un nom à la visio. Un suffixe aléatoire est ajouté, par exemple `point-hebdo-k7m2xq`.
3. Il partage le lien. Les invités entrent avec leur nom, sans compte.

Si un invité ouvre le lien avant l'admin, il voit « Cette visio n'a pas encore commencé ».
La page entre d'elle-même dès que l'admin ouvre la visio.

L'admin est présentateur de ses visios. Un invité ne le devient que si l'admin le promeut.

La session admin est un cookie signé, vérifié côté serveur (`HttpOnly`, `Secure`, `SameSite=Lax`).
Elle ne contient pas le mot de passe et expire après `HOST_SESSION_HOURS` heures.
La déconnexion la révoque, et changer le mot de passe invalide les sessions ouvertes.

## Déploiement (Coolify derrière Cloudflare)

Coolify construit l'image à partir du `Dockerfile` du dépôt. Les variables se règlent dans Coolify ;
la liste complète est dans [`.env.template`](.env.template).

| Variable | Valeur |
|---|---|
| `NODE_ENV` | `production` |
| `SERVER_HOST_URL` | l'URL publique, par exemple `https://meet.exemple.fr` |
| `SFU_ANNOUNCED_IP` | l'IP publique du serveur |
| `TRUST_PROXY` | `2` (Cloudflare + proxy Coolify) |
| `JWT_SECRET` | au moins 32 caractères : `openssl rand -hex 32` |
| `HOST_USERS` | comptes admin `identifiant:motdepasse:Nom affiché`, séparés par `\|` |
| `UI_STYLE` | `sobre` (par défaut) ou `papier` |
| `SOURCE_URL` | lien vers le code source de l'instance (AGPL-3.0, article 13) |

Le serveur refuse de démarrer si `JWT_SECRET` manque ou est trop court,
ou si `HOST_USERS` est vide ou contient des identifiants connus (`admin:admin`…).

Réseau :

- Le port HTTP `3010` passe par Coolify et Cloudflare.
- Les flux audio et vidéo ne passent pas par Cloudflare. Les ports `40000-40100`, en UDP et en TCP,
  doivent être ouverts directement sur le serveur (`SFU_MIN_PORT` et `SFU_MAX_PORT`).
- `TRUST_PROXY` doit correspondre au nombre exact de proxys devant l'application.
  Une valeur trop haute permet de falsifier l'IP utilisée par les limites de connexion.

## Développement local

Il faut Node.js 24 ou plus.

```bash
cp .env.template .env
cp app/src/config.template.js app/src/config.js
# dans .env : renseigner JWT_SECRET et HOST_USERS
npm install
npm start      # https://localhost:3010
npm test
```

En local, le serveur utilise le certificat de test de `app/ssl` ; le navigateur demande de l'accepter.

## Personnalisation

- `UI_STYLE` : `sobre` (graphite, accent bleu) ou `papier` (tons chauds, accent vert).
- `SHOW_*` : affiche ou masque chaque bouton de la visio.
- `BRAND_*` : nom, description et textes des pages.

Le code propre au fork est rangé dans des fichiers séparés, pour limiter les conflits avec l'upstream :

| Fichier | Rôle |
|---|---|
| `public/css/tllm.css` | apparence de la visio |
| `public/css/tllm-pages.css` | accueil, connexion, attente, erreurs |
| `public/js/tllm.js` | menu « Plus », chargement à la demande des bibliothèques |
| `public/js/TllmHome.js` | page d'accueil |
| `app/src/AdminAuth.js` | session admin, noms de visio |
| `app/src/ClientIp.js` | IP du client derrière les proxys |

## Mise à jour depuis MiroTalk SFU

```bash
git remote add upstream https://github.com/miroslavpejic85/mirotalksfu.git
git fetch upstream
git merge upstream/main
npm install
npm test
```

Les conflits se concentrent sur `app/src/Server.js`, `app/src/config.template.js`,
`public/views/Room.html` et `public/js/RoomClient.js`.

Après une mise à jour, vérifier :

- qu'aucune nouvelle route ni nouvel événement socket ne crée une visio sans passer par `AdminAuth` ;
- que les nouvelles intégrations externes restent retirées ou désactivées par défaut.

## Licence

[AGPL-3.0](LICENSE). Le code source modifié doit rester accessible aux utilisateurs de l'instance :
c'est le rôle du lien `SOURCE_URL`, affiché dans « À propos ».

MiroTalk SFU © 2021 Miroslav Pejic. Les modifications TLLM\*meet sont publiées sous la même licence.
