// -----------------------------------------------------------------------------
// Camera management from Gladys (managed mode): the "Cameras" button, whose
// `operation` field picks add / edit / remove / list (Gladys accepts ten
// manifest actions at most: one button, four operations).
//
// The button is a manifest action with a form (`fields`): this module checks
// what the user typed, stores the camera in /data/managed/cameras.json
// (src/frigate/managed/camerasStore.js), then lets the session regenerate
// config.yml and restart Frigate (`apply`). Frigate then shows the camera,
// and the usual discovery lists it in the Discover tab.
//
//   - One form for four operations: the fields an operation does not use
//     are ignored, and no field but `operation` has a manifest default (the
//     core would apply it to an edit too): the add defaults (generic RTSP,
//     person, 5 fps) are applied here.
//   - The Frigate camera name is the slug of the label, computed once at
//     creation: it becomes the Gladys external id of the device, forever.
//     Editing the label only changes the friendly name.
//   - Edit: a blank field keeps its value; `-` in a text field empties it
//     (no secondary stream, no user…); objects and detection fps replace
//     the stored ones when given.
//   - The answers are bilingual, on several lines, with the note of the
//     catalog model and the next steps; never a password (sources are
//     redacted).
//
// Thin adapter: the catalog and the sources are in src/frigate/managed/.
// -----------------------------------------------------------------------------

import { dlinkControlsOf } from '../frigate/dlink.js';
import { CameraSourceError } from '../frigate/errors.js';
import {
  BATTERY_WARNING,
  COMMON_LABELS,
  DEFAULT_MODEL,
  TAPO_AUTH_VARIANTS,
  catalogEntry,
} from '../frigate/managed/catalog.js';
import {
  buildCameraConfig,
  parseObjects,
  redactSource,
  resolveCamera,
  slugify,
} from '../frigate/managed/cameraSources.js';
import {
  DEFAULT_DETECT_FPS,
  MAX_DETECT_FPS,
  SUB_STREAM_SUFFIX,
} from '../frigate/managed/constants.js';

/** The values of the `operation` select of the "Cameras" button. */
export const CAMERA_OPERATIONS = Object.freeze(['add', 'edit', 'remove', 'list']);

/** Names Frigate keeps for itself (go2rtc restream of the birdseye view). */
const RESERVED_NAMES = ['birdseye'];
const MAX_LABEL_LENGTH = 64;

export const CAMERA_TEXT = Object.freeze({
  ONLY_MANAGED: {
    en: 'Cameras are added from Gladys in managed mode only ("Frigate installed by Gladys" in the Deployment section). With an existing Frigate, add them in its UI, then press "Refresh the cameras".',
    fr: "Les caméras ne s'ajoutent depuis Gladys qu'en mode géré (« Frigate installé par Gladys » dans la section Déploiement). Avec un Frigate existant, ajoutez-les dans son interface, puis cliquez sur « Rafraîchir les caméras ».",
  },
  UNKNOWN_OPERATION: {
    en: 'Unknown operation: choose Add, Edit, Remove or List.',
    fr: 'Opération inconnue : choisissez Ajouter, Modifier, Supprimer ou Lister.',
  },
  NO_FORM: {
    en: 'This Gladys version does not send the form of this button: update Gladys.',
    fr: "Cette version de Gladys n'envoie pas le formulaire de ce bouton : mettez Gladys à jour.",
  },
  LABEL_REQUIRED: {
    en: 'Enter the name of the camera.',
    fr: 'Saisissez le nom de la caméra.',
  },
  LABEL_UNUSABLE: {
    en: 'The name of the camera needs at least one letter or digit (a-z, 0-9).',
    fr: 'Le nom de la caméra doit contenir au moins une lettre ou un chiffre (a-z, 0-9).',
  },
  LABEL_TOO_LONG: {
    en: `The name of the camera is limited to ${MAX_LABEL_LENGTH} characters.`,
    fr: `Le nom de la caméra est limité à ${MAX_LABEL_LENGTH} caractères.`,
  },
  UNKNOWN_MODEL: {
    en: 'Unknown camera model: choose one in the list.',
    fr: 'Modèle de caméra inconnu : choisissez-en un dans la liste.',
  },
  BAD_HOST: {
    en: 'The camera address must be its IP address or host name only, for instance 192.168.1.20 (no rtsp://, port, path nor credentials).',
    fr: "L'adresse de la caméra doit être son adresse IP ou son nom d'hôte seuls, par exemple 192.168.1.20 (sans rtsp://, port, chemin ni identifiants).",
  },
  missing_host: {
    en: 'Enter the IP address of the camera (or of the Home Hub).',
    fr: "Saisissez l'adresse IP de la caméra (ou du Home Hub).",
  },
  missing_password: {
    en: 'Enter the password of your TP-Link cloud account (battery/solar Tapo models).',
    fr: 'Saisissez le mot de passe de votre compte cloud TP-Link (modèles Tapo batterie/solaire).',
  },
  missing_custom_source: {
    en: 'Enter the go2rtc source in the "Custom source" field.',
    fr: 'Saisissez la source go2rtc dans le champ « Source personnalisée ».',
  },
  unknown_model: {
    en: 'Unknown camera model: choose one in the list.',
    fr: 'Modèle de caméra inconnu : choisissez-en un dans la liste.',
  },
  PASSWORD_WITHOUT_USER: {
    en: 'A password was entered without a user: fill in the user too.',
    fr: "Un mot de passe est saisi sans utilisateur : renseignez aussi l'utilisateur.",
  },
  BAD_SOURCE: {
    en: 'A custom source fits on one line.',
    fr: 'Une source personnalisée tient sur une ligne.',
  },
  BAD_VARIANT: {
    en: 'Unknown Tapo authentication variant.',
    fr: "Variante d'authentification Tapo inconnue.",
  },
  NO_OBJECT: {
    en: 'Enter at least one object to detect, for instance person.',
    fr: 'Saisissez au moins un objet à détecter, par exemple person.',
  },
  TARGET_REQUIRED: {
    en: 'Choose the camera, or type its Frigate name.',
    fr: 'Choisissez la caméra, ou saisissez son nom Frigate.',
  },
});

const portText = (label) => ({
  en: `The ${label.en} must be a whole number between 1 and 65535.`,
  fr: `Le ${label.fr} doit être un nombre entier entre 1 et 65535.`,
});

/** Thrown inside this module, turned into the answer of the button. */
class Refusal extends Error {
  constructor(message) {
    super(message.en);
    this.answer = message;
  }
}

const refuse = (message) => {
  throw new Refusal(message);
};

/** Bilingual lines -> one bilingual text, one line each. */
function lines(parts) {
  const kept = parts.filter(Boolean);
  return {
    en: kept.map((part) => part.en).join('\n'),
    fr: kept.map((part) => part.fr).join('\n'),
  };
}

/** A text field: undefined when blank, '' for `-` (empty it), else trimmed. */
function textField(fields, key, { clearable = true } = {}) {
  const value = fields[key];
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === '') return undefined;
  if (clearable && trimmed === '-') return '';
  return trimmed;
}

/** A secret: undefined when blank, kept exactly as typed otherwise. */
function secretField(fields, key) {
  const value = fields[key];
  return value == null || value === '' ? undefined : String(value);
}

/** A number field: undefined when blank, else an integer within bounds. */
function integerField(fields, key, min, max, message) {
  const value = fields[key];
  if (value == null || String(value).trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) refuse(message);
  return n;
}

const isBareHost = (host) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host) || /^\[[0-9A-Fa-f:.]+\]$/.test(host);

/**
 * The stream settings of the form, shared by add and edit: only the fields
 * the user filled.
 */
function streamFields(fields) {
  const record = {};
  const host = textField(fields, 'host', { clearable: false });
  if (host !== undefined) {
    if (!isBareHost(host)) refuse(CAMERA_TEXT.BAD_HOST);
    record.host = host;
  }
  for (const [key, field] of [
    ['username', 'username'],
    ['path', 'path'],
    ['subPath', 'sub_path'],
    ['onvifUsername', 'onvif_username'],
    ['customSubSource', 'custom_sub_source'],
  ]) {
    const value = textField(fields, field);
    if (value !== undefined) record[key] = value;
  }
  // `-` empties it: back to the stream of the model (check() refuses an
  // empty one for the custom model).
  const customSource = textField(fields, 'custom_source');
  if (customSource !== undefined) record.customSource = customSource;
  if (/[\r\n]/.test(`${record.customSource ?? ''}${record.customSubSource ?? ''}`)) {
    refuse(CAMERA_TEXT.BAD_SOURCE);
  }
  for (const [key, field] of [
    ['password', 'password'],
    ['onvifPassword', 'onvif_password'],
  ]) {
    const value = secretField(fields, field);
    if (value !== undefined) record[key] = value;
  }
  const port = integerField(
    fields,
    'port',
    1,
    65535,
    portText({ en: 'stream port', fr: 'port du flux' }),
  );
  if (port !== undefined) record.port = port;
  const onvifPort = integerField(
    fields,
    'onvif_port',
    1,
    65535,
    portText({ en: 'ONVIF port', fr: 'port ONVIF' }),
  );
  if (onvifPort !== undefined) record.onvifPort = onvifPort;
  const variant = textField(fields, 'tapo_auth_variant', { clearable: false });
  if (variant !== undefined) {
    if (!TAPO_AUTH_VARIANTS.includes(variant)) refuse(CAMERA_TEXT.BAD_VARIANT);
    record.tapoAuthVariant = variant;
  }
  return record;
}

/** The objects and detection fps of the form, when given. */
function detectionFields(fields) {
  const result = {};
  const csv = textField(fields, 'objects', { clearable: false });
  if (csv !== undefined) {
    const { objects, unknown } = parseObjects(csv);
    if (unknown.length > 0) {
      refuse({
        en: `Frigate does not detect: ${unknown.join(', ')}. Common objects: ${COMMON_LABELS.join(', ')}.`,
        fr: `Frigate ne détecte pas : ${unknown.join(', ')}. Objets courants : ${COMMON_LABELS.join(', ')}.`,
      });
    }
    if (objects.length === 0) refuse(CAMERA_TEXT.NO_OBJECT);
    result.objects = objects;
  }
  const fps = integerField(fields, 'detect_fps', 1, MAX_DETECT_FPS, {
    en: `The detection fps must be a whole number between 1 and ${MAX_DETECT_FPS} (5 is recommended).`,
    fr: `Les images par seconde de détection doivent être un nombre entier entre 1 et ${MAX_DETECT_FPS} (5 recommandé).`,
  });
  if (fps !== undefined) result.detectFps = fps;
  return result;
}

function labelField(fields, { required }) {
  const label = textField(fields, 'label', { clearable: false });
  if (label === undefined) {
    if (required) refuse(CAMERA_TEXT.LABEL_REQUIRED);
    return undefined;
  }
  if (label.length > MAX_LABEL_LENGTH) refuse(CAMERA_TEXT.LABEL_TOO_LONG);
  return label;
}

function modelField(fields, fallback) {
  const model = textField(fields, 'model', { clearable: false }) ?? fallback;
  if (model === undefined) return undefined;
  if (!catalogEntry(model)) refuse(CAMERA_TEXT.UNKNOWN_MODEL);
  return model;
}

/**
 * Build the camera once, as config.yml will get it: refuses what would not
 * make a working go2rtc source.
 */
function check(name, record) {
  let camera;
  let built;
  try {
    camera = resolveCamera(name, record);
    built = buildCameraConfig(camera);
  } catch (err) {
    if (err instanceof CameraSourceError)
      refuse(CAMERA_TEXT[err.code] ?? CAMERA_TEXT.UNKNOWN_MODEL);
    throw err;
  }
  const streamUser = ['rtsp', 'mjpeg'].includes(camera.sourceType) && camera.password;
  if (streamUser && !camera.username) refuse(CAMERA_TEXT.PASSWORD_WITHOUT_USER);
  if (camera.sourceType === 'onvif' && camera.onvifPassword && !camera.onvifUsername) {
    refuse(CAMERA_TEXT.PASSWORD_WITHOUT_USER);
  }
  return { camera, built };
}

/** "rtsp://***@host/stream1 (recording) + …/stream2 (detection)". */
function describeStreams(built) {
  const main = redactSource(built.main);
  if (!built.sub) {
    return { en: `Stream: ${main}.`, fr: `Flux : ${main}.` };
  }
  const sub = redactSource(built.sub);
  return {
    en: `Streams: ${main} (recording) + ${sub} (detection).`,
    fr: `Flux : ${main} (enregistrement) + ${sub} (détection).`,
  };
}

function describeDetection(camera) {
  return {
    en: `Objects: ${camera.objects.join(', ')} — detection at ${camera.detectFps} fps.`,
    fr: `Objets : ${camera.objects.join(', ')} — détection à ${camera.detectFps} images/s.`,
  };
}

const quoted = (camera) => `"${camera.label}" (${camera.name})`;

/** What happens next, from the state of the Frigate container. */
function nextSteps(result, { removal = false } = {}) {
  const discover = removal
    ? { en: '', fr: '' }
    : {
        en: ' Then: Discover tab → Scan → Add to Gladys. Draw zones and masks in the Frigate UI: they are kept.',
        fr: " Ensuite : onglet Découverte → Scanner → Ajouter à Gladys. Dessinez zones et masques dans l'interface Frigate : ils sont conservés.",
      };
  if (result.restarted) {
    return {
      en: `Frigate restarts to apply it (about 30 s; the connection status follows).${discover.en}`,
      fr: `Frigate redémarre pour l'appliquer (environ 30 s ; le statut de connexion suit).${discover.fr}`,
    };
  }
  if (result.state === 'running') {
    return {
      en: `The Frigate configuration already had it: nothing to restart.${discover.en}`,
      fr: `La configuration de Frigate l'avait déjà : rien à redémarrer.${discover.fr}`,
    };
  }
  if (result.state === 'waiting') {
    return {
      en: `Frigate is being started by Gladys: it reads its configuration when it comes up.${discover.en}`,
      fr: `Frigate est en cours de démarrage par Gladys : il lit sa configuration en démarrant.${discover.fr}`,
    };
  }
  return {
    en: `Frigate is stopped: the change applies at its next start ("Start Frigate").${discover.en}`,
    fr: `Frigate est arrêté : la modification s'appliquera à son prochain démarrage (« Démarrer Frigate »).${discover.fr}`,
  };
}

function modelNote(camera) {
  const { entry } = camera;
  return [
    {
      en: `Model ${entry.label.en}: ${entry.note.en}`,
      fr: `Modèle ${entry.label.fr} : ${entry.note.fr}`,
    },
    entry.battery ? { en: `⚠ ${BATTERY_WARNING.en}`, fr: `⚠ ${BATTERY_WARNING.fr}` } : null,
  ];
}

/**
 * For a model driven by D-Link HTTP (pan/tilt, night mode): which account
 * the commands use, and a warning when none is set — the control account
 * falls back to the stream one, often a plain user the camera refuses.
 * Never a credential.
 * @param {ReturnType<typeof resolveCamera>} camera
 * @param {object} record what the user typed
 */
function controlNote(camera, record) {
  if (!dlinkControlsOf(camera)) return null;
  if (!camera.onvifUsername || !camera.onvifPassword) {
    return {
      en: '⚠ No control account: pan/tilt and the night mode (IR) switch will be refused. Edit the camera and enter its ADMIN account as "Control user" and "Control password".',
      fr: "⚠ Aucun compte de contrôle : le pan/tilt et l'interrupteur de mode nuit (IR) seront refusés. Modifiez la caméra et saisissez son compte ADMIN comme « Utilisateur de contrôle » et « Mot de passe de contrôle ».",
    };
  }
  if (record.onvifUsername === undefined) {
    return {
      en: 'Pan/tilt and the night mode (IR) switch use the control account, here the stream account: if it is not the camera ADMIN account, the camera refuses them — then edit the camera with its admin account as "Control user" and "Control password".',
      fr: "Le pan/tilt et l'interrupteur de mode nuit (IR) utilisent le compte de contrôle, ici celui du flux : si ce n'est pas le compte ADMIN de la caméra, elle les refuse — modifiez alors la caméra avec son compte admin comme « Utilisateur de contrôle » et « Mot de passe de contrôle ».",
    };
  }
  return {
    en: 'Pan/tilt and the night mode (IR) switch use the control account entered (the camera ADMIN account).',
    fr: "Le pan/tilt et l'interrupteur de mode nuit (IR) utilisent le compte de contrôle saisi (le compte ADMIN de la caméra).",
  };
}

/** The default resolver: the Frigate name ends the device external id ("…:camera:<name>"). */
const nameFromExternalId = (externalId) =>
  /(?:^|:)camera:([^:]+)$/.exec(String(externalId ?? ''))?.[1] ?? null;

/**
 * @param {object} options
 * @param {ReturnType<import('./managed.js').createManagedFrigate>} options.managed
 * @param {() => Promise<{ changed: boolean, restarted: boolean, state: string }>} options.apply
 *   regenerate config.yml and restart Frigate if needed (the session)
 * @param {(externalId: string) => string | null} [options.cameraOfDevice] the Frigate
 *   camera name of a Gladys device external id (the `source: devices` selects)
 * @param {{ info: Function, warn: Function }} options.logger
 */
export function createCameraActions({
  managed,
  apply,
  cameraOfDevice = nameFromExternalId,
  logger,
}) {
  // One change at a time: two presses of the button must not interleave
  // their store writes and Frigate restarts.
  let queue = Promise.resolve();
  const serialized = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const store = managed.cameras;

  /** Run an operation: a Refusal becomes its answer, anything else is thrown. */
  async function answer(fields, task) {
    try {
      return await serialized(() => task(fields));
    } catch (err) {
      if (err instanceof Refusal) return err.answer;
      throw err;
    }
  }

  /** The managed camera a form designates (device select, else typed name). */
  async function target(fields) {
    const externalId = textField(fields, 'camera', { clearable: false });
    const typed = textField(fields, 'name', { clearable: false });
    const name =
      (externalId ? cameraOfDevice(externalId) : null) ??
      (typed ? ((await store.get(typed)) ? typed : slugify(typed)) : null);
    if (!name) refuse(CAMERA_TEXT.TARGET_REQUIRED);
    const record = await store.get(name);
    if (!record) {
      const inFile = (await managed.namesInFile().catch(() => null))?.cameras ?? [];
      refuse(
        inFile.includes(name)
          ? {
              en: `The camera ${name} was added in the Frigate UI, not from Gladys: change it there.`,
              fr: `La caméra ${name} a été ajoutée dans l'interface Frigate, pas depuis Gladys : modifiez-la là-bas.`,
            }
          : {
              en: `No camera ${name} was added from Gladys (the operation "List the cameras" gives their names).`,
              fr: `Aucune caméra ${name} n'a été ajoutée depuis Gladys (l'opération « Lister les caméras » donne leurs noms).`,
            },
      );
    }
    return { name, record };
  }

  /** A new name must not take a camera or a go2rtc stream of config.yml. */
  async function checkFree(name) {
    if (await store.get(name)) {
      refuse({
        en: `A camera named ${name} already exists: use the operation "Edit a camera", or choose another name.`,
        fr: `Une caméra nommée ${name} existe déjà : utilisez l'opération « Modifier une caméra », ou choisissez un autre nom.`,
      });
    }
    const managedNames = Object.keys(await store.cameras());
    const taken = new Set([
      ...RESERVED_NAMES,
      ...managedNames.map((other) => `${other}${SUB_STREAM_SUFFIX}`),
    ]);
    const inFile = await managed.namesInFile();
    if (inFile === null) {
      refuse({
        en: 'The Frigate config.yml is not valid YAML: fix it in the Frigate UI first.',
        fr: "Le config.yml de Frigate n'est pas du YAML valide : corrigez-le d'abord dans l'interface Frigate.",
      });
    }
    for (const used of [...inFile.cameras, ...inFile.streams]) taken.add(used);
    if (taken.has(name) || taken.has(`${name}${SUB_STREAM_SUFFIX}`)) {
      refuse({
        en: `The name ${name} is already used in the Frigate configuration (a camera or a go2rtc stream added in the Frigate UI): choose another name.`,
        fr: `Le nom ${name} est déjà utilisé dans la configuration de Frigate (une caméra ou un flux go2rtc ajoutés dans l'interface Frigate) : choisissez un autre nom.`,
      });
    }
  }

  const operations = {
    /** "Add a camera". */
    add: async (fields) => {
      const label = labelField(fields, { required: true });
      const name = slugify(label);
      if (!name) refuse(CAMERA_TEXT.LABEL_UNUSABLE);
      const model = modelField(fields, DEFAULT_MODEL);
      const record = {
        label,
        model,
        ...streamFields(fields),
        objects: ['person'],
        detectFps: DEFAULT_DETECT_FPS,
        ...detectionFields(fields),
      };
      const { camera, built } = check(name, record);
      await checkFree(name);
      await store.put(name, { ...record, created_at: new Date().toISOString() });
      logger.info(`Managed camera ${name} added (${model})`);
      const result = await apply();
      return lines([
        {
          en: `Camera ${quoted(camera)} added to Frigate.`,
          fr: `Caméra ${quoted(camera)} ajoutée à Frigate.`,
        },
        describeStreams(built),
        describeDetection(camera),
        ...modelNote(camera),
        controlNote(camera, record),
        nextSteps(result),
      ]);
    },

    /** "Edit a camera": blank fields keep their value. */
    edit: async (fields) => {
      const { name, record: current } = await target(fields);
      const label = labelField(fields, { required: false });
      const model = modelField(fields, undefined);
      const record = {
        ...current,
        ...(label !== undefined ? { label } : {}),
        ...(model !== undefined ? { model } : {}),
        ...streamFields(fields),
        ...detectionFields(fields),
      };
      const { camera, built } = check(name, record);
      await store.put(name, { ...record, updated_at: new Date().toISOString() });
      logger.info(`Managed camera ${name} updated (${camera.model})`);
      const result = await apply();
      return lines([
        { en: `Camera ${quoted(camera)} updated.`, fr: `Caméra ${quoted(camera)} modifiée.` },
        describeStreams(built),
        describeDetection(camera),
        ...modelNote(camera),
        controlNote(camera, record),
        nextSteps(result),
      ]);
    },

    /** "Remove a camera": from the store and from config.yml. */
    remove: async (fields) => {
      const { name, record } = await target(fields);
      await store.remove(name);
      logger.info(`Managed camera ${name} removed`);
      const result = await apply();
      const label = record.label || name;
      return lines([
        {
          en: `Camera "${label}" (${name}) removed from Frigate.`,
          fr: `Caméra « ${label} » (${name}) retirée de Frigate.`,
        },
        {
          en: 'Its recordings already made stay in the Frigate media folder until you delete them. The Gladys device stays too: delete it from its page in Gladys if you no longer need it.',
          fr: "Ses enregistrements déjà faits restent dans le dossier média de Frigate jusqu'à ce que vous les supprimiez. L'appareil Gladys reste aussi : supprimez-le depuis sa page dans Gladys si vous n'en avez plus besoin.",
        },
        nextSteps(result, { removal: true }),
      ]);
    },

    /** "List the cameras": the managed ones, then those of the Frigate UI (several lines). */
    list: async () => {
      const records = await store.cameras();
      const names = Object.keys(records).sort();
      const parts = [];
      if (names.length === 0) {
        parts.push({
          en: 'No camera added from Gladys yet: use the operation "Add a camera".',
          fr: "Aucune caméra ajoutée depuis Gladys pour l'instant : utilisez l'opération « Ajouter une caméra ».",
        });
      } else {
        parts.push({
          en: `Cameras added from Gladys (${names.length}):`,
          fr: `Caméras ajoutées depuis Gladys (${names.length}) :`,
        });
        for (const name of names) {
          let camera;
          try {
            camera = resolveCamera(name, records[name]);
          } catch {
            parts.push({ en: `- ${name}: unknown model`, fr: `- ${name} : modèle inconnu` });
            continue;
          }
          const where = camera.host || redactSource(camera.customSource);
          parts.push({
            en: `- ${quoted(camera)} — ${camera.entry.label.en}, ${where}, objects: ${camera.objects.join(', ')}, ${camera.detectFps} fps`,
            fr: `- ${quoted(camera)} — ${camera.entry.label.fr}, ${where}, objets : ${camera.objects.join(', ')}, ${camera.detectFps} images/s`,
          });
        }
      }
      const inFile = await managed.namesInFile().catch(() => null);
      const others = (inFile?.cameras ?? []).filter((name) => !(name in records)).sort();
      if (others.length > 0) {
        parts.push({
          en: `Cameras added in the Frigate UI (left as they are): ${others.join(', ')}.`,
          fr: `Caméras ajoutées dans l'interface Frigate (laissées telles quelles) : ${others.join(', ')}.`,
        });
      }
      return lines(parts);
    },
  };

  return {
    /** The "Cameras" button: dispatch on `operation` (list when absent). */
    run(fields) {
      if (fields == null || typeof fields !== 'object') return CAMERA_TEXT.NO_FORM;
      const operation = textField(fields, 'operation', { clearable: false }) ?? 'list';
      if (!CAMERA_OPERATIONS.includes(operation)) return CAMERA_TEXT.UNKNOWN_OPERATION;
      return answer(fields, operations[operation]);
    },

    /** The number of cameras added from Gladys (null when the store is unreadable). */
    async count() {
      try {
        return Object.keys(await store.cameras()).length;
      } catch {
        return null;
      }
    },
  };
}
