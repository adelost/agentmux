import { expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import { createRunningBootReader, watchWslBoot } from "./windows-manager-boot.mjs";

const BOOT = "d4528e2a-fb97-4544-b3c7-0a24eb4af1c2";
const NEW_BOOT = "20b98fe4-8261-4569-aca0-09e0bf731fc3";
const SHARE = "\\\\wsl.localhost\\Ubuntu-22.04\\proc\\sys\\kernel\\random\\boot_id";

/** The manager's tools as the watch sees them: wsl.exe lists the running distros, `readText` reads a Windows path; every other wsl.exe call is recorded. */
function world(answers) {
  const entered = [], reads = [];
  const run = (file, args) => {
    if (args[0] === "--list") return Promise.resolve({ ok: true, stdout: "Ubuntu-22.04" });
    entered.push(args.join(" "));
    return Promise.resolve({ ok: true, timedOut: false, stdout: BOOT });
  };
  const readText = (path) => { reads.push(path); return answers(reads.length); };
  const deps = {
    nowMs: () => 1_000_000, saveState: () => {}, sendMessage: async () => {}, log: () => {},
    readRunningBootId: createRunningBootReader({ rootDir: "C:\\AgentmuxRestarter", run, readText, systemRoot: "C:\\Windows",
      readJson: () => ({ distro: "Ubuntu-22.04", linuxUser: "adelost" }) }),
  };
  return { entered, reads, deps };
}

feature("windows manager boot watch", () => {
  unit("the boot id is read from the distro's 9p share, never by a wsl.exe that starts a Linux process, and a slow read is waited out alone", {
    then: ["no wsl.exe enters the distro; later ticks wait for the slow read, and the watch reads again once it finished", async () => {
      // defect: a wsl.exe that gives up after 30 s leaves WSL's relay waiting with no limit; 5 of the 6 slow reads on 10 Nov 11:38-11:55Z left one (row 123).
      let finishSlowRead;
      const { entered, reads, deps } = world((n) => n === 1
        ? new Promise((resolvePromise) => { finishSlowRead = () => resolvePromise(`${BOOT}\n`); })
        : Promise.resolve(`${BOOT}\n`));
      vi.useFakeTimers();
      try {
        const state = { schemaVersion: 1, lastBootId: BOOT };
        const firstTick = watchWslBoot({ state, deps });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await firstTick).toBe(false);
        await vi.advanceTimersByTimeAsync(60_000);
        await watchWslBoot({ state, deps });
        expect(reads).toEqual([SHARE]);
        finishSlowRead();
        await vi.advanceTimersByTimeAsync(60_000);
        await watchWslBoot({ state, deps });
        expect(reads).toEqual([SHARE, SHARE]);
        expect(entered).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }],
  });

  unit("a boot id that changed in the share is a new boot", {
    given: ["the watch knows one boot and the share now holds another, as after a WSL restart", () => world(() => Promise.resolve(`${NEW_BOOT}\n`))],
    when: ["the watch ticks", async ({ deps }) => {
      const state = { schemaVersion: 1, lastBootId: BOOT };
      return { changed: await watchWslBoot({ state, deps }), state };
    }],
    then: ["it sees the new boot id", ({ changed, state }) =>
      expect({ changed, lastBootId: state.lastBootId }).toEqual({ changed: true, lastBootId: NEW_BOOT })],
  });
});
