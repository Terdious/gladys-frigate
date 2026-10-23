// -----------------------------------------------------------------------------
// Managed cameras -> go2rtc sources and Frigate camera sections.
//
// A managed camera is stored as what the user typed (overrides) plus its
// catalog model (./catalog.js); resolveCamera() merges both, so a preset
// improved in a later version reaches the cameras that did not override it.
// Then:
//
//   - the go2rtc streams: `<camera>` (main source) and, when the camera has a
//     distinct secondary stream, `<camera>_sub` — credentials URL-encoded
//     here, since the user types them in clear;
//   - the Frigate camera section: ffmpeg inputs on the embedded go2rtc
//     restream (one connection per camera stream whatever reads it),
//     `record` on the main stream and `detect` on the secondary one, the
//     detection fps, the tracked objects, the friendly name, and the ONVIF
//     endpoint used for PTZ.
//
// Retention (`record`, `snapshots`) stays global (./configFile.js): no
// per-camera section unless the user writes one in the Frigate UI.
//
// Never logs nor returns a password outside the generated sources (which go
// to config.yml only): messages use redactSource().
//
// Pure: no I/O, no Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { CameraSourceError } from '../errors.js';
import {
  CATALOG,
  CONTROL_PROTOCOLS,
  DEFAULT_HTTP_PORT,
  DEFAULT_MJPEG_PATH,
  DEFAULT_ONVIF_PORT,
  DEFAULT_RTSP_PORT,
  SOURCE_TYPES,
  TAPO_SOURCE_EXTRA,
  TRACKABLE_LABELS,
  catalogEntry,
} from './catalog.js';
import {
  DEFAULT_DETECT_FPS,
  RESTREAM_BASE,
  SUB_STREAM_SUFFIX,
  TAPO_DETECT_SIZE,
  TAPO_INPUT_ARGS,
} from './constants.js';

const MAX_NAME_LENGTH = 48;

/**
 * The Frigate camera name of a label: lowercase ASCII letters, digits and
 * underscores ("Caméra entrée" -> "camera_entree"). It becomes the Gladys
 * external id of the device: computed once, at creation, never again.
 * @param {string} label
 * @returns {string} '' when nothing usable is left
 */
export function slugify(label) {
  return String(label ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/_+$/, '');
}

/**
 * Parse the "objects to detect" CSV ("person, car; dog").
 * @param {string} csv
 * @returns {{ objects: string[], unknown: string[] }} objects in the given
 *   order without duplicates; unknown: the labels Frigate's model lacks
 */
export function parseObjects(csv) {
  const objects = [];
  const unknown = [];
  for (const part of String(csv ?? '').split(/[,;]/)) {
    const label = part.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (!label) continue;
    if (!TRACKABLE_LABELS.includes(label)) {
      if (!unknown.includes(label)) unknown.push(label);
    } else if (!objects.includes(label)) {
      objects.push(label);
    }
  }
  return { objects, unknown };
}

/** A source shown to the user: credentials replaced ("rtsp://***@host…"). */
export function redactSource(source) {
  return String(source ?? '').replace(/(:\/\/)[^@/\s]*@/g, '$1***@');
}

const defined = (value) => value !== undefined && value !== null;
const pick = (override, fallback) => (defined(override) ? override : fallback);
const text = (value) => (value == null ? '' : String(value));

/**
 * @typedef {object} CameraRecord what /data/managed/cameras.json holds for a
 *   camera: undefined = the preset of its model; '' = explicitly none
 * @property {string} label
 * @property {string} model a catalog id
 * @property {string} [host]
 * @property {string} [username]
 * @property {string} [password]
 * @property {string} [path]
 * @property {string} [subPath]
 * @property {number} [port] RTSP port, or HTTP port of an MJPEG camera
 * @property {number} [onvifPort]
 * @property {string} [onvifUsername] default: username
 * @property {string} [onvifPassword] default: password
 * @property {string} [customSource]
 * @property {string} [customSubSource]
 * @property {'default' | 'sha256'} [tapoAuthVariant]
 * @property {string[]} [objects]
 * @property {number} [detectFps]
 */

/**
 * The record merged with its catalog preset.
 * @param {string} name the Frigate camera name
 * @param {CameraRecord} record
 * @throws {CameraSourceError} unknown_model
 */
export function resolveCamera(name, record) {
  const entry = catalogEntry(record?.model);
  if (!entry) {
    throw new CameraSourceError('unknown_model', name);
  }
  const { preset } = entry;
  const customSource = text(record.customSource).trim();
  const username = text(record.username);
  const password = text(record.password);
  // The ONVIF endpoint (PTZ) is only declared where it is expected: a model
  // known to have one, or ONVIF settings typed by the user. Elsewhere Frigate
  // would retry a missing endpoint forever.
  const onvifWanted =
    defined(preset.onvifPort) ||
    defined(record.onvifPort) ||
    Boolean(record.onvifUsername) ||
    preset.sourceType === SOURCE_TYPES.ONVIF;
  return {
    name,
    label: text(record.label) || name,
    model: entry.id,
    entry,
    sourceType: customSource ? SOURCE_TYPES.CUSTOM : preset.sourceType,
    host: text(record.host).trim(),
    username,
    password,
    path: text(pick(record.path, preset.path ?? '')),
    subPath: text(pick(record.subPath, preset.subPath ?? '')),
    sourceFilter: preset.sourceFilter ?? '',
    rtspPort: pick(record.port, preset.rtspPort ?? DEFAULT_RTSP_PORT),
    httpPort: pick(record.port, preset.httpPort ?? DEFAULT_HTTP_PORT),
    onvifPort: pick(record.onvifPort, preset.onvifPort ?? DEFAULT_ONVIF_PORT),
    onvifUsername: text(pick(record.onvifUsername, username)),
    onvifPassword: text(pick(record.onvifPassword, password)),
    onvifWanted,
    ptzProtocol: preset.ptzProtocol ?? null,
    nightModeProtocol: preset.nightModeProtocol ?? null,
    tapoAuthVariant: record.tapoAuthVariant === 'sha256' ? 'sha256' : 'default',
    customSource,
    customSubSource: text(record.customSubSource).trim(),
    extra: preset.extra ?? TAPO_SOURCE_EXTRA,
    objects:
      Array.isArray(record.objects) && record.objects.length ? [...record.objects] : ['person'],
    detectFps:
      Number.isInteger(record.detectFps) && record.detectFps > 0
        ? record.detectFps
        : DEFAULT_DETECT_FPS,
    battery: entry.battery === true,
  };
}

/** "user:password@" URL-encoded, '' without a user. */
function credentials(username, password) {
  return username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
}

const cleanPath = (path) => String(path).replace(/^\/+/, '');

function rtspUrl(camera, path) {
  const suffix = path ? `/${cleanPath(path)}` : '';
  return `rtsp://${credentials(camera.username, camera.password)}${camera.host}:${camera.rtspPort}${suffix}${camera.sourceFilter}`;
}

function requireHost(camera) {
  if (!camera.host) throw new CameraSourceError('missing_host', camera.name);
}

/**
 * The go2rtc source of the main stream.
 * @param {ReturnType<typeof resolveCamera>} camera
 * @throws {CameraSourceError}
 */
export function buildMainSource(camera) {
  switch (camera.sourceType) {
    case SOURCE_TYPES.RTSP:
      requireHost(camera);
      return rtspUrl(camera, camera.path);
    case SOURCE_TYPES.TAPO: {
      requireHost(camera);
      if (!camera.password) throw new CameraSourceError('missing_password', camera.name);
      if (camera.tapoAuthVariant === 'sha256') {
        // Some recent firmwares only accept admin + the uppercase SHA-256 of
        // the cloud password (hexadecimal: nothing to encode).
        const hash = createHash('sha256').update(camera.password).digest('hex').toUpperCase();
        return `tapo://admin:${hash}@${camera.host}?${camera.extra}`;
      }
      return `tapo://${encodeURIComponent(camera.password)}@${camera.host}?${camera.extra}`;
    }
    case SOURCE_TYPES.ONVIF:
      requireHost(camera);
      return `onvif://${credentials(camera.onvifUsername, camera.onvifPassword)}${camera.host}:${camera.onvifPort}`;
    case SOURCE_TYPES.MJPEG: {
      requireHost(camera);
      // go2rtc reads the HTTP MJPEG stream and re-encodes it to H264 (light
      // at the VGA resolutions of these old cameras).
      const path = cleanPath(camera.path || DEFAULT_MJPEG_PATH);
      return `ffmpeg:http://${credentials(camera.username, camera.password)}${camera.host}:${camera.httpPort}/${path}#video=h264`;
    }
    case SOURCE_TYPES.CUSTOM:
      if (!camera.customSource) throw new CameraSourceError('missing_custom_source', camera.name);
      return camera.customSource;
    default:
      throw new CameraSourceError('unknown_model', camera.name);
  }
}

/**
 * The go2rtc source of the secondary (detection) stream, or null. A
 * secondary stream identical to the main one would open a second camera
 * connection for nothing: none.
 * @param {ReturnType<typeof resolveCamera>} camera
 */
export function buildSubSource(camera) {
  if (camera.sourceType === SOURCE_TYPES.RTSP) {
    if (!camera.subPath || cleanPath(camera.subPath) === cleanPath(camera.path)) return null;
    requireHost(camera);
    return rtspUrl(camera, camera.subPath);
  }
  if (camera.sourceType === SOURCE_TYPES.CUSTOM) {
    const sub = camera.customSubSource;
    return sub && sub !== camera.customSource ? sub : null;
  }
  // tapo: the one usable stream already is the light one; onvif, mjpeg: one stream.
  return null;
}

/** Frigate substitutes {FRIGATE_*} in these strings with str.format: literal braces are doubled. */
const escapeBraces = (value) => String(value).replace(/[{}]/g, (brace) => brace + brace);

/**
 * The go2rtc streams and the Frigate camera section of a managed camera.
 * @param {ReturnType<typeof resolveCamera>} camera
 * @returns {{ name: string, streams: Record<string, string[]>, section: object,
 *   main: string, sub: string | null }}
 * @throws {CameraSourceError}
 */
export function buildCameraConfig(camera) {
  const { name } = camera;
  const main = buildMainSource(camera);
  const sub = buildSubSource(camera);
  const subName = `${name}${SUB_STREAM_SUFFIX}`;
  const streams = { [name]: [main] };
  if (sub) streams[subName] = [sub];

  const tapo = camera.sourceType === SOURCE_TYPES.TAPO || /^tapo:\/\//i.test(main);
  const tapoArgs = tapo ? { input_args: TAPO_INPUT_ARGS } : {};
  const inputs = sub
    ? [
        { path: `${RESTREAM_BASE}/${name}`, ...tapoArgs, roles: ['record'] },
        { path: `${RESTREAM_BASE}/${subName}`, ...tapoArgs, roles: ['detect'] },
      ]
    : [{ path: `${RESTREAM_BASE}/${name}`, ...tapoArgs, roles: ['detect', 'record'] }];

  const detect = { enabled: true, fps: camera.detectFps };
  if (tapo) Object.assign(detect, TAPO_DETECT_SIZE);

  const section = {};
  if (camera.label && camera.label !== name) section.friendly_name = camera.label;
  Object.assign(section, {
    ffmpeg: { inputs },
    detect,
    objects: { track: [...camera.objects] },
  });

  // PTZ: the ONVIF endpoint, with the control credentials. Not for cameras
  // driven by a proprietary protocol (D-Link HTTP).
  if (
    camera.onvifWanted &&
    camera.host &&
    camera.onvifUsername &&
    camera.onvifPassword &&
    camera.ptzProtocol !== CONTROL_PROTOCOLS.DLINK_HTTP
  ) {
    section.onvif = {
      host: camera.host,
      port: camera.onvifPort,
      user: escapeBraces(camera.onvifUsername),
      password: escapeBraces(camera.onvifPassword),
    };
  }
  return { name, streams, section, main, sub };
}

/** The ids of the catalog, in the order of the `model` select. */
export const MODEL_IDS = Object.freeze(CATALOG.map((entry) => entry.id));
