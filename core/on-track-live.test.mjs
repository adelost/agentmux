import { component, feature, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readLatestOnTrackLive } from "./on-track-live.mjs";

feature("C4 reads actual live publications without rerunning a game", () => {
  component("a newer release number does not replace the receipt for current live bytes", {
    when: ["native receipts and public live bytes disagree with numeric ordering", async () => {
      const root=mkdtempSync(join(tmpdir(),"amux-latest-live-")), now=Date.now(), sites=["https://a.example","https://b.example"];
      for(const [number,key,seconds]of [[701,"A",2000],[703,"B",1000]]) {
        const q=join(root,`release-${number}`,"qualified");mkdirSync(join(q,"live"),{recursive:true});
        const picture=join(q,"live","picture.png");writeFileSync(picture,"");
        writeFileSync(join(q,"publish-result.json"),JSON.stringify({deployExit:0,bytesExit:0,liveExit:0,endedAt:new Date(now-seconds).toISOString(),correctedSource:key.repeat(40)}));
        const hash=createHash("sha256").update(key).digest("hex");
        writeFileSync(join(q,"live-bytes.json"),JSON.stringify({hosts:Object.fromEntries(sites.map(s=>[new URL(s).host,{bundle:`/assets/${key}.js`,sha256:hash}]))}));
        writeFileSync(join(q,"live","receipt.json"),JSON.stringify({hosts:Object.fromEntries(sites.map(s=>[s,{picture,errors:[]}])) ,game:{picture,errors:[],aiSeats:0,boardSeconds:1,calls:["create","join","configure","ready","start"].map(action=>({path:`/api/lobby/fixture/${action}`,status:200}))}}));
      }
      const project={id:"huset",livePaths:["title-bundles-390","lobby-api","board-hud-390"],liveEvidence:{kind:"huset",root,prefix:"release-",sites}};
      const fetcher=async url=>String(url).endsWith(".js")?{ok:true,arrayBuffer:async()=>Buffer.from("A")}:{ok:true,text:async()=>'<script src="/assets/A.js"></script>'};
      return readLatestOnTrackLive(project,{fetcher,now});
    }],
    then: ["the actual current701 receipt qualifies all three observed paths", r=>{expect(r.publication.path).toContain("release-701");expect(r.live.map(p=>p.result)).toEqual(["PASS","PASS","PASS"]);}],
  });
  component("Cutkit public smoke does not claim to prove unmeasured main flows", {
    when: ["only an anonymous smoke exists for the actual deployed Worker", async()=>{
      const root=mkdtempSync(join(tmpdir(),"amux-cut-live-")),out=join(root,"published");mkdirSync(out);
      const at=new Date().toISOString();writeFileSync(join(out,"release.json"),JSON.stringify({source:"a".repeat(40),worker:"actual-worker",at,smoke:{ok:true}}));
      return readLatestOnTrackLive({id:"cutkit",livePaths:["open-film","play","export-test-project","speak"],liveEvidence:{kind:"cutkit",root}},
        {deployment:[{created_on:at,versions:[{version_id:"actual-worker",percentage:100}]}]});
    }],
    then: ["the actual publication is selected and coverage stays UNKNOWN",r=>{expect(r.publication.worker).toBe("actual-worker");expect(r.live.every(p=>p.result==="UNKNOWN")).toBe(true);}],
  });
});
