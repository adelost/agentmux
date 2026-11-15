/** WHAT: Returns the Fable quota window of a successful Claude reading.
 * WHY: Keeps other model windows out of Fable history and advice. */
export const fableQuotaOf = account => account?.ok && account.provider === 'claude'
  ? account.limits?.find(limit => limit.kind === 'weekly_scoped' && (limit.id === 'weekly_fable' || limit.scopeName === 'Fable')) : null;

/** WHAT: Returns the measured week points for a full Fable reset.
 * WHY: Keeps an unmeasured plan from acquiring Ultra's measured value. */
export const fableFullWeekPoints = subscription => subscription?.planTier?.toLowerCase() === 'ultra' ? 50 : null;
