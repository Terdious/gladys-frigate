// The "Cameras" button of the managed mode (src/gladys/cameraActions.js
// through the session): its add / edit / remove / list operations, and its
// refusal in remote mode. Gladys and the Frigate client
// are in-memory fakes; the files go to a temporary data folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { normalizeConfig } from '../src/config.js';
import { CAMERA_TEXT } from '../src/gladys/cameraActions.js';
import { setup } from './helpers/managedSession.js';
import { waitFor } from './helpers/waitFor.js';

const PASSWORD = 'Cam-Secret@42';
const TAPO = {
  label: 'Porch',
  model: 'tapo-wired',
  host: '192.168.1.20',
  username: 'tapocam',
  password: PASSWORD,
  objects: 'person, car',
  detect_fps: 5,
};

/** A managed session with Frigate running and connected. */
async function running(t, options) {
  const context = await setup(t, options);
  await context.apply();
  context.frigate.up = true;
  await context.session.startFrigate();
  await waitFor(() => context.last()?.connected === true, { what: 'connected' });
  return context;
}

const restarts = (gladys) =>
  gladys.calls.filter(([verb]) => verb === 'restart' || verb === 'start').length;
const config = async (configPath) => parse(await readFile(configPath, 'utf8'));
const store = async (dataDir) =>
  JSON.parse(await readFile(join(dataDir, 'managed', 'cameras.json'), 'utf8'));

test('add: stored (0600), written to config.yml, Frigate restarted, the answer guides', async (t) => {
  const { session, gladys, configPath, dataDir, logs, last } = await running(t);
  const before = restarts(gladys);
  const answer = await session.cameras({ operation: 'add', ...TAPO });

  assert.match(answer.en, /^Camera "Porch" \(porch\) added to Frigate\./);
  assert.match(answer.fr, /^Caméra "Porch" \(porch\) ajoutée à Frigate\./);
  assert.match(answer.en, /\nStreams: rtsp:\/\/\*\*\*@192\.168\.1\.20:554\/stream1 \(recording\)/);
  assert.match(answer.en, /Objects: person, car — detection at 5 fps/);
  assert.match(answer.en, /camera account/, 'the note of the model');
  assert.match(answer.en, /Frigate restarts to apply it \(about 30 s/);
  assert.match(answer.en, /Discover tab → Scan → Add to Gladys/);
  assert.match(answer.fr, /onglet Découverte → Scanner → Ajouter à Gladys/);
  assert.ok(!answer.en.includes(PASSWORD) && !answer.fr.includes(PASSWORD), 'no password');
  assert.ok(!answer.en.includes('Cam-Secret'), 'not even encoded');

  const saved = await store(dataDir);
  assert.equal(saved.cameras.porch.model, 'tapo-wired');
  assert.deepEqual(saved.cameras.porch.objects, ['person', 'car']);
  assert.deepEqual(saved.applied, ['porch']);
  assert.equal((await stat(join(dataDir, 'managed', 'cameras.json'))).mode & 0o777, 0o600);

  const file = await config(configPath);
  assert.deepEqual(file.go2rtc.streams.porch, [
    'rtsp://tapocam:Cam-Secret%4042@192.168.1.20:554/stream1',
  ]);
  assert.deepEqual(file.cameras.porch.objects, { track: ['person', 'car'] });
  assert.equal(file.cameras.porch.onvif.port, 2020);

  assert.equal(restarts(gladys), before + 1, 'restarted once');
  assert.ok(!logs.some((line) => line.includes('Cam-Secret')), 'never logged');
  // Frigate comes back: connected again, with the managed count.
  await waitFor(() => /Added from Gladys: 1/.test(last()?.message?.en ?? ''), {
    what: 'the count in the status',
  });
});

test('add: what the form cannot make into a camera is refused, nothing written', async (t) => {
  const { session, gladys, dataDir } = await running(t);
  const before = restarts(gladys);
  const refusals = [
    [{ ...TAPO, label: '' }, CAMERA_TEXT.LABEL_REQUIRED],
    [{ ...TAPO, label: '***' }, CAMERA_TEXT.LABEL_UNUSABLE],
    [{ ...TAPO, model: 'nope' }, CAMERA_TEXT.UNKNOWN_MODEL],
    [{ ...TAPO, host: 'rtsp://192.168.1.20' }, CAMERA_TEXT.BAD_HOST],
    [{ ...TAPO, host: '192.168.1.20:554' }, CAMERA_TEXT.BAD_HOST],
    [{ ...TAPO, host: undefined }, CAMERA_TEXT.missing_host],
    [{ ...TAPO, username: undefined }, CAMERA_TEXT.PASSWORD_WITHOUT_USER],
    [
      { label: 'Garden', model: 'tapo-battery', host: '192.168.1.30' },
      CAMERA_TEXT.missing_password,
    ],
    [{ label: 'Hub', model: 'custom' }, CAMERA_TEXT.missing_custom_source],
    [{ ...TAPO, tapo_auth_variant: 'md5' }, CAMERA_TEXT.BAD_VARIANT],
    [{ ...TAPO, objects: ' , ' }, CAMERA_TEXT.NO_OBJECT],
  ];
  for (const [fields, expected] of refusals) {
    assert.deepEqual(
      await session.cameras({ operation: 'add', ...fields }),
      expected,
      JSON.stringify(fields),
    );
  }
  const unknown = await session.cameras({ operation: 'add', ...TAPO, objects: 'person, persn' });
  assert.match(unknown.en, /Frigate does not detect: persn\. Common objects: person, car/);
  const fps = await session.cameras({ operation: 'add', ...TAPO, detect_fps: 40 });
  assert.match(fps.en, /between 1 and 15/);
  const port = await session.cameras({ operation: 'add', ...TAPO, port: 70000 });
  assert.match(port.en, /stream port must be a whole number/);
  assert.deepEqual(await session.cameras(undefined), CAMERA_TEXT.NO_FORM);

  await assert.rejects(readFile(join(dataDir, 'managed', 'cameras.json')), { code: 'ENOENT' });
  assert.equal(restarts(gladys), before, 'never restarted');
});

test('add: a name already used, here or in the Frigate UI, is refused', async (t) => {
  const { session, configPath } = await running(t);
  await session.cameras({ operation: 'add', ...TAPO });
  const twice = await session.cameras({ operation: 'add', ...TAPO, label: 'PORCH' });
  assert.match(twice.en, /A camera named porch already exists: use the operation "Edit a camera"/);
  // A camera and a stream the user added in the Frigate UI.
  const file = await config(configPath);
  file.cameras.garage = { ffmpeg: { inputs: [{ path: 'rtsp://x/1', roles: ['detect'] }] } };
  file.go2rtc.streams.yard = ['rtsp://x/2'];
  await writeFile(configPath, stringify(file));
  for (const label of ['Garage', 'Yard', 'Porch sub', 'birdseye']) {
    const answer = await session.cameras({ operation: 'add', ...TAPO, label });
    assert.match(answer.en, /already|already used/, label);
  }
});

test('add while Frigate is stopped: written, applied at the next start', async (t) => {
  const { session, apply, gladys, configPath } = await setup(t);
  await apply();
  const answer = await session.cameras({
    operation: 'add',
    label: 'Garden',
    model: 'tapo-battery',
    host: '192.168.1.30',
    password: 'cloud-pw',
  });
  assert.match(answer.en, /Frigate is stopped: the change applies at its next start/);
  assert.match(answer.en, /PERMANENTLY POWERED/, 'battery warning');
  assert.match(answer.fr, /ALIMENTÉE EN PERMANENCE/);
  assert.match(answer.en, /Stream: tapo:\/\/\*\*\*@192\.168\.1\.30\?channel=0&subtype=1\./);
  assert.ok(!gladys.calls.some(([verb]) => verb === 'restart' || verb === 'start'));
  const file = await config(configPath);
  assert.deepEqual(file.cameras.garden.detect, { enabled: true, fps: 5, width: 640, height: 360 });

  // Start Frigate: the camera is there.
  await session.startFrigate();
  assert.ok((await config(configPath)).go2rtc.streams.garden);
});

test('edit: by the device select; blank keeps, - empties, objects and fps replace', async (t) => {
  const { session, gladys, configPath, dataDir } = await running(t);
  await session.cameras({ operation: 'add', ...TAPO });
  const before = restarts(gladys);
  const answer = await session.cameras({
    operation: 'edit',
    camera: 'ext:frigate:camera:porch',
    label: 'Front porch',
    objects: 'person, dog',
    detect_fps: 3,
    sub_path: '-',
  });
  assert.match(answer.en, /^Camera "Front porch" \(porch\) updated\./);
  assert.match(answer.en, /Stream: rtsp:\/\/\*\*\*@192\.168\.1\.20:554\/stream1\./);
  assert.match(answer.en, /Objects: person, dog — detection at 3 fps/);
  assert.match(answer.en, /Frigate restarts/);
  assert.equal(restarts(gladys), before + 1);

  const record = (await store(dataDir)).cameras.porch;
  assert.equal(record.host, '192.168.1.20', 'blank host kept');
  assert.equal(record.password, PASSWORD, 'blank password kept');
  assert.equal(record.subPath, '');
  const file = await config(configPath);
  assert.equal(file.cameras.porch.friendly_name, 'Front porch');
  assert.deepEqual(file.cameras.porch.detect, { enabled: true, fps: 3 });
  assert.deepEqual(Object.keys(file.go2rtc.streams), ['porch'], 'single stream now');

  // The same values again: nothing to restart.
  const same = await session.cameras({ operation: 'edit', name: 'porch', detect_fps: 3 });
  assert.match(same.en, /already had it: nothing to restart/);
  assert.equal(restarts(gladys), before + 1);
});

test('edit / remove: the camera must be one added from Gladys', async (t) => {
  const { session, configPath } = await running(t);
  assert.deepEqual(await session.cameras({ operation: 'edit' }), CAMERA_TEXT.TARGET_REQUIRED);
  const file = await config(configPath);
  file.cameras.garage = { ffmpeg: { inputs: [{ path: 'rtsp://x/1', roles: ['detect'] }] } };
  await writeFile(configPath, stringify(file));
  assert.match(
    (await session.cameras({ operation: 'edit', name: 'garage' })).en,
    /added in the Frigate UI/,
  );
  assert.match(
    (await session.cameras({ operation: 'remove', name: 'nothing' })).en,
    /No camera nothing/,
  );
});

test('remove: out of the store and of config.yml, recordings kept, Frigate restarted', async (t) => {
  const { session, gladys, configPath, dataDir } = await running(t);
  await session.cameras({ operation: 'add', ...TAPO });
  await session.cameras({ operation: 'add', ...TAPO, label: 'Garden', host: '192.168.1.21' });
  const before = restarts(gladys);
  const answer = await session.cameras({ operation: 'remove', name: 'Porch' });
  assert.match(answer.en, /^Camera "Porch" \(porch\) removed from Frigate\./);
  assert.match(answer.en, /recordings already made stay/);
  assert.match(answer.en, /Frigate restarts to apply it/);
  assert.equal(restarts(gladys), before + 1);
  const file = await config(configPath);
  assert.equal(file.cameras.porch, undefined);
  assert.equal(file.go2rtc.streams.porch, undefined);
  assert.equal(file.go2rtc.streams.porch_sub, undefined);
  assert.ok(file.cameras.garden, 'the other managed camera stays');
  const saved = await store(dataDir);
  assert.deepEqual(Object.keys(saved.cameras), ['garden']);
  assert.deepEqual(saved.applied, ['garden']);
});

test('list: the managed cameras (no credential) and the UI ones; list is the default', async (t) => {
  const { session, configPath } = await running(t);
  const empty = await session.cameras({ operation: 'list' });
  assert.equal(empty.en, 'No camera added from Gladys yet: use the operation "Add a camera".');
  await session.cameras({ operation: 'add', ...TAPO });
  const file = await config(configPath);
  file.cameras.garage = { ffmpeg: { inputs: [{ path: 'rtsp://x/1', roles: ['detect'] }] } };
  await writeFile(configPath, stringify(file));
  // The fields of another operation are ignored.
  const answer = await session.cameras({ ...TAPO, operation: 'list' });
  assert.match(
    answer.en,
    /^Cameras added from Gladys \(1\):\n- "Porch" \(porch\) — TP-Link Tapo — wired/,
  );
  assert.match(answer.en, /192\.168\.1\.20, objects: person, car, 5 fps/);
  assert.match(answer.en, /\nCameras added in the Frigate UI \(left as they are\): garage\./);
  assert.match(answer.fr, /Caméras ajoutées depuis Gladys \(1\) :/);
  assert.ok(!answer.en.includes(PASSWORD) && !answer.en.includes('tapocam:'));
  assert.deepEqual(await session.cameras({}), answer, 'no operation: list');
  assert.deepEqual(await session.cameras({ operation: 'rename' }), CAMERA_TEXT.UNKNOWN_OPERATION);
});

test('Test the connection gives the number of managed cameras', async (t) => {
  const { session } = await running(t);
  await session.cameras({ operation: 'add', ...TAPO });
  const answer = await session.testConnection();
  assert.match(answer.en, /Cameras added from Gladys: 1\./);
  assert.match(answer.fr, /Caméras ajoutées depuis Gladys : 1\./);
});

test('remote mode: the Cameras button refuses, nothing is read nor written', async (t) => {
  const { session, gladys, dataDir } = await setup(t);
  const raw = { frigate_url: 'https://192.168.1.10:8971', username: 'u', password: 'p' };
  await session.apply(normalizeConfig(raw), raw);
  for (const operation of ['add', 'edit', 'remove', 'list']) {
    assert.deepEqual(
      await session.cameras({ ...TAPO, operation }),
      CAMERA_TEXT.ONLY_MANAGED,
      operation,
    );
  }
  assert.deepEqual(gladys.calls, []);
  await assert.rejects(readFile(join(dataDir, 'managed', 'cameras.json')), { code: 'ENOENT' });
});
