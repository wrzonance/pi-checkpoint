# pi progress checkpoint — design

Date: 2026-10-05. Status: awaiting review.

## Purpose

When a pi session's context is nearly full, compaction clears most of it. pi-vcc builds its
summary by extraction, so it cannot record what the model was about to do next. This extension
makes the model write that down while it still has the full context, then restores it after the cut.

It augments pi-vcc; it does not replace it. pi-vcc (or pi's built-in compaction, if pi-vcc is
removed) still decides the cut and builds the summary.

## Decisions (agreed with Adam, 2026-10-05)

| Question | Decision |
|---|---|
| Session awareness | One progress file per pi session. A new session starts empty; a resumed session reuses its own file; old files are kept but never read. |
| Restore after compaction | The extension injects the file's contents into the context. |
| Relation to repo files (e.g. `AUDIT.md`) | Separate. The hidden file is working memory only; repo files are untouched. |
| Trigger | At 80% of the context window, then compact immediately after the save. |
| pi-vcc | Augment. Add this extension's instruction message type to pi-vcc's `skipCustomTypes`. |

## Behaviour

1. **Watch.** On every `turn_end`, read `ctx.getContextUsage()`. Do nothing when `percent` is null
   (unknown, e.g. right after a compaction).
2. **Threshold.** Effective threshold = the lower of the configured percent (default 80) and
   pi's own compaction trigger minus 5 points, where pi's trigger is
   `(contextWindow - reserveTokens) / contextWindow`. On a 32K model with `reserveTokens` 8192 pi
   compacts at 75%, so the checkpoint fires at 70%; on the 262K model it fires at 80%.
3. **Request.** On crossing the threshold, inject the instruction once as a steering message
   (`pi.sendMessage`, `deliverAs: "steer"`, `triggerTurn: true`, custom type
   `progress-checkpoint-request`): save progress now with `save_progress`, do not start new work.
4. **Save.** The model calls `save_progress({ content })`. The extension writes the file
   atomically (temp file + rename), overwriting any previous content. The model never supplies a path.
5. **Compact.** At the end of the turn in which the save happened, call `ctx.compact()`.
6. **No save.** If the turn after the request ends without a save, send one reminder. If the next
   turn also ends without a save, compact anyway and show a warning; an earlier save, if any, stays.
7. **Restore.** On `session_compact`, if the session's file exists, inject its contents
   (`pi.sendMessage`, custom type `progress-checkpoint`, displayed) under a line telling the model
   this is its own saved progress and to continue from it.
8. **Re-arm.** After a compaction the extension returns to watching; it fires at most once per fill.

The model may call `save_progress` at any time, not only when asked; a voluntary save does not
trigger compaction. Resuming a session does not inject the file: the session history is already there.

## Storage

- Path: `<dir>/<project>/<file>` with defaults `~/.pi/agent/checkpoints/`, the session's cwd
  encoded the way pi names its session folders (`--home-adam-github-SpecR--`), and `{session}.md`
  where `{session}` is `ctx.sessionManager.getSessionId()`.
- Directories are created with mode 700 and files with mode 600.
- Content is capped at `maxChars` (default 12,000, about 3,000 tokens). An over-long save is
  rejected with a tool error that states the limit, so the model shortens it; nothing is truncated silently.
- The checkpoints directory is not chezmoi-managed (added to `.chezmoiignore`, like pi's sessions).

## Settings

`~/.pi/agent/checkpoint.json` (chezmoi-managed, read-only to the extension; defaults apply when
the file or a key is missing, and an invalid value falls back to its default with one warning):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `thresholdPercent` | `80` | Context use at which the checkpoint is requested (1-99). |
| `compactAfterSave` | `true` | Compact as soon as the save turn ends. `false`: only save; pi compacts on its own schedule. |
| `dir` | `~/.pi/agent/checkpoints` | Root directory. |
| `file` | `{session}.md` | File name pattern; `{session}` is required so sessions never share a file. |
| `maxChars` | `12000` | Size cap for one save. |
| `instruction` | see below | Text of the save request. |

Default instruction: "Context is nearly full and will be cleared. Call `save_progress` now with:
Goal (one paragraph), Current state, Next action (the single next step), Decisions and dead ends.
Be specific: file paths, names, results. Do not start new work in this turn."

## Commands

- `/checkpoint` — ask the model to save now (same request as the automatic one, no compaction).
- `/checkpoint show` — print the file's path and contents.
- `/checkpoint off` / `/checkpoint on` — disable or re-enable for this session.

## Interaction with other extensions

- **pi-vcc:** unchanged. `progress-checkpoint-request` goes into its `skipCustomTypes` so the
  instruction boilerplate is left out of summaries. The restore message is ordinary session content.
- **pi-goal:** unchanged. Its continuation prompt resumes the run after compaction as it does today.
- **permission-gate:** `save_progress` is not a gated tool, so unattended runs do not stall.

## Structure

The code lives in the `pi-checkpoint` repository (decided 2026-10-05, after this spec was approved):

- `src/index.ts` — the extension: wiring only (events, tool, commands).
- `src/core.js` — the decisions as pure functions, no pi imports: effective threshold, the state
  machine (`watching → requested → reminded → saved → compacting`), project-folder encoding, path
  building, settings validation, the size check. Plain JavaScript so it runs under `node --test`.
- `test/core.test.js` — run with `node --test test/*.test.js`.
- `package.json` declares the extension (`"pi": { "extensions": ["./src/index.ts"] }`).
- `~/.pi/agent/checkpoint.json` stays in the home directory and is chezmoi-managed.

## Errors

- A failed write makes `save_progress` return a tool error naming the cause; the state stays
  `requested`, so the reminder and the compact-anyway path still apply.
- A missing or unreadable file at restore time is skipped with a warning; compaction is not blocked.
- A failed compaction (`session_compact_failed`) returns the extension to watching.
- Without a UI (`pi -p`) everything works except notifications.

## Testing

- Unit tests on `checkpoint-core.js`: threshold on 32K and 262K models, each state transition
  including reminder and compact-anyway, folder encoding, `{session}` enforcement, the size cap,
  settings fallbacks.
- One live run against Strata with `thresholdPercent` set low so it fires within a few turns:
  confirm the request, the save, the compaction, the restored content, and that a second session in
  the same folder starts with no file. Run only when Adam confirms Strata is idle.

## Out of scope

- Updating any repo file, importing a previous session's progress, per-model settings,
  and replacing pi-vcc's summary.
