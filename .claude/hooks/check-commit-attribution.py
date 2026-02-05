#!/usr/bin/env python3
"""
Hook to block git commits containing Claude/AI attribution.
Works for both PermissionRequest and PreToolUse events.
"""
import json
import re
import sys

input_data = json.load(sys.stdin)
hook_event = input_data.get("hook_event_name", "")
command = input_data.get("tool_input", {}).get("command", "")

# Only check git commit commands
if "git commit" not in command:
    sys.exit(0)

# Patterns to block
patterns = [
    r"Co-Authored-By: Claude"
]

for pattern in patterns:
    if re.search(pattern, command, re.IGNORECASE):
        message = "BLOCKED: Remove AI/Claude attribution. Regenerate commit message without Co-Authored-By or 'Generated with' lines."

        if hook_event == "PermissionRequest":
            # PermissionRequest uses JSON output with decision
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "deny",
                        "message": message
                    }
                }
            }
            print(json.dumps(output))
            sys.exit(0)
        else:
            # PreToolUse uses exit code 2 with stderr message
            print(message, file=sys.stderr)
            sys.exit(2)

sys.exit(0)  # Allow everything else
