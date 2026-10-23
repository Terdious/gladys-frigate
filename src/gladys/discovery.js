// -----------------------------------------------------------------------------
// Frigate cameras -> Gladys devices (the Discover tab).
//
// One device per Frigate camera, identified by the Frigate camera name (unique
// and stable in Frigate), exposing only what the Frigate configuration
// enables:
//   - image: Gladys polls the device every minute and each poll pushes a fresh
//     image (the dashboard camera widget shows the last pushed image);
//   - camera enabled (Frigate `<camera>/enabled`, also Gladys' camera gate);
//   - switches for Frigate's runtime toggles: object detection, recordings
//     (only when enabled in the Frigate file: Frigate refuses otherwise),
//     snapshots, audio detection (same rule);
//   - motion; per tracked object a presence sensor and a counter, plus the
//     total of objects; the review status (none / detection / alert);
//   - with the "zone sensors" option, one presence sensor per zone and object;
//   - when the live RTSP restream is known, the `CAMERA_URL` param the core
//     `rtsp-camera` service streams from (live view, see src/gladys/live.js);
//   - for a camera Frigate drives over ONVIF: a `move` command (the movements
//     it supports, as `supported_options`) and a `preset` command (its ONVIF
//     presets), rendered as a pad by the dashboard Camera widget.
// A camera device created with an older version shows "Update" in the
// Discover tab when features are added (Gladys compares the structure).
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { CAMERA_MOVE, supportedMoves } from '../frigate/ptz.js';
import { LIVE_PARAM, liveRtspUrl } from './live.js';

export const DEVICE_TYPE = 'camera';
export const CAMERA_PARAM = 'FRIGATE_CAMERA';
// The preset names in the order of the `preset` options (value = index + 1):
// a command maps back to its name even before Frigate is read again after a
// restart. Upserted silently with the options on every publication.
export const PTZ_PRESETS_PARAM = 'FRIGATE_PTZ_PRESETS';
// One of Gladys' DEVICE_POLL_FREQUENCIES (EVERY_MINUTES).
export const IMAGE_POLL_FREQUENCY_MS = 60_000;
export const MAX_OBJECT_COUNT = 1000;

export const FEATURES = Object.freeze({
  IMAGE: 'image',
  ENABLED: 'enabled',
  MOTION: 'motion',
  REVIEW: 'review',
  OBJECTS: 'objects',
  MOVE: 'move',
  PRESET: 'preset',
});

/** Labels of the `move` options (the dashboard pad shows icons, not these). */
export const MOVE_LABELS = Object.freeze({
  [CAMERA_MOVE.PAN_LEFT]: 'Pan left',
  [CAMERA_MOVE.PAN_RIGHT]: 'Pan right',
  [CAMERA_MOVE.TILT_UP]: 'Tilt up',
  [CAMERA_MOVE.TILT_DOWN]: 'Tilt down',
  [CAMERA_MOVE.ZOOM_IN]: 'Zoom in',
  [CAMERA_MOVE.ZOOM_OUT]: 'Zoom out',
});

/**
 * Frigate runtime toggles: feature key -> setting of the Frigate topics
 * `<camera>/<setting>/set` and `<camera>/<setting>/state`.
 */
export const TOGGLES = Object.freeze({
  enabled: 'enabled',
  detect: 'detect',
  recordings: 'recordings',
  snapshots: 'snapshots',
  audio: 'audio',
});

/** Frigate labels and zones -> feature key fragments ("traffic light" -> "traffic_light"). */
export function keyPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_');
}

export const countKey = (label) => `count-${keyPart(label)}`;
export const presenceKey = (label) => `presence-${keyPart(label)}`;
export const zoneKey = (zone, label) => `zone-${keyPart(zone)}-${keyPart(label)}`;

function humanize(value) {
  const text = String(value).replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Labels Frigate tracks on a camera (Frigate's default is "person"). */
export function trackedLabels(camera) {
  const labels = camera?.objects?.length ? camera.objects : ['person'];
  return [...new Set(labels)];
}

const binary = (name, externalId, category, readOnly) => ({
  name,
  external_id: externalId,
  category,
  type:
    category === DEVICE_FEATURE_CATEGORIES.SWITCH
      ? DEVICE_FEATURE_TYPES.SWITCH.BINARY
      : DEVICE_FEATURE_TYPES.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: readOnly,
  has_feedback: !readOnly,
  keep_history: true,
});

const counter = (name, externalId) => ({
  name,
  external_id: externalId,
  category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
  type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
  min: 0,
  max: MAX_OBJECT_COUNT,
  read_only: true,
  has_feedback: false,
  // Counts change with every passer-by: history off by default.
  keep_history: false,
});

/**
 * The PTZ features of a camera: none without ONVIF (or when Frigate could
 * not tell what it supports), `move` when it has continuous moves, `preset`
 * when it has presets. Neither keeps history nor echoes a state: they are
 * commands, not positions.
 * @param {(key: string) => string} id feature external id helper
 * @param {object} camera from capabilities
 */
function ptzFeatures(id, camera) {
  const features = [];
  const moves = supportedMoves(camera.ptz?.features);
  if (moves.length) {
    features.push({
      name: 'Movement',
      external_id: id(FEATURES.MOVE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.MOVE,
      min: CAMERA_MOVE.STOP,
      max: CAMERA_MOVE.ZOOM_OUT,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      // STOP (0) is always supported and never listed (core spec A.2).
      supported_options: moves.map((value, index) => ({
        value,
        label: MOVE_LABELS[value],
        sort_order: index,
      })),
    });
  }
  const presets = camera.ptz?.presets ?? [];
  if (presets.length) {
    features.push({
      name: 'Preset',
      external_id: id(FEATURES.PRESET),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.PRESET,
      min: 0,
      max: presets.length,
      read_only: false,
      has_feedback: false,
      keep_history: false,
      supported_options: presets.map((name, index) => ({
        value: index + 1,
        label: name,
        sort_order: index,
      })),
    });
  }
  return features;
}

/**
 * @typedef {object} DiscoveryOptions
 * @property {boolean} [zoneSensors] one presence sensor per zone and object
 * @property {{ host: string, port: number } | null} [liveRtsp] where the
 *   go2rtc restream is reached from Gladys (`resolveLiveRtsp()`); without it,
 *   no `CAMERA_URL` param is published
 * @property {{ warn: Function }} [logger] told when the core refuses the PTZ
 *   feature types
 */

/**
 * @param {{ externalIds: Function }} gladys SDK instance (id helpers only)
 * @param {object} camera from capabilities
 * @param {DiscoveryOptions} [options]
 */
export function buildCameraDevice(gladys, camera, { zoneSensors = false, liveRtsp = null } = {}) {
  const ids = gladys.externalIds(DEVICE_TYPE, camera.name);
  const id = ids.feature;
  const features = [
    {
      name: 'Image',
      external_id: id(FEATURES.IMAGE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    {
      ...binary('Camera enabled', id(FEATURES.ENABLED), DEVICE_FEATURE_CATEGORIES.CAMERA, false),
      type: DEVICE_FEATURE_TYPES.CAMERA.ENABLED,
    },
    binary('Object detection', id('detect'), DEVICE_FEATURE_CATEGORIES.SWITCH, false),
  ];
  if (camera.recordInConfig) {
    features.push(binary('Recordings', id('recordings'), DEVICE_FEATURE_CATEGORIES.SWITCH, false));
  }
  features.push(binary('Snapshots', id('snapshots'), DEVICE_FEATURE_CATEGORIES.SWITCH, false));
  if (camera.audio) {
    features.push(binary('Audio detection', id('audio'), DEVICE_FEATURE_CATEGORIES.SWITCH, false));
  }
  features.push(
    binary('Motion', id(FEATURES.MOTION), DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR, true),
    {
      name: 'Review status',
      external_id: id(FEATURES.REVIEW),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    counter('Objects', id(FEATURES.OBJECTS)),
  );
  for (const label of trackedLabels(camera)) {
    features.push(
      binary(
        humanize(label),
        id(presenceKey(label)),
        DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
        true,
      ),
      counter(`${humanize(label)} count`, id(countKey(label))),
    );
  }
  if (zoneSensors) {
    for (const zone of camera.zones ?? []) {
      const labels = zone.objects.length ? zone.objects : trackedLabels(camera);
      for (const label of labels) {
        features.push(
          binary(
            `${humanize(zone.friendlyName ?? zone.name)} ${label}`,
            id(zoneKey(zone.name, label)),
            DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
            true,
          ),
        );
      }
    }
  }
  features.push(...ptzFeatures(id, camera));
  // FRIGATE_CAMERA stays first: it identifies the camera of the device.
  const params = [{ name: CAMERA_PARAM, value: camera.name }];
  if (liveRtsp) {
    params.push({ name: LIVE_PARAM, value: liveRtspUrl(liveRtsp, camera.name) });
  }
  if (features.some((feature) => feature.type === DEVICE_FEATURE_TYPES.CAMERA.PRESET)) {
    params.push({ name: PTZ_PRESETS_PARAM, value: JSON.stringify(camera.ptz.presets) });
  }
  return {
    name: camera.friendlyName || camera.name,
    external_id: ids.device,
    params,
    should_poll: true,
    poll_frequency: IMAGE_POLL_FREQUENCY_MS,
    features,
  };
}

/**
 * The complete discovery list of a Frigate instance.
 * @param {{ externalIds: Function }} gladys
 * @param {object | null} capabilities
 * @param {DiscoveryOptions} [options]
 */
export function buildDevices(gladys, capabilities, options) {
  return (capabilities?.cameras ?? []).map((camera) => buildCameraDevice(gladys, camera, options));
}

/**
 * Frigate camera name of a Gladys device of this integration (from its
 * params, else from its external id), null for anything else.
 */
export function cameraNameOfDevice(gladys, device) {
  const param = (device?.params ?? []).find((p) => p.name === CAMERA_PARAM);
  if (typeof param?.value === 'string' && param.value) {
    return param.value;
  }
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  const externalId = device?.external_id;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  return externalId.slice(prefix.length) || null;
}

/**
 * Preset names of a Gladys device, in the order of its `preset` options
 * (from its params); null when it has none or they are unreadable.
 * @returns {string[] | null}
 */
export function presetsOfDevice(device) {
  const param = (device?.params ?? []).find((p) => p.name === PTZ_PRESETS_PARAM);
  if (typeof param?.value !== 'string') {
    return null;
  }
  try {
    const names = JSON.parse(param.value);
    return Array.isArray(names) && names.every((name) => typeof name === 'string') ? names : null;
  } catch {
    return null;
  }
}

/**
 * Splits a feature external id into its camera and feature key.
 * @returns {{ camera: string, key: string } | null}
 */
export function parseFeatureId(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const rest = externalId.slice(prefix.length);
  const index = rest.lastIndexOf(':');
  if (index <= 0 || index === rest.length - 1) {
    return null;
  }
  return { camera: rest.slice(0, index), key: rest.slice(index + 1) };
}

const PTZ_TYPES = new Set([DEVICE_FEATURE_TYPES.CAMERA.MOVE, DEVICE_FEATURE_TYPES.CAMERA.PRESET]);
const hasPtz = (device) => device.features.some((feature) => PTZ_TYPES.has(feature.type));
const withoutPtz = (device) => ({
  ...device,
  params: device.params.filter((param) => param.name !== PTZ_PRESETS_PARAM),
  features: device.features.filter((feature) => !PTZ_TYPES.has(feature.type)),
});
// A Gladys core older than the PTZ feature types refuses the whole list.
const isUnknownType = (err) => err?.status === 400 && /unknown type/i.test(err.message ?? '');

/**
 * Publishes the discovery list (it replaces the previous one; Gladys keeps it
 * in memory only, so it is published again on every connection). A core
 * that does not know the PTZ feature types gets the list without them, so
 * that the cameras stay discoverable.
 * @param {{ externalIds: Function, publishDiscoveredDevices: Function }} gladys
 * @param {object | null} capabilities null = Frigate not reachable: empty list
 * @param {DiscoveryOptions} [options]
 * @returns {Promise<number>} number of cameras listed
 */
export async function publishDiscovery(gladys, capabilities, options = {}) {
  const devices = buildDevices(gladys, capabilities, options);
  try {
    await gladys.publishDiscoveredDevices(devices);
  } catch (err) {
    if (!isUnknownType(err) || !devices.some(hasPtz)) {
      throw err;
    }
    options.logger?.warn(
      'This Gladys version does not know the PTZ features: cameras are listed without their controls (update Gladys)',
    );
    await gladys.publishDiscoveredDevices(devices.map(withoutPtz));
  }
  return devices.length;
}
