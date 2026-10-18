# TLLM\*meet

Visioconférence privée, en français, pour des réunions jusqu'à une trentaine de personnes.

- Seuls l'administrateur et les modérateurs qu'il a invités ouvrent des visios.
- Les invités rejoignent par lien, sans compte.
- Ni ChatGPT ni DeepSeek : aucune intégration d'IA conversationnelle.

TLLM\*meet est un fork de [MiroTalk SFU](https://github.com/miroslavpejic85/mirotalksfu) (v2.6.25)
de Miroslav Pejic, sous licence [AGPL-3.0](LICENSE).

## Fonctionnalités

- Audio, vidéo et partage d'écran, via [mediasoup](https://mediasoup.org).
- Discussion avec messages privés, réactions, main levée.
- Sondages : une ou plusieurs réponses, vote anonyme ou nominatif, résultats cachés jusqu'à la clôture,
  clôture automatique, export en tableur.
- Notes partagées : plusieurs personnes écrivent en même temps, avec les curseurs de chacun ; export PDF ou texte.
- Tableau blanc : dessin à plusieurs, formes, texte, post-it, images et PDF, zoom au doigt ; export PNG ou PDF.
- Notes et tableau sont gardés par le serveur : les retardataires les retrouvent.
- Caler une réunion : sondage de dates façon Doodle, sans compte, avec abonnement d'agenda.
- Partage de vidéos et de fichiers pendant la visio.
- Salle d'attente, verrouillage de la visio, mot de passe optionnel.
- Enregistrement dans le navigateur, sous-titres (reconnaissance vocale du navigateur).
- Fond flou ou virtuel, réduction de bruit.
- Interface sobre, utilisable sur téléphone ; pages en mode clair ou sombre.

## Fonctionnement

1. L'admin se connecte sur `/login` avec un compte défini dans `HOST_USERS`.
2. Il donne un nom à la visio. Un suffixe aléatoire est ajouté, par exemple `point-hebdo-k7m2xq`.
3. Il partage le lien. Les invités entrent avec leur nom, sans compte.

Le lien ouvre la porte de la salle : son nom, un bandeau d'état, l'heure prévue, qui est déjà là.
Si un invité arrive avant l'admin, le bandeau indique « Pas encore commencée ». Il règle sa caméra et
son micro en attendant, puis entre tout seul dès que l'admin ouvre la salle.

Connecté, l'admin voit à l'accueil toutes ses salles avec leur état (en cours, réservée, fermée),
l'agenda des dates fixées et les sondages de dates en attente.

L'admin est présentateur de ses visios. Un invité ne le devient que si l'admin le promeut.

## Modérateurs

Les comptes de `HOST_USERS` sont les administrateurs. Un administrateur voit et gère tout :
toutes les salles (il en est présentateur), tous les sondages de dates, avec le nom de l'organisateur.

Un modérateur ouvre des salles et propose des sondages de dates, et les gère comme l'admin
(présentateur, verrou, salle d'attente, choix de la date…). Il ne voit que les siens : dans la salle
d'un autre, il entre comme un invité. Il ne gère pas les comptes.

Créer un compte, depuis l'accueil, bloc **Modérateurs** :

1. L'admin indique pour qui (un nom, facultatif) et clique sur **Créer un compte**.
2. Il obtient un lien `/invitation/…` à envoyer à la personne. Le lien sert une fois, pendant 7 jours.
3. La personne y choisit son identifiant et son mot de passe (avec confirmation), puis elle est connectée.
   Ensuite, elle se connecte sur `/login`.

L'admin ne voit ni l'identifiant ni le mot de passe. Pour un mot de passe oublié, **Mot de passe oublié**
donne de la même façon un lien, valable 48 heures, où la personne choisit un nouveau mot de passe ;
ses sessions ouvertes sont alors fermées. Supprimer un compte ferme aussi ses sessions.

Les comptes sont enregistrés dans `DATA_DIR/moderateurs.json` : mots de passe hachés (scrypt),
et seulement l'empreinte des liens en attente.

La session (admin ou modérateur) est un cookie signé, vérifié côté serveur (`HttpOnly`, `Secure`, `SameSite=Lax`).
Elle ne contient pas le mot de passe et expire après `HOST_SESSION_HOURS` heures.
La déconnexion la révoque, et changer le mot de passe invalide les sessions ouvertes.

## Caler une réunion

1. Depuis l'accueil, l'admin choisit **Proposer des dates** : un titre, une durée, des jours et des horaires
   (heure de Paris par défaut, voir `MEETING_TIMEZONE`).
2. Il envoie le lien `/rdv/…` par le moyen de son choix. TLLM\*meet n'envoie pas d'e-mail.
3. Chacun répond Oui, Si besoin ou Non, sans compte. La réponse se modifie depuis le même navigateur.
4. Quand le nombre de personnes attendues a répondu, le créneau qui a le plus de « Oui » est retenu
   (puis le plus de « Si besoin », puis le plus tôt). À la date limite, la date se fixe avec les réponses reçues.
   L'admin peut aussi choisir ou changer la date lui-même.
5. Une visio est réservée. La page du sondage affiche la date et le lien.

Après avoir répondu, chacun peut s'abonner au sondage depuis son agenda (Google, Apple, Outlook).
Le flux `/rdv/…/agenda.ics` reste vide tant que la date n'est pas fixée, puis contient le rendez-vous
avec le lien de la visio. Les agendas relisent un abonnement à leur rythme : quelques minutes sur iPhone,
jusqu'à plusieurs heures sur Google Agenda.

Les sondages sont enregistrés dans `DATA_DIR/rendez-vous.json`.

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
6. Le fichier déclare un volume `tllm-data`, monté sur `/src/data`. Coolify le crée tout seul
   (onglet _Persistent Storage_) : les sondages de dates, la liste des salles et les comptes modérateurs
   y sont gardés entre deux déploiements.
   Ne pas le supprimer.

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
| `MEETING_TIMEZONE` | fuseau des sondages de dates, `Europe/Paris` par défaut                                                                                |

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

| Fichier                                                                    | Rôle                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `public/css/tllm.css`                                                      | apparence de la visio                                            |
| `public/css/tllm-pages.css`                                                | pages hors visio : accueil, porte, connexion, erreurs            |
| `public/js/tllm.js`                                                        | menu « Plus », chargement à la demande des bibliothèques         |
| `public/js/TllmHome.js`                                                    | accueil : salles, agenda, sondages ; invité sans lien            |
| `public/js/TllmDoor.js`                                                    | porte d'une salle pas encore ouverte, réglages, entrée auto      |
| `public/js/TllmAfter.js`                                                   | page après la visio                                              |
| `app/src/RoomRegistry.js`                                                  | salles de l'admin (`DATA_DIR/salles.json`)                       |
| `public/fonts/`                                                            | Barlow et Barlow Condensed, licence OFL                          |
| `app/src/AdminAuth.js`                                                     | session admin ou modérateur, noms de visio                       |
| `app/src/Moderators.js`, `public/js/TllmInvitation.js`                     | comptes modérateurs, liens d'invitation                          |
| `app/src/ClientIp.js`                                                      | IP du client derrière les proxys                                 |
| `public/js/TllmRoom.js`, `public/css/tllm-room.css`                        | écran de la visio (barre, panneau, discussion, sondages)         |
| `public/js/TllmJoin.js`                                                    | écran avant d'entrer, autorisations caméra et micro              |
| `app/src/Collab.js`, `public/js/TllmCollab.js`                             | contenu partagé gardé par le serveur (Yjs)                       |
| `public/js/TllmEditor.js`                                                  | notes partagées                                                  |
| `public/js/TllmBoard.js`                                                   | tableau blanc                                                    |
| `app/src/DatePolls.js`, `public/js/TllmRdv*.js`, `public/css/tllm-rdv.css` | caler une réunion                                                |
| `app/client/collab-entry.mjs`                                              | source de `public/sfu/TllmCollabLib.js` (`npm run build:collab`) |

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

- qu'aucune nouvelle route ni nouvel événement socket ne crée une visio sans passer par `AdminAuth`
  (qui couvre aussi les modérateurs) ;
- que les nouvelles intégrations externes restent retirées ou désactivées par défaut.

## Licence

[AGPL-3.0](LICENSE). Le code source modifié doit rester accessible aux utilisateurs de l'instance :
c'est le rôle du lien `SOURCE_URL`, affiché dans « À propos ».

MiroTalk SFU © 2021 Miroslav Pejic. Les modifications TLLM\*meet sont publiées sous la même licence.
