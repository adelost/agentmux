import { component, feature, expect } from 'bdd-vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createState } from './state.mjs';
import { markedPaneText, orderMark, orderNotice, senderLines } from './panel-order.mjs';
import { fanoutNotice } from './panel-fanout.mjs';

const run=promisify(execFile);
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'amux-fanout-state-')),path=join(root,'state.json'),state=createState(path);
  const send=(target,options={})=>fanoutNotice({sender:'sender:0',target,state,now:1000,...options});
  return{root,path,state,send,restore:()=>rmSync(root,{recursive:true,force:true})};
}
feature('atomic rolling panel recipient window',()=>{
  component('a fifth recipient is counted and noticed, never refused; repeats share a slot and the 15-minute boundary expires it (Mattias 16 Nov 2026)',{
    given:['one persistent sender window',fixture],
    when:['repeating one target, filling four, adding a fifth, repeating it, then waiting to the boundary',f=>{try{
      for(let i=0;i<4;i++)f.send('target'+i+':0');
      const repeated=f.send('target0:0'),fifth=f.send('target4:0'),again=f.send('target4:0'),sixth=f.send('target5:0',{fanoutReason:'handoff'});
      let blank='';try{f.send('target6:0',{fanoutReason:' '});}catch(e){blank=e.message;}
      const after=f.send('target6:0',{now:901000});return{repeated,fifth,again,sixth,blank,after};
    }finally{f.restore();}}],
    then:['four stay inside, the fifth and sixth carry the count against the limit, a repeat and an expired window carry nothing',r=>{
      expect(r.repeated).toEqual({exempt:false,recipients:4,notice:null});
      expect(r.fifth).toEqual({exempt:false,recipients:5,notice:{rule:'fanout',row:null,count:5,limit:4,words:'5 recipients in 15 minutes, limit 4',
        told:'target4:0 makes 5 different recipients in 15 minutes (limit 4). Contact only a panel that needs an action.'}});
      expect(r.again).toEqual({exempt:false,recipients:5,notice:null});expect(r.sixth.notice.count).toBe(6);
      expect(r.blank).toContain('--fanout requires');expect(r.after).toEqual({exempt:false,recipients:1,notice:null});}],
  });
  component('operator, dispatcher, internal sources and self-sends do not consume panel slots',{
    given:['an empty persistent sender window',fixture],
    when:['admitting exempt origins and independent ordinary senders',f=>{try{
      for(let i=0;i<6;i++)for(const options of [{sender:null},{sender:'lsrc:0'},{source:'discord'},{source:'stall-watch'},{sender:'target'+i+':0'}])f.send('target'+i+':0',options);
      const first=f.send('ordinary:0');for(let i=0;i<4;i++)f.send('target'+i+':0',{sender:'other:0'});return first;
    }finally{f.restore();}}],
    then:['the ordinary sender still begins at its first recipient',r=>expect(r.recipients).toBe(1)],
  });
  component('two concurrent processes cannot both take the fourth recipient slot: one is inside, one is noticed, both go (Mattias 16 Nov 2026)',{
    given:['three slots persisted before two independent CLI processes',fixture],
    when:['racing two admissions through the real State lock',async f=>{try{
      for(let i=0;i<3;i++)f.send('target'+i+':0');
      const script=`import {createState} from ${JSON.stringify(new URL('./state.mjs',import.meta.url).href)};import {fanoutNotice} from ${JSON.stringify(new URL('./panel-fanout.mjs',import.meta.url).href)};console.log(fanoutNotice({sender:'sender:0',target:process.argv[2],state:createState(process.argv[1]),now:1000}).notice?.count??'inside')`;
      return await Promise.all(['fourth:0','fifth:0'].map(async target=>(await run(process.execPath,['--input-type=module','-e',script,f.path,target])).stdout.trim()));
    }finally{f.restore();}}],
    then:['exactly one process is inside the limit and the other is the fifth',rows=>expect(rows.sort()).toEqual(['5','inside'])],
  });
});

feature('pilot order guard', () => {
  component('marks pilot sends outside the order and never stops them, while exempt and non-row texts carry nothing (Mattias 16 Nov 2026)', {
    given: ['a current pilot and a row over its message limit', () => ({at: 0, pilot: ['lsrc:9', 'sandman:0', 'deep:5'], leads: ['sandman:0'], over: {'3058': 9, '2026': 8}, limit: 6})],
    when: ['checking messages with and without a reason', guard => {
      const ask = (sender, target, text, more = {}) => orderNotice({sender, target, text, guard, now: 60000, ...more});
      let empty = ''; try { ask('lsrc:9','sandman:0','3066 DONE',{anyway:' '}); } catch (e) { empty = e.message; }
      return {done: ask('lsrc:9','sandman:0','3066 DONE: x'), stopped: ask('lsrc:9','sandman:0','[from lsrc:9]\n\n3066 STOPP: y'), over: ask('lsrc:9','sandman:0','3058 red'),
        reasoned: ask('lsrc:9','sandman:0','3066 DONE', {anyway:'emergency'}),
        pass: [ask('sandman:0','lsrc:9','3058 red'), ask('deep:5','lsrc:9','3058 red'),
          ask('lsrc:9','lsrc:9','3058 red'), ask('lsrc:9','deep:5','3058 red'),
          ...['Read 2026-11-16T10:18Z', 'Since 16 Nov 2026', '2026 px', 'at 10:18Z 2026 ms'].map(text => ask('lsrc:9','sandman:0',text)),
          ask('lsrc:9','sandman:0','3066 DONE', {now:660000}), ask('lsrc:9','sandman:0','3066 DONE', {guard: null})],
        empty};
    }],
    then: ['the notice names the rule, the row and the command; a reason no longer hides the rule; exemptions carry nothing', r => {
      expect(r.done).toEqual({rule: 'ticket', row: '3066', count: null, limit: null, words: '3066 done belongs in the ticket',
        told: '3066 done belongs in the ticket, not in a message to sandman:0: `ticket done 3066 --proof SHA`. sandman:0 reads it there.'});
      expect(r.stopped.told).toBe('3066 blocked belongs in the ticket, not in a message to sandman:0: `ticket blocked 3066 --needs "what must happen"`. sandman:0 reads it there.');
      expect(r.over).toEqual({rule: 'talk', row: '3058', count: 9, limit: 6, words: 'row 3058 has drawn 9 messages, limit 6',
        told: 'row 3058 has drawn 9 messages since its last landed commit (limit 6). Read the code and write `ticket cause 3058 --at FILE:LINE`, or write to its planner.'});
      expect(r.reasoned.rule).toBe('ticket'); expect(r.pass).toEqual(Array(r.pass.length).fill(null)); expect(r.empty).toContain('--anyway requires'); }],
  });
  component('the mark keeps the rule whole and cuts only the reason, and sits between the sender header and the text', {
    given: ['a ticket notice and a reason of 300 characters with brackets and a line break', () => ({notice: {words: '2987 done belongs in the ticket', told: 'T.'}, long: `live [prod]\nis down ${'x'.repeat(280)}`})],
    when: ['building the mark, the pane text and the sender lines', ({notice, long}) => ({bare: orderMark(notice), short: orderMark(notice, 'live is down'), cut: orderMark(notice, long),
      text: markedPaneText('[from lsrc:9]\n\n2987 DONE: x', [orderMark(notice, 'live is down')]), slash: markedPaneText('/usage', [orderMark(notice)]), none: markedPaneText('[from lsrc:9]\n\nhello', []),
      lines: senderLines(notice, {flag: '--anyway', marked: true, went: 'Delivered'}), raw: senderLines(notice, {reason: 'r', flag: '--fanout', marked: false, went: 'Queued durably'})})],
    then: ['one bracketed line of at most 160 characters; a raw slash command and an unmarked send are untouched', r => {
      expect(r.bare).toBe('[outside the order: 2987 done belongs in the ticket]');
      expect(r.short).toBe('[outside the order: 2987 done belongs in the ticket; reason: live is down]');
      expect(r.cut).toHaveLength(160); expect(r.cut).toMatch(/^\[outside the order: 2987 done belongs in the ticket; reason: live \(prod\) is down x+…\]$/u);
      expect(r.text).toBe('[from lsrc:9]\n[outside the order: 2987 done belongs in the ticket; reason: live is down]\n\n2987 DONE: x');
      expect(r.slash).toBe('/usage'); expect(r.none).toBe('[from lsrc:9]\n\nhello');
      expect(r.lines).toEqual(['Outside the order: T.', 'Delivered with AMUX\'s mark ahead of your text, and logged without a reason (give one with --anyway "reason"). Outside the order is for emergencies.']);
      expect(r.raw).toEqual(['Outside the order: T.', 'Queued durably unmarked, as a slash command, and logged with your reason. Outside the order is for emergencies.']); }],
  });
});
