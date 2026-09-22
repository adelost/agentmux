import { test, expect } from 'vitest';
import { contractArguments, checkProductContracts } from '../tools/product-contracts.mjs';

test('Given two workspaces When parsing a contract command Then it refuses an ambiguous root',()=>{
  expect(()=>contractArguments(['first','second'])).toThrow('one repository');
  expect(()=>contractArguments(['--unknown'])).toThrow('Unknown option');
});
test('Given an explicit Studio checkout When parsing options Then paths and selection stay explicit',()=>{
  const options=contractArguments(['app','--studio-root','kit/product-studio','--product','amux-link'],'/workspace');
  expect(options.root).toBe('/workspace/app');expect(options.studioRoot).toBe('/workspace/kit/product-studio');
  expect(options.product).toBe('amux-link');
});
test('Given a service contract When the shared scanner calls its evaluator Then AMUX owns the actual wording findings',async()=>{
  const report=await checkProductContracts({root:'/workspace/app'},async(root,{evaluateContract})=>{
    expect(root).toBe('/workspace/app');
    const good=evaluateContract('WHAT: Routes capture commands to the recording owner.\nWHY: Keeps microphone effects outside conversation delivery.',{name:'capture',kind:'service'});
    expect(good).toEqual([]);
    const bad=evaluateContract('WHAT: Handles things.\nWHY: Makes everything nice.',{name:'capture',kind:'service'});
    expect(bad.some(d=>d.code==='CONTRACT030')).toBe(true);
    return {ok:true,projects:[{diagnostics:bad.map(d=>({severity:d.sev==='error'?'error':'warning'}))}]};
  });
  expect(report.ok).toBe(false);expect(report.strict).toBe(true);
});
