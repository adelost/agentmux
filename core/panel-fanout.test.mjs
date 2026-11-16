import { component, feature, expect } from 'bdd-vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createState } from './state.mjs';
import { orderRefusal } from './panel-order.mjs';
import { admitPanelSend } from './panel-fanout.mjs';

const run=promisify(execFile);
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'amux-fanout-state-')),path=join(root,'state.json'),state=createState(path);
  const send=(target,options={})=>admitPanelSend({sender:'sender:0',target,state,now:1000,...options});
  return{root,path,state,send,restore:()=>rmSync(root,{recursive:true,force:true})};
}
feature('atomic rolling panel recipient window',()=>{
  component('repeat recipients share a slot and the 15-minute boundary expires it',{
    given:['one persistent sender window',fixture],
    when:['repeating one target, filling four, then waiting to the boundary',f=>{try{
      for(let i=0;i<4;i++)f.send('target'+i+':0');
      const repeated=f.send('target0:0');let denied=false;try{f.send('target4:0');}catch{denied=true;}
      const after=f.send('target4:0',{now:901000});return{repeated,denied,after};
    }finally{f.restore();}}],
    then:['four slots stay four, the fifth waits until expiry',r=>{expect(r.repeated.recipients).toBe(4);expect(r.denied).toBe(true);expect(r.after.recipients).toBe(1);}],
  });
  component('operator, dispatcher, internal sources and self-sends do not consume panel slots',{
    given:['an empty persistent sender window',fixture],
    when:['admitting exempt origins and independent ordinary senders',f=>{try{
      for(let i=0;i<6;i++)for(const options of [{sender:null},{sender:'lsrc:0'},{source:'discord'},{source:'stall-watch'},{sender:'target'+i+':0'}])f.send('target'+i+':0',options);
      const first=f.send('ordinary:0');for(let i=0;i<4;i++)f.send('target'+i+':0',{sender:'other:0'});return first;
    }finally{f.restore();}}],
    then:['the ordinary sender still begins at its first recipient',r=>expect(r.recipients).toBe(1)],
  });
  component('two concurrent processes cannot both take the fourth recipient slot',{
    given:['three slots persisted before two independent CLI processes',fixture],
    when:['racing two admissions through the real State lock',async f=>{try{
      for(let i=0;i<3;i++)f.send('target'+i+':0');
      const script=`import {createState} from ${JSON.stringify(new URL('./state.mjs',import.meta.url).href)};import {admitPanelSend} from ${JSON.stringify(new URL('./panel-fanout.mjs',import.meta.url).href)};try{admitPanelSend({sender:'sender:0',target:process.argv[2],state:createState(process.argv[1]),now:1000});console.log('accepted')}catch(e){console.log('refused')}`;
      return await Promise.all(['fourth:0','fifth:0'].map(async target=>(await run(process.execPath,['--input-type=module','-e',script,f.path,target])).stdout.trim()));
    }finally{f.restore();}}],
    then:['exactly one process is admitted',rows=>expect(rows.sort()).toEqual(['accepted','refused'])],
  });
});

feature('pilot order guard', () => {
  component('stops pilot sends while exempt and non-row texts pass', {
    given: ['a current pilot and a row over its message limit', () => ({at: 0, pilot: ['lsrc:9', 'sandman:0', 'deep:5'], leads: ['sandman:0'], over: {'3058': 9, '2026': 8}, limit: 6})],
    when: ['checking messages with and without exceptions', guard => {
      const ask = (sender, target, text, more = {}) => orderRefusal({sender, target, text, guard, now: 60000, ...more});
      return {done: ask('lsrc:9','sandman:0','3066 DONE: x'), over: ask('lsrc:9','sandman:0','3058 red'),
        pass: [ask('sandman:0','lsrc:9','3058 red'), ask('deep:5','lsrc:9','3058 red'),
          ask('lsrc:9','lsrc:9','3058 red'), ask('lsrc:9','deep:5','3058 red'),
          ...['Read 2026-11-16T10:18Z', 'Since 16 Nov 2026', '2026 px', 'at 10:18Z 2026 ms'].map(text => ask('lsrc:9','sandman:0',text)),
          ask('lsrc:9','sandman:0','3066 DONE', {anyway:'emergency'}), ask('lsrc:9','sandman:0','3066 DONE', {now:660000})],
        empty: ask('lsrc:9','sandman:0','3066 DONE',{anyway:' '})};
    }],
    then: ['refusal names the command and exemptions pass', r => { expect(r.done).toContain('ticket done 3066'); expect(r.over).toContain('row 3058'); expect(r.pass).toEqual(Array(r.pass.length).fill(null)); expect(r.empty).toContain('--anyway requires'); }],
  });
});
