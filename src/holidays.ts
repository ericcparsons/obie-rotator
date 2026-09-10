import { CronExpressionParser } from "cron-parser";
import { db } from "./db.js";
import { buildCronExpression } from "./rotations.js";
import type { Rotation } from "./db.js";

// ── Holiday config ────────────────────────────────────────────────────────────

/**
 * Maps Nager.Date API `name` field → display label + emoji.
 * Keys must match the `name` field in the Nager API response exactly.
 */
const HOLIDAY_CONFIG: Record<string, { label: string; emoji: string }> = {
  "New Year's Day":                       { label: "New Year's Day",    emoji: ":tada:" },
  "Martin Luther King, Jr. Day":          { label: "MLK Day",           emoji: ":calendar:" },
  "Presidents Day":                       { label: "Presidents' Day",   emoji: ":us:" },
  "Memorial Day":                         { label: "Memorial Day",      emoji: ":us:" },
  "Juneteenth National Independence Day": { label: "Juneteenth",        emoji: ":calendar:" },
  "Independence Day":                     { label: "Independence Day",  emoji: ":fireworks:" },
  "Labour Day":                           { label: "Labor Day",         emoji: ":calendar:" },
  "Thanksgiving Day":                     { label: "Thanksgiving Day",  emoji: ":turkey:" },
  "Christmas Day":                        { label: "Christmas Day",     emoji: ":christmas_tree:" },
};

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns today's date as YYYY-MM-DD in the given IANA timezone. */
export function getTodayInTimezone(timezone: string): string {
  return toDateString(new Date(), timezone);
}

/** Converts a Date to YYYY-MM-DD in the given IANA timezone. */
export function toDateString(date: Date, timezone: string): string {
  return date.toLocaleDateString("en-CA", { timeZone: timezone });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

const _insertSkipDate = db.prepare(`
  INSERT OR REPLACE INTO skip_dates (date, label, emoji)
  VALUES (@date, @label, @emoji)
`);

/** Returns holiday data for a date string (YYYY-MM-DD), or null if not a skip day. */
export function getSkipDate(
  dateStr: string,
): { label: string; emoji: string } | null {
  const result = db
    .prepare("SELECT label, emoji FROM skip_dates WHERE date = ?")
    .get(dateStr) as { label: string; emoji: string } | undefined;
  return result ?? null;
}

/** Returns true if skip_dates already has entries for the given year. */
export function hasSkipDatesForYear(year: number): boolean {
  const result = db
    .prepare("SELECT COUNT(*) as count FROM skip_dates WHERE date LIKE ?")
    .get(`${year}-%`) as { count: number };
  return result.count > 0;
}

// ── Nager.Date API fetch ──────────────────────────────────────────────────────

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
  global: boolean;
}

/**
 * Fetches US public holidays from Nager.Date and populates skip_dates for
 * the given year. Adds Black Friday and Christmas Eve as Obie-specific extras.
 * Safe to call on every startup — only fetches if year not already populated.
 */
export async function refreshHolidaysForYear(year: number): Promise<void> {
  try {
    const res = await fetch(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/US`,
    );
    if (!res.ok) throw new Error(`Nager API ${res.status}`);

    const holidays = (await res.json()) as NagerHoliday[];

    // Clear existing dates for this year before repopulating
    db.prepare("DELETE FROM skip_dates WHERE date LIKE ?").run(`${year}-%`);

    let thanksgivingDate: string | null = null;

    for (const h of holidays.filter((h) => h.global)) {
      const config = HOLIDAY_CONFIG[h.name];
      if (config) {
        _insertSkipDate.run({ date: h.date, label: config.label, emoji: config.emoji });
        if (h.name === "Thanksgiving Day") thanksgivingDate = h.date;
      }
    }

    // Day after Thanksgiving (Black Friday) — day after whatever Nager returns
    if (thanksgivingDate) {
      const d = new Date(`${thanksgivingDate}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      _insertSkipDate.run({
        date: d.toISOString().slice(0, 10),
        label: "Black Friday",
        emoji: ":shopping_bags:",
      });
    }

    // Christmas Eve — always Dec 24
    _insertSkipDate.run({
      date: `${year}-12-24`,
      label: "Christmas Eve",
      emoji: ":santa::skin-tone-3:",
    });

    const countResult = db
      .prepare("SELECT COUNT(*) as count FROM skip_dates WHERE date LIKE ?")
      .get(`${year}-%`) as { count: number };
    console.log(`Holidays loaded for ${year} (${countResult.count} dates).`);
  } catch (err) {
    console.error(`Failed to refresh holidays for ${year}:`, err);
  }
}

// ── Annotated firing dates ────────────────────────────────────────────────────

export interface FiringDateEntry {
  date: Date;
  /** null = normal rotation day; non-null = holiday, will be skipped */
  holiday: { label: string; emoji: string } | null;
}

/**
 * Generates firing dates for a rotation, annotating holidays inline.
 * Iterates until `personCount` non-holiday dates are found.
 * Holiday entries are interleaved so the display accurately shows
 * which dates are skipped and which person fires on which date.
 */
export function getAnnotatedFiringDates(
  rotation: Rotation,
  personCount: number,
): FiringDateEntry[] {
  if (personCount === 0) return [];

  const expression = buildCronExpression(rotation);
  try {
    const interval = CronExpressionParser.parse(expression, {
      tz: rotation.timezone,
    });

    const results: FiringDateEntry[] = [];
    let personSlotsFilled = 0;
    // Cap at personCount + 30 to handle up to 30 consecutive holidays
    const maxIterations = personCount + 30;

    for (let i = 0; i < maxIterations && personSlotsFilled < personCount; i++) {
      const date = interval.next().toDate();
      const dateStr = toDateString(date, rotation.timezone);
      const holiday = getSkipDate(dateStr);

      results.push({ date, holiday });
      if (!holiday) personSlotsFilled++;
    }

    return results;
  } catch {
    return [];
  }
}
