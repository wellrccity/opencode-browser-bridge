#!/usr/bin/env node
/*
 * OpenCode Browser Bridge - MCP server entrypoint.
 *
 * OpenCode starts this process over stdio. It also listens on a loopback
 * WebSocket port for the Chrome extension. Nothing is ever written to stdout
 * except MCP protocol messages.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserBridge } from './bridge.js';
import { registerTools } from './tools.js';

const VERSION = '0.1.2';

const INSTRUCTIONS = `Controls a real Google Chrome browser through the "OpenCode Browser Bridge" extension.

Tool access: in Code Mode call tools.chrome.<tool>({...}) inside execute, e.g. await tools.chrome.status({}) or await tools.chrome.snapshot({ tabId }). With codemode:false the same tools appear directly as chrome_*.

Workflow: chrome_status -> chrome_navigate (or chrome_tabs action="new") -> chrome_snapshot for refs like f0_e12 -> chrome_click/type/select/press/hover -> chrome_wait_for -> chrome_snapshot. Prefer snapshots over screenshots; use chrome_dom for HTML/styles/rects and chrome_evaluate for structured extraction.

Key rules:
- Pass an explicit tabId when other tabs or windows are open.
- Refs encode their frame (f123_e4 = frame 123). Take a fresh snapshot when a ref goes stale. Use allFrames=true for iframes.
- Input uses trusted CDP by default and shows Chrome's debug banner; trusted=false uses synthetic DOM events. Full-page/element screenshots, evaluate, uploads and emulation require CDP.
- Defaults favor speed: clicks are not human-like and navigation waits for domcontentloaded. Pass human=true or waitUntil="load"/"networkidle" when a site needs it.
- Dialogs are intercepted; inspect them with chrome_dialog. Chrome blocks chrome:// pages and the Web Store.
- Coordinates are viewport CSS pixels. Confirm irreversible actions (purchase, delete, send) with the user first.
- The extension can read and modify everything in the browser. Never exfiltrate cookies, tokens or personal data.

See the browser-control skill for recipes and troubleshooting.`;

function stderr(message) {
  process.stderr.write(`[browser-bridge] ${message}\n`);
}

async function main() {
  const port = Number(process.env.OPENCODE_BROWSER_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid OPENCODE_BROWSER_PORT: ${process.env.OPENCODE_BROWSER_PORT}`);
  }
  const host = process.env.OPENCODE_BROWSER_HOST || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopback && process.env.OPENCODE_BROWSER_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing to listen on ${host}. Use OPENCODE_BROWSER_ALLOW_REMOTE=1 only if you understand the risk.`);
  }
  const token = process.env.OPENCODE_BROWSER_TOKEN || '';

  const bridge = new BrowserBridge({
    host,
    port,
    token,
    requestTimeout: Number(process.env.OPENCODE_BROWSER_REQUEST_TIMEOUT || 30000)
  });

  bridge.on('ready', (hello) => {
    stderr(`extension ready: v${hello.version} (${hello.extensionId || 'unknown id'})`);
  });
  bridge.on('disconnect', ({ code }) => {
    stderr(`extension disconnected (code ${code}); waiting for reconnection`);
  });
  bridge.on('event', (event) => {
    if (event.event === 'dialog') {
      stderr(`dialog in tab ${event.data && event.data.tabId}: ${event.data && event.data.type} accepted=${event.data && event.data.accepted}`);
    }
  });

  await bridge.start();

  const server = new McpServer(
    { name: 'chrome', version: VERSION },
    { instructions: INSTRUCTIONS }
  );
  registerTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  stderr(`MCP server ready. Extension endpoint: ws://${host}:${port}${token ? ' (token required)' : ''}`);
  stderr('Load the extension from the "extension" folder, then click its toolbar icon to verify the connection.');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stderr(`shutting down (${signal})`);
    try {
      await bridge.close();
    } catch {
      // Ignore.
    }
    try {
      await server.close();
    } catch {
      // Ignore.
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  stderr(`fatal: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
