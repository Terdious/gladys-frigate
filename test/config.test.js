import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import {
  DEFAULT_CONFIG,
  configWarnings,
  explicitRetention,
  isManaged,
  normalizeConfig,
  normalizeFingerprint,
  normalizePem,
  usesMqtt,
  validateConfig,
} from '../src/config.js';
import { describeConfig } from '../src/gladys/status.js';
import { TEST_CA_PEM } from './helpers/certificates.js';

const BASE = { frigate_url: 'https://192.168.1.10:8971', username: 'gladys', password: 'pw' };

test('normalizeConfig applies the defaults to an empty configuration', () => {
  assert.deepEqual(normalizeConfig(), { ...DEFAULT_CONFIG });
});

test('normalizeConfig trims values and clamps numbers', () => {
  const config = normalizeConfig({
    frigate_url: '  https://frigate:8971/// ',
    mqtt_port: 99999,
    min_score: -5,
    trigger_cooldown: 'abc',
    mqtt_topic_prefix: '/frigate/',
  });
  assert.equal(config.frigate_url, 'https://frigate:8971');
  assert.equal(config.mqtt_port, 65535);
  assert.equal(config.min_score, 0);
  assert.equal(config.trigger_cooldown, 30);
  assert.equal(config.mqtt_topic_prefix, 'frigate');
});

test('a blank number keeps the default instead of becoming 0', () => {
  const config = normalizeConfig({ min_score: '  ', mqtt_port: '', trigger_cooldown: null });
  assert.equal(config.min_score, DEFAULT_CONFIG.min_score);
  assert.equal(config.mqtt_port, DEFAULT_CONFIG.mqtt_port);
  assert.equal(config.trigger_cooldown, DEFAULT_CONFIG.trigger_cooldown);
  assert.equal(normalizeConfig({ min_score: 0 }).min_score, 0, 'an explicit 0 is kept');
});

test('booleans only accept a strict true', () => {
  const config = normalizeConfig({ mqtt_tls: 'true', zone_sensors: 1 });
  assert.equal(config.mqtt_tls, false);
  assert.equal(config.zone_sensors, false);
  assert.equal(normalizeConfig({ mqtt_tls: true }).mqtt_tls, true);
});

test('normalizePem re-wraps a certificate pasted on a single line', () => {
  const oneLine = TEST_CA_PEM.replace(/\n/g, ' ');
  const pem = normalizePem(oneLine);
  assert.equal(pem, TEST_CA_PEM.trim());
  assert.doesNotThrow(() => new X509Certificate(pem));
  assert.equal(normalizePem('garbage'), '');
});

test('normalizeFingerprint accepts the common notations', () => {
  const hex = 'ab'.repeat(32);
  const expected = Array(32).fill('AB').join(':');
  assert.equal(normalizeFingerprint(hex), expected);
  assert.equal(normalizeFingerprint(`SHA256 Fingerprint=${expected}`), expected);
  assert.equal(normalizeFingerprint(expected.toLowerCase()), expected);
  assert.equal(normalizeFingerprint(`sha256:${hex}`), expected);
  assert.equal(normalizeFingerprint(Array(32).fill('ab').join(' ')), expected);
  assert.equal(normalizeFingerprint('AB:CD'), '');
});

test('a typical authenticated configuration is valid', () => {
  assert.equal(validateConfig(normalizeConfig(BASE)), null);
});

test('the URL is required, http(s) only, without credentials or query', () => {
  for (const frigate_url of [
    '',
    'frigate.local',
    'ftp://frigate',
    'https://u:p@frigate:8971',
    'https://frigate:8971/?token=x',
  ]) {
    assert.ok(validateConfig(normalizeConfig({ ...BASE, frigate_url })), frigate_url);
  }
});

test('the Frigate username and password go together', () => {
  assert.match(validateConfig(normalizeConfig({ ...BASE, password: '' })).en, /both/);
});

test('the expert TLS fields are optional (trust on first use by default)', () => {
  const config = normalizeConfig(BASE);
  assert.equal(config.tls_fingerprint, '');
  assert.equal(config.tls_ca, '');
  assert.equal(validateConfig(config, BASE), null);
});

test('an expert CA must be a valid PEM certificate', () => {
  const check = (tls_ca) =>
    validateConfig(normalizeConfig({ ...BASE, tls_ca }), { ...BASE, tls_ca });
  assert.match(check('not a certificate').en, /not a valid/);
  assert.match(
    check('-----BEGIN CERTIFICATE-----bm90IGEgY2VydA==-----END CERTIFICATE-----').en,
    /not a valid/,
  );
  assert.equal(check(TEST_CA_PEM), null);
  assert.equal(check(TEST_CA_PEM.replace(/\n/g, ' ')), null, 'a single-line paste is accepted');
});

test('an expert fingerprint must be a SHA-256', () => {
  const check = (tls_fingerprint) =>
    validateConfig(normalizeConfig({ ...BASE, tls_fingerprint }), { ...BASE, tls_fingerprint });
  assert.match(check('AB:CD').en, /64/);
  assert.equal(check('ab'.repeat(32)), null);
});

test('the expert fingerprint and CA are mutually exclusive', () => {
  const raw = { ...BASE, tls_fingerprint: 'ab'.repeat(32), tls_ca: TEST_CA_PEM };
  assert.match(validateConfig(normalizeConfig(raw), raw).en, /not both/);
});

test('MQTT is optional: without a host, the WebSocket feed is used', () => {
  assert.equal(usesMqtt(normalizeConfig(BASE)), false);
  assert.equal(usesMqtt(normalizeConfig({ ...BASE, mqtt_host: 'broker' })), true);
});

test('the MQTT host is a bare host name or IP address', () => {
  const check = (mqtt_host) => validateConfig(normalizeConfig({ ...BASE, mqtt_host }));
  for (const host of ['mqtt://broker', 'broker:1883', 'broker/frigate', 'my broker']) {
    assert.match(check(host)?.en ?? '', /host name or an IP address only/, host);
  }
  for (const host of ['broker', 'broker.lan', '192.168.1.10', 'fe80::1']) {
    assert.equal(check(host), null, host);
  }
});

test('the live view options: trimmed host, clamped port, 8554 by default', () => {
  assert.equal(
    normalizeConfig({ live_rtsp_host: ' 192.168.1.20 ' }).live_rtsp_host,
    '192.168.1.20',
  );
  assert.equal(normalizeConfig({ live_rtsp_port: '' }).live_rtsp_port, 8554);
  assert.equal(normalizeConfig({ live_rtsp_port: 99999 }).live_rtsp_port, 65535);
  assert.equal(normalizeConfig({ live_rtsp_port: '18554' }).live_rtsp_port, 18554);
});

test('the live view host is a bare host name or IP address, without credentials', () => {
  const check = (live_rtsp_host) => validateConfig(normalizeConfig({ ...BASE, live_rtsp_host }));
  for (const host of [
    'rtsp://frigate',
    'frigate:8554',
    'frigate/front',
    'user:pw@frigate',
    '[fe80::1]:8554',
  ]) {
    assert.match(check(host)?.en ?? '', /live view RTSP host/, host);
  }
  for (const host of ['', 'frigate', 'frigate.lan', '192.168.1.10', 'fe80::1', '[fe80::1]']) {
    assert.equal(check(host), null, host);
  }
});

test('the MQTT topic prefix refuses wildcards', () => {
  const error = validateConfig(
    normalizeConfig({ ...BASE, mqtt_host: 'broker', mqtt_topic_prefix: 'frigate/#' }),
  );
  assert.match(error.en, /wildcards/);
});

test('the unauthenticated port and clear-text passwords raise warnings', () => {
  assert.match(configWarnings(normalizeConfig({ frigate_url: 'http://f:5000' }))[0].en, /5000/);
  assert.match(
    configWarnings(normalizeConfig({ ...BASE, frigate_url: 'http://f:8971' }))[0].en,
    /unencrypted/,
  );
  assert.match(
    configWarnings(normalizeConfig({ ...BASE, mqtt_host: 'b', mqtt_password: 'x' }))[0].en,
    /MQTT/,
  );
  assert.deepEqual(configWarnings(normalizeConfig(BASE)), []);
});

test('describeConfig reports the error first, then the warnings', () => {
  assert.equal(describeConfig(normalizeConfig({})).valid, false);
  const insecure = describeConfig(normalizeConfig({ frigate_url: 'http://f:5000' }));
  assert.equal(insecure.valid, true);
  assert.match(insecure.message.fr, /5000/);
  assert.deepEqual(describeConfig(normalizeConfig(BASE)), { valid: true, message: undefined });
});

test('no secret ends up in a status message', () => {
  const raw = { ...BASE, password: 'S3cr3t!', mqtt_host: 'b', mqtt_password: 'MqttS3cr3t' };
  const { message } = describeConfig(normalizeConfig({ ...raw, frigate_url: 'http://f:8971' }));
  for (const text of Object.values(message)) {
    assert.ok(!text.includes('S3cr3t'), 'passwords never appear in messages');
  }
});

test('the CA fixture is a certificate authority', () => {
  assert.equal(new X509Certificate(TEST_CA_PEM).ca, true);
});

test('managed mode: the mode, detector and vendor accept their values only', () => {
  assert.equal(normalizeConfig().mode, 'remote', 'remote by default: today behavior');
  const config = normalizeConfig({ mode: 'managed', detector: 'coral', gpu_vendor: 'amd' });
  assert.equal(isManaged(config), true);
  assert.equal(config.detector, 'coral');
  assert.equal(config.gpu_vendor, 'amd');
  const unknown = normalizeConfig({ mode: 'cloud', detector: 'tpu', gpu_vendor: 'nvidia' });
  assert.deepEqual(
    [unknown.mode, unknown.detector, unknown.gpu_vendor],
    ['remote', 'auto', 'intel'],
  );
});

test('managed mode: retention days are clamped; blank keeps the value of config.yml', () => {
  const config = normalizeConfig({ record_continuous_days: -3, snapshots_retain_days: 99999 });
  assert.equal(config.record_continuous_days, 0);
  assert.equal(config.snapshots_retain_days, 3650);
  assert.deepEqual(explicitRetention({ record_continuous_days: 0, record_alerts_days: '' }), {
    continuous: 0,
    alerts: null,
    detections: null,
    snapshots: null,
  });
});

test('managed mode: no Frigate URL nor account required, the MQTT checks still apply', () => {
  assert.equal(validateConfig(normalizeConfig({ mode: 'managed' })), null);
  assert.equal(validateConfig(normalizeConfig({ mode: 'managed', username: 'half' })), null);
  assert.ok(validateConfig(normalizeConfig({ mode: 'managed', mqtt_host: 'mqtt://broker' })));
  assert.ok(validateConfig(normalizeConfig({ mode: 'remote' })), 'remote still needs its URL');
});

test('managed mode: no "port 5000" warning, a note for MQTT over TLS without authority', () => {
  const internal = { mode: 'managed', frigate_url: 'http://frigate:5000' };
  assert.deepEqual(configWarnings(normalizeConfig(internal)), []);
  const tls = configWarnings(normalizeConfig({ ...internal, mqtt_host: 'b', mqtt_tls: true }));
  assert.equal(tls.length, 1);
  assert.match(tls[0].en, /Frigate only trusts/);
});
