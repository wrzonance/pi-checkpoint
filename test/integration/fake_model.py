"""A scripted OpenAI-compatible model for the integration test.

It plays the part of a model that fills its context and then does what the
checkpoint extension asks, so the whole flow runs without a real model:

  a user prompt            -> a short answer; one containing TRIGGER reports
                              high prompt usage (the context "fills up")
  the save instruction     -> a save_progress tool call
  the tool result          -> a short answer
  a request without tools  -> a summary (pi's built-in compaction)

Every request's non-system message texts are written to REQUEST_LOG (the last
request wins), so the test can check what the model was actually given.

Usage: fake_model.py PORT HIGH_PROMPT_TOKENS REQUEST_LOG
"""
import http.server
import json
import sys

PORT = int(sys.argv[1])
HIGH_PROMPT_TOKENS = int(sys.argv[2])
REQUEST_LOG = sys.argv[3]
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
    if last.get("role") == "tool":
        return "text", "Saved.", 800
    asked = any("save_progress now" in text_of(m) for m in messages if m.get("role") != "system")
    already = any(m.get("role") == "tool" for m in messages)
    if asked and not already:
        return "save", SAVED_NOTE, 800
    last_user = next((text_of(m) for m in reversed(messages) if m.get("role") == "user"), "")
    return "text", "Hello.", HIGH_PROMPT_TOKENS if "TRIGGER" in last_user else 1000


def chunks(kind, payload, prompt_tokens):
    base = {"id": "fake", "object": "chat.completion.chunk", "model": "fake"}
    if kind == "save":
        call = {"index": 0, "id": "call_save", "type": "function",
                "function": {"name": "save_progress", "arguments": json.dumps({"content": payload})}}
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
        with open(REQUEST_LOG, "w", encoding="utf-8") as log:
            json.dump(seen, log)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk in chunks(*decide(body)):
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *_args):
        pass


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
