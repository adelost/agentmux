import { expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import { createRunningBootReader, watchWslBoot } from "./windows-manager-boot.mjs";

const BOOT = "d4528e2a-fb97-4544-b3c7-0a24eb4af1c2";

feature("windows manager boot watch", () => {
  unit("a slow boot id read is never killed and no second read starts while it runs", {
    then: ["the turn is released at the deadline, later ticks wait for the read, and the watch reads again once it finished", async () => {
      // defect: 95 of the 101 WSL relays still waiting at the end of the 28 to 30 Oct boot followed a boot-id-timeout.
      // WSL's relay waits with no limit for a wsl.exe killed before it connected.
      const started = [];
      const killed = [];
      let finishSlowRead;
      // runBounded's contract: a timeout above 0 kills wsl.exe at that deadline.
      const run = (file, args, timeoutMs) => {
        if (args[0] === "--list") return Promise.resolve({ ok: true, stdout: "Ubuntu-22.04" });
        started.push(args.join(" "));
        const readNumber = started.length;
        return new Promise((resolvePromise) => {
          if (timeoutMs > 0) setTimeout(() => { killed.push(readNumber); resolvePromise({ ok: false, timedOut: true, stdout: "" }); }, timeoutMs);
          const answer = () => resolvePromise({ ok: true, timedOut: false, stdout: BOOT });
          if (readNumber === 1) finishSlowRead = answer;
          else answer();
        });
      };
      vi.useFakeTimers();
      try {
        const deps = {
          nowMs: () => 1_000_000,
          saveState: () => {},
          sendMessage: async () => {},
          log: () => {},
          readRunningBootId: createRunningBootReader({ rootDir: "C:\\AgentmuxRestarter", run, readJson: () => ({ distro: "Ubuntu-22.04", linuxUser: "adelost" }), systemRoot: "C:\\Windows" }),
        };
        const state = { schemaVersion: 1, lastBootId: BOOT };
        const firstTick = watchWslBoot({ state, deps });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await firstTick).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        await watchWslBoot({ state, deps });
        expect(killed).toEqual([]);
        expect(started).toHaveLength(1);
        finishSlowRead();
        await vi.advanceTimersByTimeAsync(60_000);
        await watchWslBoot({ state, deps });
        expect(started).toHaveLength(2);
        expect(killed).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }],
  });
});
