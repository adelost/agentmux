import { component, feature, unit, expect } from "bdd-vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "./state.mjs";
import { createOnTrackMonitor, ON_TRACK_STATE } from "./on-track-monitor.mjs";
import { activeOnTrackRow, onTrackCoveredUntil, leaderQueueStop } from "./on-track-contract.mjs";

feature("approved review contracts preserve coverage and legitimate queues", () => {
  unit("coverage uses the frozen source boundary rather than later receipt acceptance", {
    when: ["a valid review was filed after its source window", () => onTrackCoveredUntil({ lastReview: { valid: true, at: 200 }, cycle: { at: 100, review: { valid: true, at: 200 } } })],
    then: ["the intervening order remains in the next window", at => expect(at).toBe(100)],
  });
  unit("Later and parked rows are outside C3 while an active long estimate is not", {
    when: ["classifying actual state forms", () => ["Later P2", "parked outside queue", "öppen: parkerad", "struken", "working, estimate 5h"].map(state => activeOnTrackRow({ state }))],
    then: ["only active work is checked", r => expect(r).toEqual([false,false,false,false,true])],
  });
  unit("a queue requires a real leader decision and an actual named gate", {
    when: ["checking a valid gate and invented evidence", () => {
      const context={project:{dispatcher:"lsrc:0"},cycle:{decisions:[{id:"decision",by:"lsrc:0",text:"W quota gate holds new work"}]},rows:{1:{}},row:{row:"1"},verify:e=>e===true};
      return [leaderQueueStop({kind:"leader-queue",gate:"W",decisionId:"decision",evidence:true},context),leaderQueueStop({kind:"leader-queue",gate:"W",decisionId:"invented",evidence:true},context),leaderQueueStop({kind:"leader-queue",predecessor:"1",decisionId:"decision",evidence:true},context)];
    }],
    then: ["only the documented non-self queue qualifies", r => expect(r).toEqual([true,false,false])],
  });
  component("one baseline receives two hours and is not replaced at the first hourly tick", {
    when: ["the bridge advances across the first hour and restarts", async () => {
      let at=Date.parse("2026-10-25T13:24:10Z");const state=createState(join(mkdtempSync(join(tmpdir(),"amux-baseline-")),"state.json")),sent=[];
      const project={id:"huset",reviewer:"claw:0",dispatcher:"claw:0",root:"/fixture",ledger:"TASKS.md",livePaths:["title"],baselinePolicy:"618ece76",baselineAfter:"2026-10-25T13:00:00Z"};
      const deps={state,projects:()=>[project],snapshot:()=>({tip:"a".repeat(40),asks:[]}),now:()=>at,send:async(target,text,key)=>{sent.push({target,key});return{id:key};}};
      await createOnTrackMonitor(deps).tick();const first=state.get(ON_TRACK_STATE).projects.huset.cycle;
      at+=61*60000;await createOnTrackMonitor(deps).tick();const second=state.get(ON_TRACK_STATE).projects.huset.cycle;
      return{first,second,sent};
    }],
    then: ["the same baseline remains pending with one reminder", r=>{expect(r.first.baseline).toBe(true);expect(r.first.deadline-r.first.at).toBe(7200000);expect(r.second.id).toBe(r.first.id);expect(r.sent).toHaveLength(1);}],
  });
});
