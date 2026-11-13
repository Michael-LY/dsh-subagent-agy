# dsh-subagent-agy

**English** | [中文](README_CN.md)

DSH (DeepSeek Harness) plugin: delegate one-shot tasks to the local **Antigravity CLI (`agy`)**, and provide two independent sidebar panels for **Gemini Web Deep Research** and **Gemini Web Chat**.

- npm package: `dsh-subagent-agy`
- Current version: `0.6.2`
- Repository: <https://github.com/Michael-LY/dsh-subagent-agy>

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Installation & Deployment](#2-installation--deployment)
- [3. Usage](#3-usage)
- [4. Configuration](#4-configuration)
- [5. Architecture](#5-architecture)
- [6. Directory Structure & Modules](#6-directory-structure--modules)
- [7. Verification & Testing](#7-verification--testing)
- [8. Known Limitations & Notes](#8-known-limitations--notes)

---

## 1. Overview

### 1.1 Positioning

Antigravity (`agy`) is Google's Agent CLI. It does not expose a public app-server or client SDK, offering only interactive CLI and headless scripting modes. This plugin provides three capabilities in DSH:

1. **One-shot Subagent Delegation**: Registers the `antigravity` provider and exposes `subagent_agy` to the model. Each task spawns an isolated `agy` child process in the host session's workspace and exits upon completion.
2. **Concurrent / Team Subagents**:
   - `subagent_agy_team`: Bound to the `antigravity-team` provider; prepends a team directive to the prompt so the main `agy` model uses its native `invoke_subagent` to split and run subtasks concurrently in a single turn.
   - `subagent_agy_parallel`: A DSH-side batch tool that launches multiple independent `agy` subagents concurrently in one call, returns IDs immediately, and delivers results asynchronously.
3. **Gemini Web Integration**:
   - **Gemini Research** panel: Runs multi-step Deep Research via the Google AI Pro web interface.
   - **Gemini Chat** panel: Multi-turn chat directly with Gemini Web.
   - Both panels have their own independent task queues while sharing a single persistent browser worker, so they do not block each other and can run concurrently.

### 1.2 Trigger Keywords

The model invokes this plugin via the `subagent_agy` tool. Trigger keywords are `agy` and `antigravity` (case-insensitive), coordinated across three places:

1. Descriptions in `locale/zh.json` and `locale/en.json`;
2. `provider` / `toolName` bindings in `cordis.patch.yml`;
3. Model instructions in `%USERPROFILE%\.dsh\AGENTS.md`.

---

## 2. Installation & Deployment

### 2.1 Install from npm

```powershell
npm install dsh-subagent-agy
# Or install into a specific DSH profile:
dsh plugin --profile desktop add dsh-subagent-agy
```

After installation, restart the DSH GUI. The model will have access to `subagent_agy`, `subagent_agy_team`, and `subagent_agy_parallel`, and the sidebar will show the **Gemini Research** and **Gemini Chat** entries.

### 2.2 Local Development & Profile Setup

This plugin can also be linked as a local dependency in the local DSH Desktop profile (`%USERPROFILE%\.dsh\profiles\desktop`). In the profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-subagent-agy": "file:C:/Users/moyi_/Documents/Claude-Mok/dsh-subagent-agy"
  }
}
```

And add `"dsh-subagent-agy"` to `dsh.profile.bundles`.

### 2.3 Hardlinks & Sync Notes

- After profile installation, `node_modules/dsh-subagent-agy/*` points to the corresponding files in this repository via **hardlinks**.
- In-place edits to existing files take effect immediately through hardlinks; **newly added files are not synced automatically**, and atomic-write replacements by an editor may break hardlinks.
- When adding new files or rebuilding hardlinks:

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

> The built-in DSH sandbox may block `pnpm` from writing to the global store; run this in a real standalone terminal, then restart the DSH GUI.

### 2.4 Requirements

- Node.js `>=22.19.0`, DSH `>=0.2.2-rc.3 <0.3.0-0`.
- `agy` CLI installed and authenticated locally (default path: `%USERPROFILE%\.gemini\bin\agy.exe`).
- Gemini Web features require local `python` and `playwright` (`pip install playwright`); uses the system default browser (Chrome/Edge), so `playwright install` is not required.

---

## 3. Usage

### 3.1 Subagents

- `subagent_agy`: Single-task delegation. The prompt must be self-contained, as the child process does not inherit parent session context.
- `subagent_agy_team`: Best when you have one large task and want `agy` to decompose it itself using native `invoke_subagent` concurrently.
- `subagent_agy_parallel`: Best when you already know the independent subtasks to split into; accepts `tasks: [{description, prompt, cwd?}]`, up to 8 tasks by default.

### 3.2 Gemini Research Panel

- Top status bar shows running state, login process, login state, and profile status.
- Enter a research topic → click **Start Deep Research** (typically takes 5–10 minutes per run).
- Displays the final report with copy support on completion; shows errors and logs on failure.
- Runs one research task at a time; uses a separate queue from Gemini Chat so both can run concurrently.

### 3.3 Gemini Chat Panel

- Message list + input box: `Enter` to send, `Shift+Enter` for newline.
- Multi-turn context is preserved within the same browser page; **New Chat** resets the context.
- Regular chat works without signing in (without history); Deep Research requires login.
- Shares the same browser profile with Deep Research, but uses its own tab and queue.

### 3.4 Login

1. Click **Initialize Login** in either Gemini panel.
2. Your system default browser (Chrome/Edge) opens; sign in to your Google AI Pro account.
3. Once signed in, `init_login.py` writes `login-ok.json` and exits; the panel status updates to verified.
4. `login-ok.json` only indicates a historical login file exists; actual runtime verification relies on `signedIn` / `checkedAt` in `login-state.json`.

### 3.5 Transport Modes (`transport`)

`agy` supports two headless channels, switched via the `transport` config field:

| `transport` | Channel | Description |
|---|---|---|
| `acp` (default) | `agy acp` | Persistent stdio JSON-RPC 2.0 server (NDJSON) with `initialize` / `session/new` / `session/prompt`, in-session streaming updates, and reverse permission requests (`session/request_permission`). |
| `stream-json` | `agy --print … --output-format stream-json` | One-shot process with unidirectional NDJSON event stream; legacy channel, still supported. |

`acp` is used by default; if handshake or session creation fails, it automatically falls back once to `stream-json` (`acpFallbackToStreamJson: true`). To force the legacy channel, set `transport: stream-json` under `- id: subagent-antigravity` in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: subagent-antigravity
      config:
        transport: stream-json
```

For ACP-specific fields (`acpProtocolVersion` / `acpRequestTimeoutMs` / `acpPromptTimeoutMs` / `acpPermissionPolicy` / `acpFallbackToStreamJson` / `acpExtraArgs`), differences vs. `stream-json`, verification, and rollback instructions, see **[docs/agy-acp-transport.md](docs/agy-acp-transport.md)**. Two key notes:

- Under ACP, `printTimeout` and `jsonSchema` **do not take effect** (a warning is logged), `effort` is appended as a model name suffix, and `addDirs` uses `session/new.additionalDirectories`; handshake failures fall back to `stream-json` by default (`acpFallbackToStreamJson`).
- The added `lib/acp-client.js` requires running `pnpm install` once in the profile per [2.3](#23-hardlinks--sync-notes), followed by a GUI restart.

### 3.6 Graphical Settings UI

Open DSH Web GUI **Settings** → **Antigravity** on the left sidebar to edit all 35 configuration fields in the UI without manually editing profile YAML:

- Organized into **5 groups**: **Basic** / **Transport & ACP** / **Gemini Web** / **Team & Parallel** / **Advanced**.
- **Immediate effect**: Changes are written to the profile config and hot-reloaded immediately; unmodified fields are not written to disk.
- **Safety**: Deployments without the settings service remain unaffected (Gemini panels work normally); empty/invalid values, `NaN`, and invalid `env` lines are not persisted; `teamProviderName` must differ from `providerName`; **changing Gemini runtime settings restarts the worker and may interrupt active tasks**.
- **No regressions**: Both Gemini panels and `subagent_agy` / `subagent_agy_team` / `subagent_agy_parallel` continue working unchanged.

For the full field reference, architecture, verification steps, and rollback notes, see **[docs/settings-ui.md](docs/settings-ui.md)**.

> Requires `@deepseek-ai/dsh-client-ui-settings` in `dsh.client.inject`; new files require running `pnpm install` in the profile per [2.3](#23-hardlinks--sync-notes) and restarting the GUI.

---

## 4. Configuration

### 4.1 Example Configuration

```yaml
- insert:
    - id: subagent-antigravity
      name: 'dsh-subagent-agy'
      config:
        providerName: antigravity
        executable: 'C:/Users/moyi_/.gemini/bin/agy.exe'
        model: gemini-4-argon-high
        effort: high
        permissionMode: dangerously-skip-permissions
        newProject: false
        projectName: ''
        printTimeout: 180s
        # jsonSchema: '{"type": "object"}'   # Optional: inline JSON or file path; do not pass an empty string
        addDirs: []
        fallbackModel: gemini-3.8-flash-high
        retryOnRateLimit: false
        disposeGraceMs: 3000
        geminiProfileDir: 'C:/Users/moyi_/.dsh/gemini-web-research/browser-profile'
        geminiPython: python
        geminiHeadless: true
        geminiTimeoutMs: 900000
        geminiChatTimeoutMs: 180000
        geminiWorkerIdleMs: 600000
        geminiWorkerMode: persistent
        geminiDefaultModel: ''
        geminiDefaultThinking: ''
        teamProviderName: antigravity-team
        teamEnabled: true
        parallelToolName: subagent_agy_parallel
        parallelMaxTasks: 8
        extraArgs: []
        env: {}
```

### 4.2 Field Reference

| Field | Type / Validation | Default | Description |
|---|---|---|---|
| `providerName` | `string` (`min(1)`) | `antigravity` | Provider name registered on `ctx.subagents`; must match the tool binding name. |
| `executable` | `string` (`min(1)`) | `%USERPROFILE%/.gemini/bin/agy.exe` | Absolute path to the `agy` executable. |
| `model` | `string` (`min(1)`) | `gemini-3.8-flash` | Base model name from `agy models` (e.g., `gemini-3.8-flash`, `gemini-4-argon`, `claude-opus-5-5`, `gpt-oss-120b`); reasoning effort is specified separately via `effort`, and explicit values always take precedence. |
| `effort` | `low \| medium \| high \| xhigh \| max` | `medium` | Reasoning effort, mapped to `--effort`; under ACP, appended as a model suffix (e.g., `gemini-3.8-flash-medium`). |
| `env` | `Record<string, string>` | `{}` | Environment variables injected into the child process, overlaid on top of the scrubbed environment. |
| `permissionMode` | `dangerously-skip-permissions \| auto` | `dangerously-skip-permissions` | Permission mode. In print mode, tool confirmations are soft-rejected, so permissions are skipped by default; `auto` is only suitable for pure Q&A. |
| `extraArgs` | `string[]` | `[]` | Extra CLI arguments appended directly to `agy`. |
| `newProject` | `boolean` | `false` | Whether to pass `--new-project`. Disabled by default to avoid cluttering Desktop Projects with duplicate entries. |
| `projectName` | `string` | `''` | When non-empty, maps to `--project <name>` to reuse a fixed project; takes precedence over `newProject`. |
| `printTimeout` | `string` (`min(1)`) | None (wait indefinitely) | `--print-timeout` in Go duration format (e.g., `180s`, `10m`). Returns partial output and exits with 0 on timeout; cannot be used to judge task completion. |
| `jsonSchema` | `string` (`min(1)`) | None | `--json-schema`, inline JSON or file path. |
| `addDirs` | `string[]` | None | Additional read-only workspace directories, each mapped to `--add-dir`. |
| `fallbackModel` | `string` (`min(1)`) | None (no retry) | Fallback model on quota exhaustion or rate limit; retries at most once. |
| `retryOnRateLimit` | `boolean` | `false` | On HTTP 429 rate limits, backs off by the suggested duration and retries once (capped at 15s). |
| `disposeGraceMs` | `number` | `3000` | Grace period (ms) when terminating child processes. |
| `geminiProfileDir` | `string` (`min(1)`) | `~/.dsh/gemini-web-research/browser-profile` | Persistent browser profile directory for Gemini Web. Named `browser-profile` because the browser may be Edge or Chrome. |
| `geminiPython` | `string` (`min(1)`) | `python` | Python executable used for Playwright scripts. |
| `geminiHeadless` | `boolean` | `true` | Whether to run Gemini Web worker headless; login initialization is always headed. |
| `geminiTimeoutMs` | `number` | `900000` | Hard timeout (ms) for a single Deep Research run. |
| `geminiChatTimeoutMs` | `number` (`min(1000)`) | `180000` | Hard timeout (ms) for a single Gemini Chat message. |
| `geminiWorkerIdleMs` | `number` (`min(0)`) | `600000` | Idle timeout (ms) before recycling the persistent worker; `0` disables auto-shutdown. |
| `geminiWorkerMode` | `persistent \| oneshot` | `persistent` | `persistent` uses the long-lived worker; `oneshot` falls back to `run_research.py` for Deep Research (Chat still uses the worker, and `oneshot` does not support model/thinking selection). |
| `geminiDefaultModel` | `string` | `''` | Default model ID (`flash-lite` / `flash` / `pro` / `argon`) when the panel has no saved local selection; empty follows the web default. |
| `geminiDefaultThinking` | `string` | `''` | Default thinking level (`low` / `medium` / `high`) when the panel has no saved local selection; empty follows the web default. |
| `teamProviderName` | `string` (`min(1)`) | `antigravity-team` | Team provider name; must differ from `providerName`. |
| `teamEnabled` | `boolean` | `true` | Whether to register the `antigravity-team` provider. |
| `parallelToolName` | `string` (`min(1)`) | `subagent_agy_parallel` | Name of the batch parallel tool. |
| `parallelMaxTasks` | `number` (1–8) | `8` | Maximum number of tasks launched per batch call. |

---

## 5. Architecture

### 5.1 `agy` Delegation Pipeline

```
apply()
  → provider.start(request)
  → startAntigravityRunWithRetry() (only when fallbackModel / retryOnRateLimit is configured)
  → startAntigravityRun()
  → spawn agy --print --output-format stream-json (or agy acp via lib/acp-client.js)
  → lib/wire.js parses stdout (NDJSON)
  → settleRunResult() → { output, stopReason }
  → failures classified by lib/classify.js (quota_exhausted / rate_limited / usage_error / unknown)
```

- `lib/run.js`: Handles argv assembly, process spawning, stream collection, termination cleanup, and exit settlement.
- `lib/wire.js`: Line-splits NDJSON frames, validates envelopes, selects the final answer (terminal `result.response` first, `text_delta` fallback), and maps terminal status.
- `lib/classify.js`: Zero-dependency pure-function failure classifier.
- `lib/parallel.js`: Concurrently launches multiple `agy` subagents via `ctx.subagents.startActivation`, returning `{started, failed}` immediately.

### 5.2 Gemini Dual-Queue + Persistent Worker

```
lib/client.js (two sidebar panels)
  ├── "Gemini Research" → /models, /run, /job, /status
  └── "Gemini Chat"     → /models, /chat/send, /chat/job, /chat/status, /chat/new
                │
lib/gemini-web.js (HTTP bridge)
  ├── researchQueue (serial) ──┐
  └── chatQueue (serial) ──────┤
                               ▼
                GeminiWorkerClient (lib/worker-client.js)
                  ├── Lazy-starts python worker.py
                  ├── JSONL protocol: request / result / heartbeat / progress
                  ├── Rejects pending on crash; auto-restarts on next request
                  ├── Shuts down after geminiWorkerIdleMs idle
                  └── dispose() kills process tree
                               │
                worker.py (persistent Python worker)
                  ├── Single Chromium persistent context (persistent mode)
                  ├── ChatPage (chat.send / chat.new / models.list / status)
                  └── ResearchPage (research.run / models.list / status)
```

- Both queues are internally serial, yet share the same worker so Chat and Research run on two independent pages concurrently.
- When `geminiWorkerMode: oneshot`, `researchQueue` falls back to `run_research.py` (spawning a Python process per run), while Chat still uses the worker; `oneshot` research does not accept model/thinking parameters.
- Protocol: stdin/stdout JSONL; commands `chat.send`, `chat.new`, `research.run`, `models.list`, `status`, `shutdown`, `cancel`; responses `ready`, `heartbeat`, `progress`, `result` (`ok/error/data`). Logs go exclusively to stderr.
- Optional payload for `chat.send` / `research.run`: `model` (ID), `modelLabel` (UI label for matching), `thinking` (`low` / `medium` / `high`); results return `modelApplied` / `thinkingApplied` / `currentModel`.

### 5.3 Browser Profile & Login Detection

**Browser selection**: `default_browser_channel()` in `scripts/gemini_research/browser.py` reads the Windows Registry key `Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice`:

- `ProgId` contains `msedge` → `msedge` (Microsoft Edge)
- Contains `chrome` → `chrome` (Google Chrome)
- Unrecognized → `None` (Playwright bundled Chromium)

**Why a dedicated profile**: Playwright cannot reuse the User Data directory of an already-running Edge/Chrome instance (single-instance lock). The plugin uses an isolated profile at `~/.dsh/gemini-web-research/browser-profile` to persist login state after initial sign-in.

**Two-layer login detection**:

1. `init_login.py` (Login initialization):
   - Polls every second until a Google session cookie (`SID`) exists in the profile or page DOM indicates signed-in state.
   - Writes `login-ok.json` and exits 0 on success; reports `browser window closed before login was detected` if closed prematurely.
2. `login-state.json` (Runtime verification):
   - Each worker page calls `selectors.is_logged_in()` before/after opening or running tasks and writes `{signedIn, checkedAt, error?}` via `record_login_state()`.
   - Decision order: redirected to `accounts.google.com` → signed out; account menu present → signed in; editor visible without "Sign in to save activity" → signed in.

**Host status fields**:

- `loginSaved`: Whether `login-ok.json` exists (historical login marker).
- `loginReady`: `loginState.signedIn === true` and either the worker is online or `checkedAt` is within 5 minutes (grace period after fresh login).
- Prevents stale `login-ok.json` files from causing false-positive "ready" states.

### 5.4 Model & Thinking Selection

Both panels provide **Model** and **Thinking** dropdowns sent with each `/run` or `/chat/send` request:

- **Dynamic model catalog**: `models.list` opens the Gemini model menu (`[data-test-id='bard-mode-menu-button']`) and reads `[data-test-id^='bard-mode-option-']`; falls back to the static catalog in `lib/gemini-models.js` (`3.5 Flash-Lite` / `3.8 Flash` / `3.1 Pro` / `4 Argon`) on failure. Panels fetch `live=0` on mount and only query live models when clicking **Refresh Models**, avoiding unnecessary headless browser launches.
- **Model matching**: Inputs are normalized via `_model_id_from_label()` (supporting `flash`, `Flash`, `3.8 Flash ...`, etc.), matched by exact ID (`flash-lite` / `flash` / `pro` / `argon`), and verified by reading back the active model ID.
- **Thinking level**: Opens the "Thinking level" submenu at the bottom of the model menu, asserts exactly 3 items, and maps indices 0/1/2 to `low` / `medium` / `high` (sanity-checked in both English and Chinese).
- **Fallback behavior**: Keeps web defaults when no model/thinking is requested; returns `model_unavailable` / `thinking_unavailable` explicitly if a requested non-default option is missing rather than silently falling back. Only `/models` catalog fetch failures fall back to the static catalog.
- **Deep Research**: The model button is exposed before submission, so the panel offers selection, though whether Deep Research actually honors the selected model is not yet E2E-verified (noted in the UI as "may not take effect").
- **Deep Think**: Not implemented yet as there is no standalone control on the current page.

---

## 6. Directory Structure & Modules

```
dsh-subagent-agy/
├── AGENTS.md                  # Development & maintenance guidelines
├── README.md                  # English documentation (this file)
├── README_CN.md               # Chinese documentation
├── cordis.patch.yml           # Plugin patch: provider & tool bindings
├── package.json               # ESM manifest, peerDependencies, files allowlist
├── icon.svg                   # Plugin icon
├── docs/
│   ├── agy-acp-transport.md           # ACP transport delivery doc (usage/architecture/verification/risks)
│   ├── agy-acp-transport-design.md    # ACP integration design
│   ├── agy-acp-transport-review.md    # ACP implementation review notes
│   ├── settings-ui.md                 # Settings UI delivery doc (fields/architecture/verification/risks)
│   ├── settings-ui-design.md          # Settings UI integration design
│   ├── settings-ui-review.md          # Settings UI code review notes
│   └── headless-scripting-plan.md     # Headless scripting research notes
├── lib/
│   ├── index.js               # Cordis plugin entry: Config, Provider, apply
│   ├── run.js                 # agy process lifecycle & optional retry (stream-json)
│   ├── acp-client.js          # ACP transport: agy acp / JSON-RPC / permissions / retry
│   ├── wire.js                # NDJSON stream parser
│   ├── classify.js            # Failure classification & retry-after parser
│   ├── client.js              # Two sidebar panels (Gemini Research / Gemini Chat) + Settings UI
│   ├── gemini-web.js          # /api/dsh-gemini-research/* bridge, dual queues, login state
│   ├── gemini-models.js       # Static model catalog, normalization, validation & token matching
│   ├── worker-client.js       # Persistent worker client (lazy start/restart/idle recycle)
│   ├── parallel.js            # subagent_agy_parallel batch concurrent tool
│   └── types/
│       └── index.d.ts         # Hand-written TypeScript declarations
├── locale/
│   ├── zh.json                # Chinese descriptions & trigger keywords
│   └── en.json                # English descriptions & trigger keywords
├── scripts/
│   └── gemini_research/
│       ├── browser.py         # Resolves system default browser (Chrome/Edge)
│       ├── init_login.py      # Persistent profile login (SID cookie + DOM)
│       ├── worker.py          # Persistent worker: one context + chat/research pages
│       ├── chat_page.py       # Regular chat page: input, completion detection, reply extraction
│       ├── research_page.py   # Deep Research page: plan approval, report polling, text extraction
│       ├── selectors.py       # Shared selectors, login check, visibility, debug screenshots
│       └── run_research.py    # Legacy one-shot Deep Research script (oneshot fallback)
└── test/
    ├── acp-client.test.js     # ACP framing, handshake, permissions, stopReason, retry
    ├── classify.test.js       # Failure classification & delay parsing
    ├── gemini-models.test.js  # Model catalog normalization, validation & token matching
    ├── gemini-web.test.js     # Dual queues, routes, login state, job summaries
    ├── parallel.test.js       # Batch parallel task normalization & rendering
    ├── settings-ui.test.js    # Settings UI field table/groups/parsing/serialization/apply wiring
    ├── test_selectors.py      # Python completion-detection pure function tests
    ├── worker-client.test.js  # Worker protocol, crash restart, timeout, idle recycle
    └── wire.test.js           # NDJSON protocol parsing
```

### 6.1 Module Responsibilities

- `lib/wire.js`: Pure NDJSON frame parser (`AntigravityStream`). Line-splits frames, validates envelopes, picks final answer, maps terminal status, and collects error text.
- `lib/classify.js`: Pure-function failure classifier. `classifyFailure()` → `quota_exhausted` / `rate_limited` / `usage_error` / `unknown`; `parseRetryAfterMs()` parses retry-after / `Resets in XhYmZs`.
- `lib/client.js`: DSH client panels. Lazy-CJS (`window.__ModuleLoader__.load`) depending only on React; registers two `sidebar.panellist` entries (order 30 / 31) and two `main` keyed slots.
- `lib/gemini-web.js`: Host-side HTTP bridge. `createJobQueue` creates separate `research` / `chat` serial queues sharing one `GeminiWorkerClient`; serves `/models`, `/status`, `/chat/status`, `/login/init`, `/run`, `/chat/send`, `/chat/new`, `/chat/latest`, `/chat/job`, `/job`, `/latest`; registers `gemini_web_research`.
- `lib/gemini-models.js`: Static model/thinking catalog (including 4 Argon), `normalizeModelCatalog()`, `validateModel()` / `validateThinking()`, exact ID matching for model menu items.
- `lib/worker-client.js`: Persistent worker client. Lazy start, `ready` handshake, request ID correlation, progress forwarding, timeout cancellation, crash rejection, idle shutdown, `dispose()` tree kill; `health` exposes `{running, ready, pid, lastHeartbeatAt, lastError, stderrTail}`.
- `lib/parallel.js`: DSH-side batch concurrency tool.
- `scripts/gemini_research/worker.py`: Persistent Python worker holding one persistent context and `chat` / `research` pages over JSONL.
- `scripts/gemini_research/chat_page.py` / `research_page.py`: Page-level actions and completion detection.
- `scripts/gemini_research/selectors.py`: Candidate selectors, login checks, input submission, reply extraction, debug screenshots.
- `scripts/gemini_research/init_login.py`: Headed login script writing `login-ok.json`.
- `scripts/gemini_research/run_research.py`: Legacy one-shot Deep Research script for `oneshot` fallback.
- `scripts/gemini_research/browser.py`: `default_browser_channel()` / `browser_label()`.

### 6.2 HTTP API

Prefix: `/api/dsh-gemini-research`

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Combined status: login, worker, research / chat queues & jobs |
| GET | `/models?mode=chat\|research` | Model/thinking catalog (live fetch with static fallback) and configured defaults |
| GET | `/chat/status` | Chat panel status |
| POST | `/login/init` | Stops worker and launches `init_login.py` (409 if jobs are running) |
| POST | `/run` | Submits a Deep Research job with optional `model` / `thinking`; returns `{jobId}` |
| POST | `/chat/send` | Submits a chat message with optional `model` / `thinking`; returns `{jobId}` |
| POST | `/chat/new` | Clears current chat context (409 if a chat job is running) |
| GET | `/chat/latest` | Latest chat job and `conversationUrl` |
| GET | `/chat/job?id=` | Query a chat job |
| GET | `/job?id=` | Query a job (research or chat) |
| GET | `/latest` | Latest research job |

---

## 7. Verification & Testing

### 7.1 Unit Tests

```powershell
npm test
# or
node --test --test-isolation=none
```

Covers **99 test cases** across `wire.js`, `classify.js`, `gemini-web.js`, `gemini-models.js`, `worker-client.js`, `parallel.js`, `acp-client.js`, and `settings-ui.test.js`, plus Python pure-function tests for completion detection and model matching:

```powershell
python -m unittest test/test_selectors.py
```

> If `spawn EPERM` occurs inside a restricted DSH shell, use `node --test --test-isolation=none`.

### 7.2 Syntax Checks

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js; node --check lib/worker-client.js; node --check lib/parallel.js; node --check lib/acp-client.js
python -m py_compile scripts/gemini_research/browser.py scripts/gemini_research/init_login.py scripts/gemini_research/run_research.py scripts/gemini_research/worker.py scripts/gemini_research/chat_page.py scripts/gemini_research/research_page.py scripts/gemini_research/selectors.py
```

### 7.3 Quick Smoke Tests

```powershell
# NDJSON 7-byte chunk reassembly: expects completed + text
node -e "import('./lib/wire.js').then(({AntigravityStream})=>{const s=new AntigravityStream('t');const t=[JSON.stringify({event:'init',conversation_id:'c1'}),JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'par'}}),JSON.stringify({event:'result',result:{status:'SUCCESS',response:'partial answer'}})].join('\n')+'\n';for(let i=0;i<t.length;i+=7)s.push(t.slice(i,i+7));s.end();console.log(s.result(),s.conversationId)})"

# Failure classification: expects rate_limited / quota_exhausted / usage_error
node -e "import('./lib/classify.js').then(({classifyFailure})=>console.log(classifyFailure('429 too many requests',{exitCode:1}),classifyFailure('quota limit exceeded',{exitCode:1}),classifyFailure('x',{exitCode:2})))"
```

### 7.4 Manual E2E Checklist

1. Click **Initialize Login** → system default browser opens → sign in → panel shows verified login state.
2. Send a message in **Gemini Chat** → receive reply → follow up to verify multi-turn context.
3. Click **New Chat** → context resets.
4. Start Deep Research while sending a message in Gemini Chat → both succeed, confirming the dual queues do not block each other.
5. Close and reopen the GUI → worker restarts on demand, and session URL / login state recovers or re-verifies.

---

## 8. Known Limitations & Notes

1. **ToS & Risk Controls**: Google's Terms of Service prohibit automated access; web automation may trigger risk controls or account suspension. Use a dedicated account, keep frequency low, and do not run batch jobs on your primary account.
2. **Selector Drift**: Gemini Web UI updates may break selectors. All selectors live in `scripts/gemini_research/selectors.py`, and failures save `debug-*.png` in the profile directory; overall this is best-effort.
3. **Single Browser Instance**: Only one browser instance may use a given `geminiProfileDir` at a time. Chat and Research run concurrently via two pages in one persistent worker; do not launch separate browsers for them. Initializing login stops the worker first to release the profile.
4. **Dedicated Profile**: Cannot reuse your daily Edge/Chrome User Data directory due to the browser single-instance lock; sign in once in the dedicated profile on first use.
5. **Deep Research Quota**: Google AI Pro allows roughly 20 runs per day, each taking ~5–10 minutes.
6. **Signed-out Chat**: Regular chat works without signing in (without history); Deep Research requires login.
7. **No Follow-ups on One-shot Delegation**: `agy --print` exits upon completion and does not inherit parent session context; prompts must be self-contained.
8. **`--print-timeout` Semantics**: On timeout, `agy` returns partial output, logs a warning to stderr, and exits with 0; `printTimeout` is only a fallback cutoff and does not indicate full task completion.
9. **Windows Default Executable**: The default `executable` is Windows `agy.exe`; on Linux/macOS, specify the executable path explicitly in config.
10. **Model / Thinking Selection**: Menu items may vary by account or rollout; live catalog failures fall back to the static catalog, and applied options are reported via `modelApplied` / `thinkingApplied`. Whether Deep Research honors the selected model still awaits minimal E2E verification.
