# Frigate

Intégrez les caméras de votre [Frigate NVR](https://frigate.video) dans Gladys
Assistant : images, mouvement, objets détectés, alertes de revue,
interrupteurs des caméras, et déclencheurs de scènes pour réagir quand une
personne, une voiture ou un animal apparaît.

## Prérequis

- **Gladys Assistant 5.1 ou plus.**
- **Frigate 0.16, 0.17 ou 0.18.** L'intégration lit la version et la
  configuration de Frigate, et n'expose que ce que votre Frigate active
  réellement.
- Recommandé : le broker MQTT sur lequel Frigate publie. Sans broker,
  l'intégration se rabat sur le WebSocket de Frigate.
- Pas encore de Frigate ? Gladys peut l'installer et le faire tourner pour
  vous sur une machine adaptée : voir « Frigate installé par Gladys (mode
  géré) ».

## Démarrage rapide

1. Dans Frigate, créez un compte dédié : **Settings → Users → Add user**,
   rôle `viewer` (suffisant avec un broker MQTT, voir plus bas).
2. Dans Gladys, installez **Frigate** depuis le store des intégrations, puis
   ouvrez son onglet **Configuration** : URL de Frigate
   `https://<ip-frigate>:8971`, le compte, et le broker MQTT sur lequel
   Frigate publie. Enregistrez.
3. Le statut en haut indique « Connecté à Frigate …, Flux temps réel : broker
   MQTT connecté ». **Tester la connexion** donne le détail.
4. Dans l'onglet **Découverte**, cliquez sur **Ajouter à Gladys** pour vos
   caméras.
5. Créez des scènes avec les déclencheurs **Frigate** (voir Scènes).

## Frigate installé par Gladys (mode géré)

Pas encore de Frigate ? Choisissez **Frigate installé par Gladys (géré)**
dans la section **Déploiement** : Gladys fait tourner Frigate 0.18 dans un
conteneur à lui, à côté de l'intégration, et écrit sa configuration pour
vous. Sinon, gardez **Instance Frigate existante (distante)**, le
fonctionnement décrit dans le reste de cette page.

### Prérequis

- Une machine adaptée à l'analyse vidéo : un mini PC x86 récent (Intel N100
  ou mieux), idéalement avec un Google Coral ou un GPU Intel. Frigate dispose
  de 4 Go de RAM et 2 CPU au plus. Sur un **Raspberry Pi ou un NAS**,
  préférez un Frigate existant sur une machine à part (mode distant).
- De la place pour les enregistrements : ils sont stockés dans le dossier de
  données de Gladys (une carte SD s'use vite en enregistrement continu —
  préférez un SSD).
- L'image Frigate (plus de 1 Go) est téléchargée à l'installation de
  l'intégration, même si vous ne la démarrez jamais.

### Accélération matérielle

À l'installation de l'intégration, Gladys liste le matériel que le conteneur
Frigate peut utiliser — **Coral USB**, **Coral PCIe**, **GPU** (`/dev/dri`) —
avec ce qu'il a détecté. Autorisez ce que vous avez ; vous pouvez le changer
ensuite dans le bloc **Matériel** de l'intégration (contrôles de
supervision) : Gladys recrée alors le conteneur Frigate, et l'intégration
régénère la configuration et redémarre Frigate.

- **Détecteur d'objets** (section mode géré) : **Automatique** choisit un
  Coral (USB, puis PCIe), puis un GPU Intel (OpenVINO), sinon le CPU. Un choix
  explicite dont le matériel n'est pas autorisé ou pas détecté revient au
  choix automatique, et le statut le dit.
- **Fabricant du GPU** : l'intégration ne peut pas le lire depuis son
  conteneur. Intel : détection OpenVINO et décodage vidéo VAAPI
  (`ffmpeg.hwaccel_args: preset-vaapi`) ; AMD : décodage VAAPI seulement,
  détection sur CPU ; Aucun : le GPU n'est pas utilisé. Les GPU NVIDIA ne
  sont pas pris en charge en mode géré.
- La détection sur CPU seul fonctionne, lentement et en consommant beaucoup :
  le statut le signale.

### Démarrer, arrêter, redémarrer

1. Choisissez le mode géré, enregistrez. Le statut indique « pas encore
   démarré ».
2. Cliquez sur **Démarrer Frigate** : l'intégration écrit la configuration de
   Frigate, puis demande à Gladys de démarrer le conteneur. Le statut suit :
   « démarre… », puis « Connecté à Frigate 0.18.0 (installé par Gladys) ». Le
   premier démarrage peut prendre quelques minutes.
3. Cliquez sur **Afficher les identifiants Frigate** : l'adresse de
   l'interface Frigate, `https://<adresse de Gladys>:<port>` (le port
   attribué par Gladys, aussi le lien « Interface Frigate » du bloc de
   supervision et de la section mode géré), et le compte `admin` créé par
   l'intégration. Le certificat est auto-signé : acceptez-le dans votre
   navigateur. La réponse n'est affichée que pour vous.
4. Dans l'interface Frigate, ajoutez vos caméras (son éditeur de
   configuration), puis **Rafraîchir les caméras** et ajoutez-les depuis
   l'onglet Découverte, comme en mode distant. La gestion des caméras depuis
   Gladys arrive dans une version suivante.

**Arrêter Frigate** arrête le conteneur (Gladys ne le relance pas) ;
**Redémarrer Frigate** régénère la configuration et le redémarre.
Enregistrer la configuration de l'intégration applique aussitôt les réglages
du mode géré : un Frigate démarré ne redémarre que si sa configuration
change vraiment.

### Configuration et données

L'intégration n'écrit que les parties de `config.yml` qui lui reviennent ;
tout ce que vous réglez dans l'interface Frigate (caméras, zones, masques,
flux go2rtc, utilisateurs) est conservé :

- `mqtt` : désactivé, ou le broker de la section **Flux temps réel** —
  Frigate publie alors sur ce broker **avec le même compte** que
  l'intégration : son ACL doit alors contenir `topic readwrite frigate/#`.
  Le mot de passe du broker est transmis à Frigate par l'environnement de son
  conteneur, jamais dans `config.yml`. MQTT sur TLS : Frigate n'accepte qu'un
  certificat de broker signé par une autorité publique, ou par l'autorité
  collée dans les réglages experts (un broker auto-signé doit l'y avoir ;
  une empreinte épinglée ne s'applique pas à Frigate). Sans broker,
  l'intégration utilise le WebSocket de Frigate.
- `detectors` (et la section `model` d'OpenVINO qui va avec), et
  `ffmpeg.hwaccel_args` quand VAAPI s'applique et que vous n'avez pas écrit de
  section `ffmpeg`. En mode automatique, une section `detectors` écrite par
  vous est conservée.
- La conservation des enregistrements : **continu** (2 jours par défaut),
  **alertes** (7), **détections** (7) et **captures** (14) ; 0 = aucun. Une
  valeur enregistrée dans Gladys l'emporte ; videz un champ pour garder la
  valeur réglée dans l'interface Frigate.

Où sont les données, dans le dossier de données de l'intégration
(`/data/containers/frigate/…` vu de l'intégration) :

| Dossier         | Contenu                                                     |
| --------------- | ----------------------------------------------------------- |
| `config`        | `config.yml`, la base de Frigate (utilisateurs, événements) |
| `media/frigate` | enregistrements, clips et captures                          |
| `tmp/cache`     | segments d'enregistrement en cours d'écriture               |

`/tmp/cache` est un dossier sur disque, pas en mémoire : le bac à sable de
Gladys monte un `/tmp` de 64 Mo en RAM, trop petit pour le cache de Frigate.
L'intégration garde le mot de passe admin dans son propre
`managed/state.json` (lisible par elle seule). Désinstaller l'intégration
supprime tout, enregistrements compris.

### Frigate ne reste pas démarré

Le bac à sable de Gladys applique à Frigate les mêmes limites qu'à tout
conteneur d'intégration : **100 processus et threads** au plus, un `/tmp` de
64 Mo, **aucune capability Linux**, trois ports publiés. Frigate (un ffmpeg
par caméra, go2rtc, nginx, des workers Python) peut ne pas démarrer ou
s'arrêter sous ces limites. Le statut indique alors « Frigate ne reste pas
démarré » (le conteneur redémarre sans cesse) ou « ne répond pas depuis
5 min ». Que faire :

- **Redémarrer Frigate** une fois, et consulter les journaux de
  l'intégration.
- Moins de caméras, ou un Coral plutôt que la détection sur CPU, utilisent
  moins de processus.
- Gladys compte les plantages : au bout de cinq, il arrête toute
  l'intégration.
- Si cela persiste, utilisez un Frigate existant sur une machine à part (mode
  distant) : ces limites sont en cours d'assouplissement dans Gladys
  (réglages du bac à sable des sous-conteneurs).

## Connexion à Frigate

| Champ                      | Valeur                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL de Frigate             | `https://<ip-frigate>:8971` (port authentifié, recommandé). Le port `5000` fonctionne mais n'a **aucune authentification** : un avertissement s'affiche dans le statut.  |
| Utilisateur / mot de passe | Un **compte Frigate dédié**. Le rôle `viewer` (ou un rôle personnalisé limité à vos caméras) suffit : les commandes des caméras passent par MQTT, pas par l'API Frigate. |

### Certificat : approuvé à la première connexion

Le port 8971 de Frigate utilise par défaut un certificat auto-signé. Vous
n'avez rien à faire :

- un certificat **signé par une autorité** (Let's Encrypt, l'autorité de votre
  entreprise installée sur le système…) est vérifié normalement, et ses
  renouvellements continuent de fonctionner, à condition que l'URL de Frigate
  utilise un nom couvert par le certificat (joint par son adresse IP, il est
  traité comme un certificat auto-signé, et chaque renouvellement vous
  demande de l'approuver à nouveau) ;
- un certificat **auto-signé** est **approuvé à la première connexion**, puis
  **épinglé** : s'il change ensuite (Frigate réinstallé, certificat régénéré…
  ou quelqu'un qui se fait passer pour Frigate), la connexion est refusée et
  le statut explique pourquoi.

Si vous savez que le certificat a changé pour une raison légitime, cliquez sur
**Faire confiance au nouveau certificat** dans l'onglet Configuration : la
connexion suivante approuve et épingle le nouveau certificat. Il en va de même
pour le broker MQTT quand TLS est activé.

La première connexion est le seul moment où le certificat n'est pas vérifié :
faites-la sur votre réseau local, pas à travers un réseau non maîtrisé.

### Réglages experts (facultatif)

En bas de l'onglet Configuration, renseignez **un** de ces champs pour
remplacer l'approbation à la première connexion :

- **Empreinte SHA-256 du certificat épinglé** : seul ce certificat exact est
  accepté. Pour la lire, depuis la machine de Frigate ou une machine de
  confiance :

  ```bash
  openssl s_client -connect <ip-frigate>:8971 </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```

- **Autorité de certification (PEM)** : votre propre autorité ; le certificat
  doit être signé par elle et correspondre au nom d'hôte.

## Flux temps réel (MQTT)

Renseignez l'hôte, le port, les identifiants du broker et le préfixe des
topics Frigate (`frigate` par défaut). Donnez à l'intégration son propre
compte sur le broker, avec cette ACL (syntaxe Mosquitto) :

```
user gladys-frigate
topic read frigate/#
topic write frigate/+/+/set
topic write frigate/+/ptz
```

La dernière ligne ne sert qu'aux caméras PTZ (voir plus bas).

Laissez l'hôte du broker vide pour utiliser le WebSocket de Frigate à la place.
Les commandes des caméras (les interrupteurs) demandent alors un compte
Frigate **admin** : depuis Frigate 0.17, le WebSocket les refuse aux autres
rôles (sauf les commandes PTZ).

Le statut de connexion indique l'état du flux (« Flux temps réel : broker
MQTT connecté », ou pourquoi pas). Une panne réseau est réessayée toute
seule ; un certificat ou un compte refusé arrête le flux jusqu'à ce que vous
corrigiez le problème et cliquiez sur **Tester la connexion** (ou
enregistriez la configuration). Quand Frigate s'annonce hors ligne
(redémarrage), le statut le signale, et sa configuration est relue à son
retour (au plus une fois par minute).

MQTT ne conserve aucun comptage d'objets : quand le flux se connecte, et
quand Frigate revient en ligne, l'intégration lit une fois les objets
présents sur chaque caméra via le WebSocket de Frigate. Une présence ne reste
donc jamais bloquée sur un comptage perdu entre-temps. Le compte Frigate doit
pouvoir ouvrir son WebSocket (c'est le cas de tous les rôles).

Un Frigate qui perd sans cesse sa connexion au broker (trois fois en cinq
minutes) perd ses messages : détections, comptages et mouvements arrivent en
retard dans Gladys, ou jamais. Le statut et les logs l'indiquent alors
(« Frigate perd sans cesse sa connexion MQTT »). La cause habituelle : un
autre client MQTT utilise le même identifiant que Frigate (`mqtt.client_id`,
`frigate` par défaut), par exemple une seconde instance de Frigate, un ancien
conteneur resté démarré ou un autre outil. Donnez à chacun son propre
`client_id`. Les logs de Frigate montrent alors `MQTT disconnected`.

Chaque incident est aussi écrit dans les logs de l'intégration (**Voir les
logs**) : `front: person detected, 87 %`, `front: person entered porch,
87 %`, `front: review alert, person, car in porch`.

## Les caméras dans Gladys

Ouvrez l'onglet **Découverte** de l'intégration : chaque caméra de Frigate y
est listée (cliquez sur **Scanner** pour relire Frigate). Cliquez sur
**Ajouter à Gladys** pour celles que vous voulez. Chaque appareil caméra
porte ce que sa configuration Frigate active :

| Fonctionnalité                       | Rôle                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                                | Rafraîchie chaque minute (moins de 60 Ko, voir plus bas), prise à l'instant jusqu'à 150 Ko quand Gladys la demande (vue live, chat, scènes). |
| Caméra activée (Camera enabled)      | Allume ou éteint la caméra **dans Frigate** (ni détection ni enregistrement quand elle est éteinte) ; Gladys n'en montre alors plus l'image. |
| Détection d'objets, instantanés      | Les interrupteurs de Frigate.                                                                                                                |
| Enregistrements, détection audio     | Seulement s'ils sont activés dans le fichier de configuration de Frigate : sinon Frigate refuse de les allumer.                              |
| Mouvement                            | Le mouvement vu par Frigate.                                                                                                                 |
| Un capteur par objet suivi (Person…) | Présent / absent, et son nombre. Plus le total des objets.                                                                                   |
| Statut de revue                      | none (aucune), detection ou alert.                                                                                                           |
| Capteurs de zone                     | Avec l'option « Capteurs d'occupation par zone » : un capteur de présence par zone et par objet.                                             |
| Mouvement, Position (Preset)         | Caméras avec une section ONVIF dans Frigate : orientation, zoom et presets (voir « Caméras PTZ »).                                           |

Un interrupteur n'est affiché comme changé qu'une fois confirmé par Frigate.
Sans broker MQTT, le WebSocket de Frigate n'accepte les commandes que d'un
compte **admin** (Frigate 0.17 et plus) : avec un autre rôle, la commande
échoue avec cette explication.

Frigate réduit les images (le conteneur n'embarque aucune bibliothèque
d'image). L'image enregistrée sur l'appareil reste sous 60 Ko : l'écran des
appareils de Gladys enregistre un appareil en le renvoyant en entier, image
comprise, et refuse plus de 100 Ko. Avec une image plus grosse, renommer une
caméra ou changer sa pièce échouait.

Le badge de chaque caméra signale quand elle n'est pas nominale : injoignable
quand Frigate ne répond pas, s'annonce hors ligne depuis 30 secondes, ou que
le flux de la caméra est perdu depuis 30 secondes ; dégradée quand son flux
d'enregistrement est interrompu, que le flux temps réel est coupé, ou que
Frigate perd sans cesse sa connexion au broker (les états peuvent alors être
périmés).

Une caméra ajoutée avec une version précédente de l'intégration affiche
**Mettre à jour** dans l'onglet Découverte : cliquez dessus pour ajouter les
nouvelles fonctionnalités.

## Caméras PTZ

Frigate pilote l'orientation, le zoom et les positions enregistrées
(presets) d'une caméra dont la configuration a une section `onvif` (le port
et le compte ONVIF de la caméra, pas ceux du RTSP) :

```yaml
cameras:
  garden:
    onvif:
      host: 192.168.1.20
      port: 2020 # Tapo ; Reolink 8000 ; beaucoup d'autres 80
      user: admin
      password: mot-de-passe-de-la-camera
```

L'intégration demande à Frigate ce que cette caméra sait faire
(`/api/<camera>/ptz/info`) et son appareil gagne deux fonctionnalités :

| Fonctionnalité       | Rôle                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Mouvement (Movement) | Gauche / droite, haut / bas, zoom avant / arrière : seulement les mouvements que la caméra fait en continu (`pt`, `zoom` de Frigate). |
| Position (Preset)    | Envoie la caméra sur l'un de ses presets ONVIF, listés par nom dans l'ordre donné par Frigate.                                        |

Utilisez-les depuis le widget **Appareils de la pièce** du tableau de bord
(une ligne de flèches, de boutons de zoom et d'arrêt, et une liste de
presets), depuis le pad du widget **Caméra** sur sa vue en direct, et dans
les scènes : « Contrôler un appareil » avec le numéro du preset (1 pour le
premier de la liste) tourne la caméra vers la porte quand vous partez.

**Arrêt de sécurité.** Frigate fait tourner une caméra jusqu'à ce qu'on lui
dise d'arrêter. Chaque mouvement est arrêté automatiquement au bout de
**1,5 seconde** si aucun autre ordre n'arrive avant : un relâchement perdu
par le navigateur, ou une scène qui envoie un mouvement seul, ne laisse
jamais la caméra tourner contre sa butée. Un bouton maintenu plus longtemps
arrête la caméra au bout de 1,5 s : appuyez de nouveau pour aller plus loin.
Un preset demandé pendant un mouvement arrête d'abord ce mouvement.

Les commandes passent par le flux temps réel, et Frigate ne renvoie rien en
retour : une commande est acquittée dès son envoi. Avec un broker MQTT, son
ACL doit autoriser l'intégration à écrire `frigate/+/ptz` (voir plus haut).
Sans broker, le WebSocket de Frigate accepte les commandes PTZ de
**n'importe quel** rôle Frigate (contrairement aux interrupteurs, qui
demandent un compte admin depuis Frigate 0.17).

Les presets se créent et se renomment dans l'application de la caméra (ou
dans Frigate). Cliquez ensuite sur **Rafraîchir les caméras** : la liste des
presets des appareils déjà ajoutés se met à jour d'elle-même (le tableau de
bord l'affiche à son prochain chargement). Une caméra ajoutée avant cette
version affiche **Mettre à jour** dans l'onglet Découverte : cliquez dessus
pour ajouter les fonctionnalités PTZ. Si Frigate ne répond pas pour une
caméra (ONVIF pas encore prêt après un redémarrage), seule cette caméra
reste sans ses commandes dans l'onglet Découverte jusqu'à la lecture
suivante ; avec une version de Gladys qui ne connaît pas encore les
fonctionnalités PTZ, les caméras sont listées sans elles (un avertissement
dans les logs le signale).

## Scènes

Trois déclencheurs, **une fois par incident** (jamais une fois par image),
au-dessus de la confiance minimale et hors cooldown (voir Options). Les faux
positifs et les objets immobiles ne déclenchent jamais.

| Déclencheur                         | Se déclenche quand                                                                                      | Filtres                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Frigate : nouvelle revue            | Frigate ouvre une revue (alerte ou détection) ; une fois de plus quand une détection devient une alerte | caméra, sévérité, objet, zone |
| Frigate : objet détecté             | Frigate commence à suivre un objet (personne, voiture…)                                                 | caméra, objet, zone           |
| Frigate : objet entre dans une zone | Un objet suivi entre dans une zone définie dans Frigate                                                 | caméra, zone, objet           |

L'objet et la zone sont les noms utilisés dans Frigate, en minuscules
(`person`, `car`, `dog`, `cat`, `bicycle`… pour les objets, ceux de
`objects.track` ; `porch`… pour les zones) ; un champ vide accepte n'importe
quelle valeur. Les objets suivis par une caméra sont aussi ses capteurs de
présence (Person, Car…). « Objet détecté » ne se déclenche que sur un objet
confirmé par la détection de Frigate, au-dessus de la confiance minimale :
un simple mouvement ne le déclenche jamais (le mouvement est le capteur
« Motion » de la caméra). Une revue est filtrée sur son objet **principal** (le premier des
objets suivis par la caméra, dans l'ordre de la configuration Frigate) et sa
première zone ; tous sont dans les variables `objects` et `zones`. Variables
disponibles dans les actions suivantes : `camera`, `camera_name`, `label`,
`sub_label` (visage ou plaque reconnus par Frigate), `zone`, `zones`, `score`
(%), `severity`, `objects`, `event_id`, `review_id`.

Sur une alerte, l'intégration publie une image fraîche de la caméra **avant**
de déclencher : l'action « Envoyer une image de caméra » placée juste après
envoie bien l'alerte.

**Action « Frigate : joindre l'image de l'événement »** : publie l'instantané
que Frigate a gardé pour un événement (avec ou sans son cadre de détection)
comme image de la caméra (celle de l'événement par défaut). Utilisez
`{{triggerEvent.data.event_id}}` comme identifiant, puis « Envoyer une image
de caméra ». Pendant une minute, c'est aussi l'image que Gladys reçoit quand
il demande une image en direct de cette caméra (« Envoyer une image de
caméra », la vue en direct du tableau de bord). Quand Frigate ne garde pas
d'instantané pour la caméra, ou en garde un trop lourd pour Gladys, sa
miniature est utilisée. Une fois l'événement terminé, Frigate sert
l'instantané qu'il a enregistré : le cadre suit alors son propre réglage
`snapshots.bounding_box`.

Exemple — une photo sur votre téléphone quand quelqu'un vient à la porte :

1. Déclencheur **Frigate : nouvelle revue**, caméra _Porte d'entrée_,
   sévérité _Alerte_, objet `person`.
2. Action **Frigate : joindre l'image de l'événement**, identifiant
   `{{triggerEvent.data.event_id}}`.
3. Action **Envoyer une image de caméra** _Porte d'entrée_ à vous-même.

## Options

- **Confiance minimale** (70 % par défaut) : les déclencheurs d'objets ne se
  déclenchent qu'au-dessus (les revues n'ont pas de score : les seuils de
  Frigate s'appliquent).
- **Cooldown des déclencheurs** (30 s par défaut) : au plus un déclenchement
  par caméra et type d'objet (et par zone pour les déclencheurs de zone ; par
  caméra et sévérité pour les revues) et par période, pour qu'un incident
  n'inonde pas vos scènes. Les faux positifs et les objets immobiles (une
  voiture garée) ne déclenchent jamais.
- **Capteurs d'occupation par zone** (désactivés par défaut) : un capteur de
  présence par zone et par objet suivi.

## Vidéo en direct

Le bouton ⏵ du widget **Caméra** du tableau de bord lit la vidéo en direct
d'une caméra Frigate, à la maison comme à distance via Gladys Plus. Gladys lit
le restream go2rtc intégré à Frigate (`rtsp://<hôte>:8554/<nom_camera>`) et le
convertit en flux HLS chiffré, exactement comme pour ses propres caméras RTSP ;
le réglage de **latence** du widget s'applique. Rien à ajouter à la main :
chaque appareil caméra porte l'adresse de son restream, mise à jour
automatiquement quand vous changez les options ci-dessous (inutile de recréer
l'appareil).

Prérequis (mode distant, un Frigate existant) :

- Le restream RTSP go2rtc de Frigate est activé (le défaut de Frigate) et
  chaque caméra a un flux go2rtc portant le nom de la caméra Frigate (section
  `go2rtc:` → `streams:` de la configuration de Frigate).
- Le port **8554** de la machine Frigate est publié (ports docker par défaut
  de Frigate) et joignable depuis la machine Gladys (pare-feu, VLAN).
- Le restream n'a pas de mot de passe (le défaut de go2rtc) : un restream
  protégé par un utilisateur et un mot de passe n'est pas pris en charge.

Options (section **Options** de la configuration) :

- **Direct : hôte RTSP** (vide par défaut) : l'hôte de l'URL de Frigate est
  utilisé. Renseignez-le quand le restream est joignable à une autre adresse
  (Frigate derrière un reverse proxy, une autre interface réseau). Nom d'hôte
  ou adresse IP seuls, sans `rtsp://` ni port.
- **Direct : port RTSP** (8554 par défaut) : le port go2rtc publié, si vous
  l'avez redirigé ailleurs.

En mode géré (Frigate installé par Gladys), le port attribué par Gladys est
utilisé automatiquement et l'hôte vaut `127.0.0.1` par défaut.

Limites : chaque personne qui regarde le widget lance sa propre conversion
ffmpeg sur la machine Gladys (une connexion RTSP à go2rtc par vue en direct,
pas par caméra), et la vidéo passe par HLS, avec quelques secondes de retard
sur le temps réel : les flux WebRTC et MSE de go2rtc ne sont pas utilisés. La
rotation d'image des caméras RTSP de Gladys (`CAMERA_ROTATION`) n'est pas
disponible. Une caméra désactivée (fonctionnalité « Caméra activée » à 0) ne
se lit pas en direct, comme dans Frigate.

## Boutons de la configuration

- **Tester la connexion** : la version et les caméras de Frigate, la façon
  dont son certificat est approuvé, le compte utilisé, et une connexion au
  broker MQTT (ou le rappel que le WebSocket de Frigate est utilisé sans
  broker).
- **Rafraîchir les caméras** : relit la configuration de Frigate (après
  l'ajout d'une caméra, par exemple) et met à jour la liste de l'onglet
  Découverte.
- **Faire confiance au nouveau certificat** : oublie les certificats épinglés
  de Frigate et du broker, se reconnecte et affiche l'empreinte désormais
  épinglée. En cas de doute, comparez-la à celle de votre Frigate (commande
  ci-dessus).
- **Démarrer Frigate**, **Arrêter Frigate**, **Redémarrer Frigate**,
  **Afficher les identifiants Frigate** : mode géré uniquement (voir
  « Frigate installé par Gladys ») ; en mode distant, ils répondent qu'ils
  ne s'appliquent pas. En mode géré, **Tester la connexion** montre aussi
  l'état du conteneur Frigate, le détecteur, la conservation et l'espace
  occupé par les enregistrements.

Quand Frigate est injoignable, l'intégration réessaie chaque minute. Un
certificat ou des identifiants refusés attendent en revanche votre action :
réessayer ne ferait que bloquer le compte (Frigate limite les connexions
échouées).

## Sécurité

- L'intégration ne parle qu'à Frigate et au broker, sur votre réseau ; elle
  tourne dans un conteneur isolé (lecture seule, sans privilèges, son seul
  dossier modifiable contient les certificats épinglés).
- Un compte Frigate dédié de rôle `viewer` (ou un rôle limité à certaines
  caméras) ne peut pas modifier la configuration de Frigate. Avec MQTT, le
  compte du broker ci-dessus ne peut que lire les topics de Frigate et
  envoyer les commandes des caméras.
- Certificats : vérifiés par une autorité, ou épinglés à la première
  connexion (voir plus haut) ; le jeton Frigate et le mot de passe du broker
  ne partent qu'une fois le certificat approuvé.
- Les mots de passe, jetons et cookies n'apparaissent jamais dans les logs ni
  dans le statut.
- Le port 5000 et MQTT sans TLS fonctionnent, avec un avertissement dans le
  statut : réservez-les à un réseau de confiance.
- Mode géré : l'intégration joint Frigate sur son port interne 5000
  uniquement par le réseau privé de l'intégration (jamais publié sur votre
  réseau) ; vous accédez à l'interface Frigate par son port authentifié, avec
  le compte `admin` créé par l'intégration. Seuls l'interface et le restream
  RTSP go2rtc sont publiés, sur des ports choisis par Gladys.

## Dépannage

Le statut de connexion en haut de l'onglet Configuration dit ce qui ne va
pas ; **Tester la connexion** revérifie tout. Les logs de l'intégration
(contrôles de supervision, **Voir les logs**) ne contiennent jamais de mot de
passe ni de jeton.

| Symptôme                                                | À vérifier                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| « Frigate ne reste pas démarré » (mode géré)            | Les limites du bac à sable de Gladys (100 processus, `/tmp` de 64 Mo, aucune capability) : voir « Frigate ne reste pas démarré ». Le mode distant les contourne.   |
| « pas encore démarré » (mode géré)                      | Cliquez sur **Démarrer Frigate** ; Frigate ne démarre jamais seul la première fois.                                                                                |
| Le statut géré indique « aucun sous-conteneur Frigate » | Mettez à jour Gladys et l'intégration (les sous-conteneurs demandent Gladys 5.1 ou plus), ou choisissez le mode distant.                                           |
| « Le certificat de … a changé »                         | Frigate réinstallé ou certificat régénéré : cliquez sur **Faire confiance au nouveau certificat**. Sinon, quelqu'un se fait peut-être passer pour Frigate.         |
| « Frigate a refusé l'utilisateur ou le mot de passe »   | Le compte de l'onglet Configuration. Après plusieurs échecs, Frigate bloque les connexions un moment : l'intégration ne réessaie pas d'elle-même.                  |
| L'onglet Découverte est vide                            | Le statut : Frigate doit être joignable. Puis **Scanner**.                                                                                                         |
| Pas d'image sur le tableau de bord                      | La caméra est allumée dans Frigate et dans Gladys ; attendez une minute après l'avoir ajoutée.                                                                     |
| Un interrupteur échoue (« did not confirm », « admin ») | Sans broker, Frigate 0.17+ n'accepte les commandes que d'un compte admin ; avec un broker, son ACL doit autoriser `frigate/+/+/set`.                               |
| Une caméra PTZ ne bouge pas                             | Avec un broker, son ACL doit autoriser `frigate/+/ptz` ; sinon les logs de Frigate (ONVIF). Pas de commande PTZ : **Rafraîchir les caméras**.                      |
| « Flux temps réel arrêté »                              | Le broker a refusé le compte ou le certificat : corrigez, puis **Tester la connexion**.                                                                            |
| Badge de caméra « injoignable »                         | Frigate est arrêté ou redémarre, ou le flux de la caméra est perdu depuis 30 s (vérifiez la caméra dans Frigate).                                                  |
| Une scène ne se déclenche pas                           | La confiance minimale et le cooldown (Options) ; les noms d'objet et de zone sont ceux de Frigate (`person`, pas `Personne`) ; les logs montrent chaque incident.  |
| Une caméra ajoutée avant une mise à jour n'a pas tout   | L'onglet Découverte affiche **Mettre à jour** à côté d'elle.                                                                                                       |
| « Frigate perd sans cesse sa connexion MQTT »           | Un autre client MQTT utilise le `mqtt.client_id` de Frigate (`frigate` par défaut) : donnez à chacun le sien. En attendant, états et scènes ratent des événements. |
| Renommer une caméra ou changer sa pièce échoue          | Corrigé en 0.3.2 : attendez une minute après la mise à jour (la petite image remplace celle enregistrée), puis enregistrez de nouveau.                             |

### Boutons de diagnostic

Deux boutons de l'onglet Configuration aident à demander de l'aide (forum,
ticket GitHub). **Diagnostic** propose un choix de **Rapport** :

- **Diagnostic**, rapport **Vue d'ensemble** (par défaut) : un texte avec les versions de l'intégration et
  de Frigate, le mode, si Frigate répond, le flux temps réel (broker MQTT ou
  WebSocket de Frigate, son état, l'âge du dernier message, si Frigate perd
  sans cesse sa connexion au broker), chaque caméra (images par seconde de
  la caméra, de la détection et sautées, le `status/<rôle>` que publie
  Frigate 0.17+), les détecteurs (type, vitesse d'inférence, détection
  bloquée), le stockage (enregistrements, cache, mémoire partagée), les
  certificats épinglés (empreintes seulement) et les avertissements. En mode
  géré, il ajoute le conteneur Frigate (état, état souhaité, heure de
  démarrage, ports hôte, matériel autorisé et détecté), le détecteur choisi,
  la conservation, l'emplacement du `config.yml` généré, si le mot de passe
  admin est défini (oui ou non, jamais le mot de passe) et le conseil de
  ressources ci-dessous.
- **Diagnostic**, rapport **Derniers messages temps réel (MQTT /
  WebSocket)** : les 50 derniers messages
  envoyés par Frigate (parmi les 200 derniers gardés en mémoire depuis le
  démarrage de l'intégration), du plus récent au plus ancien, sous la forme
  `HH:MM:SS topic contenu` en UTC. Les contenus sont coupés à 2000
  caractères et les images affichées `[binary, N bytes]`. Pratique pour
  vérifier que Frigate publie, et quoi : une caméra qui n'apparaît jamais, un
  nom d'objet.
- **Proposer une caméra au catalogue** : saisissez la marque, le modèle, le
  type de flux et des notes (chemins de flux, réglages qui marchent), et le
  bouton répond par un lien vers un ticket GitHub pré-rempli sur ce dépôt.
  Ouvrez-le dans votre navigateur, relisez-le et envoyez-le avec votre
  compte GitHub : l'intégration n'envoie rien elle-même. Le texte contient
  les versions mais ni adresse ni mot de passe ; ce qui y ressemble dans les
  notes est masqué, vérifiez tout de même.

**Partager sans risque** : le rapport et les messages ne contiennent jamais
de mot de passe, de jeton, de cookie ni le mot de passe du broker. Ils
contiennent en revanche des noms d'hôte et des adresses IP (Frigate,
broker) : masquez-les avant une publication si vous le souhaitez.

**Conseil de ressources (mode géré)** : Frigate garde ses images décodées
en mémoire partagée. L'intégration en conseille 256 Mo pour une caméra plus
64 Mo par caméra supplémentaire, et environ 1 Go de mémoire plus 256 Mo par
caméra (512 Mo de plus quand la détection tourne sur le CPU) : un ordre de
grandeur, pas une mesure. Gladys donne au conteneur Frigate des limites
fixes quelle que soit la machine (512 Mo de mémoire partagée, 4 Go de
mémoire, 2 CPU) : au-delà de 5 caméras, le conseil le signale ; préférez
alors le mode distant, tant que le core de Gladys ne permet pas des limites
relatives à la machine (voir `ROADMAP.md`, issues #12 et #14). **Tester la
connexion** affiche le même conseil en une ligne.

**Les logs de Frigate** (mode géré) ne sont pas dans les logs de
l'intégration : ouvrez le bloc de supervision de l'intégration dans Gladys,
qui affiche les logs du sous-conteneur Frigate.
