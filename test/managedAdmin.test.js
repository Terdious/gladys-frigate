import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminBootstrapError } from '../src/frigate/errors.js';
import { generatePassword, setAdminPassword } from '../src/frigate/managed/adminAccount.js';
import { createStateFile } from '../src/frigate/managed/stateFile.js';
import { startFakeFrigate } from './helpers/fakeFrigate.js';

const noWait = async () => {};

test('generated passwords: 24 characters, every class, no look-alike', () => {
  for (let i = 0; i < 50; i += 1) {
    const password = generatePassword();
    assert.equal(password.length, 24);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[2-9]/);
    assert.match(password, /[-_.!@#%+=]/);
    assert.doesNotMatch(password, /[0O1lI"'\\\s]/);
  }
  assert.notEqual(generatePassword(), generatePassword());
});

test('the admin password is set through the internal API, retried while Frigate starts', async (t) => {
  const frigate = await startFakeFrigate({
    account: null,
    adminPasswordStatus: (attempt) => (attempt < 3 ? 502 : 200),
  });
  t.after(() => frigate.close());
  await setAdminPassword({ baseUrl: frigate.url, password: 'Secret-1', wait: noWait });
  assert.deepEqual(frigate.adminPasswords, ['Secret-1', 'Secret-1', 'Secret-1']);
});

test('a refusal is not retried; the error carries no password', async (t) => {
  const frigate = await startFakeFrigate({ account: null, adminPasswordStatus: () => 400 });
  t.after(() => frigate.close());
  await assert.rejects(
    setAdminPassword({ baseUrl: frigate.url, password: 'Secret-2', wait: noWait }),
    (err) =>
      err instanceof AdminBootstrapError && err.status === 400 && !err.message.includes('Secret'),
  );
  assert.equal(frigate.adminPasswords.length, 1);
});

test('no answer at all: bounded attempts', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    setAdminPassword({
      baseUrl: 'http://frigate:5000',
      password: 'x',
      attempts: 4,
      fetchImpl,
      wait: noWait,
    }),
    (err) => err instanceof AdminBootstrapError && err.status === null,
  );
  assert.equal(calls, 4);
});

test('the state file is private (0600 in a 0700 folder) and merged on update', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-frigate-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'managed', 'state.json');
  const state = createStateFile({ filePath });
  assert.deepEqual(await state.read(), {});
  await state.update({ admin_password: 'p' });
  await state.update({ started_at: 'now' });
  assert.deepEqual(await createStateFile({ filePath }).read(), {
    admin_password: 'p',
    started_at: 'now',
  });
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'managed'))).mode & 0o777, 0o700);
  assert.match(await readFile(filePath, 'utf8'), /"admin_password": "p"/);
});
