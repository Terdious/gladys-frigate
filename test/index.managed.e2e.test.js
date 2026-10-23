// End to end, managed mode: the real index.js against the fake Gladys (with
// its sub-container routes) and a fake Frigate standing for the `frigate`
// sub-container (FRIGATE_MANAGED_URL replaces http://frigate:5000). Catches
// a managed button or the hardware hook not wired, and checks the files
// written in the data folder and the live URL of a managed Frigate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startFakeFrigate } from './helpers/fakeFrigate.js';
import { startFakeGladys } from './helpers/fakeGladys.js';
import { waitFor } from './helpers/waitFor.js';

const WAIT = { timeoutMs: 15_000 };

const FRIGATE_CONTAINER = {
  name: 'frigate',
  status: 'stopped',
  desired: 'stopped',
  started_at: null,
  ports: [
    { container_port: 8971, protocol: 'tcp', host_port: null, name: 'frigate_ui', browsable: true },
    {
      container_port: 8554,
      protocol: 'tcp',
      host_port: null,
      name: 'frigate_rtsp',
      browsable: false,
    },
  ],
  devices: [
    { class: 'coral-usb', granted: false, available: false },
    { class: 'coral-pcie', granted: false, available: false },
    { class: 'gpu', granted: false, available: false },
  ],
};

test('index.js, managed mode: start, connect, admin, live URL, hardware, stop', async (t) => {
  // Port 5000 of Frigate: no account.
  const frigate = await startFakeFrigate({ account: null, version: '0.18.0-abcdef' });
  t.after(() => frigate.close());
  const gladys = await startFakeGladys({
    config: { mode: 'managed' },
    containers: [FRIGATE_CONTAINER],
  });
  t.after(() => gladys.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-frigate-managed-e2e-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));

  const child = spawn(process.execPath, ['index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      GLADYS_HOST_API_URL: gladys.url,
      GLADYS_INTEGRATION_TOKEN: 'test-token',
      GLADYS_INTEGRATION_SELECTOR: 'frigate',
      FRIGATE_DATA_DIR: dataDir,
      FRIGATE_MANAGED_URL: frigate.url,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => child.kill('SIGKILL'));
  const step = async (what, condition) => {
    try {
      await waitFor(condition, { ...WAIT, what });
    } catch (err) {
      throw new Error(`${err.message}\n--- integration output ---\n${output}`, { cause: err });
    }
  };
  const lastStatus = () => gladys.posts('/connection_status').at(-1)?.body;
  const action = async (key) => {
    const result = await gladys.command('action.run', { key, fields: {} }, 15_000);
    assert.equal(result.success, true, `${key}: ${result.error}`);
    return result.data.message;
  };

  // 1. The managed mode saved for the first time starts Frigate by itself:
  //    config.yml generated in the sub-container volume, then started.
  await step('the first start', () => gladys.posts('/container/frigate/start').length === 1);
  assert.deepEqual(gladys.posts('/container/frigate/start')[0].body, { env: {} });

  // 2. The Start button works too (a stopped Frigate, or a second try).
  const started = await action('start_frigate');
  assert.match(started.en, /Frigate is starting/);
  const config = parse(
    await readFile(join(dataDir, 'containers', 'frigate', 'config', 'config.yml'), 'utf8'),
  );
  assert.deepEqual(config.detectors, { cpu0: { type: 'cpu' } });
  assert.deepEqual(config.mqtt, { enabled: false });

  // 3. Connected over the internal port; the real-time feed is the WebSocket.
  //    Read once the status settles: the second start goes through
  //    "starting…" again before reconnecting.
  const connectedStatus = () => {
    const status = lastStatus();
    return status?.connected === true && /Frigate WebSocket connected/.test(status.message?.en)
      ? status
      : null;
  };
  await step('the connected status', () => connectedStatus() !== null);
  assert.match(connectedStatus().message.en, /installed by Gladys/);

  // 4. The live URL uses the host port Gladys assigned to the RTSP restream.
  const rtspPort = gladys.containers[0].ports[1].host_port;
  const liveUrls = () =>
    (gladys.posts('/discovered_device').at(-1)?.body.devices ?? []).map(
      (device) => device.params.find((param) => param.name === 'CAMERA_URL')?.value,
    );
  await step('the managed live URL', () =>
    liveUrls().includes(`rtsp://127.0.0.1:${rtspPort}/front`),
  );

  // 5. The admin password, set once, shown by the button, never logged.
  await step('the admin bootstrap', () => frigate.adminPasswords.length === 1);
  const [password] = frigate.adminPasswords;
  const credentials = await action('show_credentials');
  assert.ok(credentials.en.includes(password));
  assert.match(credentials.en, new RegExp(`:${gladys.containers[0].ports[0].host_port}`));

  // 6. A Coral granted: new detector, Frigate restarted.
  const coral = [{ class: 'coral-usb', granted: true, available: true }];
  gladys.setContainer('frigate', { devices: coral });
  gladys.send('hardware-updated', { containers: [{ name: 'frigate', devices: coral }] });
  await step(
    'the restart after the hardware change',
    () => gladys.posts('/container/frigate/restart').length === 1,
  );
  const updated = parse(
    await readFile(join(dataDir, 'containers', 'frigate', 'config', 'config.yml'), 'utf8'),
  );
  assert.deepEqual(updated.detectors, { coral: { type: 'edgetpu', device: 'usb' } });

  // 7. Stop.
  const stopped = await action('stop_frigate');
  assert.match(stopped.en, /Frigate stopped/);
  assert.equal(gladys.posts('/container/frigate/stop').length, 1);
  assert.match(lastStatus().message.en, /stopped/);

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(!output.includes(password), 'the admin password is never logged');
});

test('index.js, managed mode: the Cameras button adds, lists, edits and removes a camera', async (t) => {
  const frigate = await startFakeFrigate({ account: null, version: '0.18.0-abcdef' });
  t.after(() => frigate.close());
  const gladys = await startFakeGladys({
    config: { mode: 'managed' },
    containers: [structuredClone(FRIGATE_CONTAINER)],
  });
  t.after(() => gladys.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-frigate-cameras-e2e-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5 }));

  const child = spawn(process.execPath, ['index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      GLADYS_HOST_API_URL: gladys.url,
      GLADYS_INTEGRATION_TOKEN: 'test-token',
      GLADYS_INTEGRATION_SELECTOR: 'frigate',
      FRIGATE_DATA_DIR: dataDir,
      FRIGATE_MANAGED_URL: frigate.url,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => child.kill('SIGKILL'));
  const step = async (what, condition) => {
    try {
      await waitFor(condition, { ...WAIT, what });
    } catch (err) {
      throw new Error(`${err.message}\n--- integration output ---\n${output}`, { cause: err });
    }
  };
  const lastStatus = () => gladys.posts('/connection_status').at(-1)?.body;
  const action = async (key, fields = {}) => {
    const result = await gladys.command('action.run', { key, fields }, 15_000);
    assert.equal(result.success, true, `${key}: ${result.error}`);
    return result.data.message;
  };
  const configFile = async () =>
    parse(await readFile(join(dataDir, 'containers', 'frigate', 'config', 'config.yml'), 'utf8'));
  const restarts = () => gladys.posts('/container/frigate/restart').length;

  // The first save of the managed mode starts Frigate.
  await step('the first start', () => gladys.posts('/container/frigate/start').length === 1);
  await step('connected', () => lastStatus()?.connected === true);

  // Add: stored, config.yml regenerated, Frigate restarted.
  const added = await action('camera', {
    operation: 'add',
    label: 'Driveway',
    model: 'reolink-rtsp',
    host: '192.168.1.40',
    username: 'admin',
    password: 'Reo-Secret!1',
    objects: 'person, car',
    detect_fps: 5,
  });
  assert.match(added.en, /Camera "Driveway" \(driveway\) added to Frigate/);
  assert.match(added.en, /h264Preview_01_main/);
  assert.equal(restarts(), 1);
  const config = await configFile();
  assert.deepEqual(config.go2rtc.streams.driveway, [
    'rtsp://admin:Reo-Secret!1@192.168.1.40:554/h264Preview_01_main',
  ]);
  assert.deepEqual(config.cameras.driveway.onvif, {
    host: '192.168.1.40',
    port: 8000,
    user: 'admin',
    password: 'Reo-Secret!1',
  });
  await step('connected again after the restart', () => lastStatus()?.connected === true);

  const listed = await action('camera', { operation: 'list' });
  assert.match(listed.en, /^Cameras added from Gladys \(1\):\n- "Driveway" \(driveway\)/);

  // Edit through the device select, then remove by the typed Frigate name.
  const edited = await action('camera', {
    operation: 'edit',
    camera: 'ext:frigate:camera:driveway',
    objects: 'person',
  });
  assert.match(edited.en, /Camera "Driveway" \(driveway\) updated/);
  assert.deepEqual((await configFile()).cameras.driveway.objects.track, ['person']);
  assert.equal(restarts(), 2);

  const removed = await action('camera', { operation: 'remove', name: 'driveway' });
  assert.match(removed.en, /removed from Frigate/);
  assert.equal((await configFile()).cameras.driveway, undefined);
  assert.equal(restarts(), 3);

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(!output.includes('Reo-Secret'), 'the camera password is never logged');
});
