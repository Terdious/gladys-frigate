// -----------------------------------------------------------------------------
// Lifecycle of the connection to Frigate, as Gladys sees it.
//
//   - apply(config): validate the configuration, (re)create the HTTP client,
//     read the version and the cameras (and the PTZ capabilities of the
//     ONVIF ones), publish the connection status
//     (connected, or why not, plus the security warnings). A network failure
//     is retried every minute; a refused certificate, refused credentials or
//     an unsupported version wait for the user instead (looping would only
//     hit Frigate's login rate limit or hide a real problem).
//   - The three manifest action buttons: test_connection, refresh_cameras,
//     reset_certificate.
//   - onConnected(capabilities) runs after every successful read of Frigate
//     (index.js publishes the discovery list with it).
//   - The real-time feed (milestone 3): once Frigate has been read, the MQTT
//     broker (or the Frigate WebSocket without a broker) is followed; its
//     messages are typed (src/frigate/topics.js), turned into transitions
//     (src/frigate/eventEngine.js) handed to onTransition, and its state is
//     part of the connection status. When Frigate announces it is back
//     online, its configuration is read again (cameras may have changed),
//     at most once per minute.
//   - MQTT retains no object count: when the feed connects and when Frigate
//     is back online, the current objects are read once over the Frigate
//     WebSocket (`camera_activity`), so a count lost meanwhile (an object
//     that left) does not leave a presence stuck.
//   - A Frigate dropping its broker connection again and again (three
//     "offline" within five minutes) is reported: its messages are lost,
//     and the usual cause is another MQTT client using its client_id.
//   - Managed mode (Frigate as the `frigate` sub-container, ./managed.js):
//     the connection is derived (http://frigate:5000, no account, no TLS),
//     and the state of the sub-container drives the status — not started,
//     stopped, starting (polled every 5 s, a bounded number of times, until
//     Frigate answers /api/version), not staying up — before the usual read
//     of Frigate. Once Frigate answers, its admin password is set (once).
//     Saving the configuration regenerates config.yml and restarts a running
//     Frigate only when its file or environment changed. The remote mode
//     path is unchanged.
//
// Thin adapter: the Frigate logic lives in src/frigate/.
// -----------------------------------------------------------------------------

import { configWarnings, isManaged, usesMqtt } from '../config.js';
import { readCapabilities, readPtzCapabilities } from '../frigate/capabilities.js';
import { HttpStatusError, UnreachableError } from '../frigate/errors.js';
import { createEventEngine } from '../frigate/eventEngine.js';
import { createFrigateClient } from '../frigate/httpClient.js';
import { createMqttFeed } from '../frigate/mqttClient.js';
import { probeMqtt } from '../frigate/mqttProbe.js';
import { parseMessage } from '../frigate/topics.js';
import { createWsFeed, readCameraActivity } from '../frigate/wsClient.js';
import { adviceSentence, resourceAdvice } from '../frigate/managed/advice.js';
import {
  MANAGED_TEXT,
  describeDetector,
  describeManagedError,
  describeRetention,
  describeStorage,
  notAnswering,
} from './managed.js';
import { describeAuth, describeError, describeFeed, describeTls } from './messages.js';
import { composeMessage, describeConfig } from './status.js';

const RETRY_DELAY_MS = 60_000;
const RESYNC_DELAY_MS = 60_000;
const FLAP_WINDOW_MS = 5 * 60_000;
const FLAP_COUNT = 3;
const FLAPPING = {
  en: 'Frigate keeps dropping its MQTT connection: its messages are lost. Another MQTT client probably uses its client_id (mqtt.client_id, "frigate" by default).',
  fr: 'Frigate perd sans cesse sa connexion MQTT : ses messages sont perdus. Un autre client MQTT utilise sans doute son client_id (mqtt.client_id, « frigate » par défaut).',
};
const UNSAVED_PINS = {
  en: 'The pinned certificates cannot be saved in /data: after a restart, the next connection trusts again the certificate it is served.',
  fr: 'Les certificats épinglés ne peuvent pas être enregistrés dans /data : après un redémarrage, la connexion suivante approuve de nouveau le certificat présenté.',
};
const MAX_LISTED_CAMERAS = 10;
// Managed mode: how often the sub-container is polled while Frigate starts,
// how many times before saying it does not answer (then every retryDelayMs).
const MANAGED_POLL_MS = 5_000;
const MANAGED_MAX_POLLS = 60;
// A sub-container restarted this many times within the window, or wanted
// running but down for that long, "does not stay up".
const CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_DOWN_MS = 90_000;

const isTransient = (err) =>
  err instanceof UnreachableError || (err instanceof HttpStatusError && err.status >= 500);

function cameraList(capabilities) {
  const names = capabilities.cameras.map((camera) => camera.friendlyName);
  const shown = names.slice(0, MAX_LISTED_CAMERAS).join(', ');
  return names.length > MAX_LISTED_CAMERAS ? `${shown}…` : shown;
}

function cameraSummary(capabilities) {
  const count = capabilities.cameras.length;
  if (count === 0) {
    return { en: 'no camera', fr: 'aucune caméra' };
  }
  const list = cameraList(capabilities);
  return {
    en: `${count} camera${count > 1 ? 's' : ''} (${list})`,
    fr: `${count} caméra${count > 1 ? 's' : ''} (${list})`,
  };
}

/** "First sentence. Second sentence." in both languages, no length cap. */
function sentences(parts) {
  const kept = parts.filter(Boolean);
  return {
    en: kept.map((part) => part.en).join(' '),
    fr: kept.map((part) => part.fr).join(' '),
  };
}

/** MQTT when a broker is configured, else the Frigate WebSocket. */
export function createFeed({ config, client, trustStore }) {
  if (!usesMqtt(config)) {
    return createWsFeed({ client });
  }
  return createMqttFeed({
    host: config.mqtt_host,
    port: config.mqtt_port,
    username: config.mqtt_username,
    password: config.mqtt_password,
    tls: config.mqtt_tls,
    trustStore,
    manualFingerprint: config.tls_fingerprint,
    ca: config.tls_ca,
    prefix: config.mqtt_topic_prefix,
  });
}

/**
 * @param {object} options
 * @param {{ setConnectionStatus: Function }} options.gladys
 * @param {import('../frigate/tlsTrust.js').TrustStore} options.trustStore loaded
 * @param {{ info: Function, warn: Function }} options.logger
 * @param {Function} [options.clientFactory] createFrigateClient (tests)
 * @param {Function} [options.mqttCheck] probeMqtt (tests)
 * @param {number} [options.retryDelayMs]
 * @param {(capabilities: object) => Promise} [options.onConnected]
 * @param {Function} [options.feedFactory] createFeed (tests)
 * @param {(transition: object) => void} [options.onTransition] eventEngine output
 * @param {(message: object) => void} [options.onMessage] every typed message
 * @param {(topic: string, payload: unknown) => void} [options.onRawMessage] every
 *   message of the feed as received, before typing (the debug buffer)
 * @param {(status: { state: string, error: Error | null }) => void} [options.onFeedStatus]
 * @param {(up: boolean) => void} [options.onFrigateStatus] HTTP read result
 * @param {(flapping: boolean) => void} [options.onFrigateFlapping]
 * @param {Function} [options.activityReader] readCameraActivity (tests)
 * @param {number} [options.resyncDelayMs] minimum delay between two re-reads
 * @param {() => number} [options.now]
 * @param {ReturnType<import('./managed.js').createManagedFrigate> | null} [options.managed]
 *   the managed-mode adapter (null: the managed mode is refused)
 * @param {number} [options.managedPollMs]
 * @param {number} [options.managedMaxPolls]
 * @param {(container: object | null) => void} [options.onContainer] every read
 *   of the Frigate sub-container (managed mode)
 */
export function createFrigateSession({
  gladys,
  trustStore,
  logger,
  clientFactory = createFrigateClient,
  mqttCheck = probeMqtt,
  retryDelayMs = RETRY_DELAY_MS,
  onConnected = async () => {},
  feedFactory = createFeed,
  onTransition = () => {},
  onMessage = () => {},
  onRawMessage = () => {},
  onFeedStatus = () => {},
  onFrigateStatus = () => {},
  onFrigateFlapping = () => {},
  activityReader = readCameraActivity,
  resyncDelayMs = RESYNC_DELAY_MS,
  now = Date.now,
  managed = null,
  managedPollMs = MANAGED_POLL_MS,
  managedMaxPolls = MANAGED_MAX_POLLS,
  onContainer = () => {},
}) {
  let config = null;
  let raw = {};
  let client = null;
  let capabilities = null;
  let retryTimer = null;
  // Bumped on every apply(): a slow check of an older configuration must
  // not overwrite the status of the current one.
  let generation = 0;
  let feed = null;
  let frigateOnline = null; // last `available` of Frigate, null = unknown
  let known = { cameras: new Set(), zones: new Set() };
  let engine = createEventEngine();
  let lastStatus = null;
  let lastRead = 0; // time of the last successful read of Frigate
  let resyncTimer = null;
  let offlineTimes = []; // "offline" announcements within FLAP_WINDOW_MS
  let flapping = false;
  let flapTimer = null;
  let activityError = null; // last camera_activity failure logged
  // Managed mode.
  let watchTimer = null;
  let watchPolls = 0; // reads of the sub-container while Frigate does not answer
  let container = null; // last `frigate` entry of GET /container
  let tracker = newTracker();
  let adminDone = false;
  let adminError = null;

  function newTracker() {
    return { startedAt: null, restarts: [], downSince: null };
  }

  /**
   * The state of the sub-container, and whether it fails to stay up: Gladys
   * restarts a container wanted running that exits (with a backoff), so a
   * crash shows as a new `started_at`, or as a long time down.
   * @returns {'unsupported' | 'stopped' | 'waiting' | 'running'}
   */
  function track(entry) {
    if (!entry) {
      return 'unsupported';
    }
    const time = now();
    const running = entry.status === 'running';
    const wanted = entry.desired === 'running';
    if (running) {
      if (tracker.startedAt && entry.started_at && entry.started_at !== tracker.startedAt) {
        tracker.restarts.push(time);
      }
      tracker.startedAt = entry.started_at ?? tracker.startedAt;
      tracker.downSince = null;
    } else if (wanted) {
      tracker.downSince ??= time;
    } else {
      tracker.downSince = null;
    }
    tracker.restarts = tracker.restarts.filter((at) => time - at < CRASH_WINDOW_MS);
    if (running) return 'running';
    return wanted ? 'waiting' : 'stopped';
  }

  function crashLooping() {
    return (
      tracker.restarts.length >= CRASH_RESTARTS ||
      (tracker.downSince != null && now() - tracker.downSince >= CRASH_DOWN_MS)
    );
  }
  let lastPtz = new Map(); // camera -> last PTZ capabilities read (same Frigate URL)

  /** Publishes the status, unless it is the one already shown. */
  function setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === lastStatus) {
      return Promise.resolve();
    }
    lastStatus = key;
    return gladys.setConnectionStatus(connected, message).catch((err) => {
      lastStatus = null;
      logger.warn(`Could not report the connection status: ${err.message}`);
    });
  }

  /** Status while Frigate answers: connected unless the feed gave up. */
  function publishConnected() {
    if (!capabilities) {
      return Promise.resolve();
    }
    return setStatus(feed?.status.state !== 'failed', connectedMessage());
  }

  function setFlapping(value) {
    if (flapping === value) {
      return;
    }
    flapping = value;
    if (value) {
      logger.warn(FLAPPING.en);
    } else {
      logger.info('Frigate keeps its MQTT connection again');
    }
    onFrigateFlapping(value);
    publishConnected();
  }

  function stopFlapping() {
    clearTimeout(flapTimer);
    flapTimer = null;
    offlineTimes = [];
    setFlapping(false);
  }

  /** Frigate's LWT fired (its broker connection dropped) while ours holds. */
  function noteOffline() {
    const time = now();
    offlineTimes = offlineTimes.filter((at) => time - at < FLAP_WINDOW_MS);
    offlineTimes.push(time);
    if (offlineTimes.length >= FLAP_COUNT) {
      setFlapping(true);
    }
    // Five quiet minutes end it.
    clearTimeout(flapTimer);
    flapTimer = setTimeout(stopFlapping, FLAP_WINDOW_MS);
    flapTimer.unref?.();
  }

  /** The current objects of every camera, over the Frigate WebSocket (MQTT mode). */
  async function refreshActivity(currentGeneration) {
    if (!capabilities || !client || feed?.mode !== 'mqtt') {
      return;
    }
    try {
      const cameras = await activityReader({ client });
      if (currentGeneration === generation) {
        activityError = null;
        route('camera_activity', cameras);
      }
    } catch (err) {
      if (activityError !== err.message) {
        activityError = err.message;
        logger.warn(`Could not read the current objects from Frigate: ${err.message}`);
      }
    }
  }

  /** Read Frigate again, at most once per resyncDelayMs (Frigate may flap). */
  function resync() {
    if (resyncTimer) {
      return;
    }
    const currentGeneration = generation;
    const run = () => {
      resyncTimer = null;
      if (currentGeneration !== generation) {
        return;
      }
      check(currentGeneration)
        .then(() => refreshActivity(currentGeneration))
        .catch(() => {});
    };
    const wait = lastRead + resyncDelayMs - now();
    if (wait <= 0) {
      run();
      return;
    }
    resyncTimer = setTimeout(run, wait);
    resyncTimer.unref?.();
  }

  function route(topic, payload) {
    const message = parseMessage(topic, payload, known);
    if (!message) {
      return;
    }
    if (message.type === 'available') {
      const wasOffline = frigateOnline === false;
      if (frigateOnline !== message.online) {
        frigateOnline = message.online;
        // While it flaps, one line per drop would flood the logs.
        if (!flapping) {
          logger.info(`Frigate announces it is ${message.state}`);
        }
        // "stopped" (0.18) is a clean stop; "offline" is the broker's LWT.
        if (message.state === 'offline' && feed?.status.state === 'connected') {
          noteOffline();
        }
        publishConnected();
      }
      if (message.online && wasOffline) {
        // Back from a restart: its configuration may have changed, and the
        // counts published while it was away are lost.
        resync();
      }
    }
    for (const transition of engine.handle(message)) {
      onTransition(transition);
    }
    onMessage(message);
  }

  function startFeed(currentGeneration) {
    if (feed || currentGeneration !== generation || !client) {
      return;
    }
    frigateOnline = null;
    const created = feedFactory({ config, client, trustStore });
    feed = created;
    logger.info(`Real-time feed: ${created.mode} (${created.endpoint})`);
    created.on('status', (status) => {
      if (feed !== created) {
        return;
      }
      const { state, error } = status;
      const log = state === 'connected' || state === 'connecting' ? 'info' : 'warn';
      logger[log](`Real-time feed ${state}${error ? `: ${error.message}` : ''}`);
      onFeedStatus(status);
      publishConnected();
      if (state === 'connected') {
        // MQTT retains no object count: read the current ones.
        refreshActivity(currentGeneration);
      } else if (error && isManaged(config) && feed?.mode === 'websocket' && !watchTimer) {
        // The WebSocket of a managed Frigate dropped: the sub-container may
        // have stopped. Its state says so sooner than the next retry.
        scheduleWatch(currentGeneration, managedPollMs);
      }
    });
    onFeedStatus(created.status);
    created.on('message', (topic, payload) => {
      if (feed === created) {
        // A tap only: whatever it does, the message is routed.
        try {
          onRawMessage(topic, payload);
        } catch (err) {
          logger.debug?.(`Could not record a real-time message: ${err.message}`);
        }
        route(topic, payload);
      }
    });
  }

  async function stopFeed() {
    const old = feed;
    feed = null;
    frigateOnline = null;
    clearTimeout(resyncTimer);
    resyncTimer = null;
    stopFlapping();
    if (old) {
      onFeedStatus({ state: null, error: null });
    }
    await old?.close();
  }

  async function replaceClient() {
    await stopFeed();
    await client?.close();
    client = clientFactory({
      url: config.frigate_url,
      username: config.username,
      password: config.password,
      trustStore,
      tlsFingerprint: config.tls_fingerprint,
      tlsCa: config.tls_ca,
    });
  }

  async function readFrigate() {
    const version = await client.getVersion();
    const frigateConfig = await client.getConfig();
    const result = readCapabilities(version, frigateConfig);
    // A failed PTZ read is not a Frigate failure: the camera keeps its
    // other features (and the pad found by an earlier read, if any).
    await readPtzCapabilities(result, (camera) => client.getPtzInfo(camera), {
      previous: lastPtz,
      onError: (camera, err) =>
        logger.debug?.(`Could not read the PTZ capabilities of ${camera}: ${err.message}`),
    });
    for (const camera of result.cameras) {
      if (camera.ptz) lastPtz.set(camera.name, camera.ptz);
      else lastPtz.delete(camera.name);
    }
    return result;
  }

  /** The managed-mode sentences of the connected status. */
  function managedParts() {
    if (!isManaged(config)) {
      return [];
    }
    const parts = [];
    if (capabilities.cameras.length === 0) {
      parts.push({
        en: 'Add your cameras in the Frigate UI ("Show the Frigate credentials" gives its address and login).',
        fr: "Ajoutez vos caméras dans l'interface Frigate (« Afficher les identifiants Frigate » donne son adresse et l'identifiant).",
      });
    }
    parts.push(...describeDetector(managed?.decision, managed?.lastWrite ?? {}));
    if (adminError) {
      parts.push(MANAGED_TEXT.ADMIN_PENDING);
    }
    return parts;
  }

  function connectedMessage() {
    const { version } = capabilities;
    const summary = cameraSummary(capabilities);
    const where = isManaged(config)
      ? { en: ' (installed by Gladys)', fr: ' (installé par Gladys)' }
      : { en: '', fr: '' };
    return composeMessage([
      {
        en: `Connected to Frigate ${version.raw}${where.en}, ${summary.en}.`,
        fr: `Connecté à Frigate ${version.raw}${where.fr}, ${summary.fr}.`,
      },
      // While it flaps, "offline" would change the status every few seconds.
      feed ? describeFeed(feed, flapping ? null : frigateOnline) : null,
      flapping ? FLAPPING : null,
      ...managedParts(),
      ...configWarnings(config),
      trustStore.saveError ? UNSAVED_PINS : null,
    ]);
  }

  /** Read Frigate and publish the status; schedules a retry on a transient failure. */
  async function check(currentGeneration) {
    clearTimeout(retryTimer);
    try {
      const result = await readFrigate();
      if (currentGeneration !== generation) {
        return;
      }
      capabilities = result;
      lastRead = now();
      known = {
        cameras: new Set(result.cameras.map((camera) => camera.name)),
        zones: new Set(result.cameras.flatMap((camera) => camera.zones.map((zone) => zone.name))),
      };
      engine.setCameras(result.cameras);
      logger.info(
        `Connected to Frigate ${capabilities.version.raw} (${capabilities.cameras.length} cameras)`,
      );
      startFeed(currentGeneration);
      onFrigateStatus(true);
      if (isManaged(config)) {
        bootstrapAdmin(currentGeneration);
      }
      await publishConnected();
    } catch (err) {
      if (currentGeneration !== generation) {
        return;
      }
      capabilities = null;
      onFrigateStatus(false);
      logger.warn(`Frigate is not available: ${err.message}`);
      await setStatus(false, composeMessage([describeError(err), ...configWarnings(config)]));
      if (isTransient(err)) {
        // Managed: the sub-container may be the reason, read its state.
        const retry = isManaged(config) ? watchManaged : check;
        retryTimer = setTimeout(() => retry(currentGeneration).catch(() => {}), retryDelayMs);
        retryTimer.unref?.();
      }
      throw err;
    }
    // Outside the try: a failure here is not a Frigate failure.
    await onConnected(capabilities).catch((err) =>
      logger.warn(`Could not publish the Frigate cameras to Gladys: ${err.message}`),
    );
  }

  /** Frigate no longer answers (managed): forget what was read of it. */
  async function markDown() {
    clearTimeout(retryTimer);
    if (capabilities) {
      capabilities = null;
      await stopFeed();
    }
    onFrigateStatus(false);
  }

  function scheduleWatch(currentGeneration, delayMs) {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => watchManaged(currentGeneration).catch(() => {}), delayMs);
    watchTimer.unref?.();
  }

  /** Set the Frigate admin password once, in the background. */
  function bootstrapAdmin(currentGeneration) {
    if (adminDone || !managed) {
      return;
    }
    managed
      .ensureAdmin()
      .then(() => {
        adminDone = true;
        if (adminError) {
          adminError = null;
          if (currentGeneration === generation) publishConnected();
        }
      })
      .catch((err) => {
        logger.warn(`Could not set the Frigate admin password yet: ${err.message}`);
        adminError = err;
        if (currentGeneration === generation) publishConnected();
      });
  }

  /**
   * Managed mode: read the state of the sub-container, publish it, and read
   * Frigate once it answers. Polls while Frigate starts.
   */
  async function watchManaged(currentGeneration) {
    clearTimeout(watchTimer);
    watchTimer = null;
    if (currentGeneration !== generation || !managed || !client) {
      return;
    }
    let entry;
    try {
      entry = await managed.container();
    } catch (err) {
      if (currentGeneration !== generation) return;
      logger.warn(`Could not read the state of the Frigate container: ${err.message}`);
      await markDown();
      await setStatus(false, composeMessage([describeManagedError(err)]));
      scheduleWatch(currentGeneration, retryDelayMs);
      return;
    }
    if (currentGeneration !== generation) return;
    container = entry;
    onContainer(entry);
    const state = track(entry);
    if (state === 'unsupported' || state === 'stopped') {
      await markDown();
      watchPolls = 0;
      let message = MANAGED_TEXT.UNSUPPORTED;
      if (state === 'stopped') {
        message = (await managed.everStarted()) ? MANAGED_TEXT.STOPPED : MANAGED_TEXT.NOT_STARTED;
      }
      await setStatus(false, composeMessage([message, ...configWarnings(config)]));
      return;
    }
    // Whatever happened before, a Frigate that answers is connected.
    if (state === 'running') {
      let up = false;
      try {
        await client.getVersion();
        up = true;
      } catch {
        // Not answering yet: starting.
      }
      if (currentGeneration !== generation) return;
      if (up) {
        watchPolls = 0;
        await check(currentGeneration).catch(() => {});
        return;
      }
    }
    await markDown();
    watchPolls += 1;
    let message = state === 'running' ? MANAGED_TEXT.STARTING : MANAGED_TEXT.WAITING;
    if (crashLooping()) {
      message = MANAGED_TEXT.CRASH_LOOP;
    } else if (watchPolls >= managedMaxPolls) {
      message = notAnswering(Math.max(1, Math.round((managedMaxPolls * managedPollMs) / 60_000)));
    }
    await setStatus(false, composeMessage([message, ...configWarnings(config)]));
    scheduleWatch(currentGeneration, watchPolls >= managedMaxPolls ? retryDelayMs : managedPollMs);
  }

  /**
   * A deliberate gesture (start, stop, restart, new hardware) opens a new
   * phase: a watch or a read still running from before must not publish
   * its outdated status over the new one.
   */
  function newPhase() {
    generation += 1;
    clearTimeout(watchTimer);
    clearTimeout(retryTimer);
  }

  /** Start watching afresh after a deliberate gesture (start, restart…). */
  function restartWatch() {
    newPhase();
    tracker = newTracker();
    watchPolls = 0;
    const currentGeneration = generation;
    // Not awaited: the button answers at once, the status follows.
    watchManaged(currentGeneration).catch(() => {});
  }

  /** The managed-mode buttons refuse to run in remote mode. */
  function managedGuard() {
    if (!isManaged(config) || !managed) {
      return MANAGED_TEXT.ONLY_MANAGED;
    }
    if (!client) {
      return invalidConfigAnswer();
    }
    return null;
  }

  async function checkMqtt() {
    const what = {
      en: `MQTT broker ${config.mqtt_host}:${config.mqtt_port}`,
      fr: `Broker MQTT ${config.mqtt_host}:${config.mqtt_port}`,
    };
    try {
      const { tlsDecision } = await mqttCheck({
        host: config.mqtt_host,
        port: config.mqtt_port,
        username: config.mqtt_username,
        password: config.mqtt_password,
        tls: config.mqtt_tls,
        trustStore,
        manualFingerprint: config.tls_fingerprint,
        ca: config.tls_ca,
      });
      const tls = config.mqtt_tls ? describeTls(tlsDecision) : null;
      return {
        en: `${what.en}: connected${tls ? `, certificate ${tls.en}` : ''}.`,
        fr: `${what.fr} : connecté${tls ? `, certificat ${tls.fr}` : ''}.`,
      };
    } catch (err) {
      return describeError(err, what);
    }
  }

  function invalidConfigAnswer() {
    return describeConfig(config ?? {}, raw).message;
  }

  return {
    /**
     * @param {ReturnType<import('../config.js').normalizeConfig>} newConfig
     * @param {Record<string, unknown>} rawConfig
     */
    async apply(newConfig, rawConfig = {}) {
      generation += 1;
      const currentGeneration = generation;
      clearTimeout(retryTimer);
      if (config?.frigate_url !== newConfig.frigate_url) {
        // Another Frigate: what the old one knew of its cameras is moot.
        lastPtz = new Map();
      }
      config = newConfig;
      raw = rawConfig;
      capabilities = null;
      // Gladys may have restarted: show the status again even if unchanged.
      lastStatus = null;
      engine = createEventEngine({
        minScore: config.min_score,
        cooldownSeconds: config.trigger_cooldown,
      });
      clearTimeout(watchTimer);
      if (isManaged(config)) {
        if (!managed) {
          await stopFeed();
          await client?.close();
          client = null;
          await setStatus(false, MANAGED_TEXT.UNSUPPORTED);
          return;
        }
        // Frigate's internal port, on the private network: no account, no TLS.
        config = { ...config, frigate_url: managed.url, username: '', password: '' };
      }
      const { valid, message } = describeConfig(config, raw);
      if (!valid) {
        await stopFeed();
        await client?.close();
        client = null;
        logger.warn(message.en);
        await setStatus(false, message);
        return;
      }
      await replaceClient();
      if (!isManaged(config)) {
        await check(currentGeneration).catch(() => {});
        return;
      }
      tracker = newTracker();
      watchPolls = 0;
      try {
        // A running Frigate gets the saved settings (restarted only when its
        // config.yml or environment changed).
        await managed.refresh(config, raw);
      } catch (err) {
        logger.warn(`Could not apply the configuration to Frigate: ${err.message}`);
        await setStatus(false, composeMessage([describeManagedError(err)]));
        return;
      }
      await watchManaged(currentGeneration);
    },

    /** The last capabilities read (null while not connected). */
    get capabilities() {
      return capabilities;
    },

    /** The Frigate HTTP client while connected, else null. */
    get client() {
      return capabilities ? client : null;
    },

    /**
     * The capabilities, reading Frigate once more when not connected (a scan
     * asked while Frigate was down). Null when Frigate still fails.
     */
    async ensureConnected() {
      if (capabilities || !client) {
        return capabilities;
      }
      await check(generation).catch(() => {});
      return capabilities;
    },

    /** "Test the connection": Frigate, its certificate and account, the broker. */
    async testConnection() {
      if (!client) {
        return invalidConfigAnswer();
      }
      const parts = [];
      const managedMode = isManaged(config) && managed;
      if (managedMode) {
        try {
          const entry = await managed.container();
          container = entry;
          onContainer(entry);
          const inspected = await managed.inspect(config, raw, entry);
          const state = entry
            ? {
                en: `Frigate container: ${entry.status} (wanted: ${entry.desired ?? 'unknown'}).`,
                fr: `Conteneur Frigate : ${entry.status} (souhaité : ${entry.desired ?? 'inconnu'}).`,
              }
            : MANAGED_TEXT.UNSUPPORTED;
          parts.push(
            state,
            ...describeDetector(inspected.decision, inspected),
            describeRetention(inspected.retention),
          );
        } catch (err) {
          parts.push(describeManagedError(err));
        }
      }
      // A feed stopped on a refused certificate or account: try it again
      // (the user may have fixed the broker, or trusted the certificate).
      if (feed?.status.state === 'failed') {
        await stopFeed();
      }
      try {
        await check(generation);
        parts.push(
          {
            en: `Frigate ${capabilities.version.raw}: ${cameraSummary(capabilities).en}.`,
            fr: `Frigate ${capabilities.version.raw} : ${cameraSummary(capabilities).fr}.`,
          },
          managedMode
            ? {
                en: 'Reached on its internal port, on the private network of the integration (no account needed).',
                fr: "Joint sur son port interne, sur le réseau privé de l'intégration (aucun compte nécessaire).",
              }
            : (() => {
                const tls = describeTls(client.tlsDecision);
                const auth = describeAuth(client.authMode, config.username);
                return {
                  en: `Certificate: ${tls.en}. Account: ${auth.en}.`,
                  fr: `Certificat : ${tls.fr}. Compte : ${auth.fr}.`,
                };
              })(),
        );
        if (managedMode) {
          parts.push(describeStorage(await client.getStats().catch(() => null)));
          parts.push(
            adviceSentence(
              resourceAdvice({
                cameras: capabilities.cameras.length,
                detector: managed.decision?.kind,
              }),
            ),
          );
        }
      } catch (err) {
        parts.push(describeError(err));
      }
      parts.push(
        usesMqtt(config)
          ? await checkMqtt()
          : {
              en: 'No MQTT broker configured: the Frigate WebSocket will be used.',
              fr: 'Aucun broker MQTT configuré : le WebSocket de Frigate sera utilisé.',
            },
      );
      return sentences(parts);
    },

    /** "Refresh the cameras": read the Frigate configuration again. */
    async refreshCameras() {
      if (!client) {
        return invalidConfigAnswer();
      }
      try {
        await check(generation);
      } catch (err) {
        return describeError(err);
      }
      const summary = cameraSummary(capabilities);
      return {
        en: `Frigate configuration read again: ${summary.en}. The cameras are listed in the Discover tab.`,
        fr: `Configuration de Frigate relue : ${summary.fr}. Les caméras sont listées dans l'onglet Découverte.`,
      };
    },

    /**
     * "Trust the new certificate": forget the pinned certificates (Frigate
     * and broker), reconnect, and tell which certificate is now pinned.
     */
    async resetCertificate() {
      await trustStore.reset();
      logger.info('Pinned TLS certificates forgotten at the user request');
      if (!client) {
        return {
          en: 'Pinned certificates forgotten. Complete the configuration to connect.',
          fr: 'Certificats épinglés oubliés. Complétez la configuration pour vous connecter.',
        };
      }
      // Pooled connections were trusted under the old pins: start afresh.
      await replaceClient();
      const parts = [
        {
          en: 'Pinned certificates forgotten.',
          fr: 'Certificats épinglés oubliés.',
        },
      ];
      try {
        await check(generation);
        const decision = client.tlsDecision;
        parts.push(
          decision
            ? {
                en: `Frigate certificate: ${describeTls(decision).en}.`,
                fr: `Certificat de Frigate : ${describeTls(decision).fr}.`,
              }
            : {
                en: 'Frigate is reached over http: no certificate to pin.',
                fr: 'Frigate est joint en http : aucun certificat à épingler.',
              },
        );
      } catch (err) {
        parts.push(describeError(err));
      }
      if (usesMqtt(config) && config.mqtt_tls) {
        parts.push(await checkMqtt());
      }
      return sentences(parts);
    },

    /** "Start Frigate": generate config.yml, then start the sub-container. */
    async startFrigate() {
      const refused = managedGuard();
      if (refused) return refused;
      let result;
      try {
        result = await managed.start(config, raw);
      } catch (err) {
        logger.warn(`Could not start Frigate: ${err.message}`);
        return describeManagedError(err);
      }
      restartWatch();
      return sentences([
        {
          en: 'Frigate is starting: the connection status says when it answers (the first start can take a few minutes).',
          fr: 'Frigate démarre : le statut de connexion indique quand il répond (le premier démarrage peut prendre quelques minutes).',
        },
        ...describeDetector(result.decision, result),
        describeRetention(result.retention),
      ]);
    },

    /** "Stop Frigate": the supervisor will not restart it. */
    async stopFrigate() {
      const refused = managedGuard();
      if (refused) return refused;
      try {
        await managed.stop();
      } catch (err) {
        logger.warn(`Could not stop Frigate: ${err.message}`);
        return describeManagedError(err);
      }
      newPhase();
      await markDown();
      await setStatus(false, MANAGED_TEXT.STOPPED);
      return {
        en: 'Frigate stopped. Its recordings and configuration are kept.',
        fr: 'Frigate arrêté. Ses enregistrements et sa configuration sont conservés.',
      };
    },

    /** "Restart Frigate": regenerate config.yml, then restart the sub-container. */
    async restartFrigate() {
      const refused = managedGuard();
      if (refused) return refused;
      let result;
      try {
        result = await managed.restart(config, raw);
      } catch (err) {
        logger.warn(`Could not restart Frigate: ${err.message}`);
        return describeManagedError(err);
      }
      await markDown();
      restartWatch();
      return sentences([
        {
          en: `Frigate is restarting${result.changed ? ' with its updated configuration' : ''}: the connection status says when it answers.`,
          fr: `Frigate redémarre${result.changed ? ' avec sa configuration mise à jour' : ''} : le statut de connexion indique quand il répond.`,
        },
        ...describeDetector(result.decision, result),
      ]);
    },

    /** "Show the Frigate credentials": the UI address and the admin login. */
    async showCredentials() {
      const refused = managedGuard();
      if (refused) return refused;
      let entry = container;
      try {
        entry = await managed.container();
        container = entry;
      } catch {
        // The last known state is enough for the address.
      }
      return managed.credentials(entry);
    },

    /**
     * The user changed the hardware grants (Gladys recreated the
     * sub-container): new detector, restart if it runs.
     */
    async hardwareUpdated(containers) {
      if (!isManaged(config) || !managed || !client) {
        return;
      }
      try {
        const result = await managed.hardwareUpdated(config, raw, containers);
        logger.info(
          `Hardware grants changed: detector ${result.decision.kind}${result.restarted ? ', Frigate restarted' : ''}`,
        );
        if (result.restarted) {
          await markDown();
        }
      } catch (err) {
        logger.warn(`Could not apply the new hardware grants: ${err.message}`);
        await setStatus(false, composeMessage([describeManagedError(err)]));
        return;
      }
      restartWatch();
    },

    /** The last `frigate` entry of GET /container (managed mode), else null. */
    get container() {
      return container;
    },

    /** The configuration applied last (null before the first one). */
    get config() {
      return config;
    },

    /** The raw values of the configuration applied last. */
    get rawConfig() {
      return raw;
    },

    /** Frigate's last `available` announcement (null: unknown). */
    get frigateOnline() {
      return frigateOnline;
    },

    /** Frigate keeps dropping its broker connection. */
    get flapping() {
      return flapping;
    },

    /** The real-time feed (null before Frigate was read). */
    get feed() {
      return feed;
    },

    async close() {
      generation += 1;
      clearTimeout(retryTimer);
      clearTimeout(watchTimer);
      await stopFeed();
      await client?.close();
      client = null;
    },
  };
}
