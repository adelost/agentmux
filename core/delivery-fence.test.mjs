import { feature, unit, expect } from "bdd-vitest";
import { eraseKeys, isDeliveryCancelRequested, submitCheckOrErase, throwIfCancelRequested } from "./delivery-fence.mjs";

feature("a refused maintenance submit erases its own command", () => {
  unit("erase keys match the typed characters", {
    when: ["building keys for /compact and a two-emoji text", () => [eraseKeys("/compact"), eraseKeys("🦀🦀")]],
    then: ["one backspace per character", ([compact, emoji]) => {
      expect(compact.split(" ")).toEqual(Array(8).fill("BSpace"));
      expect(emoji).toBe("BSpace BSpace");
    }],
  });

  unit("a passing check erases nothing", {
    when: ["the check passes", async () => {
      const erased = [];
      await submitCheckOrErase(async () => {}, async () => erased.push("erased"));
      return erased;
    }],
    then: ["the typed command stays for Enter", (erased) => expect(erased).toEqual([])],
  });

  unit("a refusing check erases and still fails", {
    when: ["the check refuses", async () => {
      const erased = [];
      const error = await submitCheckOrErase(async () => { throw new Error("state-changed"); },
        async () => erased.push("erased")).catch((caught) => caught.message);
      return { erased, error };
    }],
    then: ["the command is erased and the refusal is reported", ({ erased, error }) => {
      expect(erased).toEqual(["erased"]);
      expect(error).toBe("state-changed");
    }],
  });

  unit("a failed erase is named in the refusal", {
    when: ["the erase itself fails", () => submitCheckOrErase(
      async () => { throw new Error("state-changed"); },
      async () => { throw new Error("tmux gone"); },
    ).catch((caught) => caught.message)],
    then: ["both causes are visible", (message) => expect(message).toBe("state-changed; typed command not erased: tmux gone")],
  });
});

// lsrc:0 2026-10-19 (claw:2): the paste and the submit fence refuse a cancelled job with one error, and the
// transport erases its own typed text for that error only.
feature("a sender's cancellation is one refusal at every stage before Enter", () => {
  const refusal = (job, stage) => { try { throwIfCancelRequested(job, stage); return null; } catch (error) { return error; } };

  unit("a requested cancellation refuses with the shared code and names the stage", {
    when: ["checking a job whose sender asked to cancel it", () => refusal({ cancelRequestStatus: "requested" }, "paste")],
    then: ["the refusal is the cancellation error", (error) => {
      expect(isDeliveryCancelRequested(error)).toBe(true);
      expect(error.message).toBe("delivery cancellation requested before paste");
    }],
  });

  unit("a job nobody asked to cancel, or whose request was settled, passes", {
    when: ["checking three jobs", () => [
      refusal({ cancelRequestStatus: null }, "paste"),
      refusal({ cancelRequestStatus: "refused" }, "submit fence"),
      refusal({}, "paste"),
    ]],
    then: ["none refuses", (refusals) => expect(refusals).toEqual([null, null, null])],
  });

  unit("only the refusals the caller names erase the typed text", {
    when: ["a check refuses once as a cancellation and once for another reason", async () => {
      const erased = [];
      const refuseWith = (error) => submitCheckOrErase(async () => { throw error; },
        async () => erased.push(error.message), isDeliveryCancelRequested).catch((caught) => caught.message);
      const cancel = Object.assign(new Error("cancelled"), { code: "AMUX_DELIVERY_CANCEL_REQUESTED" });
      return { cancelled: await refuseWith(cancel), other: await refuseWith(new Error("disk full")), erased };
    }],
    then: ["the cancellation erases, the other refusal keeps the text, and both are reported", ({ cancelled, other, erased }) => {
      expect(erased).toEqual(["cancelled"]);
      expect(cancelled).toBe("cancelled");
      expect(other).toBe("disk full");
    }],
  });
});
