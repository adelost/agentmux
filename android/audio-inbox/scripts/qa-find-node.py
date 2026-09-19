"""The centre of the first node in a uiautomator dump whose text or description contains a needle.

Prints "x y" and exits 0, or prints nothing and exits 1. Used by qa-contact-sheet.sh so a tap lands on
what a person would tap: a row that moves takes its tap with it, and a row that is gone fails loudly
instead of tapping whatever now occupies its old coordinates.

uiautomator quotes an attribute with single quotes when its value contains a double quote, which every
Link row saying a wake phrase does. Reading only double-quoted attributes makes exactly those rows look
absent, so both quotings are read here.
"""
import re
import sys

ATTR = r'{name}=(?:"([^"]*)"|\'([^\']*)\')'


def attribute(tag: str, name: str) -> str:
    found = re.search(ATTR.format(name=name), tag)
    if not found:
        return ""
    return found.group(1) if found.group(1) is not None else found.group(2)


def centre(tag: str):
    box = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
    if not box:
        return None
    x1, y1, x2, y2 = (int(value) for value in box.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


xml = open(sys.argv[1], encoding="utf-8", errors="replace").read()
needle = sys.argv[2].lower()
# A dialog says "Allow" on its button and "Allowing ..." in its message, and the message comes first in
# the tree. Whoever asked for "Allow" meant the button, so an exact label on something tappable wins,
# then any tappable node that contains the words, and only then anything at all.
exact_clickable, loose_clickable, anything = [], [], []
for node in re.finditer(r"<node\b[^>]*>", xml):
    tag = node.group(0)
    labels = [attribute(tag, "text").lower(), attribute(tag, "content-desc").lower()]
    if not any(needle in label for label in labels):
        continue
    point = centre(tag)
    if point is None:
        continue
    clickable = attribute(tag, "clickable") == "true"
    if clickable and needle in [label.strip() for label in labels]:
        exact_clickable.append(point)
    elif clickable:
        loose_clickable.append(point)
    else:
        anything.append(point)

for candidates in (exact_clickable, loose_clickable, anything):
    if candidates:
        print(*candidates[0])
        raise SystemExit(0)
raise SystemExit(1)
