// -----------------------------------------------------------------------------
// Managed mode: Frigate run by Gladys as the `frigate` sub-container of the
// manifest (`start: manual`).
//
//   - The state of the sub-container (status, desired state, published ports,
//     hardware grants) comes from Gladys: `gladys.getContainers()`.
//   - Before every start or restart, config.yml is generated under
//     /data/containers/frigate/config (src/frigate/managed/configFile.js),
//     with the detector the granted hardware allows
//     (src/frigate/managed/detector.js).
//   - The runtime environment of the sub-container carries the broker
//     password (never config.yml, never the manifest). The supervisor
//     recreates the container when that environment changes, which only
//     `startContainer` can pass: a restart with a new environment goes
//     through it.
//   - The admin password Gladys sets on Frigate lives in
//     /data/managed/state.json (0600), for the "Show the Frigate
//     credentials" button only.
//
// The connection lifecycle (status, polling while Frigate starts) is in
// ./frigateSession.js; this module holds the Gladys calls, the files and the
// user-facing texts of the managed mode.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { explicitRetention, usesMqtt } from '../config.js';
import { AdminBootstrapError, ManagedConfigError } from '../frigate/errors.js';
import { generatePassword, setAdminPassword } from '../frigate/managed/adminAccount.js';
import { renderConfig, writeConfigFile } from '../frigate/managed/configFile.js';
import {
  ADMIN_USER,
  CONFIG_DIR,
  CONFIG_FILE,
  CONTAINER_NAME,
  INTERNAL_URL,
  MQTT_PASSWORD_ENV,
  RTSP_PORT_NAME,
  UI_PORT_NAME,
} from '../frigate/managed/constants.js';
import { chooseDetector } from '../frigate/managed/detector.js';
import { createStateFile } from '../frigate/managed/stateFile.js';

const CLASS_NAMES = {
  'coral-usb': { en: 'Coral USB', fr: 'Coral USB' },
  'coral-pcie': { en: 'Coral PCIe', fr: 'Coral PCIe' },
  gpu: { en: 'GPU', fr: 'GPU' },
};

const DETECTOR_NAMES = {
  edgetpu_usb: { en: 'Coral USB', fr: 'Coral USB' },
  edgetpu_pci: { en: 'Coral PCIe', fr: 'Coral PCIe' },
  openvino: { en: 'Intel GPU (OpenVINO)', fr: 'GPU Intel (OpenVINO)' },
  cpu: { en: 'CPU', fr: 'CPU' },
};

const CHOICE_NAMES = {
  coral: { en: 'Coral', fr: 'Coral' },
  openvino: { en: 'OpenVINO (Intel GPU)', fr: 'OpenVINO (GPU Intel)' },
};

/** User-facing texts of the managed mode (connection status, buttons). */
export const MANAGED_TEXT = Object.freeze({
  ONLY_MANAGED: {
    en: 'This button only works when "Frigate installed by Gladys (managed)" is chosen in the Deployment section.',
    fr: 'Ce bouton ne fonctionne que si « Frigate installé par Gladys (géré) » est choisi dans la section Déploiement.',
  },
  UNSUPPORTED: {
    en: 'Managed mode: Gladys reports no Frigate sub-container for this integration. It needs a Gladys version that runs sub-containers and the latest version of the integration; otherwise choose "Existing Frigate instance (remote)".',
    fr: "Mode géré : Gladys n'indique aucun sous-conteneur Frigate pour cette intégration. Il faut une version de Gladys qui gère les sous-conteneurs et la dernière version de l'intégration ; sinon, choisissez « Instance Frigate existante (distante) ».",
  },
  NOT_STARTED: {
    en: 'Frigate installed by Gladys is not started yet: press "Start Frigate".',
    fr: "Frigate installé par Gladys n'est pas encore démarré : cliquez sur « Démarrer Frigate ».",
  },
  STOPPED: {
    en: 'Frigate installed by Gladys is stopped: press "Start Frigate" to start it again.',
    fr: 'Frigate installé par Gladys est arrêté : cliquez sur « Démarrer Frigate » pour le relancer.',
  },
  STARTING: {
    en: 'Frigate is starting… (the first start can take a few minutes).',
    fr: 'Frigate démarre… (le premier démarrage peut prendre quelques minutes).',
  },
  WAITING: {
    en: 'The Frigate container is being started (or restarted) by Gladys…',
    fr: 'Le conteneur Frigate est en cours de démarrage (ou de redémarrage) par Gladys…',
  },
  CRASH_LOOP: {
    en: 'Frigate does not stay up: its container keeps stopping. The limits of the Gladys sandbox (100 processes, a 64 MB /tmp, no capabilities) may block it: see "Frigate does not stay up" in the documentation, or use an existing Frigate instance (remote mode).',
    fr: "Frigate ne reste pas démarré : son conteneur s'arrête sans cesse. Les limites du bac à sable de Gladys (100 processus, /tmp de 64 Mo, aucune capability) peuvent le bloquer : voir « Frigate ne reste pas démarré » dans la documentation, ou utilisez une instance Frigate existante (mode distant).",
  },
  ADMIN_PENDING: {
    en: 'The Frigate admin password could not be set yet (tried again at the next connection).',
    fr: "Le mot de passe admin de Frigate n'a pas encore pu être défini (nouvel essai à la prochaine connexion).",
  },
});

/** Frigate's container runs, but its API has not answered for `minutes`. */
export function notAnswering(minutes) {
  return {
    en: `The Frigate container runs, but Frigate has not answered for ${minutes} min. Press "Restart Frigate"; if it persists, see "Frigate does not stay up" in the documentation (sandbox limits).`,
    fr: `Le conteneur Frigate tourne, mais Frigate ne répond pas depuis ${minutes} min. Cliquez sur « Redémarrer Frigate » ; si cela persiste, voir « Frigate ne reste pas démarré » dans la documentation (limites du bac à sable).`,
  };
}

/** A failure of the managed mode as a user-facing text. */
export function describeManagedError(err) {
  if (err instanceof ManagedConfigError) {
    if (err.code === 'write_failed') {
      return {
        en: 'The Frigate configuration cannot be written in /data/containers/frigate/config (permissions of the Gladys data folder?).',
        fr: 'La configuration de Frigate ne peut pas être écrite dans /data/containers/frigate/config (droits du dossier de données de Gladys ?).',
      };
    }
    return {
      en: 'The Frigate config.yml is not valid YAML: fix it in the Frigate UI, or delete containers/frigate/config/config.yml from the data folder of the integration to start afresh.',
      fr: "Le config.yml de Frigate n'est pas du YAML valide : corrigez-le dans l'interface Frigate, ou supprimez containers/frigate/config/config.yml du dossier de données de l'intégration pour repartir de zéro.",
    };
  }
  if (err instanceof AdminBootstrapError) {
    return MANAGED_TEXT.ADMIN_PENDING;
  }
  // An older Gladys without the /container routes, or a manifest without the
  // `frigate` entry.
  if (err?.name === 'GladysApiError' && err.status === 404) {
    return MANAGED_TEXT.UNSUPPORTED;
  }
  if (err?.name === 'GladysApiError' || err?.status != null) {
    return {
      en: `Gladys refused the request on the Frigate container (${err.message}).`,
      fr: `Gladys a refusé la demande sur le conteneur Frigate (${err.message}).`,
    };
  }
  return {
    en: `Managed mode error: ${err?.message ?? err}.`,
    fr: `Erreur du mode géré : ${err?.message ?? err}.`,
  };
}

/** "Detector: Coral USB, video decoding VAAPI." plus the hardware notes. */
export function describeDetector(decision, { customDetectors = false } = {}) {
  if (!decision) {
    return [];
  }
  const name = customDetectors
    ? { en: 'the one of config.yml (kept)', fr: 'celui du config.yml (conservé)' }
    : DETECTOR_NAMES[decision.kind];
  const vaapi = decision.vaapi
    ? { en: ', video decoding VAAPI', fr: ', décodage vidéo VAAPI' }
    : { en: '', fr: '' };
  const parts = [
    { en: `Detector: ${name.en}${vaapi.en}.`, fr: `Détecteur : ${name.fr}${vaapi.fr}.` },
  ];
  for (const note of decision.notes) {
    const hardware = CLASS_NAMES[note.class];
    if (note.code === 'fallback') {
      const choice = CHOICE_NAMES[note.class];
      parts.push({
        en: `The ${choice.en} detector was chosen, but its hardware is not usable: automatic choice applied.`,
        fr: `Le détecteur ${choice.fr} est choisi, mais son matériel n'est pas utilisable : choix automatique appliqué.`,
      });
    } else if (note.code === 'not_granted') {
      parts.push({
        en: `${hardware.en} detected but not granted: allow it in the Hardware block of the integration.`,
        fr: `${hardware.fr} détecté mais non autorisé : autorisez-le dans le bloc Matériel de l'intégration.`,
      });
    } else if (note.code === 'not_detected') {
      parts.push({
        en: `${hardware.en} granted but not detected on this machine.`,
        fr: `${hardware.fr} autorisé mais non détecté sur cette machine.`,
      });
    } else if (note.code === 'cpu_only' && !customDetectors) {
      parts.push({
        en: 'CPU detection only: slow and CPU hungry, a Coral or an Intel GPU is recommended.',
        fr: 'Détection sur CPU uniquement : lente et gourmande, un Coral ou un GPU Intel est recommandé.',
      });
    }
  }
  return parts;
}

/** "2 days continuous, alerts 7 days…" */
export function describeRetention(retention) {
  if (!retention) {
    return null;
  }
  const { continuous, alerts, detections, snapshots } = retention;
  return {
    en: `Retention: continuous ${continuous} d, alerts ${alerts} d, detections ${detections} d, snapshots ${snapshots} d.`,
    fr: `Conservation : continu ${continuous} j, alertes ${alerts} j, détections ${detections} j, captures ${snapshots} j.`,
  };
}

/** Space of the recordings, from Frigate's /api/stats (values in MB). */
export function describeStorage(stats) {
  const storage = stats?.service?.storage ?? {};
  const key =
    storage['/media/frigate/recordings'] !== undefined
      ? '/media/frigate/recordings'
      : Object.keys(storage).find((path) => path.startsWith('/media/frigate'));
  const entry = key ? storage[key] : null;
  if (!entry || !Number.isFinite(entry.used) || !Number.isFinite(entry.total)) {
    return null;
  }
  const gb = (mb) => (mb / 1024).toFixed(1);
  return {
    en: `Recordings: ${gb(entry.used)} GB used of ${gb(entry.total)} GB (${gb(entry.total - entry.used)} GB free).`,
    fr: `Enregistrements : ${gb(entry.used)} Go utilisés sur ${gb(entry.total)} Go (${gb(entry.total - entry.used)} Go libres).`,
  };
}

/** The host port Gladys assigned to the Frigate UI, null before the first start. */
export function uiPort(entry) {
  return entry?.ports?.find((port) => port.name === UI_PORT_NAME)?.host_port ?? null;
}

/** The host port Gladys assigned to the go2rtc restream (live view), else null. */
export function rtspHostPort(entry) {
  return entry?.ports?.find((port) => port.name === RTSP_PORT_NAME)?.host_port ?? null;
}

/** https://<address of Gladys>:<port>, as the user types it. */
function uiAddress(entry) {
  const port = uiPort(entry);
  return port
    ? {
        en: `https://<address of Gladys>:${port}`,
        fr: `https://<adresse de Gladys>:${port}`,
      }
    : {
        en: 'the "Frigate UI" link of the supervision block (port assigned at the first start)',
        fr: 'le lien « Interface Frigate » du bloc de supervision (port attribué au premier démarrage)',
      };
}

const hashOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * @param {object} options
 * @param {{ getContainers: Function, startContainer: Function, stopContainer: Function,
 *   restartContainer: Function }} options.gladys
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {string} options.dataDir /data (FRIGATE_DATA_DIR)
 * @param {string} [options.url] Frigate's internal URL (tests: a fake Frigate)
 * @param {object} [options.adminOptions] setAdminPassword options (tests)
 * @param {() => string} [options.passwordFactory]
 */
export function createManagedFrigate({
  gladys,
  logger,
  dataDir,
  url = INTERNAL_URL,
  adminOptions = {},
  passwordFactory = generatePassword,
}) {
  const configDir = join(dataDir, CONFIG_DIR);
  const stateFile = createStateFile({ filePath: join(dataDir, 'managed', 'state.json') });
  let decision = null;
  let lastWrite = null;
  let adminInFlight = null;

  async function container() {
    const containers = (await gladys.getContainers()) ?? [];
    return containers.find((entry) => entry?.name === CONTAINER_NAME) ?? null;
  }

  function settingsFor(config, raw, devices) {
    decision = chooseDetector({
      detector: config.detector,
      gpuVendor: config.gpu_vendor,
      devices,
    });
    const mqtt = usesMqtt(config)
      ? {
          host: config.mqtt_host,
          port: config.mqtt_port,
          topicPrefix: config.mqtt_topic_prefix,
          user: config.mqtt_username,
          hasPassword: Boolean(config.mqtt_password),
          tls: config.mqtt_tls ? { ca: config.tls_ca || undefined } : null,
        }
      : null;
    return { mqtt, detector: decision, retention: explicitRetention(raw) };
  }

  /** The environment of the sub-container: the broker password, if any. */
  function environment(config) {
    return usesMqtt(config) && config.mqtt_username && config.mqtt_password
      ? { [MQTT_PASSWORD_ENV]: config.mqtt_password }
      : {};
  }

  async function generate(config, raw, entry) {
    const result = await writeConfigFile({
      configDir,
      settings: settingsFor(config, raw, entry?.devices ?? []),
    });
    lastWrite = result;
    if (result.changed) {
      logger.info(
        `Frigate configuration ${result.created ? 'created' : 'updated'} (detector: ${decision.kind})`,
      );
    }
    return { ...result, decision };
  }

  async function startWith(env) {
    await gladys.startContainer(CONTAINER_NAME, { env });
    await stateFile.update({ started_at: new Date().toISOString(), env_hash: hashOf(env) });
  }

  /** Restart a running container; through start when its environment changed. */
  async function restartWith(entry, env) {
    const state = await stateFile.read();
    if (entry?.status !== 'running' || state.env_hash !== hashOf(env)) {
      await startWith(env);
    } else {
      await gladys.restartContainer(CONTAINER_NAME);
    }
  }

  return {
    url,
    configPath: join(configDir, CONFIG_FILE),

    /** The `frigate` entry of GET /container, null when Gladys has none. */
    container,

    /** The last detector decision (null before the first generation). */
    get decision() {
      return decision;
    },

    /** The result of the last config.yml generation (retention applied…). */
    get lastWrite() {
      return lastWrite;
    },

    /** True once the integration started Frigate at least once. */
    async everStarted() {
      return Boolean((await stateFile.read()).started_at);
    },

    /** Generate config.yml, then start the sub-container. */
    async start(config, raw, entry) {
      const current = entry ?? (await container());
      const result = await generate(config, raw, current);
      await startWith(environment(config));
      logger.info('Frigate container started');
      return result;
    },

    async stop() {
      await gladys.stopContainer(CONTAINER_NAME);
      logger.info('Frigate container stopped');
    },

    /** Generate config.yml, then restart (or start) the sub-container. */
    async restart(config, raw, entry) {
      const current = entry ?? (await container());
      const result = await generate(config, raw, current);
      await restartWith(current, environment(config));
      logger.info('Frigate container restarted');
      return result;
    },

    /**
     * Apply the configuration to a Frigate supposed to run: regenerate, and
     * restart only when config.yml or the environment changed. A stopped
     * Frigate is left alone (its file is written at the next start).
     * @returns {Promise<{ restarted: boolean } & object | null>}
     */
    async refresh(config, raw, entry) {
      const current = entry ?? (await container());
      if (current?.desired !== 'running' && current?.status !== 'running') {
        return null;
      }
      const result = await generate(config, raw, current);
      if (current.status !== 'running') {
        // Down (Gladys is restarting it): the new file applies at its next start.
        return { ...result, restarted: false };
      }
      const env = environment(config);
      const envChanged = (await stateFile.read()).env_hash !== hashOf(env);
      if (result.changed || envChanged) {
        await restartWith(current, env);
        logger.info('Frigate restarted to apply the new configuration');
      }
      return { ...result, restarted: result.changed || envChanged };
    },

    /**
     * The user changed the hardware grants: Gladys recreated the
     * sub-container; regenerate (new detector) and restart it if it runs.
     * @param {Array} containers the `hardware-updated` payload
     */
    async hardwareUpdated(config, raw, containers = []) {
      const pushed = containers.find((entry) => entry?.name === CONTAINER_NAME);
      const current = await container();
      const devices = pushed?.devices ?? current?.devices ?? [];
      const result = await generate(config, raw, { ...current, devices });
      const running = current?.status === 'running';
      if (running) {
        await restartWith(current, environment(config));
      }
      return { ...result, restarted: running };
    },

    /**
     * What "Test the connection" shows without writing anything: the
     * detector the hardware gives and the retention config.yml would get.
     */
    async inspect(config, raw, entry) {
      const settings = settingsFor(config, raw, entry?.devices ?? []);
      let content = '';
      try {
        content = await readFile(join(configDir, CONFIG_FILE), 'utf8');
      } catch {
        // No file yet: the defaults.
      }
      try {
        const { retention, customDetectors } = renderConfig(content, settings);
        return { decision, retention, customDetectors };
      } catch {
        return { decision, retention: null, customDetectors: false };
      }
    },

    /**
     * Set the admin password once (kept in state.json). Concurrent calls
     * share one attempt. Resolves true when it was set now, false when it
     * already was.
     */
    ensureAdmin() {
      adminInFlight ??= (async () => {
        if ((await stateFile.read()).admin_password) {
          return false;
        }
        const password = passwordFactory();
        await setAdminPassword({ baseUrl: url, password, ...adminOptions });
        await stateFile.update({
          admin_password: password,
          admin_set_at: new Date().toISOString(),
        });
        logger.info('Frigate admin password set by Gladys (see "Show the Frigate credentials")');
        return true;
      })().finally(() => {
        adminInFlight = null;
      });
      return adminInFlight;
    },

    /** The answer of "Show the Frigate credentials". */
    async credentials(entry) {
      await adminInFlight?.catch(() => {});
      const { admin_password: password } = await stateFile.read();
      const address = uiAddress(entry);
      if (!password) {
        return {
          en: `No admin password set yet: it is set when Frigate first answers after "Start Frigate". The Frigate UI: ${address.en}.`,
          fr: `Aucun mot de passe admin défini pour l'instant : il est défini quand Frigate répond pour la première fois après « Démarrer Frigate ». Interface Frigate : ${address.fr}.`,
        };
      }
      return {
        en: `Frigate UI: ${address.en} (self-signed certificate: accept it in the browser). User: ${ADMIN_USER}. Password: ${password} . If you change it in the Frigate UI, this button keeps showing the one Gladys set.`,
        fr: `Interface Frigate : ${address.fr} (certificat auto-signé : acceptez-le dans le navigateur). Utilisateur : ${ADMIN_USER}. Mot de passe : ${password} . Si vous le changez dans l'interface Frigate, ce bouton continue d'afficher celui défini par Gladys.`,
      };
    },

    uiAddress,
  };
}
