"""Print one request from the fake model's log (one JSON list of message texts per line).

Usage: requests.py LOG last | first-after-compaction
"""
import json
import sys

SUMMARY = "Summary of the earlier conversation."

log, which = sys.argv[1], sys.argv[2]
with open(log, encoding="utf-8") as handle:
    requests = [json.loads(line) for line in handle if line.strip()]
if which == "last":
    chosen = requests[-1] if requests else []
else:
    chosen = next((r for r in requests if any(SUMMARY in text for text in r)), [])
print("\n".join(chosen))
