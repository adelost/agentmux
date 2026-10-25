#!/usr/bin/env node
import { readWindow } from "../core/ask-ledger.mjs";

const address = /^([\w-]+):(\d+)$/u.exec(process.argv[2] || "");
if (!address || process.argv.length !== 3) throw Error("Usage: on-track-owner-log.mjs AGENT:PANE");
const at = Date.now();
const result = readWindow({ since: at - 86400000, until: at, agents: [address[1]] });
const latest = result.posts.filter(row => row.pane === Number(address[2]) && row.kind === "reply" && row.status === "sent").at(-1);
console.log(JSON.stringify({ owner: address[0], observedAt: new Date(at).toISOString(), latest: latest || null }));
if (!latest) process.exitCode = 1;
