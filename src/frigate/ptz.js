// -----------------------------------------------------------------------------
// PTZ (pan / tilt / zoom, presets) of the cameras Frigate drives over ONVIF.
//
//   - Frigate reports what each camera supports on GET /api/<camera>/ptz/info:
//     `features` (`pt` / `zoom`: continuous moves; `pt-r`, `zoom-r`,
//     `zoom-a`, `pt-r-fov`: relative or absolute ones, used by its
//     autotracking) and `presets` (the ONVIF preset names).
//   - Commands are one message on `<camera>/ptz` (MQTT, under the prefix, or
//     the Frigate WebSocket): MOVE_LEFT | MOVE_RIGHT | MOVE_UP | MOVE_DOWN |
//     ZOOM_IN | ZOOM_OUT | STOP | preset_<name>. MOVE_* and ZOOM_* are
//     continuous: the camera keeps moving until STOP.
//   - The values Gladys sends on its `camera/move` feature are the core's
//     CAMERA_MOVE (docs/specs/camera-ptz-control.md, A.2), mirrored here
//     because SDK 0.15 exports the feature types but not that value enum.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

/** Gladys' canonical movement values (core CAMERA_MOVE). */
export const CAMERA_MOVE = Object.freeze({
  STOP: 0,
  PAN_LEFT: 1,
  PAN_RIGHT: 2,
  TILT_UP: 3,
  TILT_DOWN: 4,
  ZOOM_IN: 5,
  ZOOM_OUT: 6,
});

export const PTZ_STOP = 'STOP';

const MOVE_PAYLOADS = Object.freeze({
  [CAMERA_MOVE.STOP]: PTZ_STOP,
  [CAMERA_MOVE.PAN_LEFT]: 'MOVE_LEFT',
  [CAMERA_MOVE.PAN_RIGHT]: 'MOVE_RIGHT',
  [CAMERA_MOVE.TILT_UP]: 'MOVE_UP',
  [CAMERA_MOVE.TILT_DOWN]: 'MOVE_DOWN',
  [CAMERA_MOVE.ZOOM_IN]: 'ZOOM_IN',
  [CAMERA_MOVE.ZOOM_OUT]: 'ZOOM_OUT',
});

/** Topic of the PTZ commands of a camera, without the MQTT prefix. */
export const ptzTopic = (camera) => `${camera}/ptz`;

/**
 * CAMERA_MOVE value -> Frigate payload ("MOVE_LEFT"…), null for anything
 * else (a value out of the enum must never reach the camera).
 * @param {number | string} value
 * @returns {string | null}
 */
export function ptzPayloadForMove(value) {
  if (value === null || value === '' || typeof value === 'boolean') {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) ? (MOVE_PAYLOADS[number] ?? null) : null;
}

/**
 * Preset name -> Frigate payload ("preset_<name>"), null without a name.
 * Frigate splits on the first underscore only, so a name holding
 * underscores goes through unchanged.
 * @param {string} name
 * @returns {string | null}
 */
export function ptzPayloadForPreset(name) {
  return typeof name === 'string' && name ? `preset_${name}` : null;
}

/**
 * The movements a camera supports, as CAMERA_MOVE values (STOP excluded:
 * always supported). Only Frigate's continuous features count (`pt`,
 * `zoom`): MOVE_* and ZOOM_* are continuous moves, which Frigate refuses on
 * a camera offering relative ones only (`pt-r`, `zoom-r`); its own UI shows
 * the pad on `pt` and `zoom` alone too.
 * @param {string[]} features `features` of /api/<camera>/ptz/info
 * @returns {number[]}
 */
export function supportedMoves(features) {
  const list = Array.isArray(features) ? features : [];
  const moves = [];
  if (list.includes('pt')) {
    moves.push(
      CAMERA_MOVE.PAN_LEFT,
      CAMERA_MOVE.PAN_RIGHT,
      CAMERA_MOVE.TILT_UP,
      CAMERA_MOVE.TILT_DOWN,
    );
  }
  if (list.includes('zoom')) {
    moves.push(CAMERA_MOVE.ZOOM_IN, CAMERA_MOVE.ZOOM_OUT);
  }
  return moves;
}

const strings = (value) =>
  Array.isArray(value) ? [...new Set(value.filter((v) => typeof v === 'string' && v))] : [];

/**
 * /api/<camera>/ptz/info -> { features, presets }, defensively: anything
 * Frigate does not send reads as empty.
 * @param {object} info
 * @returns {{ features: string[], presets: string[] }}
 */
export function normalizePtzInfo(info) {
  return { features: strings(info?.features), presets: strings(info?.presets) };
}
