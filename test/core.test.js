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
