// Decisions for the pi progress-checkpoint extension
// (src/index.ts), as pure functions with no
// pi imports so they run under plain `node --test`.
// Spec: docs/superpowers/specs/2026-10-05-pi-progress-checkpoint-design.md
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

// pi's reserve for one model ("provider/id"): its override in settings.json
// (compaction.modelOverrides), then the global value, then pi's default.
const PI_DEFAULT_RESERVE_TOKENS = 16384;
const isTokenCount = (v) => Number.isSafeInteger(v) && v >= 0;

export function reserveTokensFor(piSettings, modelKey) {
  const compaction = piSettings?.compaction ?? {};
  const override = compaction.modelOverrides?.[modelKey]?.reserveTokens;
  if (isTokenCount(override)) return override;
  return isTokenCount(compaction.reserveTokens) ? compaction.reserveTokens : PI_DEFAULT_RESERVE_TOKENS;
}

// watching -> requested -> (reminded ->) waiting -> (compacting ->) watching
//
// The extension asks for the save; it does not compact a running agent.
// ctx.compact() aborts the run, and pi-goal blocks a goal whose run was
// aborted, so mid-run the cut is left to pi's own threshold compaction (which
// does not abort). `waiting` is "done asking"; only when the agent goes idle
// does the extension compact by itself.
export const INITIAL_STATE = "watching";

function onTurnEnd(state, { percent, threshold, enabled }) {
  switch (state) {
    case "watching":
      return enabled && typeof percent === "number" && percent >= threshold
        ? { state: "requested", actions: ["request"] }
        : { state, actions: [] };
    case "requested":
      return { state: "reminded", actions: ["remind"] };
    case "reminded":
      return { state: "waiting", actions: ["warn_unsaved"] };
    default:
      return { state, actions: [] };
  }
}

export function step(state, event) {
  switch (event.type) {
    case "turn_end":
      return onTurnEnd(state, event);
    case "saved":
      return state === "requested" || state === "reminded" ? { state: "waiting", actions: [] } : { state, actions: [] };
    case "idle":
      return state === "waiting" && event.compactAfterSave
        ? { state: "compacting", actions: ["compact"] }
        : { state, actions: [] };
    case "compacted":
      return { state: "watching", actions: ["restore"] };
    case "compact_failed":
      return { state: "watching", actions: [] };
    default:
      return { state, actions: [] };
  }
}
