import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import axios from 'axios';
import { isPublicAddress, assertPublicHttpUrl, guardedHttpAgent, SsrfBlockedError } from './ssrfGuard.js';

test('isPublicAddress: private, loopback, link-local, metadata and mapped addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'ff02::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('isPublicAddress: ordinary public addresses pass', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('assertPublicHttpUrl rejects non-http schemes, credentials, localhost and IP literals', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'http://user:pw@example.com/', 'http://localhost:8080/', 'http://foo.localhost/',
    'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://metadata.internal/', 'not a url']) {
    await assert.rejects(() => assertPublicHttpUrl(u), SsrfBlockedError, u);
  }
});

test('assertPublicHttpUrl accepts a public IP literal', async () => {
  const url = await assertPublicHttpUrl('https://8.8.8.8/x');
  assert.equal(url.hostname, '8.8.8.8');
});

test('guarded agent refuses to connect to a hostname that resolves to loopback (DNS-rebinding backstop)', async () => {
  const server = http.createServer((_req, res) => res.end('secret'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    // "localtest.me"-style names are not reachable offline, so use "localhost" which always resolves to loopback.
    await assert.rejects(
      axios.get(`http://localhost:${port}/`, { httpAgent: guardedHttpAgent, timeout: 3000, maxRedirects: 0 }),
      (err: { code?: string; cause?: { code?: string } }) => err.code === 'ESSRFBLOCKED' || err.cause?.code === 'ESSRFBLOCKED',
    );
  } finally {
    server.close();
  }
});
