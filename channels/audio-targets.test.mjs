// Phone target truth: which Discord channels the app may address, and which
// agent pane owns each channel. Multi-target support (lsrc:3 + lsrc:10)
// arrived after the single configured channel proved too narrow.

import { expect, feature, unit } from "bdd-vitest";
import { paneForChannel, phoneTargetChannels } from "./audio-targets.mjs";

const AGENTS = {
  lsrc: {
    dir: "/tmp/lsrc",
    discord: { "1502949109491961917": 3, "1528238682744557598": 10 },
    panes: Array.from({ length: 11 }, () => ({})),
  },
  claw: { dir: "/tmp/claw", discord: { "1495818918592249896": 3 }, panes: [{}, {}, {}, {}] },
};

feature("phone target channels", () => {
  unit("the primary target leads and extra targets follow, deduped", {
    then: ["primary first, blanks dropped, no duplicates", () => {
      expect(phoneTargetChannels({
        target: "1502949109491961917",
        targets: ["1528238682744557598", "1502949109491961917", "", "  "],
      })).toEqual(["1502949109491961917", "1528238682744557598"]);
      expect(phoneTargetChannels({ target: "1502949109491961917" }))
        .toEqual(["1502949109491961917"]);
      expect(phoneTargetChannels({ targets: ["chan-1"] }))
        .toEqual(["chan-1"]);
      expect(phoneTargetChannels(null)).toEqual([]);
    }],
  });

  unit("paneForChannel resolves the owning agent pane across sessions", {
    then: ["exact channel ownership, unknown channels refuse", () => {
      expect(paneForChannel(AGENTS, "1528238682744557598")).toEqual({ name: "lsrc", pane: 10 });
      expect(paneForChannel(AGENTS, "1495818918592249896")).toEqual({ name: "claw", pane: 3 });
      expect(paneForChannel(AGENTS, "9999999999999999999")).toBeNull();
      expect(paneForChannel(null, "1528238682744557598")).toBeNull();
    }],
  });

  unit("paneForChannel refuses malformed or out-of-range pane mappings", {
    then: ["non-integer, negative, and beyond-array panes are unowned", () => {
      const broken = {
        a: { dir: "/x", discord: { "11111111111111111111": "tre" }, panes: [{}] },
        b: { dir: "/x", discord: { "22222222222222222222": -2 }, panes: [{}] },
        c: { dir: "/x", discord: { "33333333333333333333": 7 }, panes: [{}] },
        d: { dir: "/x", discord: { "44444444444444444444": 0 }, panes: [{}] },
      };
      expect(paneForChannel(broken, "11111111111111111111")).toBeNull();
      expect(paneForChannel(broken, "22222222222222222222")).toBeNull();
      expect(paneForChannel(broken, "33333333333333333333")).toBeNull();
      expect(paneForChannel(broken, "44444444444444444444")).toEqual({ name: "d", pane: 0 });
    }],
  });
});
