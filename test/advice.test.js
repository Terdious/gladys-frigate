// Resource advice of the managed Frigate (src/frigate/managed/advice.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adviceSentence,
  computeShmMb,
  countConfigCameras,
  describeAdvice,
  maxCameras,
  recommendedMemoryMb,
  resourceAdvice,
} from '../src/frigate/managed/advice.js';
import { CONTAINER_LIMITS } from '../src/frigate/managed/constants.js';

test('shm: 256 MB plus 64 MB per camera beyond the first', () => {
  assert.equal(computeShmMb(0), 256);
  assert.equal(computeShmMb(1), 256);
  assert.equal(computeShmMb(2), 320);
  assert.equal(computeShmMb(5), 512);
  assert.equal(computeShmMb(6), 576);
  assert.equal(computeShmMb(-3), 256);
});

test('RAM: 1 GB plus 256 MB per camera, 512 MB more with CPU detection', () => {
  assert.equal(recommendedMemoryMb({ cameras: 0, detector: 'edgetpu_usb' }), 1024);
  assert.equal(recommendedMemoryMb({ cameras: 3, detector: 'openvino' }), 1792);
  assert.equal(recommendedMemoryMb({ cameras: 3, detector: 'cpu' }), 2304);
  assert.equal(recommendedMemoryMb({ cameras: 2 }), 1536);
});

test('the shared memory cap allows 5 cameras with the manifest limits', () => {
  assert.equal(maxCameras({ detector: 'edgetpu_usb' }), 5);
  assert.equal(maxCameras({ detector: 'cpu' }), 5);
  assert.equal(maxCameras({ detector: 'cpu', limits: { memoryMb: 2048, cpu: 2, shmMb: 1024 } }), 2);
});

test('within the limits: one line with the needs and the limits', () => {
  const advice = resourceAdvice({ cameras: 3, detector: 'edgetpu_usb' });
  assert.equal(advice.overLimits, false);
  assert.equal(advice.limits, CONTAINER_LIMITS);
  assert.deepEqual(describeAdvice(advice), [
    {
      en: '3 cameras: recommended shm 384 MB (limit 512), RAM 1792 MB (limit 4096).',
      fr: '3 caméras : shm conseillée 384 Mo (limite 512), RAM 1792 Mo (limite 4096).',
    },
  ]);
  assert.equal(
    adviceSentence(advice).en,
    'Resources: 3 cameras: recommended shm 384 MB (limit 512), RAM 1792 MB (limit 4096).',
  );
});

test('above the limits: prefer the remote mode until the core allows more', () => {
  const advice = resourceAdvice({ cameras: 8, detector: 'cpu' });
  assert.equal(advice.overShm, true);
  assert.equal(advice.overMemory, false);
  const lines = describeAdvice(advice);
  assert.equal(lines.length, 3);
  assert.match(lines[1].en, /^Above the limits of the Gladys sandbox \(5 cameras at most here\)/);
  assert.match(lines[1].en, /prefer the remote mode .* \(see ROADMAP, issues #12\/#14\)\.$/);
  assert.match(lines[1].fr, /préférez le mode distant/);
  assert.match(lines[2].en, /^CPU detection on 8 cameras with 2 CPU at most/);
  const sentence = adviceSentence(advice);
  assert.match(sentence.en, /^Resources: 8 cameras: .*, above the limits .*#12\/#14\)\.$/);
  assert.equal(sentence.en.split('\n').length, 1, 'one line in "Test the connection"');
});

test('the cameras of a config.yml are counted, an unreadable one gives 0', () => {
  assert.equal(countConfigCameras('cameras:\n  front: {}\n  garage: {}\n'), 2);
  assert.equal(countConfigCameras('mqtt:\n  enabled: false\n'), 0);
  assert.equal(countConfigCameras(''), 0);
  assert.equal(countConfigCameras('cameras: [unclosed'), 0);
});
