/** WHAT: Builds one non-overlapping hourly guard loop. WHY: Prevents a slow check from creating concurrent alarm sweeps. */
export async function watchStateAge(check, { interval = setInterval, log = console.error } = {}) {
  await check();
  let active = false;
  return interval(async () => {
    if (active) return;
    active = true;
    try { await check(); }
    catch (error) { log(`state-age check failed: ${error.message}`); }
    finally { active = false; }
  }, 3600000);
}
