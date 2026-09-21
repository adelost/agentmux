import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createState } from "./state.mjs";
import { formatCodexModelChange, runLockedCodexModelChange } from "./codex-model-command.mjs";

const roots=[];
afterEach(()=>roots.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true})));
function fixture({model="gpt-5.6-sol",receipt=true,newWork=false,foreign=false}={}) {
  const root=mkdtempSync(join(tmpdir(),"amux-model-idempotent-")); roots.push(root);
  const path=join(root,"rollout.jsonl"), statePath=join(root,"state.json"), state=createState(statePath), calls=[];
  const append=type=>appendFileSync(path,JSON.stringify({type:"event_msg",payload:{type}})+"\n");
  writeFileSync(path,""); if(receipt) append("context_compacted"); if(newWork) append("user_message");
  if(receipt) state.set("context_maintenance_by_pane_v1",{"claw:3":{sessionId:foreign?"other":"exact",status:"VERIFIED",cursor:{positions:{[path]:0}}}});
  let selected=model, selectedEffort="xhigh";
  const agent={isBusy:async()=>false,paneProcessState:async()=>({running:true}),
    captureScreen:async()=>`\n› Ask Codex to do anything\n\n  ${selected} ${selectedEffort} · /fixture`,
    capturePane:async()=>"\n› Ask Codex to do anything\n",
    // Historical model deliberately stays Sol; only the live footer changes.
    getContext:async()=>({sessionId:"exact",model:"gpt-5.6-sol",effort:"xhigh",tokens:105_000}),
    compactCodex:async()=>{calls.push("compact"); const cursor={positions:{[path]:statSync(path).size}};
      append("context_compacted"); return {ok:true,sessionId:"exact",compactBoundary:true,cursor};},
    restartCodex:async(_n,_p,launch)=>{calls.push("restart");selected=launch.model;selectedEffort=launch.effort;},
  };
  return {state,statePath,calls,agent,name:"claw",pane:3,targetModel:"gpt-6-astra",targetEffort:"xhigh",
    deliveryBroker:{queue:{acquireSessionLease:()=>({release(){}})}},
    statusDriver:async()=>({ok:true,status:{session:"exact",model:{id:selected,effort:selectedEffort}}})};
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
    expect(formatCodexModelChange("claw", 3, { ...result, unchanged: true })).toContain("no compact or restart");
    expect(formatCodexModelChange("claw", 3, { ...result, reusedCompact: true })).toContain("reused the existing compact receipt");
    expect(formatCodexModelChange("claw", 3, result)).toContain("compact verified");
  });
});
