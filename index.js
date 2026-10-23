// -----------------------------------------------------------------------------
// Entry point of the Frigate external integration for Gladys Assistant.
//
// Wiring only: the Frigate client lives in src/frigate/ (no Gladys
// dependency), the Gladys adapter in src/gladys/. The SDK reads
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and GLADYS_INTEGRATION_SELECTOR
// from the environment injected by the Gladys supervisor.
// -----------------------------------------------------------------------------

import { join } from 'node:path';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { TrustStore } from './src/frigate/tlsTrust.js';
import { createDeviceSync } from './src/gladys/deviceSync.js';
import { cameraNameOfDevice, publishDiscovery } from './src/gladys/discovery.js';
import { createFrigateSession } from './src/gladys/frigateSession.js';
import { createCameraImages, createDeviceImages } from './src/gladys/images.js';
import { MANIFEST_ACTIONS, SCENE_ACTIONS } from './src/gladys/keys.js';
import { createManagedFrigate, rtspHostPort } from './src/gladys/managed.js';
import { resolveLiveRtsp } from './src/gladys/live.js';
import { describeTransition } from './src/gladys/messages.js';
import { createSceneEvents, createSnapshotAction } from './src/gladys/sceneEvents.js';

// /data is the only writable location of the container (see the Dockerfile);
// FRIGATE_DATA_DIR moves it for development and the end-to-end test.
const dataDir = process.env.FRIGATE_DATA_DIR || '/data';
const trustStore = new TrustStore({ filePath: join(dataDir, 'tls-trust.json'), logger });
const gladys = new GladysIntegration();
// The device side reads the session lazily (the arrows run after start-up).
const zoneSensors = () => session.config?.zone_sensors === true;
// Managed mode: Frigate as the `frigate` sub-container. FRIGATE_MANAGED_URL
// replaces its internal address (http://frigate:5000) for development and
// the end-to-end test only.
const managed = createManagedFrigate({
  gladys,
  logger,
  dataDir,
  ...(process.env.FRIGATE_MANAGED_URL ? { url: process.env.FRIGATE_MANAGED_URL } : {}),
});
// The host port Gladys assigned to the `frigate_rtsp` port of the Frigate
// sub-container, from the last `getContainers` read of the session (null
// before the first start, or in remote mode, which needs no port from Gladys).
const managedLiveHostPort = () => rtspHostPort(session.container);
let publishedLivePort = null;
// The live URL is resolved on every publication: Gladys upserts the params of
// already-created devices, so a new host or port reaches them.
const discover = (capabilities) =>
  publishDiscovery(gladys, capabilities, {
    zoneSensors: zoneSensors(),
    logger,
    liveRtsp: resolveLiveRtsp(session.config, { managedHostPort: managedLiveHostPort() }),
  });

const cameraImages = createCameraImages({
  getClient: () => session.client,
  publish: (externalId, image) => gladys.publishCameraImage(externalId, image),
});
const deviceImages = createDeviceImages({
  gladys,
  images: cameraImages,
  cameraOf: cameraNameOfDevice,
  isConnected: () => Boolean(session.client),
  logger,
});
const deviceSync = createDeviceSync({
  gladys,
  getCapabilities: () => session.capabilities,
  getClient: () => session.client,
  getFeed: () => session.feed,
  zoneSensors,
  images: deviceImages,
  logger,
});
const sceneEvents = createSceneEvents({
  gladys,
  logger,
  // The alert image first, for a scene that sends the camera image next.
  beforeAlert: async (camera) => {
    const device = gladys.devices.find((d) => cameraNameOfDevice(gladys, d) === camera);
    if (device) await deviceImages.pushImage(device);
  },
});
const session = createFrigateSession({
  gladys,
  trustStore,
  logger,
  managed,
  // The live URL of a managed Frigate needs the host port of its restream:
  // once Gladys assigns it, the discovery is published again so the
  // CAMERA_URL param reaches the devices already created.
  onContainer: (container) => {
    const port = rtspHostPort(container);
    if (port === publishedLivePort) return;
    publishedLivePort = port;
    if (session.capabilities) {
      discover(session.capabilities).catch((err) =>
        logger.warn(`Could not publish the Frigate cameras to Gladys: ${err.message}`),
      );
    }
  },
  // Every successful read of Frigate refreshes the Discover tab.
  onConnected: discover,
  onFrigateStatus: (up) => deviceSync.frigateUp(up),
  onFrigateFlapping: (flapping) => deviceSync.frigateFlapping(flapping),
  onFeedStatus: (status) => deviceSync.feedStatus(status),
  onMessage: (message) => deviceSync.handleMessage(message),
  onTransition: (transition) => {
    logger.info(describeTransition(transition));
    sceneEvents.handle(transition);
  },
  // The `source: "devices"` select of the camera buttons gives an external id.
  cameraOfDevice: (externalId) =>
    cameraNameOfDevice(
      gladys,
      gladys.devices.find((device) => device.external_id === externalId) ?? {
        external_id: externalId,
      },
    ),
});

const applyConfig = (raw = {}) => session.apply(normalizeConfig(raw), raw);

gladys.onConfigUpdated((raw) => applyConfig(raw));
gladys.on('connected', () => {
  deviceSync.gladysConnected();
  return applyConfig(gladys.config);
});

// Always answer a scan: an empty list ends it at once, and the connection
// status says why Frigate could not be read.
gladys.onScanRequest(async () => discover(await session.ensureConnected()));
// Gladys polls each camera device every minute: fresh image, camera health.
gladys.onPoll((device) => deviceSync.poll(device));
gladys.onDeviceCreated((device) => deviceSync.deviceCreated(device));
gladys.onGetImage((device) => deviceImages.captureImage(device));
gladys.onSetValue((device, feature, value) => deviceSync.setValue(device, feature, value));

gladys.onSceneAction(
  SCENE_ACTIONS.ATTACH_EVENT_SNAPSHOT,
  createSnapshotAction({ gladys, images: cameraImages, getClient: () => session.client }),
);

gladys.onAction(MANIFEST_ACTIONS.TEST_CONNECTION, () => session.testConnection());
gladys.onAction(MANIFEST_ACTIONS.REFRESH_CAMERAS, () => session.refreshCameras());
gladys.onAction(MANIFEST_ACTIONS.RESET_CERTIFICATE, () => session.resetCertificate());
gladys.onAction(MANIFEST_ACTIONS.START_FRIGATE, () => session.startFrigate());
gladys.onAction(MANIFEST_ACTIONS.STOP_FRIGATE, () => session.stopFrigate());
gladys.onAction(MANIFEST_ACTIONS.RESTART_FRIGATE, () => session.restartFrigate());
gladys.onAction(MANIFEST_ACTIONS.SHOW_CREDENTIALS, () => session.showCredentials());
gladys.onAction(MANIFEST_ACTIONS.CAMERA, (fields) => session.cameras(fields));
// The user changed the hardware grants of the sub-container: new detector.
gladys.onHardwareUpdated((containers) => session.hardwareUpdated(containers));

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  // Before the feed closes: a camera still moving gets its STOP.
  await deviceSync.close();
  await session.close();
  // A certificate pinned just before the stop must reach the disk.
  await trustStore.settled();
});

logger.info('Starting the Frigate integration...');
// The pins must be loaded before the first TLS connection: a store read
// before that would treat a pinned endpoint as a first use.
await trustStore.load();
gladys.connect().catch((err) => {
  logger.error('Initial connection to Gladys failed', err);
  process.exit(1);
});
