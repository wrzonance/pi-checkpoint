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
