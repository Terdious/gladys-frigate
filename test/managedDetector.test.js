import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDetector, hardwareOf } from '../src/frigate/managed/detector.js';

const device = (name, granted, available) => ({ class: name, granted, available });
const usable = (...names) => names.map((name) => device(name, true, true));
const codes = (decision) => decision.notes.map((n) => (n.class ? `${n.code}:${n.class}` : n.code));

test('usable = granted and available, for every requested class', () => {
  const hardware = hardwareOf([
    device('coral-usb', true, true),
    device('coral-pcie', true, false),
    device('gpu', false, true),
  ]);
  assert.equal(hardware['coral-usb'].usable, true);
  assert.equal(hardware['coral-pcie'].usable, false);
  assert.equal(hardware.gpu.usable, false);
  assert.equal(hardwareOf([])['coral-usb'].requested, false);
});

test('automatic cascade: Coral USB, Coral PCIe, Intel GPU, CPU', () => {
  const cases = [
    [usable('coral-usb', 'coral-pcie', 'gpu'), 'edgetpu_usb'],
    [usable('coral-pcie', 'gpu'), 'edgetpu_pci'],
    [usable('gpu'), 'openvino'],
    [[], 'cpu'],
  ];
  for (const [devices, kind] of cases) {
    assert.equal(chooseDetector({ devices }).kind, kind, JSON.stringify(devices));
  }
  assert.deepEqual(chooseDetector({ devices: usable('coral-pcie') }).detectors, {
    coral: { type: 'edgetpu', device: 'pci' },
  });
});

test('every granted/available combination of each class', () => {
  for (const name of ['coral-usb', 'coral-pcie', 'gpu']) {
    for (const granted of [false, true]) {
      for (const available of [false, true]) {
        const decision = chooseDetector({ devices: [device(name, granted, available)] });
        const expected =
          granted && available
            ? { 'coral-usb': 'edgetpu_usb', 'coral-pcie': 'edgetpu_pci', gpu: 'openvino' }[name]
            : 'cpu';
        assert.equal(decision.kind, expected, `${name} granted=${granted} available=${available}`);
        assert.equal(decision.vaapi, name === 'gpu' && granted && available);
        const notes = codes(decision);
        assert.equal(notes.includes(`not_granted:${name}`), available && !granted);
        assert.equal(notes.includes(`not_detected:${name}`), granted && !available);
        assert.equal(notes.includes('cpu_only'), expected === 'cpu');
      }
    }
  }
});

test('the GPU vendor: OpenVINO on Intel only, VAAPI on Intel and AMD, none uses nothing', () => {
  const amd = chooseDetector({ devices: usable('gpu'), gpuVendor: 'amd' });
  assert.equal(amd.kind, 'cpu');
  assert.equal(amd.vaapi, true);
  const none = chooseDetector({ devices: usable('gpu'), gpuVendor: 'none' });
  assert.equal(none.kind, 'cpu');
  assert.equal(none.vaapi, false);
  const intel = chooseDetector({ devices: usable('gpu'), gpuVendor: 'intel' });
  assert.equal(intel.openvino, true);
  assert.equal(intel.vaapi, true);
});

test('an explicit choice applies when its hardware is usable', () => {
  const coral = chooseDetector({ detector: 'coral', devices: usable('coral-pcie', 'gpu') });
  assert.equal(coral.kind, 'edgetpu_pci');
  assert.equal(coral.explicit, true);
  const cpu = chooseDetector({ detector: 'cpu', devices: usable('coral-usb') });
  assert.equal(cpu.kind, 'cpu');
  assert.equal(cpu.explicit, true);
  assert.ok(!codes(cpu).includes('cpu_only'), 'no warning for a CPU the user chose');
  const openvino = chooseDetector({ detector: 'openvino', devices: usable('coral-usb', 'gpu') });
  assert.equal(openvino.kind, 'openvino');
});

test('an explicit choice whose hardware is not usable falls back to auto, and says so', () => {
  const coral = chooseDetector({ detector: 'coral', devices: usable('gpu') });
  assert.equal(coral.kind, 'openvino');
  assert.equal(coral.explicit, false);
  assert.equal(coral.fallback, 'coral');
  assert.ok(codes(coral).includes('fallback:coral'));
  const openvino = chooseDetector({
    detector: 'openvino',
    gpuVendor: 'amd',
    devices: usable('gpu'),
  });
  assert.equal(openvino.kind, 'cpu');
  assert.equal(openvino.fallback, 'openvino');
});

test('unknown values fall back to the defaults', () => {
  const decision = chooseDetector({ detector: 'tpu', gpuVendor: 'nvidia', devices: usable('gpu') });
  assert.equal(decision.requested, 'auto');
  assert.equal(decision.kind, 'openvino', 'unknown vendor = intel');
});
