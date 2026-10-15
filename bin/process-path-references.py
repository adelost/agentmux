#!/usr/bin/env python3
"""Read-only process references, including other UIDs. Never signal a process."""
import json
import os
import sys
import re


def receipt_references(request):
    """WHAT: Reads source-root bindings. WHY: Keeps private or unreadable receipts from silently permitting retirement."""
    targets = set(request["targets"])
    protected = set()
    errors = []
    cutoff = request["now"] / 1000 - 3 * 86400
    binding = re.compile(r'''(?:["']?(?:ROOT|root|sourceRoot|source[_-]root|repoRoot|cwd|WorkingDirectory)["']?)\s*[:=]\s*["']?(/[^\s"'`,;\]}]+)''')
    scanned_files = 0
    scanned_bytes = 0

    def record_root(value):
        """WHAT: Collects protected ancestors. WHY: Keeps matching proportional to path depth instead of worktree count."""
        cursor = os.path.normpath(value)
        while True:
            if cursor in targets:
                protected.add(cursor)
            parent = os.path.dirname(cursor)
            if parent == cursor:
                break
            cursor = parent

    def scan(path):
        """WHAT: Reads bounded text chunks. WHY: Prevents large logs from exhausting memory during cleanup qualification."""
        nonlocal scanned_files, scanned_bytes
        try:
            if os.path.islink(path):
                return
            if os.path.isdir(path):
                if os.path.basename(path) in {"node_modules", ".git", ".venv", "__pycache__"}:
                    return
                with os.scandir(path) as entries:
                    for entry in entries:
                        scan(entry.path)
                return
            if not os.path.isfile(path):
                return
            unit = path.endswith((".service", ".timer"))
            if not unit and os.stat(path).st_mtime < cutoff:
                return
            if not re.search(r"\.(jsonl?|md|txt|log|sh|service|timer|yaml|yml)$", path):
                return
            named = re.search(r"receipt|proof|qualif|guard|release|attest|context|runtime|manifest|source|build|live|deploy|window|verif|result|checkpoint|state|config|settings|agent|event|ledger|references", os.path.basename(path), re.I)
            artifact_data = "/.artifacts/" in path and not re.search(r"/(source|tests?|fixtures|node_modules|docs|tools|core|packages|cloud)/", path)
            if not (unit or named or artifact_data or path.endswith((".log", ".jsonl"))):
                return
            if re.search(r"/worktree-cleanup-[^/]+/references\.json$", path):
                with open(path, encoding="utf8") as source:
                    prior = json.load(source)
                for root, refs in prior.get("references", {}).items():
                    if any(ref["mtime"] >= cutoff for ref in refs):
                        record_root(root)
            with open(path, encoding="utf8", errors="replace") as source:
                scanned_files += 1
                carry = ""
                while chunk := source.read(65536):
                    scanned_bytes += len(chunk)
                    text = carry + chunk
                    for match in binding.finditer(text):
                        record_root(match[1])
                    carry = text[-8192:]
        except (FileNotFoundError, ProcessLookupError):
            pass
        except (OSError, ValueError) as error:
            errors.append({"path": path, "error": str(error)})

    for root in request["roots"]:
        if os.path.exists(root):
            scan(root)
    return {"protectedPaths": sorted(protected), "errors": errors,
            "scannedFiles": scanned_files, "scannedBytes": scanned_bytes}


if sys.argv[1:] == ["receipts"]:
    print(json.dumps(receipt_references(json.load(sys.stdin))))
    sys.exit(0)

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
