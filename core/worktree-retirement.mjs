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

/** WHAT: Checks the complete retirement contract against current facts. WHY: Keeps merged but dirty, active, referenced or recently changed worktrees intact. */
export function retirementEligibility({common,branch,candidate,now=Date.now(),safety}) {
  const reasons=[]; const {path,sha}=candidate;
  if(!candidate.branch || !sha || candidate.locked) reasons.push("detached, missing HEAD or locked");
  if(path.split("/").at(-1)==="skyvw0-verify") reasons.push("protected verification checkout");
  if(safety.errors.length) reasons.push("unreadable process or receipt evidence");
  if((safety.holders[path]??[]).length) reasons.push("process cwd, fd or mapping inside");
  if(safety.protectedPaths.some((root)=>inside(root,path)||inside(path,root))) reasons.push("recent receipt or guard source root");
  try {
    if(realpathSync(path)!==resolve(path)) reasons.push("noncanonical checkout path");
    if(git(common,["merge-base","--is-ancestor",sha,`origin/${branch}`])!=="") reasons.push("not merged and pushed");
  } catch { reasons.push("not merged and pushed"); }
  if(reasons.length) return {ok:false,reasons};
  try {
    const status=execFileSync("git",["-C",path,"status","--porcelain","--untracked-files=all"],{encoding:"utf8",timeout:30000});
    if(status.trim()) reasons.push("dirty");
    if(now-worktreeLastChange(path)<DAY) reasons.push("non-dependency change within 24h");
  } catch(error) {reasons.push(`unreadable checkout: ${error.message}`);}
  return {ok:reasons.length===0,reasons};
}

/** WHAT: Collects candidates admitted by every retirement guard. WHY: Keeps unsafe worktrees out of the single acting decision cell. */
export function retirableWorktrees({common,branch,now,safety,onSkipped=()=>{}}) {
  return registeredWorktrees(common).filter((candidate)=>{
    const verdict=retirementEligibility({common,branch,now,safety,candidate});
    if(!verdict.ok) onSkipped({target:candidate.path,reasons:verdict.reasons});
    return verdict.ok;
  })
    .map(({path,sha,branch:name})=>({kind:"RETIRABLE_WORKTREE",target:path,sha,ageDays:Math.floor((now-worktreeLastChange(path))/DAY),
      restore:`git -C ${quote(dirname(common))} worktree add --detach ${quote(path)} ${quote(sha)} # original branch ${name}`}));
}

/** WHAT: Appends and syncs one action receipt. WHY: Keeps the restore command durable before Git can remove a checkout. */
function journalEntry(path,entry) {
  mkdirSync(dirname(path),{recursive:true});
  const fd=openSync(path,"a",0o600);
  try {appendFileSync(fd,`${JSON.stringify(entry)}\n`); fsyncSync(fd);} finally {closeSync(fd);}
}

/** WHAT: Dispatches only the retirement cell after fresh checks. WHY: Prevents the report's other would-actions from deleting branches, plans or ledgers. */
export function retireWorktrees({review,journal,now=Date.now(),safety,receiptRoots=[],readProcesses=processPathReferences}) {
  const results=[]; const snapshot=safety??retirementSafety(review.common,receiptRoots,now);
  for(const decision of review.decisions.filter(({values})=>values.action==="RETIRE_WORKTREE")) {
    const candidate=registeredWorktrees(review.common).find(({path})=>path===decision.target);
    const processes=readProcesses([decision.target]);
    const fresh={...snapshot,holders:processes.holders,errors:[...snapshot.errors,...processes.errors]};
    const verdict=candidate && retirementEligibility({common:review.common,branch:review.branch,candidate,now,safety:fresh});
    const entry={at:new Date(now).toISOString(),cell:"amux.repo-hygiene/worktree.retire",target:decision.target,
      sha:decision.sha,restore:decision.restore,mode:"skipped",reasons:verdict?.reasons??["worktree no longer registered"]};
    if(!verdict?.ok || candidate.sha!==decision.sha) {journalEntry(journal,entry); results.push(entry);continue;}
    journalEntry(journal,{...entry,mode:"attempting"});
    try {
      git(review.common,["worktree","remove",decision.target]);
      entry.mode="removed";
    } catch(error) {entry.mode="refused";entry.reasons=[error.stderr?.toString().trim()||error.message];}
    journalEntry(journal,entry);results.push(entry);
  }
  return results;
}
