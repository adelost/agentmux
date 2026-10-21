import { component, feature, expect } from 'bdd-vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from './commands.mjs';
import { createState } from '../core/state.mjs';
import { createDeliveryQueue } from '../core/delivery-queue.mjs';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'amux-fanout-')), configPath=join(root,'agents.yaml');
  writeFileSync(configPath,['sender','lsrc',...Array.from({length:6},(_,i)=>'target'+i)].map(name=>`${name}:\n  dir: ${root}\n  panes:\n    - name: claude\n      cmd: claude\n`).join(''));
  const previous={HOME:process.env.HOME,AMUX_AGENT_NAME:process.env.AMUX_AGENT_NAME,AMUX_PANE:process.env.AMUX_PANE,AMUX_EVENTS_PATH:process.env.AMUX_EVENTS_PATH};
  Object.assign(process.env,{HOME:root,AMUX_AGENT_NAME:'sender',AMUX_PANE:'0',AMUX_EVENTS_PATH:join(root,'events.jsonl')});
  const queue=createDeliveryQueue({rootDir:join(root,'queue')});
  const ctx={configPath,lastFile:join(root,'last'),state:createState(join(root,'state.json')),deliveryQueue:queue,projectHistory:()=>{}};
  const send=(n,...flags)=>dispatch(['target'+n,'-p','0','--wait-ms','0','-q',...flags,'work'],ctx);
  const count=()=>queue.allTargets().reduce((n,t)=>n+queue.list(t.agentName,t.pane).length,0);
  return {root,ctx,queue,send,count,restore(){for(const[k,v]of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v;rmSync(root,{recursive:true,force:true});}};
}
feature('panel send recipient budget',()=>{
  component('a fifth distinct recipient is refused before durable enqueue',{
    given:['one configured sender and six isolated targets',fixture],
    when:['sending to four targets then a fifth',async f=>{try{for(let i=0;i<4;i++)await f.send(i);let error=null;try{await f.send(4);}catch(e){error=e.message;}return{error,jobs:f.count()};}finally{f.restore();}}],
    then:['four queued jobs and an actionable refusal',r=>{expect(r.jobs).toBe(4);expect(r.error).toMatch(/4.*15.*--fanout/u);}],
  });
  component('the explicit fanout reason reaches the real send path and audit',{
    given:['a sender at four distinct targets',fixture],
    when:['overriding for a fifth with a reason',async f=>{try{for(let i=0;i<4;i++)await f.send(i);await f.send(4,'--fanout','Release handoff to the five owners');return{jobs:f.count(),audit:readFileSync(join(f.root,'events.jsonl'),'utf8')};}finally{f.restore();}}],
    then:['one extra job and the exact reason recorded',r=>{expect(r.jobs).toBe(5);expect(r.audit).toContain('Release handoff to the five owners');}],
  });
  component('a blank exception never sends or attaches',{
    given:['one configured isolated target',fixture],
    when:['sending with an empty exception reason',async f=>{try{let error=null;try{await f.send(0,'--fanout=');}catch(e){error=e.message;}return{error,jobs:f.count()};}finally{f.restore();}}],
    then:['the reason is required before enqueue',r=>{expect(r.error).toContain('--fanout requires');expect(r.jobs).toBe(0);}],
  });
});
