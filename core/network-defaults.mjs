import net from "node:net";

// lsrc:0 and api:0 2026-10-21: Claude W's quota reads failed with "ETIMEDOUT 160.79.104.10; ENETUNREACH 2607:6bc0::10",
// and at 07:36Z a rotation refused Claude W as target-access-unverified:network_error. IPv6 has no route here, and about
// one IPv4 connect in 40 lost its SYN, which the kernel resends after 1 s and again at 3 s. Node gave the first address
// 250 ms, then tried IPv6, which failed at once; curl waited out the resend and succeeded.
/** WHAT: Defines how long a connect waits on one address before it tries the next. WHY: Keeps two lost SYNs from failing a read. */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 3_500;

/** WHAT: Assigns this process's connect wait per address. WHY: Keeps the bridge and the CLI on one connect policy. */
export function applyNetworkDefaults(assign = net.setDefaultAutoSelectFamilyAttemptTimeout) {
  assign(CONNECT_ATTEMPT_TIMEOUT_MS);
}
