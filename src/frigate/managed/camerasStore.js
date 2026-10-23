// -----------------------------------------------------------------------------
// The cameras managed from Gladys: /data/managed/cameras.json.
//
//   { "version": 1,
//     "cameras": { "<frigate name>": { label, model, host, username,
//                  password, path, subPath, port, onvifPort, ... } },
//     "applied": ["<frigate name>", ...] }
//
// `cameras` holds what the user typed (./cameraSources.js resolves it with
// the catalog preset). `applied` is the list of the cameras last written to
// config.yml: a name there but no longer in `cameras` was removed by the
// user, so its sections are deleted from config.yml at the next generation —
// while a camera the user added in the Frigate UI, never in this file, is
// never touched.
//
// The file holds camera passwords: folder 0700, file 0600, written through a
// temporary file so a crash never leaves half a JSON. A file that does not
// parse is reported, never overwritten (the user would lose every camera).
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CamerasStoreError } from '../errors.js';

export const STORE_VERSION = 1;

const isMap = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {object} options
 * @param {string} options.filePath /data/managed/cameras.json
 */
export function createCamerasStore({ filePath }) {
  let data = null;

  async function load() {
    if (data) return data;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        data = { version: STORE_VERSION, cameras: {}, applied: [] };
        return data;
      }
      throw new CamerasStoreError({ cause: err });
    }
    if (!isMap(parsed) || !isMap(parsed.cameras ?? {})) {
      throw new CamerasStoreError();
    }
    data = {
      version: STORE_VERSION,
      cameras: { ...(parsed.cameras ?? {}) },
      applied: Array.isArray(parsed.applied)
        ? parsed.applied.filter((name) => typeof name === 'string')
        : [],
    };
    return data;
  }

  async function save(next) {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    // writeFile only applies the mode to a new file.
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    data = next;
  }

  return {
    filePath,

    /** Every managed camera, { name: record } (a copy). */
    async cameras() {
      return structuredClone((await load()).cameras);
    },

    /** One record (a copy), or null. */
    async get(name) {
      const record = (await load()).cameras[name];
      return record ? structuredClone(record) : null;
    },

    /** The cameras written to config.yml by the last generation. */
    async applied() {
      return [...(await load()).applied];
    },

    /** Create or replace a camera. */
    async put(name, record) {
      const current = await load();
      await save({ ...current, cameras: { ...current.cameras, [name]: structuredClone(record) } });
    },

    /** Remove a camera; false when it was not managed. */
    async remove(name) {
      const current = await load();
      if (!current.cameras[name]) return false;
      const cameras = { ...current.cameras };
      delete cameras[name];
      await save({ ...current, cameras });
      return true;
    },

    /** Record what config.yml now holds (written only when it changed). */
    async setApplied(names) {
      const current = await load();
      const sorted = [...names].sort();
      if (JSON.stringify(sorted) === JSON.stringify([...current.applied].sort())) return;
      await save({ ...current, applied: sorted });
    },
  };
}
