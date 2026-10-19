function truncate(value, max = 4000) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function timeOf(ts) {
  if (!ts) return '--:--:--';
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  } catch {
    return String(ts);
  }
}

export function formatBridgeStatus(status) {
  const lines = [];
  lines.push(`Bridge: ${status.connected ? (status.ready ? 'connected' : 'connected (handshake pending)') : 'disconnected'}`);
  lines.push(`Endpoint: ws://${status.host}:${status.port}`);
  if (status.extension) {
    lines.push(`Extension: v${status.extension.version}${status.extension.extensionId ? ` (${status.extension.extensionId})` : ''}`);
    if (status.extension.settings) {
      lines.push(`Extension settings: CDP=${status.extension.settings.preferCdp ? 'on' : 'off'}, dialogs=${status.extension.settings.interceptDialogs ? 'intercepted' : 'native'}`);
    }
  }
  if (status.connectedAt) lines.push(`Connected at: ${new Date(status.connectedAt).toISOString()}`);
  if (status.lastSeen) lines.push(`Last message: ${new Date(status.lastSeen).toISOString()}`);
  if (status.pendingRequests) lines.push(`Pending requests: ${status.pendingRequests}`);
  if (status.tokenRequired) lines.push('Token: required');
  if (!status.connected) {
    lines.push('');
    lines.push('The extension is not connected. Check:');
    lines.push('1. chrome://extensions → "OpenCode Browser Bridge" is enabled.');
    lines.push('2. Its popup shows the same server URL (default ws://127.0.0.1:8787).');
    lines.push('3. The MCP server is running (OpenCode starts it from opencode.jsonc).');
    lines.push('4. Only one bridge process is using the port.');
  }
  return lines.join('\n');
}

export function formatStatus(extension, bridge) {
  const lines = [formatBridgeStatus(bridge), ''];
  lines.push(`Extension version: ${extension.extensionVersion}`);
  lines.push(`Active tab: ${extension.activeTabId ?? 'none'}`);
  if (extension.lastError) lines.push(`Last error: ${extension.lastError}`);
  if (Array.isArray(extension.debuggerTabs) && extension.debuggerTabs.length) {
    lines.push(`CDP attached: ${extension.debuggerTabs.map((item) => item.tabId).join(', ')}`);
  }
  const tabs = Array.isArray(extension.tabs) ? extension.tabs : [];
  lines.push(`Tabs (${tabs.length}):`);
  for (const tab of tabs.slice(0, 50)) {
    const flags = [tab.active ? 'active' : null, tab.pinned ? 'pinned' : null, tab.status].filter(Boolean).join(', ');
    lines.push(`- ${tab.id}: [${flags}] ${truncate(tab.title || '(untitled)', 80)} — ${truncate(tab.url, 160)}`);
  }
  if (tabs.length > 50) lines.push(`... and ${tabs.length - 50} more tabs.`);
  return lines.join('\n');
}

export function formatTab(tab) {
  if (!tab) return 'No tab.';
  return [
    `Tab ${tab.id}: ${tab.title || '(untitled)'}`,
    `URL: ${tab.url}`,
    `Status: ${tab.status || 'unknown'}${tab.active ? ', active' : ''}${tab.pinned ? ', pinned' : ''}`,
    `Window: ${tab.windowId}`
  ].join('\n');
}

export function formatTabs(tabs) {
  if (!Array.isArray(tabs) || !tabs.length) return 'No tabs.';
  return tabs.map((tab) => {
    const flags = [tab.active ? 'active' : null, tab.pinned ? 'pinned' : null, tab.status].filter(Boolean).join(', ');
    return `- ${tab.id}: [${flags}] ${truncate(tab.title || '(untitled)', 80)} — ${truncate(tab.url, 180)}`;
  }).join('\n');
}

export function formatSnapshot(result) {
  if (result.allFrames) {
    const lines = [];
    lines.push(`Page: ${result.tab ? result.tab.title : '(unknown)'}`);
    lines.push(`URL: ${result.tab ? result.tab.url : '(unknown)'}`);
    lines.push(`Frames: ${result.totalFrames}`);
    for (const frame of result.frames || []) {
      lines.push('');
      lines.push(`## Frame ${frame.frameId}${frame.parentFrameId >= 0 ? ` (parent ${frame.parentFrameId})` : ' (main)'} — ${frame.url || 'about:blank'}`);
      if (frame.error) {
        lines.push(`(could not snapshot: ${frame.error})`);
        continue;
      }
      const data = frame.result;
      lines.push(data.tree);
      lines.push(`(${data.stats.interactive} interactive element(s), ${data.stats.nodes} node(s)${data.stats.truncated ? ', truncated' : ''})`);
    }
    return lines.join('\n');
  }

  const lines = [];
  lines.push(`Page: ${result.title || '(untitled)'}`);
  lines.push(`URL: ${result.url}`);
  if (result.frameId != null) lines.push(`Frame: ${result.frameId}`);
  lines.push('');
  lines.push(result.tree);
  lines.push('');
  const stats = result.stats || {};
  lines.push(`${stats.interactive || 0} interactive element(s), ${stats.nodes || 0} node(s)${stats.truncated ? ' — snapshot truncated' : ''}.`);
  if (result.refs && result.refs.length) {
    lines.push(`Element refs look like ${result.refs[0].ref}. Use them with chrome_click, chrome_type, chrome_select, chrome_hover or chrome_screenshot.`);
  }
  return lines.join('\n');
}

export function formatNavigation(result) {
  const lines = [];
  const tab = result.tab;
  if (tab) {
    lines.push(`Tab ${tab.id}: ${tab.title || '(untitled)'}`);
    lines.push(`URL: ${tab.url}`);
    lines.push(`Status: ${tab.status || 'unknown'}${tab.active ? ', active' : ''}`);
  } else {
    lines.push('Navigation completed, but the tab is no longer available.');
  }
  if (result.waitUntil) lines.push(`Wait: ${result.waitUntil}`);
  if (result.elapsedMs != null) lines.push(`Elapsed: ${result.elapsedMs}ms`);
  return lines.join('\n');
}

export function formatClick(result) {
  const lines = [];
  const target = result.target || {};
  const name = target.name ? ` "${truncate(target.name, 100)}"` : '';
  lines.push(`Clicked${name}${target.tag ? ` <${target.tag}>` : ''}${target.ref ? ` [${target.ref}]` : ''} via ${result.via || 'unknown'}${target.x != null ? ` at (${target.x}, ${target.y})` : ''}.`);
  if (result.fallbackReason) lines.push(`CDP fallback: ${result.fallbackReason}`);
  if (result.navigation) {
    if (result.navigation.navigated) {
      lines.push('A navigation was detected and completed.');
      if (result.navigation.tab) {
        lines.push(`Now at: ${result.navigation.tab.title || '(untitled)'} — ${result.navigation.tab.url}`);
      }
      if (result.navigation.newTab) {
        const newTab = result.navigation.newTab;
        lines.push(`New tab: ${newTab.id} — ${newTab.title || '(untitled)'} — ${newTab.url}${result.navigation.switched ? ' (activated)' : ''}`);
      }
    } else {
      lines.push('No navigation was detected.');
    }
  }
  if (result.tab) lines.push(`Active tab: ${result.tab.id}`);
  return lines.join('\n');
}

export function formatTyping(result) {
  const lines = [];
  lines.push(`Typed into${result.name ? ` "${truncate(result.name, 100)}"` : ''} <${result.tag || 'element'}>${result.ref ? ` [${result.ref}]` : ''} via ${result.via || 'unknown'}.`);
  if (result.value != null) lines.push(`Value now: ${JSON.stringify(truncate(result.value, 500))}`);
  if (result.length != null) lines.push(`Length: ${result.length}`);
  if (result.fallbackReason) lines.push(`CDP fallback: ${result.fallbackReason}`);
  if (result.navigation && result.navigation.navigated) {
    lines.push('A navigation was detected and completed.');
    if (result.navigation.tab) lines.push(`Now at: ${result.navigation.tab.title || '(untitled)'} — ${result.navigation.tab.url}`);
    if (result.navigation.newTab) lines.push(`New tab: ${result.navigation.newTab.id} — ${result.navigation.newTab.url}`);
  }
  return lines.join('\n');
}

export function formatWait(result) {
  const lines = [];
  if (result.loadState) lines.push(`Load state reached: ${result.loadState}`);
  else if (result.url) lines.push(`URL matched: ${result.url}`);
  else if (result.value !== undefined) lines.push(`JavaScript predicate matched: ${JSON.stringify(result.value)}`);
  else {
    lines.push(`Condition matched after ${result.elapsed ?? '?'}ms.`);
    if (result.ref) lines.push(`Element: ${result.ref}${result.tag ? ` <${result.tag}>` : ''}${result.name ? ` "${truncate(result.name, 120)}"` : ''}`);
    if (result.text) lines.push(`Text: ${truncate(result.text, 300)}`);
  }
  if (result.tab) lines.push(`Tab: ${result.tab.id} — ${result.tab.url}`);
  return lines.join('\n');
}

export function formatEvaluate(result) {
  const lines = [];
  lines.push(`Evaluation via ${result.via || 'unknown'} (${result.type || 'unknown'}):`);
  if (result.value === undefined) lines.push('(undefined)');
  else if (typeof result.value === 'string') lines.push(JSON.stringify(result.value));
  else {
    try {
      lines.push(JSON.stringify(result.value, null, 2));
    } catch {
      lines.push(String(result.value));
    }
  }
  if (result.description && result.value == null) lines.push(`Description: ${result.description}`);
  return truncate(lines.join('\n'), 30000);
}

export function formatDom(result) {
  const lines = [];
  lines.push(`DOM ${result.action || 'query'}: ${result.count ?? 0} match(es).`);
  if (result.text) {
    lines.push('');
    lines.push(truncate(result.text, result.maxLength || 12000));
    return lines.join('\n');
  }
  if (Array.isArray(result.matches) && result.matches.length) {
    lines.push('');
    try {
      lines.push(truncate(JSON.stringify(result.matches, null, 2), 24000));
    } catch {
      lines.push(String(result.matches));
    }
  }
  return lines.join('\n');
}

export function formatConsole(result) {
  const lines = [];
  lines.push(`Console: ${result.count || 0} entr${result.count === 1 ? 'y' : 'ies'} across ${result.frames || 0} frame(s).`);
  if (result.note) lines.push(result.note);
  for (const entry of result.logs || []) {
    const stack = entry.stack ? `\n    ${truncate(entry.stack.split('\n').slice(0, 3).join('\n    '), 600)}` : '';
    lines.push(`[${timeOf(entry.ts)}] ${entry.level || 'log'}${entry.frameId ? ` (frame ${entry.frameId})` : ''}: ${truncate(entry.text, 1500)}${stack}`);
  }
  return truncate(lines.join('\n'), 30000);
}

export function formatNetwork(result) {
  const lines = [];
  lines.push(`Network: ${result.count || 0} entr${result.count === 1 ? 'y' : 'ies'} across ${result.frames || 0} frame(s).`);
  if (result.note) lines.push(result.note);
  for (const entry of result.entries || []) {
    const status = entry.status ? String(entry.status) : '---';
    const duration = entry.duration != null ? `${entry.duration}ms` : '';
    const type = entry.resourceType || entry.kind || '';
    const error = entry.error ? ` ERROR: ${truncate(entry.error, 200)}` : '';
    lines.push(`[${timeOf(entry.start)}] ${entry.method || 'GET'} ${status} ${duration} ${type}${entry.frameId ? ` f${entry.frameId}` : ''} ${truncate(entry.url, 500)}${error}`);
  }
  return truncate(lines.join('\n'), 30000);
}

export function formatCookies(result) {
  if (result.cookie) {
    return `Cookie set: ${result.cookie.name}=${truncate(result.cookie.value, 300)} domain=${result.cookie.domain} path=${result.cookie.path} secure=${result.cookie.secure} httpOnly=${result.cookie.httpOnly}`;
  }
  if (result.removed != null) return `Removed ${result.removed} cookie(s) (total matched: ${result.total ?? result.removed}).`;
  if (Array.isArray(result.cookies)) {
    if (!result.cookies.length) return 'No cookies matched.';
    const lines = [`Cookies (${result.cookies.length}):`];
    for (const cookie of result.cookies) {
      lines.push(`- ${cookie.name}=${truncate(cookie.value, 300)} domain=${cookie.domain} path=${cookie.path} secure=${!!cookie.secure} httpOnly=${!!cookie.httpOnly} sameSite=${cookie.sameSite || 'unspecified'}`);
    }
    return lines.join('\n');
  }
  return formatJson(result);
}

export function formatDialog(result) {
  const lines = [];
  if (result.policy) {
    lines.push(`Dialog policy: intercept=${result.policy.intercept} confirm=${result.policy.confirm} prompt=${JSON.stringify(result.policy.prompt)}`);
  } else {
    lines.push('Dialog hooks are not available on this page (reload the page after installing the extension).');
  }
  if (result.settings) {
    lines.push(`Settings: interceptDialogs=${result.settings.interceptDialogs} confirmDialogs=${result.settings.confirmDialogs} promptDialogText=${JSON.stringify(result.settings.promptDialogText)}`);
  }
  if (Array.isArray(result.dialogs) && result.dialogs.length) {
    lines.push('');
    lines.push('Recent dialogs:');
    for (const dialog of result.dialogs) {
      lines.push(`- [${timeOf(dialog.ts)}] ${dialog.type}: ${truncate(dialog.message, 300)}${dialog.response !== undefined ? ` → ${JSON.stringify(dialog.response)}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function formatJson(value, max = 30000) {
  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return truncate(String(value), max);
  }
}

export function formatError(error) {
  const code = error && error.code ? ` [${error.code}]` : '';
  const lines = [`Browser bridge error${code}: ${error && error.message ? error.message : String(error)}`];
  if (error && error.code === 'NOT_CONNECTED') {
    lines.push('');
    lines.push('Open chrome://extensions, enable "OpenCode Browser Bridge", then open its popup and confirm it shows "Conectado".');
  }
  if (error && error.code === 'PORT_IN_USE') {
    lines.push('');
    lines.push('Only one bridge process can own the port. Stop the other process or ask OpenCode to start this MCP server with a different OPENCODE_BROWSER_PORT.');
  }
  if (error && error.code === 'TIMEOUT') {
    lines.push('');
    lines.push('Tip: if a native alert/confirm dialog is open, use chrome_dialog to inspect/handle it, or enable dialog interception in the extension popup.');
  }
  if (process.env.OPENCODE_BROWSER_DEBUG === '1' && error && error.stack) {
    lines.push('');
    lines.push(error.stack);
  }
  return lines.join('\n');
}
