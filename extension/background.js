/*
 * OpenCode Browser Bridge - MV3 service worker.
 *
 * Maintains a WebSocket connection to the local MCP bridge, receives JSON-RPC
 * style commands and executes them against Chrome (tabs, DOM agent, CDP).
 */

import { DEFAULT_SETTINGS, getSettings, saveSettings } from './lib/settings.js';
import { sleep, withTimeout, truncate, errorMessage, normalizeServerUrl, jsonText } from './lib/util.js';
import * as cdp from './lib/cdp.js';
import { processScreenshot, dataUrlToBase64 } from './lib/image.js';

const VERSION = chrome.runtime.getManifest().version;
const KEEPALIVE_ALARM = 'opencode-browser-keepalive';

let settings = { ...DEFAULT_SETTINGS };
let ws = null;
let wsState = 'disconnected';
let reconnectTimer = null;
let reconnectDelay = 1000;
let heartbeatTimer = null;
let lastError = null;
let lastServerSeen = 0;
let manualDisconnect = false;
let initialized = false;
let detachTimer = null;

cdp.setDialogHandler(handleNativeDialog);

const initPromise = ensureInitialized().catch((error) => {
  lastError = errorMessage(error);
  console.error('[OpenCode Browser Bridge] init failed', error);
});

async function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  settings = await getSettings();
  try {
    const alarm = await chrome.alarms.get(KEEPALIVE_ALARM);
    if (!alarm) {
      await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    }
  } catch {
    // Alarms are best-effort.
  }
  updateBadge();
  if (settings.autoConnect) connectQuietly();
}

chrome.runtime.onInstalled.addListener(() => {
  initPromise.then(() => {
    if (settings.autoConnect) connectQuietly();
  });
});

chrome.runtime.onStartup.addListener(() => {
  initPromise.then(() => {
    if (settings.autoConnect) connectQuietly();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (wsState === 'connected') {
    send({ type: 'ping', ts: Date.now() });
  } else if (settings.autoConnect && !manualDisconnect) {
    connectQuietly();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const previous = settings;
  settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
  const serverChanged = normalizeServerUrl(previous.serverUrl) !== normalizeServerUrl(settings.serverUrl) ||
    previous.token !== settings.token;
  if (serverChanged) {
    closeSocket();
    if (settings.autoConnect) connectQuietly();
  }
  if (settings.keepAttached) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
  broadcastStatus();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cdp.detach(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'getStatus') {
    getStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'connect') {
    manualDisconnect = false;
    connect()
      .then(() => getStatus())
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'disconnect') {
    manualDisconnect = true;
    closeSocket();
    sendResponse({ ok: true, status: { wsState } });
    return false;
  }

  if (message.type === 'saveSettings') {
    saveSettings(message.settings || {})
      .then(async (next) => {
        settings = next;
        if (message.reconnect) {
          manualDisconnect = false;
          closeSocket();
          connectQuietly();
        }
        return getStatus();
      })
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message.type === 'detachDebugger') {
    cdp.detachAll()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return Promise.resolve();
  }
  manualDisconnect = false;
  clearTimeout(reconnectTimer);
  let url;
  try {
    const base = normalizeServerUrl(settings.serverUrl);
    const parsed = new URL(base);
    parsed.searchParams.set('v', '1');
    if (settings.token) parsed.searchParams.set('token', settings.token);
    url = parsed.toString();
  } catch (error) {
    lastError = `Invalid server URL: ${errorMessage(error)}`;
    wsState = 'disconnected';
    updateBadge();
    return Promise.reject(new Error(lastError));
  }

  wsState = 'connecting';
  lastError = null;
  updateBadge();

  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      lastError = errorMessage(error);
      wsState = 'disconnected';
      updateBadge();
      scheduleReconnect();
      reject(error);
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      wsState = 'connected';
      reconnectDelay = 1000;
      lastError = null;
      lastServerSeen = Date.now();
      startHeartbeat();
      updateBadge();
      send({
        type: 'hello',
        version: VERSION,
        extensionId: chrome.runtime.id,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        settings: {
          preferCdp: settings.preferCdp,
          keepAttached: settings.keepAttached,
          interceptDialogs: settings.interceptDialogs
        }
      });
      broadcastStatus();
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    socket.addEventListener('message', (event) => {
      lastServerSeen = Date.now();
      handleSocketMessage(event.data);
    });

    socket.addEventListener('error', () => {
      lastError = `Could not connect to ${url}. Is the MCP server running?`;
    });

    socket.addEventListener('close', (event) => {
      if (ws === socket) {
        ws = null;
        wsState = 'disconnected';
        stopHeartbeat();
        updateBadge();
        broadcastStatus();
        if (!settled) {
          settled = true;
          reject(new Error(lastError || `WebSocket closed (code ${event.code}).`));
        }
        if (settings.autoConnect && !manualDisconnect) scheduleReconnect();
      }
    });
  });
}

function connectQuietly() {
  connect().catch(() => {
    // lastError and wsState are already set; scheduleReconnect() retries.
  });
}

function closeSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopHeartbeat();
  if (ws) {
    try {
      ws.close(1000, 'client disconnect');
    } catch {
      // Ignore.
    }
  }
  ws = null;
  wsState = 'disconnected';
  updateBadge();
}

function scheduleReconnect() {
  if (manualDisconnect || !settings.autoConnect) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(reconnectDelay, 15000);
  reconnectTimer = setTimeout(() => {
    if (!manualDisconnect && wsState !== 'connected') {
      connect().catch(() => {});
    }
  }, delay);
  reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 15000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (wsState !== 'connected') return;
    send({ type: 'ping', ts: Date.now() });
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function send(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    lastError = errorMessage(error);
    return false;
  }
}

function handleSocketMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'request') {
    handleServerRequest(message);
    return;
  }
  if (message.type === 'ping') {
    send({ type: 'pong', ts: message.ts });
    return;
  }
  if (message.type === 'pong') {
    lastServerSeen = Date.now();
  }
}

async function handleServerRequest(message) {
  const started = Date.now();
  try {
    const result = await handleCommand(message.method, message.params || {});
    send({
      type: 'response',
      id: message.id,
      ok: true,
      result,
      elapsedMs: Date.now() - started
    });
  } catch (error) {
    send({
      type: 'response',
      id: message.id,
      ok: false,
      error: {
        message: errorMessage(error),
        code: error && error.code,
        details: error && error.details,
        stack: error && error.stack ? truncate(error.stack, 4000) : undefined
      },
      elapsedMs: Date.now() - started
    });
  } finally {
    scheduleIdleDetach();
  }
}

function scheduleIdleDetach() {
  if (settings.keepAttached) return;
  clearTimeout(detachTimer);
  detachTimer = setTimeout(() => {
    detachTimer = null;
    for (const item of cdp.listAttached()) {
      if (item.reason === 'manual') continue;
      cdp.detach(item.tabId).catch(() => {});
    }
  }, 2000);
}

async function handleNativeDialog({ tabId, params }) {
  if (!settings.interceptDialogs) return;
  const type = params && params.type;
  const accept = type === 'beforeunload' ? true : type === 'prompt' ? true : settings.confirmDialogs;
  try {
    await cdp.send(tabId, 'Page.handleJavaScriptDialog', {
      accept,
      promptText: type === 'prompt' ? settings.promptDialogText : undefined
    });
    send({
      type: 'event',
      event: 'dialog',
      data: {
        tabId,
        type,
        message: params && params.message,
        accepted: accept,
        ts: Date.now()
      }
    });
  } catch {
    // The dialog may have been handled by the page or already closed.
  }
}

async function broadcastStatus() {
  try {
    const status = await getStatus();
    chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {});
  } catch {
    // No popup open.
  }
}

function updateBadge() {
  try {
    chrome.action.setBadgeText({ text: wsState === 'connected' ? 'ON' : '' })?.catch?.(() => {});
    chrome.action.setBadgeBackgroundColor({ color: wsState === 'connected' ? '#16a34a' : '#6b7280' })?.catch?.(() => {});
    chrome.action.setTitle({
      title: wsState === 'connected'
        ? 'OpenCode Browser Bridge: connected'
        : 'OpenCode Browser Bridge: disconnected'
    })?.catch?.(() => {});
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// Tabs and frames
// ---------------------------------------------------------------------------

function tabInfo(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    status: tab.status,
    title: tab.title || '',
    url: tab.url || '',
    audible: !!tab.audible,
    muted: !!(tab.mutedInfo && tab.mutedInfo.muted),
    groupId: tab.groupId,
    openerTabId: tab.openerTabId
  };
}

function isScriptableUrl(url) {
  return /^(https?|file|about|data):/i.test(String(url || ''));
}

async function getActiveTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    // Ignore.
  }
  if (!tab) {
    try {
      [tab] = await chrome.tabs.query({ active: true });
    } catch {
      // Ignore.
    }
  }
  if (!tab) {
    const tabs = await chrome.tabs.query({});
    tab = tabs.find((item) => isScriptableUrl(item.url)) || tabs[0];
  }
  return tab || null;
}

async function resolveTab(params = {}) {
  if (params.tabId != null) {
    try {
      return await chrome.tabs.get(Number(params.tabId));
    } catch {
      throw new Error(`Tab ${params.tabId} was not found.`);
    }
  }
  const tab = await getActiveTab();
  if (!tab) {
    throw new Error('No Chrome tab is available. Use chrome_navigate with newTab=true to create one.');
  }
  return tab;
}

function frameFromRef(ref) {
  const match = /^f(\d+)_e\d+$/.exec(String(ref || ''));
  return match ? Number(match[1]) : null;
}

async function listFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return Array.isArray(frames) ? frames : [];
  } catch {
    return [{ frameId: 0, parentFrameId: -1, url: '' }];
  }
}

async function execInFrame(tabId, frameId, cmd, params = {}, options = {}) {
  const timeout = Math.max(1000, Math.min(Number(options.timeout) || 15000, 120000));
  const start = Date.now();
  const prefix = `f${Number(frameId) || 0}_`;
  let lastError = null;

  while (Date.now() - start < timeout) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [Number(frameId) || 0] },
        files: ['content/agent.js']
      });
      const injections = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [Number(frameId) || 0] },
        func: (payload) => {
          if (!globalThis.__OC_AGENT__ || typeof globalThis.__OC_AGENT__.handle !== 'function') {
            return { ok: false, error: { message: 'Page agent is not available in this frame.' } };
          }
          return globalThis.__OC_AGENT__.handle(payload);
        },
        args: [{ cmd, params, prefix }]
      });
      const injection = injections && injections[0];
      if (!injection) throw new Error('The page agent did not return a result.');
      const result = injection.result;
      if (!result || result.ok !== true) {
        const error = new Error(result && result.error && result.error.message ? result.error.message : 'Page agent failed.');
        error.code = 'AGENT_ERROR';
        error.details = result && result.error ? result.error.details : undefined;
        if (result && result.error && result.error.stack) error.stack = result.error.stack;
        throw error;
      }
      return result.result;
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      if (error && error.code === 'AGENT_ERROR') throw error;

      if (/The frame was removed|Frame with id .* was removed|context was destroyed|Cannot find context|The tab was closed|No tab with id/i.test(message)) {
        if (options.navigation) {
          const lost = new Error(message);
          lost.code = 'FRAME_LOST';
          throw lost;
        }
        await sleep(150);
        continue;
      }
      if (/Cannot access contents|The extensions gallery cannot be scripted|Extension manifest must request permission|Cannot access a chrome/i.test(message)) {
        const denied = new Error(`Chrome does not allow extensions to script this page (${message}). Open a normal http(s) page and try again.`);
        denied.code = 'PAGE_NOT_SCRIPTABLE';
        throw denied;
      }
      throw error;
    }
  }
  throw lastError || new Error(`Could not run "${cmd}" in frame ${frameId}.`);
}

async function execAllFrames(tabId, cmd, params = {}, options = {}) {
  const frames = await listFrames(tabId);
  const maxFrames = Math.max(1, Math.min(Number(options.maxFrames) || 30, 100));
  const selected = frames
    .filter((frame) => !frame.errorOccurred)
    .sort((a, b) => (a.parentFrameId - b.parentFrameId) || (a.frameId - b.frameId))
    .slice(0, maxFrames);
  const results = [];
  for (const frame of selected) {
    try {
      results.push({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
        result: await execInFrame(tabId, frame.frameId, cmd, params, options)
      });
    } catch (error) {
      results.push({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
        error: errorMessage(error)
      });
    }
  }
  return results;
}

async function execMain(tabId, frameId, func, args = [], options = {}) {
  const injections = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [Number(frameId) || 0] },
    world: 'MAIN',
    func,
    args
  });
  const injection = injections && injections[0];
  if (!injection) throw new Error('MAIN world script returned no result.');
  return injection.result;
}

async function execMainAllFrames(tabId, func, args = [], options = {}) {
  const frames = await listFrames(tabId);
  const maxFrames = Math.max(1, Math.min(Number(options.maxFrames) || 30, 100));
  const selected = frames
    .filter((frame) => !frame.errorOccurred)
    .sort((a, b) => (a.parentFrameId - b.parentFrameId) || (a.frameId - b.frameId))
    .slice(0, maxFrames);
  const results = [];
  for (const frame of selected) {
    try {
      results.push({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
        result: await execMain(tabId, frame.frameId, func, args)
      });
    } catch (error) {
      results.push({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
        error: errorMessage(error)
      });
    }
  }
  return results;
}

async function waitForTabStatus(tabId, wanted, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error(`Tab ${tabId} was closed while waiting for it to load.`);
    }
    if (wanted === 'complete' && tab.status === 'complete') return tab;
    if (wanted === 'loading' && tab.status === 'loading') return tab;
    await sleep(120);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  throw new Error(
    `Timed out after ${timeout}ms waiting for tab ${tabId} to be ${wanted}. ` +
    `Current status: ${tab ? tab.status : 'unknown'}, URL: ${tab ? tab.url : 'unknown'}.`
  );
}

async function waitForReadyState(tabId, wanted, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const position = await execInFrame(tabId, 0, 'position', {}, { timeout: Math.min(2500, timeout) });
      const ready = position && position.readyState;
      if (wanted === 'complete' && ready === 'complete') return position;
      if (wanted === 'interactive' && ready && ready !== 'loading') return position;
    } catch {
      // The page may still be navigating.
    }
    await sleep(150);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (wanted === 'complete' && tab && tab.status === 'complete') return { readyState: 'complete', url: tab.url };
  throw new Error(`Timed out after ${timeout}ms waiting for document.readyState="${wanted}".`);
}

async function waitForNetworkIdle(tabId, timeout = 30000) {
  const start = Date.now();
  let idleSince = null;
  await waitForTabStatus(tabId, 'complete', Math.min(timeout, 15000)).catch(() => {});
  while (Date.now() - start < timeout) {
    let ready = false;
    let inflight = 0;
    try {
      const position = await execInFrame(tabId, 0, 'position', {}, { timeout: 2500 });
      ready = position && position.readyState === 'complete';
    } catch {
      // Ignore.
    }
    try {
      inflight = await execMain(tabId, 0, () => {
        return globalThis.__OPENCODE_HOOKS__ && typeof globalThis.__OPENCODE_HOOKS__.inflight === 'function'
          ? globalThis.__OPENCODE_HOOKS__.inflight()
          : 0;
      });
    } catch {
      inflight = 0;
    }
    if (ready && !inflight) {
      if (idleSince == null) idleSince = Date.now();
      if (Date.now() - idleSince >= 600) return { idle: true, elapsed: Date.now() - start };
    } else {
      idleSince = null;
    }
    await sleep(200);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for network idle.`);
}

async function waitForReady(tabId, waitUntil = 'domcontentloaded', timeout = 30000) {
  const mode = String(waitUntil || 'domcontentloaded').toLowerCase();
  if (mode === 'none') {
    await sleep(150);
    return;
  }
  if (mode === 'commit') {
    await sleep(250);
    return;
  }
  if (mode === 'domcontentloaded') {
    await waitForReadyState(tabId, 'interactive', timeout);
    return;
  }
  if (mode === 'networkidle') {
    await waitForNetworkIdle(tabId, timeout);
    return;
  }
  await waitForTabStatus(tabId, 'complete', timeout);
  await waitForReadyState(tabId, 'complete', Math.min(timeout, 10000)).catch(() => {});
}

async function waitForPossibleNavigation(tabId, beforeUrl, params = {}) {
  const detectMs = Math.max(100, Math.min(Number(params.detectNavigationMs) || 700, 5000));
  const beforeTabs = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
  const started = Date.now();
  let navigated = false;
  let closed = false;

  while (Date.now() - started < detectMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      closed = true;
      break;
    }
    if ((tab.url && tab.url !== beforeUrl) || tab.status === 'loading') {
      navigated = true;
      break;
    }
    await sleep(100);
  }

  await sleep(80);
  const tabs = await chrome.tabs.query({});
  const newTab = tabs.find((tab) => !beforeTabs.has(tab.id) && (tab.openerTabId === tabId || tab.active));

  if (navigated && !closed) {
    const waitUntil = params.waitUntil || 'domcontentloaded';
    const timeout = Math.max(1000, Math.min(Number(params.timeout) || 30000, 120000));
    try {
      await waitForReady(tabId, waitUntil, timeout);
    } catch (error) {
      if (params.allowTimeout !== true) throw error;
    }
    // On cross-origin navigations the tab can still report status "loading"
    // (or the old URL) before the new document commits. Give the URL a short
    // grace period so the reported "Now at" reflects the destination.
    const urlDeadline = Date.now() + 800;
    let finalTab = await chrome.tabs.get(tabId).catch(() => null);
    while (finalTab && finalTab.url === beforeUrl && Date.now() < urlDeadline) {
      await sleep(100);
      finalTab = await chrome.tabs.get(tabId).catch(() => null);
    }
    return {
      navigated: true,
      tab: tabInfo(finalTab),
      newTab: newTab ? tabInfo(newTab) : undefined,
      elapsedMs: Date.now() - started
    };
  }

  if (newTab) {
    let activeTabId = newTab.id;
    if (params.switchToNewTab || settings.autoSwitchNewTabs) {
      await chrome.tabs.update(newTab.id, { active: true });
      if (newTab.windowId) await chrome.windows.update(newTab.windowId, { focused: true }).catch(() => {});
      activeTabId = newTab.id;
    }
    return {
      navigated: true,
      newTab: tabInfo(newTab),
      switched: !!(params.switchToNewTab || settings.autoSwitchNewTabs),
      activeTabId,
      elapsedMs: Date.now() - started
    };
  }

  const tab = closed ? null : await chrome.tabs.get(tabId).catch(() => null);
  return {
    navigated: false,
    closed,
    tab: tabInfo(tab),
    elapsedMs: Date.now() - started
  };
}

// ---------------------------------------------------------------------------
// Command router
// ---------------------------------------------------------------------------

async function handleCommand(method, params) {
  switch (method) {
    case 'status':
      return getStatus();
    case 'tabs':
      return handleTabs(params);
    case 'navigate':
      return handleNavigate(params);
    case 'snapshot':
      return handleSnapshot(params);
    case 'screenshot':
      return handleScreenshot(params);
    case 'click':
      return handleClick(params);
    case 'type':
      return handleType(params);
    case 'press':
      return handlePress(params);
    case 'hover':
      return handleHover(params);
    case 'select':
      return handleSelect(params);
    case 'scroll':
      return handleScroll(params);
    case 'waitFor':
      return handleWaitFor(params);
    case 'evaluate':
      return handleEvaluate(params);
    case 'dom':
      return handleDom(params);
    case 'fillForm':
      return handleFillForm(params);
    case 'uploadFile':
      return handleUploadFile(params);
    case 'console':
      return handleConsole(params);
    case 'network':
      return handleNetwork(params);
    case 'cookies':
      return handleCookies(params);
    case 'dialog':
      return handleDialog(params);
    case 'highlight':
      return handleHighlight(params);
    case 'drag':
      return handleDrag(params);
    case 'emulate':
      return handleEmulate(params);
    case 'debugger':
      return handleDebugger(params);
    case 'ping':
      return execInFrame((await resolveTab(params)).id, 0, 'ping', {}, { timeout: 5000 });
    default:
      throw new Error(`Unknown browser bridge method: ${method}`);
  }
}

function shouldUseCdp(params = {}) {
  if (params.trusted === false) return false;
  if (params.trusted === true) return true;
  return !!settings.preferCdp;
}

async function getStatus() {
  let tabs = [];
  try {
    tabs = (await chrome.tabs.query({})).map(tabInfo);
  } catch {
    // Ignore.
  }
  const active = await getActiveTab().catch(() => null);
  return {
    extensionVersion: VERSION,
    extensionId: chrome.runtime.id,
    wsState,
    connected: wsState === 'connected',
    serverUrl: settings.serverUrl,
    hasToken: !!settings.token,
    autoConnect: !!settings.autoConnect,
    preferCdp: !!settings.preferCdp,
    keepAttached: !!settings.keepAttached,
    interceptDialogs: !!settings.interceptDialogs,
    lastError,
    lastServerSeen,
    activeTabId: active ? active.id : null,
    tabs,
    debuggerTabs: cdp.listAttached()
  };
}

async function handleTabs(params = {}) {
  const action = String(params.action || 'list').toLowerCase();
  if (action === 'list') {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map(tabInfo) };
  }
  if (action === 'new') {
    const url = params.url ? normalizeUrl(params.url) : 'about:blank';
    const tab = await chrome.tabs.create({
      url,
      active: params.active !== false,
      windowId: params.windowId != null ? Number(params.windowId) : undefined
    });
    if (url !== 'about:blank' && params.waitUntil !== 'none') {
      await waitForReady(tab.id, params.waitUntil || 'domcontentloaded', Number(params.timeout) || 30000);
    }
    const fresh = await chrome.tabs.get(tab.id);
    return { tab: tabInfo(fresh) };
  }
  const tab = await resolveTab(params);
  if (action === 'get') return { tab: tabInfo(tab) };
  if (action === 'activate') {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { tab: tabInfo(await chrome.tabs.get(tab.id)) };
  }
  if (action === 'close') {
    await chrome.tabs.remove(tab.id);
    return { closed: true, tabId: tab.id };
  }
  if (action === 'reload') {
    await chrome.tabs.reload(tab.id, { bypassCache: !!params.bypassCache });
    if (params.waitUntil !== 'none') await waitForReady(tab.id, params.waitUntil || 'domcontentloaded', Number(params.timeout) || 30000);
    return { tab: tabInfo(await chrome.tabs.get(tab.id)) };
  }
  if (action === 'duplicate') {
    const duplicate = await chrome.tabs.duplicate(tab.id);
    return { tab: tabInfo(duplicate) };
  }
  if (action === 'pin') {
    const updated = await chrome.tabs.update(tab.id, { pinned: params.pinned !== false });
    return { tab: tabInfo(updated) };
  }
  if (action === 'mute' || action === 'unmute') {
    const updated = await chrome.tabs.update(tab.id, { muted: action === 'mute' });
    return { tab: tabInfo(updated) };
  }
  throw new Error(`Unknown tabs action: ${action}`);
}

function normalizeUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) throw new Error('A URL is required.');
  if (/^javascript:/i.test(value)) {
    throw new Error('javascript: URLs are blocked by the bridge. Use chrome_evaluate instead.');
  }
  if (/^(https?|file|about|data|chrome-extension):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error(`Unsupported URL scheme "${value.split(':')[0]}". Use http(s), file, about or data URLs.`);
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return 'http://' + value;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(value)) return 'https://' + value;
  throw new Error('Invalid URL. Include a scheme (https://…) or use a valid domain name.');
}

async function handleNavigate(params = {}) {
  const action = String(params.action || 'goto').toLowerCase();
  let tab = null;
  if (params.tabId != null) {
    tab = await chrome.tabs.get(Number(params.tabId)).catch(() => null);
    if (!tab) throw new Error(`Tab ${params.tabId} was not found.`);
  } else if (action !== 'goto' || !params.newTab) {
    tab = await resolveTab(params);
  }

  const beforeUrl = tab ? tab.url : 'about:blank';
  const started = Date.now();

  if (action === 'goto') {
    const url = normalizeUrl(params.url);
    if (!tab) {
      tab = await chrome.tabs.create({ url, active: params.active !== false });
    } else {
      await chrome.tabs.update(tab.id, { url, active: params.active !== false });
    }
    if (params.waitUntil !== 'none') {
      await waitForReady(tab.id, params.waitUntil || 'domcontentloaded', Math.max(1000, Number(params.timeout) || 30000));
    }
  } else if (action === 'back') {
    try {
      await chrome.tabs.goBack(tab.id);
    } catch {
      throw new Error('Cannot go back: the tab has no previous page in its history.');
    }
    if (params.waitUntil !== 'none') await waitForReady(tab.id, params.waitUntil || 'domcontentloaded', Number(params.timeout) || 30000);
  } else if (action === 'forward') {
    try {
      await chrome.tabs.goForward(tab.id);
    } catch {
      throw new Error('Cannot go forward: the tab has no next page in its history.');
    }
    if (params.waitUntil !== 'none') await waitForReady(tab.id, params.waitUntil || 'domcontentloaded', Number(params.timeout) || 30000);
  } else if (action === 'reload') {
    await chrome.tabs.reload(tab.id, { bypassCache: !!params.bypassCache });
    if (params.waitUntil !== 'none') await waitForReady(tab.id, params.waitUntil || 'domcontentloaded', Number(params.timeout) || 30000);
  } else if (action === 'stop') {
    try {
      await cdp.send(tab.id, 'Page.stopLoading');
    } catch {
      try {
        await execMain(tab.id, 0, () => window.stop());
      } catch {
        // Ignore.
      }
    }
  } else {
    throw new Error(`Unknown navigate action: ${action}`);
  }

  const fresh = await chrome.tabs.get(tab.id).catch(() => null);
  return {
    tab: tabInfo(fresh),
    action,
    requestedUrl: params.url,
    beforeUrl,
    waitUntil: params.waitUntil || 'domcontentloaded',
    elapsedMs: Date.now() - started
  };
}

async function handleSnapshot(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;

  if (params.allFrames) {
    const frames = await execAllFrames(tab.id, 'snapshot', {
      selector: params.selector,
      mode: params.mode,
      maxNodes: params.maxNodes,
      maxDepth: params.maxDepth,
      includeHidden: params.includeHidden,
      includeBboxes: params.includeBboxes
    }, { timeout: Number(params.timeout) || 20000, maxFrames: params.maxFrames || 25 });
    return {
      tab: tabInfo(tab),
      allFrames: true,
      frames,
      totalFrames: frames.length
    };
  }

  const result = await execInFrame(tab.id, frameId, 'snapshot', {
    selector: params.selector,
    mode: params.mode,
    maxNodes: params.maxNodes,
    maxDepth: params.maxDepth,
    includeHidden: params.includeHidden,
    includeBboxes: params.includeBboxes
  }, { timeout: Number(params.timeout) || 20000 });

  return {
    tab: tabInfo(tab),
    frameId,
    ...result
  };
}

async function handleScreenshot(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  let rectsData = null;
  let target = null;
  let fallbackReason = null;

  if (params.ref || params.selector) {
    await execInFrame(tab.id, frameId, 'scroll', {
      ref: params.ref,
      selector: params.selector,
      smooth: false
    }, { timeout: 6000 }).catch(() => {});
    target = await execInFrame(tab.id, frameId, 'resolve', {
      ref: params.ref,
      selector: params.selector
    }, { timeout: 6000 });
  }

  try {
    rectsData = await execInFrame(tab.id, frameId, 'rects', { limit: 400 }, { timeout: 6000 });
  } catch {
    rectsData = null;
  }

  if (frameId !== 0) {
    // CDP clips are expressed in top-frame page coordinates. A rect measured
    // inside an iframe cannot be used for a top-level screenshot, so capture
    // the viewport instead and avoid drawing misleading annotations.
    if (target && !params.fullPage) {
      target = null;
      fallbackReason = 'Element screenshots inside iframes are not supported; captured the viewport instead.';
    }
    try {
      const top = await execInFrame(tab.id, 0, 'position', {}, { timeout: 6000 });
      rectsData = {
        rects: [],
        scrollX: top.scrollX,
        scrollY: top.scrollY,
        innerWidth: top.innerWidth,
        innerHeight: top.innerHeight,
        scrollWidth: top.scrollWidth,
        scrollHeight: top.scrollHeight
      };
    } catch {
      rectsData = null;
    }
  }

  const useCdp = shouldUseCdp(params);
  let shot = null;
  let originX = 0;
  let originY = 0;
  let cssWidth = rectsData ? rectsData.innerWidth : 1280;
  let cssHeight = rectsData ? rectsData.innerHeight : 720;

  if (useCdp) {
    try {
      if (params.fullPage) {
        shot = await cdp.captureScreenshot(tab.id, {
          fullPage: true,
          format: params.format,
          quality: params.quality,
          maxHeight: params.maxHeight
        });
        const metrics = await cdp.getLayoutMetrics(tab.id);
        cssWidth = metrics.contentWidth || cssWidth;
        cssHeight = metrics.contentHeight || cssHeight;
        originX = 0;
        originY = 0;
      } else if (target) {
        const clip = {
          x: Math.max(0, target.rect.pageX - 8),
          y: Math.max(0, target.rect.pageY - 8),
          width: Math.max(1, target.rect.width + 16),
          height: Math.max(1, target.rect.height + 16),
          scale: 1
        };
        shot = await cdp.captureScreenshot(tab.id, {
          clip,
          format: params.format,
          quality: params.quality
        });
        originX = clip.x;
        originY = clip.y;
        cssWidth = clip.width;
        cssHeight = clip.height;
      } else {
        shot = await cdp.captureScreenshot(tab.id, {
          format: params.format,
          quality: params.quality
        });
        const metrics = await cdp.getLayoutMetrics(tab.id);
        cssWidth = metrics.viewportWidth || cssWidth;
        cssHeight = metrics.viewportHeight || cssHeight;
        originX = rectsData ? rectsData.scrollX : 0;
        originY = rectsData ? rectsData.scrollY : 0;
      }
    } catch (error) {
      fallbackReason = errorMessage(error);
      shot = null;
    }
  }

  if (!shot && params.fullPage) {
    try {
      shot = await captureFullPageWithTabs(tab, rectsData);
      cssWidth = shot.cssWidth;
      cssHeight = shot.cssHeight;
      originX = 0;
      originY = 0;
      if (!fallbackReason) fallbackReason = 'CDP disabled; used a stitched viewport capture. Sticky headers may repeat.';
    } catch (error) {
      throw new Error(`Full-page screenshot failed: ${errorMessage(error)}`);
    }
  }

  if (!shot) {
    const dataUrl = await captureVisibleTab(tab);
    shot = { base64: dataUrlToBase64(dataUrl), mimeType: 'image/png' };
    if (rectsData) {
      cssWidth = rectsData.innerWidth;
      cssHeight = rectsData.innerHeight;
      originX = rectsData.scrollX;
      originY = rectsData.scrollY;
    }
    if (!fallbackReason) fallbackReason = 'CDP disabled; captured the visible viewport only.';
  }

  const processed = await processScreenshot({
    base64: shot.base64,
    mimeType: shot.mimeType,
    rects: rectsData ? rectsData.rects : [],
    originX,
    originY,
    cssWidth,
    cssHeight,
    annotate: !!params.annotate,
    grid: !!params.grid,
    maxWidth: params.maxWidth || 1400,
    maxHeight: params.maxHeight || 8000,
    format: params.format || 'png',
    quality: params.quality || 82
  });

  return {
    tab: tabInfo(tab),
    frameId,
    image: processed,
    width: processed.width,
    height: processed.height,
    fullPage: !!params.fullPage,
    annotated: !!params.annotate,
    grid: !!params.grid,
    target,
    fallbackReason,
    note: shot.clipped ? 'The page was taller than the screenshot limit and was clipped.' : undefined
  };
}

async function captureVisibleTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  await sleep(140);
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

async function captureFullPageWithTabs(tab, rectsData) {
  let info = rectsData;
  if (!info) info = await execInFrame(tab.id, 0, 'position', {}, { timeout: 6000 });
  const viewportHeight = Math.max(100, info.innerHeight);
  const totalHeight = Math.max(viewportHeight, info.scrollHeight);
  const originalScroll = info.scrollY || 0;
  const shots = [];
  const maxShots = Math.min(40, Math.ceil(totalHeight / viewportHeight) + 1);

  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});

  try {
    for (let index = 0; index < maxShots; index++) {
      const y = Math.min(index * viewportHeight, Math.max(0, totalHeight - viewportHeight));
      await execMain(tab.id, 0, (scrollY) => window.scrollTo(0, scrollY), [y]).catch(() => {});
      await sleep(180);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      shots.push({ base64: dataUrlToBase64(dataUrl), y });
      if (y >= totalHeight - viewportHeight) break;
    }
  } finally {
    await execMain(tab.id, 0, (scrollY) => window.scrollTo(0, scrollY), [originalScroll]).catch(() => {});
  }

  const stitched = await processScreenshot({
    base64: shots[0].base64,
    mimeType: 'image/png',
    rects: [],
    annotate: false,
    grid: false,
    cssWidth: info.innerWidth,
    cssHeight: viewportHeight,
    maxWidth: 1400,
    maxHeight: 8000,
    format: 'png'
  });

  if (shots.length === 1) {
    return { ...stitched, cssWidth: info.innerWidth, cssHeight: viewportHeight };
  }

  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(stitched.base64), (char) => char.charCodeAt(0))], { type: 'image/png' }));
  const scale = bitmap.width / info.innerWidth;
  const width = bitmap.width;
  const height = Math.min(Math.round(totalHeight * scale), 12000);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  for (const shot of shots) {
    const shotBitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(shot.base64), (char) => char.charCodeAt(0))], { type: 'image/png' }));
    ctx.drawImage(shotBitmap, 0, Math.round(shot.y * scale));
    shotBitmap.close();
  }
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  return {
    base64,
    mimeType: 'image/png',
    cssWidth: info.innerWidth,
    cssHeight: totalHeight,
    stitched: true
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function handleClick(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const beforeUrl = tab.url;
  let target = null;
  let via = 'dom';
  let fallbackReason = null;

  if (params.ref || params.selector || params.text) {
    await execInFrame(tab.id, frameId, 'scroll', {
      ref: params.ref,
      selector: params.selector,
      text: params.text,
      exactText: params.exactText,
      smooth: false
    }, { timeout: 6000 });
    target = await execInFrame(tab.id, frameId, 'resolve', {
      ref: params.ref,
      selector: params.selector,
      text: params.text,
      exactText: params.exactText
    }, { timeout: 6000 });
  }

  if (shouldUseCdp(params) && frameId === 0 && (target || (params.x != null && params.y != null))) {
    try {
      const x = params.x != null ? Number(params.x) : target.rect.x + target.rect.width / 2;
      const y = params.y != null ? Number(params.y) : target.rect.y + target.rect.height / 2;
      await cdp.clickMouse(tab.id, x, y, {
        button: params.button,
        clickCount: params.clickCount,
        modifiers: params.modifiers,
        human: params.human === true
      });
      via = 'cdp';
    } catch (error) {
      fallbackReason = errorMessage(error);
    }
  }

  if (via !== 'cdp') {
    try {
      const result = await execInFrame(tab.id, frameId, 'click', params, {
        timeout: Number(params.timeout) || 12000,
        navigation: true
      });
      target = target || {
        ref: result.ref,
        tag: result.tag,
        role: result.role,
        name: result.name,
        rect: { x: result.x, y: result.y, width: 0, height: 0 }
      };
    } catch (error) {
      if (error && error.code === 'FRAME_LOST') {
        via = 'dom+navigation';
      } else {
        throw error;
      }
    }
  }

  if (params.delayAfter) await sleep(Math.max(0, Math.min(Number(params.delayAfter) || 0, 5000)));
  const navigation = await waitForPossibleNavigation(tab.id, beforeUrl, params);

  return {
    clicked: true,
    via,
    fallbackReason,
    target,
    tab: navigation.tab || tabInfo(await chrome.tabs.get(tab.id).catch(() => null)),
    navigation
  };
}

function effectiveTypingDelay(params, trusted) {
  if (params.delay != null) return Math.max(0, Math.min(Number(params.delay) || 0, 1000));
  const length = String(params.text || '').length;
  if (!trusted) return length > 200 ? 0 : 8;
  if (length > 800) return 0;
  if (length > 300) return 2;
  return 12;
}

async function handleType(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const beforeUrl = tab.url;
  const trusted = shouldUseCdp(params) && frameId === 0;
  let via = 'dom';
  let result = null;
  let fallbackReason = null;

  if (trusted) {
    try {
      const prepared = await execInFrame(tab.id, frameId, 'prepareType', params, { timeout: 8000 });
      await cdp.attach(tab.id, 'type');
      const typed = await cdp.typeText(tab.id, params.text || '', {
        delay: effectiveTypingDelay(params, true)
      });
      if (params.pressEnter) await cdp.pressKey(tab.id, 'Enter');
      const active = await execInFrame(tab.id, frameId, 'activeElement', {}, { timeout: 5000 }).catch(() => null);
      result = {
        ...prepared,
        typed: typed.typed,
        value: active ? active.value : prepared.value,
        via: 'cdp'
      };
      via = 'cdp';
    } catch (error) {
      fallbackReason = errorMessage(error);
    }
  }

  if (via !== 'cdp') {
    result = await execInFrame(tab.id, frameId, 'type', params, { timeout: Number(params.timeout) || 15000 });
    result.via = 'dom';
    if (params.pressEnter) {
      await execInFrame(tab.id, frameId, 'press', { key: 'Enter' }, { timeout: 5000 });
    }
  }

  if (params.delayAfter) await sleep(Math.max(0, Math.min(Number(params.delayAfter) || 0, 5000)));
  const navigation = params.pressEnter || params.waitForNavigation
    ? await waitForPossibleNavigation(tab.id, beforeUrl, params)
    : { navigated: false };

  return {
    ...result,
    tab: navigation.tab || tabInfo(await chrome.tabs.get(tab.id).catch(() => null)),
    fallbackReason,
    navigation
  };
}

async function handlePress(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const beforeUrl = tab.url;
  const trusted = shouldUseCdp(params) && frameId === 0;
  let via = 'dom';
  let result = null;
  let fallbackReason = null;

  if (params.ref || params.selector) {
    await execInFrame(tab.id, frameId, 'focus', {
      ref: params.ref,
      selector: params.selector
    }, { timeout: 5000 }).catch(() => {});
  }

  if (trusted) {
    try {
      await cdp.attach(tab.id, 'press');
      const def = await cdp.pressKey(tab.id, params.key || 'Enter', { delay: params.delay || 0 });
      result = { ...def, via: 'cdp' };
      via = 'cdp';
    } catch (error) {
      fallbackReason = errorMessage(error);
    }
  }

  if (via !== 'cdp') {
    result = await execInFrame(tab.id, frameId, 'press', params, { timeout: 8000 });
    result.via = 'dom';
  }

  if (params.delayAfter) await sleep(Math.max(0, Math.min(Number(params.delayAfter) || 0, 5000)));
  const navigation = String(params.key || 'Enter').toLowerCase().includes('enter') || params.waitForNavigation
    ? await waitForPossibleNavigation(tab.id, beforeUrl, params)
    : { navigated: false };

  return {
    ...result,
    tab: navigation.tab || tabInfo(await chrome.tabs.get(tab.id).catch(() => null)),
    fallbackReason,
    navigation
  };
}

async function handleHover(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  await execInFrame(tab.id, frameId, 'scroll', {
    ref: params.ref,
    selector: params.selector,
    text: params.text,
    smooth: false
  }, { timeout: 6000 }).catch(() => {});
  const target = await execInFrame(tab.id, frameId, 'resolve', {
    ref: params.ref,
    selector: params.selector,
    text: params.text
  }, { timeout: 6000 });

  let via = 'dom';
  let fallbackReason = null;
  if (shouldUseCdp(params) && frameId === 0) {
    try {
      await cdp.moveMouse(tab.id, target.rect.x + target.rect.width / 2, target.rect.y + target.rect.height / 2, {
        steps: params.steps,
        duration: params.duration
      });
      via = 'cdp';
    } catch (error) {
      fallbackReason = errorMessage(error);
    }
  }
  if (via !== 'cdp') {
    await execInFrame(tab.id, frameId, 'hover', params, { timeout: 6000 });
  }
  if (params.durationMs) await sleep(Math.max(0, Math.min(Number(params.durationMs) || 0, 10000)));
  return { hovered: true, via, target, fallbackReason, tab: tabInfo(tab) };
}

async function handleSelect(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const result = await execInFrame(tab.id, frameId, 'select', params, { timeout: 8000 });
  return { ...result, tab: tabInfo(tab) };
}

async function handleScroll(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const container = params.containerRef || params.containerSelector;

  if (shouldUseCdp(params) && frameId === 0 && !container && !params.to && params.ref == null && params.selector == null) {
    try {
      const position = await execInFrame(tab.id, frameId, 'position', {}, { timeout: 5000 });
      const direction = String(params.direction || 'down').toLowerCase();
      const amount = Number(params.amount) || 600;
      const sign = direction === 'up' || direction === 'left' ? -1 : 1;
      const deltaX = direction === 'left' || direction === 'right' ? sign * amount : 0;
      const deltaY = direction === 'up' || direction === 'down' ? sign * amount : 0;
      const steps = Math.max(1, Math.min(Math.ceil(amount / 250), 8));
      for (let index = 0; index < steps; index++) {
        await cdp.mouseWheel(tab.id, {
          x: position.innerWidth / 2,
          y: position.innerHeight / 2,
          deltaX: deltaX / steps,
          deltaY: deltaY / steps
        });
        await sleep(60);
      }
      await sleep(120);
      const after = await execInFrame(tab.id, frameId, 'position', {}, { timeout: 5000 });
      return { ...after, via: 'cdp', tab: tabInfo(tab) };
    } catch {
      // Fall through to DOM scrolling.
    }
  }

  const result = await execInFrame(tab.id, frameId, 'scroll', params, { timeout: 8000 });
  return { ...result, via: 'dom', tab: tabInfo(tab) };
}

async function handleWaitFor(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : 0;
  const timeout = Math.max(100, Math.min(Number(params.timeout) || 10000, 120000));
  const interval = Math.max(50, Math.min(Number(params.interval) || 200, 2000));

  if (params.loadState) {
    const started = Date.now();
    await waitForReady(tab.id, params.loadState, timeout);
    return { found: true, loadState: params.loadState, elapsed: Date.now() - started, tab: tabInfo(await chrome.tabs.get(tab.id)) };
  }

  if (params.urlIncludes || params.urlMatches) {
    const started = Date.now();
    const regex = params.urlMatches ? new RegExp(params.urlMatches) : null;
    while (Date.now() - started < timeout) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current) throw new Error('Tab was closed while waiting for the URL.');
      const matches = regex
        ? regex.test(current.url || '')
        : String(current.url || '').includes(String(params.urlIncludes));
      if (matches) {
        return { found: true, url: current.url, title: current.title, elapsed: Date.now() - started, tab: tabInfo(current) };
      }
      await sleep(interval);
    }
    throw new Error(`Timed out after ${timeout}ms waiting for URL ${params.urlMatches ? 'to match ' + params.urlMatches : 'to include ' + params.urlIncludes}.`);
  }

  if (params.js) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeout) {
      try {
        const evaluation = await handleEvaluate({
          tabId: tab.id,
          frameId,
          expression: params.js,
          awaitPromise: true,
          trusted: params.trusted
        });
        const value = evaluation.value;
        if (value) {
          return { found: true, value, elapsed: Date.now() - started, tab: tabInfo(await chrome.tabs.get(tab.id)) };
        }
      } catch (error) {
        lastError = errorMessage(error);
      }
      await sleep(interval);
    }
    throw new Error(`Timed out after ${timeout}ms waiting for the JavaScript predicate.${lastError ? ' Last error: ' + lastError : ''}`);
  }

  const result = await execInFrame(tab.id, frameId, 'waitFor', {
    selector: params.selector,
    text: params.text,
    exact: params.exact,
    state: params.state,
    timeout,
    interval
  }, { timeout: timeout + 5000 });
  return { ...result, frameId, tab: tabInfo(tab) };
}

async function handleEvaluate(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : 0;
  const expression = String(params.expression == null ? '' : params.expression);
  if (!expression.trim()) throw new Error('expression is required.');

  if (frameId === 0 && shouldUseCdp(params)) {
    try {
      const result = await cdp.evaluate(tab.id, expression, {
        awaitPromise: params.awaitPromise !== false,
        returnByValue: params.returnByValue !== false,
        userGesture: params.userGesture !== false
      });
      return { ...result, via: 'cdp', tab: tabInfo(tab) };
    } catch (error) {
      if (!/Cannot attach|another debugger/i.test(errorMessage(error))) throw error;
    }
  }

  const injections = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [frameId] },
    world: 'MAIN',
    func: async (code) => {
      try {
        const value = await (0, eval)(code);
        let serialized;
        try {
          serialized = JSON.parse(JSON.stringify(value));
        } catch {
          serialized = String(value);
        }
        return { ok: true, value: serialized === undefined ? null : serialized, type: typeof value };
      } catch (error) {
        return { ok: false, error: { message: error && error.message ? error.message : String(error), stack: error && error.stack ? String(error.stack) : undefined } };
      }
    },
    args: [expression]
  });
  const result = injections && injections[0] && injections[0].result;
  if (!result) throw new Error('Evaluation returned no result.');
  if (!result.ok) {
    throw new Error(`Evaluation failed in MAIN world: ${result.error.message}${result.error.stack ? '\n' + result.error.stack : ''}`);
  }
  return { ...result, via: 'main-world', tab: tabInfo(tab) };
}

async function handleDom(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const result = await execInFrame(tab.id, frameId, 'dom', params, { timeout: Number(params.timeout) || 10000 });
  return { ...result, tab: tabInfo(tab), frameId };
}

async function handleFillForm(params = {}) {
  const fields = Array.isArray(params.fields) ? params.fields : [];
  if (!fields.length) throw new Error('fields must be a non-empty array.');
  const results = [];
  let lastTarget = null;

  for (const field of fields) {
    try {
      if (!field || (!field.ref && !field.selector)) {
        throw new Error('Each field needs a ref or selector.');
      }
      const kind = String(field.type || '').toLowerCase();
      const base = {
        tabId: params.tabId,
        trusted: params.trusted,
        ref: field.ref,
        selector: field.selector,
        frameId: field.frameId,
        timeout: params.timeout
      };
      let result;
      if (kind === 'select' || field.values || field.select === true) {
        result = await handleSelect({
          ...base,
          value: field.value,
          values: field.values,
          label: field.label,
          labels: field.labels,
          index: field.index,
          indexes: field.indexes
        });
      } else if (kind === 'checkbox' || kind === 'radio' || typeof field.checked === 'boolean') {
        const info = await handleDom({ ...base, action: 'query' }).catch(() => null);
        const current = info && info.matches && info.matches[0] ? !!info.matches[0].checked : null;
        const wanted = field.checked !== false;
        if (current !== wanted) {
          result = await handleClick(base);
        } else {
          result = { clicked: false, alreadyChecked: current };
        }
      } else {
        const value = field.value != null ? field.value : field.text;
        if (value == null) throw new Error('Each text field needs a value or text.');
        result = await handleType({
          ...base,
          text: value,
          clear: field.clear,
          delay: field.delay,
          pressEnter: field.pressEnter
        });
      }
      results.push({ field, ok: true, result });
      lastTarget = base;
    } catch (error) {
      results.push({ field, ok: false, error: errorMessage(error) });
      if (!params.continueOnError) {
        const failed = new Error(`fill_form stopped at field "${field && (field.ref || field.selector)}": ${errorMessage(error)}`);
        failed.details = { results };
        throw failed;
      }
    }
  }

  if (params.submit) {
    if (typeof params.submit === 'object' && (params.submit.ref || params.submit.selector)) {
      await handleClick({
        tabId: params.tabId,
        trusted: params.trusted,
        ref: params.submit.ref,
        selector: params.submit.selector
      });
    } else if (lastTarget) {
      await handlePress({
        ...lastTarget,
        key: 'Enter',
        waitForNavigation: true
      });
    }
  }

  return { fields: results, submitted: !!params.submit };
}

async function handleUploadFile(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  if (frameId !== 0) throw new Error('File uploads are only supported in the top frame.');
  if (!Array.isArray(params.files) || !params.files.length) {
    throw new Error('files must be a non-empty array of absolute paths.');
  }
  const result = await cdp.uploadFiles(tab.id, {
    ref: params.ref,
    selector: params.selector,
    files: params.files
  });
  return { ...result, tab: tabInfo(tab) };
}

async function handleConsole(params = {}) {
  const tab = await resolveTab(params);
  const action = String(params.action || 'get').toLowerCase();
  if (action === 'clear') {
    await execMainAllFrames(tab.id, () => {
      if (globalThis.__OPENCODE_HOOKS__) return globalThis.__OPENCODE_HOOKS__.clearConsole();
      return false;
    });
    return { cleared: true, tab: tabInfo(tab) };
  }
  const injections = await execMainAllFrames(tab.id, (limit) => {
    const hooks = globalThis.__OPENCODE_HOOKS__;
    if (!hooks) return null;
    return hooks.getConsole(limit);
  }, [Math.max(1, Math.min(Number(params.limit) || 200, 400))]);

  const logs = [];
  for (const injection of injections) {
    const frameId = injection.frameId;
    const entries = Array.isArray(injection.result) ? injection.result : [];
    for (const entry of entries) logs.push({ frameId, ...entry });
  }
  const level = params.level ? String(params.level).toLowerCase() : null;
  const filtered = level ? logs.filter((entry) => entry.level === level) : logs;
  filtered.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const limited = filtered.slice(-Math.max(1, Math.min(Number(params.limit) || 200, 400)));
  return {
    logs: limited,
    count: limited.length,
    frames: injections.length,
    note: limited.length ? undefined : 'No console entries captured. Reload the page if the extension was installed after it loaded.',
    tab: tabInfo(tab)
  };
}

async function handleNetwork(params = {}) {
  const tab = await resolveTab(params);
  const action = String(params.action || 'get').toLowerCase();
  if (action === 'clear') {
    await execMainAllFrames(tab.id, () => {
      if (globalThis.__OPENCODE_HOOKS__) return globalThis.__OPENCODE_HOOKS__.clearNetwork();
      return false;
    });
    return { cleared: true, tab: tabInfo(tab) };
  }
  const injections = await execMainAllFrames(tab.id, (limit, includeStatic) => {
    const hooks = globalThis.__OPENCODE_HOOKS__;
    if (!hooks) return null;
    return hooks.getNetwork(limit, includeStatic);
  }, [
    Math.max(1, Math.min(Number(params.limit) || 200, 400)),
    !!params.includeStatic
  ]);

  const entries = [];
  for (const injection of injections) {
    const frameId = injection.frameId;
    const list = Array.isArray(injection.result) ? injection.result : [];
    for (const entry of list) entries.push({ frameId, ...entry });
  }
  let filtered = entries;
  if (params.filter) {
    const needle = String(params.filter).toLowerCase();
    filtered = filtered.filter((entry) => String(entry.url || '').toLowerCase().includes(needle));
  }
  if (params.type) {
    const type = String(params.type).toLowerCase();
    filtered = filtered.filter((entry) => String(entry.resourceType || entry.kind || '').toLowerCase().includes(type));
  }
  if (params.status != null) {
    filtered = filtered.filter((entry) => Number(entry.status) === Number(params.status));
  }
  filtered.sort((a, b) => (a.start || 0) - (b.start || 0));
  const limited = filtered.slice(-Math.max(1, Math.min(Number(params.limit) || 200, 400)));
  return {
    entries: limited,
    count: limited.length,
    frames: injections.length,
    note: limited.length ? undefined : 'No network entries captured. Reload the page if the extension was installed after it loaded.',
    tab: tabInfo(tab)
  };
}

async function handleCookies(params = {}) {
  const action = String(params.action || 'get').toLowerCase();
  const tab = await resolveTab(params).catch(() => null);
  const url = params.url || (tab && tab.url) || undefined;
  const storeId = params.storeId;

  if (action === 'get') {
    const query = {};
    if (url && /^https?:/i.test(url)) query.url = url;
    else if (params.domain) query.domain = params.domain;
    else throw new Error('A URL or domain is required to read cookies.');
    if (storeId) query.storeId = storeId;
    if (params.name) query.name = String(params.name);
    if (params.path) query.path = String(params.path);
    if (typeof params.secure === 'boolean') query.secure = params.secure;
    let cookies = await chrome.cookies.getAll(query);
    if (typeof params.httpOnly === 'boolean') {
      cookies = cookies.filter((cookie) => cookie.httpOnly === params.httpOnly);
    }
    if (params.sameSite) {
      const wanted = String(params.sameSite).toLowerCase();
      cookies = cookies.filter((cookie) => String(cookie.sameSite || 'unspecified').toLowerCase() === wanted);
    }
    return { cookies, count: cookies.length };
  }

  if (action === 'set') {
    if (!params.name) throw new Error('name is required.');
    const details = {
      name: String(params.name),
      value: String(params.value == null ? '' : params.value),
      url: params.url || url,
      domain: params.domain,
      path: params.path || '/',
      secure: !!params.secure,
      httpOnly: !!params.httpOnly,
      sameSite: params.sameSite === 'no_restriction' || params.sameSite === 'none' ? 'no_restriction'
        : params.sameSite === 'strict' ? 'strict'
        : params.sameSite === 'lax' ? 'lax'
        : 'unspecified',
      expirationDate: params.expirationDate != null ? Number(params.expirationDate) : undefined,
      storeId
    };
    if (!details.url && !details.domain) throw new Error('A URL or domain is required to set a cookie.');
    if (!details.url && details.domain) details.url = `https://${String(details.domain).replace(/^\./, '')}/`;
    const cookie = await chrome.cookies.set(details);
    if (!cookie) throw new Error('Chrome rejected the cookie.');
    return { cookie };
  }

  if (action === 'delete') {
    if (!params.name) throw new Error('name is required.');
    if (!url && !params.domain) throw new Error('A URL or domain is required.');
    const result = await chrome.cookies.remove({
      url: url || `https://${String(params.domain).replace(/^\./, '')}/`,
      name: String(params.name),
      storeId
    });
    return { removed: result ? 1 : 0, total: result ? 1 : 0, result };
  }

  if (action === 'clear') {
    const query = {};
    if (url && /^https?:/i.test(url)) query.url = url;
    else if (params.domain) query.domain = params.domain;
    else throw new Error('A URL or domain is required.');
    if (storeId) query.storeId = storeId;
    if (params.name) query.name = String(params.name);
    if (params.path) query.path = String(params.path);
    if (typeof params.secure === 'boolean') query.secure = params.secure;
    const cookies = await chrome.cookies.getAll(query);
    let removed = 0;
    for (const cookie of cookies) {
      const cookieUrl = `https://${String(cookie.domain).replace(/^\./, '')}${cookie.path || '/'}`;
      const result = await chrome.cookies.remove({ url: cookieUrl, name: cookie.name, storeId: cookie.storeId });
      if (result) removed++;
    }
    return { removed, total: cookies.length };
  }

  throw new Error(`Unknown cookies action: ${action}`);
}

async function handleDialog(params = {}) {
  const tab = await resolveTab(params);
  const action = String(params.action || 'status').toLowerCase();
  if (action === 'status') {
    const policy = await execMain(tab.id, 0, () => {
      const hooks = globalThis.__OPENCODE_HOOKS__;
      return hooks ? { policy: hooks.getDialogPolicy(), dialogs: hooks.getDialogs(50) } : null;
    }).catch(() => null);
    return { ...(policy || { policy: null, dialogs: [] }), settings: { interceptDialogs: settings.interceptDialogs, confirmDialogs: settings.confirmDialogs, promptDialogText: settings.promptDialogText }, tab: tabInfo(tab) };
  }
  if (action === 'set_policy' || action === 'setpolicy') {
    const patch = {
      intercept: params.intercept,
      confirm: params.confirm,
      prompt: params.prompt
    };
    const next = { ...settings };
    if (typeof patch.intercept === 'boolean') next.interceptDialogs = patch.intercept;
    if (typeof patch.confirm === 'boolean') next.confirmDialogs = patch.confirm;
    if (patch.prompt !== undefined) next.promptDialogText = String(patch.prompt == null ? '' : patch.prompt);
    settings = await saveSettings(next);
    await execMainAllFrames(tab.id, (policy) => {
      if (globalThis.__OPENCODE_HOOKS__) return globalThis.__OPENCODE_HOOKS__.setDialogPolicy(policy);
      return null;
    }, [patch]).catch(() => {});
    return { policy: patch, settings: { interceptDialogs: settings.interceptDialogs, confirmDialogs: settings.confirmDialogs, promptDialogText: settings.promptDialogText } };
  }
  if (action === 'clear') {
    await execMainAllFrames(tab.id, () => {
      if (globalThis.__OPENCODE_HOOKS__) return globalThis.__OPENCODE_HOOKS__.clearDialogs();
      return false;
    });
    return { cleared: true };
  }
  throw new Error(`Unknown dialog action: ${action}`);
}

async function handleHighlight(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : frameFromRef(params.ref) || 0;
  const result = await execInFrame(tab.id, frameId, 'highlight', params, { timeout: 6000 });
  return { ...result, tab: tabInfo(tab) };
}

async function handleDrag(params = {}) {
  const tab = await resolveTab(params);
  const frameId = params.frameId != null ? Number(params.frameId) : 0;
  let from;
  let to;
  try {
    from = await execInFrame(tab.id, frameId, 'resolve', {
      ref: params.fromRef,
      selector: params.fromSelector,
      x: params.fromX,
      y: params.fromY
    }, { timeout: 6000 });
    to = await execInFrame(tab.id, frameId, 'resolve', {
      ref: params.toRef,
      selector: params.toSelector,
      x: params.toX,
      y: params.toY
    }, { timeout: 6000 });
  } catch (error) {
    throw new Error(`Could not resolve drag source/target: ${errorMessage(error)}`);
  }

  let via = 'dom';
  let fallbackReason = null;
  if (shouldUseCdp(params) && frameId === 0) {
    try {
      await cdp.dragMouse(tab.id, {
        x: from.rect.x + from.rect.width / 2,
        y: from.rect.y + from.rect.height / 2
      }, {
        x: to.rect.x + to.rect.width / 2,
        y: to.rect.y + to.rect.height / 2
      }, {
        steps: params.steps,
        duration: params.duration
      });
      via = 'cdp';
    } catch (error) {
      fallbackReason = errorMessage(error);
    }
  }
  if (via !== 'cdp') {
    await execInFrame(tab.id, frameId, 'drag', {
      fromRef: params.fromRef,
      fromSelector: params.fromSelector,
      fromX: params.fromX,
      fromY: params.fromY,
      toRef: params.toRef,
      toSelector: params.toSelector,
      toX: params.toX,
      toY: params.toY
    }, { timeout: 10000 });
  }
  return { dragged: true, via, from, to, fallbackReason, tab: tabInfo(tab) };
}

async function handleEmulate(params = {}) {
  const tab = await resolveTab(params);
  const result = await cdp.emulate(tab.id, params);
  return { ...result, tab: tabInfo(tab) };
}

async function handleDebugger(params = {}) {
  const action = String(params.action || 'status').toLowerCase();
  if (action === 'status') {
    return { attached: cdp.listAttached(), settings: { preferCdp: settings.preferCdp, keepAttached: settings.keepAttached } };
  }
  const tab = await resolveTab(params);
  if (action === 'attach') {
    const result = await cdp.attach(tab.id, 'manual');
    return { ...result, tab: tabInfo(tab) };
  }
  if (action === 'detach') {
    const result = await cdp.detach(tab.id);
    return { ...result, tab: tabInfo(tab) };
  }
  throw new Error(`Unknown debugger action: ${action}`);
}
