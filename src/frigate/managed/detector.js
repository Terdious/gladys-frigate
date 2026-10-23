// -----------------------------------------------------------------------------
// Object detector and video decoding of the managed Frigate, decided from the
// hardware the user granted to the sub-container.
//
// The integration cannot look at /dev or /sys from its own container: Gladys
// tells it, per hardware class the manifest requests, whether the user
// granted it and whether the host has it (`GET /container` -> `devices:
// [{ class, granted, available }]`). Only a class both granted and available
// is mounted in the Frigate container, so only those are "usable".
//
// The GPU vendor cannot be read either (the PCI vendor id lives in the
// host's sysfs): the user tells it (`gpu_vendor`). OpenVINO's GPU detector
// only runs on Intel; AMD gets VAAPI decoding with a CPU detector.
//
// Pure: no I/O, no Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { DETECTOR_PRESETS } from './constants.js';

export const DETECTOR_CHOICES = Object.freeze(['auto', 'coral', 'openvino', 'cpu']);
export const GPU_VENDORS = Object.freeze(['intel', 'amd', 'none']);
export const HARDWARE_CLASSES = Object.freeze(['coral-usb', 'coral-pcie', 'gpu']);

/**
 * Per requested class: granted, available, usable (granted and available).
 * @param {Array<{ class: string, granted?: boolean, available?: boolean }>} [devices]
 */
export function hardwareOf(devices = []) {
  const hardware = {};
  for (const name of HARDWARE_CLASSES) {
    const entry = devices.find((device) => device?.class === name);
    const granted = entry?.granted === true;
    const available = entry?.available === true;
    hardware[name] = {
      requested: Boolean(entry),
      granted,
      available,
      usable: granted && available,
    };
  }
  return hardware;
}

/**
 * The detector a hardware set gives in automatic mode: Coral USB, Coral
 * PCIe, Intel GPU (OpenVINO), else the CPU.
 */
function automatic(hardware, gpuVendor) {
  if (hardware['coral-usb'].usable) return 'edgetpu_usb';
  if (hardware['coral-pcie'].usable) return 'edgetpu_pci';
  if (hardware.gpu.usable && gpuVendor === 'intel') return 'openvino';
  return 'cpu';
}

/**
 * @param {object} options
 * @param {string} [options.detector] one of DETECTOR_CHOICES (unknown -> auto)
 * @param {string} [options.gpuVendor] one of GPU_VENDORS (unknown -> intel)
 * @param {Array<{ class: string, granted?: boolean, available?: boolean }>} [options.devices]
 *   the `devices` of the `frigate` entry of `GET /container`
 * @returns {{
 *   kind: 'edgetpu_usb' | 'edgetpu_pci' | 'openvino' | 'cpu',
 *   detectors: object, openvino: boolean, vaapi: boolean, explicit: boolean,
 *   requested: string, fallback: null | 'coral' | 'openvino',
 *   notes: Array<{ code: string, class?: string }>
 * }} `explicit`: the user's own choice applies (it then always overwrites the
 *   detectors section); `fallback`: the choice that could not apply.
 */
export function chooseDetector({ detector = 'auto', gpuVendor = 'intel', devices = [] } = {}) {
  const requested = DETECTOR_CHOICES.includes(detector) ? detector : 'auto';
  const vendor = GPU_VENDORS.includes(gpuVendor) ? gpuVendor : 'intel';
  const hardware = hardwareOf(devices);
  const notes = [];

  for (const name of HARDWARE_CLASSES) {
    const { requested: declared, granted, available } = hardware[name];
    if (declared && available && !granted) notes.push({ code: 'not_granted', class: name });
    if (declared && granted && !available) notes.push({ code: 'not_detected', class: name });
  }

  let kind = null;
  let fallback = null;
  if (requested === 'coral') {
    if (hardware['coral-usb'].usable) kind = 'edgetpu_usb';
    else if (hardware['coral-pcie'].usable) kind = 'edgetpu_pci';
    else fallback = 'coral';
  } else if (requested === 'openvino') {
    if (hardware.gpu.usable && vendor === 'intel') kind = 'openvino';
    else fallback = 'openvino';
  } else if (requested === 'cpu') {
    kind = 'cpu';
  }
  const explicit = kind !== null;
  if (!explicit) {
    kind = automatic(hardware, vendor);
  }
  if (fallback) {
    notes.push({ code: 'fallback', class: fallback });
  }
  if (kind === 'cpu' && requested !== 'cpu') {
    notes.push({ code: 'cpu_only' });
  }

  return {
    kind,
    detectors: structuredClone(DETECTOR_PRESETS[kind]),
    openvino: kind === 'openvino',
    // VAAPI decodes on Intel and AMD render nodes alike.
    vaapi: hardware.gpu.usable && vendor !== 'none',
    explicit,
    requested,
    fallback,
    notes,
  };
}
