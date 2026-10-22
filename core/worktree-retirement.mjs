import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { processPathReferences, receiptPathReferences } from "./process-path-references.mjs";

const DAY = 86400000;
const git = (common, args) => execFileSync("git", [`--git-dir=${common}`, ...args],
  {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:30000}).trim();
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const inside = (path, root) => path === root || path.startsWith(`${root}/`);

/** WHAT: Reads the newest non-dependency metadata timestamp. WHY: Prevents recent source, ignored output or directory changes from being retired. */
export function worktreeLastChange(root) {
  let latest = 0;
  function visit(path) {
    const stat = lstatSync(path);
    latest = Math.max(latest, stat.mtimeMs, stat.ctimeMs);
    if (stat.isDirectory()) for (const name of readdirSync(path)) {
      if (name !== "node_modules") visit(join(path, name));
    }
  }
  visit(root);
  return latest;
}

/** WHAT: Reads live worktree identities. WHY: Keeps branch, lock and HEAD evidence tied to Git's registered checkout. */
export function registeredWorktrees(common) {
  return git(common,["worktree","list","--porcelain"]).split("\n\n").slice(1)
    .filter((block)=>block.trim()).map((block)=>({
      path:/^worktree (.+)$/mu.exec(block)?.[1], sha:/^HEAD (\w+)$/mu.exec(block)?.[1],
      branch:/^branch refs\/heads\/(.+)$/mu.exec(block)?.[1],
      locked:/^locked(?: |$)/mu.test(block),
    }));
}

/** WHAT: Names the folders whose recent receipts and units can bind a checkout. WHY: Keeps the janitor and the disk cleanup on one protected set. */
export const retirementReceiptRoots=(home)=>[join(home,"lsrc/.artifacts"),join(home,"lsrc/.agents"),
  join(home,".openclaw/workspace/projects"),join(home,".agentmux"),join(home,".config/systemd/user"),"/tmp"];

/** WHAT: Reads recent source-root bindings from receipts and units. WHY: Keeps the earlier cleanup's protected release and qualification roots alive. */
export function receiptReferences(targets, roots, {now=Date.now()}={}) {
  return receiptPathReferences(targets,roots,now);
}

/** WHAT: Reads complete process and receipt evidence. WHY: Prevents an unreadable safety boundary from authorizing removal. */
export function retirementSafety(common, roots, now=Date.now(), targets=registeredWorktrees(common).map(({path})=>path)) {
  const processes=processPathReferences(targets);
  const allRoots=[...new Set([...roots,...targets])];
  const minimalRoots=allRoots.filter((path)=>!allRoots.some((other)=>other!==path&&inside(path,other)));
  const receipts=receiptReferences(targets,minimalRoots,{now});
  return {holders:processes.holders,protectedPaths:receipts.protectedPaths,
    errors:[...processes.errors,...receipts.errors]};
}

// v2-live is the davinci-resolve skill's default CUTKIT_TOOLS path, so no process or receipt names it.
const PROTECTED_CHECKOUTS=new Set(["skyvw0-verify","v2-live"]);

/** WHAT: Checks whether a fetched origin ref contains a commit. WHY: Lets a pushed branch or detached HEAD be restored after its checkout is gone. */
export function onOrigin(common,sha) {
  try {return git(common,["for-each-ref","--count=1","--contains",sha,"--format=%(refname)","refs/remotes/origin"])!=="";}
  catch {return false;}
}

/** WHAT: Checks the cheap Git identity of a checkout. WHY: Lets callers narrow candidates before the process and receipt scan. */
export function checkoutReasons({common,candidate}) {
  const reasons=[]; const {path,sha}=candidate;
  if(!sha || candidate.locked) reasons.push("missing HEAD or locked");
  if(PROTECTED_CHECKOUTS.has(path.split("/").at(-1))) reasons.push("protected checkout");
  try {if(realpathSync(path)!==resolve(path)) reasons.push("noncanonical checkout path");}
  catch {reasons.push("missing checkout");}
  if(sha && !onOrigin(common,sha)) reasons.push("not pushed or merged");
  return reasons;
}

/** WHAT: Checks process and receipt evidence for one checkout. WHY: Keeps active or referenced checkouts intact whatever their Git state. */
function safetyReasons(path,safety) {
  const reasons=[];
  if(safety.errors.length) reasons.push("unreadable process or receipt evidence");
  if(!Array.isArray(safety.holders[path])) reasons.push("no process evidence for this checkout");
  else if(safety.holders[path].length) reasons.push("process cwd, fd or mapping inside");
  if(safety.protectedPaths.some((root)=>inside(root,path)||inside(path,root))) reasons.push("recent receipt or guard source root");
  return reasons;
}

/** WHAT: Checks the complete retirement contract against current facts. WHY: Keeps unpushed, dirty, active, referenced or recently changed worktrees intact. */
export function retirementEligibility({common,candidate,now=Date.now(),safety}) {
  const reasons=[...safetyReasons(candidate.path,safety),...checkoutReasons({common,candidate})];
  if(reasons.length) return {ok:false,reasons};
  try {
    const status=execFileSync("git",["-C",candidate.path,"status","--porcelain","--untracked-files=all"],{encoding:"utf8",timeout:30000});
    if(status.trim()) reasons.push("dirty");
    if(now-worktreeLastChange(candidate.path)<DAY) reasons.push("non-dependency change within 24h");
  } catch(error) {reasons.push(`unreadable checkout: ${error.message}`);}
  return {ok:reasons.length===0,reasons};
}

/** WHAT: Collects candidates admitted by every retirement guard. WHY: Keeps unsafe worktrees out of the single acting decision cell. */
export function retirableWorktrees({common,now,safety,onSkipped=()=>{},candidates=registeredWorktrees(common)}) {
  return candidates.filter((candidate)=>{
    const verdict=retirementEligibility({common,now,safety,candidate});
    if(!verdict.ok) onSkipped({target:candidate.path,reasons:verdict.reasons});
    return verdict.ok;
  })
    .map(({path,sha,branch:name})=>({kind:"RETIRABLE_WORKTREE",target:path,sha,ageDays:Math.floor((now-worktreeLastChange(path))/DAY),
      restore:`git -C ${quote(dirname(common))} worktree add --detach ${quote(path)} ${quote(sha)}${name?` # original branch ${name}`:""}`}));
}

/** WHAT: Appends and syncs one action receipt. WHY: Keeps the restore command durable before Git can remove a checkout. */
function journalEntry(path,entry) {
  mkdirSync(dirname(path),{recursive:true});
  const fd=openSync(path,"a",0o600);
  try {appendFileSync(fd,`${JSON.stringify(entry)}\n`); fsyncSync(fd);} finally {closeSync(fd);}
}

/** WHAT: Dispatches only the retirement cell after fresh checks. WHY: Prevents the report's other would-actions from deleting branches, plans or ledgers. */
export function retireWorktrees({review,journal,now=Date.now(),safety,receiptRoots=[],readProcesses=processPathReferences}) {
  return retireCheckouts({common:review.common,journal,now,safety:safety??retirementSafety(review.common,receiptRoots,now),readProcesses,
    retirements:review.decisions.filter(({values})=>values.action==="RETIRE_WORKTREE")});
}

/** WHAT: Dispatches planned checkout removals after a fresh process and eligibility check. WHY: Keeps one journaled, never-forced removal path for the janitor and the disk cleanup. */
export function retireCheckouts({common,retirements,journal,now=Date.now(),safety,readProcesses=processPathReferences,cell="amux.repo-hygiene/worktree.retire"}) {
  const results=[];
  for(const planned of retirements) {
    const candidate=registeredWorktrees(common).find(({path})=>path===planned.target);
    const processes=readProcesses([planned.target]);
    const fresh={...safety,holders:processes.holders,errors:[...safety.errors,...processes.errors]};
    const verdict=candidate && retirementEligibility({common,candidate,now,safety:fresh});
    const entry={at:new Date(now).toISOString(),cell,target:planned.target,
      sha:planned.sha,restore:planned.restore,mode:"skipped",reasons:verdict?.reasons??["worktree no longer registered"]};
    if(!verdict?.ok || candidate.sha!==planned.sha) {journalEntry(journal,entry); results.push(entry);continue;}
    journalEntry(journal,{...entry,mode:"attempting"});
    try {
      git(common,["worktree","remove",planned.target]);
      entry.mode="removed";
    } catch(error) {entry.mode="refused";entry.reasons=[error.stderr?.toString().trim()||error.message];}
    journalEntry(journal,entry);results.push(entry);
  }
  return results;
}
