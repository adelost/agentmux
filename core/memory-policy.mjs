import { existsSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

export const DEFAULT_MEMORY_POLICY = Object.freeze({
  memoryMaxBytes: 4 * 1024,
  peopleIndexMaxLines: 300,
  recentDailyDays: 30,
  recentDailyMaxLines: 100,
  recentDailyTargetLines: 20,
  oldDailyMaxLines: 30,
  oldDailyTargetLines: 5,
  referenceMaxLines: 500,
  peopleDetailMaxLines: 500,
  maxCompactions: 3,
  dreamBlockMaxLines: 10,
});

const POSITIVE_KEYS = new Set(Object.keys(DEFAULT_MEMORY_POLICY));

export function loadMemoryPolicy(workspace, { policyPath } = {}) {
  const path = policyPath || join(workspace, "memory", ".memory-policy.yaml");
  if (!existsSync(path)) return { ...DEFAULT_MEMORY_POLICY };
  const raw = yaml.load(readFileSync(path, "utf-8"));
  if (raw == null) return { ...DEFAULT_MEMORY_POLICY };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: policy must be a YAML mapping`);
  }

  const policy = { ...DEFAULT_MEMORY_POLICY };
  for (const [key, value] of Object.entries(raw)) {
    if (!POSITIVE_KEYS.has(key)) throw new Error(`${path}: unknown policy key "${key}"`);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${path}: ${key} must be a positive integer`);
    }
    policy[key] = value;
  }
  if (policy.oldDailyTargetLines >= policy.oldDailyMaxLines) {
    throw new Error(`${path}: oldDailyTargetLines must be below oldDailyMaxLines`);
  }
  if (policy.recentDailyTargetLines >= policy.recentDailyMaxLines) {
    throw new Error(`${path}: recentDailyTargetLines must be below recentDailyMaxLines`);
  }
  return policy;
}

export function localDateKey(now = new Date(), timeZone = "Europe/Stockholm") {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function dateKeyDaysAgo(days, now = new Date(), timeZone = "Europe/Stockholm") {
  return localDateKey(new Date(now.getTime() - days * 24 * 3600 * 1000), timeZone);
}

export function dailyPolicyFor(dateKey, policy, now = new Date()) {
  const today = localDateKey(now);
  const yesterday = dateKeyDaysAgo(1, now);
  if (dateKey === today || dateKey === yesterday) return { protected: true };

  const recentCutoff = dateKeyDaysAgo(policy.recentDailyDays, now);
  if (dateKey >= recentCutoff) {
    return {
      protected: false,
      maxLines: policy.recentDailyMaxLines,
      targetLines: policy.recentDailyTargetLines,
      ageBand: `2-${policy.recentDailyDays}d`,
    };
  }
  return {
    protected: false,
    maxLines: policy.oldDailyMaxLines,
    targetLines: policy.oldDailyTargetLines,
    ageBand: `>${policy.recentDailyDays}d`,
  };
}
