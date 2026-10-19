import { z } from 'zod';
import {
  formatBridgeStatus,
  formatStatus,
  formatTabs,
  formatTab,
  formatSnapshot,
  formatNavigation,
  formatClick,
  formatTyping,
  formatWait,
  formatEvaluate,
  formatDom,
  formatConsole,
  formatNetwork,
  formatCookies,
  formatDialog,
  formatJson,
  formatError
} from './format.js';

const waitUntil = z.enum(['none', 'commit', 'domcontentloaded', 'load', 'networkidle']);
const modifiers = z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift', 'Option', 'Command']));

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function imageResult(text, image) {
  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: image.base64, mimeType: image.mimeType }
    ]
  };
}

function errorResult(error) {
  return { isError: true, content: [{ type: 'text', text: formatError(error) }] };
}

function requireTarget(args) {
  if (!args.ref && !args.selector && !args.text && (args.x == null || args.y == null)) {
    throw new Error('Provide ref, selector, text, or x/y coordinates.');
  }
}

function requireGotoUrl(args) {
  if (!args.url) throw new Error('url is required when action is "goto".');
}

function formatScreenshot(result) {
  const lines = [];
  const kind = result.fullPage ? 'full page' : result.target ? 'element' : 'viewport';
  lines.push(`Screenshot (${kind}): ${result.width}×${result.height}px.`);
  if (result.tab) lines.push(`Page: ${result.tab.title || '(untitled)'} — ${result.tab.url}`);
  if (result.annotated) lines.push('Element refs are drawn as colored boxes with labels.');
  if (result.grid) lines.push('A 100px coordinate grid is overlaid.');
  if (result.target && result.target.name) lines.push(`Target: ${result.target.ref || ''} ${result.target.tag || ''} "${result.target.name}"`);
  if (result.fallbackReason) lines.push(`Note: ${result.fallbackReason}`);
  if (result.note) lines.push(result.note);
  return lines.join('\n');
}

export function registerTools(server, bridge) {
  const register = (name, config, handler) => {
    server.registerTool(name, config, async (args, extra) => {
      try {
        return await handler(args || {}, extra);
      } catch (error) {
        return errorResult(error);
      }
    });
  };

  register('status', {
    title: 'Browser status',
    description: 'Check whether the Chrome extension is connected, list open tabs and show the active tab. Call this first when browser tools seem unavailable.',
    inputSchema: {}
  }, async () => {
    const bridgeStatus = bridge.status();
    if (!bridge.ready) return textResult(formatBridgeStatus(bridgeStatus));
    const extension = await bridge.request('status', {}, { timeout: 8000 });
    return textResult(formatStatus(extension, bridgeStatus));
  });

  register('tabs', {
    title: 'Manage tabs',
    description: 'List, create, activate, close, reload, duplicate, pin or mute Chrome tabs. Actions: list, new, activate, close, get, reload, duplicate, pin, mute, unmute.',
    inputSchema: {
      action: z.enum(['list', 'new', 'activate', 'close', 'get', 'reload', 'duplicate', 'pin', 'mute', 'unmute']).default('list'),
      tabId: z.number().int().optional().describe('Target tab id. Defaults to the active tab.'),
      url: z.string().optional().describe('URL for action="new". Defaults to about:blank.'),
      active: z.boolean().optional().describe('For action="new", whether to focus the new tab.'),
      windowId: z.number().int().optional(),
      waitUntil: waitUntil.optional(),
      timeout: z.number().int().min(1000).max(120000).optional(),
      bypassCache: z.boolean().optional(),
      pinned: z.boolean().optional()
    }
  }, async (args) => {
    const result = await bridge.request('tabs', args, { timeout: (args.timeout || 30000) + 15000 });
    if (args.action === 'list') return textResult(formatTabs(result.tabs));
    if (args.action === 'new' || args.action === 'get' || args.action === 'activate') return textResult(formatTab(result.tab));
    if (args.action === 'close') return textResult(`Closed tab ${result.tabId}.`);
    if (args.action === 'duplicate') return textResult(`Duplicated tab. New tab: ${formatTab(result.tab)}`);
    return textResult(formatJson(result));
  });

  register('navigate', {
    title: 'Navigate',
    description: 'Open a URL, go back/forward, reload or stop the active tab. Waits for the requested load state. Use newTab=true to open in a new tab.',
    inputSchema: {
      action: z.enum(['goto', 'back', 'forward', 'reload', 'stop']).default('goto'),
      url: z.string().optional().describe('URL for action="goto". A bare domain is upgraded to https://.'),
      tabId: z.number().int().optional(),
      newTab: z.boolean().optional().describe('Open the URL in a new tab.'),
      active: z.boolean().optional().describe('Focus the tab after navigating. Default true.'),
      waitUntil: waitUntil.default('domcontentloaded'),
      timeout: z.number().int().min(1000).max(120000).default(30000),
      bypassCache: z.boolean().optional()
    }
  }, async (args) => {
    if (args.action === 'goto') requireGotoUrl(args);
    const result = await bridge.request('navigate', args, { timeout: args.timeout + 25000 });
    return textResult(formatNavigation(result));
  });

  register('snapshot', {
    title: 'Snapshot page',
    description: 'Return a compact accessibility-style tree with stable refs (e.g. f0_e12) for interactive elements. Do this before clicking or typing. Refs belong to a frame; use allFrames=true to include iframes.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional().describe('Frame id. Defaults to the top frame (0) or the frame encoded in a ref.'),
      allFrames: z.boolean().optional().describe('Snapshot the top frame and all iframes.'),
      selector: z.string().optional().describe('Restrict the snapshot to a subtree.'),
      mode: z.enum(['interactive', 'full']).default('interactive'),
      maxNodes: z.number().int().min(20).max(2000).default(400),
      maxDepth: z.number().int().min(3).max(80).default(24),
      includeHidden: z.boolean().optional(),
      includeBboxes: z.boolean().optional().describe('Include element bounding boxes in the tree.'),
      timeout: z.number().int().min(1000).max(120000).default(20000)
    }
  }, async (args) => {
    const result = await bridge.request('snapshot', args, { timeout: args.timeout + 10000 });
    return textResult(formatSnapshot(result));
  });

  register('screenshot', {
    title: 'Screenshot',
    description: 'Capture the viewport, the full page, or one element. Set annotate=true to draw element refs as labeled boxes and grid=true for a 100px coordinate grid. Returns an image the model can see.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      fullPage: z.boolean().optional().describe('Capture the entire scrollable page.'),
      ref: z.string().optional().describe('Capture a specific element by ref.'),
      selector: z.string().optional().describe('Capture a specific element by CSS selector.'),
      annotate: z.boolean().optional().describe('Draw boxes/labels for element refs.'),
      grid: z.boolean().optional().describe('Draw a 100px coordinate grid.'),
      format: z.enum(['png', 'jpeg']).default('png'),
      quality: z.number().int().min(1).max(100).optional(),
      maxWidth: z.number().int().min(200).max(6000).optional(),
      maxHeight: z.number().int().min(200).max(12000).optional(),
      trusted: z.boolean().optional().describe('Force CDP on/off for this capture.'),
      timeout: z.number().int().min(1000).max(180000).default(60000)
    }
  }, async (args) => {
    if (args.ref && args.selector) throw new Error('Use either ref or selector, not both.');
    const result = await bridge.request('screenshot', args, { timeout: args.timeout + 15000 });
    if (!result.image || !result.image.base64) throw new Error('The extension did not return screenshot data.');
    return imageResult(formatScreenshot(result), result.image);
  });

  register('click', {
    title: 'Click',
    description: 'Click an element by ref (preferred), CSS selector, visible text, or viewport coordinates. Uses trusted CDP input by default and falls back to DOM events. Waits for a navigation if one starts.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional().describe('Visible text or accessible name to match.'),
      exactText: z.boolean().optional(),
      x: z.number().optional().describe('Viewport X coordinate, if not using ref/selector/text.'),
      y: z.number().optional(),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      clickCount: z.number().int().min(1).max(3).default(1),
      modifiers: modifiers.optional(),
      trusted: z.boolean().optional().describe('true = real CDP input; false = DOM events.'),
      human: z.boolean().optional().describe('Move the mouse along a human-like path. Default false (faster); set true only when a site needs human-like movement.'),
      waitUntil: waitUntil.default('domcontentloaded'),
      timeout: z.number().int().min(1000).max(120000).default(30000),
      detectNavigationMs: z.number().int().min(100).max(5000).optional().describe('How long to watch for a navigation after the click. Default 700.'),
      switchToNewTab: z.boolean().optional(),
      delayAfter: z.number().int().min(0).max(5000).optional()
    }
  }, async (args) => {
    requireTarget(args);
    if ((args.x == null) !== (args.y == null)) throw new Error('Provide both x and y, or neither.');
    const result = await bridge.request('click', args, { timeout: (args.timeout || 30000) + 20000 });
    return textResult(formatClick(result));
  });

  register('type', {
    title: 'Type text',
    description: 'Type into an input, textarea or contenteditable element. Clears the field by default and uses trusted CDP keystrokes. Set pressEnter=true to submit. If no target is given, types into the focused element.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      focused: z.boolean().optional().describe('Type into the currently focused element.'),
      text: z.string(),
      clear: z.boolean().optional().describe('Clear the field before typing. Default true.'),
      delay: z.number().int().min(0).max(1000).optional().describe('Delay per character in ms.'),
      pressEnter: z.boolean().optional(),
      trusted: z.boolean().optional(),
      waitUntil: waitUntil.default('domcontentloaded'),
      timeout: z.number().int().min(1000).max(120000).default(30000),
      delayAfter: z.number().int().min(0).max(5000).optional()
    }
  }, async (args) => {
    if (!args.ref && !args.selector) args.focused = true;
    const result = await bridge.request('type', args, { timeout: (args.timeout || 30000) + 20000 });
    return textResult(formatTyping(result));
  });

  register('press', {
    title: 'Press key',
    description: 'Press a key or key combination: Enter, Tab, Escape, Backspace, ArrowDown, Control+A, Shift+Enter, F5, etc. Optionally focus an element first.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      key: z.string().default('Enter'),
      trusted: z.boolean().optional(),
      delay: z.number().int().min(0).max(2000).optional(),
      noSubmit: z.boolean().optional().describe('Do not submit a form when pressing Enter.'),
      waitUntil: waitUntil.default('domcontentloaded'),
      timeout: z.number().int().min(1000).max(120000).default(30000)
    }
  }, async (args) => {
    const result = await bridge.request('press', args, { timeout: (args.timeout || 30000) + 20000 });
    const lines = [`Pressed ${result.key || args.key}${result.code ? ` (${result.code})` : ''} via ${result.via || 'unknown'}.`];
    if (result.submitted) lines.push('The form was submitted.');
    if (result.fallbackReason) lines.push(`CDP fallback: ${result.fallbackReason}`);
    if (result.navigation && result.navigation.navigated && result.navigation.tab) {
      lines.push(`Now at: ${result.navigation.tab.title || '(untitled)'} — ${result.navigation.tab.url}`);
    }
    return textResult(lines.join('\n'));
  });

  register('hover', {
    title: 'Hover',
    description: 'Move the real mouse over an element to trigger CSS :hover, tooltips and menus. Falls back to synthetic mouse events without CDP.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      trusted: z.boolean().optional(),
      durationMs: z.number().int().min(0).max(10000).optional().describe('Keep the page open after hovering.'),
      steps: z.number().int().min(1).max(80).optional(),
      duration: z.number().int().min(0).max(3000).optional().describe('Mouse movement duration in ms.')
    }
  }, async (args) => {
    requireTarget(args);
    const result = await bridge.request('hover', args, { timeout: 20000 });
    return textResult(`Hovered ${result.target ? `${result.target.ref || ''} <${result.target.tag || ''}> "${result.target.name || ''}"` : 'element'} via ${result.via}.`);
  });

  register('select', {
    title: 'Select option',
    description: 'Choose one or more options in a native <select> by value, label or index. For custom dropdowns, click the trigger and then click an option with chrome_click.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      value: z.string().optional(),
      values: z.array(z.string()).optional(),
      label: z.string().optional(),
      labels: z.array(z.string()).optional(),
      index: z.number().int().optional(),
      indexes: z.array(z.number().int()).optional()
    }
  }, async (args) => {
    if (!args.ref && !args.selector) throw new Error('Provide ref or selector.');
    if (args.value == null && !args.values && args.label == null && !args.labels && args.index == null && !args.indexes) {
      throw new Error('Provide value, values, label, labels, index or indexes.');
    }
    const result = await bridge.request('select', args, { timeout: 15000 });
    return textResult(`Selected:\n${formatJson(result.selected)}`);
  });

  register('scroll', {
    title: 'Scroll',
    description: 'Scroll the page or a container, jump to top/bottom, or bring an element into view. Uses trusted mouse wheel events when CDP is available.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
      amount: z.number().int().min(50).max(10000).default(600),
      to: z.enum(['top', 'bottom']).optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      containerRef: z.string().optional(),
      containerSelector: z.string().optional(),
      smooth: z.boolean().optional(),
      trusted: z.boolean().optional()
    }
  }, async (args) => {
    const result = await bridge.request('scroll', args, { timeout: 15000 });
    const position = result.scrollY != null ? `scrollY=${result.scrollY}/${result.scrollHeight}` : `scrollTop=${result.after ?? '?'}`;
    return textResult(`Scrolled via ${result.via || 'dom'} (${position}).`);
  });

  register('wait_for', {
    title: 'Wait for condition',
    description: 'Wait for a selector/text state, a URL, a JavaScript predicate, or a page load state. Use after actions that trigger async updates or navigation.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      exact: z.boolean().optional(),
      state: z.enum(['visible', 'attached', 'hidden', 'detached']).default('visible'),
      urlIncludes: z.string().optional(),
      urlMatches: z.string().optional().describe('JavaScript regular expression source.'),
      js: z.string().optional().describe('JavaScript expression/predicate.'),
      loadState: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).optional(),
      timeout: z.number().int().min(100).max(120000).default(10000),
      interval: z.number().int().min(50).max(2000).default(200),
      trusted: z.boolean().optional()
    }
  }, async (args) => {
    if (!args.selector && !args.text && !args.urlIncludes && !args.urlMatches && !args.js && !args.loadState) {
      throw new Error('Provide selector, text, urlIncludes, urlMatches, js or loadState.');
    }
    const result = await bridge.request('waitFor', args, { timeout: args.timeout + 15000 });
    return textResult(formatWait(result));
  });

  register('evaluate', {
    title: 'Evaluate JavaScript',
    description: 'Execute JavaScript in the page main world and return a JSON value. Use an IIFE for multiple statements, e.g. "(() => ({title: document.title}))()". Powerful: prefer snapshot/DOM when possible.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      expression: z.string(),
      awaitPromise: z.boolean().optional(),
      returnByValue: z.boolean().optional(),
      userGesture: z.boolean().optional(),
      trusted: z.boolean().optional()
    }
  }, async (args) => {
    const result = await bridge.request('evaluate', args, { timeout: 40000 });
    return textResult(formatEvaluate(result));
  });

  register('dom', {
    title: 'Inspect DOM',
    description: 'Query DOM elements and return metadata, HTML, text, attributes, computed styles, rects or counts. Supports open shadow DOM with the ">>>" separator, e.g. "my-app >>> button".',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      action: z.enum(['query', 'html', 'text', 'attributes', 'styles', 'rect', 'count']).default('query'),
      selector: z.string().optional(),
      ref: z.string().optional(),
      xpath: z.string().optional(),
      all: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeHtml: z.boolean().optional(),
      maxLength: z.number().int().min(100).max(30000).optional(),
      properties: z.array(z.string()).optional().describe('CSS properties to return for action="styles".'),
      timeout: z.number().int().min(1000).max(60000).default(10000)
    }
  }, async (args) => {
    if (!args.selector && !args.ref && !args.xpath && args.action !== 'text') {
      throw new Error('Provide selector, ref or xpath.');
    }
    const result = await bridge.request('dom', args, { timeout: args.timeout + 10000 });
    return textResult(formatDom(result));
  });

  register('fill_form', {
    title: 'Fill form',
    description: 'Fill multiple fields in one call and optionally submit. Each field may use ref or selector; type can be "text", "select", "checkbox" or "radio".',
    inputSchema: {
      tabId: z.number().int().optional(),
      trusted: z.boolean().optional(),
      timeout: z.number().int().min(1000).max(120000).optional(),
      continueOnError: z.boolean().optional(),
      fields: z.array(z.object({
        ref: z.string().optional(),
        selector: z.string().optional(),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        text: z.string().optional(),
        type: z.enum(['text', 'select', 'checkbox', 'radio']).optional(),
        checked: z.boolean().optional(),
        values: z.array(z.string()).optional(),
        label: z.string().optional(),
        index: z.number().int().optional(),
        clear: z.boolean().optional(),
        delay: z.number().int().min(0).max(1000).optional(),
        pressEnter: z.boolean().optional(),
        frameId: z.number().int().optional()
      })),
      submit: z.union([
        z.boolean(),
        z.object({ ref: z.string().optional(), selector: z.string().optional() })
      ]).optional()
    }
  }, async (args) => {
    if (!Array.isArray(args.fields) || !args.fields.length) throw new Error('fields must be a non-empty array.');
    const result = await bridge.request('fillForm', args, { timeout: 90000 });
    const lines = ['Form fill results:'];
    for (const item of result.fields || []) {
      const target = item.field ? (item.field.ref || item.field.selector) : '?';
      lines.push(`- ${target}: ${item.ok ? 'ok' : 'error — ' + item.error}`);
    }
    if (result.submitted) lines.push('Form submitted.');
    return textResult(lines.join('\n'));
  });

  register('upload_file', {
    title: 'Upload file',
    description: 'Set one or more files on an <input type="file"> using absolute paths on the machine running Chrome. Requires CDP and the top frame.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      ref: z.string().optional(),
      selector: z.string().optional(),
      files: z.array(z.string()).min(1)
    }
  }, async (args) => {
    if (!args.ref && !args.selector) throw new Error('Provide ref or selector.');
    const result = await bridge.request('uploadFile', args, { timeout: 30000 });
    return textResult(`Attached ${result.count} file(s): ${result.files.join(', ')}`);
  });

  register('console', {
    title: 'Read console',
    description: 'Read console logs, warnings, errors and unhandled rejections captured since page load. Use action="clear" to reset the buffer.',
    inputSchema: {
      tabId: z.number().int().optional(),
      action: z.enum(['get', 'clear']).default('get'),
      level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional(),
      limit: z.number().int().min(1).max(400).default(200)
    }
  }, async (args) => {
    const result = await bridge.request('console', args, { timeout: 15000 });
    if (args.action === 'clear') return textResult('Console buffer cleared.');
    return textResult(formatConsole(result));
  });

  register('network', {
    title: 'Read network activity',
    description: 'Read fetch/XHR requests captured since page load, including status, duration and errors. Set includeStatic=true to include scripts/images/cached resource timings.',
    inputSchema: {
      tabId: z.number().int().optional(),
      action: z.enum(['get', 'clear']).default('get'),
      filter: z.string().optional().describe('Only URLs containing this substring.'),
      type: z.string().optional().describe('Filter by resource type, e.g. fetch, xmlhttprequest, image.'),
      status: z.number().int().optional(),
      includeStatic: z.boolean().optional(),
      limit: z.number().int().min(1).max(400).default(200)
    }
  }, async (args) => {
    const result = await bridge.request('network', args, { timeout: 15000 });
    if (args.action === 'clear') return textResult('Network buffer cleared.');
    return textResult(formatNetwork(result));
  });

  register('cookies', {
    title: 'Cookies',
    description: 'Read, set, delete or clear cookies for the current site using Chrome cookies API. Values are returned to the model: handle secrets carefully.',
    inputSchema: {
      tabId: z.number().int().optional(),
      action: z.enum(['get', 'set', 'delete', 'clear']).default('get'),
      url: z.string().optional(),
      domain: z.string().optional(),
      name: z.string().optional(),
      value: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      httpOnly: z.boolean().optional(),
      sameSite: z.enum(['unspecified', 'no_restriction', 'none', 'lax', 'strict']).optional(),
      expirationDate: z.number().optional(),
      storeId: z.string().optional()
    }
  }, async (args) => {
    const result = await bridge.request('cookies', args, { timeout: 20000 });
    return textResult(formatCookies(result));
  });

  register('dialog', {
    title: 'JavaScript dialogs',
    description: 'Inspect recent alert/confirm/prompt dialogs, clear the log, or change how future dialogs are answered. Interception avoids blocking automation.',
    inputSchema: {
      tabId: z.number().int().optional(),
      action: z.enum(['status', 'set_policy', 'clear']).default('status'),
      intercept: z.boolean().optional(),
      confirm: z.boolean().optional().describe('Answer for window.confirm.'),
      prompt: z.string().optional().describe('Answer for window.prompt.')
    }
  }, async (args) => {
    const result = await bridge.request('dialog', args, { timeout: 15000 });
    if (args.action === 'clear') return textResult('Dialog log cleared.');
    return textResult(formatDialog(result));
  });

  register('highlight', {
    title: 'Highlight elements',
    description: 'Draw temporary labeled outlines over one element, all elements with refs, or a selector/text match on the live page. Useful for visual debugging and demos.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      action: z.enum(['show', 'clear']).default('show'),
      ref: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      all: z.boolean().optional(),
      color: z.string().optional(),
      durationMs: z.number().int().min(0).max(60000).optional()
    }
  }, async (args) => {
    const result = await bridge.request('highlight', args, { timeout: 15000 });
    if (args.action === 'clear') return textResult('Highlights cleared.');
    return textResult(`Highlighted ${result.highlighted} element(s) for ${result.durationMs}ms.`);
  });

  register('drag', {
    title: 'Drag and drop',
    description: 'Drag from one element/point to another using real mouse events when CDP is available, with synthetic pointer/drag events as fallback. Works for pointer-based UIs and many HTML5 drop zones.',
    inputSchema: {
      tabId: z.number().int().optional(),
      frameId: z.number().int().optional(),
      fromRef: z.string().optional(),
      fromSelector: z.string().optional(),
      fromX: z.number().optional(),
      fromY: z.number().optional(),
      toRef: z.string().optional(),
      toSelector: z.string().optional(),
      toX: z.number().optional(),
      toY: z.number().optional(),
      steps: z.number().int().min(2).max(80).optional(),
      duration: z.number().int().min(0).max(3000).optional(),
      trusted: z.boolean().optional()
    }
  }, async (args) => {
    const hasFrom = args.fromRef || args.fromSelector || (args.fromX != null && args.fromY != null);
    const hasTo = args.toRef || args.toSelector || (args.toX != null && args.toY != null);
    if (!hasFrom || !hasTo) throw new Error('Provide fromRef/fromSelector/fromX+fromY and toRef/toSelector/toX+toY.');
    const result = await bridge.request('drag', args, { timeout: 30000 });
    return textResult(`Dragged via ${result.via} from (${result.from?.x}, ${result.from?.y}) to (${result.to?.x}, ${result.to?.y}).`);
  });

  register('emulate', {
    title: 'Emulate device/network',
    description: 'Emulate viewport size, device scale, mobile, user agent, geolocation, color scheme, timezone or offline/network conditions. Requires CDP. Use action="reset" to clear overrides.',
    inputSchema: {
      tabId: z.number().int().optional(),
      action: z.enum(['set', 'reset']).default('set'),
      width: z.number().int().min(200).max(10000).optional(),
      height: z.number().int().min(200).max(10000).optional(),
      deviceScaleFactor: z.number().min(0.5).max(4).optional(),
      mobile: z.boolean().optional(),
      userAgent: z.string().optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      accuracy: z.number().min(0).optional(),
      colorScheme: z.enum(['light', 'dark']).optional(),
      timezone: z.string().optional(),
      offline: z.boolean().optional(),
      latency: z.number().min(0).optional(),
      downloadThroughput: z.number().optional(),
      uploadThroughput: z.number().optional()
    }
  }, async (args) => {
    const result = await bridge.request('emulate', args, { timeout: 30000 });
    return textResult(formatJson(result));
  });

  register('debugger', {
    title: 'Debugger (CDP)',
    description: 'Show, attach or detach the Chrome debugger for a tab. CDP enables trusted input, full-page screenshots, evaluation, uploads and emulation. Attaching shows a Chrome debug banner.',
    inputSchema: {
      action: z.enum(['status', 'attach', 'detach']).default('status'),
      tabId: z.number().int().optional()
    }
  }, async (args) => {
    const result = await bridge.request('debugger', args, { timeout: 20000 });
    return textResult(formatJson(result));
  });
}
