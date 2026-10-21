import { component, feature, expect } from 'bdd-vitest';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoCompact } from './auto-compact.mjs';
import { DEFAULT_CONFIG } from '../core/auto-compact.mjs';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'amux-held-cause-')),prior=process.env.HOME;process.env.HOME=root;
  const configPath=join(root,'agents.yaml'),paneDir=join(root,'.agents','0');
  writeFileSync(configPath,`test:\n  dir: ${root}\n  panes:\n    - name: claude\n      cmd: claude\n  discord:\n    held-channel: 0\n`);
  const project=join(root,'.claude','projects',paneDir.replace(/[/.]/gu,'-'));mkdirSync(project,{recursive:true});
  const state={screen:'Conversation interrupted - tell the model what to do differently',tokens:1000000,mode:0,sends:[],at:Date.now()-55*60_000};
  const turn=()=>writeFileSync(join(project,'session.jsonl'),JSON.stringify({type:'user',timestamp:new Date(state.at).toISOString(),message:{role:'user',content:'work'}})+'\n');turn();
  const config={...DEFAULT_CONFIG,minIdleMs:0};
  const make=()=>createAutoCompact({agent:{paneProcessState:async()=>({running:true}),capturePane:async()=>state.screen+(state.tokens===null?'':`\n  ${state.tokens} tokens`)+'\n❯ '},agentsYamlPath:configPath,discord:{send:async(_ch,text)=>state.sends.push(text)},tmux:async()=>({stdout:`${state.mode} 50`}),config,log:()=>{}});
  return{state,turn,make,restore(){prior===undefined?delete process.env.HOME:process.env.HOME=prior;rmSync(root,{recursive:true,force:true});}};
}
feature('held compact notice identity',()=>{
  component('an unreadable context observation does not clear an unchanged hold',{
    given:['an interrupted pane with one accepted notice',fixture],
    when:['losing and regaining only its context reading',async f=>{try{const ac=f.make();await ac.tick();f.state.tokens=null;await ac.tick();f.state.tokens=1000000;await ac.tick();return f.state.sends;}finally{f.restore();}}],
    then:['the same cause still has one notice',sent=>expect(sent).toHaveLength(1)],
  });
  component('overlapping polls do not post the same accepted episode twice',{
    given:['one interrupted pane polled twice concurrently',fixture],
    when:['both ticks inspect the same episode',async f=>{try{const ac=f.make();await Promise.all([ac.tick(),ac.tick()]);return f.state.sends;}finally{f.restore();}}],
    then:['one held notice is accepted',sent=>expect(sent).toHaveLength(1)],
  });
  component('the same interrupted cause stays quiet across journal activity and controller reload',{
    given:['one interrupted pane over its context budget',fixture],
    when:['polling, advancing its journal, and reconstructing the controller',async f=>{try{const ac=f.make();await ac.tick();f.state.at+=1000;f.turn();await ac.tick();await f.make().tick();return f.state.sends;}finally{f.restore();}}],
    then:['only one accepted notice for the same cause',sent=>{expect(sent).toHaveLength(1);expect(sent[0]).toContain('its status is interrupted');}],
  });
  component('a changed cause is reported once and a cleared episode rearms',{
    given:['an interrupted pane with a readable journal',fixture],
    when:['changing to copy mode, clearing it, and later interrupting again',async f=>{try{
      const ac=f.make();await ac.tick();f.state.mode=1;await ac.tick();await ac.tick();
      f.state.mode=0;f.state.screen='Ready';await ac.tick();
      f.state.screen='Conversation interrupted - tell the model what to do differently';await ac.tick();
      return f.state.sends.filter(text=>text.includes('is held:'));
    }finally{f.restore();}}],
    then:['only the changed or newly held episodes notify',sent=>{expect(sent).toHaveLength(3);expect(sent[1]).toContain('copy-mode');expect(sent[2]).toContain('interrupted');}],
  });
});
