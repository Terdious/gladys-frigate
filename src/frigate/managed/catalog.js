// -----------------------------------------------------------------------------
// Camera catalog of the managed mode: the models whose stream settings are
// known, so the user only types an address and an account.
//
// Ported from the core branch frigate-pr4 (server/services/frigate/lib/
// cameraCatalog.js) and its i18n notes, validated on real cameras and with
// the feedback of the community forum. Each entry gives:
//
//   - `id`: stable forever — it is the value of the `model` select of the
//     "Add a camera" button and is stored in /data/managed/cameras.json;
//   - `label` and `note` (en/fr): the select option, and what the user has
//     to do for this camera (shown in the result of the button);
//   - `allowedSourceTypes`: the go2rtc sources that work with the model
//     (a custom source is always possible);
//   - `preset`: the stream settings applied unless the user overrides them.
//
// Pure: no I/O, no Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

export const SOURCE_TYPES = Object.freeze({
  RTSP: 'rtsp',
  // go2rtc's tapo:// producer: Tapo cameras without RTSP (battery/solar).
  TAPO: 'tapo',
  ONVIF: 'onvif',
  // HTTP MJPEG stream (old cameras without RTSP), re-encoded to H264 by go2rtc.
  MJPEG: 'mjpeg',
  // Any go2rtc source typed by the user.
  CUSTOM: 'custom',
});

/** How a camera is moved / switched to night mode (PTZ milestones read it). */
export const CONTROL_PROTOCOLS = Object.freeze({
  ONVIF: 'onvif',
  DLINK_HTTP: 'dlink-http',
});

/** `default`: the cloud password; `sha256`: admin + its uppercase SHA-256 (recent firmwares). */
export const TAPO_AUTH_VARIANTS = Object.freeze(['default', 'sha256']);

export const DEFAULT_RTSP_PORT = 554;
export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_ONVIF_PORT = 80;
export const DEFAULT_MJPEG_PATH = 'video.cgi';
/** The light 640x360 substream: the main stream of these models is not usable. */
export const TAPO_SOURCE_EXTRA = 'channel=0&subtype=1';

const TAPO_WIRED_MODELS = [
  'C100',
  'C110',
  'C120',
  'C200',
  'C210',
  'C225',
  'C310',
  'C320WS',
  'C325WB',
  'C500',
  'C520WS',
];
const TAPO_BATTERY_MODELS = ['C400', 'C420', 'C425', 'C460', 'C610', 'C645D', 'C660', 'D230'];

/** Added to the note of every model running on a battery (forum feedback #37, #76). */
export const BATTERY_WARNING = Object.freeze({
  en: 'Battery camera: keep it PERMANENTLY POWERED (mains, USB or a sufficient solar panel) — Frigate pulls its stream continuously and would drain the battery in hours. Tip: a scene condition on the battery level (> 50 %) before relying on it.',
  fr: 'Caméra sur batterie : gardez-la ALIMENTÉE EN PERMANENCE (secteur, USB ou panneau solaire suffisant) — Frigate lit son flux en continu et viderait la batterie en quelques heures. Astuce : une condition de scène sur le niveau de batterie (> 50 %) avant de compter dessus.',
});

/** The 2-3 simultaneous connections of some cameras. */
const CONNECTIONS_LIMIT = {
  en: 'The camera only accepts 2-3 simultaneous connections: Frigate opens one per stream (main and secondary) — if the vendor app or its cloud use it continuously, type - in the secondary path to open a single connection.',
  fr: "La caméra n'accepte que 2-3 connexions simultanées : Frigate en ouvre une par flux (principal et secondaire) — si l'app du fabricant ou son cloud l'utilisent en continu, saisissez - dans le chemin secondaire pour n'ouvrir qu'une connexion.",
};

const join = (...parts) => ({
  en: parts.map((part) => part.en).join(' '),
  fr: parts.map((part) => part.fr).join(' '),
});

const DLINK_LOCAL_ACCESS = {
  en: '1) Enable local access in the mydlink app: camera settings → "Local Access" (or ONVIF) — on some models, opening http://CAMERA-IP once in a browser is enough. 2) IMPORTANT: then restart the camera (unplug it for a few seconds) — without this restart, the video stream does not start. 3) Credentials: user admin, password = the camera PIN code (printed on the base or the setup card, and in the mydlink app → device info); if the full PIN is rejected, try its last 6 digits. Do not connect another ONVIF software (NAS…) to this camera: D-Link may then kick it out of its cloud.',
  fr: "1) Activez l'accès local dans l'app mydlink : réglages de la caméra → « Accès local » (ou ONVIF) — sur certains modèles, il suffit d'ouvrir une fois http://IP-de-la-caméra dans un navigateur. 2) IMPORTANT : redémarrez ensuite la caméra (débranchez-la quelques secondes) — sans ce redémarrage, le flux vidéo ne démarre pas. 3) Identifiants : utilisateur admin, mot de passe = code PIN de la caméra (imprimé sur le socle ou la carte d'installation, et dans l'app mydlink → infos de l'appareil) ; si le PIN complet est refusé, essayez ses 6 derniers chiffres. Ne connectez pas d'autre logiciel ONVIF (NAS…) à cette caméra : D-Link peut alors l'éjecter de son cloud.",
};

/**
 * @typedef {object} CatalogPreset
 * @property {string} sourceType one of SOURCE_TYPES
 * @property {string} [path] main stream path
 * @property {string} [subPath] secondary (detection) stream path
 * @property {string} [sourceFilter] go2rtc modifiers appended to the RTSP URL
 * @property {number} [rtspPort]
 * @property {number} [httpPort]
 * @property {number} [onvifPort] the ONVIF port used for PTZ (control credentials)
 * @property {string} [ptzProtocol] one of CONTROL_PROTOCOLS
 * @property {string} [nightModeProtocol] one of CONTROL_PROTOCOLS
 * @property {string} [extra] query of the tapo:// source
 */

/**
 * @typedef {object} CatalogEntry
 * @property {string} id stable forever
 * @property {string} brand
 * @property {string[]} models
 * @property {{ en: string, fr: string }} label
 * @property {{ en: string, fr: string }} note
 * @property {string[]} allowedSourceTypes
 * @property {CatalogPreset} preset
 * @property {boolean} [battery] runs on a battery: the battery warning applies
 * @property {boolean} [needsHost] false: no address to type (custom source)
 */

/** @type {ReadonlyArray<CatalogEntry>} */
export const CATALOG = Object.freeze([
  {
    id: 'tapo-wired',
    brand: 'TP-Link Tapo',
    models: TAPO_WIRED_MODELS,
    label: {
      en: 'TP-Link Tapo — wired (C100…C520WS)',
      fr: 'TP-Link Tapo — filaire (C100…C520WS)',
    },
    note: join(
      {
        en: 'Create a "camera account" in the Tapo app (camera settings → Advanced settings → Camera account) and enter those credentials, NOT your TP-Link cloud account. Streams stream1 (recording) and stream2 (detection).',
        fr: "Créez un « compte caméra » dans l'app Tapo (réglages de la caméra → Paramètres avancés → Compte de la caméra) et saisissez ces identifiants, PAS votre compte cloud TP-Link. Flux stream1 (enregistrement) et stream2 (détection).",
      },
      CONNECTIONS_LIMIT,
    ),
    allowedSourceTypes: [SOURCE_TYPES.RTSP, SOURCE_TYPES.ONVIF, SOURCE_TYPES.CUSTOM],
    preset: {
      sourceType: SOURCE_TYPES.RTSP,
      path: 'stream1',
      subPath: 'stream2',
      rtspPort: DEFAULT_RTSP_PORT,
      onvifPort: 2020,
    },
  },
  {
    id: 'tapo-battery',
    brand: 'TP-Link Tapo',
    models: TAPO_BATTERY_MODELS,
    label: {
      en: 'TP-Link Tapo — battery/solar (C400…D230)',
      fr: 'TP-Link Tapo — batterie/solaire (C400…D230)',
    },
    note: {
      en: 'Battery/solar model without RTSP: enter the password of your TP-Link cloud account (no user needed). The light 640×360 stream is used (the main stream is not usable on these models). If the Frigate logs show "401 Unauthorized" for this camera, edit it with the Tapo authentication variant "SHA256": some recent firmwares require it.',
      fr: "Modèle batterie/solaire sans RTSP : saisissez le mot de passe de votre compte cloud TP-Link (pas d'utilisateur). Le flux léger 640×360 est utilisé (le flux principal n'est pas exploitable sur ces modèles). Si les logs Frigate montrent « 401 Unauthorized » sur cette caméra, modifiez-la avec la variante d'authentification Tapo « SHA256 » : certains firmwares récents l'exigent.",
    },
    allowedSourceTypes: [SOURCE_TYPES.TAPO, SOURCE_TYPES.CUSTOM],
    preset: { sourceType: SOURCE_TYPES.TAPO, extra: TAPO_SOURCE_EXTRA },
    battery: true,
  },
  {
    id: 'reolink-rtsp',
    brand: 'Reolink',
    models: ['RLC', 'E1', 'Duo'],
    label: {
      en: 'Reolink — RLC / E1 / Duo (RTSP)',
      fr: 'Reolink — RLC / E1 / Duo (RTSP)',
    },
    note: {
      en: 'Use your Reolink camera credentials (enable RTSP and ONVIF in the Reolink app or web UI if they are off). Most models expose the h264Preview_01_main (recording) and h264Preview_01_sub (detection) paths.',
      fr: "Utilisez les identifiants de votre caméra Reolink (activez RTSP et ONVIF dans l'app ou l'interface web Reolink s'ils sont désactivés). La plupart des modèles exposent les chemins h264Preview_01_main (enregistrement) et h264Preview_01_sub (détection).",
    },
    allowedSourceTypes: [SOURCE_TYPES.RTSP, SOURCE_TYPES.ONVIF, SOURCE_TYPES.CUSTOM],
    preset: {
      sourceType: SOURCE_TYPES.RTSP,
      path: 'h264Preview_01_main',
      subPath: 'h264Preview_01_sub',
      rtspPort: DEFAULT_RTSP_PORT,
      onvifPort: 8000,
    },
  },
  {
    id: 'reolink-hub',
    brand: 'Reolink',
    models: ['Argus', 'Home Hub'],
    label: {
      en: 'Reolink — Argus / battery (Home Hub)',
      fr: 'Reolink — Argus / batterie (Home Hub)',
    },
    note: {
      en: 'Battery camera: no standalone local stream (manufacturer limitation), it only works paired with a Reolink Home Hub. Enter the IP address of the Home Hub (not the camera) and its credentials. Streams are prefilled for channel 1 (Preview_01_main / Preview_01_sub): for the 2nd camera of the hub, set the paths Preview_02_main / Preview_02_sub, and so on.',
      fr: "Caméra sur batterie : aucun flux local en autonome (limitation du fabricant), elle fonctionne uniquement associée à un Reolink Home Hub. Renseignez l'adresse IP du Home Hub (pas celle de la caméra) et ses identifiants. Flux préremplis pour le canal 1 (Preview_01_main / Preview_01_sub) : pour la 2e caméra du hub, indiquez les chemins Preview_02_main / Preview_02_sub, etc.",
    },
    allowedSourceTypes: [SOURCE_TYPES.RTSP, SOURCE_TYPES.CUSTOM],
    preset: {
      sourceType: SOURCE_TYPES.RTSP,
      path: 'Preview_01_main',
      subPath: 'Preview_01_sub',
      rtspPort: DEFAULT_RTSP_PORT,
    },
    battery: true,
  },
  {
    id: 'dlink-dcs-5020l',
    brand: 'D-Link',
    models: ['DCS-5020L'],
    label: { en: 'D-Link DCS-5020L (MJPEG)', fr: 'D-Link DCS-5020L (MJPEG)' },
    note: {
      en: 'This firmware has no RTSP: Gladys uses the local MJPEG stream (light re-encoding to H264). For the stream, a user account of the camera is enough. For pan/tilt (5° steps) and the night mode (IR) switch, the camera ADMIN account is needed: enter it as the control user and password. No motorized zoom.',
      fr: "Ce firmware n'a pas de RTSP : Gladys utilise le flux MJPEG local (léger réencodage en H264). Pour le flux, un compte utilisateur de la caméra suffit. Pour le pan/tilt (pas de 5°) et l'interrupteur de mode nuit (IR), le compte ADMIN de la caméra est nécessaire : saisissez-le comme utilisateur et mot de passe de contrôle. Pas de zoom motorisé.",
    },
    allowedSourceTypes: [SOURCE_TYPES.MJPEG, SOURCE_TYPES.CUSTOM],
    preset: {
      sourceType: SOURCE_TYPES.MJPEG,
      path: DEFAULT_MJPEG_PATH,
      httpPort: DEFAULT_HTTP_PORT,
      ptzProtocol: CONTROL_PROTOCOLS.DLINK_HTTP,
      nightModeProtocol: CONTROL_PROTOCOLS.DLINK_HTTP,
    },
  },
  {
    // No ONVIF on this model (checked on real hardware): RTSP only.
    id: 'dlink-dcs-8302lh',
    brand: 'D-Link',
    models: ['DCS-8302LH'],
    label: { en: 'D-Link DCS-8302LH (mydlink)', fr: 'D-Link DCS-8302LH (mydlink)' },
    note: join(DLINK_LOCAL_ACCESS, CONNECTIONS_LIMIT),
    allowedSourceTypes: [SOURCE_TYPES.RTSP, SOURCE_TYPES.CUSTOM],
    preset: {
      sourceType: SOURCE_TYPES.RTSP,
      path: 'live/profile.0',
      subPath: 'live/profile.1',
      // AAC + Opus audio: keep AAC only, so that the mp4 recordings stay valid.
      sourceFilter: '#video=copy#audio=aac',
      rtspPort: DEFAULT_RTSP_PORT,
    },
  },
  {
    // ONVIF discovery is a trap on this model (it locks onto the H265 main
    // profile and burns extra RTSP sessions): plain RTSP with the preset
    // path, ONVIF for PTZ only through the control credentials.
    id: 'dlink-dcs-8635lh',
    brand: 'D-Link',
    models: ['DCS-8635LH'],
    label: { en: 'D-Link DCS-8635LH (mydlink)', fr: 'D-Link DCS-8635LH (mydlink)' },
    note: join(DLINK_LOCAL_ACCESS, {
      en: 'A single stream is used, the 1080p H264 live/profile.1: the 2K stream is H265, which browsers cannot play live, and one connection keeps the camera under its limit of 2-3 simultaneous connections. PTZ: Gladys only uses ONVIF for it (port 80), which is safe.',
      fr: "Un seul flux est utilisé, le 1080p H264 live/profile.1 : le flux 2K est en H265, que les navigateurs ne peuvent pas lire en direct, et une seule connexion garde la caméra sous sa limite de 2-3 connexions simultanées. PTZ : Gladys n'utilise l'ONVIF que pour cela (port 80), sans risque.",
    }),
    allowedSourceTypes: [SOURCE_TYPES.RTSP, SOURCE_TYPES.CUSTOM],
    preset: {
      sourceType: SOURCE_TYPES.RTSP,
      path: 'live/profile.1',
      sourceFilter: '#video=copy#audio=aac',
      rtspPort: DEFAULT_RTSP_PORT,
      onvifPort: 80,
    },
  },
  {
    id: 'generic-rtsp',
    brand: 'RTSP',
    models: [],
    label: { en: 'RTSP camera (generic)', fr: 'Caméra RTSP (générique)' },
    note: {
      en: 'Most cameras expose RTSP: enter the path of the main stream given by the manufacturer (for instance stream1, h264Preview_01_main, live/ch0, cam/realmonitor?channel=1&subtype=0) and, optionally, the path of a lighter stream used for detection. A Tapo, Reolink or D-Link model not listed: try the closest entry of the catalog first. Share what works with the community (forum or GitHub issue) so that the catalog grows.',
      fr: "La plupart des caméras exposent du RTSP : saisissez le chemin du flux principal donné par le fabricant (par exemple stream1, h264Preview_01_main, live/ch0, cam/realmonitor?channel=1&subtype=0) et, si besoin, le chemin d'un flux plus léger utilisé pour la détection. Un modèle Tapo, Reolink ou D-Link non listé : essayez d'abord l'entrée la plus proche du catalogue. Partagez ce qui fonctionne avec la communauté (forum ou issue GitHub) pour enrichir le catalogue.",
    },
    allowedSourceTypes: [SOURCE_TYPES.RTSP, SOURCE_TYPES.ONVIF, SOURCE_TYPES.CUSTOM],
    preset: { sourceType: SOURCE_TYPES.RTSP, rtspPort: DEFAULT_RTSP_PORT },
  },
  {
    id: 'onvif',
    brand: 'ONVIF',
    models: [],
    label: { en: 'ONVIF camera (automatic stream)', fr: 'Caméra ONVIF (flux automatique)' },
    note: {
      en: 'go2rtc asks the camera for its stream over ONVIF: enter its ONVIF port (often 80, 2020 or 8000) and account. The first ONVIF profile is used (often the main stream, sometimes H265): when the stream does not play, prefer the "RTSP camera" entry with an explicit path.',
      fr: "go2rtc demande son flux à la caméra en ONVIF : saisissez son port ONVIF (souvent 80, 2020 ou 8000) et son compte. Le premier profil ONVIF est utilisé (souvent le flux principal, parfois en H265) : si le flux ne se lit pas, préférez l'entrée « Caméra RTSP » avec un chemin explicite.",
    },
    allowedSourceTypes: [SOURCE_TYPES.ONVIF, SOURCE_TYPES.CUSTOM],
    preset: { sourceType: SOURCE_TYPES.ONVIF, onvifPort: DEFAULT_ONVIF_PORT },
  },
  {
    id: 'custom',
    brand: 'go2rtc',
    models: [],
    label: { en: 'Custom go2rtc source', fr: 'Source go2rtc personnalisée' },
    note: {
      en: 'Any source go2rtc understands (rtsp://, rtmp://, http://, ffmpeg:, tapo://, onvif://, homekit://…), typed as is in the "Custom source" field — special characters of a password must then be URL-encoded (@ → %40). An optional secondary source is used for detection. See the go2rtc documentation.',
      fr: "Toute source comprise par go2rtc (rtsp://, rtmp://, http://, ffmpeg:, tapo://, onvif://, homekit://…), saisie telle quelle dans le champ « Source personnalisée » — les caractères spéciaux d'un mot de passe doivent alors être encodés pour une URL (@ → %40). Une source secondaire facultative sert à la détection. Voir la documentation de go2rtc.",
    },
    allowedSourceTypes: [SOURCE_TYPES.CUSTOM],
    preset: { sourceType: SOURCE_TYPES.CUSTOM },
    needsHost: false,
  },
]);

export const DEFAULT_MODEL = 'generic-rtsp';

/** The catalog entry of an id, or null. */
export function catalogEntry(id) {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * The labels Frigate's default model (COCO) detects, as Frigate names them.
 * The CSV of the "Objects to detect" field is checked against them: a typo
 * would otherwise make Frigate refuse the whole configuration.
 */
export const TRACKABLE_LABELS = Object.freeze([
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'couch',
  'potted plant',
  'bed',
  'dining table',
  'toilet',
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
]);

/** The labels worth suggesting for home video surveillance. */
export const COMMON_LABELS = Object.freeze([
  'person',
  'car',
  'dog',
  'cat',
  'horse',
  'bird',
  'bicycle',
  'motorcycle',
  'bus',
  'truck',
]);
