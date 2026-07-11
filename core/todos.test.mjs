import { unit, feature, expect } from "bdd-vitest";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseTodos,
  serializeTodos,
  nextId,
  addTodo,
  doneTodo,
  rmTodo,
  findItem,
  listActive,
  listRemindable,
  listDone,
  loadTodos,
  saveTodos,
  formatActiveList,
  formatReminderSummary,
  SECTION_NOW,
  SECTION_PARKED,
  SECTION_BLOCKED,
  SECTION_DONE,
} from "./todos.mjs";

const tmpPath = () =>
  join(tmpdir(), `amux-todos-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
const cleanup = (p) => { try { unlinkSync(p); } catch {} };

const SAMPLE = `> summary: test fixture
> why: tests

# Tasks

## Idag / snart
- [ ] Bygg s22-scripts <!-- id:5 created:2026-05-27 -->
- [ ] Köp extern SSD <!-- id:6 created:2026-05-27 prio:medium -->

## Parkerat (tar tag i senare)
- [ ] Skeleton terrain alignment <!-- id:3 created:2026-05-20 -->

## Väntar på
_(Saker som blockas av andra)_

## Klart (senaste)
- [x] /api/logs auth fix <!-- id:4 created:2026-05-25 closed:2026-05-26 -->
- [x] Tidigare task utan id-comment
`;

feature("parseTodos", () => {
  unit("parses header + sections + items correctly", {
    given: ["the sample fixture", () => SAMPLE],
    when: ["parsing", (text) => parseTodos(text)],
    then: ["expected structure", (parsed) => {
      expect(parsed.header).toContain("# Tasks");
      expect(parsed.sections.length).toBe(4);
      expect(parsed.sections[0].name).toBe(SECTION_NOW);
      expect(parsed.sections[0].items.length).toBe(2);
      expect(parsed.sections[0].items[0].text).toBe("Bygg s22-scripts");
      expect(parsed.sections[0].items[0].meta.id).toBe(5);
      expect(parsed.sections[0].items[0].done).toBe(false);
      expect(parsed.sections[3].name).toBe(SECTION_DONE);
      expect(parsed.sections[3].items[0].done).toBe(true);
      expect(parsed.sections[3].items[0].meta.closed).toBe("2026-05-26");
    }],
  });

  unit("tolerates item without meta comment", {
    given: ["fixture with un-tagged item", () => SAMPLE],
    when: ["parsing and finding the un-tagged one", (text) => {
      const p = parseTodos(text);
      return p.sections[3].items[1];
    }],
    then: ["text preserved, no id", (item) => {
      expect(item.text).toBe("Tidigare task utan id-comment");
      expect(item.meta.id).toBe(undefined);
    }],
  });

  unit("preserves placeholder text in empty section", {
    given: ["fixture", () => SAMPLE],
    when: ["parsing", (text) => parseTodos(text)],
    then: ["blocked section has placeholder line", (parsed) => {
      const blocked = parsed.sections.find((s) => s.name === SECTION_BLOCKED);
      expect(blocked.items.length).toBe(0);
      expect(blocked.lines.some((l) => l.includes("blockas av andra"))).toBe(true);
    }],
  });

  unit("empty input returns empty structure", {
    given: ["empty string", () => ""],
    when: ["parsing", (text) => parseTodos(text)],
    then: ["no sections", (parsed) => {
      expect(parsed.sections).toEqual([]);
    }],
  });
});

feature("serializeTodos", () => {
  unit("roundtrip preserves structure", {
    given: ["sample fixture", () => SAMPLE],
    when: ["parse then serialize", (text) => {
      const parsed = parseTodos(text);
      return serializeTodos(parsed);
    }],
    then: ["contains all items", (out) => {
      expect(out).toContain("- [ ] Bygg s22-scripts <!-- id:5");
      expect(out).toContain("- [x] /api/logs auth fix");
      expect(out).toContain("## Idag / snart");
      expect(out).toContain("## Klart (senaste)");
    }],
  });

  unit("empty section gets placeholder", {
    given: ["parsed with all items in Klart only", () => {
      const p = parseTodos(SAMPLE);
      // empty Idag section
      p.sections[0].items = [];
      p.sections[0].lines = [];
      return p;
    }],
    when: ["serializing", (p) => serializeTodos(p)],
    then: ["placeholder injected", (out) => {
      expect(out).toContain("_(inget just nu)_");
    }],
  });
});

feature("nextId", () => {
  unit("returns max+1 across all sections", {
    given: ["parsed fixture", () => parseTodos(SAMPLE)],
    when: ["asking for next id", (p) => nextId(p)],
    then: ["7 (max was 6)", (id) => expect(id).toBe(7)],
  });

  unit("returns 1 for empty list", {
    given: ["empty parsed", () => parseTodos("")],
    when: ["next id", (p) => nextId(p)],
    then: ["1", (id) => expect(id).toBe(1)],
  });
});

feature("addTodo", () => {
  unit("appends to Idag / snart by default", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["adding", (p) => {
      const { item } = addTodo(p, "Ny task");
      return { parsed: p, item };
    }],
    then: ["item present with new id", ({ parsed, item }) => {
      expect(item.meta.id).toBe(7);
      expect(parsed.sections[0].items.length).toBe(3);
      expect(parsed.sections[0].items[2].text).toBe("Ny task");
    }],
  });

  unit("can add to Parkerat with section option", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["adding parked", (p) => {
      addTodo(p, "Senare", { section: SECTION_PARKED });
      return p;
    }],
    then: ["lands in parked section", (parsed) => {
      const parked = parsed.sections.find((s) => s.name === SECTION_PARKED);
      expect(parked.items.some((i) => i.text === "Senare")).toBe(true);
    }],
  });
});

feature("doneTodo", () => {
  unit("moves active item to Klart with closed date", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["marking id 5 done", (p) => {
      const result = doneTodo(p, 5, "2026-05-28");
      return { parsed: p, result };
    }],
    then: ["found, moved, closed date set", ({ parsed, result }) => {
      expect(result.found).toBe(true);
      expect(result.fromSection).toBe(SECTION_NOW);
      const idag = parsed.sections.find((s) => s.name === SECTION_NOW);
      expect(idag.items.some((i) => i.meta.id === 5)).toBe(false);
      const klart = parsed.sections.find((s) => s.name === SECTION_DONE);
      const moved = klart.items.find((i) => i.meta.id === 5);
      expect(moved).toBeTruthy();
      expect(moved.done).toBe(true);
      expect(moved.meta.closed).toBe("2026-05-28");
    }],
  });

  unit("substring match works", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["done by substring 's22'", (p) => doneTodo(p, "s22")],
    then: ["found", (result) => expect(result.found).toBe(true)],
  });

  unit("returns not-found for unknown id", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["done id 999", (p) => doneTodo(p, 999)],
    then: ["not found", (result) => expect(result.found).toBe(false)],
  });
});

feature("rmTodo", () => {
  unit("removes item without moving to Klart", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["removing id 6", (p) => {
      const result = rmTodo(p, 6);
      return { parsed: p, result };
    }],
    then: ["gone entirely", ({ parsed, result }) => {
      expect(result.found).toBe(true);
      const allItems = parsed.sections.flatMap((s) => s.items);
      expect(allItems.some((i) => i.meta.id === 6)).toBe(false);
    }],
  });
});

feature("listActive / listDone", () => {
  unit("listActive returns items from Idag + Parkerat + Väntar", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["listing", (p) => listActive(p)],
    then: ["3 items (2 idag + 1 parkerat)", (items) => {
      expect(items.length).toBe(3);
      expect(items.every((i) => i.section !== SECTION_DONE)).toBe(true);
    }],
  });

  unit("listDone returns from Klart only", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["listing done", (p) => listDone(p)],
    then: ["2 items", (items) => expect(items.length).toBe(2)],
  });
});

feature("findItem", () => {
  unit("by numeric id", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["find id 3", (p) => findItem(p, 3)],
    then: ["hit", (hit) => {
      expect(hit).toBeTruthy();
      expect(hit.item.text).toContain("Skeleton");
    }],
  });

  unit("by string id", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["find '5'", (p) => findItem(p, "5")],
    then: ["hit id 5", (hit) => {
      expect(hit).toBeTruthy();
      expect(hit.item.meta.id).toBe(5);
    }],
  });

  unit("substring case-insensitive", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["find 'SKELETON'", (p) => findItem(p, "SKELETON")],
    then: ["hit", (hit) => expect(hit).toBeTruthy()],
  });
});

feature("formatActiveList / formatReminderSummary", () => {
  unit("formatActiveList shows ids and section headers", {
    given: ["fixture", () => parseTodos(SAMPLE)],
    when: ["format", (p) => formatActiveList(p)],
    then: ["contains id markers + sections", (out) => {
      expect(out).toContain("## Idag / snart");
      expect(out).toContain("[#5]");
      expect(out).toContain("Bygg s22-scripts");
    }],
  });

  unit("formatActiveList handles empty", {
    given: ["empty parsed", () => parseTodos("")],
    when: ["format", (p) => formatActiveList(p)],
    then: ["fallback string", (out) => expect(out).toContain("inga aktiva")],
  });

  unit("formatReminderSummary is brief and counts only REMINDABLE items", {
    given: ["fixture (en av tre aktiva är odaterat parkerad)", () => parseTodos(SAMPLE)],
    when: ["format reminder", (p) => formatReminderSummary(p)],
    then: ["short; parked-undated excluded from the ping by design", (out) => {
      expect(out).toContain("2 aktiva");
      expect(out.length).toBeLessThan(200);
    }],
  });
});

feature("loadTodos / saveTodos roundtrip", () => {
  unit("save then load preserves content", {
    given: ["a path + parsed fixture", () => ({
      path: tmpPath(),
      parsed: parseTodos(SAMPLE),
    })],
    when: ["save then load", ({ path, parsed }) => {
      saveTodos(parsed, path);
      const reloaded = loadTodos(path);
      cleanup(path);
      return reloaded;
    }],
    then: ["sections match", (reloaded) => {
      expect(reloaded.sections.length).toBe(4);
      expect(reloaded.sections[0].items[0].meta.id).toBe(5);
      expect(reloaded.sections[3].items[0].meta.closed).toBe("2026-05-26");
    }],
  });

  unit("load on missing file returns empty-but-valid structure", {
    given: ["a path that doesn't exist", () => tmpPath()],
    when: ["load", (path) => loadTodos(path)],
    then: ["has at least Idag section", (parsed) => {
      const idag = parsed.sections.find((s) => s.name === SECTION_NOW);
      expect(idag).toBeTruthy();
      expect(idag.items.length).toBe(0);
    }],
  });
});

feature("listRemindable — morgonpingens urval (tjatighets-vakt)", () => {
  const FILE = [
    "# Tasks",
    "",
    "## Idag / snart",
    "- [ ] ring banken",
    "",
    "## Parkerat (tar tag i senare)",
    "- [ ] städa garaget",
    "- [ ] deklarera — deadline: 2026-07-01",
    "",
    "## Väntar på",
    "- [ ] svar från Sebbe — deadline: 2026-07-11",
    "- [ ] svar från kommunen",
    "",
    "## Klart (senaste)",
    "- [x] gammalt",
  ].join("\n");

  unit("odaterat parkerat/väntande pingas ALDRIG; Idag alltid; due-deadlines inkluderas", {
    given: ["listan ovan, idag = 2026-07-11", () => ({ parsed: parseTodos(FILE) })],
    when: ["selecting", ({ parsed }) => listRemindable(parsed, { today: "2026-07-11" })],
    then: ["3 items: overdue först, sen dagens, sen odaterad Idag-rad", (items) => {
      expect(items.map((i) => i.text.slice(0, 10))).toEqual([
        "deklarera ", "svar från ", "ring banke",
      ]);
      expect(items[0].overdue).toBe(true);
      expect(items[1].overdue).toBe(false);
      expect(items.some((i) => i.text.includes("garaget"))).toBe(false);
      expect(items.some((i) => i.text.includes("kommunen"))).toBe(false);
    }],
  });

  unit("tom Idag-sektion + inga due deadlines = ingenting att pinga", {
    given: ["bara odaterat parkerat", () => ({
      parsed: parseTodos("# Tasks\n\n## Idag / snart\n\n## Parkerat (tar tag i senare)\n- [ ] nånting sen\n"),
    })],
    when: ["selecting", ({ parsed }) => listRemindable(parsed, { today: "2026-07-11" })],
    then: ["tom lista → cron är tyst", (items) => expect(items).toHaveLength(0)],
  });

  unit("reminder-summary markerar overdue med 🔴 och är tom när inget är remindable", {
    given: ["listan ovan", () => ({ parsed: parseTodos(FILE) })],
    when: ["formatting", ({ parsed }) => formatReminderSummary(parsed, 180, { today: "2026-07-11" })],
    then: ["🔴 på deklarera, garaget saknas", (body) => {
      expect(body).toContain("🔴 deklarera");
      expect(body).not.toContain("garaget");
    }],
  });
});
