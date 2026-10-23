// "Propose a camera to the catalog": the pre-filled GitHub issue link
// (src/frigate/proposal.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROPOSAL_URL_LENGTH, anonymize, buildProposal } from '../src/frigate/proposal.js';

const params = (url) => new URL(url).searchParams;

test('the link opens a new issue on the repository, labelled cameras', () => {
  const { url, title } = buildProposal({
    brand: 'Reolink',
    model: 'RLC-510A',
    sourceType: 'rtsp',
    notes: 'Main stream: /h264Preview_01_main & sub: /h264Preview_01_sub (100% OK)',
    frigateVersion: '0.18.0-abc',
    integrationVersion: '0.4.0',
    mode: 'managed',
  });
  assert.ok(url.startsWith('https://github.com/Terdious/gladys-frigate/issues/new?title='));
  assert.equal(title, 'Frigate camera catalog: Reolink RLC-510A');
  assert.equal(params(url).get('title'), title);
  assert.equal(params(url).get('labels'), 'cameras');
  const body = params(url).get('body');
  assert.match(body, /- Brand: Reolink\n- Model: RLC-510A\n- Source type: rtsp/);
  assert.match(body, /Main stream: \/h264Preview_01_main & sub: \/h264Preview_01_sub \(100% OK\)/);
  assert.match(body, /- Frigate: 0\.18\.0-abc\n- Integration: 0\.4\.0 \(managed mode\)/);
  // Encoded: no raw space, &, # or line break in the URL.
  assert.doesNotMatch(url.split('?')[1], /[ \n#]|&(?!body=|labels=)/);
});

test('credentials and addresses of the notes never reach the link', () => {
  const { url } = buildProposal({
    brand: 'Tapo',
    model: 'C200',
    sourceType: 'tapo',
    notes:
      'rtsp://admin:S3cretPw@192.168.1.42:554/stream1 works; password=hunter2; host 10.0.0.7, firmware 1.0.2.30',
  });
  const body = params(url).get('body');
  for (const secret of ['S3cretPw', 'hunter2', '192.168.1.42', '10.0.0.7', 'admin:']) {
    assert.ok(!url.includes(encodeURIComponent(secret)) && !body.includes(secret), secret);
  }
  assert.match(
    body,
    /rtsp:\/\/\*\*\*@<address>:554\/stream1 works; password=\*\*\*; host <address>/,
  );
  assert.match(body, /firmware 1\.0\.2\.30/, 'a firmware version is not an address');
});

test('the link fits in the GitHub URL limit, long notes are shortened', () => {
  const result = buildProposal({
    brand: 'Dahua',
    model: 'IPC-HDW',
    sourceType: 'onvif',
    notes: 'é'.repeat(5000),
  });
  assert.ok(result.url.length <= MAX_PROPOSAL_URL_LENGTH, `${result.url.length}`);
  assert.equal(result.shortened, true);
  assert.match(params(result.url).get('body'), /é…\n/);
  const short = buildProposal({ brand: 'A', model: 'B', notes: 'ok' });
  assert.equal(short.shortened, false);
});

test('an unknown source type reads as custom, names stay on one line', () => {
  const { url, title } = buildProposal({ brand: ' Foo\nBar ', model: 'X1', sourceType: 'weird' });
  assert.equal(title, 'Frigate camera catalog: Foo Bar X1');
  assert.match(params(url).get('body'), /- Source type: custom/);
  assert.match(params(url).get('body'), /_None\._/);
});

test('emoji cut in the middle never breaks the encoding', () => {
  const result = buildProposal({ brand: '📷'.repeat(60), model: 'X', notes: '📷'.repeat(5000) });
  assert.ok(result.url.length <= MAX_PROPOSAL_URL_LENGTH);
  assert.doesNotThrow(() => decodeURIComponent(result.url));
});

test('anonymize masks IPv6 addresses too', () => {
  assert.equal(anonymize('http://[fe80::1]:8971/x'), 'http://<address>/x');
});
