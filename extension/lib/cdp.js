/*
 * Chrome DevTools Protocol helpers.
 *
 * CDP is used for trusted (isTrusted === true) input, full-page/element
 * screenshots, page evaluation, file uploads, emulation and native dialogs.
 * The extension still works without CDP by falling back to DOM events.
 */

const attached = new Map();
const mousePositions = new Map();
let dialogHandler = null;

export function setDialogHandler(handler) {
  dialogHandler = handler;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Page.javascriptDialogOpening' && source.tabId != null && dialogHandler) {
    Promise.resolve(dialogHandler({ tabId: source.tabId, params })).catch(() => {});
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId);
    mousePositions.delete(source.tabId);
  }
});

export function listAttached() {
  return [...attached.entries()].map(([tabId, meta]) => ({ tabId, ...meta }));
}

export function isAttached(tabId) {
  return attached.has(tabId);
}

export async function attach(tabId, reason = 'automation') {
  if (attached.has(tabId)) {
    return { attached: true, already: true, tabId };
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    const busy = /another debugger|already attached/i.test(String(error && error.message));
    const wrapped = new Error(
      busy
        ? `Cannot attach the debugger to tab ${tabId}: another debugger (e.g. DevTools) is attached. Close DevTools and try again.`
        : `Cannot attach the debugger to tab ${tabId}: ${error && error.message ? error.message : error}`
    );
    wrapped.code = busy ? 'DEBUGGER_BUSY' : 'DEBUGGER_ATTACH_FAILED';
    throw wrapped;
  }
  attached.set(tabId, { since: Date.now(), reason });
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
  } catch {
    // Page domain is optional; screenshots still work.
  }
  return { attached: true, already: false, tabId };
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return { detached: false, tabId };
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The tab may already be gone.
  }
  attached.delete(tabId);
  mousePositions.delete(tabId);
  return { detached: true, tabId };
}

export async function detachAll() {
  const tabIds = [...attached.keys()];
  await Promise.allSettled(tabIds.map((tabId) => detach(tabId)));
  return { detached: tabIds };
}

export async function send(tabId, method, params = {}) {
  if (!attached.has(tabId)) await attach(tabId, 'command');
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    if (/not attached/i.test(String(error && error.message))) {
      attached.delete(tabId);
      await attach(tabId, 'retry');
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw error;
  }
}

export function modifierMask(modifiers) {
  let mask = 0;
  const list = Array.isArray(modifiers) ? modifiers : [];
  for (const modifier of list) {
    const value = String(modifier).toLowerCase();
    if (value === 'alt' || value === 'option') mask |= 1;
    else if (value === 'control' || value === 'ctrl') mask |= 2;
    else if (value === 'meta' || value === 'command' || value === 'cmd') mask |= 4;
    else if (value === 'shift') mask |= 8;
  }
  return mask;
}

export async function moveMouse(tabId, x, y, options = {}) {
  const targetX = Number(x);
  const targetY = Number(y);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    throw new Error('Mouse target coordinates must be finite numbers.');
  }
  const steps = Math.max(1, Math.min(Number(options.steps) || 8, 80));
  const duration = Math.max(0, Math.min(Number(options.duration) || 120, 3000));
  const jitter = Math.max(0, Math.min(Number(options.jitter) || 1.2, 8));
  const from = mousePositions.get(tabId) || {
    x: Math.max(8, targetX * 0.55),
    y: Math.max(8, targetY * 0.45)
  };

  for (let index = 1; index <= steps; index++) {
    const progress = index / steps;
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    const remaining = 1 - progress;
    const dx = index === steps ? 0 : (Math.random() * 2 - 1) * jitter * remaining;
    const dy = index === steps ? 0 : (Math.random() * 2 - 1) * jitter * remaining;
    const currentX = from.x + (targetX - from.x) * eased + dx;
    const currentY = from.y + (targetY - from.y) * eased + dy;
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(currentX * 100) / 100,
      y: Math.round(currentY * 100) / 100,
      button: 'none',
      buttons: 0
    });
    if (duration && index < steps) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(4, duration / steps)));
    }
  }
  mousePositions.set(tabId, { x: targetX, y: targetY });
  return { x: targetX, y: targetY, steps };
}

export async function clickMouse(tabId, x, y, options = {}) {
  const human = options.human === true;
  if (human) {
    await moveMouse(tabId, x, y, options);
  } else {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', buttons: 0
    });
    mousePositions.set(tabId, { x, y });
  }

  const button = options.button === 'right' ? 'right' : options.button === 'middle' ? 'middle' : 'left';
  const pressedButtons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const modifiers = modifierMask(options.modifiers);
  const clickCount = Math.max(1, Math.min(Number(options.clickCount) || 1, 3));

  for (let count = 1; count <= clickCount; count++) {
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: pressedButtons,
      clickCount: count,
      modifiers
    });
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: count,
      modifiers
    });
    if (count < clickCount) await new Promise((resolve) => setTimeout(resolve, 55));
  }
  mousePositions.set(tabId, { x, y });
  return { x, y, button, clickCount, modifiers };
}

export async function dragMouse(tabId, from, to, options = {}) {
  const human = options.human === true;
  if (human) await moveMouse(tabId, from.x, from.y, { steps: 10, duration: 160 });
  const modifiers = modifierMask(options.modifiers);
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers
  });
  const steps = Math.max(2, Math.min(Number(options.steps) || 16, 80));
  for (let index = 1; index <= steps; index++) {
    const progress = index / steps;
    const x = from.x + (to.x - from.x) * progress;
    const y = from.y + (to.y - from.y) * progress;
    await send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'left', buttons: 1, modifiers
    });
    if (options.duration) await new Promise((resolve) => setTimeout(resolve, Math.max(2, options.duration / steps)));
  }
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers
  });
  mousePositions.set(tabId, { x: to.x, y: to.y });
  return { from, to, steps };
}

const KEY_DEFS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  capslock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 }
};

function charKeyDef(ch) {
  if (ch === '\n' || ch === '\r') return { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' };
  if (ch === '\t') return { key: 'Tab', code: 'Tab', keyCode: 9 };
  if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: ' ' };
  if (/^[a-z]$/i.test(ch)) {
    const upper = ch.toUpperCase();
    return { key: ch, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: ch };
  }
  if (/^[0-9]$/.test(ch)) {
    return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
  }
  return { key: ch, code: '', keyCode: 0, text: ch };
}

export function parseKeyCombo(combo) {
  const parts = String(combo || '').split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers = [];
  let keyPart = parts.pop() || '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'control' || lower === 'ctrl') modifiers.push('control');
    else if (lower === 'alt' || lower === 'option') modifiers.push('alt');
    else if (lower === 'shift') modifiers.push('shift');
    else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modifiers.push('meta');
    else keyPart = part;
  }
  const lower = keyPart.toLowerCase();
  let def = KEY_DEFS[lower];
  if (!def && /^f([1-9]|1[0-2])$/.test(lower)) {
    const number = Number(lower.slice(1));
    def = { key: 'F' + number, code: 'F' + number, keyCode: 111 + number };
  }
  if (!def) def = charKeyDef(keyPart);
  if (modifiers.includes('shift')) {
    if (def.key.length === 1) {
      def = { ...def, key: def.key.toUpperCase(), text: def.key.toUpperCase() };
    }
  }
  if (modifiers.some((modifier) => ['control', 'alt', 'meta'].includes(modifier))) {
    def = { ...def, text: undefined };
  }
  return { ...def, modifiers };
}

export async function pressKey(tabId, combo, options = {}) {
  const def = parseKeyCombo(combo);
  const mask = modifierMask(def.modifiers);
  const base = {
    key: def.key,
    code: def.code || '',
    windowsVirtualKeyCode: def.keyCode || 0,
    nativeVirtualKeyCode: def.keyCode || 0,
    modifiers: mask
  };
  const textPayload = def.text ? { text: def.text, unmodifiedText: def.text } : {};
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...textPayload });
  if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  return { ...def, modifiers: def.modifiers };
}

export async function typeText(tabId, text, options = {}) {
  const delay = Math.max(0, Math.min(Number(options.delay) || 0, 1000));
  const value = String(text == null ? '' : text);
  let typed = 0;
  for (const ch of value) {
    const def = charKeyDef(ch);
    const base = {
      key: def.key,
      code: def.code || '',
      windowsVirtualKeyCode: def.keyCode || 0,
      nativeVirtualKeyCode: def.keyCode || 0,
      modifiers: 0
    };
    const textPayload = def.text ? { text: def.text, unmodifiedText: def.text } : {};
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...textPayload });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    typed++;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { typed, length: value.length };
}

export async function mouseWheel(tabId, options = {}) {
  const x = Number(options.x);
  const y = Number(options.y);
  const deltaX = Number(options.deltaX) || 0;
  const deltaY = Number(options.deltaY) || 0;
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Number.isFinite(x) ? x : 400,
    y: Number.isFinite(y) ? y : 400,
    deltaX,
    deltaY,
    modifiers: modifierMask(options.modifiers)
  });
  return { deltaX, deltaY };
}

export async function getLayoutMetrics(tabId) {
  const metrics = await send(tabId, 'Page.getLayoutMetrics');
  const content = metrics.cssContentSize || metrics.contentSize || {};
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  return {
    contentWidth: content.width || 0,
    contentHeight: content.height || 0,
    viewportWidth: viewport.clientWidth || viewport.width || 0,
    viewportHeight: viewport.clientHeight || viewport.height || 0,
    raw: metrics
  };
}

export async function captureScreenshot(tabId, options = {}) {
  const format = options.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = format === 'jpeg' ? Math.max(1, Math.min(Number(options.quality) || 80, 100)) : undefined;
  const fullPage = !!options.fullPage;
  let clip = options.clip || null;
  let clipped = false;

  if (fullPage && !clip) {
    const metrics = await getLayoutMetrics(tabId);
    const maxHeight = Math.max(200, Math.min(Number(options.maxHeight) || 12000, 20000));
    const width = Math.max(1, Math.min(Math.round(metrics.contentWidth), 20000));
    const height = Math.max(1, Math.min(Math.round(metrics.contentHeight), maxHeight));
    clip = { x: 0, y: 0, width, height, scale: 1 };
    clipped = metrics.contentHeight > maxHeight;
  }

  const params = {
    format,
    fromSurface: true,
    captureBeyondViewport: fullPage || !!options.clip
  };
  if (quality != null) params.quality = quality;
  if (clip) params.clip = { ...clip, scale: clip.scale || 1 };

  const result = await send(tabId, 'Page.captureScreenshot', params);
  return {
    base64: result.data,
    mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    clip,
    clipped,
    fullPage
  };
}

export async function evaluate(tabId, expression, options = {}) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression: String(expression),
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture !== false,
    includeCommandLineAPI: options.includeCommandLineAPI !== false,
    replMode: false
  });

  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description
      : result.exceptionDetails.text || 'Evaluation failed.';
    const error = new Error(description);
    error.details = {
      lineNumber: result.exceptionDetails.lineNumber,
      columnNumber: result.exceptionDetails.columnNumber,
      url: result.exceptionDetails.url
    };
    throw error;
  }

  const remote = result.result || {};
  if (options.returnByValue === false) {
    return { objectId: remote.objectId, type: remote.type, description: remote.description, value: undefined };
  }
  if (remote.type === 'undefined') return { value: null, type: 'undefined' };
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
    return { value: remote.value, type: remote.type, description: remote.description };
  }
  return {
    value: remote.description != null ? remote.description : null,
    type: remote.type,
    subtype: remote.subtype,
    description: remote.description
  };
}

function elementExpression(ref, selector) {
  if (ref) {
    return `(() => {
      const ref = ${JSON.stringify(ref)};
      const visit = (root) => {
        const direct = root.querySelector('[data-oc-ref="' + ref + '"]');
        if (direct) return direct;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = visit(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      return visit(document);
    })()`;
  }
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    try { return document.querySelector(selector); } catch (error) { return null; }
  })()`;
}

export async function uploadFiles(tabId, options = {}) {
  const files = Array.isArray(options.files) ? options.files.filter(Boolean).map(String) : [];
  if (!files.length) throw new Error('No file paths were provided.');
  if (!options.ref && !options.selector) throw new Error('Provide ref or selector for the file input.');

  const expression = `(() => {
    const candidate = ${elementExpression(options.ref, options.selector)};
    if (!candidate) return null;
    if (candidate.tagName === 'INPUT' && candidate.type === 'file') return candidate;
    return candidate.querySelector ? candidate.querySelector('input[type="file"]') : null;
  })()`;

  const evaluation = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: true
  });
  const objectId = evaluation.result && evaluation.result.objectId;
  if (!objectId) {
    throw new Error('File input not found. The element must be an <input type="file"> or contain one.');
  }

  await send(tabId, 'DOM.enable');
  try {
    // Modern Chrome accepts a RemoteObjectId directly, which also works for
    // file inputs inside open shadow roots.
    await send(tabId, 'DOM.setFileInputFiles', { files, objectId });
  } catch (error) {
    const node = await send(tabId, 'DOM.requestNode', { objectId });
    if (!node || !node.nodeId) {
      throw new Error(`Could not resolve the file input node: ${error && error.message ? error.message : error}`);
    }
    await send(tabId, 'DOM.setFileInputFiles', { files, nodeId: node.nodeId });
  }
  try {
    await send(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }`
    });
  } catch {
    // The change event is usually fired by Chrome already.
  }

  return {
    files: files.map((file) => file.split(/[\\/]/).pop()),
    count: files.length
  };
}

export async function emulate(tabId, options = {}) {
  const action = String(options.action || 'set').toLowerCase();
  if (action === 'reset') {
    await send(tabId, 'Emulation.clearDeviceMetricsOverride');
    try { await send(tabId, 'Emulation.setGeolocationOverride', {}); } catch {}
    try { await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: '' }); } catch {}
    try { await send(tabId, 'Emulation.setEmulatedMedia', { features: [] }); } catch {}
    try { await send(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' }); } catch {}
    try {
      await send(tabId, 'Network.enable');
      await send(tabId, 'Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
      });
    } catch {}
    return { reset: true };
  }

  const applied = {};
  if (options.width != null || options.height != null) {
    const width = Math.max(200, Math.min(Number(options.width) || 1280, 10000));
    const height = Math.max(200, Math.min(Number(options.height) || 800, 10000));
    const deviceScaleFactor = Math.max(0.5, Math.min(Number(options.deviceScaleFactor) || 1, 4));
    await send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: !!options.mobile
    });
    applied.viewport = { width, height, deviceScaleFactor, mobile: !!options.mobile };
  }
  if (options.userAgent) {
    await send(tabId, 'Emulation.setUserAgentOverride', { userAgent: String(options.userAgent) });
    applied.userAgent = options.userAgent;
  }
  if (options.latitude != null && options.longitude != null) {
    await send(tabId, 'Emulation.setGeolocationOverride', {
      latitude: Number(options.latitude),
      longitude: Number(options.longitude),
      accuracy: Number(options.accuracy) || 100
    });
    applied.geolocation = { latitude: options.latitude, longitude: options.longitude };
  }
  if (options.colorScheme) {
    await send(tabId, 'Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: String(options.colorScheme) }]
    });
    applied.colorScheme = options.colorScheme;
  }
  if (options.timezone) {
    await send(tabId, 'Emulation.setTimezoneOverride', { timezoneId: String(options.timezone) });
    applied.timezone = options.timezone;
  }
  if (options.offline != null || options.latency != null || options.downloadThroughput != null || options.uploadThroughput != null) {
    await send(tabId, 'Network.enable');
    await send(tabId, 'Network.emulateNetworkConditions', {
      offline: !!options.offline,
      latency: Math.max(0, Number(options.latency) || 0),
      downloadThroughput: Number(options.downloadThroughput) || -1,
      uploadThroughput: Number(options.uploadThroughput) || -1
    });
    applied.network = {
      offline: !!options.offline,
      latency: Number(options.latency) || 0,
      downloadThroughput: options.downloadThroughput,
      uploadThroughput: options.uploadThroughput
    };
  }
  return applied;
}
