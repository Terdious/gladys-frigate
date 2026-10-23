// -----------------------------------------------------------------------------
// Resource advice of the managed Frigate: what its cameras need, compared
// with the caps of the sub-container (CONTAINER_LIMITS, the manifest values).
//
// The core gives a sub-container fixed maximums whatever the machine (4 GB,
// 2 CPU, 512 MB of shared memory): beyond a handful of cameras, Frigate runs
// out of /dev/shm (its decoded frames live there) or of memory, and the
// remote mode (Frigate installed by hand, sized for the machine) is the way
// out until the core allows machine-relative limits (core issues #12, #14).
//
// Heuristics, not measurements:
//   - shm: 256 MB for one camera (Docker's 64 MB default crashes Frigate,
//     256 MB was validated with one camera on the core branches), plus 64 MB
//     per extra camera: the `computeShmSize` of the Gladys frigate-pr5 branch;
//   - RAM: 1 GB for Frigate itself (go2rtc, nginx, the recorder), 256 MB per
//     camera (ffmpeg decoding, the tracked objects), 512 MB more when the
//     detection runs on the CPU (the model in the main memory, frames queued
//     for a slower detector).
//
// Pure, no Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { parse } from 'yaml';
import { CONTAINER_LIMITS } from './constants.js';

export const SHM_BASE_MB = 256;
export const SHM_PER_EXTRA_CAMERA_MB = 64;
export const MEMORY_BASE_MB = 1024;
export const MEMORY_PER_CAMERA_MB = 256;
export const MEMORY_CPU_DETECTION_MB = 512;
// Two CPUs at most: CPU detection on more cameras than this skips frames.
const CPU_DETECTION_CAMERAS = 2;

const count = (cameras) => Math.max(0, Math.floor(Number(cameras) || 0));

/** Shared memory (MB) Frigate needs for `cameraCount` cameras. */
export function computeShmMb(cameraCount) {
  return SHM_BASE_MB + SHM_PER_EXTRA_CAMERA_MB * Math.max(0, count(cameraCount) - 1);
}

/**
 * Memory (MB) advised for Frigate (heuristic, see the header).
 * @param {object} options
 * @param {number} options.cameras
 * @param {string} [options.detector] the detector kind (`cpu`, `edgetpu_usb`…)
 */
export function recommendedMemoryMb({ cameras, detector }) {
  return (
    MEMORY_BASE_MB +
    MEMORY_PER_CAMERA_MB * count(cameras) +
    (detector === 'cpu' ? MEMORY_CPU_DETECTION_MB : 0)
  );
}

/** The most cameras that fit in the limits (shm and RAM), for this detector. */
export function maxCameras({ detector, limits = CONTAINER_LIMITS }) {
  let cameras = 0;
  while (
    cameras < 1000 &&
    computeShmMb(cameras + 1) <= limits.shmMb &&
    recommendedMemoryMb({ cameras: cameras + 1, detector }) <= limits.memoryMb
  ) {
    cameras += 1;
  }
  return cameras;
}

/**
 * @param {object} options
 * @param {number} options.cameras number of cameras of Frigate
 * @param {string} [options.detector] the detector kind
 * @param {{ memoryMb: number, cpu: number, shmMb: number }} [options.limits]
 */
export function resourceAdvice({ cameras, detector, limits = CONTAINER_LIMITS }) {
  const n = count(cameras);
  const shmMb = computeShmMb(n);
  const memoryMb = recommendedMemoryMb({ cameras: n, detector });
  const overShm = shmMb > limits.shmMb;
  const overMemory = memoryMb > limits.memoryMb;
  return {
    cameras: n,
    detector: detector ?? null,
    shmMb,
    memoryMb,
    limits,
    overShm,
    overMemory,
    overLimits: overShm || overMemory,
    cpuBound: detector === 'cpu' && n > CPU_DETECTION_CAMERAS,
    maxCameras: maxCameras({ detector, limits }),
  };
}

/** "3 cameras: recommended shm 384 MB (limit 512), RAM 1792 MB (limit 4096)." */
function summary(advice) {
  const { cameras: n, shmMb, memoryMb, limits } = advice;
  return {
    en: `${n} camera${n > 1 ? 's' : ''}: recommended shm ${shmMb} MB (limit ${limits.shmMb}), RAM ${memoryMb} MB (limit ${limits.memoryMb})`,
    fr: `${n} caméra${n > 1 ? 's' : ''} : shm conseillée ${shmMb} Mo (limite ${limits.shmMb}), RAM ${memoryMb} Mo (limite ${limits.memoryMb})`,
  };
}

function overText(advice) {
  return {
    en: `above the limits of the Gladys sandbox (${advice.maxCameras} cameras at most here): prefer the remote mode until the Gladys core allows machine-relative limits (see ROADMAP, issues #12/#14)`,
    fr: `au-delà des limites du bac à sable de Gladys (${advice.maxCameras} caméras au plus ici) : préférez le mode distant tant que le core de Gladys ne permet pas des limites relatives à la machine (voir ROADMAP, issues #12/#14)`,
  };
}

/**
 * The advice as lines (diagnostics report): the needs, then what to do when
 * they exceed the limits.
 * @param {ReturnType<typeof resourceAdvice>} advice
 * @returns {Array<{ en: string, fr: string }>}
 */
export function describeAdvice(advice) {
  const head = summary(advice);
  const lines = [{ en: `${head.en}.`, fr: `${head.fr}.` }];
  if (advice.overLimits) {
    const over = overText(advice);
    lines.push({
      en: `${over.en[0].toUpperCase()}${over.en.slice(1)}.`,
      fr: `${over.fr[0].toUpperCase()}${over.fr.slice(1)}.`,
    });
  }
  if (advice.cpuBound) {
    lines.push({
      en: `CPU detection on ${advice.cameras} cameras with ${advice.limits.cpu} CPU at most: expect skipped frames (a Coral or an Intel GPU helps).`,
      fr: `Détection sur CPU pour ${advice.cameras} caméras avec ${advice.limits.cpu} CPU au plus : attendez-vous à des images sautées (un Coral ou un GPU Intel aide).`,
    });
  }
  return lines;
}

/** The advice in one sentence ("Test the connection" in managed mode). */
export function adviceSentence(advice) {
  const head = summary(advice);
  if (!advice.overLimits) {
    return { en: `Resources: ${head.en}.`, fr: `Ressources : ${head.fr}.` };
  }
  const over = overText(advice);
  return {
    en: `Resources: ${head.en}, ${over.en}.`,
    fr: `Ressources : ${head.fr}, ${over.fr}.`,
  };
}

/**
 * Number of cameras declared in a config.yml content (0 when unreadable):
 * the advice is still due when Frigate does not answer, which is when the
 * shared memory is the likely culprit.
 * @param {string} content
 */
export function countConfigCameras(content) {
  try {
    const cameras = parse(content ?? '')?.cameras;
    return cameras !== null && typeof cameras === 'object' && !Array.isArray(cameras)
      ? Object.keys(cameras).length
      : 0;
  } catch {
    return 0;
  }
}
