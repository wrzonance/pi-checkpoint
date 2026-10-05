"""A scripted OpenAI-compatible model for the integration test.

It plays the part of a model that fills its context and then does what the
checkpoint extension asks, so the whole flow runs without a real model:

  a user prompt            -> a short answer; one containing TRIGGER reports
                              high prompt usage (the context "fills up")
  a prompt with TRIGGER2   -> a `read` tool call that reports usage above pi's
                              own compaction trigger, so pi wants to compact
                              mid-run, while the save request is still unanswered
  the save instruction     -> a save_progress tool call
  a tool result            -> a short answer
  a request without tools  -> a summary (pi's built-in compaction)

Every request's non-system message texts are appended to REQUEST_LOG, one JSON
list per line, so the test can check what the model was actually given and when.

Usage: fake_model.py PORT HIGH_PROMPT_TOKENS REQUEST_LOG
"""
import http.server
import json
import sys

PORT = int(sys.argv[1])
HIGH_PROMPT_TOKENS = int(sys.argv[2])
REQUEST_LOG = sys.argv[3]
OVER_PI_TRIGGER = 17000  # above (32768 - 16384): pi's own threshold compaction wants to run
SAVED_NOTE = "Goal: finish the integration test.\nCurrent state: asked to save.\nNext action: stop.\nDecisions and dead ends: none."


def text_of(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    return " ".join(part.get("text", "") for part in content or [] if isinstance(part, dict))


def decide(body):
    """What the scripted model answers: ("text", str, prompt_tokens) or ("save", str, prompt_tokens)."""
    messages = body.get("messages", [])
    if not body.get("tools"):
        return "text", "Summary of the earlier conversation.", 500
    last = messages[-1] if messages else {}
    last_user = next((text_of(m) for m in reversed(messages) if m.get("role") == "user"), "")
    mid_run = any("TRIGGER2" in text_of(m) for m in messages if m.get("role") == "user")
    asked = any("save_progress now" in text_of(m) for m in messages if m.get("role") != "system")
    saved = any(m.get("role") == "tool" and m.get("tool_call_id") == "call_save" for m in messages)
    if asked and not saved:
        return "save", SAVED_NOTE, OVER_PI_TRIGGER if mid_run else 800
    if last.get("role") == "tool":
        return "text", "Done.", 800
    if mid_run:
        return "read", "notes.txt", OVER_PI_TRIGGER
    return "text", "Hello.", HIGH_PROMPT_TOKENS if "TRIGGER" in last_user else 1000


def chunks(kind, payload, prompt_tokens):
    base = {"id": "fake", "object": "chat.completion.chunk", "model": "fake"}
    if kind in ("save", "read"):
        name, arguments = ("save_progress", {"content": payload}) if kind == "save" else ("read", {"path": payload})
        call = {"index": 0, "id": f"call_{kind}", "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)}}
        delta, finish = {"role": "assistant", "tool_calls": [call]}, "tool_calls"
    else:
        delta, finish = {"role": "assistant", "content": payload}, "stop"
    yield {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
    yield {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}
    yield {**base, "choices": [], "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 5,
                                             "total_tokens": prompt_tokens + 5}}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        seen = [text_of(m)[:2000] for m in body.get("messages", []) if m.get("role") != "system"]
        with open(REQUEST_LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps(seen) + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk in chunks(*decide(body)):
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *_args):
        pass


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
