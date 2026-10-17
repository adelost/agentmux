// The names the human reads for subscription accounts.
// Mattias 2026-10-17 13:04Z: "Bättre att kalla demd för claude wetterlind eller Claude W och Claude A.. tror faktist jag
// föredrar det egentlige... Claude W och Claude A.. och Codex A och Codex W ... överallt .. konsekvent.. gärna.."

const ENGINE_NAMES = Object.freeze({ claude: "Claude", codex: "Codex", kimi: "Kimi" });

/** WHAT: Returns the login an email names, "jane.doe@…" as "doe". WHY: Keeps a name to the part of the address he says. */
export const loginOfEmail = (email) => String(email || "").split("@")[0].split(".").at(-1).toLowerCase() || null;

/**
 * WHAT: Names an account by engine and login initial, or by the whole login when initials clash.
 * WHY: Keeps the name from following a slot, since slots drift from the login they run.
 */
export function accountName(account, accounts = [account]) {
  if (account?.name) return account.name;
  const engine = ENGINE_NAMES[account?.provider] || String(account?.provider || "Account");
  const login = loginOfEmail(account?.account?.email);
  // Without its login only the slot names it; that is what amux knows about the account.
  if (!login) return `${engine} ${account?.profile?.id ?? "?"}`;
  const shared = accounts.some((other) => other?.provider === account.provider
    && loginOfEmail(other?.account?.email)?.[0] === login[0] && loginOfEmail(other.account.email) !== login);
  return `${engine} ${shared ? login : login[0].toUpperCase()}`;
}

const LOGGED_OUT = new Set(["login_expired", "credentials_expired", "credentials_unavailable", "login_required"]);

/**
 * WHAT: Returns each account with its name and its login's subscription entry, also when its reading failed.
 * WHY: Keeps the box, amux quota and the stats board on one name and one renewal date per login.
 */
export function withAccountEntries(accounts, entries = new Map()) {
  // A logged-out login is no reason to spell out a live login that shares its initial.
  const peers = accounts.filter((account) => account.ok || !LOGGED_OUT.has(account.error));
  return accounts.map((account) => {
    const login = loginOfEmail(account.account?.email);
    const entry = login ? entries.get(`${account.provider}:${login}`) : null;
    return { ...account, name: entry?.name || accountName(account, peers),
      ...(entry?.subscription ? { subscription: entry.subscription } : {}) };
  });
}
