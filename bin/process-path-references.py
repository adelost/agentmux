#!/usr/bin/env python3
"""Read-only process references, including other UIDs. Never signal a process."""
import json
import os
import sys

targets = json.load(sys.stdin)
holders = {path: set() for path in targets}
errors = []


def record(value, pid):
    """WHAT: Collects matching process references. WHY: Keeps unrelated private paths out of the result."""
    value = value.removesuffix(" (deleted)")
    for path in targets:
        if value == path or value.startswith(path + "/"):
            holders[path].add(int(pid))


for pid in os.listdir("/proc"):
    if not pid.isdecimal():
        continue
    base = "/proc/" + pid
    try:
        try:
            record(os.readlink(base + "/cwd"), pid)
        except FileNotFoundError:
            pass  # Kernel threads have no cwd.
        for fd in os.listdir(base + "/fd"):
            try:
                record(os.readlink(base + "/fd/" + fd), pid)
            except FileNotFoundError:
                pass  # Descriptor closed during enumeration.
        with open(base + "/maps", encoding="utf8") as stream:
            for line in stream:
                fields = line.split(maxsplit=5)
                if len(fields) == 6:
                    record(fields[5].strip(), pid)
    except (FileNotFoundError, ProcessLookupError):
        pass
    except OSError as error:
        errors.append({"pid": int(pid), "error": str(error)})

print(json.dumps({"holders": {p: sorted(v) for p, v in holders.items()}, "errors": errors}))
