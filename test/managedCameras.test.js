// The camera catalog and the go2rtc sources / Frigate camera sections of the
// managed cameras (src/frigate/managed/catalog.js, cameraSources.js), and
// their store (camerasStore.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraSourceError, CamerasStoreError } from '../src/frigate/errors.js';
import {
  BATTERY_WARNING,
  CATALOG,
  COMMON_LABELS,
  DEFAULT_MODEL,
  SOURCE_TYPES,
  TRACKABLE_LABELS,
  catalogEntry,
} from '../src/frigate/managed/catalog.js';
import {
  buildCameraConfig,
  buildMainSource,
  buildSubSource,
  parseObjects,
  redactSource,
  resolveCamera,
  slugify,
} from '../src/frigate/managed/cameraSources.js';
import { createCamerasStore } from '../src/frigate/managed/camerasStore.js';
import { TAPO_INPUT_ARGS } from '../src/frigate/managed/constants.js';

const camera = (record, name = 'cam') => resolveCamera(name, record);
const bilingual = (text) =>
  typeof text?.en === 'string' &&
  text.en.length > 0 &&
  typeof text.fr === 'string' &&
  text.fr.length > 0;

// ---- Catalog ----------------------------------------------------------------

test('every catalog entry has a stable id, bilingual texts and a valid preset', () => {
  const ids = CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const entry of CATALOG) {
    assert.match(entry.id, /^[a-z0-9-]+$/, entry.id);
    assert.ok(bilingual(entry.label), `${entry.id} label`);
    assert.ok(bilingual(entry.note), `${entry.id} note`);
    assert.notEqual(entry.note.en, entry.note.fr, `${entry.id}: the note is translated`);
    const types = Object.values(SOURCE_TYPES);
    assert.ok(entry.allowedSourceTypes.length > 0);
    for (const type of entry.allowedSourceTypes) assert.ok(types.includes(type), type);
    assert.ok(entry.allowedSourceTypes.includes(entry.preset.sourceType), `${entry.id} preset`);
    assert.ok(
      entry.allowedSourceTypes.includes(SOURCE_TYPES.CUSTOM),
      'a custom source always works',
    );
    for (const key of ['rtspPort', 'httpPort', 'onvifPort']) {
      const port = entry.preset[key];
      if (port !== undefined) assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
    }
  }
  assert.ok(catalogEntry(DEFAULT_MODEL));
  assert.equal(catalogEntry('nope'), null);
});

test('the catalog covers the models ported from the core branch', () => {
  assert.deepEqual(
    CATALOG.map((entry) => entry.id),
    [
      'tapo-wired',
      'tapo-battery',
      'reolink-rtsp',
      'reolink-hub',
      'dlink-dcs-5020l',
      'dlink-dcs-8302lh',
      'dlink-dcs-8635lh',
      'generic-rtsp',
      'onvif',
      'custom',
    ],
  );
  assert.ok(catalogEntry('tapo-wired').models.includes('C520WS'));
  assert.ok(catalogEntry('tapo-battery').models.includes('C660'));
  assert.equal(catalogEntry('tapo-battery').battery, true);
  assert.equal(catalogEntry('reolink-hub').battery, true);
  assert.equal(catalogEntry('dlink-dcs-5020l').preset.ptzProtocol, 'dlink-http');
  assert.equal(catalogEntry('dlink-dcs-8635lh').preset.subPath, undefined, 'one stream');
});

test('the notes carry the forum knowledge', () => {
  const note = (id) => catalogEntry(id).note;
  assert.match(note('tapo-wired').en, /camera account/);
  assert.match(note('tapo-wired').en, /NOT your TP-Link cloud account/);
  assert.match(note('tapo-battery').en, /SHA256/);
  assert.match(note('tapo-battery').en, /401/);
  assert.match(note('reolink-hub').en, /Home Hub/);
  assert.match(note('dlink-dcs-8302lh').en, /Local Access/);
  assert.match(note('dlink-dcs-8302lh').en, /PIN/);
  assert.match(note('dlink-dcs-8302lh').en, /2-3 simultaneous connections/);
  assert.match(note('dlink-dcs-8302lh').fr, /2-3 connexions simultanées/);
  assert.match(note('dlink-dcs-5020l').en, /ADMIN account/);
  assert.match(BATTERY_WARNING.en, /PERMANENTLY POWERED/);
  assert.match(BATTERY_WARNING.en, /> 50 %/);
  assert.match(BATTERY_WARNING.fr, /ALIMENTÉE EN PERMANENCE/);
});

test('the trackable labels include the common ones', () => {
  for (const label of COMMON_LABELS) assert.ok(TRACKABLE_LABELS.includes(label), label);
});

// ---- Names and objects ------------------------------------------------------

test('slugify gives a stable Frigate name', () => {
  assert.equal(slugify('Porch'), 'porch');
  assert.equal(slugify('  Caméra entrée — Nord!  '), 'camera_entree_nord');
  assert.equal(slugify('Garage 2'), 'garage_2');
  assert.equal(slugify('***'), '');
  assert.equal(slugify('日本'), '');
  assert.ok(slugify('x'.repeat(100)).length <= 48);
});

test('parseObjects reads a CSV and reports the unknown labels', () => {
  assert.deepEqual(parseObjects('Person, car;dog, person'), {
    objects: ['person', 'car', 'dog'],
    unknown: [],
  });
  assert.deepEqual(parseObjects('traffic_light, Sports  Ball'), {
    objects: ['traffic light', 'sports ball'],
    unknown: [],
  });
  assert.deepEqual(parseObjects('person, persn, unicorn'), {
    objects: ['person'],
    unknown: ['persn', 'unicorn'],
  });
  assert.deepEqual(parseObjects(''), { objects: [], unknown: [] });
});

// ---- Sources ----------------------------------------------------------------

test('rtsp: preset paths, URL-encoded credentials, port and filter', () => {
  const tapo = camera({
    model: 'tapo-wired',
    host: '192.168.1.20',
    username: 'cam user',
    password: 'p@ss:w/rd#1',
  });
  assert.equal(
    buildMainSource(tapo),
    'rtsp://cam%20user:p%40ss%3Aw%2Frd%231@192.168.1.20:554/stream1',
  );
  assert.equal(
    buildSubSource(tapo),
    'rtsp://cam%20user:p%40ss%3Aw%2Frd%231@192.168.1.20:554/stream2',
  );

  const dlink = camera({
    model: 'dlink-dcs-8302lh',
    host: '10.0.0.5',
    username: 'admin',
    password: '123456',
  });
  assert.equal(
    buildMainSource(dlink),
    'rtsp://admin:123456@10.0.0.5:554/live/profile.0#video=copy#audio=aac',
  );
  assert.equal(
    buildSubSource(dlink),
    'rtsp://admin:123456@10.0.0.5:554/live/profile.1#video=copy#audio=aac',
  );

  const generic = camera({
    model: 'generic-rtsp',
    host: 'cam.local',
    path: '/live/ch0',
    port: 8554,
  });
  assert.equal(
    buildMainSource(generic),
    'rtsp://cam.local:8554/live/ch0',
    'no credentials, no slash doubled',
  );
  assert.equal(buildSubSource(generic), null);
});

test('a secondary stream identical to the main one, or emptied, is ignored', () => {
  assert.equal(
    buildSubSource(camera({ model: 'tapo-wired', host: 'h', subPath: 'stream1' })),
    null,
  );
  assert.equal(
    buildSubSource(camera({ model: 'tapo-wired', host: 'h', subPath: '/stream1' })),
    null,
  );
  assert.equal(buildSubSource(camera({ model: 'tapo-wired', host: 'h', subPath: '' })), null);
  assert.equal(
    buildSubSource(
      camera({ model: 'custom', customSource: 'rtsp://a/1', customSubSource: 'rtsp://a/1' }),
    ),
    null,
  );
  assert.equal(
    buildSubSource(
      camera({ model: 'custom', customSource: 'rtsp://a/1', customSubSource: 'rtsp://a/2' }),
    ),
    'rtsp://a/2',
  );
});

test('tapo: the cloud password, or admin + its uppercase SHA-256', () => {
  const record = { model: 'tapo-battery', host: '192.168.1.30', password: 'Cloud Pw&1' };
  assert.equal(
    buildMainSource(camera(record)),
    'tapo://Cloud%20Pw%261@192.168.1.30?channel=0&subtype=1',
  );
  const hash = createHash('sha256').update('Cloud Pw&1').digest('hex').toUpperCase();
  assert.equal(
    buildMainSource(camera({ ...record, tapoAuthVariant: 'sha256' })),
    `tapo://admin:${hash}@192.168.1.30?channel=0&subtype=1`,
  );
  assert.equal(buildSubSource(camera(record)), null, 'the light stream already');
  assert.throws(
    () => buildMainSource(camera({ model: 'tapo-battery', host: 'h' })),
    (err) => err instanceof CameraSourceError && err.code === 'missing_password',
  );
});

test('onvif, mjpeg and custom sources', () => {
  assert.equal(
    buildMainSource(
      camera({ model: 'onvif', host: '192.168.1.40', username: 'u', password: 'p w' }),
    ),
    'onvif://u:p%20w@192.168.1.40:80',
  );
  assert.equal(
    buildMainSource(
      camera({
        model: 'onvif',
        host: '192.168.1.40',
        username: 'u',
        password: 'p',
        onvifUsername: 'ctl',
        onvifPassword: 'c',
        onvifPort: 2020,
      }),
    ),
    'onvif://ctl:c@192.168.1.40:2020',
  );
  assert.equal(
    buildMainSource(
      camera({
        model: 'dlink-dcs-5020l',
        host: '192.168.1.50',
        username: 'viewer',
        password: 'v:1',
      }),
    ),
    'ffmpeg:http://viewer:v%3A1@192.168.1.50:80/video.cgi#video=h264',
  );
  assert.equal(
    buildMainSource(
      camera({ model: 'dlink-dcs-5020l', host: '192.168.1.50', port: 8080, path: '' }),
    ),
    'ffmpeg:http://192.168.1.50:8080/video.cgi#video=h264',
  );
  assert.equal(
    buildMainSource(camera({ model: 'custom', customSource: 'homekit://x' })),
    'homekit://x',
  );
  // A custom source given with another model replaces its stream.
  assert.equal(
    buildMainSource(camera({ model: 'tapo-wired', host: 'h', customSource: 'rtsp://h/x' })),
    'rtsp://h/x',
  );
  assert.throws(
    () => buildMainSource(camera({ model: 'custom' })),
    (err) => err.code === 'missing_custom_source',
  );
  assert.throws(
    () => buildMainSource(camera({ model: 'generic-rtsp' })),
    (err) => err.code === 'missing_host',
  );
  assert.throws(
    () => resolveCamera('x', { model: 'nope' }),
    (err) => err.code === 'unknown_model',
  );
});

test('redactSource never shows a credential', () => {
  assert.equal(redactSource('rtsp://u:p%40@192.168.1.2:554/s'), 'rtsp://***@192.168.1.2:554/s');
  assert.equal(
    redactSource('tapo://secret@192.168.1.2?channel=0'),
    'tapo://***@192.168.1.2?channel=0',
  );
  assert.equal(redactSource('ffmpeg:http://u:p@h/video.cgi'), 'ffmpeg:http://***@h/video.cgi');
  assert.equal(redactSource('rtsp://h/s'), 'rtsp://h/s');
});

// ---- Camera section ---------------------------------------------------------

test('two streams: record on the main restream, detect on the secondary one', () => {
  const built = buildCameraConfig(
    camera(
      {
        label: 'Porch',
        model: 'tapo-wired',
        host: '192.168.1.20',
        username: 'u',
        password: 'p',
        objects: ['person', 'car'],
        detectFps: 7,
      },
      'porch',
    ),
  );
  assert.deepEqual(Object.keys(built.streams), ['porch', 'porch_sub']);
  assert.deepEqual(built.section, {
    friendly_name: 'Porch',
    ffmpeg: {
      inputs: [
        { path: 'rtsp://127.0.0.1:8554/porch', roles: ['record'] },
        { path: 'rtsp://127.0.0.1:8554/porch_sub', roles: ['detect'] },
      ],
    },
    detect: { enabled: true, fps: 7 },
    objects: { track: ['person', 'car'] },
    // Tapo wired: ONVIF on port 2020 with the stream account by default.
    onvif: { host: '192.168.1.20', port: 2020, user: 'u', password: 'p' },
  });
});

test('one stream: detect and record; Tapo battery: its input args and 640x360', () => {
  const built = buildCameraConfig(
    camera(
      { label: 'garden', model: 'tapo-battery', host: '192.168.1.30', password: 'x' },
      'garden',
    ),
  );
  assert.deepEqual(built.section.ffmpeg.inputs, [
    {
      path: 'rtsp://127.0.0.1:8554/garden',
      input_args: TAPO_INPUT_ARGS,
      roles: ['detect', 'record'],
    },
  ]);
  assert.deepEqual(built.section.detect, { enabled: true, fps: 5, width: 640, height: 360 });
  assert.deepEqual(built.section.objects, { track: ['person'] }, 'person by default');
  assert.equal(built.section.friendly_name, undefined, 'label = name: no friendly name');
  assert.equal(built.section.onvif, undefined, 'no ONVIF on battery Tapo');
});

test('onvif: declared only where expected, never for D-Link HTTP control', () => {
  const onvif = (record) => buildCameraConfig(camera(record)).section.onvif;
  // Generic RTSP: Frigate would retry a missing endpoint forever.
  assert.equal(
    onvif({ model: 'generic-rtsp', host: 'h', path: 's', username: 'u', password: 'p' }),
    undefined,
  );
  assert.deepEqual(
    onvif({
      model: 'generic-rtsp',
      host: 'h',
      path: 's',
      username: 'u',
      password: 'p',
      onvifPort: 8899,
    }),
    { host: 'h', port: 8899, user: 'u', password: 'p' },
  );
  assert.equal(
    onvif({ model: 'dlink-dcs-8302lh', host: 'h', username: 'admin', password: 'p' }),
    undefined,
  );
  assert.equal(
    onvif({ model: 'dlink-dcs-5020l', host: 'h', username: 'admin', password: 'p', onvifPort: 80 }),
    undefined,
    'proprietary HTTP control',
  );
  assert.equal(onvif({ model: 'tapo-wired', host: 'h' }), undefined, 'no credentials');
  // Literal braces would be read as {FRIGATE_*} substitutions by Frigate.
  assert.deepEqual(
    onvif({
      model: 'reolink-rtsp',
      host: 'h',
      username: 'u',
      password: 'p{x}',
      onvifPassword: 'c{1}',
    }),
    { host: 'h', port: 8000, user: 'u', password: 'c{{1}}' },
  );
});

// ---- Store ------------------------------------------------------------------

test('the camera store: private file, records, removal, applied list', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-cameras-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'managed', 'cameras.json');
  const store = createCamerasStore({ filePath });
  assert.deepEqual(await store.cameras(), {});
  assert.deepEqual(await store.applied(), []);
  await store.put('porch', { label: 'Porch', model: 'tapo-wired', password: 'secret' });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600, 'camera passwords: 0600');
  assert.equal((await stat(join(dir, 'managed'))).mode & 0o777, 0o700);
  await store.setApplied(['porch']);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.applied, ['porch']);
  assert.equal(saved.cameras.porch.model, 'tapo-wired');

  // A fresh store reads the file back.
  const again = createCamerasStore({ filePath });
  assert.equal((await again.get('porch')).label, 'Porch');
  assert.equal(await again.remove('porch'), true);
  assert.equal(await again.remove('porch'), false);
  assert.deepEqual(await again.applied(), ['porch'], 'kept until config.yml is written');
});

test('a corrupt camera store is reported, never overwritten', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-cameras-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'cameras.json');
  await writeFile(filePath, '{ not json');
  const store = createCamerasStore({ filePath });
  await assert.rejects(store.cameras(), CamerasStoreError);
  await assert.rejects(store.put('x', {}), CamerasStoreError);
  assert.equal(await readFile(filePath, 'utf8'), '{ not json');
});
