import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readCapabilities } from '../src/frigate/capabilities.js';
import { CAMERA_MOVE } from '../src/frigate/ptz.js';
import { parseMessage } from '../src/frigate/topics.js';
import { CommandError, PTZ_WATCHDOG_MS, createDeviceSync } from '../src/gladys/deviceSync.js';
import { buildDevices } from '../src/gladys/discovery.js';
import { FRIGATE_CONFIG, FRIGATE_CONFIG_PTZ, FRONT_PTZ_INFO } from './helpers/fakeFrigate.js';
import { gladysIds } from './helpers/gladysIds.js';

const known = { cameras: new Set(['front', 'garage']), zones: new Set(['porch']) };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeFeed(mode = 'mqtt') {
  const feed = new EventEmitter();
  feed.mode = mode;
  feed.status = { state: 'connected', error: null };
  feed.published = [];
  feed.publish = async (topic, payload) => {
    feed.published.push([topic, payload]);
  };
  return feed;
}

function setup({
  version = '0.17.2',
  feed = fakeFeed(),
  stats,
  created = ['front'],
  capabilities = readCapabilities(version, FRIGATE_CONFIG),
} = {}) {
  const states = [];
  const transports = [];
  const pushed = [];
  let statsReads = 0;
  const gladys = {
    ...gladysIds,
    devices: buildDevices(gladysIds, capabilities).filter((device) =>
      created.includes(device.params[0].value),
    ),
    publishStates: async (batch) => states.push(...batch),
    publishTransports: async (batch) => transports.push(...batch),
  };
  const logs = [];
  const sync = createDeviceSync({
    gladys,
    getCapabilities: () => capabilities,
    getClient: () => ({
      getStats: async () => {
        statsReads += 1;
        return stats;
      },
    }),
    getFeed: () => feed,
    zoneSensors: () => false,
    images: { pushImage: async (device) => pushed.push(device.external_id) },
    logger: { info() {}, warn: (text) => logs.push(text) },
    confirmTimeoutMs: 50,
    debounceMs: 20,
    flushMs: 5,
  });
  const message = (topic, payload) => sync.handleMessage(parseMessage(topic, payload, known));
  return {
    sync,
    gladys,
    feed,
    states,
    transports,
    pushed,
    message,
    logs,
    statsReads: () => statsReads,
  };
}

const feature = (camera, key) => ({ external_id: `ext:frigate:camera:${camera}:${key}` });

test('a switch publishes <camera>/<setting>/set and resolves on Frigate confirmation', async (t) => {
  const { sync, feed, message } = setup();
  t.after(() => sync.close());
  const command = sync.setValue({}, feature('front', 'detect'), 0);
  await wait(5);
  assert.deepEqual(feed.published, [['front/detect/set', 'OFF']]);
  message('front/detect/state', 'OFF');
  await command;
  const enable = sync.setValue({}, feature('front', 'enabled'), 1);
  await wait(5);
  assert.deepEqual(feed.published.at(-1), ['front/enabled/set', 'ON']);
  message('front/enabled/state', 'ON');
  await enable;
});

test('commands fail clearly: no confirmation, no feed, not a switch', async (t) => {
  const ws = setup({ feed: fakeFeed('websocket') });
  t.after(() => ws.sync.close());
  await assert.rejects(
    ws.sync.setValue({}, feature('front', 'snapshots'), 1),
    /admin Frigate account/,
  );
  const mqtt = setup();
  t.after(() => mqtt.sync.close());
  mqtt.message('front/snapshots/state', 'OFF'); // the opposite value does not confirm
  await assert.rejects(mqtt.sync.setValue({}, feature('front', 'snapshots'), 1), /did not confirm/);
  mqtt.feed.status = { state: 'disconnected', error: null };
  await assert.rejects(mqtt.sync.setValue({}, feature('front', 'detect'), 1), /not connected/);
  await assert.rejects(mqtt.sync.setValue({}, feature('front', 'motion'), 1), CommandError);
  const failing = setup();
  t.after(() => failing.sync.close());
  failing.feed.publish = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    failing.sync.setValue({}, feature('front', 'detect'), 1),
    /could not be sent: offline/,
  );
});

test('states of created devices are published; a new device gets the latest ones', async (t) => {
  const { sync, gladys, states, pushed, message } = setup();
  t.after(() => sync.close());
  message('front/motion', 'ON');
  message('garage/motion', 'ON');
  await wait(20);
  assert.deepEqual(states, [
    { device_feature_external_id: 'ext:frigate:camera:front:motion', state: 1 },
  ]);
  gladys.devices = buildDevices(gladysIds, readCapabilities('0.17.2', FRIGATE_CONFIG));
  await sync.deviceCreated(gladys.devices[1]);
  await wait(20);
  assert.deepEqual(states.at(-1), {
    device_feature_external_id: 'ext:frigate:camera:garage:motion',
    state: 1,
  });
  assert.deepEqual(pushed, ['ext:frigate:camera:garage'], 'first image at once');
});

test('feed and camera status drive the transport badges', async (t) => {
  const { sync, transports, message } = setup();
  t.after(() => sync.close());
  sync.frigateUp(true);
  sync.feedStatus({ state: 'connected' });
  await wait(5);
  assert.equal(transports.at(-1).transport, 'local');
  message('front/status/detect', 'offline');
  await wait(40);
  assert.equal(transports.at(-1).transport, 'unreachable');
  sync.frigateUp(true);
  message('front/status/detect', 'online');
  await wait(5);
  assert.equal(transports.at(-1).transport, 'local');
  message('available', 'offline');
  await wait(5);
  assert.equal(transports.at(-1).transport, 'local', 'Frigate offline counts after the debounce');
  await wait(40);
  assert.equal(transports.at(-1).transport, 'unreachable');
  message('available', 'online');
  sync.frigateFlapping(true);
  await wait(5);
  assert.equal(transports.at(-1).degraded, true);
  assert.match(transports.at(-1).message.en, /keeps dropping its MQTT connection/);
});

test('Frigate 0.16: the camera fps of /api/stats tells a lost camera, read once for all', async (t) => {
  const stats = { cameras: { front: { camera_fps: 0 }, garage: { camera_fps: 5 } } };
  const { sync, gladys, transports, statsReads } = setup({ version: '0.16.4', stats });
  t.after(() => sync.close());
  sync.frigateUp(true);
  await sync.poll(gladys.devices[0]);
  await sync.poll(gladys.devices[0]);
  assert.equal(statsReads(), 1);
  await wait(40);
  assert.equal(transports.at(-1).transport, 'unreachable');
  // 0.17+: the status topics are used instead.
  const recent = setup({ stats });
  t.after(() => recent.sync.close());
  await recent.sync.poll(recent.gladys.devices[0]);
  assert.equal(recent.statsReads(), 0);
});

test('a camera turned off gets no image pushed on poll', async (t) => {
  const { sync, gladys, pushed, message } = setup();
  t.after(() => sync.close());
  await sync.poll(gladys.devices[0]);
  message('front/enabled/state', 'OFF');
  await sync.poll(gladys.devices[0]);
  message('front/enabled/state', 'ON');
  await sync.poll(gladys.devices[0]);
  assert.equal(pushed.length, 2);
});

/** The front camera on ONVIF, as Frigate reports it (pan, tilt, zoom, 2 presets). */
function ptzCapabilities() {
  const capabilities = readCapabilities('0.17.2', FRIGATE_CONFIG_PTZ);
  capabilities.cameras[0].ptz = structuredClone(FRONT_PTZ_INFO);
  return capabilities;
}

const PTZ_TOPIC = 'front/ptz';

test('a move publishes <camera>/ptz at once, without waiting for any state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sync, feed } = setup({ capabilities: ptzCapabilities() });
  t.after(() => sync.close());
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.PAN_LEFT);
  await sync.setValue({}, feature('front', 'move'), '5');
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.STOP);
  assert.deepEqual(feed.published, [
    [PTZ_TOPIC, 'MOVE_LEFT'],
    [PTZ_TOPIC, 'ZOOM_IN'],
    [PTZ_TOPIC, 'STOP'],
  ]);
  t.mock.timers.tick(PTZ_WATCHDOG_MS * 2);
  assert.equal(feed.published.length, 3, 'no automatic STOP after an explicit one');
});

test('the watchdog stops a move left without STOP after 1.5 s, re-armed by each move', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sync, feed } = setup({ capabilities: ptzCapabilities() });
  t.after(() => sync.close());
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.TILT_UP);
  t.mock.timers.tick(PTZ_WATCHDOG_MS - 100);
  assert.deepEqual(feed.published, [[PTZ_TOPIC, 'MOVE_UP']]);
  // A new direction re-arms the watchdog from now.
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.PAN_RIGHT);
  t.mock.timers.tick(PTZ_WATCHDOG_MS - 100);
  assert.equal(feed.published.length, 2);
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(feed.published, [
    [PTZ_TOPIC, 'MOVE_UP'],
    [PTZ_TOPIC, 'MOVE_RIGHT'],
    [PTZ_TOPIC, 'STOP'],
  ]);
});

test('a lost feed makes the watchdog STOP a logged failure, not a crash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sync, feed, logs } = setup({ capabilities: ptzCapabilities() });
  t.after(() => sync.close());
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.PAN_LEFT);
  feed.status = { state: 'disconnected', error: null };
  t.mock.timers.tick(PTZ_WATCHDOG_MS);
  await settle();
  assert.match(logs.at(-1), /Could not stop the movement of front/);
  feed.status = { state: 'connected', error: null };
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.PAN_LEFT);
  feed.publish = async () => {
    throw new Error('broker gone');
  };
  t.mock.timers.tick(PTZ_WATCHDOG_MS);
  await settle();
  assert.match(logs.at(-1), /Could not stop the movement of front: broker gone/);
});

test('a preset value maps back to its name: device param, else the Frigate read', async (t) => {
  const capabilities = ptzCapabilities();
  const { sync, feed, gladys } = setup({ capabilities });
  t.after(() => sync.close());
  const [device] = gladys.devices;
  await sync.setValue(device, feature('front', 'preset'), 2);
  assert.deepEqual(feed.published.at(-1), [PTZ_TOPIC, 'preset_Garden']);
  // Only the external id (Gladys sends a slim device): the created device.
  await sync.setValue({ external_id: device.external_id }, feature('front', 'preset'), '1');
  assert.deepEqual(feed.published.at(-1), [PTZ_TOPIC, 'preset_Entrance']);
  // Not created here at all: the last Frigate read.
  gladys.devices = [];
  await sync.setValue({}, feature('front', 'preset'), 1);
  assert.deepEqual(feed.published.at(-1), [PTZ_TOPIC, 'preset_Entrance']);
  // The param wins over a read whose order changed meanwhile.
  capabilities.cameras[0].ptz.presets = ['Garden', 'Entrance'];
  await sync.setValue(device, feature('front', 'preset'), 1);
  assert.deepEqual(feed.published.at(-1), [PTZ_TOPIC, 'preset_Entrance']);
});

test('a preset recalled during a move stops it first; the watchdog is disarmed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sync, feed, gladys } = setup({ capabilities: ptzCapabilities() });
  t.after(() => sync.close());
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.ZOOM_OUT);
  await sync.setValue(gladys.devices[0], feature('front', 'preset'), 1);
  t.mock.timers.tick(PTZ_WATCHDOG_MS * 2);
  await settle();
  assert.deepEqual(feed.published, [
    [PTZ_TOPIC, 'ZOOM_OUT'],
    [PTZ_TOPIC, 'STOP'],
    [PTZ_TOPIC, 'preset_Entrance'],
  ]);
});

test('PTZ commands fail clearly: unknown value, unknown preset, no feed, send error', async (t) => {
  const { sync, feed, gladys } = setup({ capabilities: ptzCapabilities() });
  t.after(() => sync.close());
  const [device] = gladys.devices;
  await assert.rejects(sync.setValue(device, feature('front', 'move'), 9), /not a camera movement/);
  await assert.rejects(
    sync.setValue(device, feature('front', 'preset'), 3),
    /Preset 3 is unknown on front/,
  );
  await assert.rejects(sync.setValue(device, feature('front', 'preset'), 0), CommandError);
  assert.deepEqual(feed.published, [], 'nothing reaches Frigate');
  feed.status = { state: 'disconnected', error: null };
  await assert.rejects(sync.setValue(device, feature('front', 'move'), 1), /not connected/);
  feed.status = { state: 'connected', error: null };
  feed.publish = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    sync.setValue(device, feature('front', 'preset'), 1),
    /could not be sent: offline/,
  );
});

test('the WebSocket feed carries the PTZ commands too (any Frigate role, 0.17+)', async (t) => {
  const { sync, feed } = setup({ feed: fakeFeed('websocket'), capabilities: ptzCapabilities() });
  t.after(() => sync.close());
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.TILT_DOWN);
  assert.deepEqual(feed.published, [[PTZ_TOPIC, 'MOVE_DOWN']]);
});

test('closing stops a camera still moving at once and clears its watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sync, feed } = setup({ capabilities: ptzCapabilities() });
  await sync.setValue({}, feature('front', 'move'), CAMERA_MOVE.PAN_LEFT);
  await sync.close();
  assert.deepEqual(feed.published, [
    [PTZ_TOPIC, 'MOVE_LEFT'],
    [PTZ_TOPIC, 'STOP'],
  ]);
  t.mock.timers.tick(PTZ_WATCHDOG_MS * 2);
  await settle();
  assert.equal(feed.published.length, 2);
});
