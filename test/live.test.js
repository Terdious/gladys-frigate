import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';
import { liveRtspUrl, resolveLiveRtsp } from '../src/gladys/live.js';

const remote = (raw) => normalizeConfig({ frigate_url: 'https://192.168.1.10:8971', ...raw });
const managed = (raw) => ({ ...remote(raw), mode: 'managed' });

test('the live URL is the go2rtc restream of the camera, without credentials', () => {
  assert.equal(
    liveRtspUrl({ host: 'frigate.lan', port: 8554 }, 'front'),
    'rtsp://frigate.lan:8554/front',
  );
  assert.equal(
    liveRtspUrl({ host: '192.168.1.10', port: 8554 }, 'back yard'),
    'rtsp://192.168.1.10:8554/back%20yard',
  );
  // IPv6 literals are bracketed once, whether the brackets came with them or not.
  assert.equal(
    liveRtspUrl({ host: 'fe80::1', port: 8554 }, 'front'),
    'rtsp://[fe80::1]:8554/front',
  );
  assert.equal(
    liveRtspUrl({ host: '[fe80::1]', port: 8554 }, 'front'),
    'rtsp://[fe80::1]:8554/front',
  );
});

test('remote mode: the host of the Frigate URL and port 8554 by default', () => {
  assert.deepEqual(resolveLiveRtsp(remote()), { host: '192.168.1.10', port: 8554 });
  assert.deepEqual(resolveLiveRtsp(remote({ frigate_url: 'http://frigate.lan:5000/' })), {
    host: 'frigate.lan',
    port: 8554,
  });
  assert.deepEqual(resolveLiveRtsp(remote({ live_rtsp_port: '18554' })), {
    host: '192.168.1.10',
    port: 18554,
  });
  // An explicit `mode: 'remote'` behaves like the configurations saved before it existed.
  assert.deepEqual(resolveLiveRtsp({ ...remote(), mode: 'remote' }), {
    host: '192.168.1.10',
    port: 8554,
  });
});

test('remote mode: an IPv6 Frigate URL keeps its brackets', () => {
  const target = resolveLiveRtsp(remote({ frigate_url: 'https://[fd00::10]:8971' }));
  assert.deepEqual(target, { host: '[fd00::10]', port: 8554 });
  assert.equal(liveRtspUrl(target, 'front'), 'rtsp://[fd00::10]:8554/front');
});

test('remote mode: an explicit host wins over the Frigate URL', () => {
  assert.deepEqual(resolveLiveRtsp(remote({ live_rtsp_host: ' 192.168.1.20 ' })), {
    host: '192.168.1.20',
    port: 8554,
  });
});

test('remote mode: no usable Frigate URL, no live URL', () => {
  assert.equal(resolveLiveRtsp(normalizeConfig()), null);
  assert.equal(resolveLiveRtsp(remote({ frigate_url: 'not a url' })), null);
  assert.equal(resolveLiveRtsp(null), null);
});

test('managed mode: 127.0.0.1 and the host port assigned by Gladys', () => {
  assert.deepEqual(resolveLiveRtsp(managed(), { managedHostPort: 32768 }), {
    host: '127.0.0.1',
    port: 32768,
  });
  // The remote port option does not apply: the published host port does.
  assert.deepEqual(resolveLiveRtsp(managed({ live_rtsp_port: 9554 }), { managedHostPort: 32768 }), {
    host: '127.0.0.1',
    port: 32768,
  });
  assert.deepEqual(
    resolveLiveRtsp(managed({ live_rtsp_host: 'nas.lan' }), { managedHostPort: 32768 }),
    { host: 'nas.lan', port: 32768 },
  );
});

test('managed mode: an unknown host port publishes no live URL', () => {
  assert.equal(resolveLiveRtsp(managed()), null);
  assert.equal(resolveLiveRtsp(managed(), { managedHostPort: null }), null);
  assert.equal(resolveLiveRtsp(managed(), { managedHostPort: 0 }), null);
  assert.equal(resolveLiveRtsp(managed(), { managedHostPort: 70000 }), null);
});
