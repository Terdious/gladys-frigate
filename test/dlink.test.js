// D-Link HTTP controls (src/frigate/dlink.js): the requests of the pan/tilt
// steps and of the night mode, and how they are sent — against a local fake
// D-Link camera (basic auth checked), never the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  DLINK_MOVES,
  dlinkControlsOf,
  dlinkMoveRequest,
  dlinkNightModeRequest,
  dlinkTargetOf,
  sendDlink,
} from '../src/frigate/dlink.js';
import {
  DlinkCredentialsError,
  DlinkHttpError,
  DlinkUnreachableError,
} from '../src/frigate/errors.js';
import { resolveCamera } from '../src/frigate/managed/cameraSources.js';
import { CAMERA_MOVE } from '../src/frigate/ptz.js';
import { DLINK_ADMIN, startFakeDlink } from './helpers/fakeDlink.js';

test('pan/tilt: one 5° step per direction, nothing for STOP, zoom or other values', () => {
  const cell = (move) => new URLSearchParams(dlinkMoveRequest(move).body).get('PanTiltSingleMove');
  assert.deepEqual(
    [CAMERA_MOVE.TILT_UP, CAMERA_MOVE.PAN_LEFT, CAMERA_MOVE.PAN_RIGHT, CAMERA_MOVE.TILT_DOWN].map(
      cell,
    ),
    ['1', '3', '5', '7'],
  );
  assert.deepEqual(dlinkMoveRequest('2'), {
    method: 'POST',
    path: '/pantiltcontrol.cgi',
    body: 'PanSingleMoveDegree=5&TiltSingleMoveDegree=5&PanTiltSingleMove=5',
  });
  for (const value of [CAMERA_MOVE.STOP, CAMERA_MOVE.ZOOM_IN, CAMERA_MOVE.ZOOM_OUT, 7, null, '']) {
    assert.equal(dlinkMoveRequest(value), null, `${value} sends nothing`);
  }
  assert.deepEqual(DLINK_MOVES, [1, 2, 3, 4], 'pan and tilt, no zoom');
});

test('night mode: infrared forced (3) or automatic (0), without reboot', () => {
  assert.deepEqual(dlinkNightModeRequest(true), {
    method: 'GET',
    path: '/daynight.cgi?DayNightMode=3&ConfigReboot=no',
  });
  assert.equal(dlinkNightModeRequest(false).path, '/daynight.cgi?DayNightMode=0&ConfigReboot=no');
});

test('sendDlink: basic auth with the control account, form body for a move', async (t) => {
  const camera = await startFakeDlink(t);
  const target = { host: '127.0.0.1', port: camera.port, ...DLINK_ADMIN };
  await sendDlink(target, dlinkMoveRequest(CAMERA_MOVE.PAN_LEFT));
  await sendDlink(target, dlinkNightModeRequest(true));
  assert.deepEqual(
    camera.requests.map(({ method, url, body, type }) => [method, url, body, type]),
    [
      [
        'POST',
        '/pantiltcontrol.cgi',
        'PanSingleMoveDegree=5&TiltSingleMoveDegree=5&PanTiltSingleMove=3',
        'application/x-www-form-urlencoded',
      ],
      ['GET', '/daynight.cgi?DayNightMode=3&ConfigReboot=no', '', undefined],
    ],
  );
  assert.ok(
    camera.requests.every((r) => !r.url.includes(DLINK_ADMIN.password)),
    'never in the URL',
  );
});

test('sendDlink: a refused account, missing credentials, no answer', async (t) => {
  const camera = await startFakeDlink(t);
  const request = dlinkNightModeRequest(false);
  await assert.rejects(
    sendDlink({ host: '127.0.0.1', port: camera.port, username: 'user', password: 'x' }, request),
    (err) => err instanceof DlinkHttpError && err.status === 401,
  );
  for (const credentials of [
    { username: 'admin', password: '' },
    { username: '', password: 'p' },
  ]) {
    await assert.rejects(
      sendDlink({ host: '127.0.0.1', port: camera.port, ...credentials }, request),
      DlinkCredentialsError,
    );
  }
  assert.equal(camera.requests.length, 1, 'nothing sent without credentials');

  const silent = await startFakeDlink(t, { hang: true });
  await assert.rejects(
    sendDlink({ host: '127.0.0.1', port: silent.port, ...DLINK_ADMIN, timeoutMs: 100 }, request),
    (err) => err instanceof DlinkUnreachableError && err.code === 'TIMEOUT',
  );
  // A closed port: refused, never a credential in the message.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(sendDlink({ host: '127.0.0.1', port, ...DLINK_ADMIN }, request), (err) => {
    assert.ok(err instanceof DlinkUnreachableError);
    assert.equal(err.code, 'ECONNREFUSED');
    assert.ok(!err.message.includes(DLINK_ADMIN.password));
    return true;
  });
});

test('the controls and the target of a managed camera come from the catalog and its record', () => {
  const dlink = (record) => resolveCamera('desk', { model: 'dlink-dcs-5020l', ...record });
  assert.deepEqual(dlinkControlsOf(dlink({ host: 'h' })), { ptz: true, nightMode: true });
  assert.equal(dlinkControlsOf(resolveCamera('c', { model: 'reolink-rtsp', host: 'h' })), null);
  // The stream account stands in for the control one; port 80 by default.
  assert.deepEqual(dlinkTargetOf(dlink({ host: '192.168.1.50', username: 'u', password: 'p' })), {
    host: '192.168.1.50',
    port: 80,
    username: 'u',
    password: 'p',
  });
  assert.deepEqual(
    dlinkTargetOf(
      dlink({
        host: '192.168.1.50',
        port: 8080,
        username: 'u',
        password: 'p',
        onvifUsername: 'admin',
        onvifPassword: 'pin',
      }),
    ),
    { host: '192.168.1.50', port: 8080, username: 'admin', password: 'pin' },
  );
});
