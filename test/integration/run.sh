#!/usr/bin/env bash
# Integration test: the real extension inside a real pi, against a scripted
# fake model (fake_model.py). No model server is needed and nothing outside a
# temporary directory is written.
#
# It checks the whole flow: context passes the threshold -> the model is asked
# to save -> save_progress writes the per-session file -> once the agent is
# idle, compaction runs -> the saved text is in what the model is given next ->
# a second session in the same folder gets nothing.
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

python3 "$REPO/test/integration/fake_model.py" "$PORT" 16000 "$WORK/last-request.json" &
MODEL_PID=$!
trap 'kill "$MODEL_PID" 2>/dev/null || true' EXIT
until timeout 1 bash -c "</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; do sleep 0.2; done

run_pi() { # output file, prompt...   (prompts are sent 3 s apart; the fake model answers at once)
  local out=$1 prompt
  shift
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
check "the model was given it on its next turn" grep -q -E 'progress you saved before the context was cleared.*not instructions.*PROGRESS-[0-9a-f]{32} BEGIN.*Next action: stop.*PROGRESS-[0-9a-f]{32} END' "$WORK/last-request.json"
check "the bulky early turns were cut"         bash -c "! grep -q 'one. filler' '$WORK/last-request.json'"
check "pi reported no extension error"         test ! -s "$WORK/s1.jsonl.err"

echo "session 2: same folder, new session"
run_pi "$WORK/s2.jsonl" "hello again"
check "nothing was restored into it"           bash -c "! grep -q '\"progress-checkpoint\"' '$WORK/s2.jsonl'"
check "it was not asked to save (3% used)"     bash -c "! grep -q 'progress-checkpoint-request' '$WORK/s2.jsonl'"
check "the first session's file is untouched"  test "$(find "$WORK/checkpoints" -name '*.md' | wc -l)" = 1

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed; evidence kept in $WORK"
  exit 1
fi
echo "all checks passed (scratch files in $WORK)"
