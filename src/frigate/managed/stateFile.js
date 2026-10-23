// -----------------------------------------------------------------------------
// Persistent state of the managed mode: /data/managed/state.json.
//
// Holds the admin password Gladys set on Frigate (shown by the "Show the
// Frigate credentials" button), when Frigate was last started by the
// integration, and a hash of the environment passed to the sub-container.
// The file is private to the integration: folder 0700, file 0600, written
// through a temporary file so a crash never leaves half a JSON.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * @param {object} options
 * @param {string} options.filePath /data/managed/state.json
 */
export function createStateFile({ filePath }) {
  let state = null;
  // Updates are serialized: two concurrent read-modify-write cycles (the
  // admin password being saved while a start records its environment) would
  // otherwise lose one of the two keys.
  let queue = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      state = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      state = {};
    }
    return state;
  }

  return {
    filePath,
    /** The whole state ({} when there is none yet). */
    async read() {
      return { ...(await load()) };
    },
    /** Merge `partial` into the state and save it (one update at a time). */
    update(partial) {
      const run = async () => {
        const next = { ...(await load()), ...partial };
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        // writeFile only applies the mode to a new file.
        await chmod(temporary, 0o600);
        await rename(temporary, filePath);
        state = next;
        return { ...next };
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
}
