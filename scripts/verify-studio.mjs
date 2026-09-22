import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const studioRoot=path.resolve(process.env.STUDIO_ROOT??path.join(root,'../circlekit/product-studio'));
const [{Workbench},{loadContractEvaluator}]=await Promise.all([
  import(pathToFileURL(path.join(studioRoot,'lib/workspaces.mjs')).href),
  import(pathToFileURL(path.join(studioRoot,'lib/documentation.mjs')).href),
]);
const evaluateContract=await loadContractEvaluator(root);
const workbench=new Workbench({dataDir:path.join(os.tmpdir(),'amux-studio-evidence-smoke'),evaluateContract});
await workbench.initialize([root],{includeFixtures:false});
const project=workbench.list().find(candidate=>candidate.id==='amux-link');
assert(project,'studio.workspace.json did not load amux-link.');
const owner=workbench.require(project.key),view=workbench.view(owner);
assert.equal(view.product?.id,'agentmux-link');
assert(view.architecture.coverage.owners>0,'Link artifact exposes no owners.');
const services=view.documentation.contracts.filter(contract=>contract.kind==='service');
assert.equal(services.length,11,'Expected the eleven reviewed Link service declarations.');
assert(services.every(contract=>contract.contract.status==='validated'),'Every Link service intent must pass AMUX grammar.');
const laws=view.documentation.reports.find(report=>report.run?.framework==='product-spec-laws');
assert(laws,'Run `node studio.mjs laws --product amux-link --output test-results/link-laws.json` before this smoke.');
assert.equal(laws.modelCorrelation,'same-model','Generated laws belong to a different model.');
assert(laws.summary.passed>0,'No declaration law was actually evaluated.');
assert.equal(laws.summary.failed,0,'At least one declaration law failed.');
console.log(JSON.stringify({
  product:view.productId,owners:view.architecture.coverage.owners,
  services:services.length,laws:laws.summary,modelCorrelation:laws.modelCorrelation,
},null,2));
