import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getTodayInTimezone,
  toDateString,
  getSkipDate,
  hasSkipDatesForYear,
  refreshHolidaysForYear,
  getAnnotatedFiringDates,
} from "../src/holidays.js";
import { db } from "../src/db.js";
import type { Rotation } from "../src/db.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearSkipDates() {
  db.exec("DELETE FROM skip_dates");
}

function insertSkipDate(date: string, label: string, emoji = ":calendar:") {
  db.prepare(
    "INSERT OR REPLACE INTO skip_dates (date, label, emoji) VALUES (?, ?, ?)",
  ).run(date, label, emoji);
}

function dailyRotation(overrides: Partial<Rotation> = {}): Rotation {
  return {
    id: 1,
    name: "Standup",
    channel: "C123",
    cadence: "daily",
    days: null,
    day_of_month: null,
    hour: 10,
    minute: 0,
    timezone: "America/New_York",
    message_template: null,
    owners: null,
    current_index: 0,
    created_at: "2026-01-01",
    ...overrides,
  };
}

// ── getTodayInTimezone ────────────────────────────────────────────────────────

describe("getTodayInTimezone", () => {
  it("returns a YYYY-MM-DD formatted string", () => {
    const result = getTodayInTimezone("America/New_York");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns today's date in the given timezone", () => {
    const utcDate = toDateString(new Date(), "UTC");
    const etDate = toDateString(new Date(), "America/New_York");
    // Both should be valid dates (may differ near midnight)
    expect(utcDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(etDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── toDateString ──────────────────────────────────────────────────────────────

describe("toDateString", () => {
  it("formats a date as YYYY-MM-DD", () => {
    const date = new Date("2026-07-04T15:00:00Z");
    expect(toDateString(date, "UTC")).toBe("2026-07-04");
  });

  it("converts to the correct timezone", () => {
    // 2026-01-01 01:00 UTC = 2025-12-31 in ET (UTC-5)
    const date = new Date("2026-01-01T01:00:00Z");
    expect(toDateString(date, "America/New_York")).toBe("2025-12-31");
    expect(toDateString(date, "UTC")).toBe("2026-01-01");
  });
});

// ── getSkipDate ───────────────────────────────────────────────────────────────

describe("getSkipDate", () => {
  beforeEach(clearSkipDates);

  it("returns null when date is not a skip day", () => {
    expect(getSkipDate("2026-07-01")).toBeNull();
  });

  it("returns label and emoji for a skip day", () => {
    insertSkipDate("2026-07-04", "Independence Day", ":fireworks:");
    const result = getSkipDate("2026-07-04");
    expect(result).toEqual({ label: "Independence Day", emoji: ":fireworks:" });
  });

  it("returns null for a date that looks similar but doesn't match", () => {
    insertSkipDate("2026-07-04", "Independence Day", ":fireworks:");
    expect(getSkipDate("2026-07-05")).toBeNull();
  });
});

// ── hasSkipDatesForYear ───────────────────────────────────────────────────────

describe("hasSkipDatesForYear", () => {
  beforeEach(clearSkipDates);

  it("returns false when no dates exist for the year", () => {
    expect(hasSkipDatesForYear(2026)).toBe(false);
  });

  it("returns true when dates exist for the year", () => {
    insertSkipDate("2026-07-04", "Independence Day");
    expect(hasSkipDatesForYear(2026)).toBe(true);
  });

  it("returns false for a different year even if dates exist", () => {
    insertSkipDate("2026-07-04", "Independence Day");
    expect(hasSkipDatesForYear(2025)).toBe(false);
  });
});

// ── refreshHolidaysForYear ────────────────────────────────────────────────────

const MOCK_NAGER_RESPONSE = [
  { date: "2026-01-01", localName: "New Year's Day",     name: "New Year's Day",     global: true  },
  { date: "2026-11-26", localName: "Thanksgiving Day",   name: "Thanksgiving Day",    global: true  },
  { date: "2026-12-25", localName: "Christmas Day",      name: "Christmas Day",       global: true  },
  { date: "2026-07-04", localName: "Independence Day",   name: "Independence Day",    global: false }, // not global — should be skipped
];

describe("refreshHolidaysForYear", () => {
  beforeEach(() => {
    clearSkipDates();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => MOCK_NAGER_RESPONSE,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches from the correct Nager URL", async () => {
    await refreshHolidaysForYear(2026);
    expect(fetch).toHaveBeenCalledWith(
      "https://date.nager.at/api/v3/PublicHolidays/2026/US",
    );
  });

  it("inserts global holidays", async () => {
    await refreshHolidaysForYear(2026);
    expect(getSkipDate("2026-01-01")).toEqual({
      label: "New Year's Day",
      emoji: ":tada:",
    });
    expect(getSkipDate("2026-12-25")).toEqual({
      label: "Christmas Day",
      emoji: ":christmas_tree:",
    });
  });

  it("skips non-global holidays", async () => {
    await refreshHolidaysForYear(2026);
    // Independence Day is global: false in our mock
    expect(getSkipDate("2026-07-04")).toBeNull();
  });

  it("adds Black Friday (day after Thanksgiving)", async () => {
    await refreshHolidaysForYear(2026);
    // Thanksgiving is Nov 26, so Black Friday is Nov 27
    expect(getSkipDate("2026-11-27")).toEqual({
      label: "Black Friday",
      emoji: ":shopping_bags:",
    });
  });

  it("adds Christmas Eve", async () => {
    await refreshHolidaysForYear(2026);
    expect(getSkipDate("2026-12-24")).toEqual({
      label: "Christmas Eve",
      emoji: ":santa::skin-tone-3:",
    });
  });

  it("clears existing dates for the year before repopulating", async () => {
    insertSkipDate("2026-03-15", "Old Fake Holiday");
    await refreshHolidaysForYear(2026);
    expect(getSkipDate("2026-03-15")).toBeNull();
  });

  it("handles API failure gracefully without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    await expect(refreshHolidaysForYear(2026)).resolves.not.toThrow();
  });
});

// ── getAnnotatedFiringDates ───────────────────────────────────────────────────

describe("getAnnotatedFiringDates", () => {
  beforeEach(clearSkipDates);

  it("returns empty array when personCount is 0", () => {
    expect(getAnnotatedFiringDates(dailyRotation(), 0)).toHaveLength(0);
  });

  it("returns N non-holiday entries when no holidays configured", () => {
    const entries = getAnnotatedFiringDates(dailyRotation(), 3);
    const nonHolidays = entries.filter((e) => !e.holiday);
    expect(nonHolidays).toHaveLength(3);
    entries.forEach((e) => expect(e.holiday).toBeNull());
  });

  it("interleaves holiday entries without consuming a person slot", () => {
    // Insert a holiday for tomorrow-ish — we'll use a known date
    // Daily rotation from now: find the next 3 dates and insert the first as a holiday
    const tempEntries = getAnnotatedFiringDates(dailyRotation(), 3);
    const firstDate = toDateString(tempEntries[0].date, "America/New_York");
    insertSkipDate(firstDate, "Test Holiday", ":test:");

    const entries = getAnnotatedFiringDates(dailyRotation(), 3);
    // Should have 4 entries: 1 holiday + 3 people
    expect(entries).toHaveLength(4);
    expect(entries[0].holiday).toEqual({ label: "Test Holiday", emoji: ":test:" });
    expect(entries[1].holiday).toBeNull();
    expect(entries[2].holiday).toBeNull();
    expect(entries[3].holiday).toBeNull();
  });

  it("returns dates in ascending order", () => {
    const entries = getAnnotatedFiringDates(dailyRotation(), 5);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].date.getTime()).toBeGreaterThan(
        entries[i - 1].date.getTime(),
      );
    }
  });

  it("returns empty array for invalid cron expression", () => {
    // Monthly with day_of_month 32 produces an invalid cron
    const entries = getAnnotatedFiringDates(
      dailyRotation({ cadence: "monthly", day_of_month: 32 }),
      3,
    );
    expect(entries).toHaveLength(0);
  });
});
