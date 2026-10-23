// Test-only D-Link camera (DCS-5020L CGIs): records every request and
// answers 200 to its admin account, 401 to anything else (or never, with
// `hang`). Listens on 127.0.0.1 only.

import http from 'node:http';

export const DLINK_ADMIN = Object.freeze({ username: 'admin', password: 'Pin:Code@1' });

/**
 * @param {import('node:test').TestContext} t closes the server after the test
 * @param {{ hang?: boolean, account?: { username: string, password: string } }} [options]
 */
export async function startFakeDlink(t, { hang = false, account = DLINK_ADMIN } = {}) {
  const requests = [];
  const expected = `Basic ${Buffer.from(`${account.username}:${account.password}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body,
        type: req.headers['content-type'],
        authorization: req.headers.authorization,
      });
      if (hang) return;
      res.statusCode = req.headers.authorization === expected ? 200 : 401;
      res.end(res.statusCode === 200 ? 'ok\n' : 'Unauthorized\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return { port: server.address().port, requests };
}
