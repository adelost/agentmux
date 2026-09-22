import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateContract } from '../core/contract-lint.mjs';

/**
 * WHAT: Parses the explicit workspace and Studio paths for service contract checks.
 * WHY: Keeps authoring checks separate from bridge startup and arbitrary command execution.
 */
export function contractArguments(args, cwd = process.cwd()) {
  const options={}, positional=[];
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--help')return {help:true};
    if(arg==='--pretty') {if(options.pretty)throw new Error('Duplicate --pretty.');options.pretty=true;continue;}
    if(['--studio-root','--product'].includes(arg)) {
      const key=arg.slice(2),value=args[++i];
      if(options[key]!==undefined||!value||value.startsWith('--'))throw new Error(`Missing or repeated ${arg}.`);
      options[key]=value;
    } else if(arg.startsWith('-'))throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if(positional.length>1)throw new Error('Choose one repository root.');
  const ownRoot=fileURLToPath(new URL('../',import.meta.url));
  return {root:path.resolve(cwd,positional[0]??cwd),product:options.product,pretty:!!options.pretty,
    studioRoot:path.resolve(cwd,options['studio-root']??path.join(ownRoot,'../circlekit/product-studio'))};
}

/**
 * WHAT: Applies the existing AMUX wording floor to every discovered ProductSpec service.
 * WHY: Keeps one grammar authority while Studio supplies exact service and comment locations.
 */
export async function checkProductContracts(options, scan) {
  const report=await scan(options.root,{product:options.product,evaluateContract});
  const findings=report.projects.flatMap(p=>p.diagnostics);
  return {...report,ok:report.ok&&!findings.some(d=>['error','warning'].includes(d.severity)),
    policy:'Existing AMUX evaluateContract; service presence and source scope from Product Studio.',
    strict:true};
}

/**
 * WHAT: Reports service contract failures without starting the bridge or changing repository files.
 * WHY: Keeps documentation enforcement on the manual authoring path rather than production startup.
 */
export async function main(args=process.argv.slice(2), {cwd=process.cwd(),write=s=>process.stdout.write(s)}={}) {
  try {
    const options=contractArguments(args,cwd);
    if(options.help){write('node tools/product-contracts.mjs /path/to/product [--studio-root /path/to/circlekit/product-studio] [--product ID] [--pretty]\nRead-only. Requires Node 22+ and installed Studio dependencies. No build, test, bridge, or model is started.\n');return 0;}
    if(Number(process.versions.node.split('.')[0])<22)throw new Error('This Studio authoring command requires Node 22 or later; bridge requirements are unchanged.');
    let scanner;
    try {scanner=await import(pathToFileURL(path.join(options.studioRoot,'lib/documentation.mjs')).href);}
    catch(error){throw new Error(`Cannot load the shared Studio scanner. Run npm ci in product-studio and pass --studio-root to its installed checkout. ${error.code??''}`);}
    if(typeof scanner.checkWorkspaceContracts!=='function')throw new Error('Studio is missing checkWorkspaceContracts; use the living-documentation PR.');
    const report=await checkProductContracts(options,scanner.checkWorkspaceContracts);
    write(JSON.stringify(report,null,options.pretty?2:undefined)+'\n');return report.ok?0:1;
  } catch(error){write(JSON.stringify({ok:false,error:{code:error.code??'contracts.failed',message:error.message}})+'\n');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(code=>{process.exitCode=code;});
