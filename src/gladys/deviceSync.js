// -----------------------------------------------------------------------------
// Camera devices kept in sync with Frigate.
//
//   - Real-time messages -> feature states (./cameraStates.js, published by
//     ./statePublisher.js) and transport badges (./transports.js).
//   - Commands (onSetValue): a switch publishes `<camera>/<setting>/set` on
//     the feed, then waits for Frigate's `<camera>/<setting>/state`; no
//     confirmation within 4 s fails the command with a reason (in WebSocket
//     mode Frigate 0.17+ silently ignores commands from non-admin accounts).
//   - PTZ commands (`move`, `preset`) publish `<camera>/ptz`; Frigate sends
//     no state back for them, so nothing is awaited. Frigate's moves are
//     continuous until STOP: every move arms a per-camera watchdog that
//     sends STOP after 1.5 s unless another order comes first (core spec
//     A.2: a lost release must never leave a camera turning).
//   - D-Link HTTP cameras (device param FRIGATE_CONTROL = dlink-http, managed
//     mode): `move` and the "Night mode (IR)" switch go to the camera itself
//     (src/frigate/dlink.js), with the address and the control (admin)
//     account of the managed cameras store (`dlinkTargetOf`). A move is one
//     5-degree step that ends by itself: STOP sends nothing and no watchdog
//     is armed. The camera echoes nothing: the night mode state published
//     is the one the command set.
//   - Polls (every minute per camera device): push a fresh image; on Frigate
//     0.16, which has no `status/<role>` topics, read the camera fps from
//     /api/stats for the transport badge.
// -----------------------------------------------------------------------------

import { createStateMapper } from './cameraStates.js';
import {
  dlinkMoveRequest,
  dlinkNightModeRequest,
  sendDlink as sendDlinkRequest,
} from '../frigate/dlink.js';
import { DlinkCredentialsError, DlinkHttpError } from '../frigate/errors.js';
import { CONTROL_PROTOCOLS } from '../frigate/managed/catalog.js';
import {
  CAMERA_MOVE,
  PTZ_STOP,
  ptzPayloadForMove,
  ptzPayloadForPreset,
  ptzTopic,
} from '../frigate/ptz.js';
import {
  FEATURES,
  TOGGLES,
  cameraNameOfDevice,
  controlOfDevice,
  parseFeatureId,
  presetsOfDevice,
} from './discovery.js';
import { createStatePublisher } from './statePublisher.js';
import { createTransportTracker } from './transports.js';

const CONFIRM_TIMEOUT_MS = 4_000;
const STATS_MAX_AGE_MS = 30_000;
// Short on purpose: a lone move (a scene, a release lost by the browser)
// is a nudge, not a camera turning for seconds. Holding a pad button longer
// than this stops the move: press again to go on.
export const PTZ_WATCHDOG_MS = 1_500;

export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandError';
  }
}

/**
 * @param {object} options
 * @param {object} options.gladys SDK instance
 * @param {() => object | null} options.getCapabilities
 * @param {() => object | null} options.getClient Frigate HTTP client while connected
 * @param {() => object | null} options.getFeed the real-time feed
 * @param {() => boolean} options.zoneSensors
 * @param {{ pushImage: (device: object) => Promise }} options.images
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {number} [options.confirmTimeoutMs]
 * @param {number} [options.ptzWatchdogMs] automatic STOP after a move
 * @param {(camera: string) => Promise<{ host: string, port: number, username: string,
 *   password: string } | null>} [options.dlinkTargetOf] where the D-Link controls of a
 *   managed camera go (null: not a managed camera, or the remote mode)
 * @param {typeof sendDlinkRequest} [options.sendDlink] the D-Link HTTP sender
 * @param {number} [options.debounceMs] camera status debounce
 * @param {number} [options.flushMs] state batching
 * @param {() => number} [options.now]
 */
export function createDeviceSync({
  gladys,
  getCapabilities,
  getClient,
  getFeed,
  zoneSensors,
  images,
  logger,
  confirmTimeoutMs = CONFIRM_TIMEOUT_MS,
  ptzWatchdogMs = PTZ_WATCHDOG_MS,
  dlinkTargetOf = async () => null,
  sendDlink = sendDlinkRequest,
  debounceMs,
  flushMs,
  now = Date.now,
}) {
  // Feature ids of the created devices, cached per gladys.devices array (the
  // SDK replaces the array on every change).
  let knownFor = null;
  let known = new Set();
  function knownIds() {
    if (knownFor !== gladys.devices) {
      knownFor = gladys.devices;
      known = new Set(
        (gladys.devices ?? []).flatMap((device) =>
          (device.features ?? []).map((feature) => feature.external_id),
        ),
      );
    }
    return known;
  }
  const createdCameras = () =>
    (gladys.devices ?? []).map((device) => cameraNameOfDevice(gladys, device)).filter(Boolean);

  const mapper = createStateMapper({ gladys, getCapabilities, zoneSensors });
  const states = createStatePublisher({
    publish: (batch) => gladys.publishStates(batch),
    isKnown: (id) => knownIds().has(id),
    logger,
    flushMs,
    now,
  });
  const transports = createTransportTracker({ gladys, createdCameras, logger, debounceMs });
  const waiters = new Set(); // { camera, setting, on, resolve }
  const cameraEnabled = new Map(); // camera -> last `enabled` state
  let stats = { at: 0, promise: null };
  const watchdogs = new Map(); // camera -> timer of the automatic STOP

  /** The feed, when commands can reach Frigate through it. */
  function connectedFeed() {
    const feed = getFeed();
    if (feed?.status.state !== 'connected') {
      throw new CommandError(
        'The real-time feed is not connected: the command cannot reach Frigate',
      );
    }
    return feed;
  }

  async function sendPtz(feed, camera, payload) {
    try {
      await feed.publish(ptzTopic(camera), payload);
    } catch (err) {
      throw new CommandError(`The command could not be sent: ${err.message}`);
    }
  }

  /** STOP sent outside a command (watchdog, shutdown): failures are logged. */
  function stopNow(camera) {
    const feed = getFeed();
    if (feed?.status.state !== 'connected') {
      logger.warn(`Could not stop the movement of ${camera}: the real-time feed is not connected`);
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => feed.publish(ptzTopic(camera), PTZ_STOP))
      .catch((err) => logger.warn(`Could not stop the movement of ${camera}: ${err.message}`));
  }

  /** Clears the watchdog of a camera; true when a move was pending. */
  function disarm(camera) {
    const timer = watchdogs.get(camera);
    clearTimeout(timer);
    watchdogs.delete(camera);
    return timer !== undefined;
  }

  function arm(camera) {
    disarm(camera);
    const timer = setTimeout(() => {
      watchdogs.delete(camera);
      stopNow(camera);
    }, ptzWatchdogMs);
    timer.unref?.();
    watchdogs.set(camera, timer);
  }

  async function move(camera, value) {
    const payload = ptzPayloadForMove(value);
    if (!payload) {
      throw new CommandError(`${value} is not a camera movement`);
    }
    const feed = connectedFeed();
    // Armed before sending: a move that reached Frigate while its publish
    // reported an error still gets its STOP.
    if (payload === PTZ_STOP) disarm(camera);
    else arm(camera);
    await sendPtz(feed, camera, payload);
  }

  /** The preset names of a device: its param, else the last Frigate read. */
  function presetNames(device, camera) {
    const stored =
      presetsOfDevice(device) ??
      presetsOfDevice((gladys.devices ?? []).find((d) => d.external_id === device?.external_id));
    if (stored) {
      return stored;
    }
    const known = getCapabilities()?.cameras.find((c) => c.name === camera);
    return known?.ptz?.presets ?? [];
  }

  async function recallPreset(device, camera, value) {
    const index = Number(value);
    const name =
      Number.isInteger(index) && index >= 1 ? presetNames(device, camera)[index - 1] : null;
    if (!name) {
      throw new CommandError(`Preset ${value} is unknown on ${camera}`);
    }
    const feed = connectedFeed();
    // A pending watchdog STOP would cut the way to the preset short: stop
    // the move now instead, then go.
    if (disarm(camera)) {
      await sendPtz(feed, camera, PTZ_STOP);
    }
    await sendPtz(feed, camera, ptzPayloadForPreset(name));
  }

  /** The control protocol of a device: its param, else the created device's. */
  function controlOf(device) {
    return (
      controlOfDevice(device) ??
      controlOfDevice((gladys.devices ?? []).find((d) => d.external_id === device?.external_id))
    );
  }

  /** A D-Link failure as the reason shown to the user (never a credential). */
  function dlinkCommandError(camera, err) {
    if (err instanceof DlinkCredentialsError) {
      return new CommandError(
        `${camera}: control credentials (admin account) missing: edit the camera (Cameras button) and enter its admin account as control user and password`,
      );
    }
    if (err instanceof DlinkHttpError) {
      return new CommandError(
        err.status === 401 || err.status === 403
          ? `${camera} refused the control account: pan/tilt and night mode need the camera admin account (edit the camera)`
          : `${camera} answered HTTP ${err.status} to the command`,
      );
    }
    return new CommandError(`${camera} does not answer: ${err.message}`);
  }

  async function toDlink(camera, request) {
    let target;
    try {
      target = await dlinkTargetOf(camera);
    } catch (err) {
      throw new CommandError(`The managed cameras cannot be read: ${err.message}`);
    }
    if (!target) {
      throw new CommandError(
        `The D-Link controls of ${camera} are only available in managed mode, for a D-Link camera added from Gladys`,
      );
    }
    if (!target.host) {
      throw new CommandError(`The address of ${camera} is missing: edit the camera`);
    }
    try {
      await sendDlink(target, request);
    } catch (err) {
      throw dlinkCommandError(camera, err);
    }
  }

  async function dlinkMove(camera, value) {
    const payload = ptzPayloadForMove(value);
    if (!payload) {
      throw new CommandError(`${value} is not a camera movement`);
    }
    // A step ends by itself: the release of a pad button has nothing to stop.
    if (payload === PTZ_STOP) return;
    const number = Number(value);
    if (number === CAMERA_MOVE.ZOOM_IN || number === CAMERA_MOVE.ZOOM_OUT) {
      throw new CommandError('zoom is not available on this camera');
    }
    await toDlink(camera, dlinkMoveRequest(number));
  }

  async function dlinkNightMode(camera, featureId, value) {
    const on = Number(value) === 1;
    await toDlink(camera, dlinkNightModeRequest(on));
    states.set([{ id: featureId, value: on ? 1 : 0 }]);
  }

  function confirm(message) {
    for (const waiter of waiters) {
      if (
        waiter.camera === message.camera &&
        waiter.setting === message.setting &&
        waiter.on === message.on
      ) {
        waiter.resolve();
      }
    }
  }

  function waitForState(camera, setting, on) {
    return new Promise((resolve, reject) => {
      const waiter = { camera, setting, on, resolve: null };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new CommandError(
            getFeed()?.mode === 'websocket'
              ? 'Frigate did not confirm the change: without an MQTT broker, commands need an admin Frigate account'
              : 'Frigate did not confirm the change in time',
          ),
        );
      }, confirmTimeoutMs);
      waiter.resolve = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve();
      };
      waiters.add(waiter);
    });
  }

  /** Frigate 0.16: camera fps from /api/stats (shared, at most every 30 s). */
  async function checkHealth() {
    const capabilities = getCapabilities();
    const client = getClient();
    if (!capabilities || capabilities.topics.cameraStatus || !client) {
      return;
    }
    if (!stats.promise || now() - stats.at > STATS_MAX_AGE_MS) {
      // One read (and at most one warning) for all the cameras polled.
      stats = {
        at: now(),
        promise: client.getStats().catch((err) => {
          logger.warn(`Could not read the Frigate stats: ${err.message}`);
          return null;
        }),
      };
    }
    const data = await stats.promise;
    if (!data) {
      return;
    }
    for (const camera of capabilities.cameras) {
      const entry = data?.cameras?.[camera.name] ?? data?.[camera.name];
      const fps = Number(entry?.camera_fps);
      const disabled = cameraEnabled.get(camera.name) === false || camera.enabled === false;
      transports.setCameraHealth(camera.name, disabled || fps > 0);
    }
  }

  return {
    /** A typed message of the real-time feed. */
    handleMessage(message) {
      states.set(mapper.map(message));
      switch (message.type) {
        case 'setting':
          if (message.setting === 'enabled') cameraEnabled.set(message.camera, message.on);
          confirm(message);
          break;
        case 'cameraStatus':
          transports.setCameraStatus(message.camera, message.role, message.state);
          break;
        case 'available':
          transports.setFrigateOnline(message.online);
          break;
        default:
      }
    },

    /** The feed state changed; a new connection resends every state. */
    feedStatus({ state }) {
      transports.setFeed(state);
      if (state === 'connected') {
        states.forget();
      }
    },

    /** Frigate keeps dropping its broker connection (or stopped doing so). */
    frigateFlapping(flapping) {
      transports.setFrigateFlapping(flapping);
    },

    /** The HTTP read of Frigate succeeded or failed. */
    frigateUp(up) {
      transports.setFrigateUp(up);
    },

    /** Gladys (re)connected: it may have restarted, resend everything. */
    gladysConnected() {
      states.forget();
      transports.forget();
    },

    async deviceCreated(device) {
      states.republish();
      transports.refresh();
      await images.pushImage(device);
    },

    async poll(device) {
      // A camera turned off (in Frigate or Gladys) has no image to show:
      // Gladys would refuse it anyway.
      if (cameraEnabled.get(cameraNameOfDevice(gladys, device)) !== false) {
        await images.pushImage(device);
      }
      await checkHealth();
    },

    /** onSetValue: a Frigate toggle, a PTZ move or a preset, a D-Link control. */
    async setValue(device, feature, value) {
      const parsed = parseFeatureId(gladys, feature?.external_id);
      if (parsed?.key === FEATURES.NIGHT_MODE) {
        // Only D-Link HTTP cameras have this switch.
        return dlinkNightMode(parsed.camera, feature.external_id, value);
      }
      if (parsed?.key === FEATURES.MOVE) {
        return controlOf(device) === CONTROL_PROTOCOLS.DLINK_HTTP
          ? dlinkMove(parsed.camera, value)
          : move(parsed.camera, value);
      }
      if (parsed?.key === FEATURES.PRESET) {
        return recallPreset(device, parsed.camera, value);
      }
      const setting = parsed && TOGGLES[parsed.key];
      if (!setting) {
        throw new CommandError(`${feature?.external_id} cannot be changed`);
      }
      const feed = connectedFeed();
      const on = Number(value) === 1;
      const confirmed = waitForState(parsed.camera, setting, on);
      try {
        await feed.publish(`${parsed.camera}/${setting}/set`, on ? 'ON' : 'OFF');
      } catch (err) {
        confirmed.catch(() => {});
        throw new CommandError(`The command could not be sent: ${err.message}`);
      }
      await confirmed;
    },

    /**
     * Stops the timers; a camera still moving gets its STOP at once (the
     * watchdog would not outlive the process). Resolves once sent.
     */
    close() {
      states.close();
      transports.close();
      const moving = [...watchdogs.keys()];
      moving.forEach(disarm);
      return Promise.all(moving.map(stopNow));
    },

    // Exposed for the tests.
    states,
    transports,
  };
}
