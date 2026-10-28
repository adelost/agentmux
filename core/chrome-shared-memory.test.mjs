// The Chrome launcher keeps shared memory in RAM. These tests run real executables through it.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { CHROME_LAUNCHER, downloadedChromeBuilds, keepChromeMemoryInRam } from "./chrome-shared-memory.mjs";

/** WHAT: Places a real executable where a downloaded Chrome build would be. WHY: Lets the launcher run something observable. */
function fakeBuild(home, parts, executable = "/bin/echo") {
  const folder = join(home, ...parts.slice(0, -1));
  mkdirSync(folder, { recursive: true });
  copyFileSync(executable, join(folder, parts.at(-1)));
  return join(folder, parts.at(-1));
}

const absent = () => ({ state: "absent" });

feature("Chrome shared memory stays in RAM", () => {
  component("downloaded Playwright and Puppeteer builds get the launcher, which drops only the shared-memory flag", {
    given: ["a Playwright and a Puppeteer build that echo their arguments", () => {
      const home = mkdtempSync(join(tmpdir(), "chrome-home-"));
      return { home, builds: [fakeBuild(home, [".cache/ms-playwright", "chromium_headless_shell-1300", "chrome-headless-shell-linux64", "chrome-headless-shell"]),
        fakeBuild(home, [".cache/puppeteer", "chrome", "linux-155.0", "chrome-linux64", "chrome"])] };
    }],
    when: ["guarding twice and launching each build with Playwright's flags", ({ home, builds }) => {
      const first = keepChromeMemoryInRam({ builds: downloadedChromeBuilds({ home }), system: absent });
      const second = keepChromeMemoryInRam({ builds: downloadedChromeBuilds({ home }), system: absent });
      return { first, second, output: builds.map((path) => execFileSync(path, ["--disable-dev-shm-usage", "--headless=new", "about:blank"], { encoding: "utf8" })) };
    }],
    then: ["both run without the flag, keep their binary as .real and the second pass changes nothing", ({ first, second, output }, { builds }) => {
      expect(first.builds.map(({ state }) => state)).toEqual(["wrapped", "wrapped"]);
      expect(second.builds.map(({ state }) => state)).toEqual(["guarded", "guarded"]);
      expect(output).toEqual(["--headless=new about:blank\n", "--headless=new about:blank\n"]);
      expect(builds.map((path) => readFileSync(path, "utf8"))).toEqual([CHROME_LAUNCHER, CHROME_LAUNCHER]);
    }],
    cleanup: ({ home }) => rmSync(home, { recursive: true, force: true }),
  });

  component("a binary reinstalled over the launcher becomes the new .real", {
    given: ["a guarded build that a reinstall then overwrote with another binary", () => {
      const home = mkdtempSync(join(tmpdir(), "chrome-home-"));
      const path = fakeBuild(home, [".cache/ms-playwright", "chromium-1300", "chrome-linux64", "chrome"]);
      keepChromeMemoryInRam({ builds: [path], system: absent });
      copyFileSync("/bin/true", path);
      return { home, path };
    }],
    when: ["guarding again and launching", ({ path }) => ({ result: keepChromeMemoryInRam({ builds: [path], system: absent }),
      output: execFileSync(path, ["--disable-dev-shm-usage"], { encoding: "utf8" }) })],
    then: ["the launcher is back and runs the reinstalled binary", ({ result, output }, { path }) => {
      expect(result.builds.map(({ state }) => state)).toEqual(["wrapped"]);
      expect(readFileSync(path, "utf8")).toBe(CHROME_LAUNCHER);
      expect(readFileSync(`${path}.real`)).toEqual(readFileSync("/bin/true"));
      expect(output).toBe("");
    }],
    cleanup: ({ home }) => rmSync(home, { recursive: true, force: true }),
  });
});
