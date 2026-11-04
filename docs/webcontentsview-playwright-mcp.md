> 历史记录：文中 Playwright MCP 实现和对应采集、打包脚本已移除；当前网页入口见 [browserskill-backend.md](browserskill-backend.md)。

# WebContentsView + Playwright MCP integration

Validated on Electron 33.4.11 (Chromium 130, CDP 1.3) with
`@playwright/mcp` 0.0.78.

Run the real integration spike:

```sh
node scripts/spike-electron-webcontentsview-cdp.mjs
```

The spike launches a real Electron app, creates a Brain UI `BrowserWindow` and
a persistent `WebContentsView`, attaches through the loopback CDP endpoint,
uses the production `connectEmbeddedPlaywright` connector, navigates
`https://example.com`, reparents the same view between compact and large hosts,
restarts Electron, and verifies a persistent cookie.

## Findings

- A `WebContentsView` is a live Chromium page, not a screenshot. Reparenting
  the same instance preserves its `webContents.id`, Playwright `Page`, current
  navigation, and in-page history.
- An Electron `persist:` partition preserves cookies and login storage across
  app restarts.
- Electron exposes the Brain UI, host windows, and embedded browser through one
  app-wide remote-debugging endpoint.
- Different Electron StoragePartitions still appear in Playwright as pages in
  `browser.contexts()[0]`. `devTools: false` does not remove Brain UI from the
  CDP target catalog.
- Consequently, the Playwright MCP CLI's `--cdp-endpoint` is unsafe here: it
  blindly uses `contexts()[0]` and its initial current page can be Brain UI.
- Passing the raw context to programmatic `createConnection(config,
  contextGetter)` has the same problem. `contextGetter` narrows a context, not
  a page.
- A Playwright page can be matched exactly to Electron's target using a page
  CDP session and `Target.getTargetInfo`. This target id matches the id resolved
  by Electron's `webContents.fromDevToolsTargetId`.

## Production wiring

The production connector in
`src/mcp/embedded-playwright-connection.js`:

1. Accepts only a loopback CDP endpoint and a resolved Electron target id.
2. Starts a Node-mode sidecar over stdio so the Electron main process never
   asks Playwright to attach to its own CDP endpoint while it is initializing.
3. Finds the exact Playwright `Page` by `Target.getTargetInfo`.
4. Wraps its merged Electron context in a single-page facade.
5. Maps request, WebSocket, unroute, and init-script operations to the selected
   page instead of the raw context.
6. Disables page creation and keeps context/page close operations as no-ops.
7. Connects official Playwright MCP through SDK `StdioClientTransport`.

The host explicitly commits `about:blank` when the persistent
`WebContentsView` is created. Without that first committed renderer Electron
can list the DevTools target while Playwright's CDP initialization still waits
until it times out. Plain Node integration tests retain an in-memory connector;
the production Electron path uses the sidecar.

`client-manager.js` uses this connection only when the Electron bridge exists.
Plain Node and non-Electron execution retain the existing stdio CLI and
headless-reader screenshot fallback. In embedded mode, card and window use the
same interactive connection, native preview metadata is returned without
taking an extra screenshot, and tab creation/closing is rejected because the
Electron host owns one persistent page.

The native browser schemas come from the pinned official Playwright package and
remain discoverable before the first CDP connection. If startup is delayed or a
connection drops, the next browser tool call retries the embedded connection
instead of reporting that the already-discovered tool is unknown.

The page guard is page-scoped. A context-wide route would also intercept Brain
UI traffic because Electron's CDP integration merges all WebContents into one
Playwright context.

## Security boundary

The random remote-debugging port is loopback-only, but any local process that
discovers it can still control every Electron target. It must never bind to a
LAN interface. The exact-page facade protects the Agent/MCP path; it does not
turn the raw CDP endpoint into a generally authenticated interface.

Keep the existing fixed tool allowlist. In particular, do not expose arbitrary
JavaScript execution, storage/cookie tools, file upload, or detailed network
inspection. Electron partition storage is not represented as distinct
Playwright contexts, so context-wide storage APIs are not a reliable
per-surface boundary.
