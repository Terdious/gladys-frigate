// The troubleshooting buttons (src/gladys/diagnostics.js): the report on a
// remote and a managed fixture, the debug answer, the catalog proposal.
// Everything is in memory (fake session, fake Frigate client, temporary data
// folder for the managed files): no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../src/config.js';
import { readCapabilities } from '../src/frigate/capabilities.js';
import { MAX_REPORT_LINES } from '../src/frigate/diagnostics.js';
import { TRUST_REASONS } from '../src/frigate/tlsTrust.js';
import { createDiagnostics } from '../src/gladys/diagnostics.js';
import { createManagedFrigate } from '../src/gladys/managed.js';
import { FRIGATE_CONFIG } from './helpers/fakeFrigate.js';

const NOW = Date.parse('2026-10-23T14:02:11Z');
const FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0').toUpperCase(),
).join(':');
const SECRETS = ['S3cret', 'MqttPw!', 'AdminPw-123', 'jwt.token.value'];

const STATS = {
  cameras: {
    front: { camera_fps: 5, detection_fps: 1.25, skipped_fps: 0, process_fps: 5 },
    garage: { camera_fps: 0, detection_fps: 0, skipped_fps: 0 },
  },
  detectors: {
    coral: { inference_speed: 9.81, detection_start: 0, pid: 101 },
    cpu1: { inference_speed: 95.3, detection_start: NOW / 1000 - 30, pid: 102 },
  },
  service: {
    uptime: 7200,
    storage: {
      '/media/frigate/recordings': { total: 10240, used: 1024, free: 9216 },
      '/tmp/cache': { total: 1000, used: 12.4 },
      '/dev/shm': { total: 512, used: 130.2 },
    },
  },
};

function fakeClient({ tlsDecision = null } = {}) {
  return {
    authMode: 'token',
    tlsDecision,
    async getStats() {
      return STATS;
    },
    async getConfig() {
      return {
        ...FRIGATE_CONFIG,
        detectors: { coral: { type: 'edgetpu' }, cpu1: { type: 'cpu' } },
      };
    },
  };
}

function fakeTrustStore(pins = []) {
  return { saveError: null, list: () => pins };
}

function fakeSession(raw, overrides = {}) {
  const capabilities = readCapabilities('0.17.2-abc', FRIGATE_CONFIG);
  return {
    config: normalizeConfig(raw),
    rawConfig: raw,
    capabilities,
    client: fakeClient(),
    feed: {
      mode: 'mqtt',
      endpoint: '192.168.1.20:8883',
      status: { state: 'connected', error: null },
    },
    frigateOnline: true,
    flapping: false,
    ...overrides,
  };
}

const lines = (answer) => answer.en.split('\n');

function assertNoSecret(answer) {
  for (const secret of SECRETS) {
    assert.ok(!answer.en.includes(secret), `"${secret}" in the English report`);
    assert.ok(!answer.fr.includes(secret), `"${secret}" in the French report`);
  }
}

test('remote report: versions, feed, cameras, detectors, storage, certificates, warnings', async () => {
  const raw = {
    frigate_url: 'https://gladys:S3cret@192.168.1.10:8971',
    username: 'gladys',
    password: 'S3cret',
    mqtt_host: '192.168.1.20',
    mqtt_port: 8883,
    mqtt_username: 'frigate',
    mqtt_password: 'MqttPw!',
    mqtt_tls: true,
  };
  const session = fakeSession(raw, {
    client: fakeClient({
      tlsDecision: { trusted: true, reason: TRUST_REASONS.PINNED, fingerprint: FINGERPRINT },
    }),
  });
  const diagnostics = createDiagnostics({
    getSession: () => session,
    trustStore: fakeTrustStore([
      {
        endpoint: '192.168.1.10:8971',
        fingerprint: FINGERPRINT,
        pinned_at: '2026-10-01T08:00:00.000Z',
      },
      {
        endpoint: '192.168.1.20:8883',
        fingerprint: FINGERPRINT,
        pinned_at: '2026-10-02T08:00:00.000Z',
      },
      {
        endpoint: 'old-host:8971',
        fingerprint: FINGERPRINT,
        pinned_at: '2026-01-01T08:00:00.000Z',
      },
    ]),
    now: () => NOW,
    packageVersion: async () => '0.4.0',
  });
  diagnostics.recordRaw('front/motion', Buffer.from('ON'));
  diagnostics.noteMessage({
    type: 'cameraStatus',
    camera: 'front',
    role: 'detect',
    state: 'online',
  });
  diagnostics.noteMessage({
    type: 'cameraStatus',
    camera: 'front',
    role: 'record',
    state: 'offline',
  });

  const answer = await diagnostics.report();
  const text = answer.en;
  assert.match(
    text,
    /^Frigate integration diagnostics, 2026-10-23 14:02 UTC\nIntegration 0\.4\.0, mode: remote \(existing Frigate\)/,
  );
  assert.match(text, /• Version 0\.17\.2-abc, reachable at https:\/\/192\.168\.1\.10:8971\n/);
  assert.match(text, /• Up for 2 h/);
  assert.match(text, /• Account: logged in as gladys/);
  assert.match(text, /Real-time feed\n {2}• MQTT broker 192\.168\.1\.20:8883: connected\n/);
  assert.match(text, /• Last message 0 s ago \(1 since the start\)/);
  assert.match(
    text,
    /• Frigate announces: online; drops its broker connection again and again: no/,
  );
  assert.match(
    text,
    /Cameras \(2\)\n {2}• front \(Front door\): camera 5\.0 fps, detection 1\.3 fps, skipped 0\.0 fps; detect online, record offline\n {2}• garage: camera 0\.0 fps/,
  );
  assert.match(text, /• coral \(edgetpu\): inference 9\.8 ms, idle/);
  assert.match(text, /• cpu1 \(cpu\): inference 95\.3 ms, detection running for 30 s \(stuck\?\)/);
  assert.match(text, /• Recordings: 1\.0 GB used of 10\.0 GB/);
  assert.match(text, /• Shared memory \(\/dev\/shm\): 130 MB used of 512 MB/);
  assert.match(
    text,
    /• Frigate certificate: self-signed, identical to the pinned one \(SHA-256 00:01:02:03:…:1C:1D:1E:1F\)/,
  );
  assert.match(
    text,
    /• Frigate 192\.168\.1\.10:8971: pinned SHA-256 00:01:02:03:…:1C:1D:1E:1F \(since 2026-10-01 08:00 UTC\)/,
  );
  assert.match(text, /• Broker 192\.168\.1\.20:8883: pinned SHA-256/);
  assert.match(text, /• 1 other pinned endpoint\(s\)/);
  assert.match(text, /• Expert fingerprint: none; custom authority: no/);
  assert.match(text, /Warnings\n {2}• None/);
  assert.doesNotMatch(text, /Managed mode/);
  assert.match(answer.fr, /Intégration 0\.4\.0, mode : distant/);
  assert.match(
    answer.fr,
    /• front \(Front door\) : caméra 5\.0 i\/s, détection 1\.3 i\/s, sautées 0\.0 i\/s ; detect en ligne, record hors ligne/,
  );
  assert.ok(lines(answer).length <= MAX_REPORT_LINES, `${lines(answer).length} lines`);
  assert.equal(lines(answer).length, answer.fr.split('\n').length, 'both languages line up');
  assertNoSecret(answer);
});

test('remote report with Frigate down: the reason is the connection status, warnings shown', async () => {
  const raw = { frigate_url: 'http://192.168.1.10:5000' };
  const session = fakeSession(raw, {
    capabilities: null,
    client: null,
    feed: null,
    frigateOnline: null,
  });
  const diagnostics = createDiagnostics({
    getSession: () => session,
    trustStore: fakeTrustStore(),
    now: () => NOW,
    packageVersion: async () => '0.4.0',
  });
  const answer = await diagnostics.report();
  assert.match(
    answer.en,
    /• Not reachable at http:\/\/192\.168\.1\.10:5000 \(the connection status says why\)/,
  );
  assert.match(answer.en, /Real-time feed\n {2}• Not started/);
  assert.match(answer.en, /Warnings\n {2}• Unauthenticated Frigate port \(5000\)/);
  assert.doesNotMatch(answer.en, /Cameras \(/, 'no camera section without Frigate');
});

test('an unconfigured integration gets a two-line report', async () => {
  const diagnostics = createDiagnostics({
    getSession: () => ({ config: null }),
    trustStore: fakeTrustStore(),
    now: () => NOW,
    packageVersion: async () => '0.4.0',
  });
  const answer = await diagnostics.report();
  assert.equal(lines(answer).length, 2);
  assert.match(answer.en, /Integration 0\.4\.0: not configured yet\./);
});

test('managed report: container, ports, hardware, detector, retention, files, admin, advice', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frigate-diag-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  // A config.yml with 6 cameras (over the shm limit) and an admin password.
  const configDir = join(dataDir, 'containers/frigate/config');
  await mkdir(configDir, { recursive: true });
  const cameras = Array.from({ length: 6 }, (_, i) => `  cam${i}: {}`).join('\n');
  await writeFile(join(configDir, 'config.yml'), `mqtt:\n  enabled: false\ncameras:\n${cameras}\n`);
  await mkdir(join(dataDir, 'managed'), { recursive: true });
  await writeFile(
    join(dataDir, 'managed/state.json'),
    JSON.stringify({ admin_password: 'AdminPw-123', started_at: '2026-10-23T12:00:00.000Z' }),
  );
  const gladys = {
    async getContainers() {
      return [
        {
          name: 'frigate',
          status: 'running',
          desired: 'running',
          started_at: '2026-10-23T12:00:00.000Z',
          ports: [
            { container_port: 8971, name: 'frigate_ui', host_port: 42115 },
            { container_port: 8554, name: 'frigate_rtsp', host_port: null },
          ],
          devices: [
            { class: 'coral-usb', granted: true, available: true },
            { class: 'coral-pcie', granted: false, available: false },
            { class: 'gpu', granted: false, available: true },
          ],
        },
      ];
    },
  };
  const managed = createManagedFrigate({ gladys, logger: { info() {}, warn() {} }, dataDir });
  const raw = {
    mode: 'managed',
    mqtt_host: 'broker',
    mqtt_password: 'MqttPw!',
    mqtt_username: 'f',
  };
  const session = fakeSession(raw, { capabilities: null, client: null, feed: null });
  const diagnostics = createDiagnostics({
    getSession: () => session,
    managed,
    trustStore: fakeTrustStore(),
    now: () => NOW,
    packageVersion: async () => '0.4.0',
  });
  const answer = await diagnostics.report();
  const text = answer.en;
  assert.match(text, /mode: managed \(Frigate installed by Gladys\)/);
  assert.match(text, /• Not reachable at http:\/\/frigate:5000/);
  assert.match(
    text,
    /Managed mode\n {2}• Container frigate: running \(wanted: running\), started 2026-10-23 12:00 UTC \(2 h ago\)/,
  );
  assert.match(text, /• Host ports: frigate_ui 42115, frigate_rtsp not assigned/);
  assert.match(
    text,
    /• Hardware: Coral USB: granted, detected · Coral PCIe: absent · GPU: detected, not granted/,
  );
  assert.match(text, /• Detector: Coral USB\./);
  assert.match(text, /• GPU detected but not granted/);
  assert.match(text, /• Retention: continuous 2 d/);
  assert.match(
    text,
    /• Generated configuration: .*containers\/frigate\/config\/config\.yml \(\/config\/config\.yml in Frigate\)/,
  );
  assert.match(text, /• Admin password set by Gladys: yes/);
  assert.match(
    text,
    /• 6 cameras: recommended shm 576 MB \(limit 512\), RAM 2560 MB \(limit 4096\)\./,
  );
  assert.match(
    text,
    /• Above the limits of the Gladys sandbox \(5 cameras at most here\): prefer the remote mode/,
  );
  assert.match(text, /• Frigate: internal port over the private network/);
  assert.match(text, /• Broker: no TLS/);
  assert.match(text, /Frigate's own logs: the supervision block of the integration in Gladys/);
  assert.match(answer.fr, /Mot de passe admin défini par Gladys : oui/);
  assert.ok(lines(answer).length <= MAX_REPORT_LINES, `${lines(answer).length} lines`);
  assertNoSecret(answer);
});

test('the report is capped in lines', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`cam${i}`, { enabled: true, detect: { enabled: true } }]),
  );
  const raw = { frigate_url: 'https://192.168.1.10:8971' };
  const session = fakeSession(raw, {
    capabilities: readCapabilities('0.17.2', { cameras: many }),
  });
  session.client.getStats = async () => ({
    ...STATS,
    detectors: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`d${i}`, { inference_speed: 10 }]),
    ),
  });
  const diagnostics = createDiagnostics({
    getSession: () => session,
    trustStore: fakeTrustStore(),
    now: () => NOW,
    packageVersion: async () => '0.4.0',
  });
  const answer = await diagnostics.report();
  assert.equal(lines(answer).length, MAX_REPORT_LINES);
  assert.match(answer.en, /• … and 30 more/);
  assert.match(answer.en, /… \(report shortened\)$/);
  assert.match(answer.fr, /… \(rapport raccourci\)$/);
});

test('the debug button lists the messages recorded through the raw tap', () => {
  const session = fakeSession(
    { frigate_url: 'https://x:8971' },
    {
      feed: { mode: 'websocket', endpoint: 'wss://x:8971/ws', status: { state: 'connected' } },
    },
  );
  let now = NOW;
  const diagnostics = createDiagnostics({
    getSession: () => session,
    trustStore: fakeTrustStore(),
    now: () => (now += 1000),
  });
  diagnostics.recordRaw('available', 'online');
  diagnostics.recordRaw('front/person', 1);
  diagnostics.recordRaw('events', { type: 'new', after: { id: 'a', token: 'jwt.token.value' } });
  const answer = diagnostics.mqttDebug();
  const [head, , ...rows] = answer.en.split('\n');
  assert.match(head, /^Last 3 of 3 real-time messages since the start \(Frigate WebSocket\)/);
  assert.deepEqual(rows, [
    '14:02:14 events {"type":"new","after":{"id":"a","token":"***"}}',
    '14:02:13 front/person 1',
    '14:02:12 available online',
  ]);
  assertNoSecret(answer);
});

test('the proposal button answers a GitHub link without secret, or asks for the names', async () => {
  const session = fakeSession({ mode: 'managed' });
  const diagnostics = createDiagnostics({
    getSession: () => session,
    trustStore: fakeTrustStore(),
    now: () => NOW,
    packageVersion: async () => '0.4.0',
  });
  const answer = await diagnostics.proposeCamera({
    brand: 'Tapo',
    model: 'C200',
    source_type: 'tapo',
    notes: 'tapo://S3cret@192.168.1.42 works',
  });
  const url = answer.en.split('\n').at(-1);
  assert.match(
    url,
    /^https:\/\/github\.com\/Terdious\/gladys-frigate\/issues\/new\?title=Frigate%20camera%20catalog%3A%20Tapo%20C200&body=.*&labels=cameras$/,
  );
  const body = new URL(url).searchParams.get('body');
  assert.match(body, /- Frigate: 0\.17\.2-abc\n- Integration: 0\.4\.0 \(managed mode\)/);
  assert.doesNotMatch(body, /S3cret|192\.168\.1\.42/);
  assert.match(answer.en, /^Open this link in your browser/);
  assert.match(answer.fr, /^Ouvrez ce lien dans votre navigateur/);
  assert.equal(answer.fr.split('\n').at(-1), url, 'the same link in both languages');

  const missing = await diagnostics.proposeCamera({ brand: ' ', model: 'C200' });
  assert.match(missing.en, /Fill in the brand and the model/);
});
