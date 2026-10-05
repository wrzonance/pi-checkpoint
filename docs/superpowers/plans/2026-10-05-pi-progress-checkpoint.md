# pi Progress Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pi extension that makes the model save its progress to a per-session file when context is nearly full, compacts, and restores that progress afterwards.

**Architecture:** All decisions (settings validation, paths, threshold, the request/remind/compact state machine) are pure functions in one plain-JavaScript module tested with `node --test`. A thin TypeScript extension wires those functions to pi's events, one tool (`save_progress`) and one command (`/checkpoint`). pi-vcc keeps doing the compaction itself.

**Tech Stack:** Node 26 (`node --test`, ES modules), pi 1.0.3 extension API (`@earendil-works/pi-coding-agent`), `typebox` (provided by pi to extensions), chezmoi for deployment.

**Spec:** `docs/superpowers/specs/2026-10-05-pi-progress-checkpoint-design.md`

## Amendment — 2026-10-05: the code lives in this repository

Adam moved the work into `~/github/pi-checkpoint` after the plan was written. Where a step below
still says otherwise, this section wins:

- **Layout:** `src/core.js` (pure decisions), `src/index.ts` (the extension), `test/core.test.js`,
  `package.json` with `"pi": { "extensions": ["./src/index.ts"] }`. All paths are relative to the repo root.
- **Imports:** `src/index.ts` imports `./core.js` statically. The `CORE_PATH` / `pathToFileURL`
  dynamic import in Task 3's listing is not used: inside a package pi loads only the declared
  extension, so the core can sit beside it.
- **Commits:** plain `git commit` in this repository on branch `feat/progress-checkpoint`. The
  `chezmoi add` / `dotfiles` commands apply only to the three files that stay in the home
  directory: `~/.pi/agent/checkpoint.json`, `~/.pi/agent/pi-vcc-config.json` and `.chezmoiignore`.
- **Loading pi with the extension:** `pi -e ~/github/pi-checkpoint/src/index.ts` (or the throwaway
  agent directories in Tasks 3 and 4, with the two source files copied in). Installing it into
  Adam's pi (`pi install`, which edits the fleet-synced `settings.json`) is NOT part of this plan:
  ask him first.

## Amendment 2 — 2026-10-05: no compaction of a running agent

Found in Task 3 (see the spec's *Revision* section): `ctx.compact()` aborts the run and pi-goal blocks an
aborted goal. Changes against the task listings below:

- State machine: `watching → requested → (reminded →) waiting → (compacting →) watching`. A save or an
  exhausted reminder leads to `waiting`; a new `idle` event (from `agent_settled`) is the only thing
  that produces the `compact` action. `saved`/`settled` states and `compactAfterSave` on `turn_end` are gone.
- New pure function `reserveTokensFor(piSettings, "provider/id")` (per-model override, global, default).
- Restore uses `pi.sendMessage(..., { triggerTurn: false })`, not `deliverAs: "nextTurn"`.
- New: `test/integration/` — a scripted fake model and `run.sh`, which run the real extension inside
  pi end to end without any model server.
- Task 3 Steps 1, 5, 6 (the files in the home directory) and installation are deferred until Adam
  decides how the extension is installed.

## Global Constraints

- Files: `src/core.js`, `test/core.test.js`, `src/index.ts`, `~/.pi/agent/checkpoint.json`.
- Progress file path: `<dir>/<project>/<file>`; defaults `~/.pi/agent/checkpoints`, project folder encoded like pi's session folders (`/home/adam/github/SpecR` → `--home-adam-github-SpecR--`), file `{session}.md`.
- Defaults: `enabled` true, `thresholdPercent` 80, `compactAfterSave` true, `maxChars` 12000.
- Effective threshold = min(configured percent, pi's trigger percent − 5), pi's trigger = `(contextWindow − reserveTokens) / contextWindow`.
- Directories mode 700, files mode 600. A save overwrites; nothing is appended or truncated silently.
- Message custom types: `progress-checkpoint-request` (the instruction), `progress-checkpoint` (the restore).
- The extension never writes `checkpoint.json` and never touches any file in the project.
- **Every edit to a chezmoi-managed file is followed by `chezmoi add`/`re-add` in the same command.** The auto-apply overwrites uncommitted edits within minutes (see memory `feedback-chezmoi-autoapply-clobbers-uncommitted-edits`).
- `the dotfiles repository` takes commits straight on `main`; end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Do not send requests to Strata (`model-host:8081`) or restart it without Adam confirming it is idle. Task 4 is the only task that uses it.

## Review Focus

1. Context usage unknown (`percent` null, right after a compaction): must not request a checkpoint or throw. → Task 2 test.
2. A `file` setting with a path separator or `..`, or without `{session}`: must fall back to the default, never write outside the checkpoint directory or share a file between sessions. → Task 1 test.
3. Empty or over-long `save_progress` content: rejected with a message stating the limit; the previous file is left intact. → Task 2 test (`sizeProblem`), Task 3 wiring throws before writing.
4. Compaction fails, or the model never saves: the extension returns to watching and fires again on the next fill, never stuck. → Task 2 tests.
5. Small-context models where pi compacts before 80%: the checkpoint still fires first. → Task 2 test.

---

### Task 1: Core module — settings and paths

**Files:**
- Create: `src/core.js`
- Test: `test/core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULTS` — frozen object with keys `enabled, thresholdPercent, compactAfterSave, dir, file, maxChars, instruction`.
  - `REQUEST_TYPE = "progress-checkpoint-request"`, `RESTORE_TYPE = "progress-checkpoint"`, `RESTORE_HEADER` (string).
  - `resolveSettings(raw: unknown): { settings: typeof DEFAULTS, warnings: string[] }`
  - `projectFolder(cwd: string): string`
  - `checkpointPath({ settings, cwd, sessionId, home }): string`

- [ ] **Step 1: Write the failing tests**

Create `test/core.test.js`:

```js
// node --test test/*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  REQUEST_TYPE,
  RESTORE_TYPE,
  resolveSettings,
  projectFolder,
  checkpointPath,
} from "../src/core.js";

test("defaults match the spec", () => {
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.thresholdPercent, 80);
  assert.equal(DEFAULTS.compactAfterSave, true);
  assert.equal(DEFAULTS.dir, "~/.pi/agent/checkpoints");
  assert.equal(DEFAULTS.file, "{session}.md");
  assert.equal(DEFAULTS.maxChars, 12000);
  assert.match(DEFAULTS.instruction, /save_progress/);
  assert.equal(REQUEST_TYPE, "progress-checkpoint-request");
  assert.equal(RESTORE_TYPE, "progress-checkpoint");
});

test("resolveSettings: missing file or keys give defaults without warnings", () => {
  assert.deepEqual(resolveSettings(undefined), { settings: { ...DEFAULTS }, warnings: [] });
  const { settings, warnings } = resolveSettings({ thresholdPercent: 60 });
  assert.equal(settings.thresholdPercent, 60);
  assert.equal(settings.maxChars, DEFAULTS.maxChars);
  assert.deepEqual(warnings, []);
});

test("resolveSettings: an invalid value falls back to its default with one warning each", () => {
  const { settings, warnings } = resolveSettings({ thresholdPercent: 150, enabled: "yes", maxChars: 10 });
  assert.equal(settings.thresholdPercent, 80);
  assert.equal(settings.enabled, true);
  assert.equal(settings.maxChars, 12000);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join("\n"), /thresholdPercent/);
});

test("resolveSettings: a file pattern that could leave the directory or share a file is refused", () => {
  for (const file of ["progress.md", "../{session}.md", "sub/{session}.md", "a\\{session}.md", "{session}/../../x"]) {
    const { settings, warnings } = resolveSettings({ file });
    assert.equal(settings.file, "{session}.md", file);
    assert.equal(warnings.length, 1, file);
  }
  assert.equal(resolveSettings({ file: "progress-{session}.md" }).settings.file, "progress-{session}.md");
});

test("resolveSettings: a non-object config gives defaults and says so", () => {
  for (const raw of [[], "x", 5]) {
    const { settings, warnings } = resolveSettings(raw);
    assert.deepEqual(settings, { ...DEFAULTS });
    assert.equal(warnings.length, 1);
  }
});

test("projectFolder encodes a cwd the way pi names its session folders", () => {
  assert.equal(projectFolder("/home/adam/github/SpecR"), "--home-adam-github-SpecR--");
  assert.equal(projectFolder("/home/adam"), "--home-adam--");
  assert.equal(projectFolder("/home/adam/"), "--home-adam--");
  assert.equal(projectFolder("/tmp/claude-1000/-home-adam/x"), "--tmp-claude-1000--home-adam-x--");
  assert.equal(projectFolder("/"), "----");
});

test("checkpointPath: one file per session under the project folder", () => {
  const args = { settings: DEFAULTS, cwd: "/home/adam/github/SpecR", home: "/home/adam" };
  const a = checkpointPath({ ...args, sessionId: "01a10d76-f372" });
  const b = checkpointPath({ ...args, sessionId: "02b20e87-0483" });
  assert.equal(a, "/home/adam/.pi/agent/checkpoints/--home-adam-github-SpecR--/01a10d76-f372.md");
  assert.notEqual(a, b);
});

test("checkpointPath: an absolute dir is used as is, and a hostile session id cannot add path parts", () => {
  const settings = { ...DEFAULTS, dir: "/var/tmp/cp" };
  const path = checkpointPath({ settings, cwd: "/p", sessionId: "../../etc/passwd", home: "/home/adam" });
  assert.equal(path, "/var/tmp/cp/--p--/.._.._etc_passwd.md");
  assert.ok(path.startsWith("/var/tmp/cp/--p--/"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/*.test.js 2>&1 | tail -6`
Expected: FAIL — `Cannot find module '.../lib/checkpoint-core.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/core.js`:

```js
// Decisions for the pi progress-checkpoint extension
// (src/index.ts), as pure functions with no
// pi imports so they run under plain `node --test`. This file lives outside
// extensions/ because pi loads every file there as an extension.
// Spec: ~/docs/superpowers/specs/2026-10-05-pi-progress-checkpoint-design.md
// Tests: node --test test/*.test.js
import { join } from "node:path";

export const REQUEST_TYPE = "progress-checkpoint-request";
export const RESTORE_TYPE = "progress-checkpoint";
export const RESTORE_HEADER =
  "This is the progress you saved before the context was cleared. " +
  "Continue from its Next action; do not redo completed work.";

export const DEFAULTS = Object.freeze({
  enabled: true,
  thresholdPercent: 80,
  compactAfterSave: true,
  dir: "~/.pi/agent/checkpoints",
  file: "{session}.md",
  maxChars: 12000,
  instruction:
    "Context is nearly full and will be cleared. Call save_progress now with: " +
    "Goal (one paragraph), Current state, Next action (the single next step), " +
    "Decisions and dead ends. Be specific: file paths, names, results. " +
    "Do not start new work in this turn.",
});

const isText = (v) => typeof v === "string" && v.trim() !== "";

// `file` must keep sessions apart ({session}) and stay inside the directory.
const VALID = Object.freeze({
  enabled: (v) => typeof v === "boolean",
  thresholdPercent: (v) => Number.isInteger(v) && v >= 1 && v <= 99,
  compactAfterSave: (v) => typeof v === "boolean",
  dir: isText,
  file: (v) => isText(v) && v.includes("{session}") && !/[\\/]/.test(v) && !v.includes(".."),
  maxChars: (v) => Number.isInteger(v) && v >= 500 && v <= 200000,
  instruction: isText,
});

// Parsed checkpoint.json (or undefined when there is none) -> usable settings.
export function resolveSettings(raw) {
  const settings = { ...DEFAULTS };
  if (raw === undefined || raw === null) return { settings, warnings: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings, warnings: ["checkpoint.json is not a JSON object; using the defaults"] };
  }
  const warnings = [];
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw)) continue;
    if (VALID[key](raw[key])) settings[key] = raw[key];
    else warnings.push(`checkpoint.json: invalid "${key}"; using the default`);
  }
  return { settings, warnings };
}

// pi's own session-folder naming: /home/adam/x -> --home-adam-x--
export function projectFolder(cwd) {
  const inner = String(cwd).replace(/^[\\/]+/, "").replace(/[\\/]+$/, "").replace(/[\\/:]/g, "-");
  return `--${inner}--`;
}

export function checkpointPath({ settings, cwd, sessionId, home }) {
  const session = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  const root = settings.dir.startsWith("~/") ? join(home, settings.dir.slice(2)) : settings.dir;
  return join(root, projectFolder(cwd), settings.file.replaceAll("{session}", session));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/*.test.js 2>&1 | grep -E '^(✖|ℹ (pass|fail))'`
Expected: `ℹ pass 8`, `ℹ fail 0`.

- [ ] **Step 5: Commit (in the same command as nothing else — the files are new)**

```bash
cd ~ && chezmoi add .pi/agent/lib/checkpoint-core.js .pi/agent/tests/checkpoint-core.test.js \
  && cd ~/.local/share/chezmoi && git add private_dot_pi && git commit -q -m "feat(pi): checkpoint core — settings and per-session paths

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push -q && git log --oneline -1
```

---

### Task 2: Core module — threshold, size check and the state machine

**Files:**
- Modify: `src/core.js` (append)
- Test: `test/core.test.js` (append)

**Interfaces:**
- Consumes: `DEFAULTS` from Task 1.
- Produces:
  - `effectiveThreshold({ thresholdPercent, contextWindow, reserveTokens }): number`
  - `sizeProblem(content: unknown, maxChars: number): string | undefined` — the reason a save is refused, or `undefined`.
  - `INITIAL_STATE = "watching"`
  - `step(state: string, event: object): { state: string, actions: string[] }`
    - states: `watching`, `requested`, `reminded`, `saved`, `compacting`, `settled`
    - events: `{ type: "turn_end", percent: number|null, threshold: number, enabled: boolean, compactAfterSave: boolean }`, `{ type: "saved" }`, `{ type: "compacted" }`, `{ type: "compact_failed" }`
    - actions: `request`, `remind`, `warn_unsaved`, `compact`, `restore`

- [ ] **Step 1: Write the failing tests**

Append to `test/core.test.js`, and extend the import list at the top with `effectiveThreshold, sizeProblem, INITIAL_STATE, step`:

```js
const turn = (percent, extra = {}) => ({ type: "turn_end", percent, threshold: 80, enabled: true, compactAfterSave: true, ...extra });

test("effectiveThreshold: the configured percent on a large window, below pi's own trigger on a small one", () => {
  assert.equal(effectiveThreshold({ thresholdPercent: 80, contextWindow: 262144, reserveTokens: 8192 }), 80);
  // 32K model: pi compacts at (32768-8192)/32768 = 75%, so the checkpoint must fire at 70%
  assert.equal(effectiveThreshold({ thresholdPercent: 80, contextWindow: 32768, reserveTokens: 8192 }), 70);
  assert.equal(effectiveThreshold({ thresholdPercent: 50, contextWindow: 32768, reserveTokens: 8192 }), 50);
  assert.equal(effectiveThreshold({ thresholdPercent: 80, contextWindow: 0, reserveTokens: 8192 }), 80);
  assert.equal(effectiveThreshold({ thresholdPercent: 80, contextWindow: 8192, reserveTokens: 8192 }), 1);
});

test("sizeProblem: empty and over-long content are refused with the limit stated", () => {
  assert.equal(sizeProblem("Goal: x", 100), undefined);
  assert.equal(sizeProblem("x".repeat(100), 100), undefined);
  assert.match(sizeProblem("x".repeat(101), 100), /101 characters.*limit is 100/);
  assert.match(sizeProblem("   ", 100), /empty/);
  assert.match(sizeProblem(undefined, 100), /empty/);
});

test("step: watching does nothing below the threshold, when usage is unknown, or when disabled", () => {
  assert.equal(INITIAL_STATE, "watching");
  assert.deepEqual(step("watching", turn(79)), { state: "watching", actions: [] });
  assert.deepEqual(step("watching", turn(null)), { state: "watching", actions: [] });
  assert.deepEqual(step("watching", turn(95, { enabled: false })), { state: "watching", actions: [] });
});

test("step: crossing the threshold requests a save once", () => {
  assert.deepEqual(step("watching", turn(80)), { state: "requested", actions: ["request"] });
});

test("step: a save after the request leads to compaction at the end of that turn", () => {
  assert.deepEqual(step("requested", { type: "saved" }), { state: "saved", actions: [] });
  assert.deepEqual(step("saved", turn(85)), { state: "compacting", actions: ["compact"] });
  assert.deepEqual(step("compacting", turn(85)), { state: "compacting", actions: [] });
});

test("step: no save -> one reminder -> compact anyway with a warning", () => {
  assert.deepEqual(step("requested", turn(85)), { state: "reminded", actions: ["remind"] });
  assert.deepEqual(step("reminded", { type: "saved" }), { state: "saved", actions: [] });
  assert.deepEqual(step("reminded", turn(88)), { state: "compacting", actions: ["warn_unsaved", "compact"] });
});

test("step: with compactAfterSave off it settles instead of compacting", () => {
  const off = { compactAfterSave: false };
  assert.deepEqual(step("saved", turn(85, off)), { state: "settled", actions: [] });
  assert.deepEqual(step("reminded", turn(85, off)), { state: "settled", actions: ["warn_unsaved"] });
  assert.deepEqual(step("settled", turn(99, off)), { state: "settled", actions: [] });
});

test("step: a voluntary save while watching changes nothing", () => {
  assert.deepEqual(step("watching", { type: "saved" }), { state: "watching", actions: [] });
});

test("step: any compaction restores and re-arms; a failed one re-arms without restoring", () => {
  for (const state of ["watching", "requested", "reminded", "saved", "compacting", "settled"]) {
    assert.deepEqual(step(state, { type: "compacted" }), { state: "watching", actions: ["restore"] }, state);
    assert.deepEqual(step(state, { type: "compact_failed" }), { state: "watching", actions: [] }, state);
  }
});

test("step: an unknown event leaves the state alone", () => {
  assert.deepEqual(step("requested", { type: "nonsense" }), { state: "requested", actions: [] });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/*.test.js 2>&1 | tail -6`
Expected: FAIL — `does not provide an export named 'INITIAL_STATE'` (or `effectiveThreshold`).

- [ ] **Step 3: Write the implementation**

Append to `src/core.js`:

```js
// pi compacts at (contextWindow - reserveTokens); the checkpoint must come
// first, so it fires at least this many points below that.
const PI_TRIGGER_MARGIN = 5;

export function effectiveThreshold({ thresholdPercent, contextWindow, reserveTokens }) {
  if (!(contextWindow > 0)) return thresholdPercent;
  const piTrigger = ((contextWindow - reserveTokens) / contextWindow) * 100;
  return Math.max(1, Math.min(thresholdPercent, Math.floor(piTrigger - PI_TRIGGER_MARGIN)));
}

// Why a save is refused, or undefined when it is fine. Nothing is trimmed:
// the model is told the limit and shortens the text itself.
export function sizeProblem(content, maxChars) {
  if (typeof content !== "string" || content.trim() === "") {
    return "content is empty: write the progress to save";
  }
  if (content.length > maxChars) {
    return `content is ${content.length} characters; the limit is ${maxChars}. Shorten it and call save_progress again`;
  }
  return undefined;
}

// watching -> requested -> (reminded ->) saved -> compacting -> watching
// `settled` replaces `compacting` when compactAfterSave is off: the request is
// done and pi compacts on its own schedule.
export const INITIAL_STATE = "watching";

function onTurnEnd(state, { percent, threshold, enabled, compactAfterSave }) {
  const finish = (actions) =>
    compactAfterSave ? { state: "compacting", actions: [...actions, "compact"] } : { state: "settled", actions };
  switch (state) {
    case "watching":
      return enabled && typeof percent === "number" && percent >= threshold
        ? { state: "requested", actions: ["request"] }
        : { state, actions: [] };
    case "requested":
      return { state: "reminded", actions: ["remind"] };
    case "reminded":
      return finish(["warn_unsaved"]);
    case "saved":
      return finish([]);
    default:
      return { state, actions: [] };
  }
}

export function step(state, event) {
  switch (event.type) {
    case "turn_end":
      return onTurnEnd(state, event);
    case "saved":
      return state === "requested" || state === "reminded" ? { state: "saved", actions: [] } : { state, actions: [] };
    case "compacted":
      return { state: "watching", actions: ["restore"] };
    case "compact_failed":
      return { state: "watching", actions: [] };
    default:
      return { state, actions: [] };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/*.test.js 2>&1 | grep -E '^(✖|ℹ (pass|fail))'`
Expected: `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 5: Commit, re-adding in the same command as the check that the edit is still on disk**

```bash
grep -c 'export function step' src/core.js \
  && cd ~ && chezmoi re-add .pi/agent/lib/checkpoint-core.js .pi/agent/tests/checkpoint-core.test.js \
  && cd ~/.local/share/chezmoi && git add private_dot_pi && git commit -q -m "feat(pi): checkpoint core — threshold, size check, state machine

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push -q && git log --oneline -1 \
  && grep -c 'export function step' private_dot_pi/private_agent/lib/checkpoint-core.js
```

Expected: both `grep -c` lines print `1`.

---

### Task 3: The extension, its settings file, and the pi-vcc setting

**Files:**
- Create: `src/index.ts`
- Create: `~/.pi/agent/checkpoint.json`
- Modify: `~/.pi/agent/pi-vcc-config.json` (`skipCustomTypes`)
- Modify: `~/.local/share/chezmoi/.chezmoiignore` (ignore the checkpoints directory)

**Interfaces:**
- Consumes (from `src/core.js`): `DEFAULTS`, `REQUEST_TYPE`, `RESTORE_TYPE`, `RESTORE_HEADER`, `INITIAL_STATE`, `resolveSettings(raw)`, `checkpointPath({settings, cwd, sessionId, home})`, `effectiveThreshold({thresholdPercent, contextWindow, reserveTokens})`, `sizeProblem(content, maxChars)`, `step(state, event)`.
- Consumes (pi 1.0.3): `pi.on("session_start" | "turn_end" | "session_compact" | "session_compact_failed", handler(event, ctx))`, `ctx.getContextUsage(): { tokens, contextWindow, percent } | undefined`, `ctx.compact({ onError })`, `ctx.sessionManager.getSessionId()`, `ctx.sessionManager.getCwd()`, `pi.sendMessage({ customType, content, display }, { triggerTurn, deliverAs })`, `pi.registerTool({...})`, `pi.registerCommand(name, { description, handler(args, ctx) })`.
- Produces: tool `save_progress({ content: string })`, command `/checkpoint [show|on|off]`.

- [ ] **Step 1: Write the settings file with the defaults spelled out, and add it to chezmoi in the same command**

```bash
cat > ~/.pi/agent/checkpoint.json <<'EOF'
{
  "enabled": true,
  "thresholdPercent": 80,
  "compactAfterSave": true,
  "dir": "~/.pi/agent/checkpoints",
  "file": "{session}.md",
  "maxChars": 12000
}
EOF
python3 -m json.tool ~/.pi/agent/checkpoint.json >/dev/null && cd ~ && chezmoi add .pi/agent/checkpoint.json && echo added
```

Expected: `added`. (`instruction` is left out on purpose: the default text lives in the core.)

- [ ] **Step 2: Write the extension**

Create `src/index.ts`:

```ts
// pi extension -- save progress before the context is cleared.
//
// When context use passes a threshold the model is told to call save_progress;
// the text goes to a per-session file under ~/.pi/agent/checkpoints/<project>/,
// compaction is triggered, and the saved text is put back into the context
// afterwards. It adds the steps around compaction; pi-vcc (or pi itself) still
// does the cut. A new session never reads another session's file.
//
// Decisions live in src/core.js (tested with
// `node --test test/*.test.js`); this file is wiring only.
// Settings: ~/.pi/agent/checkpoint.json (read at session start, never written).
// Spec: ~/docs/superpowers/specs/2026-10-05-pi-progress-checkpoint-design.md
//
// Install: ~/.pi/agent/extensions/ (auto-discovered, chezmoi-tracked).
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CORE_PATH = join(AGENT_DIR, "lib", "checkpoint-core.js");
const SETTINGS_PATH = join(AGENT_DIR, "checkpoint.json");
const PI_SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const PI_DEFAULT_RESERVE_TOKENS = 16384;

type Settings = {
  enabled: boolean;
  thresholdPercent: number;
  compactAfterSave: boolean;
  dir: string;
  file: string;
  maxChars: number;
  instruction: string;
};
type Step = { state: string; actions: string[] };
type Core = {
  DEFAULTS: Settings;
  REQUEST_TYPE: string;
  RESTORE_TYPE: string;
  RESTORE_HEADER: string;
  INITIAL_STATE: string;
  resolveSettings(raw: unknown): { settings: Settings; warnings: string[] };
  checkpointPath(args: { settings: Settings; cwd: string; sessionId: string; home: string }): string;
  effectiveThreshold(args: { thresholdPercent: number; contextWindow: number; reserveTokens: number }): number;
  sizeProblem(content: unknown, maxChars: number): string | undefined;
  step(state: string, event: Record<string, unknown>): Step;
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

// Parsed JSON, undefined when the file does not exist; a broken file throws.
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
  }
}

export default async function (pi: ExtensionAPI) {
  const core = (await import(pathToFileURL(CORE_PATH).href)) as Core;
  let settings: Settings = { ...core.DEFAULTS };
  let reserveTokens = PI_DEFAULT_RESERVE_TOKENS;
  let state = core.INITIAL_STATE;
  let sessionEnabled = true;

  const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(`checkpoint: ${text}`, level);
  };

  const filePath = (ctx: ExtensionContext) =>
    core.checkpointPath({
      settings,
      cwd: ctx.sessionManager.getCwd(),
      sessionId: ctx.sessionManager.getSessionId(),
      home: homedir(),
    });

  const askToSave = (text: string) =>
    pi.sendMessage({ customType: core.REQUEST_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "steer" });

  const restore = async (ctx: ExtensionContext) => {
    let saved: string;
    try {
      saved = await readFile(filePath(ctx), "utf8");
    } catch (error) {
      if (!isMissing(error)) notify(ctx, `could not read the saved progress: ${(error as Error).message}`, "warning");
      return;
    }
    pi.sendMessage(
      { customType: core.RESTORE_TYPE, content: `${core.RESTORE_HEADER}\n\n${saved}`, display: true },
      { deliverAs: "nextTurn" },
    );
  };

  const perform = async (action: string, ctx: ExtensionContext) => {
    switch (action) {
      case "request":
        askToSave(settings.instruction);
        notify(ctx, "context is nearly full; asked the model to save its progress");
        break;
      case "remind":
        askToSave(`Progress is not saved yet. ${settings.instruction}`);
        break;
      case "warn_unsaved":
        notify(ctx, "the model did not save its progress; any earlier save is kept", "warning");
        break;
      case "compact":
        ctx.compact({
          onError: (error) => {
            state = core.step(state, { type: "compact_failed" }).state;
            notify(ctx, `compaction failed: ${error.message}`, "error");
          },
        });
        break;
      case "restore":
        await restore(ctx);
        break;
    }
  };

  const dispatch = async (event: Record<string, unknown>, ctx: ExtensionContext) => {
    const next = core.step(state, event);
    state = next.state;
    for (const action of next.actions) await perform(action, ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    state = core.INITIAL_STATE;
    sessionEnabled = true;
    try {
      const resolved = core.resolveSettings(await readJson(SETTINGS_PATH));
      settings = resolved.settings;
      for (const warning of resolved.warnings) notify(ctx, warning, "warning");
    } catch (error) {
      settings = { ...core.DEFAULTS };
      notify(ctx, `${(error as Error).message}; using the defaults`, "warning");
    }
    try {
      const piSettings = (await readJson(PI_SETTINGS_PATH)) as { compaction?: { reserveTokens?: unknown } } | undefined;
      const value = piSettings?.compaction?.reserveTokens;
      reserveTokens = Number.isInteger(value) && (value as number) >= 0 ? (value as number) : PI_DEFAULT_RESERVE_TOKENS;
    } catch {
      reserveTokens = PI_DEFAULT_RESERVE_TOKENS;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    await dispatch(
      {
        type: "turn_end",
        percent: usage?.percent ?? null,
        threshold: core.effectiveThreshold({
          thresholdPercent: settings.thresholdPercent,
          contextWindow: usage?.contextWindow ?? 0,
          reserveTokens,
        }),
        enabled: settings.enabled && sessionEnabled,
        compactAfterSave: settings.compactAfterSave,
      },
      ctx,
    );
  });

  pi.on("session_compact", async (_event, ctx) => dispatch({ type: "compacted" }, ctx));
  pi.on("session_compact_failed", async (_event, ctx) => dispatch({ type: "compact_failed" }, ctx));

  pi.registerTool({
    name: "save_progress",
    label: "Save progress",
    description:
      "Save your working progress for this session so it survives the context being cleared. " +
      "Each call replaces what was saved before. Write: Goal, Current state, Next action, " +
      "Decisions and dead ends. The saved text is given back to you after the context is cleared.",
    promptSnippet: "save_progress: save Goal / Current state / Next action / Decisions when asked, or before a risky step.",
    parameters: Type.Object({
      content: Type.String({ description: "The full progress note, in Markdown. Replaces the previous note." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const problem = core.sizeProblem(params.content, settings.maxChars);
      if (problem) throw new Error(problem);
      const path = filePath(ctx);
      const temporary = `${path}.tmp-${process.pid}`;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, params.content, { mode: 0o600 });
        await rename(temporary, path);
      } catch (error) {
        throw new Error(`could not save progress to ${path}: ${(error as Error).message}`, { cause: error });
      }
      state = core.step(state, { type: "saved" }).state;
      return {
        content: [{ type: "text", text: `Progress saved (${params.content.length} characters).` }],
        details: { path },
      };
    },
  });

  pi.registerCommand("checkpoint", {
    description: "Progress checkpoint: no argument = ask the model to save now; show | on | off",
    handler: async (args, ctx) => {
      const argument = (args ?? "").trim();
      if (argument === "off" || argument === "on") {
        sessionEnabled = argument === "on";
        notify(ctx, `automatic checkpoint ${sessionEnabled ? "on" : "off"} for this session`);
        return;
      }
      if (argument === "show") {
        const path = filePath(ctx);
        try {
          notify(ctx, `${path}\n\n${await readFile(path, "utf8")}`);
        } catch (error) {
          notify(ctx, isMissing(error) ? `nothing saved yet for this session (${path})` : `${path}: ${(error as Error).message}`, "warning");
        }
        return;
      }
      if (argument !== "") {
        notify(ctx, "usage: /checkpoint [show|on|off]", "warning");
        return;
      }
      askToSave(settings.instruction);
    },
  });
}
```

- [ ] **Step 3: Add the extension to chezmoi immediately, then check pi loads it**

```bash
cd ~ && chezmoi add .pi/agent/extensions/progress-checkpoint.ts && cd /tmp \
  && printf '{"type":"get_commands","id":"1"}\n' | timeout 30 pi --mode rpc --no-session 2>/tmp/pi-checkpoint.err \
     | grep -o '"name":"checkpoint"' | head -1; head -5 /tmp/pi-checkpoint.err
```

Expected: `"name":"checkpoint"` and an empty error file. If pi reports it cannot resolve `typebox`, replace the `Type.Object(...)` parameters with the equivalent plain schema and drop the import, then re-run this step:

```ts
    parameters: {
      type: "object",
      properties: { content: { type: "string", description: "The full progress note, in Markdown. Replaces the previous note." } },
      required: ["content"],
      additionalProperties: false,
    } as never,
```

- [ ] **Step 4: Check the tool reaches the model and writes the right file, without Strata**

This uses a throwaway agent directory and a local probe that records what pi sends, so no model server is touched:

```bash
rm -rf /tmp/pi-cp && mkdir -p /tmp/pi-cp/lib /tmp/pi-cp/extensions \
  && command cp src/core.js /tmp/pi-cp/lib/ \
  && command cp src/index.ts /tmp/pi-cp/extensions/ \
  && python3 - <<'EOF'
import json
json.dump({"providers": {"probe": {"baseUrl": "http://127.0.0.1:18099/v1", "api": "openai-completions", "apiKey": "x",
  "models": [{"id": "m", "name": "m", "reasoning": False, "input": ["text"], "contextWindow": 32768, "maxTokens": 1024,
              "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}, open("/tmp/pi-cp/models.json", "w"))
EOF
cat > /tmp/pi-cp/probe.py <<'EOF'
"""One-off: record the tool names pi offers, then refuse the request."""
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        names = sorted(t["function"]["name"] for t in body.get("tools", []))
        open("/tmp/pi-cp/tools.json", "w").write(json.dumps(names))
        self.send_response(400); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 18099), H).serve_forever()
EOF
python3 /tmp/pi-cp/probe.py & PROBE=$!
until timeout 1 bash -c '</dev/tcp/127.0.0.1/18099' 2>/dev/null; do :; done
cd /tmp && PI_CODING_AGENT_DIR=/tmp/pi-cp timeout 40 pi -p --no-session --provider probe --model m "hi" </dev/null >/dev/null 2>&1
kill $PROBE; cat /tmp/pi-cp/tools.json
```

Expected: the printed list contains `"save_progress"`.

- [ ] **Step 5: Tell pi-vcc to leave the instruction out of its summaries, and track that file**

```bash
python3 - <<'EOF' && cd ~ && chezmoi add .pi/agent/pi-vcc-config.json && echo added
import json, pathlib
p = pathlib.Path.home() / ".pi/agent/pi-vcc-config.json"
c = json.loads(p.read_text())
skip = c.setdefault("skipCustomTypes", [])
if "progress-checkpoint-request" not in skip:
    skip.append("progress-checkpoint-request")
p.write_text(json.dumps(c, indent=2) + "\n")
print(c["skipCustomTypes"])
EOF
```

Expected: `['progress-checkpoint-request']` then `added`.

- [ ] **Step 6: Keep the progress files out of chezmoi**

In `~/.local/share/chezmoi/.chezmoiignore`, directly below the existing line `.pi/agent/sessions`, add:

```
.pi/agent/checkpoints
```

Verify: `grep -n -A1 '^\.pi/agent/sessions$' ~/.local/share/chezmoi/.chezmoiignore` shows the new line.

- [ ] **Step 7: Run all checks, then commit**

```bash
node --test test/*.test.js 2>&1 | grep -E '^ℹ (pass|fail)' \
  && cd ~ && chezmoi verify .pi/agent/extensions/progress-checkpoint.ts .pi/agent/checkpoint.json .pi/agent/lib .pi/agent/tests .pi/agent/pi-vcc-config.json \
  && cd ~/.local/share/chezmoi && git add .chezmoiignore private_dot_pi && git commit -q -m "feat(pi): progress-checkpoint extension

Asks the model to save its progress to a per-session file when context is
nearly full, compacts, and restores the saved text afterwards. pi-vcc still
does the cut and now skips the instruction message in its summaries.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push -q && git log --oneline -1
```

Expected: `ℹ pass 18`, `ℹ fail 0`, `chezmoi verify` silent, and a new commit id.

---

### Task 4: Live verification against Strata (needs Adam's go-ahead)

**Files:**
- Modify (temporarily): `~/.pi/agent/checkpoint.json`
- Modify: `~/.claude/projects/-home-adam/memory/strata-orca-model-host.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3, a running Strata (`llm status` shows `strata: UP`), and Adam's confirmation that no task of his is using it.
- Produces: observed evidence that request → save → compaction → restore works, and that sessions do not share a file.

- [ ] **Step 1: Confirm Strata is idle and Adam has said to go ahead**

Run: `llm status | sed -n 1,4p`. Do not continue while his pi session is working. This task sends real requests and resets Strata's single prompt cache.

- [ ] **Step 2: Lower the threshold for the test, in a throwaway agent directory (the real config is not touched)**

```bash
rm -rf /tmp/pi-live && mkdir -p /tmp/pi-live/lib /tmp/pi-live/extensions \
  && command cp src/core.js /tmp/pi-live/lib/ \
  && command cp src/index.ts /tmp/pi-live/extensions/ \
  && command cp ~/.pi/agent/models.json /tmp/pi-live/ \
  && printf '{"thresholdPercent": 2, "dir": "/tmp/pi-live/checkpoints"}\n' > /tmp/pi-live/checkpoint.json \
  && mkdir -p /tmp/pi-live-project && echo "notes" > /tmp/pi-live-project/README.md
```

2% of the 262K window is about 5,200 tokens, which a few tool turns exceed. Only this extension is copied: the permission gate would wait for an answer nobody gives in RPC mode, and pi-vcc is a package this throwaway directory does not have, so pi's built-in compaction does the cut here. That means the live run does not exercise pi-vcc's cut or its `skipCustomTypes` setting; say so in the report.

- [ ] **Step 3: Run a short task in RPC mode and capture the events**

```bash
cd /tmp/pi-live-project && (printf '{"type":"prompt","id":"p1","message":"Read README.md, then list the files in /usr/share/doc (first 200 names), then summarise in one sentence. Use tools."}\n'; sleep 240) \
  | PI_CODING_AGENT_DIR=/tmp/pi-live timeout 250 pi --mode rpc --provider strata --model strata-orca --thinking off > /tmp/pi-live/events.jsonl 2>/tmp/pi-live/err.txt
python3 - <<'EOF'
import json
seen = []
for line in open("/tmp/pi-live/events.jsonl"):
    try: e = json.loads(line)
    except Exception: continue
    s = json.dumps(e)
    for marker in ("progress-checkpoint-request", "save_progress", "session_compact", "compaction", '"progress-checkpoint"'):
        if marker in s and marker not in seen: seen.append(marker)
print("observed, in order:", seen)
EOF
ls -la /tmp/pi-live/checkpoints/*/ && cat /tmp/pi-live/checkpoints/*/*.md | head -30
```

Expected: the request, a `save_progress` call, a compaction, and the restore message appear in that order; exactly one `.md` file exists, mode `-rw-------`, containing Goal / Current state / Next action text.

- [ ] **Step 4: Confirm a second session in the same folder starts empty**

```bash
cd /tmp/pi-live-project && (printf '{"type":"prompt","id":"p1","message":"Reply with exactly: second session"}\n'; sleep 60) \
  | PI_CODING_AGENT_DIR=/tmp/pi-live timeout 70 pi --mode rpc --provider strata --model strata-orca --thinking off > /tmp/pi-live/events2.jsonl 2>/dev/null
grep -c '"progress-checkpoint"' /tmp/pi-live/events2.jsonl; ls /tmp/pi-live/checkpoints/*/ | wc -l
```

Expected: `0` (nothing restored into the new session) and still `1` file (the new session wrote none and did not touch the first).

- [ ] **Step 5: Record the result in memory, re-adding in the same command**

Add one bullet to `~/.claude/projects/-home-adam/memory/strata-orca-model-host.md` under the pi extensions entry, stating the date, what was observed in Steps 3–4, and anything that had to change, then:

```bash
cd ~ && chezmoi re-add .claude/projects/-home-adam/memory/strata-orca-model-host.md \
  && cd ~/.local/share/chezmoi && git add private_dot_claude && git commit -q -m "memory: progress-checkpoint extension verified live

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push -q && git log --oneline -1
```

- [ ] **Step 6: Report to Adam**

State what was observed, what was not (the reminder and compact-anyway paths are covered by unit tests only unless they happened to occur), and that his real `checkpoint.json` still has the 80% threshold: `python3 -c 'import json; print(json.load(open("/home/adam/.pi/agent/checkpoint.json"))["thresholdPercent"])'` → `80`.
