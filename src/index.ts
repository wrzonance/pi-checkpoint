// pi extension -- save progress before the context is cleared.
//
// When context use passes a threshold the model is told to call save_progress;
// the text goes to a per-session file under ~/.pi/agent/checkpoints/<project>/
// and is put back into the context after the next compaction. A new session
// never reads another session's file.
//
// It adds the steps around compaction; pi-vcc (or pi itself) still does the
// cut. It never compacts a running agent: ctx.compact() aborts the run, and
// pi-goal blocks a goal whose run was aborted. Mid-run the cut is pi's own
// threshold compaction; only an idle agent is compacted from here. For a prompt
// cut on a large model, give it a per-model reserve in pi's settings.json
// (compaction.modelOverrides) so pi's trigger sits just above this threshold.
//
// Decisions live in ./core.js (tested with `node --test test/*.test.js`); this
// file is wiring only.
// Settings: ~/.pi/agent/checkpoint.json (read at session start, never written).
// Spec: docs/superpowers/specs/2026-10-05-pi-progress-checkpoint-design.md
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as coreModule from "./core.js";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(AGENT_DIR, "checkpoint.json");

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
  INITIAL_STATE: string;
  resolveSettings(raw: unknown): { settings: Settings; warnings: string[] };
  checkpointPath(args: { settings: Settings; cwd: string; sessionId: string; home: string }): string;
  effectiveThreshold(args: { thresholdPercent: number; contextWindow: number; reserveTokens: number }): number;
  sizeProblem(content: unknown, maxChars: number): string | undefined;
  reserveTokensFor(piSettings: unknown, modelKey: string): number;
  restoreMessage(saved: string): string;
  shouldDeferCompaction(args: { state: string; reason: string; deferrals: number }): boolean;
  directoryProblem(stats: { uid: number; mode: number }, ownUid: number): string | undefined;
  injectRestore(messages: unknown[], pending: string | undefined, now: number): { delivered: boolean; messages?: unknown[] };
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

const core = coreModule as unknown as Core;

// Write `content` to `path` so that nothing else can be made to receive it:
// the directory must be ours and closed to others, and the temporary file has
// an unpredictable name and is created exclusively (never through a symlink
// or onto a file someone left there), then renamed into place.
async function writePrivately(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownUid = process.getuid?.();
  if (ownUid !== undefined) {
    const problem = core.directoryProblem(await stat(directory), ownUid);
    if (problem) throw new Error(`${directory} is not safe to write to: ${problem}`);
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  let settings: Settings = { ...core.DEFAULTS };
  let state = core.INITIAL_STATE;
  let sessionEnabled = true;
  // What this process saved last. Restores prefer it to the file: the file is
  // only needed when pi was restarted since the save.
  let lastSaved: string | undefined;
  // The restore message that the session's own history does not carry yet.
  let pendingRestore: string | undefined;
  // How often pi's threshold compaction was put off for the current save request.
  let deferrals = 0;

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
    let saved = lastSaved;
    if (saved === undefined) {
      try {
        saved = await readFile(filePath(ctx), "utf8");
      } catch (error) {
        if (!isMissing(error)) notify(ctx, `could not read the saved progress: ${(error as Error).message}`, "warning");
        return;
      }
      // A file this process did not write gets the same limits as a save.
      const problem = core.sizeProblem(saved, settings.maxChars);
      if (problem) {
        notify(ctx, `saved progress on disk was not restored: ${problem}`, "warning");
        return;
      }
    }
    // Stored in the session so every later run sees it (a /goal continuation as
    // much as a typed prompt; "nextTurn" delivery would wait for a typed prompt).
    // During a run pi only appends it at the end of the next turn, so until the
    // session carries it the `context` handler below adds it to each request.
    pendingRestore = core.restoreMessage(saved);
    pi.sendMessage({ customType: core.RESTORE_TYPE, content: pendingRestore, display: true }, { triggerTurn: false });
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
      case "warn_tight":
        notify(
          ctx,
          "context is still above the checkpoint threshold right after a compaction; not asking again until it " +
            "drops (raise thresholdPercent, or let pi compact later)",
          "warning",
        );
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
    if (next.state !== "requested" && next.state !== "reminded") deferrals = 0;
    state = next.state;
    for (const action of next.actions) await perform(action, ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    state = core.INITIAL_STATE;
    sessionEnabled = true;
    lastSaved = undefined;
    pendingRestore = undefined;
    deferrals = 0;
    try {
      const resolved = core.resolveSettings(await readJson(SETTINGS_PATH));
      settings = resolved.settings;
      for (const warning of resolved.warnings) notify(ctx, warning, "warning");
    } catch (error) {
      settings = { ...core.DEFAULTS };
      notify(ctx, `${(error as Error).message}; using the defaults`, "warning");
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
          // pi's merged settings (global + project), the same ones its own trigger uses
          reserveTokens: core.reserveTokensFor(pi.getSettings(), `${ctx.model?.provider}/${ctx.model?.id}`),
        }),
        enabled: settings.enabled && sessionEnabled,
      },
      ctx,
    );
  });

  // The run is over and nothing else is queued: safe to compact without aborting anything.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    await dispatch(
      { type: "idle", compactAfterSave: settings.compactAfterSave, enabled: settings.enabled && sessionEnabled },
      ctx,
    );
  });

  // One tool result can pass both the checkpoint threshold and pi's own trigger;
  // pi would then compact before the model has answered the save request. Put
  // that compaction off (a bounded number of times) while a save is outstanding.
  pi.on("session_before_compact", async (event, ctx) => {
    if (!core.shouldDeferCompaction({ state, reason: event.reason, deferrals })) return undefined;
    deferrals += 1;
    notify(ctx, "compaction put off until the model has saved its progress");
    return { cancel: true };
  });

  pi.on("context", async (event) => {
    const result = core.injectRestore(event.messages, pendingRestore, Date.now());
    if (result.delivered) pendingRestore = undefined;
    return result.messages ? { messages: result.messages as typeof event.messages } : undefined;
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
      try {
        await writePrivately(path, params.content);
      } catch (error) {
        throw new Error(`could not save progress to ${path}: ${(error as Error).message}`, { cause: error });
      }
      lastSaved = params.content;
      await dispatch({ type: "saved" }, ctx);
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
        if (!sessionEnabled) await dispatch({ type: "disabled" }, ctx); // drop a pending request too
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
