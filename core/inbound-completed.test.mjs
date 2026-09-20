import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";
import { createInboundReconciler } from "./inbound-reconciler.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, {recursive:true,force:true})));
const root = () => { const path=mkdtempSync(join(tmpdir(), "amux-completed-")); roots.push(path); return path; };
const msg = {id:"101",channelId:"500",authorId:"human",text:"/model astra",createdTimestamp:101,attachments:[]};
const target = () => ({agentName:"claw",pane:3,dir:"/fixture"});

describe("completed Discord commands stay completed", () => {
  it("Gateway followed by REST and process restart executes one command once", async () => {
    const rootDir=root(), calls=[];
    const store=createDiscordInboundStore({rootDir}); store.advanceCursor("500","100");
    const build = store => createInboundReconciler({store,state:{get:(_k,f)=>f},resolveTarget:target,
      onMessage:async m => { calls.push(m.id); }});
    const channel={fetchMissed:async()=>({messages:[msg],newestId:"101"}),fetchMessage:async()=>msg};
    await build(store).enqueue(msg,channel);
    const completedAt=store.read("500","101").completedAt;
    await build(createDiscordInboundStore({rootDir})).reconcile(channel,"500");
    await build(createDiscordInboundStore({rootDir})).enqueue(msg,channel);
    expect(calls).toEqual(["101"]);
    expect(store.read("500","101")).toMatchObject({status:"completed",completedAt});
  });

  it("completion during attachment preparation cannot regress to assets_ready", async () => {
    let finish;
    const bytes=new Promise(resolve=>{finish=resolve});
    const rootDir=root(), store=createDiscordInboundStore({rootDir,downloadBuffer:()=>bytes});
    const record=store.observe({...msg,attachments:[{id:"a",name:"a.txt",url:"fixture"}]},target());
    const preparation=store.prepareAttachments(record);
    createDiscordInboundStore({rootDir}).complete(record,{delivered:true});
    finish(Buffer.from("local fixture"));
    expect((await preparation).status).toBe("completed");
    expect(store.pending("500")).toEqual([]);
  });

  it("a delayed failure cannot turn completed work into a reported retry", () => {
    const store=createDiscordInboundStore({rootDir:root()}), record=store.observe(msg,target());
    store.complete(record,{delivered:true}); store.fail(record,new Error("late transport error"));
    expect(store.read("500","101")).toMatchObject({status:"completed",nextAttemptAt:null,lastError:null});
  });
});
