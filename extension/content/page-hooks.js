/*
 * OpenCode Browser Bridge - page hooks (MAIN world, document_start).
 *
 * Buffers console output, unhandled errors, fetch/XHR activity and JavaScript
 * dialogs so the agent can inspect them later. It also lets the agent decide
 * how alert/confirm/prompt are answered (avoiding blocked automation).
 *
 * This script must stay dependency-free and defensive: a broken hook must
 * never break the page it is injected into.
 */
(() => {
  'use strict';

  const KEY = '__OPENCODE_HOOKS__';
  const VERSION = 1;
  if (globalThis[KEY] && globalThis[KEY].version === VERSION) return;

  const MAX_CONSOLE = 400;
  const MAX_NETWORK = 400;
  const MAX_DIALOGS = 50;

  const consoleLogs = [];
  const networkLogs = [];
  const dialogs = [];
  const xhrMeta = new WeakMap();
  const originals = {};
  let consoleSeq = 0;
  let inflight = 0;

  const dialogState = {
    intercept: true,
    confirm: true,
    prompt: ''
  };

  function truncate(value, max = 8000) {
    const text = String(value);
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function safeSerialize(value, depth = 0, seen = new WeakSet()) {
    try {
      if (value === null) return 'null';
      const type = typeof value;
      if (type === 'string') return value;
      if (type === 'number' || type === 'boolean' || type === 'undefined') return String(value);
      if (type === 'bigint') return String(value) + 'n';
      if (type === 'symbol') return value.toString();
      if (type === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? '\n' + value.stack : ''}`;
      if (typeof Node !== 'undefined' && value instanceof Node) {
        if (value.nodeType === 1) {
          const el = value;
          const id = el.id ? '#' + el.id : '';
          const cls = el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : '';
          return `<${String(el.tagName).toLowerCase()}${id}${cls}>`;
        }
        return `[Node ${value.nodeName}]`;
      }
      if (depth > 4) return '[...]';
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      if (Array.isArray(value)) {
        return '[' + value.slice(0, 60).map((item) => safeSerialize(item, depth + 1, seen)).join(', ') + ']';
      }
      if (value instanceof Map) {
        return `Map(${value.size}) {` + [...value.entries()].slice(0, 40)
          .map(([k, v]) => `${safeSerialize(k, depth + 1, seen)}: ${safeSerialize(v, depth + 1, seen)}`)
          .join(', ') + '}';
      }
      if (value instanceof Set) {
        return `Set(${value.size}) {` + [...value.values()].slice(0, 40)
          .map((item) => safeSerialize(item, depth + 1, seen)).join(', ') + '}';
      }
      const keys = Object.keys(value).slice(0, 40);
      return '{' + keys.map((key) => {
        let serialized;
        try {
          serialized = safeSerialize(value[key], depth + 1, seen);
        } catch {
          serialized = '[Unserializable]';
        }
        return `${key}: ${serialized}`;
      }).join(', ') + '}';
    } catch {
      try {
        return String(value);
      } catch {
        return '[Unserializable]';
      }
    }
  }

  function recordConsole(level, args, extra) {
    if (consoleLogs.length >= MAX_CONSOLE) consoleLogs.splice(0, consoleLogs.length - MAX_CONSOLE + 1);
    const errorArg = args.find((arg) => arg instanceof Error);
    consoleLogs.push({
      id: ++consoleSeq,
      level,
      ts: Date.now(),
      text: truncate(args.map((arg) => safeSerialize(arg)).join(' ')),
      stack: extra && extra.stack ? truncate(extra.stack, 4000) : errorArg && errorArg.stack ? truncate(errorArg.stack, 4000) : undefined,
      url: typeof location !== 'undefined' ? location.href : undefined
    });
  }

  function trimNetwork() {
    if (networkLogs.length > MAX_NETWORK) networkLogs.splice(0, networkLogs.length - MAX_NETWORK);
  }

  function recordDialog(type, message, defaultValue) {
    if (dialogs.length >= MAX_DIALOGS) dialogs.splice(0, dialogs.length - MAX_DIALOGS + 1);
    let response;
    if (type === 'confirm') response = !!dialogState.confirm;
    else if (type === 'prompt') response = dialogState.prompt != null ? dialogState.prompt : defaultValue || '';
    else response = undefined;
    dialogs.push({
      type,
      message: truncate(message == null ? '' : message, 2000),
      defaultValue: defaultValue == null ? undefined : truncate(defaultValue, 1000),
      response,
      ts: Date.now()
    });
  }

  function installDialogInterception() {
    if (!dialogState.intercept || originals.alert) return;
    try {
      originals.alert = globalThis.alert;
      originals.confirm = globalThis.confirm;
      originals.prompt = globalThis.prompt;

      globalThis.alert = function (message) {
        recordDialog('alert', message);
      };
      globalThis.confirm = function (message) {
        recordDialog('confirm', message);
        return !!dialogState.confirm;
      };
      globalThis.prompt = function (message, defaultValue) {
        recordDialog('prompt', message, defaultValue);
        return dialogState.prompt != null ? dialogState.prompt : defaultValue || '';
      };
    } catch {
      // Some pages freeze window properties; native dialogs remain available.
    }
  }

  function restoreDialogInterception() {
    try {
      if (originals.alert) globalThis.alert = originals.alert;
      if (originals.confirm) globalThis.confirm = originals.confirm;
      if (originals.prompt) globalThis.prompt = originals.prompt;
    } catch {
      // Ignore.
    }
    delete originals.alert;
    delete originals.confirm;
    delete originals.prompt;
  }

  // ---- console -----------------------------------------------------------
  try {
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level];
      if (typeof original !== 'function') continue;
      console[level] = function (...args) {
        try {
          recordConsole(level, args);
        } catch {
          // Never interfere with the page.
        }
        return original.apply(this, args);
      };
    }
  } catch {
    // Ignore.
  }

  try {
    globalThis.addEventListener('error', (event) => {
      recordConsole('error', [event.message || 'Uncaught error'], {
        stack: event.error && event.error.stack
      });
    });
    globalThis.addEventListener('unhandledrejection', (event) => {
      recordConsole('error', ['Unhandled rejection', event.reason], {
        stack: event.reason && event.reason.stack
      });
    });
  } catch {
    // Ignore.
  }

  // ---- fetch -------------------------------------------------------------
  try {
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch === 'function') {
      globalThis.fetch = function (input, init) {
        const start = performance.now();
        let method = 'GET';
        let url = '';
        try {
          method = (init && init.method) || (input && input.method) || 'GET';
          url = typeof input === 'string' ? input : (input && input.url) || String(input);
        } catch {
          // Ignore.
        }
        const entry = {
          kind: 'fetch',
          resourceType: 'fetch',
          method: String(method).toUpperCase(),
          url: truncate(url, 2000),
          start: Date.now(),
          status: 0,
          ok: false,
          duration: 0
        };
        inflight++;
        let promise;
        try {
          promise = originalFetch.apply(this, arguments);
        } catch (error) {
          entry.error = truncate(error && error.message ? error.message : error, 1000);
          networkLogs.push(entry);
          trimNetwork();
          inflight = Math.max(0, inflight - 1);
          throw error;
        }
        return promise.then((response) => {
          try {
            entry.status = response.status;
            entry.ok = response.ok;
            entry.type = response.type;
            entry.duration = Math.round(performance.now() - start);
          } catch {
            // Ignore.
          }
          networkLogs.push(entry);
          trimNetwork();
          return response;
        }, (error) => {
          entry.error = truncate(error && error.message ? error.message : error, 1000);
          entry.duration = Math.round(performance.now() - start);
          networkLogs.push(entry);
          trimNetwork();
          throw error;
        }).finally(() => {
          inflight = Math.max(0, inflight - 1);
        });
      };
    }
  } catch {
    // Ignore.
  }

  // ---- XMLHttpRequest ----------------------------------------------------
  try {
    const XHR = globalThis.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          xhrMeta.set(this, {
            method: String(method || 'GET').toUpperCase(),
            url: truncate(url == null ? '' : url, 2000)
          });
        } catch {
          // Ignore.
        }
        return originalOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        const xhr = this;
        const meta = xhrMeta.get(xhr) || { method: 'GET', url: '' };
        const start = performance.now();
        const entry = {
          kind: 'xhr',
          resourceType: 'xmlhttprequest',
          method: meta.method,
          url: meta.url,
          start: Date.now(),
          status: 0,
          ok: false,
          duration: 0
        };
        inflight++;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          try {
            entry.status = xhr.status;
            entry.ok = xhr.status >= 200 && xhr.status < 400;
            entry.duration = Math.round(performance.now() - start);
            entry.type = xhr.responseType || 'text';
          } catch {
            // Ignore.
          }
          networkLogs.push(entry);
          trimNetwork();
          inflight = Math.max(0, inflight - 1);
        };
        try {
          xhr.addEventListener('loadend', finish, { once: true });
          xhr.addEventListener('error', () => {
            entry.error = 'network error';
            finish();
          }, { once: true });
          xhr.addEventListener('abort', () => {
            entry.error = 'aborted';
            finish();
          }, { once: true });
        } catch {
          // Ignore.
        }
        try {
          return originalSend.apply(xhr, arguments);
        } catch (error) {
          entry.error = truncate(error && error.message ? error.message : error, 1000);
          finish();
          throw error;
        }
      };
    }
  } catch {
    // Ignore.
  }

  // ---- dialogs -----------------------------------------------------------
  installDialogInterception();

  // ---- public API --------------------------------------------------------
  const api = {
    version: VERSION,
    getConsole(limit = 200) {
      const count = Math.max(1, Math.min(Number(limit) || 200, MAX_CONSOLE));
      return consoleLogs.slice(-count);
    },
    clearConsole() {
      consoleLogs.length = 0;
      return true;
    },
    getNetwork(limit = 200, includeStatic = false) {
      const count = Math.max(1, Math.min(Number(limit) || 200, MAX_NETWORK));
      const entries = networkLogs.slice();
      if (includeStatic) {
        try {
          const seen = new Set(entries.map((entry) => `${entry.url}|${Math.round((entry.start || 0) / 1000)}`));
          for (const perf of performance.getEntriesByType('resource')) {
            const key = `${perf.name}|${Math.round((performance.timeOrigin + perf.startTime) / 1000)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({
              kind: 'resource',
              resourceType: perf.initiatorType || 'resource',
              method: 'GET',
              url: truncate(perf.name, 2000),
              start: Math.round(performance.timeOrigin + perf.startTime),
              status: 0,
              duration: Math.round(perf.duration),
              size: perf.transferSize
            });
          }
        } catch {
          // Ignore.
        }
      }
      return entries.sort((a, b) => (a.start || 0) - (b.start || 0)).slice(-count);
    },
    clearNetwork() {
      networkLogs.length = 0;
      return true;
    },
    getDialogs(limit = 50) {
      const count = Math.max(1, Math.min(Number(limit) || 50, MAX_DIALOGS));
      return dialogs.slice(-count);
    },
    clearDialogs() {
      dialogs.length = 0;
      return true;
    },
    setDialogPolicy(policy = {}) {
      if (typeof policy.intercept === 'boolean') {
        dialogState.intercept = policy.intercept;
        if (policy.intercept) installDialogInterception();
        else restoreDialogInterception();
      }
      if (typeof policy.confirm === 'boolean') dialogState.confirm = policy.confirm;
      if (policy.prompt !== undefined) dialogState.prompt = policy.prompt == null ? '' : String(policy.prompt);
      return { ...dialogState };
    },
    getDialogPolicy() {
      return { ...dialogState };
    },
    inflight() {
      return inflight;
    }
  };

  globalThis[KEY] = api;
})();
