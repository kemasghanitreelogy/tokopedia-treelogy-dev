import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchWithTimeout, TimeoutError, TIMEOUTS } from '../src/http.js';

/**
 * A fetch with no deadline is not "slow", it is stuck.
 *
 * This is written against a real socket rather than a stubbed fetch, because the thing
 * being tested is exactly what a stub cannot reproduce: a server that accepts the
 * connection, answers nothing, and never closes. That is what held `mekari:images` for
 * 78 minutes at 0% CPU, and what kept the daily job sitting in "activating".
 */
async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    return await run(url);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a server that never answers gives up instead of hanging', async () => {
  await withServer(
    () => {}, // accepts the request, writes nothing, never ends
    async (url) => {
      const started = Date.now();
      await assert.rejects(
        () => fetchWithTimeout(url, { timeout: 150 }),
        (error) => {
          assert.ok(error instanceof TimeoutError);
          assert.equal(error.timeout, true);
          return true;
        },
      );
      assert.ok(Date.now() - started < 3000, 'harus berhenti sendiri, bukan menunggu selamanya');
    },
  );
});

test('the message names the endpoint without leaking its query string', async () => {
  const error = new TimeoutError('https://api.example.com/v1/orders?token=rahasia', 30_000);
  assert.match(error.message, /30 detik/);
  assert.match(error.message, /api\.example\.com\/v1\/orders/);
  assert.ok(!error.message.includes('rahasia'), 'query string tidak boleh ikut ke log');
});

test('a response that arrives in time is returned untouched', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    async (url) => {
      const response = await fetchWithTimeout(url, { timeout: 5000 });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    },
  );
});

test('a caller that brought its own signal keeps control of it', async () => {
  await withServer(
    () => {},
    async (url) => {
      const controller = new AbortController();
      const inflight = fetchWithTimeout(url, { signal: controller.signal, timeout: 50 });
      // The 50ms timeout is deliberately ignored, so nothing settles until we abort.
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      await assert.rejects(() => inflight, (error) => error.name === 'AbortError');
    },
  );
});

test('a download is given a longer deadline than an API call', () => {
  // A 2-megapixel product photo over a slow line is not the same kind of wait as a JSON
  // read, and giving them one budget means either cutting downloads short or letting a
  // stuck API call sit for two minutes.
  assert.ok(TIMEOUTS.download > TIMEOUTS.api);
});
