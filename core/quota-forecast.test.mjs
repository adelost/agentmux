import { feature, unit, expect } from "bdd-vitest";
import { formatWeeklyNotice, weeklyForecast, weeklyNoticeLevel } from "./quota-forecast.mjs";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-10T08:30:00Z");
const RESET = "2026-10-14T07:00:00Z"; // 94.5 h after NOW
const settings = { warnPercent: 80, urgentHours: 12, now: NOW };
const reading = (hoursAgo, usedPercent) => ({ at: NOW - hoursAgo * HOUR, usedPercent, resetsAt: RESET });
const adelost = [{ email: "adelost@gmail.com", usedPercent: 26, resetsAt: "2026-10-14T00:00:00Z" }];

const forecastFrom = (history) => weeklyForecast({ history, latest: history.at(-1), now: NOW });

feature("weekly quota forecast", () => {
  unit("a slow pace past the threshold asks for nothing", {
    given: ["82 % used, 1 point in the last 10 h, 180 h of room", () => forecastFrom([reading(10, 81), reading(0, 82)])],
    when: ["choosing the notice", (forecast) => ({ forecast, level: weeklyNoticeLevel(forecast, settings) })],
    then: ["the threshold notice says no action and names no switch", ({ forecast, level }) => {
      expect(forecast.lastsUntilReset).toBe(true);
      expect(level).toBe("threshold");
      const text = formatWeeklyNotice({ level, email: "mattias.wetterlind@gmail.com", forecast, alternatives: adelost, now: NOW });
      expect(text).toMatch(/^Claude mattias\.wetterlind@gmail\.com: ingen åtgärd\. 82 % av veckan använt, takten 0,1 %\/h \(senaste 10 h\) räcker till reset /u);
      expect(text).not.toMatch(/rotate|gratis reset/u);
    }],
  });

  unit("a pace that runs out before the reset offers a free reset before a switch", {
    given: ["82 % used after 10 points in 10 h, out in about 18 h", () => forecastFrom([reading(10, 72), reading(0, 82)])],
    when: ["choosing and formatting the notice", (forecast) => {
      const level = weeklyNoticeLevel(forecast, settings);
      return { level, text: formatWeeklyNotice({ level, email: "mattias.wetterlind@gmail.com", forecast, alternatives: adelost, now: NOW }) };
    }],
    then: ["the free reset comes first and the switch names the target's own numbers", ({ level, text }) => {
      expect(level).toBe("threshold");
      const lines = text.split("\n");
      expect(lines[1]).toMatch(/^1\. Om du har en gratis reset: använd den på claude\.ai/u);
      expect(lines[2]).toMatch(/^2\. Annars byt konto: `amux accounts rotate claude:adelost@gmail\.com --dry`.*adelost@gmail\.com har 26 % av veckan, reset /u);
    }],
  });

  unit("past the threshold, a limit less than 12 hours away gets the stronger notice", {
    given: ["85 % used at 5 % an hour", () => forecastFrom([reading(2, 75), reading(0, 85)])],
    when: ["choosing the notice", (forecast) => {
      const level = weeklyNoticeLevel(forecast, settings);
      return { level, text: formatWeeklyNotice({ level, email: "adelost@gmail.com", forecast, alternatives: [], now: NOW }) };
    }],
    then: ["it says hours, keeps the reset first and says no account can take over", ({ level, text }) => {
      expect(level).toBe("urgent");
      expect(text).toMatch(/^Claude adelost@gmail\.com tar slut om ca 3 h /u);
      expect(text.split("\n")[1]).toMatch(/^1\. Om du har en gratis reset/u);
      expect(text.split("\n")[2]).toBe("2. Inget annat Claude-konto går att byta till just nu.");
    }],
  });

  unit("below the threshold even a fast hour sends nothing", {
    given: ["a burst from 0 to 10 % in one hour after the reset", () => forecastFrom([reading(1, 0), reading(0, 10)])],
    when: ["choosing the notice", (forecast) => weeklyNoticeLevel(forecast, settings)],
    then: ["no notice", (level) => expect(level).toBeNull()],
  });

  unit("a single reading falls back to the average since the window began", {
    given: ["one reading of 40 % with 94.5 of 168 hours left", () => forecastFrom([reading(0, 40)])],
    when: ["forecasting", (forecast) => forecast],
    then: ["the pace is the window average and it lasts until the reset", (forecast) => {
      expect(forecast.pace.basis).toBe("window");
      expect(forecast.pace.percentPerHour).toBeCloseTo(40 / 73.5, 5);
      expect(forecast.lastsUntilReset).toBe(true);
      expect(weeklyNoticeLevel(forecast, settings)).toBeNull();
    }],
  });

  unit("readings from the previous window do not count toward the pace", {
    given: ["a 90 % reading from last week and a fresh 10 % one", () => forecastFrom([
      { at: NOW - 3 * HOUR, usedPercent: 90, resetsAt: "2026-10-07T07:00:00Z" }, reading(0, 10)])],
    when: ["forecasting", (forecast) => forecast],
    then: ["only this window's reading is used", (forecast) => {
      expect(forecast.pace.basis).toBe("window");
      expect(weeklyNoticeLevel(forecast, settings)).toBeNull();
    }],
  });
});
