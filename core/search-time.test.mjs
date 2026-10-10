import { expect, feature, unit } from "bdd-vitest";
import { preferDates, temporalIntent } from "./search-time.mjs";

feature("relative time in a question", () => {
  unit("time words become dates and leave the content words", {
    given: ["questions written on Saturday 2026-10-10", () => new Date("2026-10-10T16:00:00")],
    when: ["reading their intent", (now) => [
      temporalIntent("när startade WSL om i förmiddags", now),
      temporalIntent("vad bröt npm run generate på main i går", now),
      temporalIntent("vad hände i natt", now),
      temporalIntent("Conquest Reforged", now),
    ]],
    then: ["today, yesterday and both for the night; plain lookups are untouched", ([morning, yesterday, night, plain]) => {
      expect(morning).toEqual({ query: "när startade WSL om", dates: ["2026-10-10"] });
      expect(yesterday).toEqual({ query: "vad bröt npm run generate på main", dates: ["2026-10-09"] });
      expect(night.dates).toEqual(["2026-10-10", "2026-10-09"]);
      expect(plain).toEqual({ query: "Conquest Reforged", dates: [] });
    }],
  });

  unit("hits from the named day move first and keep their order", {
    given: ["a ranking led by an older note", () => [{ path: "/a", date: "2026-09-01" }, { path: "/b", date: "2026-10-09" }, { path: "/c", date: "2026-10-09" }]],
    when: ["preferring yesterday", (hits) => preferDates(hits, ["2026-10-09"]).map((hit) => hit.path)],
    then: ["yesterday's notes lead", (paths) => expect(paths).toEqual(["/b", "/c", "/a"])],
  });
});
