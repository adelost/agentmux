import { expect, feature, unit } from "bdd-vitest";
import { rescueChannelOwners } from "./restarter.mjs";

feature("Windows rescue channel ownership", () => {
  unit("a channel may have exactly the Windows bridge as consumer", {
    then: ["scalar and mapped WSL bindings are both detected", () => {
      const config = {
        ai: { dir: "/ai", discord: { "12345678901234567": 0 } },
        claw: { dir: "/claw", discord: "23456789012345678" },
        search: { roots: [] },
      };
      expect(rescueChannelOwners(config, "12345678901234567")).toEqual(["ai"]);
      expect(rescueChannelOwners(config, "23456789012345678")).toEqual(["claw"]);
      expect(rescueChannelOwners(config, "34567890123456789")).toEqual([]);
    }],
  });
});
