// -----------------------------------------------------------------------------
// D-Link HTTP controls (catalog protocol `dlink-http`, the DCS-5020L): the
// pan/tilt and the night mode of the cameras D-Link drives through its own
// CGI rather than ONVIF. Ported from the core branch frigate-pr9
// (server/services/frigate/lib/sendDlinkPtzCommand.js, setValue.js),
// validated on a DCS-5020L (firmware 1.16).
//
//   - Pan/tilt: POST /pantiltcontrol.cgi (form-urlencoded) with a single
//     step of 5 degrees: `PanTiltSingleMove` 1 up, 3 left, 5 right, 7 down
//     (the cells of D-Link's 3x3 direction pad). A step ends by itself:
//     there is nothing to stop, and no zoom.
//   - Night mode: GET /daynight.cgi?DayNightMode=3 (infrared forced) or 0
//     (automatic), ConfigReboot=no so the camera applies it without
//     rebooting. The camera sends nothing back: the caller publishes the
//     state it asked for.
//   - Both need the camera ADMIN account (HTTP basic auth): a user account
//     streams but gets 401 on these CGIs.
//
// Plain HTTP on the LAN (these cameras have no TLS). The credentials only go
// in the Authorization header: never in a URL, a log or an error message.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { fetch } from 'undici';
import { CONTROL_PROTOCOLS, DEFAULT_HTTP_PORT } from './managed/catalog.js';
import { CAMERA_MOVE } from './ptz.js';
import { DlinkCredentialsError, DlinkHttpError, DlinkUnreachableError } from './errors.js';

export const DLINK_PANTILT_PATH = '/pantiltcontrol.cgi';
export const DLINK_DAYNIGHT_PATH = '/daynight.cgi';
export const DLINK_STEP_DEGREES = 5;
export const DLINK_NIGHT_MODE = Object.freeze({ IR_FORCED: 3, AUTO: 0 });
export const DLINK_TIMEOUT_MS = 5_000;

/** Gladys movement (CAMERA_MOVE) -> D-Link `PanTiltSingleMove` cell. */
const SINGLE_MOVES = Object.freeze({
  [CAMERA_MOVE.TILT_UP]: 1,
  [CAMERA_MOVE.PAN_LEFT]: 3,
  [CAMERA_MOVE.PAN_RIGHT]: 5,
  [CAMERA_MOVE.TILT_DOWN]: 7,
});

/** The movements a D-Link camera makes (STOP excluded, no zoom), in the pad order. */
export const DLINK_MOVES = Object.freeze([
  CAMERA_MOVE.PAN_LEFT,
  CAMERA_MOVE.PAN_RIGHT,
  CAMERA_MOVE.TILT_UP,
  CAMERA_MOVE.TILT_DOWN,
]);

/**
 * The request of a single-step move, null for anything that sends nothing:
 * STOP (a step ends by itself), zoom (no motor), a value out of the enum.
 * @param {number | string} move a CAMERA_MOVE value
 * @returns {{ method: 'POST', path: string, body: string } | null}
 */
export function dlinkMoveRequest(move) {
  if (move === null || move === '' || typeof move === 'boolean') return null;
  const cell = SINGLE_MOVES[Number(move)];
  if (cell === undefined) return null;
  const body = new URLSearchParams({
    PanSingleMoveDegree: String(DLINK_STEP_DEGREES),
    TiltSingleMoveDegree: String(DLINK_STEP_DEGREES),
    PanTiltSingleMove: String(cell),
  }).toString();
  return { method: 'POST', path: DLINK_PANTILT_PATH, body };
}

/**
 * The request of the night mode: infrared forced (on) or automatic (off).
 * @param {boolean} on
 * @returns {{ method: 'GET', path: string }}
 */
export function dlinkNightModeRequest(on) {
  const mode = on ? DLINK_NIGHT_MODE.IR_FORCED : DLINK_NIGHT_MODE.AUTO;
  return { method: 'GET', path: `${DLINK_DAYNIGHT_PATH}?DayNightMode=${mode}&ConfigReboot=no` };
}

/**
 * Send a D-Link control request.
 * @param {object} target
 * @param {string} target.host the camera address
 * @param {number} [target.port] its HTTP port (80)
 * @param {string} target.username the control (admin) account
 * @param {string} target.password
 * @param {typeof fetch} [target.fetchImpl]
 * @param {number} [target.timeoutMs]
 * @param {{ method: string, path: string, body?: string }} request
 * @throws {DlinkCredentialsError | DlinkHttpError | DlinkUnreachableError}
 */
export async function sendDlink(
  { host, port, username, password, fetchImpl = fetch, timeoutMs = DLINK_TIMEOUT_MS },
  request,
) {
  if (!username || !password) {
    throw new DlinkCredentialsError();
  }
  const authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
  const url = new URL(request.path, `http://${host}:${port || DEFAULT_HTTP_PORT}`);
  const headers = { authorization };
  if (request.body !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err?.cause ?? err;
    const code =
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'TIMEOUT'
        : (cause?.code ?? 'NETWORK');
    throw new DlinkUnreachableError(code);
  }
  // The CGI answers a few lines of text: nothing to read.
  try {
    await response.body?.cancel?.();
  } catch {
    // Already closed.
  }
  if (!response.ok) {
    throw new DlinkHttpError(response.status);
  }
}

/**
 * The D-Link controls of a managed camera (resolveCamera() of
 * ./managed/cameraSources.js), null when it has none.
 * @param {{ ptzProtocol: string | null, nightModeProtocol: string | null }} camera
 * @returns {{ ptz: boolean, nightMode: boolean } | null}
 */
export function dlinkControlsOf(camera) {
  const ptz = camera?.ptzProtocol === CONTROL_PROTOCOLS.DLINK_HTTP;
  const nightMode = camera?.nightModeProtocol === CONTROL_PROTOCOLS.DLINK_HTTP;
  return ptz || nightMode ? { ptz, nightMode } : null;
}

/**
 * Where the D-Link controls of a managed camera go: its address, its HTTP
 * port (the stream port of an MJPEG camera, 80 by default) and the control
 * account, which falls back to the stream account (resolveCamera()).
 * @param {object} camera resolveCamera() output
 * @returns {{ host: string, port: number, username: string, password: string }}
 */
export function dlinkTargetOf(camera) {
  return {
    host: camera.host,
    port: Number(camera.httpPort) || DEFAULT_HTTP_PORT,
    username: camera.onvifUsername,
    password: camera.onvifPassword,
  };
}
