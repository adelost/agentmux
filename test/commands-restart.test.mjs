import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { dispatch } from "../cli/commands.mjs";
import { consumeFleetRestart } from "../core/fleet-restart.mjs";

feature("amux restart scope", () => {
  unit("--all hands the destructive work to the supervised bridge", {
    given: ["a fake live bridge and isolated request path", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-restart-cli-"));
      const pidfile = join(root, "bridge.pid");
      const request = join(root, "fleet-request.json");
      writeFileSync(pidfile, "4242\n");
      const originalPidfile = process.env.PIDFILE;
      const originalRequest = process.env.AMUX_FLEET_RESTART_REQUEST;
      process.env.PIDFILE = pidfile;
      process.env.AMUX_FLEET_RESTART_REQUEST = request;
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      return { root, request, kill, output, originalPidfile, originalRequest };
    }],
    when: ["dispatching restart --all", async () => {
      await dispatch(["restart", "--all"], {});
    }],
    then: ["SIGUSR2 is sent only after a durable fleet request", (_, context) => {
      expect(context.kill).toHaveBeenCalledWith(4242, "SIGUSR2");
      expect(consumeFleetRestart({ path: context.request })).toMatchObject({ source: "cli" });
      expect(context.output.mock.calls.flat().join(" ")).toMatch(/fleet restart queued/i);
      context.kill.mockRestore();
      context.output.mockRestore();
      if (context.originalPidfile === undefined) delete process.env.PIDFILE;
      else process.env.PIDFILE = context.originalPidfile;
      if (context.originalRequest === undefined) delete process.env.AMUX_FLEET_RESTART_REQUEST;
      else process.env.AMUX_FLEET_RESTART_REQUEST = context.originalRequest;
      rmSync(context.root, { recursive: true, force: true });
    }],
  });
});
