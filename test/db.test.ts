import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  stmts,
  getRotation,
  getMembers,
  setMembers,
  reorderMembers,
  popNextMember,
  isOwner,
  type Rotation,
} from '../src/db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearAll() {
  db.exec('DELETE FROM members');
  db.exec('DELETE FROM rotations');
}

function insertRotation(overrides: Partial<{
  name: string;
  channel: string;
  cadence: string;
  days: string | null;
  day_of_month: number | null;
  hour: number;
  minute: number;
  timezone: string;
  owners: string | null;
  current_index: number;
}> = {}) {
  const result = stmts.insertRotation.run({
    name: overrides.name ?? 'Test Rotation',
    channel: overrides.channel ?? 'C123',
    cadence: overrides.cadence ?? 'daily',
    days: overrides.days ?? null,
    day_of_month: overrides.day_of_month ?? null,
    hour: overrides.hour ?? 9,
    minute: overrides.minute ?? 0,
    timezone: overrides.timezone ?? 'America/New_York',
    message_template: null,
    owners: overrides.owners ?? null,
  });
  if (overrides.current_index != null) {
    stmts.advanceIndex.run(overrides.current_index, Number(result.lastInsertRowid));
  }
  return Number(result.lastInsertRowid);
}

// ── isOwner ───────────────────────────────────────────────────────────────────

describe('isOwner', () => {
  it('returns true when user is in the owners list', () => {
    const rotation = { owners: '["U001","U002"]' } as Rotation;
    expect(isOwner(rotation, 'U001')).toBe(true);
    expect(isOwner(rotation, 'U002')).toBe(true);
  });

  it('returns false when user is not in the owners list', () => {
    const rotation = { owners: '["U001"]' } as Rotation;
    expect(isOwner(rotation, 'U999')).toBe(false);
  });

  it('returns true when owners is null (legacy — no restriction)', () => {
    const rotation = { owners: null } as Rotation;
    expect(isOwner(rotation, 'U001')).toBe(true);
  });

  it('returns false when owners is an empty array', () => {
    const rotation = { owners: '[]' } as Rotation;
    expect(isOwner(rotation, 'U001')).toBe(false);
  });
});

// ── setMembers ────────────────────────────────────────────────────────────────

describe('setMembers', () => {
  beforeEach(clearAll);

  it('stores members in order', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002', 'U003']);
    const members = getMembers(id);
    expect(members.map((m) => m.slack_user_id)).toEqual(['U001', 'U002', 'U003']);
  });

  it('replaces existing members on second call', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002']);
    setMembers(id, ['U003', 'U004', 'U005']);
    const members = getMembers(id);
    expect(members.map((m) => m.slack_user_id)).toEqual(['U003', 'U004', 'U005']);
  });

  it('resets current_index to 0', () => {
    const id = insertRotation({ current_index: 2 });
    setMembers(id, ['U001', 'U002', 'U003']);
    expect(getRotation(id)?.current_index).toBe(0);
  });

  it('handles a single member', () => {
    const id = insertRotation();
    setMembers(id, ['U001']);
    expect(getMembers(id)).toHaveLength(1);
  });

  it('handles an empty list', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002']);
    setMembers(id, []);
    expect(getMembers(id)).toHaveLength(0);
  });
});

// ── popNextMember ─────────────────────────────────────────────────────────────

describe('popNextMember', () => {
  beforeEach(clearAll);

  it('returns null for an unknown rotation', () => {
    expect(popNextMember(99999)).toBeNull();
  });

  it('returns null when rotation has no members', () => {
    const id = insertRotation();
    expect(popNextMember(id)).toBeNull();
  });

  it('returns the first member on first call', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002', 'U003']);
    const member = popNextMember(id);
    expect(member?.slack_user_id).toBe('U001');
  });

  it('advances to next member on subsequent calls', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002', 'U003']);
    popNextMember(id); // U001
    const second = popNextMember(id);
    expect(second?.slack_user_id).toBe('U002');
  });

  it('wraps around from last member back to first', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002']);
    popNextMember(id); // U001 → index becomes 1
    popNextMember(id); // U002 → index becomes 0
    const wrapped = popNextMember(id);
    expect(wrapped?.slack_user_id).toBe('U001');
  });

  it('works correctly with a single member', () => {
    const id = insertRotation();
    setMembers(id, ['U001']);
    expect(popNextMember(id)?.slack_user_id).toBe('U001');
    expect(popNextMember(id)?.slack_user_id).toBe('U001');
    expect(popNextMember(id)?.slack_user_id).toBe('U001');
  });

  it('increments the stored current_index after firing', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002', 'U003']);
    popNextMember(id);
    expect(getRotation(id)?.current_index).toBe(1);
  });
});

// ── reorderMembers ────────────────────────────────────────────────────────────

describe('reorderMembers', () => {
  beforeEach(clearAll);

  it('saves the new order correctly', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002', 'U003']);
    reorderMembers(id, ['U003', 'U001', 'U002']);
    const members = getMembers(id);
    expect(members.map((m) => m.slack_user_id)).toEqual(['U003', 'U001', 'U002']);
  });

  it('resets current_index to 0 so position 1 is next up', () => {
    const id = insertRotation({ current_index: 2 });
    setMembers(id, ['U001', 'U002', 'U003']);
    reorderMembers(id, ['U003', 'U001', 'U002']);
    expect(getRotation(id)?.current_index).toBe(0);
  });

  it('works with a single member', () => {
    const id = insertRotation();
    setMembers(id, ['U001']);
    reorderMembers(id, ['U001']);
    expect(getMembers(id).map((m) => m.slack_user_id)).toEqual(['U001']);
  });

  it('works when order is unchanged', () => {
    const id = insertRotation();
    setMembers(id, ['U001', 'U002']);
    reorderMembers(id, ['U001', 'U002']);
    expect(getMembers(id).map((m) => m.slack_user_id)).toEqual(['U001', 'U002']);
  });
});
