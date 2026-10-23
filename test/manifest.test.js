// -----------------------------------------------------------------------------
// Consistency between `gladys-assistant-integration.json` and the code. The
// store indexer validates the manifest itself (`npm run validate:manifest`);
// these tests pin what the indexer cannot know.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, DETECTORS, GPU_VENDORS, MODES } from '../src/config.js';
import { SOURCE_TYPES } from '../src/frigate/proposal.js';
import {
  CONTAINER_LIMITS,
  CONTAINER_NAME,
  FRIGATE_IMAGE,
  RETENTION_DEFAULTS,
  RTSP_PORT_NAME,
  UI_PORT_NAME,
} from '../src/frigate/managed/constants.js';
import {
  DETECTOR_CHOICES,
  GPU_VENDORS as DETECTOR_GPU_VENDORS,
  HARDWARE_CLASSES,
} from '../src/frigate/managed/detector.js';
import { MANIFEST_ACTIONS, SCENE_ACTIONS, SCENE_TRIGGERS } from '../src/gladys/keys.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const valueFields = manifest.config_schema.filter((f) => f.type !== 'section');

test('the manifest requires Gladys 5.1+ (scene triggers and actions)', () => {
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('the manifest version and image tag follow package.json', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/terdious/gladys-frigate:${pkg.version}`);
});

test('every config field is known to the code, with the same default', () => {
  assert.deepEqual(valueFields.map((f) => f.key).sort(), Object.keys(DEFAULT_CONFIG).sort());
  for (const field of valueFields) {
    if (field.default !== undefined) {
      assert.equal(field.default, DEFAULT_CONFIG[field.key], `default of "${field.key}"`);
    }
  }
});

test('passwords are secret fields', () => {
  for (const key of ['password', 'mqtt_password']) {
    assert.equal(valueFields.find((f) => f.key === key).type, 'secret');
  }
});

test('the expert TLS fields are optional and come last', () => {
  const keys = manifest.config_schema.map((f) => f.key);
  assert.deepEqual(keys.slice(-3), ['expert_section', 'tls_fingerprint', 'tls_ca']);
  for (const key of ['tls_fingerprint', 'tls_ca']) {
    assert.notEqual(valueFields.find((f) => f.key === key).required, true);
  }
});

test('a reset button lets the user trust a new self-signed certificate', () => {
  assert.ok(manifest.actions.some((a) => a.key === MANIFEST_ACTIONS.RESET_CERTIFICATE));
});

// Published keys are stored in the users' scenes: never rename or remove one.
// Extending these lists is fine; changing an existing entry is a breaking change.
test('scene trigger keys are frozen', () => {
  assert.deepEqual(Object.values(SCENE_TRIGGERS), [
    'review_alert',
    'object_detected',
    'object_entered_zone',
  ]);
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key),
    Object.values(SCENE_TRIGGERS),
  );
});

test('scene action keys are frozen', () => {
  assert.deepEqual(Object.values(SCENE_ACTIONS), ['attach_event_snapshot']);
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTIONS),
  );
});

test('manifest action keys are frozen', () => {
  assert.deepEqual(Object.values(MANIFEST_ACTIONS), [
    'test_connection',
    'refresh_cameras',
    'reset_certificate',
    'start_frigate',
    'stop_frigate',
    'restart_frigate',
    'show_credentials',
    'diagnostics',
    'mqtt_debug',
    'propose_camera',
  ]);
});

// The Gladys core rejects a manifest with more than 10 actions (MAX_ACTIONS
// of server/lib/external-integration/constants.js).
test('the manifest stays within the 10 actions the core accepts', () => {
  assert.ok(manifest.actions.length <= 10, `${manifest.actions.length} actions`);
});

test('the catalog proposal offers the source types the code knows', () => {
  const action = manifest.actions.find((a) => a.key === MANIFEST_ACTIONS.PROPOSE_CAMERA);
  const field = (key) => action.fields.find((f) => f.key === key);
  assert.equal(field('brand').required, true);
  assert.equal(field('model').required, true);
  assert.notEqual(field('notes').required, true);
  assert.deepEqual(
    field('source_type').options.map((o) => o.value),
    [...SOURCE_TYPES],
  );
  for (const key of ['brand', 'model', 'source_type', 'notes']) {
    assert.ok(field(key).label.en && field(key).label.fr, `${key} is labelled in both languages`);
  }
});

test('manifest action keys match the code', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(MANIFEST_ACTIONS),
  );
});

test('every trigger exposes the common variables and filters on the camera', () => {
  for (const trigger of manifest.scene_triggers) {
    const variables = trigger.variables.map((v) => v.key);
    for (const key of ['camera', 'camera_name', 'label', 'sub_label', 'zones', 'event_id']) {
      assert.ok(variables.includes(key), `${trigger.key} lacks the "${key}" variable`);
    }
    const camera = trigger.fields.find((f) => f.key === 'camera');
    assert.equal(camera?.source, 'devices', `${trigger.key} filters on a camera device`);
  }
  const review = manifest.scene_triggers.find((t) => t.key === SCENE_TRIGGERS.REVIEW_ALERT);
  assert.ok(review.variables.some((v) => v.key === 'review_id'));
});

test('no trigger declares a threshold filter (Gladys matches by equality only)', () => {
  for (const trigger of manifest.scene_triggers) {
    for (const field of trigger.fields) {
      assert.notEqual(field.type, 'number', `${trigger.key}.${field.key}: use min_score instead`);
    }
  }
});

test('the snapshot action requires the event id and can take the scene variable', () => {
  const action = manifest.scene_actions[0];
  const eventId = action.fields.find((f) => f.key === 'event_id');
  assert.equal(eventId.type, 'string', 'string fields accept {{…}} variables');
  assert.equal(eventId.required, true);
  assert.ok(action.timeout_seconds >= 15, 'leave time to fetch and resize the snapshot');
});

test('every manifest action has a handler in index.js (no "not implemented" button)', async () => {
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  for (const [name, key] of Object.entries(MANIFEST_ACTIONS)) {
    assert.ok(manifest.actions.some((action) => action.key === key));
    assert.match(
      index,
      new RegExp(`onAction\\(MANIFEST_ACTIONS\\.${name}\\b`),
      `${key} is handled`,
    );
  }
});

test('index.js answers the scan and the camera requests of Gladys', async () => {
  // Without a handler, the SDK ignores a scan silently: the Discovery tab
  // then spins for minutes and shows nothing (0.1.2).
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  for (const handler of ['onScanRequest', 'onGetImage', 'onPoll', 'onDeviceCreated']) {
    assert.match(index, new RegExp(`gladys\\.${handler}\\(`), `${handler} is registered`);
  }
});

test('every scene action has a handler, every trigger is published (index.js)', async () => {
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const scenes = await readFile(new URL('../src/gladys/sceneEvents.js', import.meta.url), 'utf8');
  for (const [name, key] of Object.entries(SCENE_ACTIONS)) {
    assert.ok(manifest.scene_actions.some((action) => action.key === key));
    assert.match(
      index,
      new RegExp(`onSceneAction\\(\\s*SCENE_ACTIONS\\.${name}\\b`),
      `${key} is handled`,
    );
  }
  for (const name of Object.keys(SCENE_TRIGGERS)) {
    assert.match(scenes, new RegExp(`SCENE_TRIGGERS\\.${name}\\b`), `${name} is published`);
  }
});

// ---- Managed mode: the `frigate` sub-container and its settings ----------

const frigateContainer = () => manifest.containers.find((c) => c.name === CONTAINER_NAME);

test('the Frigate sub-container is declared as the code expects', () => {
  assert.equal(manifest.containers.length, 1);
  const container = frigateContainer();
  assert.equal(container.docker_image, FRIGATE_IMAGE, 'one Frigate version, code and manifest');
  assert.equal(container.start, 'manual', 'started by the "Start Frigate" button only');
  assert.equal(container.read_only, false, 'Frigate does not run on a read-only rootfs');
  // /tmp/cache on disk: the core mounts a 64 MB tmpfs on /tmp.
  assert.deepEqual(container.volumes, ['/config', '/media/frigate', '/tmp/cache']);
  assert.deepEqual(container.devices, [...HARDWARE_CLASSES]);
  assert.deepEqual(
    container.ports.map((port) => [port.container_port, port.name, port.browsable !== false]),
    [
      [8971, UI_PORT_NAME, true],
      [8554, RTSP_PORT_NAME, false],
    ],
  );
  assert.equal(container.env, undefined, 'never a secret in the public manifest');
});

test('the resource advice compares with the limits of the manifest', () => {
  const container = frigateContainer();
  assert.deepEqual(
    { memoryMb: container.memory_mb, cpu: container.cpu, shmMb: container.shm_mb },
    { ...CONTAINER_LIMITS },
  );
});

test('every {{port:<name>}} of the section texts names a declared port', () => {
  const names = new Set(manifest.containers.flatMap((c) => (c.ports ?? []).map((p) => p.name)));
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  const tokens = sections.flatMap((section) =>
    [section.label, section.description]
      .flatMap((text) => Object.values(text ?? {}))
      .flatMap((text) => [...text.matchAll(/\{\{port:([a-z0-9_]+)\}\}/g)].map((m) => m[1])),
  );
  assert.ok(tokens.includes(UI_PORT_NAME), 'the managed section shows the Frigate UI address');
  for (const token of tokens) assert.ok(names.has(token), `{{port:${token}}} is declared`);
});

test('the select fields offer exactly the values the code knows', () => {
  const options = (key) => valueFields.find((f) => f.key === key).options.map((o) => o.value);
  assert.deepEqual(options('mode'), Object.values(MODES));
  assert.deepEqual(options('detector'), [...DETECTORS]);
  assert.deepEqual(options('detector'), [...DETECTOR_CHOICES]);
  assert.deepEqual(options('gpu_vendor'), [...GPU_VENDORS]);
  assert.deepEqual(options('gpu_vendor'), [...DETECTOR_GPU_VENDORS]);
  assert.equal(valueFields.find((f) => f.key === 'mode').default, 'remote', 'remote by default');
});

test('the retention defaults of the manifest are the ones config.yml gets', () => {
  assert.deepEqual(
    {
      continuous: DEFAULT_CONFIG.record_continuous_days,
      alerts: DEFAULT_CONFIG.record_alerts_days,
      detections: DEFAULT_CONFIG.record_detections_days,
      snapshots: DEFAULT_CONFIG.snapshots_retain_days,
    },
    { ...RETENTION_DEFAULTS },
  );
});

test('the Frigate URL is not required by the form (managed mode has none)', () => {
  assert.notEqual(valueFields.find((f) => f.key === 'frigate_url').required, true);
});

test('index.js follows the hardware grants of the sub-container', async () => {
  const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(index, /gladys\.onHardwareUpdated\(/);
});
