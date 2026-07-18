import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { component, expect, feature } from "bdd-vitest";

feature("bridge supervisor release swaps", () => {
  component("every child generation reacquires the installed package path", {
    when: ["reading the supervisor loop", () => readFileSync(resolve("bin/start.sh"), "utf8")],
    then: ["cd runs inside the loop immediately before Node", (source) => {
      const loop = source.indexOf("while true; do");
      const reacquire = source.indexOf('cd "$DIR"', loop);
      const launch = source.indexOf("node --import ./bin/quota-recovery-bootstrap.mjs index.mjs", loop);
      expect(loop).toBeGreaterThan(0);
      expect(reacquire).toBeGreaterThan(loop);
      expect(launch).toBeGreaterThan(reacquire);
    }],
  });
});
