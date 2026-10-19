import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { BrowserBridge } from '../server/src/bridge.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    socket.once('error', () => {});
  });
}

function until(predicate, timeout = 3000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch {
        // Keep polling.
      }
      if (Date.now() - started > timeout) {
        reject(new Error('Timed out waiting for condition.'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('bridge accepts only extension/no-origin clients', async () => {
  const bridge = new BrowserBridge({ port: 0, logger: () => {} });
  await bridge.start();
  try {
    const bad = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: 'https://example.com' });
    const closed = await waitClose(bad);
    assert.equal(closed.code, 4003);
  } finally {
    await bridge.close();
  }
});

test('bridge completes hello and request/response lifecycle', async () => {
  const bridge = new BrowserBridge({ port: 0, logger: () => {} });
  await bridge.start();
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  try {
    await waitOpen(socket);

    const ready = once(bridge, 'ready');
    socket.send(JSON.stringify({
      type: 'hello',
      version: 'test',
      extensionId: 'test-extension'
    }));
    await ready;
    assert.equal(bridge.ready, true);
    assert.equal(bridge.hello.extensionId, 'test-extension');

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'request') return;
      if (message.method === 'fail') {
        socket.send(JSON.stringify({
          type: 'response',
          id: message.id,
          ok: false,
          error: { message: 'expected failure', code: 'EXPECTED' }
        }));
        return;
      }
      socket.send(JSON.stringify({
        type: 'response',
        id: message.id,
        ok: true,
        result: { method: message.method, params: message.params }
      }));
    });

    const result = await bridge.request('echo', { value: 42 });
    assert.deepEqual(result, { method: 'echo', params: { value: 42 } });

    await assert.rejects(
      bridge.request('fail'),
      (error) => error.code === 'EXPECTED' && /expected failure/.test(error.message)
    );

    const status = bridge.status();
    assert.equal(status.connected, true);
    assert.equal(status.ready, true);
    assert.equal(status.pendingRequests, 0);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test('bridge rejects a wrong token', async () => {
  const bridge = new BrowserBridge({ port: 0, token: 'correct-horse', logger: () => {} });
  await bridge.start();
  try {
    const bad = new WebSocket(`ws://127.0.0.1:${bridge.port}?token=wrong`);
    const closed = await waitClose(bad);
    assert.equal(closed.code, 4001);

    const good = new WebSocket(`ws://127.0.0.1:${bridge.port}?token=correct-horse`);
    await waitOpen(good);
    good.close();
    await waitClose(good);
  } finally {
    await bridge.close();
  }
});
