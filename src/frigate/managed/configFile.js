// -----------------------------------------------------------------------------
// The config.yml of the managed Frigate.
//
// The supervisor mounts `<integration>/containers/frigate/config` on the
// Frigate container's /config, and the integration sees the same folder as
// /data/containers/frigate/config: writing config.yml there, then starting or
// restarting the sub-container, is the configuration channel.
//
// Gladys owns a few sections only, and leaves everything else as it is — in
// particular what the user sets in the Frigate UI (cameras, zones, masks,
// go2rtc, auth, tls…):
//
//   - `mqtt`: disabled, or the user's broker (password through the
//     environment, see MQTT_PASSWORD_ENV);
//   - `detectors`, plus the OpenVINO `model` section it needs: an explicit
//     choice always applies; in automatic mode a detectors section Gladys did
//     not generate (a hand-written one) is kept. The generated model section
//     is removed when leaving OpenVINO; a custom one is kept;
//   - `ffmpeg.hwaccel_args: preset-vaapi` only when VAAPI applies and the
//     file has no ffmpeg section (a user one is never overwritten); the
//     generated one is removed when the GPU is no longer usable, since
//     Frigate's ffmpeg would fail without /dev/dri;
//   - the global retention of `record` (Frigate 0.16+ schema:
//     continuous.days, alerts.retain.days, detections.retain.days) and of
//     `snapshots` (retain.default): an explicit Gladys value wins, else the
//     days already in the file (set in the Frigate UI), else the defaults.
//
// The `cameras` and `go2rtc` sections are never touched in this milestone
// (cameras are added in the Frigate UI until camera management lands).
// Frigate 0.14+ writes a `version` key at the top of the file when it
// migrates it: kept, like every other key.
//
// The YAML is edited as a document (yaml's parseDocument), so comments and
// formatting of the untouched parts survive; a value is only set when it
// differs, and the file is only written when something changed.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isNode, parseDocument } from 'yaml';
import { ManagedConfigError } from '../errors.js';
import {
  DETECTOR_PRESETS,
  MQTT_CA_FILE,
  MQTT_CA_PATH_IN_FRIGATE,
  MQTT_PASSWORD_ENV,
  OPENVINO_MODEL,
  RETENTION_DEFAULTS,
  SYSTEM_CA_BUNDLE,
  VAAPI_FFMPEG,
} from './constants.js';

/** The keys of a user's mqtt section that Gladys keeps (it owns the others). */
const KEPT_MQTT_KEYS = ['client_id', 'stats_interval', 'qos'];

const RETENTION_PATHS = {
  continuous: ['record', 'continuous', 'days'],
  alerts: ['record', 'alerts', 'retain', 'days'],
  detections: ['record', 'detections', 'retain', 'days'],
  snapshots: ['snapshots', 'retain', 'default'],
};

/** A whole number of days >= 0, else undefined. */
function days(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function valueAt(doc, path) {
  const node = doc.getIn(path, true);
  return isNode(node) ? node.toJS(doc) : node;
}

/**
 * Set `path` to `value` unless it already holds it. Missing (or non-map)
 * parents become maps. Returns true when the document changed.
 */
function setIfDifferent(doc, path, value) {
  if (isDeepStrictEqual(valueAt(doc, path), value)) {
    return false;
  }
  for (let depth = 1; depth < path.length; depth += 1) {
    const parent = path.slice(0, depth);
    if (!isMap(doc.getIn(parent, true))) {
      doc.setIn(parent, doc.createNode({}));
    }
  }
  doc.setIn(path, doc.createNode(value));
  return true;
}

function deleteIf(doc, path, predicate) {
  if (doc.hasIn(path) && predicate(valueAt(doc, path))) {
    doc.deleteIn(path);
    return true;
  }
  return false;
}

/**
 * The retention days of a parsed Frigate configuration (global level).
 * @param {object | null | undefined} frigateConfig plain JS
 * @returns {{ continuous?: number, alerts?: number, detections?: number, snapshots?: number }}
 */
export function retentionInFile(frigateConfig) {
  const record = frigateConfig?.record;
  return {
    continuous: days(record?.continuous?.days),
    alerts: days(record?.alerts?.retain?.days),
    detections: days(record?.detections?.retain?.days),
    snapshots: days(frigateConfig?.snapshots?.retain?.default),
  };
}

/**
 * The retention that applies: explicit Gladys value, else the file, else
 * the default.
 * @param {Record<string, number | null | undefined>} explicit
 * @param {Record<string, number | undefined>} inFile
 */
export function effectiveRetention(explicit = {}, inFile = {}) {
  const result = {};
  for (const key of Object.keys(RETENTION_DEFAULTS)) {
    result[key] = days(explicit[key]) ?? days(inFile[key]) ?? RETENTION_DEFAULTS[key];
  }
  return result;
}

/** The mqtt section Gladys wants, keeping the user's tuning keys. */
function mqttSection(current, mqtt) {
  if (!mqtt) {
    return { enabled: false };
  }
  const kept = {};
  for (const key of KEPT_MQTT_KEYS) {
    if (current && typeof current === 'object' && current[key] !== undefined) {
      kept[key] = current[key];
    }
  }
  const section = {
    ...kept,
    enabled: true,
    host: mqtt.host,
    port: mqtt.port,
    topic_prefix: mqtt.topicPrefix,
  };
  if (mqtt.user) {
    section.user = mqtt.user;
    if (mqtt.hasPassword) {
      // Substituted by Frigate from the container environment.
      section.password = `{${MQTT_PASSWORD_ENV}}`;
    }
  }
  if (mqtt.tls) {
    // Frigate only turns TLS on when tls_ca_certs is set.
    section.tls_ca_certs = mqtt.tls.ca ? MQTT_CA_PATH_IN_FRIGATE : SYSTEM_CA_BUNDLE;
  }
  return section;
}

const isPreset = (value) =>
  Object.values(DETECTOR_PRESETS).some((p) => isDeepStrictEqual(value, p));

/**
 * @typedef {object} ManagedSettings
 * @property {null | { host: string, port: number, topicPrefix: string, user?: string,
 *   hasPassword?: boolean, tls?: null | { ca?: string } }} mqtt null = no broker
 * @property {ReturnType<import('./detector.js').chooseDetector>} detector
 * @property {Record<string, number | null | undefined>} [retention] explicit
 *   Gladys values (null / undefined: not set in Gladys)
 */

/**
 * Apply the Gladys-owned sections to a config.yml content.
 * @param {string} content the current file ('' when there is none)
 * @param {ManagedSettings} settings
 * @param {{ created?: boolean }} [options] created: a new file (gets `cameras: {}`)
 * @returns {{ content: string, changed: boolean, retention: object, customDetectors: boolean }}
 * @throws {ManagedConfigError} invalid_yaml | not_a_map
 */
export function renderConfig(content, settings, { created = false } = {}) {
  const doc = parseDocument(content ?? '');
  if (doc.errors.length > 0) {
    throw new ManagedConfigError('invalid_yaml', { cause: doc.errors[0] });
  }
  if (doc.contents == null) {
    doc.contents = doc.createNode({});
  } else if (!isMap(doc.contents)) {
    throw new ManagedConfigError('not_a_map');
  }
  const before = doc.toJS() ?? {};
  let edited = false;
  const set = (path, value) => {
    edited = setIfDifferent(doc, path, value) || edited;
  };
  const remove = (path, predicate) => {
    edited = deleteIf(doc, path, predicate) || edited;
  };

  set(['mqtt'], mqttSection(before.mqtt, settings.mqtt));

  const { detector } = settings;
  const currentDetectors = before.detectors;
  const customDetectors =
    !detector.explicit && currentDetectors != null && !isPreset(currentDetectors);
  if (!customDetectors) {
    set(['detectors'], detector.detectors);
    if (detector.openvino) {
      if (before.model == null) {
        set(['model'], { ...OPENVINO_MODEL });
      }
    } else {
      remove(['model'], (model) => isDeepStrictEqual(model, { ...OPENVINO_MODEL }));
    }
  }

  if (detector.vaapi) {
    if (before.ffmpeg == null) {
      set(['ffmpeg'], { ...VAAPI_FFMPEG });
    }
  } else {
    remove(['ffmpeg'], (ffmpeg) => isDeepStrictEqual(ffmpeg, { ...VAAPI_FFMPEG }));
  }

  const retention = effectiveRetention(settings.retention, retentionInFile(before));
  if (before.record?.enabled === undefined) set(['record', 'enabled'], true);
  if (before.snapshots?.enabled === undefined) set(['snapshots', 'enabled'], true);
  for (const [key, path] of Object.entries(RETENTION_PATHS)) {
    set(path, retention[key]);
  }

  // Frigate 0.14+ starts without any camera; a new file declares the
  // (empty) section the user fills in the Frigate UI.
  if (created && before.cameras === undefined) {
    set(['cameras'], {});
  }

  const next = edited ? String(doc) : content;
  return { content: next, changed: next !== content, retention, customDetectors };
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write through a temporary file: Frigate never reads a half-written config. */
async function writeAtomically(filePath, content, mode = 0o644) {
  const temporary = `${filePath}.gladys-tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, filePath);
  } catch (err) {
    throw new ManagedConfigError('write_failed', { cause: err });
  }
}

/**
 * Generate (or update) config.yml, and the broker authority file next to it
 * when MQTT over TLS uses one.
 * @param {object} options
 * @param {string} options.configDir /data/containers/frigate/config
 * @param {ManagedSettings} options.settings
 * @param {string} [options.fileName]
 * @returns {Promise<{ changed: boolean, created: boolean, retention: object,
 *   customDetectors: boolean, filePath: string }>} `changed` covers the
 *   authority file too (Frigate reads it at start-up only).
 */
export async function writeConfigFile({ configDir, settings, fileName = 'config.yml' }) {
  const filePath = join(configDir, fileName);
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch (err) {
    throw new ManagedConfigError('write_failed', { cause: err });
  }
  const current = await readIfExists(filePath);
  const created = current === null;
  const result = renderConfig(current ?? '', settings, { created });

  let caChanged = false;
  const ca = settings.mqtt?.tls?.ca;
  if (ca) {
    const caPath = join(configDir, MQTT_CA_FILE);
    const text = ca.endsWith('\n') ? ca : `${ca}\n`;
    if ((await readIfExists(caPath)) !== text) {
      await writeAtomically(caPath, text);
      caChanged = true;
    }
  }

  if (result.changed || created) {
    await writeAtomically(filePath, result.content);
  }
  return {
    changed: result.changed || created || caChanged,
    created,
    retention: result.retention,
    customDetectors: result.customDetectors,
    filePath,
  };
}
