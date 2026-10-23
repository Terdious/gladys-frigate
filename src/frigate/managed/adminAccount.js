// -----------------------------------------------------------------------------
// Admin account of the managed Frigate.
//
// Frigate 0.16+ creates an `admin` user on its first start, with a random
// password it only prints in its logs — which the user cannot read from
// Gladys. The integration sets its own instead, through Frigate's internal
// port (5000: reachable on the private network of the integration only,
// unauthenticated, acting as an admin): `PUT /api/users/admin/password`.
// Frigate answers its API before its user database is always ready, so the
// call is retried a few times.
//
// The password is never logged nor put in a URL or an error message.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import { fetch } from 'undici';
import { AdminBootstrapError } from '../errors.js';
import { ADMIN_USER } from './constants.js';

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
// No quote, backslash or space: the password is shown in a message and
// typed by hand in the Frigate login form.
const SYMBOLS = '-_.!@#%+=';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

/**
 * A random password with every character class (Frigate's password rules
 * may ask for them), without look-alike characters (0/O, 1/l/I).
 * @param {number} [length]
 * @param {(max: number) => number} [random] crypto.randomInt
 */
export function generatePassword(length = 24, random = randomInt) {
  const pick = (set) => set[random(set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher-Yates, so the guaranteed classes are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Set the password of Frigate's admin account.
 * @param {object} options
 * @param {string} options.baseUrl the internal URL, http://frigate:5000
 * @param {string} options.password
 * @param {number} [options.attempts] network errors, 5xx and 404 are retried
 * @param {number} [options.delayMs] between two attempts
 * @param {number} [options.timeoutMs] per attempt
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise} [options.wait]
 * @throws {AdminBootstrapError} refused (4xx) or never answered
 */
export async function setAdminPassword({
  baseUrl,
  password,
  attempts = 6,
  delayMs = 5_000,
  timeoutMs = 10_000,
  fetchImpl = fetch,
  wait = sleep,
}) {
  const url = new URL(`/api/users/${ADMIN_USER}/password`, baseUrl);
  let lastStatus = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ password }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel?.();
      lastStatus = response.status;
      if (response.ok) {
        return;
      }
      // 404: the admin user is not created yet. Other 4xx: a refusal that
      // repeating would not change (a password rule, say).
      retryable = response.status >= 500 || response.status === 404 || response.status === 429;
    } catch {
      lastStatus = null;
    }
    if (!retryable) {
      break;
    }
    if (attempt < attempts) {
      await wait(delayMs);
    }
  }
  throw new AdminBootstrapError(lastStatus);
}
