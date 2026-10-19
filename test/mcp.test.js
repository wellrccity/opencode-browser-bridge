import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==';

function waitOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.once('error', () => {});
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

function textOf(result) {
  return (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function connectMockExtension(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const welcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock extension did not receive welcome')), 5000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(message);
      }
    };
    socket.on('message', onMessage);
  });

  const requests = [];
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type !== 'request') return;
    requests.push(message);

    const respond = (result) => {
      socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true, result, elapsedMs: 1 }));
    };
    const fail = (text, code = 'MOCK_ERROR') => {
      socket.send(JSON.stringify({
        type: 'response',
        id: message.id,
        ok: false,
        error: { message: text, code },
        elapsedMs: 1
      }));
    };

    const tab = {
      id: 1,
      windowId: 1,
      index: 0,
      active: true,
      pinned: false,
      status: 'complete',
      title: 'Test page',
      url: message.params && message.params.url ? message.params.url : 'https://example.com/'
    };

    switch (message.method) {
      case 'status':
        respond({
          extensionVersion: '0.1.0',
          extensionId: 'mock-extension',
          wsState: 'connected',
          connected: true,
          serverUrl: `ws://127.0.0.1:${port}`,
          hasToken: false,
          autoConnect: true,
          preferCdp: true,
          keepAttached: true,
          interceptDialogs: true,
          lastError: null,
          lastServerSeen: Date.now(),
          activeTabId: 1,
          tabs: [tab],
          debuggerTabs: []
        });
        break;
      case 'navigate':
        respond({
          tab,
          action: message.params.action || 'goto',
          requestedUrl: message.params.url,
          beforeUrl: 'about:blank',
          waitUntil: 'load',
          elapsedMs: 5
        });
        break;
      case 'screenshot':
        respond({
          tab,
          frameId: 0,
          image: { base64: onePixelPng, mimeType: 'image/png', width: 1, height: 1 },
          width: 1,
          height: 1,
          fullPage: false,
          annotated: false,
          grid: false,
          target: null
        });
        break;
      case 'dom':
        fail('Element not found for selector #missing', 'NOT_FOUND');
        break;
      default:
        respond({ ok: true, method: message.method });
        break;
    }
  });

  return { socket, welcome, requests };
}

test('MCP server exposes tools and relays browser commands', { timeout: 30000 }, async () => {
  const port = await freePort();
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['server/src/index.js'],
    cwd: root,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      OPENCODE_BROWSER_HOST: '127.0.0.1',
      OPENCODE_BROWSER_PORT: String(port),
      OPENCODE_BROWSER_TOKEN: ''
    }
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({ name: 'browser-bridge-test', version: '1.0.0' }, { capabilities: {} });
  let mock = null;

  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      'status', 'tabs', 'navigate', 'snapshot', 'screenshot', 'click', 'type', 'press',
      'hover', 'select', 'scroll', 'wait_for', 'evaluate', 'dom', 'fill_form', 'upload_file',
      'console', 'network', 'cookies', 'dialog', 'highlight', 'drag', 'emulate', 'debugger'
    ]) {
      assert.ok(names.includes(name), `missing tool "${name}" (got: ${names.join(', ')})\n${stderr}`);
    }

    const disconnected = await client.callTool({ name: 'status', arguments: {} });
    assert.match(textOf(disconnected), /Bridge: disconnected/, stderr);

    mock = connectMockExtension(port);
    await waitOpen(mock.socket);
    mock.socket.send(JSON.stringify({ type: 'hello', version: 'test', extensionId: 'mock-extension' }));
    await mock.welcome;

    const status = await client.callTool({ name: 'status', arguments: {} });
    const statusText = textOf(status);
    assert.match(statusText, /Bridge: connected/, statusText + stderr);
    assert.match(statusText, /Tabs \(1\)/, statusText);
    assert.match(statusText, /Test page/, statusText);

    const navigation = await client.callTool({
      name: 'navigate',
      arguments: { url: 'https://example.org/', waitUntil: 'load' }
    });
    assert.match(textOf(navigation), /example\.org/, textOf(navigation));

    const screenshot = await client.callTool({ name: 'screenshot', arguments: {} });
    assert.ok(Array.isArray(screenshot.content));
    assert.ok(screenshot.content.some((item) => item.type === 'image' && item.data === onePixelPng));

    const failedDom = await client.callTool({
      name: 'dom',
      arguments: { selector: '#missing' }
    });
    assert.equal(failedDom.isError, true);
    assert.match(textOf(failedDom), /Element not found/, textOf(failedDom));
    assert.equal(mock.requests.some((request) => request.method === 'dom'), true);

    mock.socket.close();
    await waitClose(mock.socket);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterDisconnect = await client.callTool({ name: 'status', arguments: {} });
    assert.match(textOf(afterDisconnect), /Bridge: disconnected/, textOf(afterDisconnect));
  } finally {
    if (mock) {
      try {
        mock.socket.close();
      } catch {
        // Ignore.
      }
    }
    await client.close().catch(() => {});
  }
});
