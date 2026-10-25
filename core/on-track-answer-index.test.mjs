import { component, feature, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTrackAnswerPage, readIndexedOnTrackAnswer } from "./on-track-answer-index.mjs";

feature("canonical answer transport stays bounded and source linked", () => {
  component("a source over1MiB is read once and emitted in bounded pages without losing IDs", {
    when: ["partitioning the real failure's large-answer shape", () => {
      const root=mkdtempSync(join(tmpdir(),"amux-answer-pages-")),cycle={id:"cutkit:1",at:1};let reads=0;
      const entries=Array.from({length:1200},(_,i)=>({id:`answer-${i}`,ts:"2026-10-25T13:00:00Z",agent:"lsrc",pane:3,ledgerPath:"/canonical/source.jsonl",messageId:String(i),text:"å".repeat(1200)}));
      const readEntries=()=>{reads++;return entries;};let cursor=null;const pages=[];
      do { const p=onTrackAnswerPage({root,project:"cutkit",cycle,cursor,readEntries});pages.push(p);cursor=p.nextCursor; } while(cursor);
      return{pages,reads,expected:entries.map(e=>e.id)};
    }],
    then:["every source identity and reference survives below the frame bound",r=>{
      expect(r.reads).toBe(1);expect(r.pages.length).toBeGreaterThan(1);
      expect(r.pages.flatMap(p=>p.answers.map(a=>a.id))).toEqual(r.expected);
      expect(r.pages.every(p=>Buffer.byteLength(JSON.stringify(p))<=128*1024)).toBe(true);
      expect(r.pages.flatMap(p=>p.answers).every(a=>a.source==="/canonical/source.jsonl"&&a.textSha256.length===64)).toBe(true);
    }],
  });
  component("one full answer is reopened from its original record and a changed source is refused", {
    when:["reading a captured reference before and after a source edit",()=>{
      const root=mkdtempSync(join(tmpdir(),"amux-answer-source-")),source=join(root,"canonical.jsonl"),cycle={id:"cutkit:1",at:1};
      const row={id:"actual",ts:"2026-10-25T13:00:00Z",agent:"lsrc",pane:3,ledgerPath:source,text:"The complete actual answer."};writeFileSync(source,JSON.stringify(row)+'\n');
      onTrackAnswerPage({root,project:"cutkit",cycle,readEntries:()=>[row]});
      const answer=readIndexedOnTrackAnswer({root,project:"cutkit",cycle,id:"actual"});writeFileSync(source,JSON.stringify({...row,text:"changed"})+'\n');
      let refused=false;try{readIndexedOnTrackAnswer({root,project:"cutkit",cycle,id:"actual"});}catch{refused=true;}
      return{answer,refused};
    }],
    then:["full text is exact and its immutable hash is checked",r=>{expect(r.answer.text).toBe("The complete actual answer.");expect(r.refused).toBe(true);}],
  });
});
