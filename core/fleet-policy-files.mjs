import { fileURLToPath } from "node:url";

// WHAT: Resolves a demand-read rule file. WHY: Prevents generated links and reminders from resolving inside the caller's project instead of the installed package.
export const fleetPolicyFile = (name) => fileURLToPath(new URL(`../docs/fleet/${name}`, import.meta.url));
