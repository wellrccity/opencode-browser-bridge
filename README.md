# OpenCode Browser Bridge

Chrome extension + local MCP server that lets OpenCode control a real browser almost like a person: navigate, read the DOM, click, type, fill forms, scroll, drag, take screenshots, and more.

The server shows up in OpenCode as `chrome` (a name chosen so it does not collide with OpenCode V2's native `browser` namespace), so the tools are available as `chrome_status`, `chrome_navigate`, `chrome_snapshot`, `chrome_click`, etc.

## How it works

```text
┌──────────────┐   MCP stdio   ┌──────────────────────────────┐
│   OpenCode   │ ────────────► │ Node.js MCP server           │
│   (agent)    │ ◄──────────── └ chrome_* tools               │
└──────────────┘               │ + local WebSocket bridge      │
                               └──────────────┬───────────────┘
                                              │ ws://127.0.0.1:8787
                                              │ (loopback, optional token)
                               ┌──────────────▼───────────────┐
                               │ Chrome extension (MV3)        │
                               │ service worker + CDP + DOM   │
                               └──────────────┬───────────────┘
                                              │
                               ┌──────────────▼───────────────┐
                               │ Tabs, iframes, forms,        │
                               │ screenshots, downloads...   │
                               └──────────────────────────────┘
```

- OpenCode starts the MCP server over stdio.
- The server also listens on a WebSocket bound to `127.0.0.1` only.
- The extension connects to that WebSocket as a client.
- The service worker runs commands on the tabs using the Chrome APIs and, when available, the Chrome DevTools Protocol (CDP) for trusted input and screenshots.

No traffic is sent to the internet by the server. Tool results (including screenshots, HTML, cookies, and logs) are delivered to OpenCode and may be sent to whichever model provider you are using — treat sensitive data with care.

## Requirements

- Google Chrome 116 or newer.
- Node.js 20 or newer.
- OpenCode V2.

## Installation

```powershell
git clone https://github.com/wellrccity/opencode-browser-bridge.git
cd opencode-browser-bridge
npm install
```

The OpenCode skill ships with the project, in `.opencode/skills/browser-control/`. After cloning, open OpenCode inside that folder: the skill appears in the list automatically and can be loaded with `@browser-control`.

The `opencode.jsonc` file already points at `server/src/index.js` and starts the server automatically:

```jsonc
{
  "mcp": {
    "servers": {
      "chrome": {
        "type": "local",
        "command": ["node", "server/src/index.js"],
        "cwd": ".",
        "codemode": false
      }
    }
  }
}
```

Restart OpenCode after installing the dependencies. To check the server state:

```powershell
opencode mcp list
```

## Loading the extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project's `extension` folder.
5. Pin the extension to the toolbar for easy access to the popup.
6. Open the popup. It should show **Connected** when OpenCode (and the MCP server) are running.

If you open `file://` pages, enable **Allow access to file URLs** in the extension settings.

> The extension uses the `debugger` permission, so Chrome shows a banner reading "OpenCode Browser Bridge started debugging this browser". That is expected while CDP is attached.

## First test

In OpenCode, ask something like:

```text
Use chrome_status to check the connection, then open https://example.com in a new tab.
Take a snapshot of the page and click the "More information..." link.
```

Recommended agent flow:

1. `chrome_status` — confirms the connection and lists the tabs.
2. `chrome_navigate` — opens a URL.
3. `chrome_snapshot` — returns a compact accessibility tree with refs like `f0_e12`.
4. `chrome_click`, `chrome_type`, `chrome_select`, `chrome_hover`, `chrome_press` — operate on the refs.
5. `chrome_wait_for` — waits for async updates or navigation.
6. `chrome_screenshot` — use it when the visuals matter. `annotate=true` draws the refs and `grid=true` adds a 100 px grid.

Refs are the most reliable way to target elements. They belong to a frame: `f0_e12` is the main frame; `f123_e4` is frame 123. If the page changed, take a new snapshot.

## Bundled skill

The project includes a local skill at `.opencode/skills/browser-control/SKILL.md`. It teaches the full flow: check the connection, pick a `tabId`, use refs, fill forms, wait for dynamic content, take screenshots, handle iframes/shadow DOM, upload, cookies, network, emulation, and error recovery.

In a new OpenCode session the skill appears automatically in the skill list. You can load it explicitly with `@browser-control` or by asking something like "use the browser skill". Detailed references live in:

- `.opencode/skills/browser-control/references/tool-reference.md` — arguments for every tool.
- `.opencode/skills/browser-control/references/troubleshooting.md` — diagnosis and recovery.

The skill complements the MCP server instructions; it does not replace the connected extension.

## Available tools

In Code Mode each tool is called as `tools.chrome.<name>` inside `execute`; the table uses the `chrome_*` MCP names.

| Tool | What it does |
| --- | --- |
| `chrome_status` | Connection state, open tabs, and the active tab. |
| `chrome_tabs` | List, create, activate, close, reload, duplicate, pin, or mute tabs. |
| `chrome_navigate` | Open a URL, go back, forward, reload, or stop. |
| `chrome_snapshot` | Accessibility tree with refs; supports iframes and shadow DOM. |
| `chrome_screenshot` | Viewport, full page, or an element; optional annotations and a grid. |
| `chrome_click` | Click by ref, selector, text, or coordinates; real event via CDP. |
| `chrome_type` | Type into an input, textarea, or contenteditable; clear and submit with Enter. |
| `chrome_press` | Keys and combinations: Enter, Tab, Escape, Control+A, Shift+Enter, F5... |
| `chrome_hover` | Move the mouse to open menus, tooltips, and trigger `:hover`. |
| `chrome_select` | Select `<select>` options by value, label, or index. |
| `chrome_scroll` | Scroll the page or a container, jump to top/bottom, or bring an element into view. |
| `chrome_wait_for` | Wait for a selector, text, URL, JavaScript predicate, or load state. |
| `chrome_evaluate` | Run JavaScript in the page main world and return JSON. |
| `chrome_dom` | Query HTML, text, attributes, styles, rects, and counts. |
| `chrome_fill_form` | Fill several fields at once and optionally submit. |
| `chrome_upload_file` | Attach files to an `<input type="file">` via CDP. |
| `chrome_console` | Read logs, warnings, errors, and unhandled rejections. |
| `chrome_network` | Read captured `fetch`/XHR requests, with status and duration. |
| `chrome_cookies` | Read, create, delete, or clear the site's cookies. |
| `chrome_dialog` | Inspect `alert`/`confirm`/`prompt` and change the answer policy. |
| `chrome_highlight` | Draw temporary outlines around elements. |
| `chrome_drag` | Drag from one element/point to another. |
| `chrome_emulate` | Emulate viewport, mobile, user agent, geolocation, theme, timezone, and network. |
| `chrome_debugger` | View, attach, or detach a tab's CDP debugger. |

## Performance

The defaults favor speed and context savings:

- `chrome_click` uses `human=false` by default (no humanized mouse path). Pass `human=true` when the site needs it.
- After a click, the bridge watches for navigation for ~700 ms (`detectNavigationMs`). Raise it if the click takes a while to navigate.
- `waitUntil` defaults to `domcontentloaded`; ask for `load` or `networkidle` when the content depends on late resources, or `none` to not wait.
- Prefer `chrome_snapshot` over `chrome_screenshot`: snapshots cost much less context.
- Use `chrome_wait_for` (selector, text, URL, `js`, or `loadState`) instead of fixed pauses.

## Code Mode

This project uses **Code Mode** (`"codemode": true` in `opencode.jsonc`). The tools are not listed natively one by one; they are available inside the `execute` tool:

```js
const status = await tools.chrome.status({});
const snap = await tools.chrome.snapshot({ tabId: 123 });
return { status, snap };
```

Benefits:

- The catalog reaches the model compactly, instead of the full JSON schemas for all 24 tools on every request.
- Several independent calls can be grouped into a single `execute` with `Promise.all`.

Cost: the flow now uses `execute` and `tools.chrome.*`; the `browser-control` skill already documents this. To go back to the direct `chrome_*` tools, use `"codemode": false` and run `opencode reload`.

## Extension settings

Open the extension popup to adjust:

- **MCP server URL** — defaults to `ws://127.0.0.1:8787`.
- **Token** — optional; must match `OPENCODE_BROWSER_TOKEN` on the server.
- **Auto-connect** — reconnects when Chrome starts.
- **Use CDP by default** — enables trusted input (`isTrusted=true`), CDP screenshots, evaluation, uploads, and emulation. Turn it off if the debugging banner bothers you.
- **Keep debugger attached** — when off, CDP is detached a few seconds after each command.
- **Intercept dialogs** — prevents `alert`, `confirm`, and `prompt` from blocking automation.
- **Accept `confirm()`** — choose the automatic answer.
- **`prompt()` answer** — text returned automatically.
- **Switch to new tabs** — activates a tab opened by a click.

## Server environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_BROWSER_PORT` | `8787` | WebSocket bridge port. |
| `OPENCODE_BROWSER_HOST` | `127.0.0.1` | Listening address. |
| `OPENCODE_BROWSER_TOKEN` | empty | Shared token required from the extension. |
| `OPENCODE_BROWSER_ALLOW_REMOTE` | empty | `1` allows listening outside loopback. Avoid. |
| `OPENCODE_BROWSER_REQUEST_TIMEOUT` | `30000` | Default command timeout in ms. |
| `OPENCODE_BROWSER_DEBUG` | empty | `1` includes stack traces in tool errors. |

If you change the port, also update the URL in the extension popup. Several OpenCode sessions can share the same bridge: the first one to start owns the port and the others attach to it automatically.

Example with a token:

```jsonc
"environment": {
  "OPENCODE_BROWSER_PORT": "8787",
  "OPENCODE_BROWSER_TOKEN": "{env:OPENCODE_BROWSER_TOKEN}"
}
```

Then fill the same token into the extension popup.

## Security

- The bridge listens on loopback only by default.
- The server rejects connections with a common web page `Origin`; only `chrome-extension://` (or local clients with no `Origin`, like the tests) can connect.
- A shared token is optional but recommended on shared machines.
- Only one extension is connected at a time; a new connection replaces the previous one.
- The control channel between OpenCode sessions uses the same loopback listener, requires the same token, and never reaches the extension: each request is revalidated by the owning process. On shared machines, set `OPENCODE_BROWSER_TOKEN` so other local users cannot use the bridge.
- The extension has broad access to the browser: tabs, DOM, cookies, screenshots, and the debugger. Install only this local code and review changes before using it.
- Never expose the bridge port on the network. If you use `OPENCODE_BROWSER_ALLOW_REMOTE=1`, you assume the risk.
- The agent must confirm with you before irreversible actions (purchase, delete, send message).
- Cookies, tokens, and personal data must not be exfiltrated; inspect only what the task requires.

## Troubleshooting

### The extension shows "Disconnected"

1. Check that OpenCode is open and that the `chrome` MCP server is connected (`opencode mcp list`).
2. Confirm that the port in the popup matches the server's.
3. Click **Connect** in the popup.
4. Reload the extension at `chrome://extensions`.
5. If there is a token, confirm that both sides use the same value.

### `PORT_IN_USE`

Only one process can listen on the port. The MCP server handles this itself: if another bridge already owns the port, it attaches to that instance instead of exiting. If the owning session closes, the next one takes over the port.

The error still appears when whoever holds the port is **not** the bridge. In that case stop the process or change `OPENCODE_BROWSER_PORT` in `opencode.jsonc` and the URL in the popup.

### `NOT_CONNECTED` / `NOT_READY`

The extension did not complete the handshake. Open the popup, click **Connect**, and reload the extension if the problem persists.

### CDP does not attach

DevTools or another extension may be using the tab's debugger. Close DevTools and try again. Without CDP the tools still work with synthetic events, but without trusted input, full-page screenshots, uploads, and emulation.

### Pages that cannot be controlled

Chrome blocks extensions on `chrome://`, the Chrome Web Store, and some internal pages. Use normal `http(s)` pages. For `file://`, enable access to file URLs.

### Only some `chrome_*` tools appear

Check that the server is configured as `chrome` in `opencode.jsonc`. **Do not use `browser` as the MCP server name**: OpenCode V2 already has a native `browser` namespace (denied by the default `browser` permission), and MCP tools with the same name are shadowed. That is why `navigate`, `snapshot`, `screenshot`, `click`, etc. disappeared.

If the name is already `chrome` and tools are still missing, open a **new session** in the same project directory. In affected versions the MCP catalog can be frozen per session. The extension and the server keep running; nothing needs to be reinstalled. Check the total with:

```powershell
opencode mcp list
```

The current server registers 24 tools.

### No console or network logs

The extension captures data from the moment the page loads. Reload the page after installing or reloading the extension.

### Native dialogs blocking things

Enable **Intercept dialogs** in the popup. If a native dialog is already open, use `chrome_dialog` or close it manually.

### Full-page screenshot with repeated headers

Without CDP the capture is done in pieces and fixed headers can appear repeated. Use CDP (`trusted`/`preferCdp`) for the native capture.

### Clicks in iframes

Trusted CDP clicks are used in the main frame. In iframes the agent uses synthetic DOM events. For flows that require `isTrusted`, open the iframe content directly when possible.

## Development

```powershell
npm run icons   # regenerates extension/icons/*.png
npm run check   # validates manifest syntax and references
npm test        # bridge and MCP server tests
npm start       # runs the MCP server manually (without OpenCode)
```

Structure:

```text
extension/
  manifest.json          MV3 manifest
  background.js          service worker, WebSocket and routing
  popup.html/css/js      interface (in English)
  content/agent.js       DOM agent injected on demand
  content/page-hooks.js  console/network/dialogs in the MAIN world
  lib/cdp.js             Chrome DevTools Protocol helpers
  lib/image.js           annotation, grid and resizing
  lib/settings.js        default settings
  lib/util.js            utilities
server/src/
  index.js               MCP entry over stdio
  bridge.js              local WebSocket bridge
  proxy.js               attaches to a bridge already open in another session
  version.js             shared version
  tools.js               MCP tool definitions
  format.js              response formatting
test/                    tests without Chrome
scripts/                 icons and verification
.opencode/skills/
  browser-control/       skill for using the integration
    SKILL.md
    references/          tool reference and troubleshooting
```

## Known limitations

- Chrome can suspend the service worker; the keepalive alarm and automatic reconnect reduce the impact.
- JavaScript evaluation in the main world can be blocked by some pages' CSP; CDP is the preferred path.
- Very tall full-page captures are limited and may be scaled down.
- The extension does not bypass authentication, CAPTCHAs, or site policies; use it responsibly.
- Dialog and frame behavior varies by site.
