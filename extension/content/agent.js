/*
 * OpenCode Browser Bridge - in-page agent (ISOLATED world).
 *
 * Injected on demand by the service worker into the target frame. It exposes
 * an idempotent `__OC_AGENT__.handle()` entrypoint used for snapshots, element
 * lookup, clicks, typing, scrolling, waiting, DOM inspection and highlights.
 *
 * All returned values are plain JSON-serializable objects because they cross
 * the chrome.scripting boundary.
 */
(() => {
  'use strict';

  const VERSION = 1;
  if (globalThis.__OC_AGENT__ && globalThis.__OC_AGENT__.version === VERSION) return;

  const state = {
    version: VERSION,
    prefix: 'f0_',
    counter: 0,
    refs: new Map(),
    byElement: new WeakMap(),
    highlightTimer: null,
    highlightLayer: null
  };

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title',
    'base', 'source', 'track', 'param', 'br', 'wbr'
  ]);

  const TEXT_BLOCK_TAGS = new Set([
    'p', 'li', 'td', 'th', 'blockquote', 'pre', 'figcaption', 'caption',
    'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
  ]);

  const LANDMARK_ROLES = new Set([
    'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region',
    'search', 'form', 'dialog', 'alert', 'status', 'tablist', 'tabpanel',
    'menu', 'menubar', 'toolbar', 'grid', 'tree', 'group'
  ]);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox',
    'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell',
    'columnheader', 'rowheader', 'scrollbar'
  ]);

  const STRUCTURAL_TAGS = new Set([
    'main', 'nav', 'header', 'footer', 'aside', 'section', 'article', 'form',
    'fieldset', 'dialog', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol',
    'dl', 'details', 'summary', 'iframe', 'div'
  ]);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function truncate(value, max = 240) {
    const text = clean(value);
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function quote(value, max = 240) {
    return '"' + truncate(value, max).replace(/"/g, "'") + '"';
  }

  function norm(value) {
    return clean(value).toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function setPrefix(prefix) {
    if (typeof prefix !== 'string' || !prefix) return;
    if (state.prefix === prefix) return;
    state.prefix = prefix;
    state.refs.clear();
    state.byElement = new WeakMap();
    state.counter = 0;
  }

  function refFor(el) {
    let ref = state.byElement.get(el);
    if (ref && state.refs.get(ref) === el && el.isConnected) return ref;
    ref = state.prefix + 'e' + (++state.counter);
    state.refs.set(ref, el);
    state.byElement.set(el, ref);
    try {
      el.setAttribute('data-oc-ref', ref);
    } catch {
      // Some exotic elements reject attributes; the Map still works.
    }
    return ref;
  }

  function resolveRef(ref) {
    const el = state.refs.get(ref);
    if (el && el.isConnected) return el;
    const found = deepQueryAll(`[data-oc-ref="${String(ref).replace(/"/g, '\\"')}"]`)[0];
    if (found) {
      state.refs.set(ref, found);
      state.byElement.set(found, ref);
      return found;
    }
    throw new Error(`Element ref "${ref}" is stale or does not exist in this frame. Take a new snapshot.`);
  }

  function collectRoots(root, out) {
    if (!root || !root.querySelectorAll) return;
    out.push(root);
    if (root.shadowRoot) collectRoots(root.shadowRoot, out);
    let all;
    try {
      all = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of all) {
      if (el.shadowRoot) collectRoots(el.shadowRoot, out);
    }
  }

  function deepQueryAll(selector, root = document) {
    const roots = [];
    collectRoots(root, roots);
    const out = [];
    for (const scope of roots) {
      try {
        out.push(...scope.querySelectorAll(selector));
      } catch {
        // Invalid selector; let the caller report it.
      }
    }
    return [...new Set(out)];
  }

  function queryDeep(selector, root = document) {
    const parts = String(selector).split('>>>').map((part) => part.trim()).filter(Boolean);
    if (parts.length <= 1) return deepQueryAll(selector, root);
    let scopes = [root];
    for (const part of parts) {
      const next = [];
      for (const scope of scopes) next.push(...deepQueryAll(part, scope));
      scopes = [...new Set(next)];
      if (!scopes.length) break;
    }
    return scopes;
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.documentElement || el === document.body) return true;
    if (el.hidden) return false;
    try {
      if (el.closest('[hidden]') || el.closest('[inert]')) return false;
    } catch {
      // Ignore.
    }
    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      return false;
    }
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (style.display === 'contents') return true;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  function directText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += ' ' + (node.nodeValue || '');
    }
    return clean(text);
  }

  function innerText(el) {
    try {
      return clean(el.innerText || el.textContent || '');
    } catch {
      return clean(el.textContent || '');
    }
  }

  function getRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      pageX: rect.left + window.scrollX,
      pageY: rect.top + window.scrollY
    };
  }

  function accessibleName(el, max = 200) {
    if (!el || el.nodeType !== 1) return '';
    try {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map((id) => {
          const node = document.getElementById(id);
          return node ? innerText(node) : '';
        }).filter(Boolean);
        if (parts.length) return truncate(parts.join(' '), max);
      }
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return truncate(ariaLabel, max);

      const tag = el.tagName.toLowerCase();
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['submit', 'button', 'reset'].includes(type) && el.value) return truncate(el.value, max);
        if (type === 'image' && el.getAttribute('alt')) return truncate(el.getAttribute('alt'), max);
        if (type === 'file') {
          const names = el.files ? [...el.files].map((file) => file.name) : [];
          return names.length ? `Choose file: ${names.join(', ')}` : 'Choose file';
        }
      }

      if (el.labels && el.labels.length) {
        const label = [...el.labels].map((item) => innerText(item)).filter(Boolean).join(' ');
        if (label) return truncate(label, max);
      }

      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return truncate(placeholder, max);
      const alt = el.getAttribute('alt');
      if (alt) return truncate(alt, max);
      const title = el.getAttribute('title');
      if (title) return truncate(title, max);
      if (el.getAttribute('aria-valuetext')) return truncate(el.getAttribute('aria-valuetext'), max);

      if (tag === 'select') {
        const selected = el.selectedOptions && el.selectedOptions[0];
        if (selected) return truncate(innerText(selected) || selected.value, max);
      }
      if (tag === 'textarea' && el.value) return truncate(el.value, max);
      if (tag === 'input' && el.value && !['password', 'hidden'].includes((el.type || '').toLowerCase())) {
        return truncate(el.value, max);
      }

      const text = innerText(el);
      if (text) return truncate(text, max);
      const name = el.getAttribute('name');
      if (name) return truncate(name, max);
      return '';
    } catch {
      return '';
    }
  }

  function roleOf(el) {
    if (!el || el.nodeType !== 1) return 'generic';
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple || Number(el.getAttribute('size') || 0) > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return 'none';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) return 'button';
      return 'textbox';
    }
    if (tag === 'summary') return 'button';
    if (tag === 'details') return 'group';
    if (tag === 'img') return 'img';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'canvas') return 'img';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    if (tag === 'ul' || tag === 'ol' || tag === 'dl') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'form') return 'form';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'fieldset') return 'group';
    if (tag === 'option') return 'option';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }

  function isInteractive(el, role = roleOf(el)) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href');
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary' || tag === 'details') return true;
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase() !== 'hidden';
    if (tag === 'audio' || tag === 'video') return el.hasAttribute('controls');
    if (el.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex')) return el.tabIndex >= 0;
    return INTERACTIVE_ROLES.has(role);
  }

  function shouldPrint(el, role, name, opts, insideTextBlock) {
    const tag = el.tagName.toLowerCase();
    if (isInteractive(el, role)) return true;
    if (role === 'heading') return true;
    if (role === 'iframe' || role === 'img') return !!(name || tag === 'iframe');
    if (role === 'table' || role === 'row' || role === 'cell' || role === 'columnheader' || role === 'list' || role === 'listitem') return true;
    if (LANDMARK_ROLES.has(role)) return true;
    if (TEXT_BLOCK_TAGS.has(tag)) return !!name && !insideTextBlock;
    if (opts.mode === 'full') {
      if (tag === 'section' || tag === 'article' || tag === 'div' || tag === 'span') return !!name;
    }
    return false;
  }

  function formatNode(el, role, name, ref, opts) {
    const tag = el.tagName.toLowerCase();
    const parts = [role];
    if (name) parts.push(quote(name, TEXT_BLOCK_TAGS.has(tag) ? 300 : 160));

    const attrs = [];
    if (ref) attrs.push(`ref=${ref}`);
    if (role === 'heading') {
      const level = Number(tag.slice(1));
      if (level) attrs.push(`level=${level}`);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
    if (el.checked) attrs.push('checked');
    if (el.selected) attrs.push('selected');
    if (el.required) attrs.push('required');
    if (el.readOnly) attrs.push('readonly');
    if (el.multiple) attrs.push('multiple');
    if (el.getAttribute('aria-expanded') != null) attrs.push(`expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-checked') != null) attrs.push(`checked=${el.getAttribute('aria-checked')}`);
    if (el.getAttribute('aria-selected') != null) attrs.push(`selected=${el.getAttribute('aria-selected')}`);

    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type !== 'text') attrs.push(`type=${type}`);
      if (type === 'password') attrs.push('value="••••"');
      else if (type !== 'file' && el.value) attrs.push(`value=${quote(el.value, 100)}`);
    } else if (tag === 'textarea' && el.value) {
      attrs.push(`value=${quote(el.value, 100)}`);
    } else if (tag === 'select') {
      const selected = el.selectedOptions ? [...el.selectedOptions].map((option) => option.value).slice(0, 5) : [];
      if (selected.length) attrs.push(`value=${quote(selected.join('|'), 100)}`);
    }

    if (tag === 'input' && el.getAttribute('placeholder')) attrs.push(`placeholder=${quote(el.getAttribute('placeholder'), 80)}`);
    if (tag === 'a' && el.getAttribute('href')) attrs.push(`href=${quote(el.getAttribute('href'), 160)}`);
    if ((tag === 'iframe' || tag === 'img') && el.getAttribute('src')) attrs.push(`src=${quote(el.getAttribute('src'), 160)}`);
    if (el.id) attrs.push(`id=${quote(el.id, 80)}`);
    if (el.getAttribute('name')) attrs.push(`name=${quote(el.getAttribute('name'), 80)}`);
    if (el.getAttribute('data-testid')) attrs.push(`testid=${quote(el.getAttribute('data-testid'), 80)}`);

    if (opts.includeBboxes) {
      const rect = getRect(el);
      attrs.push(`bbox=${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
    }

    return parts.join(' ') + (attrs.length ? ' [' + attrs.join('] [') + ']' : '');
  }

  function snapshot(params = {}) {
    const opts = {
      mode: params.mode === 'full' ? 'full' : 'interactive',
      maxNodes: Math.max(20, Math.min(Number(params.maxNodes) || 400, 2000)),
      maxDepth: Math.max(3, Math.min(Number(params.maxDepth) || 24, 80)),
      includeHidden: !!params.includeHidden,
      includeBboxes: !!params.includeBboxes,
      selector: params.selector || null
    };
    let root = document.body;
    if (opts.selector) {
      root = queryDeep(opts.selector)[0];
      if (!root) throw new Error(`Snapshot root not found: ${opts.selector}`);
    }
    if (!root) {
      return {
        title: document.title,
        url: location.href,
        tree: '(document has no body)',
        refs: [],
        stats: { nodes: 0, interactive: 0, truncated: false }
      };
    }

    const lines = [];
    const refs = [];
    let nodes = 0;
    let interactiveCount = 0;
    let truncated = false;
    const seen = new Set();

    function addLine(depth, text) {
      lines.push('  '.repeat(Math.min(depth, 40)) + '- ' + text);
    }

    function walk(el, depth, insideTextBlock) {
      if (nodes >= opts.maxNodes) {
        truncated = true;
        return;
      }
      if (!el || el.nodeType !== 1 || seen.has(el)) return;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'svg' || tag === 'path' || tag === 'g' || tag === 'use') return;
      if (!opts.includeHidden && !isVisible(el)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (el.getAttribute('role') === 'presentation' || el.getAttribute('role') === 'none') return;

      const role = roleOf(el);
      let name = accessibleName(el, TEXT_BLOCK_TAGS.has(tag) ? 300 : 180);
      if (tag === 'li') {
        const ownText = directText(el);
        if (ownText) name = truncate(ownText, 300);
      }
      const interactive = isInteractive(el, role);
      const prints = shouldPrint(el, role, name, opts, insideTextBlock);
      let childDepth = depth;
      let textPrinted = false;

      if (prints) {
        if (depth > opts.maxDepth) {
          truncated = true;
          return;
        }
        let ref = null;
        if (interactive || role === 'iframe') {
          ref = refFor(el);
          interactiveCount++;
          const rect = getRect(el);
          refs.push({
            ref,
            role,
            name: truncate(name, 120),
            tag,
            type: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
            href: tag === 'a' ? el.getAttribute('href') || undefined : undefined,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            pageX: Math.round(rect.pageX),
            pageY: Math.round(rect.pageY),
            disabled: !!el.disabled,
            checked: typeof el.checked === 'boolean' ? el.checked : undefined,
            value: tag === 'input' && (el.type || '').toLowerCase() === 'password' ? '••••' : undefined
          });
        }
        addLine(depth, formatNode(el, role, name, ref, opts));
        nodes++;
        childDepth = depth + 1;
        if (TEXT_BLOCK_TAGS.has(tag) || tag === 'a' || tag === 'button' || tag === 'summary') textPrinted = true;
      }

      if (tag === 'iframe') return;

      const children = [];
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) children.push(child);
        for (const slot of el.shadowRoot.querySelectorAll('slot')) {
          for (const assigned of slot.assignedElements ? slot.assignedElements() : []) children.push(assigned);
        }
      }
      for (const child of el.children) children.push(child);

      const nextSuppress = insideTextBlock || textPrinted;
      for (const child of children) walk(child, childDepth, nextSuppress);
    }

    try {
      walk(root, 0, false);
    } catch (error) {
      lines.push(`... (snapshot stopped: ${error && error.message ? error.message : error})`);
      truncated = true;
    }

    if (truncated) lines.push(`... (truncated at ${nodes} nodes; refine with selector, maxNodes or mode="full")`);
    if (!lines.length) lines.push('(no visible elements matched)');

    return {
      title: document.title,
      url: location.href,
      tree: lines.join('\n'),
      refs,
      stats: {
        nodes,
        interactive: interactiveCount,
        truncated,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
        scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
      }
    };
  }

  function getRects(params = {}) {
    const limit = Math.max(1, Math.min(Number(params.limit) || 400, 1000));
    const out = [];
    for (const el of deepQueryAll('[data-oc-ref]')) {
      if (out.length >= limit) break;
      if (!isVisible(el)) continue;
      const ref = el.getAttribute('data-oc-ref');
      if (!ref || ref.indexOf(state.prefix) !== 0) continue;
      const rect = getRect(el);
      out.push({
        ref,
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        name: truncate(accessibleName(el, 100), 100),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        pageX: Math.round(rect.pageX),
        pageY: Math.round(rect.pageY)
      });
    }
    return {
      rects: out,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      dpr: window.devicePixelRatio || 1,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
    };
  }

  function getPosition() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      dpr: window.devicePixelRatio || 1,
      bodyText: truncate(innerText(document.body || document.documentElement), 1500)
    };
  }

  function findByText(text, options = {}) {
    const needle = norm(text);
    if (!needle) return null;
    const exact = !!options.exact;
    const candidates = queryDeep(
      'a,button,input,select,textarea,summary,label,[role],[contenteditable="true"],' +
      'h1,h2,h3,h4,h5,h6,p,li,td,th,div,span',
      options.root || document
    );
    let best = null;
    let matches = 0;
    for (const el of candidates) {
      if (el === document.documentElement || el === document.body) continue;
      if (!isVisible(el)) continue;
      const role = roleOf(el);
      const name = norm(accessibleName(el, 300));
      if (!name) continue;
      let score = -1;
      if (name === needle) score = 120;
      else if (!exact && name.startsWith(needle)) score = 80;
      else if (!exact && name.includes(needle)) score = 55;
      else continue;
      matches++;
      if (isInteractive(el, role)) score += 30;
      const tag = el.tagName.toLowerCase();
      if (tag === 'div' || tag === 'span') score -= 8;
      if (role === 'heading' || role === 'listitem' || role === 'cell') score -= 3;
      const rect = el.getBoundingClientRect();
      score -= Math.min(25, Math.floor((rect.width * rect.height) / 120000));
      if (!best || score > best.score) best = { el, name, score };
    }
    if (!best) return null;
    return { el: best.el, name: best.name, matches };
  }

  function resolveTarget(params = {}) {
    if (params.ref) return { el: resolveRef(params.ref), how: 'ref' };
    if (params.selector) {
      const elements = queryDeep(params.selector);
      if (!elements.length) throw new Error(`Selector not found: ${params.selector}`);
      const el = elements.find(isVisible) || elements[0];
      return { el, how: 'selector', count: elements.length };
    }
    if (params.text) {
      const found = findByText(params.text, { exact: !!params.exactText });
      if (!found) throw new Error(`No visible element found with text: ${params.text}`);
      return { el: found.el, how: 'text', matches: found.matches };
    }
    if (params.x != null && params.y != null) {
      const el = deepElementFromPoint(Number(params.x), Number(params.y));
      if (!el) throw new Error(`No element at (${params.x}, ${params.y}).`);
      return { el, how: 'point' };
    }
    if (params.focused) {
      const el = document.activeElement;
      if (!el || el === document.body) throw new Error('No element currently has focus.');
      return { el, how: 'focused' };
    }
    throw new Error('Provide ref, selector, text or x/y coordinates.');
  }

  function modifierFlags(modifiers) {
    const list = Array.isArray(modifiers) ? modifiers.map((item) => String(item).toLowerCase()) : [];
    return {
      altKey: list.includes('alt') || list.includes('option'),
      ctrlKey: list.includes('control') || list.includes('ctrl'),
      metaKey: list.includes('meta') || list.includes('command') || list.includes('cmd'),
      shiftKey: list.includes('shift')
    };
  }

  function mouseButton(button) {
    const value = String(button || 'left').toLowerCase();
    if (value === 'right') return { button: 2, buttons: 2 };
    if (value === 'middle') return { button: 1, buttons: 4 };
    return { button: 0, buttons: 1 };
  }

  async function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        // Ignore.
      }
    }
    await nextFrame();
    await nextFrame();
    await sleep(20);
  }

  function fireMouse(el, type, x, y, options) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: options.button,
      buttons: options.buttons,
      detail: options.detail || 1,
      ...options.modifiers
    };
    try {
      if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent(type, {
          ...init,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: type === 'pointerdown' || type === 'pointerup' ? 0.5 : 0
        }));
      } else {
        el.dispatchEvent(new MouseEvent(type, init));
      }
    } catch {
      // Ignore event constructor differences.
    }
  }

  async function click(params = {}) {
    let target;
    if (params.x != null && params.y != null) {
      const el = deepElementFromPoint(Number(params.x), Number(params.y));
      if (!el) throw new Error(`No element at (${params.x}, ${params.y}).`);
      target = { el, how: 'point' };
    } else {
      target = resolveTarget(params);
    }
    let el = target.el;

    if (el.nodeType !== 1) throw new Error('Target is not an element.');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Target is disabled.');

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'file') {
      throw new Error('File inputs cannot be clicked by the agent; use chrome_upload_file with absolute file paths.');
    }

    if (!isVisible(el) && (tag === 'input' && (type === 'checkbox' || type === 'radio'))) {
      const label = el.labels && el.labels[0];
      if (label && isVisible(label)) el = label;
    }

    if (!isVisible(el)) throw new Error('Target is not visible. Take a new snapshot or scroll it into view.');

    await scrollIntoView(el);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const { button, buttons } = mouseButton(params.button);
    const modifiers = modifierFlags(params.modifiers);
    const clickCount = Math.max(1, Math.min(Number(params.clickCount) || 1, 3));

    fireMouse(el, 'pointerover', x, y, { button, buttons: 0, modifiers });
    fireMouse(el, 'mouseover', x, y, { button, buttons: 0, modifiers });
    fireMouse(el, 'pointermove', x, y, { button, buttons: 0, modifiers });
    fireMouse(el, 'mousemove', x, y, { button, buttons: 0, modifiers });

    fireMouse(el, 'pointerdown', x, y, { button, buttons, modifiers });
    fireMouse(el, 'mousedown', x, y, { button, buttons, modifiers });

    try {
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    } catch {
      // Ignore.
    }

    fireMouse(el, 'pointerup', x, y, { button, buttons: 0, modifiers });
    fireMouse(el, 'mouseup', x, y, { button, buttons: 0, modifiers });

    if (button === 0) {
      try {
        if (typeof el.click === 'function') el.click();
        else el.dispatchEvent(new MouseEvent('click', {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, button, buttons: 0, detail: clickCount, ...modifiers
        }));
      } catch {
        // Ignore; pointer events already fired.
      }
      if (clickCount > 1) {
        try {
          el.click();
        } catch {
          // Ignore.
        }
        fireMouse(el, 'dblclick', x, y, { button, buttons: 0, detail: 2, modifiers });
      }
    } else {
      fireMouse(el, 'contextmenu', x, y, { button, buttons: 0, modifiers });
      fireMouse(el, 'auxclick', x, y, { button, buttons: 0, detail: 1, modifiers });
    }

    let value;
    try {
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        value = type === 'password' ? '••••' : el.value;
      }
    } catch {
      // Ignore.
    }

    return {
      clicked: true,
      how: target.how,
      ref: el.getAttribute('data-oc-ref') || undefined,
      tag,
      role: roleOf(el),
      name: truncate(accessibleName(el, 160), 160),
      x: Math.round(x),
      y: Math.round(y),
      checked: typeof el.checked === 'boolean' ? el.checked : undefined,
      value,
      url: location.href
    };
  }

  function setNativeValue(el, value) {
    const tag = el.tagName.toLowerCase();
    try {
      const prototype = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
    } catch {
      el.value = value;
    }
  }

  function dispatchInput(el, data, inputType = 'insertText') {
    let event;
    try {
      event = new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data,
        inputType
      });
    } catch {
      event = new Event('input', { bubbles: true, composed: true });
    }
    el.dispatchEvent(event);
  }

  function dispatchKey(el, type, key, code, keyCode, modifiers, text) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...modifiers
    });
    if (text && type === 'keypress') {
      try {
        Object.defineProperty(event, 'charCode', { get: () => text.charCodeAt(0) });
      } catch {
        // Ignore.
      }
    }
    return el.dispatchEvent(event);
  }

  function keyInfoForChar(ch) {
    if (ch === '\n' || ch === '\r') return { key: 'Enter', code: 'Enter', keyCode: 13, text: ch };
    if (ch === '\t') return { key: 'Tab', code: 'Tab', keyCode: 9, text: ch };
    const upper = ch.toUpperCase();
    if (/^[a-z]$/i.test(ch)) {
      return { key: ch, code: 'Key' + upper, keyCode: upper.charCodeAt(0), text: ch };
    }
    if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, keyCode: ch.charCodeAt(0), text: ch };
    if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: ch };
    return { key: ch, code: '', keyCode: 0, text: ch };
  }

  async function typeIntoElement(el, text, params = {}) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();

    if (tag === 'select') throw new Error('Use chrome_select for <select> elements.');
    if (tag === 'input' && type === 'file') throw new Error('File inputs must be filled with chrome_upload_file.');
    if (el.disabled || el.readOnly) throw new Error('Target is disabled or read-only.');

    await scrollIntoView(el);
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        // Ignore.
      }
    }

    const delay = Math.max(0, Math.min(Number(params.delay) || 0, 1000));
    const clear = params.clear !== false;
    const value = String(text == null ? '' : text);
    let typed = 0;

    if (tag === 'input' || tag === 'textarea') {
      const specialType = ['number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type);
      if (clear) {
        setNativeValue(el, '');
        dispatchInput(el, null, 'deleteContentBackward');
      }
      if (specialType) {
        setNativeValue(el, value);
        dispatchInput(el, value, 'insertText');
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        typed = value.length;
      } else {
        for (const ch of value) {
          const before = el.value;
          const maxLength = Number(el.getAttribute('maxlength'));
          const start = typeof el.selectionStart === 'number' ? el.selectionStart : before.length;
          const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
          let next = before.slice(0, start) + ch + before.slice(end);
          if (Number.isFinite(maxLength) && maxLength >= 0 && next.length > maxLength) {
            next = next.slice(0, maxLength);
          }
          if (next === before && ch.length) {
            // maxlength reached; stop, like a real keyboard would.
            break;
          }
          const info = keyInfoForChar(ch);
          const modifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: /[A-Z]/.test(ch) };
          const down = dispatchKey(el, 'keydown', info.key, info.code, info.keyCode, modifiers, info.text);
          dispatchKey(el, 'keypress', info.key, info.code, info.keyCode, modifiers, info.text);
          if (down) {
            setNativeValue(el, next);
            try {
              el.setSelectionRange(Math.min(start + ch.length, next.length), Math.min(start + ch.length, next.length));
            } catch {
              // Some input types do not support selection.
            }
            dispatchInput(el, ch, 'insertText');
          }
          dispatchKey(el, 'keyup', info.key, info.code, info.keyCode, modifiers, info.text);
          typed++;
          if (delay) await sleep(delay);
        }
      }
      try {
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch {
        // Ignore.
      }
      return {
        tag,
        type,
        value: type === 'password' ? '••••' : el.value,
        length: el.value.length,
        typed,
        focused: document.activeElement === el
      };
    }

    if (el.isContentEditable) {
      if (clear) {
        try {
          el.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false);
        } catch {
          el.textContent = '';
        }
        dispatchInput(el, null, 'deleteContentBackward');
      }
      for (const ch of value) {
        let inserted = false;
        try {
          inserted = document.execCommand('insertText', false, ch);
        } catch {
          inserted = false;
        }
        if (!inserted) {
          el.textContent = (el.textContent || '') + ch;
        }
        dispatchInput(el, ch, 'insertText');
        typed++;
        if (delay) await sleep(delay);
      }
      return {
        tag,
        type: 'contenteditable',
        value: truncate(el.innerText || el.textContent, 500),
        length: (el.innerText || el.textContent || '').length,
        typed,
        focused: document.activeElement === el
      };
    }

    throw new Error(`Cannot type into <${tag}>; use chrome_click or chrome_evaluate instead.`);
  }

  async function type(params = {}) {
    const target = resolveTarget(params);
    return typeIntoElement(target.el, params.text, params);
  }

  const KEY_ALIASES = {
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
    insert: { key: 'Insert', code: 'Insert', keyCode: 45 }
  };

  function parseCombo(combo) {
    const parts = String(combo || '').split('+').map((part) => part.trim()).filter(Boolean);
    const modifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    let keyPart = parts.pop() || '';
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'control' || lower === 'ctrl') modifiers.ctrlKey = true;
      else if (lower === 'alt' || lower === 'option') modifiers.altKey = true;
      else if (lower === 'shift') modifiers.shiftKey = true;
      else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modifiers.metaKey = true;
      else keyPart = part;
    }
    const lower = keyPart.toLowerCase();
    let info = KEY_ALIASES[lower];
    if (!info && /^f([1-9]|1[0-2])$/.test(lower)) {
      const number = Number(lower.slice(1));
      info = { key: 'F' + number, code: 'F' + number, keyCode: 111 + number };
    }
    if (!info) info = keyInfoForChar(keyPart);
    return { ...info, modifiers };
  }

  async function press(params = {}) {
    let el = null;
    if (params.ref || params.selector || params.text) {
      el = resolveTarget(params).el;
    } else {
      el = document.activeElement;
      if (!el || el === document.body) el = document.body;
    }
    if (el && typeof el.focus === 'function' && el !== document.body) {
      try {
        el.focus({ preventScroll: true });
      } catch {
        // Ignore.
      }
    }
    const info = parseCombo(params.key);
    const key = info.key;
    const code = info.code;
    const keyCode = info.keyCode;
    const modifiers = info.modifiers;
    const target = el || document.activeElement || document.body;
    const down = dispatchKey(target, 'keydown', key, code, keyCode, modifiers, info.text);
    if (info.text && info.text.length === 1) {
      dispatchKey(target, 'keypress', key, code, keyCode, modifiers, info.text);
    }
    dispatchKey(target, 'keyup', key, code, keyCode, modifiers, info.text);

    let submitted = false;
    if (down && key === 'Enter' && !params.noSubmit) {
      const form = target.form;
      if (form && typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit();
          submitted = true;
        } catch {
          // Ignore.
        }
      }
    }
    return { key, code, keyCode, submitted, activeTag: target.tagName ? target.tagName.toLowerCase() : null };
  }

  async function hover(params = {}) {
    const target = resolveTarget(params);
    const el = target.el;
    await scrollIntoView(el);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const modifiers = modifierFlags(params.modifiers);
    fireMouse(el, 'pointerover', x, y, { button: 0, buttons: 0, modifiers });
    fireMouse(el, 'mouseover', x, y, { button: 0, buttons: 0, modifiers });
    fireMouse(el, 'pointermove', x, y, { button: 0, buttons: 0, modifiers });
    fireMouse(el, 'mousemove', x, y, { button: 0, buttons: 0, modifiers });
    return {
      hovered: true,
      ref: el.getAttribute('data-oc-ref') || undefined,
      tag: el.tagName.toLowerCase(),
      name: truncate(accessibleName(el, 120), 120),
      x: Math.round(x),
      y: Math.round(y)
    };
  }

  async function select(params = {}) {
    const el = resolveTarget(params).el;
    if (el.tagName.toLowerCase() !== 'select') throw new Error('Target is not a <select> element.');
    const options = [...el.options];
    const wanted = [];
    if (Array.isArray(params.values)) wanted.push(...params.values.map(String));
    else if (params.value != null) wanted.push(String(params.value));
    if (Array.isArray(params.labels)) wanted.push(...params.labels.map(norm));
    else if (params.label != null) wanted.push(norm(params.label));
    const indices = Array.isArray(params.indexes) ? params.indexes.map(Number) : params.index != null ? [Number(params.index)] : [];

    const matches = [];
    for (const option of options) {
      const byValue = wanted.some((value) => option.value === value);
      const byLabel = wanted.some((value) => norm(option.textContent) === value);
      const byIndex = indices.includes(option.index);
      if (byValue || byLabel || byIndex) matches.push(option);
    }
    if (!matches.length) {
      const available = options.slice(0, 30).map((option, index) => `${index}:${option.value}=${truncate(option.textContent, 40)}`).join(', ');
      throw new Error(`No matching option. Available: ${available}`);
    }

    if (!el.multiple) {
      for (const option of options) option.selected = false;
      matches[0].selected = true;
    } else {
      for (const option of matches) option.selected = true;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return {
      selected: [...el.selectedOptions].map((option) => ({ value: option.value, label: truncate(option.textContent, 80), index: option.index })),
      multiple: el.multiple
    };
  }

  async function scroll(params = {}) {
    const to = String(params.to || '').toLowerCase();
    const direction = String(params.direction || 'down').toLowerCase();
    const amount = Number(params.amount) || 600;
    const smooth = params.smooth === true;

    if (params.ref || params.selector) {
      const el = resolveTarget(params).el;
      await scrollIntoView(el);
      return { scrolledToElement: true, ref: el.getAttribute('data-oc-ref') || undefined, ...getPosition() };
    }

    let container = null;
    if (params.containerRef || params.containerSelector) {
      container = resolveTarget({ ref: params.containerRef, selector: params.containerSelector }).el;
    }

    if (container) {
      const before = container.scrollTop;
      if (to === 'top') container.scrollTop = 0;
      else if (to === 'bottom') container.scrollTop = container.scrollHeight;
      else {
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        container.scrollBy({ left: dx, top: dy, behavior: smooth ? 'smooth' : 'auto' });
      }
      await sleep(smooth ? 250 : 30);
      return { container: true, before, after: container.scrollTop, ...getPosition() };
    }

    const before = { x: window.scrollX, y: window.scrollY };
    if (to === 'top') window.scrollTo({ top: 0, left: 0, behavior: smooth ? 'smooth' : 'auto' });
    else if (to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    else {
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      window.scrollBy({ left: dx, top: dy, behavior: smooth ? 'smooth' : 'auto' });
    }
    await sleep(smooth ? 250 : 30);
    return { before, after: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }, ...getPosition() };
  }

  async function waitFor(params = {}) {
    const timeout = Math.max(100, Math.min(Number(params.timeout) || 10000, 120000));
    const interval = Math.max(50, Math.min(Number(params.interval) || 150, 2000));
    const stateWanted = String(params.state || 'visible').toLowerCase();
    const text = params.text ? norm(params.text) : null;
    const exact = !!params.exact;
    const start = Date.now();
    let last = null;

    while (Date.now() - start <= timeout) {
      let el = null;
      if (params.selector) {
        const elements = queryDeep(params.selector);
        if (stateWanted === 'detached') {
          if (!elements.length) return { found: true, elapsed: Date.now() - start, state: stateWanted };
        } else {
          el = elements.find(isVisible) || elements[0] || null;
        }
      }
      if (text && !el) {
        const found = findByText(text, { exact });
        el = found ? found.el : null;
      }

      if (stateWanted === 'detached') {
        if (!el) return { found: true, elapsed: Date.now() - start, state: stateWanted };
      } else if (stateWanted === 'hidden') {
        if (!el || !isVisible(el)) return { found: true, elapsed: Date.now() - start, state: stateWanted };
      } else if (stateWanted === 'attached') {
        if (el) {
          last = el;
          return { found: true, elapsed: Date.now() - start, state: stateWanted, ref: refFor(el), tag: el.tagName.toLowerCase(), name: truncate(accessibleName(el, 120), 120) };
        }
      } else if (el && isVisible(el)) {
        last = el;
        return {
          found: true,
          elapsed: Date.now() - start,
          state: 'visible',
          ref: refFor(el),
          tag: el.tagName.toLowerCase(),
          name: truncate(accessibleName(el, 120), 120),
          text: truncate(innerText(el), 200)
        };
      }
      await sleep(interval);
    }

    const message = params.selector
      ? `Timed out after ${timeout}ms waiting for selector "${params.selector}" to be ${stateWanted}.`
      : `Timed out after ${timeout}ms waiting for text "${params.text}".`;
    const error = new Error(message);
    error.details = {
      elapsed: Date.now() - start,
      last: last ? { tag: last.tagName.toLowerCase(), name: truncate(accessibleName(last, 120), 120) } : null,
      url: location.href
    };
    throw error;
  }

  function collectByXPath(xpath) {
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const out = [];
    for (let index = 0; index < result.snapshotLength; index++) {
      const node = result.snapshotItem(index);
      if (node && node.nodeType === 1) out.push(node);
    }
    return out;
  }

  function elementInfo(el, params = {}) {
    const tag = el.tagName.toLowerCase();
    const rect = getRect(el);
    const info = {
      tag,
      id: el.id || undefined,
      classes: el.classList ? [...el.classList] : [],
      role: roleOf(el),
      name: truncate(accessibleName(el, 160), 160),
      text: truncate(innerText(el), 500),
      visible: isVisible(el),
      disabled: !!el.disabled,
      href: tag === 'a' ? el.getAttribute('href') || undefined : undefined,
      src: el.getAttribute('src') || undefined,
      type: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
      value: tag === 'input' || tag === 'textarea' || tag === 'select' ? ((el.type || '').toLowerCase() === 'password' ? '••••' : el.value) : undefined,
      checked: typeof el.checked === 'boolean' ? el.checked : undefined,
      selected: typeof el.selected === 'boolean' ? el.selected : undefined,
      attributes: {},
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        pageX: Math.round(rect.pageX), pageY: Math.round(rect.pageY)
      },
      ref: isInteractive(el) ? refFor(el) : undefined
    };
    for (const attr of el.attributes) {
      info.attributes[attr.name] = truncate(attr.value, 500);
    }
    if (params.includeHtml) {
      info.html = truncate(el.outerHTML, Math.max(100, Math.min(Number(params.maxLength) || 4000, 20000)));
    }
    if (params.styles || params.properties) {
      const computed = getComputedStyle(el);
      const requested = params.properties || params.styles;
      const properties = Array.isArray(requested) && requested.length
        ? requested
        : ['display', 'visibility', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'width', 'height', 'margin', 'padding', 'border', 'opacity', 'zIndex', 'overflow', 'cursor'];
      info.styles = {};
      for (const property of properties) {
        const cssName = String(property).replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
        info.styles[property] = computed.getPropertyValue(cssName) || computed[property] || '';
      }
    }
    return info;
  }

  function dom(params = {}) {
    const action = String(params.action || 'query').toLowerCase();
    const maxLength = Math.max(100, Math.min(Number(params.maxLength) || 4000, 30000));
    const limit = Math.max(1, Math.min(Number(params.limit) || 10, 100));
    let elements = [];

    if (params.ref) elements = [resolveRef(params.ref)];
    else if (params.xpath) elements = collectByXPath(params.xpath);
    else if (params.selector) elements = queryDeep(params.selector);
    else if (action === 'text') elements = [document.body || document.documentElement];
    else throw new Error('Provide selector, ref or xpath.');

    if (!elements.length) return { count: 0, matches: [], action };
    const selected = params.all ? elements.slice(0, limit) : elements.slice(0, 1);

    if (action === 'count') return { count: elements.length, action };
    if (action === 'html') {
      return {
        count: elements.length,
        action,
        matches: selected.map((el) => ({
          tag: el.tagName.toLowerCase(),
          html: truncate(el.outerHTML, maxLength)
        }))
      };
    }
    if (action === 'text') {
      return {
        count: elements.length,
        action,
        text: truncate(elements.map((el) => innerText(el)).join('\n'), maxLength),
        matches: selected.map((el) => ({ tag: el.tagName.toLowerCase(), text: truncate(innerText(el), maxLength) }))
      };
    }
    if (action === 'attributes') {
      return {
        count: elements.length,
        action,
        matches: selected.map((el) => {
          const attributes = {};
          for (const attr of el.attributes) attributes[attr.name] = truncate(attr.value, 1000);
          return { tag: el.tagName.toLowerCase(), attributes };
        })
      };
    }
    if (action === 'rect') {
      return {
        count: elements.length,
        action,
        matches: selected.map((el) => ({ tag: el.tagName.toLowerCase(), ...getRect(el) }))
      };
    }

    return {
      count: elements.length,
      action: 'query',
      matches: selected.map((el) => elementInfo(el, {
        includeHtml: !!params.includeHtml,
        maxLength,
        properties: action === 'styles' ? (params.properties || true) : null
      }))
    };
  }

  function highlight(params = {}) {
    if (String(params.action || 'show').toLowerCase() === 'clear') {
      if (state.highlightTimer) clearInterval(state.highlightTimer);
      state.highlightTimer = null;
      if (state.highlightLayer && state.highlightLayer.parentNode) state.highlightLayer.remove();
      state.highlightLayer = null;
      return { cleared: true };
    }

    let elements = [];
    if (params.all) {
      elements = deepQueryAll('[data-oc-ref]').filter(isVisible).slice(0, 200);
    } else {
      elements = [resolveTarget(params).el];
    }
    if (!elements.length) throw new Error('No elements to highlight.');

    if (state.highlightTimer) clearInterval(state.highlightTimer);
    if (state.highlightLayer && state.highlightLayer.parentNode) state.highlightLayer.remove();

    const layer = document.createElement('div');
    layer.setAttribute('data-oc-highlight', 'true');
    layer.style.cssText = 'position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
    const color = params.color || '#ff2d55';
    const boxes = [];

    for (const el of elements) {
      const box = document.createElement('div');
      box.style.cssText = `position:fixed!important;border:2px solid ${color}!important;background:${color}1a!important;box-sizing:border-box!important;border-radius:3px!important;pointer-events:none!important;`;
      const label = document.createElement('div');
      label.textContent = el.getAttribute('data-oc-ref') || truncate(accessibleName(el, 60), 60);
      label.style.cssText = `position:absolute!important;left:0!important;top:-18px!important;background:${color}!important;color:#fff!important;font:11px/16px monospace!important;padding:0 4px!important;border-radius:2px!important;white-space:nowrap!important;`;
      box.appendChild(label);
      layer.appendChild(box);
      boxes.push({ el, box, label });
    }
    (document.documentElement || document.body).appendChild(layer);
    state.highlightLayer = layer;

    const update = () => {
      for (const item of boxes) {
        const rect = item.el.getBoundingClientRect();
        item.box.style.left = rect.left + 'px';
        item.box.style.top = rect.top + 'px';
        item.box.style.width = rect.width + 'px';
        item.box.style.height = rect.height + 'px';
      }
    };
    update();
    state.highlightTimer = setInterval(update, 250);

    const duration = Math.max(0, Math.min(Number(params.durationMs) || 2500, 60000));
    if (duration > 0) {
      setTimeout(() => {
        if (state.highlightLayer === layer) highlight({ action: 'clear' });
      }, duration);
    }
    return { highlighted: elements.length, durationMs: duration, color };
  }

  async function prepareType(params = {}) {
    const target = resolveTarget(params);
    const el = target.el;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'select') throw new Error('Use chrome_select for <select> elements.');
    if (tag === 'input' && type === 'file') throw new Error('Use chrome_upload_file for file inputs.');
    if (el.disabled || el.readOnly) throw new Error('Target is disabled or read-only.');

    await scrollIntoView(el);
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        // Ignore.
      }
    }

    if (params.clear !== false) {
      if (tag === 'input' || tag === 'textarea') {
        setNativeValue(el, '');
        dispatchInput(el, null, 'deleteContentBackward');
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else if (el.isContentEditable) {
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false);
        } catch {
          el.textContent = '';
        }
        dispatchInput(el, null, 'deleteContentBackward');
      } else {
        throw new Error(`Cannot type into <${tag}>; use chrome_click or chrome_evaluate instead.`);
      }
    }

    return {
      tag,
      type: el.isContentEditable ? 'contenteditable' : type,
      ref: el.getAttribute('data-oc-ref') || undefined,
      role: roleOf(el),
      name: truncate(accessibleName(el, 120), 120),
      value: type === 'password' ? '••••' : el.value,
      focused: document.activeElement === el
    };
  }

  async function drag(params = {}) {
    const source = resolveTarget({
      ref: params.fromRef,
      selector: params.fromSelector,
      x: params.fromX,
      y: params.fromY
    });
    const target = resolveTarget({
      ref: params.toRef,
      selector: params.toSelector,
      x: params.toX,
      y: params.toY
    });
    await scrollIntoView(source.el);
    const sourceRect = source.el.getBoundingClientRect();
    let targetRect = target.el.getBoundingClientRect();
    if (targetRect.width === 0 && target.el !== document.body) {
      await scrollIntoView(target.el);
      targetRect = target.el.getBoundingClientRect();
    }
    const sx = sourceRect.left + sourceRect.width / 2;
    const sy = sourceRect.top + sourceRect.height / 2;
    const tx = targetRect.left + targetRect.width / 2;
    const ty = targetRect.top + targetRect.height / 2;
    const steps = Math.max(2, Math.min(Number(params.steps) || 14, 60));
    const duration = Math.max(0, Math.min(Number(params.duration) || 350, 3000));
    let dataTransfer = null;
    try {
      dataTransfer = new DataTransfer();
    } catch {
      dataTransfer = null;
    }

    fireMouse(source.el, 'pointerover', sx, sy, { button: 0, buttons: 0, modifiers: {} });
    fireMouse(source.el, 'mouseover', sx, sy, { button: 0, buttons: 0, modifiers: {} });
    fireMouse(source.el, 'pointerdown', sx, sy, { button: 0, buttons: 1, modifiers: {} });
    fireMouse(source.el, 'mousedown', sx, sy, { button: 0, buttons: 1, modifiers: {} });
    if (dataTransfer && typeof DragEvent === 'function') {
      try {
        source.el.dispatchEvent(new DragEvent('dragstart', {
          bubbles: true, cancelable: true, composed: true, dataTransfer,
          clientX: sx, clientY: sy
        }));
      } catch {
        // Ignore.
      }
    }

    for (let index = 1; index <= steps; index++) {
      const progress = index / steps;
      const x = sx + (tx - sx) * progress;
      const y = sy + (ty - sy) * progress;
      const over = deepElementFromPoint(x, y) || target.el;
      fireMouse(over, 'pointermove', x, y, { button: 0, buttons: 1, modifiers: {} });
      fireMouse(over, 'mousemove', x, y, { button: 0, buttons: 1, modifiers: {} });
      if (dataTransfer && typeof DragEvent === 'function') {
        try {
          over.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, composed: true, dataTransfer,
            clientX: x, clientY: y
          }));
        } catch {
          // Ignore.
        }
      }
      if (duration) await sleep(duration / steps);
    }

    fireMouse(target.el, 'pointerup', tx, ty, { button: 0, buttons: 0, modifiers: {} });
    fireMouse(target.el, 'mouseup', tx, ty, { button: 0, buttons: 0, modifiers: {} });
    if (dataTransfer && typeof DragEvent === 'function') {
      try {
        target.el.dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, composed: true, dataTransfer,
          clientX: tx, clientY: ty
        }));
        source.el.dispatchEvent(new DragEvent('dragend', {
          bubbles: true, cancelable: true, composed: true, dataTransfer,
          clientX: tx, clientY: ty
        }));
      } catch {
        // Ignore.
      }
    }

    return {
      dragged: true,
      from: { x: Math.round(sx), y: Math.round(sy) },
      to: { x: Math.round(tx), y: Math.round(ty) },
      steps
    };
  }

  function getActiveElement() {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      ref: isInteractive(el) ? refFor(el) : undefined,
      role: roleOf(el),
      name: truncate(accessibleName(el, 120), 120),
      value: (el.type || '').toLowerCase() === 'password' ? '••••' : el.value
    };
  }

  async function dispatch(payload) {
    const cmd = payload && payload.cmd;
    const params = (payload && payload.params) || {};
    switch (cmd) {
      case 'ping':
        return { pong: true, url: location.href, readyState: document.readyState };
      case 'snapshot':
        return snapshot(params);
      case 'rects':
        return getRects(params);
      case 'position':
        return getPosition();
      case 'click':
        return click(params);
      case 'prepareType':
        return prepareType(params);
      case 'type':
        return type(params);
      case 'press':
        return press(params);
      case 'hover':
        return hover(params);
      case 'select':
        return select(params);
      case 'scroll':
        return scroll(params);
      case 'drag':
        return drag(params);
      case 'waitFor':
        return waitFor(params);
      case 'dom':
        return dom(params);
      case 'highlight':
        return highlight(params);
      case 'activeElement':
        return getActiveElement();
      case 'focus': {
        const target = resolveTarget(params);
        try {
          target.el.focus({ preventScroll: false });
        } catch {
          target.el.focus();
        }
        return { focused: document.activeElement === target.el, ref: target.el.getAttribute('data-oc-ref') || undefined };
      }
      case 'resolve': {
        const target = resolveTarget(params);
        return {
          found: true,
          how: target.how,
          ref: isInteractive(target.el) ? refFor(target.el) : undefined,
          tag: target.el.tagName.toLowerCase(),
          role: roleOf(target.el),
          name: truncate(accessibleName(target.el, 160), 160),
          rect: getRect(target.el)
        };
      }
      default:
        throw new Error(`Unknown agent command: ${cmd}`);
    }
  }

  async function handle(payload) {
    if (payload && payload.prefix) setPrefix(payload.prefix);
    try {
      const result = await dispatch(payload);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error && error.message ? error.message : String(error),
          stack: error && error.stack ? String(error.stack).slice(0, 4000) : undefined,
          details: error && error.details ? error.details : undefined
        }
      };
    }
  }

  globalThis.__OC_AGENT__ = {
    version: VERSION,
    handle,
    setPrefix,
    snapshot,
    getRects,
    resolveRef,
    find: findByText
  };
})();
