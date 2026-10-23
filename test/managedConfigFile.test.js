import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ManagedConfigError } from '../src/frigate/errors.js';
import {
  effectiveRetention,
  renderConfig,
  retentionInFile,
  writeConfigFile,
} from '../src/frigate/managed/configFile.js';
import {
  MQTT_CA_FILE,
  OPENVINO_MODEL,
  SYSTEM_CA_BUNDLE,
} from '../src/frigate/managed/constants.js';
import { chooseDetector } from '../src/frigate/managed/detector.js';

const grant = (...classes) =>
  classes.map((name) => ({ class: name, granted: true, available: true }));
const settings = ({ detector = 'auto', gpuVendor = 'intel', devices = [], ...rest } = {}) => ({
  mqtt: null,
  detector: chooseDetector({ detector, gpuVendor, devices }),
  retention: {},
  ...rest,
});
const render = (content, options, renderOptions) =>
  renderConfig(content, settings(options), renderOptions);

// A config.yml as Frigate leaves it after the user worked in its UI.
const USER_FILE = `version: 0.16-0
# My cameras, set in the Frigate UI
mqtt:
  enabled: false
ffmpeg:
  hwaccel_args: preset-intel-qsv-h264 # mine
go2rtc:
  streams:
    porch:
      - rtsp://user:pw@192.168.1.20:554/stream1
cameras:
  porch:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/porch
          roles: [detect, record]
    zones:
      steps:
        coordinates: 0.1,0.2,0.3,0.4
    motion:
      mask: 0,0,10,10
record:
  enabled: true
  continuous:
    days: 30
  alerts:
    retain:
      days: 20
auth:
  enabled: true
`;

test('an empty file gets the minimal managed configuration', () => {
  const { content, changed, retention } = render('', {}, { created: true });
  assert.equal(changed, true);
  const config = parse(content);
  assert.deepEqual(config.mqtt, { enabled: false });
  assert.deepEqual(config.cameras, {});
  assert.deepEqual(config.detectors, { cpu0: { type: 'cpu' } });
  assert.equal(config.model, undefined, 'no model for the CPU detector');
  assert.equal(config.ffmpeg, undefined, 'no VAAPI without a usable GPU');
  assert.deepEqual(config.record, {
    enabled: true,
    continuous: { days: 2 },
    alerts: { retain: { days: 7 } },
    detections: { retain: { days: 7 } },
  });
  assert.deepEqual(config.snapshots, { enabled: true, retain: { default: 14 } });
  assert.deepEqual(retention, { continuous: 2, alerts: 7, detections: 7, snapshots: 14 });
});

test('the generation is idempotent: a second pass changes nothing', () => {
  const first = render(USER_FILE, { devices: grant('gpu') });
  const second = render(first.content, { devices: grant('gpu') });
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test('what the user set in the Frigate UI is preserved', () => {
  const { content } = render(USER_FILE, { devices: grant('gpu') });
  const before = parse(USER_FILE);
  const after = parse(content);
  assert.equal(after.version, '0.16-0', 'the version key Frigate writes is kept');
  assert.deepEqual(after.cameras, before.cameras, 'cameras, zones and masks untouched');
  assert.deepEqual(after.go2rtc, before.go2rtc, 'go2rtc untouched');
  assert.deepEqual(after.auth, before.auth, 'auth untouched');
  assert.deepEqual(after.ffmpeg, before.ffmpeg, 'a user ffmpeg section is never overwritten');
  assert.match(content, /# My cameras, set in the Frigate UI/, 'comments survive');
  assert.match(content, /# mine/);
  assert.ok(content.startsWith('version: 0.16-0'), 'the version stays at the top');
});

test('retention: an explicit Gladys value wins, else the file, else the default', () => {
  const fromFile = render(USER_FILE).retention;
  assert.deepEqual(fromFile, { continuous: 30, alerts: 20, detections: 7, snapshots: 14 });
  const explicit = renderConfig(
    USER_FILE,
    settings({ retention: { continuous: 3, alerts: null, detections: 0, snapshots: 1 } }),
  );
  assert.deepEqual(explicit.retention, { continuous: 3, alerts: 20, detections: 0, snapshots: 1 });
  const config = parse(explicit.content);
  assert.equal(config.record.continuous.days, 3);
  assert.equal(config.record.alerts.retain.days, 20);
  assert.equal(config.record.detections.retain.days, 0, '0 disables, it is not "unset"');
  assert.equal(config.snapshots.retain.default, 1);
  assert.equal(config.record.enabled, true);
});

test('retention helpers ignore what is not a whole number of days', () => {
  assert.deepEqual(retentionInFile({ record: { continuous: { days: 'x' } } }), {
    continuous: undefined,
    alerts: undefined,
    detections: undefined,
    snapshots: undefined,
  });
  assert.deepEqual(effectiveRetention({ continuous: -1 }, { continuous: 1.5 }), {
    continuous: 2,
    alerts: 7,
    detections: 7,
    snapshots: 14,
  });
});

test('a user record section keeps its other keys (motion days, alert mode…)', () => {
  const file =
    'record:\n  enabled: false\n  motion:\n    days: 3\n  alerts:\n    retain:\n      mode: motion\n';
  const config = parse(render(file).content);
  assert.equal(config.record.enabled, false, 'recordings turned off by the user stay off');
  assert.deepEqual(config.record.motion, { days: 3 });
  assert.deepEqual(config.record.alerts, { retain: { mode: 'motion', days: 7 } });
});

test('detector transitions: CPU -> OpenVINO -> Coral -> CPU', () => {
  let content = render('', {}, { created: true }).content;
  // An Intel GPU is granted: OpenVINO, its model, VAAPI decoding.
  content = render(content, { devices: grant('gpu') }).content;
  let config = parse(content);
  assert.deepEqual(config.detectors, { ov: { type: 'openvino', device: 'GPU' } });
  assert.deepEqual(config.model, { ...OPENVINO_MODEL });
  assert.deepEqual(config.ffmpeg, { hwaccel_args: 'preset-vaapi' });
  // A Coral USB as well: the Coral wins, the generated model goes away,
  // VAAPI decoding stays (the GPU is still there).
  content = render(content, { devices: grant('gpu', 'coral-usb') }).content;
  config = parse(content);
  assert.deepEqual(config.detectors, { coral: { type: 'edgetpu', device: 'usb' } });
  assert.equal(config.model, undefined);
  assert.deepEqual(config.ffmpeg, { hwaccel_args: 'preset-vaapi' });
  // Everything revoked: CPU, and no VAAPI (ffmpeg would fail without /dev/dri).
  content = render(content, { devices: [] }).content;
  config = parse(content);
  assert.deepEqual(config.detectors, { cpu0: { type: 'cpu' } });
  assert.equal(config.ffmpeg, undefined);
});

test('a custom model section is kept when leaving OpenVINO', () => {
  const file =
    'detectors:\n  ov:\n    type: openvino\n    device: GPU\nmodel:\n  path: /config/my-model.xml\n';
  const config = parse(render(file, { devices: grant('coral-pcie') }).content);
  assert.deepEqual(config.detectors, { coral: { type: 'edgetpu', device: 'pci' } });
  assert.deepEqual(config.model, { path: '/config/my-model.xml' });
});

test('automatic mode keeps a hand-written detectors section; an explicit choice replaces it', () => {
  const file =
    'detectors:\n  coral1:\n    type: edgetpu\n    device: usb:0\n  coral2:\n    type: edgetpu\n    device: usb:1\n';
  const auto = render(file, { devices: grant('coral-usb') });
  assert.equal(auto.customDetectors, true);
  assert.deepEqual(parse(auto.content).detectors, parse(file).detectors);
  const explicit = render(file, { detector: 'cpu', devices: grant('coral-usb') });
  assert.equal(explicit.customDetectors, false);
  assert.deepEqual(parse(explicit.content).detectors, { cpu0: { type: 'cpu' } });
});

test('mqtt: the user broker, the password through the environment, TLS authorities', () => {
  const broker = { host: '192.168.1.5', port: 8883, topicPrefix: 'cams', user: 'frigate' };
  const file =
    'mqtt:\n  enabled: true\n  host: old\n  client_id: frigate-home\n  tls_insecure: true\n';
  let config = parse(
    render(file, { mqtt: { ...broker, hasPassword: true, tls: { ca: 'PEM' } } }).content,
  );
  assert.deepEqual(config.mqtt, {
    client_id: 'frigate-home',
    enabled: true,
    host: '192.168.1.5',
    port: 8883,
    topic_prefix: 'cams',
    user: 'frigate',
    password: '{FRIGATE_MQTT_PASSWORD}',
    tls_ca_certs: `/config/${MQTT_CA_FILE}`,
  });
  config = parse(render(file, { mqtt: { ...broker, hasPassword: false, tls: {} } }).content);
  assert.equal(config.mqtt.password, undefined);
  assert.equal(config.mqtt.tls_ca_certs, SYSTEM_CA_BUNDLE);
  config = parse(render(file, { mqtt: null }).content);
  assert.deepEqual(config.mqtt, { enabled: false }, 'no broker in Gladys: MQTT off');
});

test('an invalid file is refused, never overwritten', () => {
  assert.throws(
    () => render('cameras: [unclosed\n'),
    (err) => err instanceof ManagedConfigError && err.code === 'invalid_yaml',
  );
  assert.throws(
    () => render('- a\n- b\n'),
    (err) => err instanceof ManagedConfigError && err.code === 'not_a_map',
  );
});

test('writeConfigFile creates the file, then writes only when something changed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'containers', 'frigate', 'config');
  const first = await writeConfigFile({ configDir, settings: settings() });
  assert.equal(first.created, true);
  assert.equal(first.changed, true);
  const written = await readFile(first.filePath, 'utf8');
  assert.deepEqual(parse(written).cameras, {});

  const before = (await stat(first.filePath)).mtimeMs;
  const again = await writeConfigFile({ configDir, settings: settings() });
  assert.equal(again.changed, false);
  assert.equal((await stat(first.filePath)).mtimeMs, before, 'not rewritten');

  const ca = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
  const mqtt = { host: 'b', port: 8883, topicPrefix: 'frigate', tls: { ca } };
  const withCa = await writeConfigFile({ configDir, settings: settings({ mqtt }) });
  assert.equal(withCa.changed, true);
  assert.equal(await readFile(join(configDir, MQTT_CA_FILE), 'utf8'), `${ca}\n`);

  // A file Frigate rewrote (migration) with the same values: left alone.
  await writeFile(first.filePath, `version: 0.18-0\n${await readFile(first.filePath, 'utf8')}`);
  const migrated = await writeConfigFile({ configDir, settings: settings({ mqtt }) });
  assert.equal(migrated.changed, false);
});
