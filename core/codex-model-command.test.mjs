import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createState } from "./state.mjs";
import { formatCodexModelChange, formatCodexModelFailure, runLockedCodexModelChange } from "./codex-model-command.mjs";

import { startCodexProcess, assertCodexWorkModel } from "./codex-process-launch.mjs";
import { waitForCodexUiReady } from "./codex-readiness.mjs";

const roots=[];
afterEach(()=>roots.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true})));
function fixture({model="gpt-5.6-sol",receipt=true,newWork=false,foreign=false,session="exact"}={}) {
  const root=mkdtempSync(join(tmpdir(),"amux-model-idempotent-")); roots.push(root);
  const path=join(root,"rollout.jsonl"), statePath=join(root,"state.json"), state=createState(statePath), calls=[];
  const append=type=>appendFileSync(path,JSON.stringify({type:"event_msg",payload:{type}})+"\n");
  writeFileSync(path,""); if(receipt) append("context_compacted"); if(newWork) append("user_message");
  if(receipt) state.set("context_maintenance_by_pane_v1",{"claw:3":{sessionId:foreign?"other":session,status:"VERIFIED",cursor:{positions:{[path]:0}}}});
  let selected=model, selectedEffort="xhigh";
  const agent={isBusy:async()=>false,paneProcessState:async()=>({running:true}),
    captureScreen:async()=>`\n› Ask Codex to do anything\n\n  ${selected} ${selectedEffort} · /fixture`,
    capturePane:async()=>"\n› Ask Codex to do anything\n",
    // Historical model deliberately stays Sol; only the live footer changes.
    getContext:async()=>({sessionId:session,model:"gpt-5.6-sol",effort:"xhigh",tokens:105_000}),
    compactCodex:async()=>{calls.push("compact"); const cursor={positions:{[path]:statSync(path).size}};
      append("context_compacted"); return {ok:true,sessionId:session,compactBoundary:true,cursor};},
    restartCodex:async(_n,_p,launch)=>{calls.push("restart");selected=launch.model;selectedEffort=launch.effort;},
  };
  return {state,statePath,calls,agent,name:"claw",pane:3,targetModel:"gpt-6-astra",targetEffort:"xhigh",
    deliveryBroker:{queue:{acquireSessionLease:()=>({release(){}})}},
    statusDriver:async()=>({ok:true,status:{session,model:{id:selected,effort:selectedEffort}}})};
}

describe("explicit model commands do not buy duplicate compaction",()=>{
  it("already selected Astra is a no-op even with old Sol history",async()=>{
    const fx=fixture({model:"gpt-6-astra",receipt:false});
    const result=await runLockedCodexModelChange(fx);
    expect(result).toMatchObject({ok:true,unchanged:true,model:"gpt-6-astra"}); expect(fx.calls).toEqual([]);
  });
  it("auto-compact, model switch, replay after restart use no extra compact",async()=>{
    const fx=fixture(); const first=await runLockedCodexModelChange(fx);
    const second=await runLockedCodexModelChange({...fx,state:createState(fx.statePath)});
    expect(first).toMatchObject({ok:true,reusedCompact:true}); expect(second.unchanged).toBe(true);
    expect(fx.calls).toEqual(["restart"]);
  });
  it("reads a receipt obtained while waiting for the shared lock", async () => {
    const fx = fixture();
    const receipt = fx.state.get("context_maintenance_by_pane_v1", {});
    fx.state.set("context_maintenance_by_pane_v1", {});
    let attempts = 0;
    fx.deliveryBroker.queue.acquireSessionLease = () => ++attempts === 1 ? null : { release() {} };
    fx.wait = async () => fx.state.set("context_maintenance_by_pane_v1", receipt);
    expect(await runLockedCodexModelChange(fx)).toMatchObject({ ok: true, reusedCompact: true });
    expect(fx.calls).toEqual(["restart"]);
  });
  it("same model with a different effort is a real change, not a no-op", async () => {
    const fx = fixture({ model: "gpt-6-astra", receipt: false });
    expect(await runLockedCodexModelChange({ ...fx, targetEffort: "high" }))
      .toMatchObject({ ok: true, effort: "high" });
    expect(fx.calls).toEqual(["compact", "restart"]);
  });
  it("a stale compact receipt does not matter when no model change is needed", async () => {
    const fx = fixture({ model: "gpt-6-astra", newWork: true });
    expect(await runLockedCodexModelChange(fx)).toMatchObject({ ok: true, unchanged: true });
    expect(fx.calls).toEqual([]);
  });
  for(const [name,extra]of [["new user work",{newWork:true}],["foreign session",{foreign:true}],["missing receipt",{receipt:false}]]){
    it(`${name} requires exactly one new compact before switching`,async()=>{
      const fx=fixture(extra); const result=await runLockedCodexModelChange(fx);
      expect(result.ok).toBe(true);expect(fx.calls).toEqual(["compact","restart"]);
    });
  }
  it("reports no-op, reused proof and new compact as different outcomes", () => {
    const result = { model: "gpt-6-astra", effort: "xhigh" };
    // Mattias 2026-10-02 found the receipt wording incomprehensible; the three
    // outcomes stay distinct in plain words.
    expect(formatCodexModelChange("claw", 3, { ...result, unchanged: true })).toBe("claw:3 already runs gpt-6-astra xhigh. Nothing changed.");
    expect(formatCodexModelChange("claw", 3, { ...result, reusedCompact: true })).toBe("claw:3 now runs gpt-6-astra xhigh. No compact was needed; other panes are unchanged.");
    expect(formatCodexModelChange("claw", 3, result)).toBe("claw:3 now runs gpt-6-astra xhigh. The context was compacted first; other panes are unchanged.");
  });
  it("says in plain words that a failed compact holds new messages", () => {
    // lsrc:4 on 2026-10-02 got "modelbyte avbrutet före osäkert cachebyte:
    // compact: compact-ended-without-boundary" and could not tell what happened.
    expect(formatCodexModelFailure("lsrc", 4, { ok: false, stage: "compact", reason: "compact-ended-without-boundary" })).toBe(
      "lsrc:4 was not switched. The compact that has to run first did not finish (compact-ended-without-boundary). "
      + "Messages to lsrc:4 wait until a switch succeeds; send /model again to retry.");
    expect(formatCodexModelFailure("lsrc", 4, { ok: false, stage: "busy", error: "pane is mid-turn; wait for it to finish or interrupt it first" }))
      .toBe("lsrc:4 was not switched. pane is mid-turn; wait for it to finish or interrupt it first.");
  });
});


describe("recovery of an explicitly retried stopped model transition", () => {
  it("leaves the goal paused and clears the block only through a verified same-session launch", async () => {
    const session = "11111111-1111-4111-8111-111111111111";
    const fx = fixture({ session });
    fx.targetModel = "gpt-6.1-sol";
    const key = "claw:3@1", sessionKey = "codex_session_by_pane_profile_v1";
    fx.state.set(sessionKey, { [key]: { sessionId: session, model: "gpt-5.6-sol",
      modelTransitionBlocked: { target: "gpt-6.1-sol", reason: "Codex composer did not become ready" } } });
    const captured = process.env.AMUX_PAUSED_GOAL_CAPTURE
      ? JSON.parse(readFileSync(process.env.AMUX_PAUSED_GOAL_CAPTURE, "utf8")).frame
      : "Resume paused goal?\n› 1. Resume goal\n› Ask Codex to do an  2. Leave paused\nGPT-6.1-Sol xhigh enter select · esc back\n? for shortcuts";
    const keys = [], launched = [], readinessClocks = [];
    let live = { model: "gpt-5.6-sol", effort: "xhigh" };
    fx.agent.paneProcessState = async () => ({ running: false });
    fx.agent.captureScreen = async () => `› Ask Codex to do anything\n${live.model} ${live.effort} · /workspace`;
    const start = async (_name, _pane, options) => {
      expect(options.retryModelChange).toBe(true);
      let menu = true, clock = 0;
      const screen = async () => menu ? captured : `› Ask Codex to do anything\n${options.model} ${options.effort} · /workspace`;
      const dismiss = async prompt => { keys.push(prompt.keys); menu = false; };
      await startCodexProcess({
        t: { runShell: async () => { launched.push(options.model); }, respawnPane: async () => {}, currentCommand: async () => "bash" }, wait: async () => {},
        target: "claw:.3", dir: "/workspace", profile: { home: "/test-profile" },
        selected: { model: options.model, effort: options.effort }, previous: live,
        sessionId: session, remembered: fx.state.get(sessionKey)[key], launchOptions: options,
        ready: async () => {
          const ready = await waitForCodexUiReady({
            tmux: { captureScreen: screen, sendKeys: async (_target, value) => dismiss({ keys: value }) },
            target: "claw:.3", agentName: "claw", pane: 3,
            delay: async ms => { clock += ms; }, now: () => clock, logger: { warn() {} },
          });
          readinessClocks.push(clock); return ready;
        }, screen, dismiss,
        remember: value => { fx.state.set(sessionKey, { [key]: value }); live = { model: value.model, effort: value.effort }; },
        pin: () => {},
      });
    };
    fx.agent.ensureReady = start;
    fx.agent.restartCodex = start;
    fx.statusDriver = async () => ({ ok: true, status: { session, model: { id: live.model, effort: live.effort } } });
    await expect(assertCodexWorkModel({ state: fx.state, name: "claw", pane: 3, screen: fx.agent.captureScreen }))
      .rejects.toMatchObject({ code: "AMUX_DELIVERY_REFUSED" });
    const result = await runLockedCodexModelChange(fx);
    expect(result, result.error).toMatchObject({ ok: true, reusedCompact: true });
    expect(launched).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
    expect(keys).toEqual(["Down Enter", "Down Enter"]);
    expect(readinessClocks).toEqual([1000, 1000]);
    expect(fx.state.get(sessionKey)[key]).toMatchObject({ sessionId: session, model: "gpt-6.1-sol", modelTransitionBlocked: null });
    expect(fx.calls).toEqual([]);
    await expect(assertCodexWorkModel({ state: fx.state, name: "claw", pane: 3, screen: fx.agent.captureScreen }))
      .resolves.toBeUndefined();
  });
});
