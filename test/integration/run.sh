#!/usr/bin/env bash
# Integration test: the real extension inside a real pi, against a scripted
# fake model (fake_model.py). No model server is needed and nothing outside a
# temporary directory is written.
#
# Session 1, the idle path: context passes the threshold -> the model is asked
# to save -> save_progress writes the per-session file -> once the agent is
# idle, compaction runs -> the saved text is in what the model is given next.
# Session 2: a new session in the same folder gets nothing.
# Session 3, the mid-run path (what a /goal loop hits): one tool result passes
# both the checkpoint threshold and pi's own trigger. pi's compaction must wait
# for the save, and the first response after it must already see the note.
#
# Usage: test/integration/run.sh      (exit 0 = all checks passed)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/pi-checkpoint-it.XXXXXX)"
PORT=18097
AGENT="$WORK/agent"
PROJECT="$WORK/project"
failures=0

check() { # description, command...
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $what"; else echo "  FAIL $what"; failures=$((failures + 1)); fi
}

mkdir -p "$AGENT" "$PROJECT"
# 32768-token window, pi's default reserve of 16384: pi itself compacts at 50%,
# so the checkpoint threshold is 45%. The fake model reports 16000 prompt tokens
# (48.8%): past the checkpoint threshold, below pi's own trigger.
cat > "$AGENT/models.json" <<EOF
{"providers": {"fake": {"baseUrl": "http://127.0.0.1:$PORT/v1", "api": "openai-completions", "apiKey": "x",
  "models": [{"id": "m", "name": "m", "reasoning": false, "input": ["text"], "contextWindow": 32768, "maxTokens": 1024,
              "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}
EOF
printf '{"dir": "%s/checkpoints"}\n' "$WORK" > "$AGENT/checkpoint.json"
# pi keeps the most recent keepRecentTokens (default 20000) and refuses to
# compact when nothing older is left ("nothing to compact"), so the session
# needs several earlier turns with real bulk (~15k tokens each) before the one
# that fills the context.
BULK="$(printf 'filler line about nothing in particular. %.0s' $(seq 1 1500))"

REQUESTS="$WORK/requests.jsonl"
python3 "$REPO/test/integration/fake_model.py" "$PORT" 16000 "$REQUESTS" &
MODEL_PID=$!
trap 'kill "$MODEL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if timeout 1 bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then break; fi
  if ! kill -0 "$MODEL_PID" 2>/dev/null; then echo "the fake model exited before listening"; exit 1; fi
  sleep 0.2
done
timeout 1 bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null || { echo "the fake model never opened port $PORT"; exit 1; }
request() { python3 "$REPO/test/integration/requests.py" "$REQUESTS" "$1"; } # last | first-after-compaction

run_pi() { # output file, prompt...   (prompts are sent 3 s apart; the fake model answers at once)
  local out=$1 prompt
  shift
  : > "$REQUESTS"
  (for prompt in "$@"; do printf '{"type":"prompt","id":"p","message":"%s"}\n' "$prompt"; sleep 3; done; sleep 6) |
    (cd "$PROJECT" && PI_CODING_AGENT_DIR="$AGENT" timeout 60 pi --mode rpc --no-extensions \
      -e "$REPO/src/index.ts" --provider fake --model m >"$out" 2>"$out.err") || true
}

echo "session 1: fill the context"
run_pi "$WORK/s1.jsonl" "one. $BULK" "two. $BULK" "three. $BULK" "four. TRIGGER" "five. carry on"
SAVED="$(find "$WORK/checkpoints" -name '*.md' 2>/dev/null | head -1)"
check "the model was asked to save"            grep -q 'progress-checkpoint-request' "$WORK/s1.jsonl"
check "save_progress was called"               grep -q '"save_progress"' "$WORK/s1.jsonl"
check "exactly one progress file was written"  test "$(find "$WORK/checkpoints" -name '*.md' | wc -l)" = 1
check "it holds what the model saved"          grep -q 'Next action: stop.' "$SAVED"
check "the file is private (mode 600)"         test "$(stat -c %a "$SAVED")" = 600
check "its folder is named after the project"  test "$(basename "$(dirname "$SAVED")")" = "--$(printf '%s' "${PROJECT#/}" | tr / -)--"
check "compaction ran and succeeded"           bash -c "grep '\"type\":\"compaction_end\"' '$WORK/s1.jsonl' | grep -v -q errorMessage"
check "the saved progress was restored"        grep -q '"progress-checkpoint"' "$WORK/s1.jsonl"
request last > "$WORK/s1-last.txt"
check "the model was given it on its next turn" grep -q -E 'PROGRESS-[0-9a-f]{32} BEGIN' "$WORK/s1-last.txt"
check "framed as notes, with the saved text"   bash -c "grep -q 'not instructions' '$WORK/s1-last.txt' && grep -q 'Next action: stop.' '$WORK/s1-last.txt'"
check "the bulky early turns were cut"         bash -c "! grep -q 'one. filler' '$WORK/s1-last.txt'"
check "pi reported no extension error"         test ! -s "$WORK/s1.jsonl.err"

echo "session 2: same folder, new session"
run_pi "$WORK/s2.jsonl" "hello again"
check "nothing was restored into it"           bash -c "! grep -q '\"progress-checkpoint\"' '$WORK/s2.jsonl'"
check "it was not asked to save (3% used)"     bash -c "! grep -q 'progress-checkpoint-request' '$WORK/s2.jsonl'"
check "the first session's file is untouched"  test "$(find "$WORK/checkpoints" -name '*.md' | wc -l)" = 1

echo "session 3: pi wants to compact mid-run, before the save"
PROJECT="$WORK/project-midrun"
mkdir -p "$PROJECT" && echo "some notes" > "$PROJECT/notes.txt"
run_pi "$WORK/s3.jsonl" "one. $BULK" "two. $BULK" "three. $BULK" "four. TRIGGER2 read notes.txt"
request first-after-compaction > "$WORK/s3-after.txt"
check "pi's compaction was put off for the save" grep -q 'compaction put off until the model has saved' "$WORK/s3.jsonl"
check "compaction then ran"                    test -s "$WORK/s3-after.txt"
check "the save came before the compaction"    grep -q 'Progress saved (' "$WORK/s3-after.txt"
check "the first response after it saw the note" grep -q -E 'PROGRESS-[0-9a-f]{32} BEGIN' "$WORK/s3-after.txt"
check "pi reported no extension error"         test ! -s "$WORK/s3.jsonl.err"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; evidence kept in $WORK"
  exit 1
fi
echo "all checks passed (scratch files in $WORK)"
