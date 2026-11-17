import { component, feature, expect } from 'bdd-vitest';
import { vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from './commands.mjs';
import { createState } from '../core/state.mjs';
import { createDeliveryQueue } from '../core/delivery-queue.mjs';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'amux-fanout-')), configPath=join(root,'agents.yaml');
  writeFileSync(configPath,['sender','lsrc','plan',...Array.from({length:6},(_,i)=>'target'+i)].map(name=>`${name}:\n  dir: ${root}\n  panes:\n    - name: claude\n      cmd: claude\n`).join(''));
  const previous={HOME:process.env.HOME,AMUX_AGENT_NAME:process.env.AMUX_AGENT_NAME,AMUX_PANE:process.env.AMUX_PANE,AMUX_EVENTS_PATH:process.env.AMUX_EVENTS_PATH};
  Object.assign(process.env,{HOME:root,AMUX_AGENT_NAME:'sender',AMUX_PANE:'0',AMUX_EVENTS_PATH:join(root,'events.jsonl')});
  const queue=createDeliveryQueue({rootDir:join(root,'queue')});
  const ctx={configPath,lastFile:join(root,'last'),state:createState(join(root,'state.json')),deliveryQueue:queue,projectHistory:()=>{}};
  const send=(n,...flags)=>dispatch(['target'+n,'-p','0','--wait-ms','0','-q',...flags,'work'],ctx);
  const count=()=>queue.allTargets().reduce((n,t)=>n+queue.list(t.agentName,t.pane).length,0);
  const jobs=n=>queue.list('target'+n,0);
  const events=name=>!existsSync(join(root,'events.jsonl'))?[]:readFileSync(join(root,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.event===name).map(({ts,event,...rest})=>rest);
  const said=[],log=vi.spyOn(console,'log').mockImplementation(line=>said.push(...String(line).split('\n'))),exitCode=process.exitCode;
  const exit=()=>process.exitCode??0;
  return {root,ctx,queue,send,count,jobs,events,said,exit,restore(){log.mockRestore();process.exitCode=exitCode;for(const[k,v]of Object.entries(previous))v===undefined?delete process.env[k]:process.env[k]=v;rmSync(root,{recursive:true,force:true});}};
}
const guardDir=root=>{const dir=join(root,'.local/state/fleet-orch');mkdirSync(dir,{recursive:true});return dir;};
const writeGuard=(root,guard)=>writeFileSync(join(guardDir(root),'guard.json'),typeof guard==='string'?guard:JSON.stringify({at:Date.now(),pilot:['sender:0'],leads:['target0:0'],over:{'3058':9},limit:6,...guard}));
const LOGGED_BARE=flag=>`Queued durably with AMUX's mark ahead of your text, and logged without a reason (give one with ${flag} "reason"). Outside the order is for emergencies.`;
const LOGGED_REASON="Queued durably with AMUX's mark ahead of your text, and logged with your reason. Outside the order is for emergencies.";
feature('panel send recipient budget',()=>{
  component('a fifth distinct recipient is delivered with a warning, never refused (Mattias 16 Nov 2026)',{
    given:['one configured sender and six isolated targets',fixture],
    when:['sending to four targets then a fifth without a flag',async f=>{try{for(let i=0;i<5;i++)await f.send(i);
      return{jobs:f.count(),inside:f.jobs(3)[0].text,outside:f.jobs(4)[0].text,said:f.said,events:f.events('panel_send_fanout'),exit:f.exit()};}finally{f.restore();}}],
    then:['five jobs, the mark ahead of the fifth text, the sender told, one event, exit 0',r=>{expect(r.jobs).toBe(5);expect(r.exit).toBe(0);
      expect(r.inside).toBe('[from sender:0]\n\nwork');
      expect(r.outside).toBe('[from sender:0]\n[outside the order: 5 recipients in 15 minutes, limit 4]\n\nwork');
      expect(r.said).toEqual(['Outside the order: target4:0 makes 5 different recipients in 15 minutes (limit 4). Contact only a panel that needs an action.',LOGGED_BARE('--fanout')]);
      expect(r.events).toEqual([{session:'sender',pane:0,target:'target4:0',reason:null,rule:'fanout',row:null,count:5,limit:4}]);}],
  });
  component('a fanout reason is carried in the mark and the event and decides nothing (Mattias 16 Nov 2026)',{
    given:['a sender at four distinct targets',fixture],
    when:['sending to a fifth with a reason, then a slash command to a sixth',async f=>{try{for(let i=0;i<4;i++)await f.send(i);await f.send(4,'--fanout','Release handoff to the five owners');
      await dispatch(['target5','-p','0','--wait-ms','0','-q','/usage'],f.ctx);
      return{jobs:f.count(),outside:f.jobs(4)[0].text,slash:f.jobs(5)[0].text,said:f.said,events:f.events('panel_send_fanout'),exit:f.exit()};}finally{f.restore();}}],
    then:['the reason is in the mark and the event; the slash command stays raw and is still told and logged',r=>{expect(r.jobs).toBe(6);expect(r.exit).toBe(0);
      expect(r.outside).toBe('[from sender:0]\n[outside the order: 5 recipients in 15 minutes, limit 4; reason: Release handoff to the five owners]\n\nwork');
      expect(r.slash).toBe('/usage');
      expect(r.said).toEqual(['Outside the order: target4:0 makes 5 different recipients in 15 minutes (limit 4). Contact only a panel that needs an action.',LOGGED_REASON,
        'Outside the order: target5:0 makes 6 different recipients in 15 minutes (limit 4). Contact only a panel that needs an action.',
        'Queued durably unmarked, as a slash command, and logged without a reason (give one with --fanout "reason"). Outside the order is for emergencies.']);
      expect(r.events).toEqual([{session:'sender',pane:0,target:'target4:0',reason:'Release handoff to the five owners',rule:'fanout',row:null,count:5,limit:4},
        {session:'sender',pane:0,target:'target5:0',reason:null,rule:'fanout',row:null,count:6,limit:4}]);}],
  });
  component('a blank exception never sends or attaches',{
    given:['one configured isolated target',fixture],
    when:['sending with an empty exception reason',async f=>{try{let error=null;try{await f.send(0,'--fanout=');}catch(e){error=e.message;}return{error,jobs:f.count()};}finally{f.restore();}}],
    then:['the reason is required before enqueue',r=>{expect(r.error).toContain('--fanout requires');expect(r.jobs).toBe(0);}],
  });
});

feature('an agent named as a command', () => {
  component('a send to the agent plan reaches its pane, not the plan command (17 Nov 2026: spawn claude ENOENT)', {
    given: ['a configured agent named plan', fixture],
    when: ['sending to its pane by name', async f => { try { await dispatch(['plan', '-p', '0', '--wait-ms', '0', '-q', 'work'], f.ctx);
      return { jobs: f.queue.list('plan', 0).map(job => job.text) }; } finally { f.restore(); } }],
    then: ['one job is queued for plan:0', r => { expect(r.jobs).toEqual(['[from sender:0]\n\nwork']); }],
  });
});

feature('panel order guard integration', () => {
  const to = (f, n, ...rest) => dispatch(['target' + n, '-p', '0', '--wait-ms', '0', '-q', ...rest], f.ctx);
  component('a pilot ROW DONE to a lead is delivered with a warning, never refused (Mattias 16 Nov 2026)', {
    given: ['a pilot sender and its local guard', () => { const f = fixture(); writeGuard(f.root, {}); return f; }],
    when: ['sending it without a flag, then with a reason', async f => { try { await to(f, 0, '3066 DONE: x'); await to(f, 0, '--anyway', 'live is down', '3066 BLOCKED: y');
      const [bare, reasoned] = f.jobs(0); return { bare: bare.text, reasoned: reasoned.text, cap: [bare.metadata.capAnyway, reasoned.metadata.capAnyway], said: f.said, events: f.events('panel_send_order'), exit: f.exit() };
    } finally { f.restore(); } }],
    then: ['both are queued with the mark ahead of the text, the sender is told the ticket command, each has its event, exit 0', r => { expect(r.exit).toBe(0);
      expect(r.bare).toBe('[from sender:0]\n[outside the order: 3066 done belongs in the ticket]\n\n3066 DONE: x');
      expect(r.reasoned).toBe('[from sender:0]\n[outside the order: 3066 blocked belongs in the ticket; reason: live is down]\n\n3066 BLOCKED: y');
      expect(r.cap).toEqual([undefined, 'live is down']);
      expect(r.said).toEqual(['Outside the order: 3066 done belongs in the ticket, not in a message to target0:0: `ticket done 3066 --proof SHA`. target0:0 reads it there.', LOGGED_BARE('--anyway'),
        'Outside the order: 3066 blocked belongs in the ticket, not in a message to target0:0: `ticket blocked 3066 --needs "what must happen"`. target0:0 reads it there.', LOGGED_REASON]);
      expect(r.events).toEqual([{ session: 'sender', pane: 0, target: 'target0:0', reason: null, rule: 'ticket', row: '3066', count: null, limit: null },
        { session: 'sender', pane: 0, target: 'target0:0', reason: 'live is down', rule: 'ticket', row: '3066', count: null, limit: null }]); }],
  });
  component('talk on a row over its limit is delivered with a warning, never refused (Mattias 16 Nov 2026)', {
    given: ['a pilot sender and a row with 9 messages against a limit of 6', () => { const f = fixture(); writeGuard(f.root, {}); return f; }],
    when: ['writing about the row to a builder, without a flag then with a reason', async f => { try { await to(f, 1, '3058 red again'); await to(f, 1, '--anyway', 'prod [live] is\ndown', '3058 still red');
      return { texts: f.jobs(1).map(job => job.text), said: f.said, events: f.events('panel_send_order'), exit: f.exit() };
    } finally { f.restore(); } }],
    then: ['both are queued with the row and its count in the mark, the sender and the log', r => { expect(r.exit).toBe(0);
      expect(r.texts).toEqual(['[from sender:0]\n[outside the order: row 3058 has drawn 9 messages, limit 6]\n\n3058 red again',
        '[from sender:0]\n[outside the order: row 3058 has drawn 9 messages, limit 6; reason: prod (live) is down]\n\n3058 still red']);
      expect(r.said).toEqual(['Outside the order: row 3058 has drawn 9 messages since its last landed commit (limit 6). Read the code and write `ticket cause 3058 --at FILE:LINE`, or write to its planner.', LOGGED_BARE('--anyway'),
        'Outside the order: row 3058 has drawn 9 messages since its last landed commit (limit 6). Read the code and write `ticket cause 3058 --at FILE:LINE`, or write to its planner.', LOGGED_REASON]);
      expect(r.events).toEqual([{ session: 'sender', pane: 0, target: 'target1:0', reason: null, rule: 'talk', row: '3058', count: 9, limit: 6 },
        { session: 'sender', pane: 0, target: 'target1:0', reason: 'prod [live] is\ndown', rule: 'talk', row: '3058', count: 9, limit: 6 }]); }],
  });
  component('a stale, malformed or foreign guard marks nothing, and the builder cap reason still reaches the job', {
    given: ['a sender the guard does not list as pilot', () => { const f = fixture(); writeGuard(f.root, { pilot: [] }); return f; }],
    when: ['sending under each guard, with the cap reason, and with a blank reason', async f => { try {
      await to(f, 0, '--anyway', 'urgent', '3066 DONE: x'); writeGuard(f.root, { at: Date.now() - 11 * 60_000 }); await to(f, 0, '3066 DONE: x');
      writeGuard(f.root, '{'); await to(f, 0, '3066 DONE: x'); writeGuard(f.root, {}); let blank = ''; try { await to(f, 0, '--anyway=', '3066 DONE: x'); } catch (e) { blank = e.message; }
      return { jobs: f.jobs(0).map(job => [job.text, job.metadata.capAnyway]), said: f.said, order: f.events('panel_send_order'), fault: f.events('panel_send_order_fault'), blank, exit: f.exit() };
    } finally { f.restore(); } }],
    then: ['three unmarked jobs, the cap reason on its job and in the log with no rule, one fault event, and the blank reason is a usage error', r => { expect(r.exit).toBe(0);
      expect(r.jobs).toEqual([['[from sender:0]\n\n3066 DONE: x', 'urgent'], ['[from sender:0]\n\n3066 DONE: x', undefined], ['[from sender:0]\n\n3066 DONE: x', undefined]]);
      expect(r.said).toEqual([]);
      expect(r.order).toEqual([{ session: 'sender', pane: 0, target: 'target0:0', reason: 'urgent', rule: null, row: null, count: null, limit: null }]);
      expect(r.fault).toEqual([{ session: 'sender', pane: 0, target: 'target0:0' }]); expect(r.blank).toContain('--anyway requires'); }],
  });
});
