import { describe, it, expect } from 'vitest';
import { buildCronExpression, describeSchedule, getNextFiringDates } from '../src/rotations.js';
import type { Rotation } from '../src/db.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function rotation(overrides: Partial<Rotation> = {}): Rotation {
  return {
    id: 1,
    name: 'Test',
    channel: 'C123',
    cadence: 'weekly',
    days: '[1]',
    day_of_month: null,
    hour: 9,
    minute: 0,
    timezone: 'America/New_York',
    message_template: null,
    owners: null,
    current_index: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── buildCronExpression ───────────────────────────────────────────────────────

describe('buildCronExpression', () => {
  it('daily: fires every day at given time', () => {
    expect(buildCronExpression(rotation({ cadence: 'daily', hour: 9, minute: 0 }))).toBe('0 9 * * *');
  });

  it('daily: midnight edge case', () => {
    expect(buildCronExpression(rotation({ cadence: 'daily', hour: 0, minute: 0 }))).toBe('0 0 * * *');
  });

  it('daily: preserves minutes', () => {
    expect(buildCronExpression(rotation({ cadence: 'daily', hour: 14, minute: 30 }))).toBe('30 14 * * *');
  });

  it('weekly: single day', () => {
    expect(buildCronExpression(rotation({ cadence: 'weekly', days: '[4]', hour: 10, minute: 0 }))).toBe('0 10 * * 4');
  });

  it('weekly: multiple days in order', () => {
    expect(buildCronExpression(rotation({ cadence: 'weekly', days: '[1,2,4]', hour: 10, minute: 0 }))).toBe('0 10 * * 1,2,4');
  });

  it('weekly: falls back to Monday when days is null', () => {
    expect(buildCronExpression(rotation({ cadence: 'weekly', days: null }))).toBe('0 9 * * 1');
  });

  it('monthly: uses day_of_month', () => {
    expect(buildCronExpression(rotation({ cadence: 'monthly', day_of_month: 15, hour: 8, minute: 0 }))).toBe('0 8 15 * *');
  });

  it('monthly: falls back to 1st when day_of_month is null', () => {
    expect(buildCronExpression(rotation({ cadence: 'monthly', day_of_month: null }))).toBe('0 9 1 * *');
  });

  it('last minute of day', () => {
    expect(buildCronExpression(rotation({ cadence: 'daily', hour: 23, minute: 59 }))).toBe('59 23 * * *');
  });
});

// ── describeSchedule ──────────────────────────────────────────────────────────

describe('describeSchedule', () => {
  it('daily', () => {
    expect(describeSchedule(rotation({ cadence: 'daily', hour: 9, minute: 0 }))).toBe('Daily at 9:00 AM (America/New_York)');
  });

  it('noon (12 PM)', () => {
    expect(describeSchedule(rotation({ cadence: 'daily', hour: 12, minute: 0 }))).toBe('Daily at 12:00 PM (America/New_York)');
  });

  it('midnight (12 AM)', () => {
    expect(describeSchedule(rotation({ cadence: 'daily', hour: 0, minute: 0 }))).toBe('Daily at 12:00 AM (America/New_York)');
  });

  it('1 PM', () => {
    expect(describeSchedule(rotation({ cadence: 'daily', hour: 13, minute: 0 }))).toBe('Daily at 1:00 PM (America/New_York)');
  });

  it('pads minutes', () => {
    expect(describeSchedule(rotation({ cadence: 'daily', hour: 9, minute: 5 }))).toBe('Daily at 9:05 AM (America/New_York)');
  });

  it('weekly with multiple days', () => {
    expect(describeSchedule(rotation({ cadence: 'weekly', days: '[1,4]', hour: 10, minute: 0 }))).toBe('Weekly on Mon, Thu at 10:00 AM (America/New_York)');
  });

  it('weekly with no days set', () => {
    expect(describeSchedule(rotation({ cadence: 'weekly', days: null }))).toContain('(no days set)');
  });

  it('monthly', () => {
    expect(describeSchedule(rotation({ cadence: 'monthly', day_of_month: 15, hour: 8, minute: 0 }))).toBe('Monthly on day 15 at 8:00 AM (America/New_York)');
  });

  it('monthly with null day_of_month', () => {
    expect(describeSchedule(rotation({ cadence: 'monthly', day_of_month: null }))).toContain('day ?');
  });
});

// ── getNextFiringDates ────────────────────────────────────────────────────────

describe('getNextFiringDates', () => {
  it('returns the requested number of dates', () => {
    const dates = getNextFiringDates(rotation({ cadence: 'daily' }), 5);
    expect(dates).toHaveLength(5);
  });

  it('returns dates in the future', () => {
    const now = new Date();
    const dates = getNextFiringDates(rotation({ cadence: 'daily' }), 3);
    dates.forEach((d) => expect(d.getTime()).toBeGreaterThan(now.getTime()));
  });

  it('returns dates in ascending order', () => {
    const dates = getNextFiringDates(rotation({ cadence: 'daily' }), 3);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i].getTime()).toBeGreaterThan(dates[i - 1].getTime());
    }
  });

  it('weekly rotation only fires on the specified days', () => {
    // Thu = 4
    const dates = getNextFiringDates(rotation({ cadence: 'weekly', days: '[4]' }), 3);
    dates.forEach((d) => {
      expect(d.getDay()).toBe(4); // Thursday in UTC
    });
  });

  it('returns empty array for an invalid cron expression', () => {
    // Force an invalid expression by giving an impossible day_of_month value
    const r = rotation({ cadence: 'monthly', day_of_month: 32 });
    // buildCronExpression will produce "0 9 32 * *" which is invalid
    const dates = getNextFiringDates(r, 3);
    expect(dates).toHaveLength(0);
  });

  it('returns 0 dates when count is 0', () => {
    expect(getNextFiringDates(rotation({ cadence: 'daily' }), 0)).toHaveLength(0);
  });
});
