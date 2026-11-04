# Web access: web_search + bsk

Public search uses the `web_search` function tool, backed by saved DeepSeek or
OpenAI provider credentials, independently of the active chat model. Search can
return original text or a cited provider answer. Snippets alone are not verified
article content. Date-scoped research retains date checks across retrievals.

Browser work uses the bundled `skills/bsk/SKILL.md` and its upstream references,
executing Tencent's official `bsk` CLI with `run_command`. The skill is named `bsk`;
it is not an additional function-call tool. `read_file` can read bundled skill
references even with the file sandbox enabled; this grants no write permission.

The old `model_web_search`, `model_web_fetch`, `web_read`, `fetch_url`,
`system_browser_open`, browser download wrappers and all `browser_*` function
tools are unavailable in model schemas, discovery and execution policy. The
old human-web-search skill has been removed. Historical tool names in UI logs
and dormant browser adapters do not re-enable those tools.

## Installation and sessions

The skill and its references ship through the existing `skills/**/*` package
rule. The CLI and Chrome/Edge extension are separate dependencies. Follow
Tencent's installation guide: https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md
Use `bsk --version`, `bsk doctor` and `bsk browsers` to inspect the environment.
Do not install software or start a browser session merely to list capabilities.

Session creation uses `skills/bsk/scripts/session.mjs ensure` through
`run_command`. It persists its own session identity under the user data sandbox,
ships its executable script outside app.asar on all platforms,
checks the live session list before reuse, and keeps one default foreground
window across sequential requests. Extra pages use tabs in that window.
Explicit profile selection uses an instance ID; deliberately separate work uses
a stable `--slot`. Independent tasks must serialize access to the default slot.

Creation is locked across helper processes. A persisted request ID permits
recovery after a lost start response without replaying session creation. Unknown
state and cleanup failures block new creation. The helper never adopts arbitrary
existing sessions or closes other tools' windows. `close` clears state only after
confirmed cleanup. A hard-killed helper can leave a lock; inspect its PID before
removing that lock, preserving the session JSON for request recovery.

Page interaction continues through the official CLI with fresh cooperation
contexts. Return borrowed user tabs at the end of their step. Keep the default
window for follow-up requests; close it when requested. Temporary explicitly
separate slots are closed when finished. The former wrapper task panel does not
manage these CLI sessions. Do not bypass paused legacy sessions or restart shared
daemons to recover.

The exact vendored upstream revision and license are in `skills/bsk/UPSTREAM`
and `skills/bsk/LICENSE`. The entrypoint and managed session helper are Bailongma adaptations; upstream reference documents are included intact.

## Validation

`node --test src/test-web-search.js src/test-web-read.js src/test-model-web-service.js src/test-model-vision-web.js src/test-tool-schema-dedup.js src/test-config-upgrade.js src/test-agent-skills.js`

Network-provider tests use a local mock HTTP service. Browser CLI routing and
execution evidence use controlled fixtures; these tests do not manipulate the
user's real logged-in browser.

Playwright MCP server code, sidecars and browser packaging scripts have been removed.
The `playwright` and `playwright-core` packages are also removed, including their
UI smoke tests and browser performance diagnostics. HTTP/SSE performance probing
remains available through `scripts/probe-request-performance.mjs --http`.
