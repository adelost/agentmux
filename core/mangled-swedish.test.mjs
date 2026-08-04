import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  MIN_PARAGRAPH_WORDS,
  MIN_SWEDISH_MARKERS,
  describeManglingRisk,
  findManglingRisk,
  findManglingRiskInPayload,
} from "./mangled-swedish.mjs";

// Taken from the real outbox corpus, then re-accented so the pair differs in
// nothing but the diacritics. Both halves must be judged, or the check is only
// half tested. Every fixture below clears MIN_PARAGRAPH_WORDS deliberately: a
// negative fixture that is merely too short proves nothing about the language
// test, it only proves the length floor, and it would still pass if the Swedish
// detection were deleted outright.
const MANGLED = "Laget ar systemiskt, inte ticket-specifikt: NOLL av projektets 100 tickets "
  + "har state=approved eftersom gaten ar retroaktiv, och 11 ready-tickets ar blockerade "
  + "likadant. Att watchdogen anda eskalerar gor att den larmar om nagot ingen agent kan "
  + "atgarda, vilket bara flyttar arbetet till den som lases av larmet utan att nagon "
  + "enda ticket blir mojlig att starta.";
const CLEAN = "Läget är systemiskt, inte ticket-specifikt: NOLL av projektets 100 tickets "
  + "har state=approved eftersom gaten är retroaktiv, och 11 ready-tickets är blockerade "
  + "likadant. Att watchdogen ändå eskalerar gör att den larmar om något ingen agent kan "
  + "åtgärda, vilket bara flyttar arbetet till den som låses av larmet utan att någon "
  + "enda ticket blir möjlig att starta.";

const ENGLISH = "The admission gate returns 409 product-approval-required for every ticket "
  + "in this project, and the watchdog escalates anyway, so it alarms about work that no "
  + "agent can start. That is the whole finding, and it is not ticket specific: none of "
  + "the hundred tickets carry an approved state, because the gate was applied "
  + "retroactively and nothing was migrated behind it.";

const TECHNICAL = "core/suggestions-authoring.mjs assertVerbatimSources(bodyBytes, "
  + "expectedBytes) throws when a declared source is absent from the request body; "
  + "stageSuggestionsRequest then writes ${mutationId}.body.json with flag wx and mode "
  + "0o600 under stateDir, and recordAttempt rewrites the envelope to rejected, "
  + "send_failed, applied_unverified or acknowledged depending on which exit was taken.";

describe("mangled Swedish detection", () => {
  it("flags a fully mangled Swedish paragraph", () => {
    const findings = findManglingRisk(MANGLED);
    expect(findings).toHaveLength(1);
    expect(findings[0].markers.length).toBeGreaterThanOrEqual(3);
  });

  it("clears the identical paragraph once its diacritics are back", () => {
    expect(findManglingRisk(CLEAN)).toEqual([]);
  });

  // The criterion says ONE diacritic anywhere clears the paragraph. This is the
  // boundary ai:0 named: a paragraph that is otherwise mangled but kept a single
  // a-ring must pass, because partial mangling is not the failure being hunted
  // and guessing at it is how a check starts crying wolf.
  it("clears a mangled paragraph where a single word kept its diacritic", () => {
    const oneSurvivor = MANGLED.replace("nagot", "något");
    expect(oneSurvivor).toContain("å");
    expect(findManglingRisk(oneSurvivor)).toEqual([]);
  });

  // Calibration: if a negative fixture ever drops under the length floor it
  // passes for the wrong reason, so the floor is asserted before the verdict.
  it.each([["English", ENGLISH], ["technical", TECHNICAL]])(
    "does not flag %s prose that is long enough to be judged", (_label, text) => {
      expect(text.match(/[\p{L}]+/gu).length).toBeGreaterThanOrEqual(MIN_PARAGRAPH_WORDS);
      expect(findManglingRisk(text)).toEqual([]);
    },
  );

  it("judges the mangled fixture on language, not on length", () => {
    expect(MANGLED.match(/[\p{L}]+/gu).length).toBeGreaterThanOrEqual(MIN_PARAGRAPH_WORDS);
  });

  // Short, entirely correct Swedish without diacritics was the dominant false
  // alarm before the floor was measured in. It must stay silent.
  it("stays silent on short correct Swedish that never needed a diacritic", () => {
    expect(findManglingRisk("PR #49 mergad som e94f730d och finns i live-builden.")).toEqual([]);
    expect(findManglingRisk("Janitorn ska trimma sessionsloggar per rad, inte radera hela filer")).toEqual([]);
  });

  it("ignores short strings that carry ids and labels, not prose", () => {
    expect(findManglingRisk("SVW-0110 blocked, se PR #49")).toEqual([]);
  });

  it("needs more than one shared word before calling a paragraph Swedish", () => {
    // "det" alone is coincidence; the threshold exists so it stays coincidence.
    const oneMarker = "The deployment det pipeline runs a clean checkout of the "
      + "release commit and verifies the served bundle hash before switching traffic, "
      + "then records the rollback commit so an operator can reverse it later without "
      + "reading any of this from a log file or asking whoever happened to deploy it.";
    expect(findManglingRisk(oneMarker)).toEqual([]);
  });

  it("judges each paragraph on its own, not the whole document", () => {
    const findings = findManglingRisk(`${CLEAN}\n\n${MANGLED}`);
    expect(findings).toHaveLength(1);
    expect(findings[0].paragraphIndex).toBe(1);
  });

  it("scans every string in a request payload, at any depth", () => {
    const payload = { ticketId: "AI-0026", nested: { rows: [{ reason: MANGLED }] } };
    expect(findManglingRiskInPayload(payload)).toHaveLength(1);
    expect(findManglingRiskInPayload({ reason: CLEAN })).toEqual([]);
  });

  it("renders a counted warning, and nothing at all when there is nothing to say", () => {
    expect(describeManglingRisk([])).toBeNull();
    const text = describeManglingRisk(findManglingRisk(MANGLED));
    expect(text).toContain("1 paragraph reads");
  });

  // The attestation is only worth something if it describes the code that ships.
  // Moving a threshold without re-measuring makes the booked number a claim about
  // a check nobody ran, so it fails here instead of quietly going stale.
  it("ships the exact thresholds the booked measurement was taken at", () => {
    const attestation = JSON.parse(readFileSync(
      fileURLToPath(new URL("../docs/mangled-swedish-measurement.json", import.meta.url)), "utf8",
    ));
    expect(MIN_PARAGRAPH_WORDS).toBe(attestation.thresholds.minParagraphWords);
    expect(MIN_SWEDISH_MARKERS).toBe(attestation.thresholds.minSwedishMarkers);
    expect(attestation.audit.atFloor8.flagged)
      .toBe(attestation.audit.atFloor8.trulyMangled + attestation.audit.atFloor8.falseAlarms);
    expect(attestation.headline.flagged).toBe(attestation.audit.atFloor40.flagged);
    expect(attestation.decision.mode).toBe('warn');
  });
});
