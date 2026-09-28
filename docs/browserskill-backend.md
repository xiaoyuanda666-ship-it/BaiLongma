# Real Chrome browser integration

BaiLongma uses Tencent BrowserSkill exclusively. Electron renders the application UI only.
`BAILONGMA_BROWSER_BACKEND=embedded` no longer enables an alternate browser.
No browser profile is copied, no credentials/cookies are read, and there is no webpage
card, custom browser window, screenshot stream, DOM mirror, or input forwarding.

## Setup and binding

Install CLI and Chrome extension using [Tencent's installation guide](https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md).
Run `bsk --version`, `bsk doctor`, and connect the extension in the intended Chrome
profile. Start a missing daemon from your terminal using `bsk daemon start`.
BaiLongma never restarts or automatically launches the shared daemon.

Open **Chrome 浏览器任务** in Brain UI. Refresh connection status, set the absolute
CLI path if necessary, and select the instance ID shown in that profile's extension
popup. CLI lookup honors `BAILONGMA_BSK_PATH`, saved settings, `BSK_INSTALL_DIR`,
`~/.local/bin`, PATH and standard Homebrew locations, without invoking a shell.
`BAILONGMA_BSK_BROWSER` explicitly binds an instance; environment overrides lock UI
configuration. Settings are saved separately in `browser-skill.json` in the app user
directory. Existing app configuration is untouched.

Multiple instances require selection. An initial single instance is bound by exact
ID before session creation and saved; disconnection never removes that binding.
Changing settings requires all owned sessions to be closed. Labels may be supplied
through the environment only when unique; the session receives the exact instance ID.
The adapter checks CLI/daemon/extension matching versions and protocol 1.3, the
locally verified protocol. Other versions fail closed with update/connection guidance.
It does not install or update software automatically.

## Lifecycle and human control

Session creation uses the verified `session request --prepare`, `session start --request-id`, and `session request --claim` flow. A lost start reply is inspected by request ID instead of repeating creation; unresolved requests are cancelled during cleanup.

Each session serializes commands and explicitly targets its owned tab. Interactive
sessions are reused across turns for the same UI client (or channel/recipient).
Background success/failure releases the session at turn end; login/challenge or
cancellation retains the page. A cancelled CLI does not prove daemon work stopped.

**Takeover / cancel** immediately blocks new and queued Agent commands, waits for
accepted work to finish, and verifies daemon idle before confirming takeover.
An unresolved wait stays blocked. The user works in the same real Chrome page.
**Resume** reads the page and requires the Agent to obtain a new snapshot before
any referenced input; it does not resume the LLM turn automatically. Send a continue
message after pressing Resume. No stale refs or unknown submissions are replayed.
Login detection is heuristic; the user can always take over explicitly. Real Chrome
can still encounter CAPTCHA. This adapter does not automate credential/verification
entry or modify extension Automation settings.

**Close** stops only the recorded session. It does not clear site data or close
unrelated windows. App quit awaits owned-session cleanup (45-second bound); a busy
session gets one bounded idle wait and one stop retry. Failures remain tracked while
the process is alive. Forced termination or a persistently disconnected daemon can
leave a Chrome Agent Window; manual cleanup through bsk may then be needed. There
is no automatic orphan adoption. Standalone backend process hard termination has
the same limitation. Never restart the daemon to clean up.

`GET /browser-backend/status` returns connection and owned task states.
`POST /browser-backend/settings` configures CLI and instance.
`POST /browser-backend/task` accepts takeover/cancel/resume/close for a known owned
session only. These endpoints require existing local/token authentication.
Removed `/browser-surface*` and `/browser-preview` endpoints return 410; explicit
screenshots are delivered using the existing chat-media path.

## Capability audit (bsk 0.3.1 / protocol 1.3)

| Capability | Upstream command | BaiLongma integration |
| --- | --- | --- |
| Navigate/back/forward/reload | navigate, navigate-back, navigate-forward, reload | Supported; entry URL policy retained |
| Read/ref continuation | observe, snapshot, get-html | observe + cursor exposed; HTML not exposed |
| Click/fill/forms/select/key/hover | click, fill, select, press, hover | Supported; fresh @eN refs; partial form progress reported |
| Scroll | wheel, scroll-to | browser_scroll uses wheel; keyboard scrolling also available |
| Tabs | tab list/create/select/close | Supported for task-owned tabs only; create blank then navigate |
| Borrow/return user tabs | tab borrow/return | Not exposed; no automatic borrowing |
| Viewport/full-page PNG | screenshot | One-off explicit capture; no continuous display |
| Console | console | Supported |
| Local upload/download | upload/download | Upstream supports both; not exposed by this adapter |
| Remote upload/download | — | Upstream unsupported |
| Download jobs/pause/resume/retry | — | Old Electron job integration disabled; explicit unsupported result |
| Browser data deletion | — | Disabled; never touches Chrome profile data |
| Drag/dialog/find/wait/resize/evaluation | varies | Existing tool names return unsupported where not mapped; no fallback |
| Human-help overlay | request-help | Upstream protocol 1.3; adapter uses explicit task-panel takeover/resume |

Bsk controls redirects/subresources in real Chrome. Electron request interception
is no longer present; the adapter must not claim it enforces subresource/network
policy. Navigation entry URLs still go through BaiLongma's URL validator.

## Migration and packaging

The old screenshot draft module and API were removed. Native webpage host
construction, browser IPC, renderer surface and automatic preview capture were
removed. Electron BrowserWindow/app Chromium remains intact. Legacy browser engine
modules remain as diagnostic/test source, excluded from packaged resources; pinned
Playwright and Chrome DevTools packages are development dependencies only. Browser
binary preparation/resources were removed from platform builds. Node runtime and
speech/native dependencies remain.

Current system prompt and built-in self-knowledge explicitly supersede only old
embedded/card/window/fixed-session browser procedures in recalled memories.
No user database is rewritten or cleared. Previous unrelated work (security,
startup, voice, memory/thread changes) remains in the working tree. The pre-change
source backup for this development session is `/tmp/bailongma-pre-real-chrome/`.

## Verification

- `npm run test:browser-core`: adapter/lifecycle/connection/packaging tests plus URL
  policy and challenge guards.
- `node --test src/test-browser-screenshot-contract.js src/mcp/test-scoped-tool-call.js src/mcp/test-browser-result-pages.js`
- `node scripts/smoke-browserskill.mjs`: isolated real Agent Window, example.com,
  local test form input/click, native scrolling, takeover/resume/ref refresh,
  task tab create/close, PNG verification and session cleanup. No user tabs borrowed.

Multi-profile and disconnection cases use deterministic mocks; this machine has
one connected Chrome profile. No production app was restarted, installed or
published, and no full distributable build was run.

### Verified on 2026-09-27 (macOS)

43 adapter/core automated tests passed, plus URL-policy and challenge-guard checks;
6 screenshot/scoped-call/pagination tests passed. The real Chrome smoke passed,
including the rendered task panel and status API. CLI, daemon and extension were
0.3.1 / protocol 1.3. Final session list was empty; the shared daemon PID was
unchanged. Multi-instance selection and disconnect behavior were tested with mocks,
not by creating or modifying the user's Chrome profiles. Syntax checks and
`git diff --check` passed. Historical embedded-browser suites are superseded by
`test:browser-core`; no claim is made that every legacy project test still passes.
