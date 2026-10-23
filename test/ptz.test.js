import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_MOVE,
  normalizePtzInfo,
  ptzPayloadForMove,
  ptzPayloadForPreset,
  ptzTopic,
  supportedMoves,
} from '../src/frigate/ptz.js';

test('Gladys movement values map to the Frigate PTZ payloads', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(ptzPayloadForMove), [
    'STOP',
    'MOVE_LEFT',
    'MOVE_RIGHT',
    'MOVE_UP',
    'MOVE_DOWN',
    'ZOOM_IN',
    'ZOOM_OUT',
  ]);
  // Gladys may send the value as a string.
  assert.equal(ptzPayloadForMove('2'), 'MOVE_RIGHT');
  for (const value of [7, -1, 1.5, 'left', null, undefined, '', true, NaN]) {
    assert.equal(ptzPayloadForMove(value), null, `${value} is no movement`);
  }
});

test('the values mirror the core CAMERA_MOVE enum', () => {
  assert.deepEqual(CAMERA_MOVE, {
    STOP: 0,
    PAN_LEFT: 1,
    PAN_RIGHT: 2,
    TILT_UP: 3,
    TILT_DOWN: 4,
    ZOOM_IN: 5,
    ZOOM_OUT: 6,
  });
});

test('presets are recalled by name; the topic carries the camera', () => {
  assert.equal(ptzPayloadForPreset('Garden'), 'preset_Garden');
  assert.equal(ptzPayloadForPreset('front_door'), 'preset_front_door');
  assert.equal(ptzPayloadForPreset(''), null);
  assert.equal(ptzPayloadForPreset(undefined), null);
  assert.equal(ptzTopic('front'), 'front/ptz');
});

test('supported movements follow the continuous features Frigate reports', () => {
  assert.deepEqual(supportedMoves(['pt', 'zoom', 'pt-r', 'zoom-r']), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(supportedMoves(['pt', 'pt-r-fov']), [1, 2, 3, 4]);
  assert.deepEqual(supportedMoves(['zoom']), [5, 6]);
  // Relative or absolute only: Frigate refuses MOVE_* and ZOOM_* on them.
  assert.deepEqual(supportedMoves(['pt-r', 'zoom-r', 'zoom-a']), []);
  assert.deepEqual(supportedMoves(undefined), []);
});

test('the ptz info is read defensively', () => {
  assert.deepEqual(
    normalizePtzInfo({ name: 'front', features: ['pt', 3, 'pt'], presets: ['A', '', 'B', 'A'] }),
    { features: ['pt'], presets: ['A', 'B'] },
  );
  assert.deepEqual(normalizePtzInfo(null), { features: [], presets: [] });
  assert.deepEqual(normalizePtzInfo({ features: 'pt' }), { features: [], presets: [] });
});
