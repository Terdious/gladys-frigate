// The managed-mode flow of the session (src/gladys/frigateSession.js +
// src/gladys/managed.js): container state in the status, start / stop /
// restart buttons, admin bootstrap, hardware grants. Gladys and the Frigate
// client are in-memory fakes; the files go to a temporary data folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { normalizeConfig } from '../src/config.js';
import { UnreachableError } from '../src/frigate/errors.js';
import { MANAGED_TEXT, createManagedFrigate } from '../src/gladys/managed.js';
import { createFrigateSession } from '../src/gladys/frigateSession.js';
import { FRIGATE_CONFIG } from './helpers/fakeFrigate.js';
import { waitFor } from './helpers/waitFor.js';

const MANAGED = { mode: 'managed' };

/** Gladys' side of the sub-container, as GET /container and the start/stop routes. */
function fakeGladys(initial = {}) {
  const calls = [];
  const statuses = [];
  let starts = 0;
  const frigate = {
    name: 'frigate',
    status: 'stopped',
    desired: 'stopped',
    started_at: null,
    ports: [
      { container_port: 8971, name: 'frigate_ui', host_port: null },
      { container_port: 8554, name: 'frigate_rtsp', host_port: null },
    ],
    devices: [
      { class: 'coral-usb', granted: false, available: false },
      { class: 'coral-pcie', granted: false, available: false },
      { class: 'gpu', granted: false, available: false },
    ],
    ...initial,
  };
  const run = () => {
    starts += 1;
    frigate.status = 'running';
    frigate.desired = 'running';
    frigate.started_at = `2026-01-01T00:00:0${starts}.000Z`;
    frigate.ports[0].host_port ??= 42115;
    frigate.ports[1].host_port ??= 42116;
  };
  return {
    frigate,
    calls,
    statuses,
    async setConnectionStatus(connected, message) {
      statuses.push({ connected, message });
    },
    async getContainers() {
      calls.push(['getContainers']);
      return [structuredClone(frigate)];
    },
    async startContainer(name, options) {
      calls.push(['start', name, options]);
      run();
      return { success: true };
    },
    async stopContainer(name) {
      calls.push(['stop', name]);
      Object.assign(frigate, { status: 'stopped', desired: 'stopped', started_at: null });
      return { success: true };
    },
    async restartContainer(name) {
      calls.push(['restart', name]);
      run();
      return { success: true };
    },
  };
}

/** A Frigate client answering only when `frigate.up` is true. */
function fakeClients(frigate) {
  const created = [];
  const factory = (options) => {
    const client = {
      options,
      authMode: 'none',
      tlsDecision: null,
      async getVersion() {
        if (!frigate.up) throw new UnreachableError('ECONNREFUSED');
        return '0.18.0';
      },
      async getConfig() {
        return FRIGATE_CONFIG;
      },
      async getStats() {
        return {
          service: { storage: { '/media/frigate/recordings': { total: 10240, used: 1024 } } },
        };
      },
      async close() {},
    };
    created.push(client);
    return client;
  };
  factory.created = created;
  return factory;
}

function feedFactory() {
  const feed = new EventEmitter();
  feed.mode = 'websocket';
  feed.endpoint = 'ws://frigate:5000/ws';
  feed.status = { state: 'connected', error: null };
  feed.close = async () => {};
  return feed;
}

async function setup(t, { container, now, managedMaxPolls = 60, adminStatus = () => 200 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-frigate-managed-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const gladys = fakeGladys(container);
  const frigate = { up: false };
  const adminCalls = [];
  const logs = [];
  const logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
  const managed = createManagedFrigate({
    gladys,
    logger,
    dataDir,
    passwordFactory: () => 'Generated-Admin-Pw-24chars',
    adminOptions: {
      wait: async () => {},
      fetchImpl: async (url, init) => {
        adminCalls.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: adminStatus() < 300, status: adminStatus(), body: null };
      },
    },
  });
  const containers = [];
  const clientFactory = fakeClients(frigate);
  const session = createFrigateSession({
    gladys,
    trustStore: { async reset() {} },
    logger,
    clientFactory,
    feedFactory,
    managed,
    managedPollMs: 5,
    managedMaxPolls,
    retryDelayMs: 60_000,
    onContainer: (entry) => containers.push(entry),
    ...(now ? { now } : {}),
  });
  t.after(() => session.close());
  const apply = (raw = MANAGED) => session.apply(normalizeConfig(raw), raw);
  const last = () => gladys.statuses.at(-1);
  const configPath = join(dataDir, 'containers', 'frigate', 'config', 'config.yml');
  return {
    session,
    gladys,
    frigate,
    adminCalls,
    logs,
    apply,
    last,
    dataDir,
    configPath,
    containers,
    clientFactory,
  };
}

test('managed: the connection is derived, and the first save starts Frigate', async (t) => {
  const { apply, last, clientFactory, gladys, logs } = await setup(t);
  await apply();
  const { options } = clientFactory.created.at(-1);
  assert.equal(options.url, 'http://frigate:5000');
  assert.equal(options.username, '');
  assert.equal(options.password, '');
  // Choosing the managed mode installs Frigate: no second gesture needed.
  assert.deepEqual(
    gladys.calls.filter(([verb]) => verb === 'start'),
    [['start', 'frigate', { env: {} }]],
  );
  assert.ok(logs.some((line) => /starting Frigate for the first time/.test(line)));
  await waitFor(() => last()?.message?.en === MANAGED_TEXT.STARTING.en, { what: 'starting' });
  assert.doesNotMatch(last().message.en, /5000/, 'no "port 5000" warning in managed mode');
  // Saving again (or Gladys reconnecting) does not start it twice.
  await apply();
  assert.equal(gladys.calls.filter(([verb]) => verb === 'start').length, 1);
});

test('managed: no URL nor account is required', async (t) => {
  const { apply, last } = await setup(t);
  await apply({ mode: 'managed', frigate_url: '', username: 'only-user' });
  await waitFor(() => last()?.message?.en === MANAGED_TEXT.STARTING.en, { what: 'starting' });
});

test('managed: a Frigate stopped on purpose is not started again by a save', async (t) => {
  const { session, apply, last, gladys, frigate } = await setup(t);
  await apply();
  frigate.up = true;
  await waitFor(() => last()?.connected === true, { what: 'connected' });
  await session.stopFrigate();
  assert.deepEqual(last(), { connected: false, message: MANAGED_TEXT.STOPPED });
  const starts = gladys.calls.filter(([verb]) => verb === 'start').length;
  await apply({ ...MANAGED, record_alerts_days: 3 });
  assert.equal(gladys.calls.filter(([verb]) => verb === 'start').length, starts);
  assert.deepEqual(last().message, MANAGED_TEXT.STOPPED);
});

test('managed: a Gladys without the sub-container says so', async (t) => {
  const { apply, last, gladys } = await setup(t);
  gladys.getContainers = async () => [];
  await apply();
  assert.deepEqual(last().message, MANAGED_TEXT.UNSUPPORTED);
});

test('managed: Start generates config.yml, starts, polls, connects and sets the admin password', async (t) => {
  const { session, apply, last, gladys, frigate, adminCalls, configPath, containers, logs } =
    await setup(t);
  await apply();
  const answer = await session.startFrigate();
  assert.match(answer.en, /Frigate is starting/);
  assert.match(answer.en, /Detector: CPU\./);
  assert.match(answer.en, /CPU detection only/);
  const start = gladys.calls.find(([verb]) => verb === 'start');
  assert.deepEqual(start, ['start', 'frigate', { env: {} }]);
  const config = parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.mqtt, { enabled: false });
  assert.deepEqual(config.detectors, { cpu0: { type: 'cpu' } });
  assert.deepEqual(config.cameras, {});

  await waitFor(() => last()?.message?.en === MANAGED_TEXT.STARTING.en, { what: 'starting' });
  frigate.up = true;
  await waitFor(() => last()?.connected === true, { what: 'connected' });
  assert.match(
    last().message.en,
    /Connected to Frigate 0\.18\.0 \(installed by Gladys\), 2 cameras/,
  );
  assert.equal(containers.at(-1).ports[1].host_port, 42116, 'the RTSP host port reaches index.js');

  await waitFor(() => adminCalls.length === 1, { what: 'the admin bootstrap' });
  assert.equal(adminCalls[0].url, 'http://frigate:5000/api/users/admin/password');
  const credentials = await session.showCredentials();
  assert.match(credentials.en, /https:\/\/<address of Gladys>:42115/);
  assert.match(credentials.en, /User: admin\. Password: Generated-Admin-Pw-24chars/);
  assert.match(credentials.fr, /Mot de passe : Generated-Admin-Pw-24chars/);
  assert.ok(!logs.some((line) => line.includes('Generated-Admin-Pw')), 'never logged');

  // Applying again (Gladys reconnected) neither resets nor restarts it.
  const before = gladys.calls.filter(([verb]) => verb === 'restart' || verb === 'start').length;
  await apply();
  await waitFor(() => last()?.connected === true, { what: 'connected again' });
  assert.equal(
    gladys.calls.filter(([verb]) => verb === 'restart' || verb === 'start').length,
    before,
  );
  await session.showCredentials();
  assert.equal(adminCalls.length, 1, 'the password is set once');
});

test('managed: Stop stops the container and says so', async (t) => {
  const { session, apply, last, gladys, frigate } = await setup(t);
  await apply();
  frigate.up = true;
  await session.startFrigate();
  await waitFor(() => last()?.connected === true, { what: 'connected' });
  const answer = await session.stopFrigate();
  assert.match(answer.en, /Frigate stopped/);
  assert.ok(gladys.calls.some(([verb]) => verb === 'stop'));
  assert.deepEqual(last(), { connected: false, message: MANAGED_TEXT.STOPPED });
  // Seen again later (Gladys restarted): stopped, not "not started yet".
  await session.apply(normalizeConfig(MANAGED), MANAGED);
  assert.deepEqual(last().message, MANAGED_TEXT.STOPPED);
});

test('managed: a container that does not stay up is reported', async (t) => {
  let time = 1_000_000;
  const { apply, last } = await setup(t, {
    container: { desired: 'running', status: 'stopped' },
    now: () => time,
  });
  await apply();
  assert.equal(last().message.en, MANAGED_TEXT.WAITING.en);
  time += 120_000;
  await waitFor(() => last()?.message?.en === MANAGED_TEXT.CRASH_LOOP.en, { what: 'crash loop' });
  assert.match(last().message.fr, /bac à sable/);
});

test('managed: restarts seen through started_at are a crash loop too', async (t) => {
  const { apply, last, gladys } = await setup(t, {
    container: { desired: 'running', status: 'running', started_at: 't0' },
  });
  await apply();
  for (const startedAt of ['t1', 't2', 't3']) {
    gladys.frigate.started_at = startedAt;
    await waitFor(() => gladys.calls.filter(([v]) => v === 'getContainers').length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await waitFor(() => last()?.message?.en === MANAGED_TEXT.CRASH_LOOP.en, { what: 'crash loop' });
});

test('managed: a running container whose Frigate never answers is reported, bounded', async (t) => {
  const { apply, last } = await setup(t, {
    container: { desired: 'running', status: 'running', started_at: 't0' },
    managedMaxPolls: 3,
  });
  await apply();
  await waitFor(() => /has not answered/.test(last()?.message?.en ?? ''), {
    what: 'not answering',
  });
  assert.match(last().message.fr, /Redémarrer Frigate/);
});

test('managed: hardware grants change the detector and restart a running Frigate', async (t) => {
  const { session, apply, last, gladys, frigate, configPath } = await setup(t);
  await apply();
  frigate.up = true;
  await session.startFrigate();
  await waitFor(() => last()?.connected === true, { what: 'connected' });
  const devices = [
    { class: 'coral-usb', granted: true, available: true },
    { class: 'gpu', granted: true, available: true },
  ];
  gladys.frigate.devices = devices;
  await session.hardwareUpdated([{ name: 'frigate', devices }]);
  const config = parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(config.detectors, { coral: { type: 'edgetpu', device: 'usb' } });
  assert.deepEqual(config.ffmpeg, { hwaccel_args: 'preset-vaapi' });
  assert.ok(
    gladys.calls.some(([verb]) => verb === 'restart'),
    'restarted (same environment)',
  );
  await waitFor(() => /Detector: Coral USB, video decoding VAAPI/.test(last()?.message?.en ?? ''), {
    what: 'the new detector in the status',
  });
});

test('managed: the broker password goes through the environment; a change restarts Frigate', async (t) => {
  const { session, apply, last, gladys, frigate, configPath } = await setup(t);
  const raw = {
    mode: 'managed',
    mqtt_host: '192.168.1.5',
    mqtt_username: 'frigate',
    mqtt_password: 'Broker-Secret',
  };
  await apply(raw);
  frigate.up = true;
  await session.startFrigate();
  const start = gladys.calls.find(([verb]) => verb === 'start');
  assert.deepEqual(start[2], { env: { FRIGATE_MQTT_PASSWORD: 'Broker-Secret' } });
  const file = await readFile(configPath, 'utf8');
  assert.ok(!file.includes('Broker-Secret'), 'never in config.yml');
  assert.equal(parse(file).mqtt.password, '{FRIGATE_MQTT_PASSWORD}');
  await waitFor(() => last()?.connected === true, { what: 'connected' });

  // Saving a new broker password: restarted through start (new environment).
  const starts = gladys.calls.filter(([verb]) => verb === 'start').length;
  await apply({ ...raw, mqtt_password: 'New-Secret' });
  const calls = gladys.calls.filter(([verb]) => verb === 'start');
  assert.equal(calls.length, starts + 1);
  assert.deepEqual(calls.at(-1)[2], { env: { FRIGATE_MQTT_PASSWORD: 'New-Secret' } });
});

test('managed: a retention saved in Gladys restarts Frigate with the new config.yml', async (t) => {
  const { session, apply, last, gladys, frigate, configPath } = await setup(t);
  await apply();
  frigate.up = true;
  await session.startFrigate();
  await waitFor(() => last()?.connected === true, { what: 'connected' });
  await apply({ mode: 'managed', record_continuous_days: 10 });
  assert.equal(parse(await readFile(configPath, 'utf8')).record.continuous.days, 10);
  assert.ok(gladys.calls.some(([verb]) => verb === 'restart'));
});

test('managed: Test the connection describes the container, detector, retention and storage', async (t) => {
  const { session, apply, last, frigate } = await setup(t);
  await apply();
  frigate.up = true;
  await session.startFrigate();
  await waitFor(() => last()?.connected === true, { what: 'connected' });
  const answer = await session.testConnection();
  assert.match(answer.en, /Frigate container: running \(wanted: running\)/);
  assert.match(answer.en, /Detector: CPU/);
  assert.match(answer.en, /Retention: continuous 2 d, alerts 7 d, detections 7 d, snapshots 14 d/);
  assert.match(answer.en, /Recordings: 1\.0 GB used of 10\.0 GB/);
  assert.match(answer.en, /internal port/);
  // The fake Frigate has 2 cameras, detected on the CPU.
  assert.match(
    answer.en,
    /Resources: 2 cameras: recommended shm 320 MB \(limit 512\), RAM 2048 MB \(limit 4096\)\./,
  );
  assert.match(answer.fr, /Ressources : 2 caméras : shm conseillée 320 Mo/);
});

test('remote mode: the managed buttons refuse, and no container is read', async (t) => {
  const { session, gladys } = await setup(t);
  const raw = { frigate_url: 'https://192.168.1.10:8971', username: 'u', password: 'p' };
  await session.apply(normalizeConfig(raw), raw);
  for (const action of ['startFrigate', 'stopFrigate', 'restartFrigate', 'showCredentials']) {
    assert.deepEqual(await session[action](), MANAGED_TEXT.ONLY_MANAGED, action);
  }
  await session.hardwareUpdated([{ name: 'frigate', devices: [] }]);
  assert.deepEqual(gladys.calls, []);
});
