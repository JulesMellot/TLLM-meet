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

Le dépôt contient [`docker-compose.coolify.yml`](docker-compose.coolify.yml), prévu pour Coolify :

1. Dans Coolify, créer une ressource à partir du dépôt, type de build **Docker Compose**.
2. Dans _Docker Compose Location_, indiquer `/docker-compose.coolify.yml`.
3. Dans le champ _Domains_ du service `tllm-meet`, écrire le domaine **suivi du port 3010** :
   `https://meet.exemple.fr:3010`. Coolify envoie le trafic vers le port 3010 du conteneur ;
   l'adresse publique reste `https://meet.exemple.fr`.
4. Dans les variables d'environnement, remplir `HOST_USERS` et `SERVER_HOST_URL`
   (`https://meet.exemple.fr`, sans port), puis déployer. Pas besoin de guillemets.
   Éviter le caractère `$` dans les mots de passe : Docker Compose le remplace par une variable.
5. Pour `HOST_USERS` et `SERVICE_PASSWORD_64_JWT`, décocher l'option de variable de build
   (_Build Variable_ / _Available at Buildtime_) : ce sont des secrets utiles seulement à l'exécution,
   et une variable de build reste lisible dans l'historique de l'image.

Coolify lit le fichier et affiche les variables dans son interface :

| Variable           | Valeur                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST_USERS`       | **à remplir** : comptes admin `identifiant:motdepasse:Nom affiché`, séparés par `\|` ; le déploiement est bloqué tant qu'elle est vide |
| `JWT_SECRET`       | généré par Coolify (64 caractères), conservé entre deux déploiements                                                                   |
| `SERVER_HOST_URL`  | **à remplir** : l'adresse publique, sans port, par exemple `https://meet.exemple.fr`                                                   |
| `TRUST_PROXY`      | `2` par défaut (Cloudflare + proxy Coolify)                                                                                            |
| `SFU_ANNOUNCED_IP` | l'IP publique du VPS (recommandé). Vide : détectée au démarrage, et le serveur s'arrête si la détection échoue                         |
| `UI_STYLE`         | `sobre` par défaut, ou `papier`                                                                                                        |
| `SOURCE_URL`       | lien vers le code source de l'instance (AGPL-3.0, article 13)                                                                          |

Les autres réglages de [`.env.template`](.env.template) peuvent être ajoutés dans Coolify.

Le serveur refuse de démarrer si `JWT_SECRET` manque ou est trop court,
ou si `HOST_USERS` est vide ou contient des identifiants connus (`admin:admin`…).

Réseau :

- Le port HTTP `3010` passe par Coolify et Cloudflare.
- Les flux audio et vidéo ne passent pas par Cloudflare. Les ports `40000-40100`, en UDP et en TCP,
  doivent être ouverts directement sur le serveur (pare-feu de l'hébergeur compris).
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

Sur un serveur Ubuntu sans Coolify, `sudo ./install.sh` construit l'image à partir du dépôt
et demande le compte admin.

En local, le serveur utilise le certificat de test de `app/ssl` ; le navigateur demande de l'accepter.

## Personnalisation

- `UI_STYLE` : `sobre` (graphite, accent bleu) ou `papier` (tons chauds, accent vert).
- `SHOW_*` : affiche ou masque chaque bouton de la visio.
- `BRAND_*` : nom, description et textes des pages.

Le code propre au fork est rangé dans des fichiers séparés, pour limiter les conflits avec l'upstream :

| Fichier                     | Rôle                                                     |
| --------------------------- | -------------------------------------------------------- |
| `public/css/tllm.css`       | apparence de la visio                                    |
| `public/css/tllm-pages.css` | accueil, connexion, attente, erreurs                     |
| `public/js/tllm.js`         | menu « Plus », chargement à la demande des bibliothèques |
| `public/js/TllmHome.js`     | page d'accueil                                           |
| `app/src/AdminAuth.js`      | session admin, noms de visio                             |
| `app/src/ClientIp.js`       | IP du client derrière les proxys                         |

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
