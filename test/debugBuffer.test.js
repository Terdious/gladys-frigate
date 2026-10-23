// The debug ring buffer of the real-time feed and the answer of "Show the
// last real-time messages" (src/frigate/debugBuffer.js, src/frigate/diagnostics.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEBUG_BUFFER_SIZE,
  createDebugBuffer,
  payloadText,
  redactSecrets,
} from '../src/frigate/debugBuffer.js';
import { formatDebugMessages } from '../src/frigate/diagnostics.js';

const clock = (start = Date.parse('2026-10-23T14:02:11Z')) => {
  let time = start;
  return () => new Date((time += 1000));
};

test('text payloads are kept, JSON values of the WebSocket serialized', () => {
  assert.equal(payloadText(Buffer.from('ON')), 'ON');
  assert.equal(payloadText('online'), 'online');
  assert.equal(payloadText(3), '3');
  assert.equal(
    payloadText({ type: 'new', after: { id: 'x' } }),
    '{"type":"new","after":{"id":"x"}}',
  );
  assert.equal(payloadText(undefined), '');
});

test('payloads are cut at 2000 characters, the full length told', () => {
  const text = payloadText('a'.repeat(2500));
  assert.ok(text.startsWith('a'.repeat(2000)));
  assert.ok(!text.startsWith('a'.repeat(2001)));
  assert.match(text, /… \[truncated, 2500 characters\]$/);
  assert.equal(payloadText('a'.repeat(2000)), 'a'.repeat(2000));
});

test('binary payloads (JPEG, not UTF-8) are replaced by their size', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1200, 0x41)]);
  assert.equal(payloadText(jpeg), '[binary, 1204 bytes]');
  assert.equal(payloadText(Buffer.from([0xc3, 0x28, 0x41])), '[binary, 3 bytes]');
  assert.equal(payloadText(Buffer.from([0x41, 0x00, 0x42])), '[binary, 3 bytes]');
  assert.equal(payloadText(new Uint8Array([0x4f, 0x4e])), 'ON');
});

test('credentials in payloads are masked, topics naming one are not stored', () => {
  assert.equal(
    redactSecrets('{"user":"a","mqtt_password":"hunter2","token": "abc.def"}'),
    '{"user":"a","mqtt_password":"***","token": "***"}',
  );
  assert.equal(redactSecrets('path?token=abc&x=1'), 'path?token=***&x=1');
  assert.equal(
    redactSecrets('rtsp://admin:pw@192.168.1.5:554/stream'),
    'rtsp://***@192.168.1.5:554/stream',
  );
  const buffer = createDebugBuffer({ now: clock() });
  buffer.record('front/password', 'x');
  buffer.record('front/motion', 'ON');
  assert.deepEqual(
    buffer.entries().map((entry) => entry.topic),
    ['front/motion'],
  );
  assert.equal(buffer.received, 2, 'a dropped message still counts as received');
});

test('a huge payload is cut quickly, whatever its content', () => {
  const start = process.hrtime.bigint();
  const text = payloadText('A'.repeat(256 * 1024) + '@');
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.match(text, /… \[truncated, 262145 characters\]$/);
  assert.ok(ms < 200, `${ms} ms`);
});

test('the buffer keeps the last 200 messages, newest first, with ISO times', () => {
  const buffer = createDebugBuffer({ now: clock() });
  assert.equal(buffer.lastAt, null);
  for (let i = 1; i <= 250; i += 1) buffer.record(`front/person`, String(i));
  const entries = buffer.entries();
  assert.equal(entries.length, DEBUG_BUFFER_SIZE);
  assert.equal(entries[0].payload, '250');
  assert.equal(entries.at(-1).payload, '51');
  assert.match(entries[0].received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(buffer.entries(50).length, 50);
  assert.equal(buffer.received, 250);
  assert.equal(buffer.lastAt.toISOString(), entries[0].received_at);
});

test('the debug answer lists HH:MM:SS topic payload, newest first, 50 at most', () => {
  const buffer = createDebugBuffer({ now: clock() });
  for (let i = 1; i <= 60; i += 1) buffer.record('front/motion', i % 2 ? 'ON' : 'OFF');
  buffer.record('events', '{"type":"new",\n"after":{}}');
  const source = { en: 'MQTT broker 192.168.1.20:1883', fr: 'broker MQTT 192.168.1.20:1883' };
  const answer = formatDebugMessages(buffer.entries(50), { received: buffer.received, source });
  const lines = answer.en.split('\n');
  assert.match(lines[0], /^Last 50 of 61 real-time messages .*MQTT broker 192\.168\.1\.20:1883/);
  assert.equal(lines[1], '');
  assert.equal(lines[2], '14:03:12 events {"type":"new", "after":{}}', 'one line per message');
  assert.equal(lines[3], '14:03:11 front/motion OFF');
  assert.equal(lines.length, 2 + 50);
  assert.match(answer.fr, /^50 derniers des 61 messages temps réel/);
});

test('the debug answer stays under its size cap and says what it left out', () => {
  const buffer = createDebugBuffer({ now: clock() });
  for (let i = 0; i < 50; i += 1) buffer.record('events', 'x'.repeat(2000));
  const answer = formatDebugMessages(buffer.entries(50), {
    received: 50,
    source: { en: 'Frigate WebSocket', fr: 'WebSocket de Frigate' },
  });
  assert.ok(answer.en.length < 21_000, `${answer.en.length} characters`);
  assert.match(answer.en, /… \d+ older messages left out \(answer size\)\.$/);
  assert.match(answer.fr, /messages plus anciens omis/);
});

test('an empty buffer says nothing was received yet', () => {
  const answer = formatDebugMessages([], {
    received: 0,
    source: { en: 'Frigate WebSocket', fr: 'WebSocket de Frigate' },
  });
  assert.match(answer.en, /^No real-time message received yet \(Frigate WebSocket\)/);
  assert.match(answer.fr, /^Aucun message temps réel reçu/);
});
