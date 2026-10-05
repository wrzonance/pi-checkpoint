# pi-checkpoint

A [pi](https://pi.dev) extension. When a session's context is nearly full it asks the model to save
its progress with a `save_progress` tool, writes that to a per-session file, and puts it back into the
context after the next compaction. It works beside pi-vcc or pi's built-in compaction; it does not
replace either.

- Progress files: `~/.pi/agent/checkpoints/<project folder>/<session id>.md`. One per session, so a
  new session in the same folder never inherits an old one's progress.
- Settings: `~/.pi/agent/checkpoint.json` (`enabled`, `thresholdPercent`, `compactAfterSave`, `dir`,
  `file`, `maxChars`, `instruction`). Missing keys use the defaults in `src/core.js`.
- Commands: `/checkpoint` (ask the model to save now), `/checkpoint show`, `/checkpoint on|off`.

It never compacts a running agent, because that aborts the run. Mid-run the cut is pi's own threshold
compaction; set a per-model `compaction.modelOverrides` reserve in pi's `settings.json` if you want
that to follow the save closely on a large-context model.

## Try it

```sh
pi -e /path/to/pi-checkpoint/src/index.ts
```

## Tests

```sh
npm test                    # unit tests for the decision logic
npm run test:integration    # the real extension inside pi, against a scripted fake model
```

Design and plan: `docs/superpowers/`.
