/*
 * Local WebSocket bridge between the MCP server and the Chrome extension.
 *
 * Security model:
 *  - listens on loopback only (default 127.0.0.1)
 *  - rejects web-page origins; only chrome-extension:// (or no Origin) is allowed
 *  - optional shared token (OPENCODE_BROWSER_TOKEN / extension settings)
 *  - a single active extension connection; a new one replaces the old one
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

function log(message, ...args) {
  const suffix = args.length ? ' ' + args.map((value) => {
    try {
      return typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(' ') : '';
  process.stderr.write(`[browser-bridge] ${message}${suffix}\n`);
}

export class BridgeError extends Error {
  constructor(message, code = 'BRIDGE_ERROR', details) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export class BrowserBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    const requestedPort = Number(options.port);
    this.port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 8787;
    this.token = options.token || '';
    this.logger = options.logger || log;
    this.requestTimeout = Number(options.requestTimeout) || 30000;
    this.wss = null;
    this.client = null;
    this.hello = null;
    this.connectedAt = null;
    this.lastSeen = 0;
    this.pending = new Map();
    this.heartbeat = null;
  }

  async start() {
    if (this.wss) return this;
    this.wss = new WebSocketServer({
      host: this.host,
      port: this.port,
      maxPayload: 64 * 1024 * 1024,
      clientTracking: true
    });

    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.wss.on('error', (error) => {
      this.logger(`WebSocket server error: ${error.message}`);
    });

    await new Promise((resolve, reject) => {
      const onListening = () => {
        this.wss.off('error', onError);
        resolve();
      };
      const onError = (error) => {
        this.wss.off('listening', onListening);
        if (error && error.code === 'EADDRINUSE') {
          reject(new BridgeError(
            `Port ${this.port} is already in use. Stop the other bridge instance or set OPENCODE_BROWSER_PORT to a free port and update the extension settings.`,
            'PORT_IN_USE'
          ));
        } else {
          reject(error);
        }
      };
      this.wss.once('listening', onListening);
      this.wss.once('error', onError);
    });

    const address = this.wss.address();
    if (address && typeof address === 'object' && address.port) {
      this.port = address.port;
    }

    this.heartbeat = setInterval(() => {
      if (!this.wss) return;
      for (const socket of this.wss.clients) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          // Ignore.
        }
      }
    }, 20000);
    this.heartbeat.unref?.();

    this.logger(`listening on ws://${this.host}:${this.port}`);
    return this;
  }

  handleConnection(socket, request) {
    const origin = request && request.headers ? request.headers.origin : undefined;
    // Browsers send an Origin header on WebSocket handshakes. Only a Chrome
    // extension page may connect; an absent Origin is accepted for local CLI
    // tools and tests. Never allow an ordinary web page to impersonate the
    // extension.
    if (origin && !/^chrome-extension:\/\//i.test(origin)) {
      this.logger(`rejected connection from origin ${origin}`);
      socket.close(4003, 'forbidden origin');
      return;
    }

    let token = '';
    try {
      const url = new URL(request.url || '/', `http://${this.host}:${this.port}`);
      token = url.searchParams.get('token') || '';
    } catch {
      // Ignore.
    }
    if (this.token && token !== this.token) {
      this.logger('rejected connection: invalid token');
      socket.close(4001, 'invalid token');
      return;
    }

    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.logger('replacing the previous extension connection');
      try {
        this.client.close(4002, 'replaced');
      } catch {
        // Ignore.
      }
      this.rejectPending('Extension reconnected; the previous request was cancelled.', 'DISCONNECTED');
    }

    this.client = socket;
    this.hello = null;
    this.connectedAt = Date.now();
    this.lastSeen = Date.now();
    socket.isAlive = true;

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (data) => {
      this.lastSeen = Date.now();
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        this.logger('received invalid JSON from the extension');
        return;
      }
      this.handleMessage(socket, message);
    });

    socket.on('close', (code, reason) => {
      if (this.client === socket) {
        this.client = null;
        this.hello = null;
        this.connectedAt = null;
        this.rejectPending(`Extension disconnected (code ${code}${reason ? ': ' + reason.toString() : ''}).`, 'DISCONNECTED');
        this.logger(`extension disconnected (code ${code})`);
        this.emit('disconnect', { code, reason: reason ? reason.toString() : '' });
      }
    });

    socket.on('error', (error) => {
      this.logger(`extension socket error: ${error.message}`);
    });

    this.emit('connection', { origin });
    this.logger('extension connected; waiting for hello');
  }

  handleMessage(socket, message) {
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'hello') {
      this.hello = {
        version: message.version || 'unknown',
        extensionId: message.extensionId || null,
        userAgent: message.userAgent || null,
        platform: message.platform || null,
        settings: message.settings || null,
        at: Date.now()
      };
      this.logger(`hello from extension v${this.hello.version} (${this.hello.extensionId || 'unknown id'})`);
      this.sendTo(socket, {
        type: 'welcome',
        server: 'opencode-browser-bridge',
        version: '0.1.3',
        heartbeatSeconds: 20
      });
      this.emit('ready', this.hello);
      return;
    }

    if (message.type === 'ping') {
      this.sendTo(socket, { type: 'pong', ts: message.ts });
      return;
    }

    if (message.type === 'pong') return;

    if (message.type === 'response') {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        const error = message.error || {};
        const wrapped = new BridgeError(
          error.message || 'The browser extension reported an unknown error.',
          error.code || 'EXTENSION_ERROR',
          error.details
        );
        if (error.stack) wrapped.stack = error.stack;
        entry.reject(wrapped);
      }
      return;
    }

    if (message.type === 'event') {
      this.emit('event', message);
      return;
    }
  }

  sendTo(socket, message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  send(message) {
    return this.sendTo(this.client, message);
  }

  get connected() {
    return !!(this.client && this.client.readyState === WebSocket.OPEN);
  }

  get ready() {
    return this.connected && !!this.hello;
  }

  status() {
    return {
      connected: this.connected,
      ready: this.ready,
      host: this.host,
      port: this.port,
      extension: this.hello,
      connectedAt: this.connectedAt,
      lastSeen: this.lastSeen,
      pendingRequests: this.pending.size,
      tokenRequired: !!this.token
    };
  }

  async request(method, params = {}, options = {}) {
    if (!this.connected) {
      throw new BridgeError(
        'The Chrome extension is not connected. Open chrome://extensions, make sure "OpenCode Browser Bridge" is enabled, then click its toolbar icon and verify the server URL.',
        'NOT_CONNECTED'
      );
    }
    if (!this.hello) {
      throw new BridgeError(
        'The Chrome extension connected but did not complete the handshake. Reload the extension and try again.',
        'NOT_READY'
      );
    }

    const timeout = Math.max(1000, Math.min(Number(options.timeout) || this.requestTimeout, 180000));
    const id = options.id || randomUUID();
    const message = { type: 'request', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(
          `The browser did not respond to "${method}" within ${Math.round(timeout / 1000)}s. The page may be blocked by a native dialog, a navigation, or an extension that was suspended.`,
          'TIMEOUT',
          { method, timeout }
        ));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer, method, startedAt: Date.now() });
      const sent = this.send(message);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('Could not send the request to the extension.', 'SEND_FAILED'));
      }
    });
  }

  rejectPending(message, code = 'DISCONNECTED') {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeError(message, code, { method: entry.method }));
      this.pending.delete(id);
    }
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.rejectPending('Browser bridge is shutting down.', 'SHUTDOWN');
    if (this.client) {
      try {
        this.client.close(1001, 'server shutdown');
      } catch {
        // Ignore.
      }
    }
    this.client = null;
    this.hello = null;
    if (this.wss) {
      await new Promise((resolve) => {
        this.wss.close(() => resolve());
      });
      this.wss = null;
    }
  }
}
