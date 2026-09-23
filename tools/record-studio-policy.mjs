import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { contextCostDecision } from '../policies/context-cost.mjs';

const doctor=JSON.parse(execFileSync('v1d-studio',['doctor','--product','amux'],{encoding:'utf8'}));
const project=doctor.projects.find(project=>project.id==='amux');
assert(project?.compiler.simulate,'The installed Studio must load AMUX with its locked ProductSpec.');

const cases=[
  [{tokens:80000,idleMs:7200000,safe:true,attempt:'NEW'},'within-policy','CONTINUE'],
  [{tokens:120000,idleMs:7200000,safe:true,attempt:'NEW'},'compact-once','COMPACT'],
  [{tokens:120000,idleMs:7200000,safe:true,attempt:'FAILED'},'failed-attempt','HOLD'],
];
const events=cases.map(([facts,cell,action])=>{
  const decision=contextCostDecision(facts);
  assert.equal(decision.cell,cell);
  assert.equal(decision.values.action,action);
  return {kind:'decision',
    entityKey:`cell:decision-table%2Famux.context-cost:${decision.cell}`,
    summary:`Context policy chose ${action.toLowerCase()} for ${decision.cell}.`,
    logic:{facetId:'amux.context-cost',cellId:decision.cell,facts:decision.at,values:decision.values}};
});
const trace={kind:'product-studio-trace',version:1,modelDigest:project.modelDigest,events};
await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await writeFile(new URL('../test-results/amux-studio-trace.json',import.meta.url),JSON.stringify(trace,null,2)+'\n');
console.log(`Recorded ${events.length} real context-cost decisions for Product Studio.`);
