import { expect, feature, unit } from "bdd-vitest";
import {
  formatMemoryRelief,
  gradleDaemonsFromPs,
  parseGradleStatus,
  relieveIdleGradleDaemons,
} from "./memory-relief.mjs";

const JAVA = "/home/u/android-dev/jdk17/bin/java";
// Shapes measured on 2026-09-14 21:17: three 8.11.1 daemons and one 8.10.2.
const PS = [
  `1340270 3826000 ${JAVA} --add-opens=java.base/java.lang=ALL-UNNAMED -Xmx4g -cp /g/gradle-daemon-main-8.11.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.11.1`,
  `1401589 1150000 ${JAVA} -Xmx2048m -cp /g/gradle-daemon-main-8.11.1.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.11.1`,
  `1210313 4400000 ${JAVA} -Xmx2g -cp /g/gradle-daemon-main-8.10.2.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10.2`,
  `1212377 2300000 ${JAVA} -cp /g/kotlin-compiler-embeddable.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon`,
  `55024 512000 /home/u/.local/bin/claude --model claude-opus-5`,
].join("\n");

function status(rows) {
  return `   PID STATUS   INFO\n${rows.map(([pid, state, version]) => `${pid} ${state}     ${version}`).join("\n")}\n`;
}

feature("memory relief", () => {
  unit("finds only Gradle daemons, with version, JVM and size", {
    then: ["Kotlin daemons and other processes are not Gradle daemons", () => {
      expect(gradleDaemonsFromPs(PS)).toEqual([
        { pid: 1340270, rssKb: 3826000, java: JAVA, version: "8.11.1" },
        { pid: 1401589, rssKb: 1150000, java: JAVA, version: "8.11.1" },
        { pid: 1210313, rssKb: 4400000, java: JAVA, version: "8.10.2" },
      ]);
      expect(parseGradleStatus(status([["1340270", "IDLE", "8.11.1"], ["1401589", "BUSY", "8.11.1"]])).get(1401589))
        .toEqual({ state: "BUSY", version: "8.11.1" });
    }],
  });

  unit("stops IDLE daemons and leaves BUSY, unreported and replaced pids running", {
    then: ["Gradle's own status is the only proof, checked per version with that daemon's JVM", async () => {
      const killed = [];
      const statusCalls = [];
      const result = await relieveIdleGradleDaemons({
        listProcesses: async () => PS,
        launcherFor: (version) => (version === "8.10.2" ? "/dists/8.10.2/bin/gradle" : "/dists/8.11.1/bin/gradle"),
        statusFor: async (launcher, javaHome) => {
          statusCalls.push([launcher, javaHome]);
          return launcher.includes("8.11.1")
            ? { ok: true, stdout: status([["1340270", "IDLE", "8.11.1"], ["1401589", "BUSY", "8.11.1"]]) }
            : { ok: true, stdout: status([]) };
        },
        stillDaemon: () => true,
        kill: (pid) => killed.push(pid),
      });
      expect(killed).toEqual([1340270]);
      expect(statusCalls).toEqual([
        ["/dists/8.11.1/bin/gradle", "/home/u/android-dev/jdk17"],
        ["/dists/8.10.2/bin/gradle", "/home/u/android-dev/jdk17"],
      ]);
      expect(result.kept).toEqual([
        { pid: 1401589, version: "8.11.1", state: "BUSY" },
        { pid: 1210313, version: "8.10.2", state: "UNREPORTED" },
      ]);
      expect(formatMemoryRelief(result)).toBe("stoppade 1 inaktiva Gradle-processer (3.6 GiB), 1 bygger och får vara");
    }],
  });

  unit("a pid that stopped being a Gradle daemon before the kill is never signalled", {
    then: ["pid reuse between status and kill cannot hit another process", async () => {
      const killed = [];
      await relieveIdleGradleDaemons({
        listProcesses: async () => PS,
        launcherFor: () => "/dists/bin/gradle",
        statusFor: async () => ({ ok: true, stdout: status([["1340270", "IDLE", "8.11.1"], ["1401589", "IDLE", "8.11.1"], ["1210313", "IDLE", "8.10.2"]]) }),
        stillDaemon: (pid) => pid !== 1401589,
        kill: (pid) => killed.push(pid),
      });
      expect(killed).toEqual([1340270, 1210313]);
    }],
  });

  unit("a missing launcher or failed status stops nothing for that version", {
    then: ["without Gradle's verdict every daemon of that version keeps running", async () => {
      const killed = [];
      const result = await relieveIdleGradleDaemons({
        listProcesses: async () => PS,
        launcherFor: (version) => (version === "8.10.2" ? null : "/dists/bin/gradle"),
        statusFor: async () => ({ ok: false, stdout: "" }),
        stillDaemon: () => true,
        kill: (pid) => killed.push(pid),
      });
      expect(killed).toEqual([]);
      expect(result.skipped).toEqual([
        { version: "8.11.1", reason: "status-failed" },
        { version: "8.10.2", reason: "launcher-not-installed" },
      ]);
    }],
  });
});
