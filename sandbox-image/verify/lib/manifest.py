#!/usr/bin/env python3

import json
import sys
import tomllib


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: manifest.py <manifest> <dotted-key> <value|lines|json>")

    with open(sys.argv[1], "rb") as manifest_file:
        value = tomllib.load(manifest_file)
    for part in sys.argv[2].split("."):
        value = value[part]

    mode = sys.argv[3]
    if mode == "json":
        print(json.dumps(value, separators=(",", ":")))
    elif mode == "lines":
        for item in value:
            if isinstance(item, (dict, list)):
                print(json.dumps(item, separators=(",", ":")))
            else:
                print(item)
    elif mode == "value" and not isinstance(value, (dict, list)):
        print(str(value).lower() if isinstance(value, bool) else value)
    else:
        raise SystemExit(f"cannot render {sys.argv[2]} as {mode}")


if __name__ == "__main__":
    main()
