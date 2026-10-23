import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion,
  readCapabilities,
  readPtzCapabilities,
  versionAtLeast,
} from '../src/frigate/capabilities.js';
import { UnsupportedVersionError } from '../src/frigate/errors.js';
import { FRIGATE_CONFIG, FRIGATE_CONFIG_PTZ, FRONT_PTZ_INFO } from './helpers/fakeFrigate.js';

test('parseVersion reads the version Frigate reports', () => {
  assert.deepEqual(parseVersion('0.16.4-4131252'), {
    major: 0,
    minor: 16,
    patch: 4,
    raw: '0.16.4-4131252',
  });
  assert.equal(parseVersion('"0.18.0"').minor, 18);
  assert.equal(parseVersion('0.17').patch, 0);
  assert.equal(parseVersion('dev'), null);
  assert.ok(versionAtLeast(parseVersion('0.17.0'), parseVersion('0.16.9')));
  assert.ok(!versionAtLeast(parseVersion('0.15.9'), parseVersion('0.16.0')));
});

test('Frigate before 0.16, or an unreadable version, is refused', () => {
  assert.throws(() => readCapabilities('0.15.2', FRIGATE_CONFIG), UnsupportedVersionError);
  assert.throws(() => readCapabilities('', FRIGATE_CONFIG), UnsupportedVersionError);
});

test('cameras are normalized from the configuration, missing fields read as off', () => {
  const { cameras, mqtt } = readCapabilities('0.16.4', FRIGATE_CONFIG);
  assert.deepEqual(
    cameras.map((camera) => camera.name),
    ['front', 'garage'],
  );
  const [front, garage] = cameras;
  assert.equal(front.friendlyName, 'Front door');
  assert.deepEqual([front.detect, front.record, front.snapshots], [true, true, true]);
  assert.deepEqual(front.zones, [{ name: 'porch', friendlyName: 'porch', objects: ['person'] }]);
  assert.equal(garage.friendlyName, 'garage');
  assert.deepEqual([garage.record, garage.snapshots, garage.audio], [false, false, false]);
  assert.deepEqual(garage.objects, ['car']);
  assert.deepEqual(mqtt, { enabled: true, host: 'broker', topicPrefix: 'frigate' });
});

test('version-gated topics: camera status from 0.17 only', () => {
  assert.equal(readCapabilities('0.16.4', {}).topics.cameraStatus, false);
  assert.equal(readCapabilities('0.17.2', {}).topics.cameraStatus, true);
  assert.equal(readCapabilities('0.18.0', {}).topics.cameraStatus, true);
  assert.deepEqual(readCapabilities('0.18.0', null).cameras, []);
});

test('ONVIF cameras get their PTZ from /api/<cam>/ptz/info; the others make no request', async () => {
  const asked = [];
  const getPtzInfo = async (camera) => {
    asked.push(camera);
    return FRONT_PTZ_INFO;
  };
  const plain = readCapabilities('0.17.2', FRIGATE_CONFIG);
  await readPtzCapabilities(plain, getPtzInfo);
  assert.deepEqual(asked, [], 'no ONVIF camera, no extra request');
  assert.deepEqual(
    plain.cameras.map((camera) => [camera.onvif, camera.ptz]),
    [
      [false, null],
      [false, null],
    ],
  );

  const ptz = await readPtzCapabilities(readCapabilities('0.17.2', FRIGATE_CONFIG_PTZ), getPtzInfo);
  assert.deepEqual(asked, ['front']);
  const [front, garage] = ptz.cameras;
  assert.equal(front.onvif, true);
  assert.deepEqual(front.ptz, {
    features: ['pt', 'zoom', 'pt-r', 'zoom-r', 'zoom-a'],
    presets: ['Entrance', 'Garden'],
  });
  assert.equal(garage.ptz, null);
});

test('a failed PTZ read leaves the camera without PTZ, or with the previous read', async () => {
  const errors = [];
  const failing = async () => {
    throw new Error('HTTP 500');
  };
  const onError = (camera, err) => errors.push([camera, err.message]);
  const first = await readPtzCapabilities(readCapabilities('0.17.2', FRIGATE_CONFIG_PTZ), failing, {
    onError,
  });
  assert.equal(first.cameras[0].ptz, null);
  assert.deepEqual(errors, [['front', 'HTTP 500']]);
  const previous = new Map([['front', { features: ['pt'], presets: [] }]]);
  const second = await readPtzCapabilities(
    readCapabilities('0.17.2', FRIGATE_CONFIG_PTZ),
    failing,
    {
      previous,
      onError,
    },
  );
  assert.deepEqual(second.cameras[0].ptz, { features: ['pt'], presets: [] });
});
