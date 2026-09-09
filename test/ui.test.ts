import { describe, it, expect } from 'vitest';
import { parseModalValues, parsePrivateMeta, buildRotationModal, buildRotationList } from '../src/ui.js';
import { DEFAULT_MESSAGE_TEMPLATE } from '../src/db.js';
import type { Rotation, Member } from '../src/db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Builds a minimal view.state.values object for parseModalValues
function makeValues(overrides: Record<string, unknown> = {}) {
  return {
    name_block: { name_input: { value: 'Test Rotation' } },
    channel_block: { channel_select: { selected_channel: 'C123' } },
    members_block: { members_select: { selected_users: ['U001', 'U002'] } },
    owners_block: { owners_select: { selected_users: ['U001'] } },
    cadence_block: { cadence_select: { selected_option: { value: 'weekly' } } },
    days_block: { days_checkboxes: { selected_options: [{ value: '1' }, { value: '4' }] } },
    day_of_month_block: { day_of_month_input: { value: null } },
    time_block: { time_picker: { selected_option: { value: '10:30' } } },
    timezone_block: { timezone_select: { selected_option: { value: 'America/New_York' } } },
    message_block: { message_input: { value: '*{{rotation}}*\n<@{{user}}> you\'re up!' } },
    ...overrides,
  };
}

// ── parsePrivateMeta ──────────────────────────────────────────────────────────

describe('parsePrivateMeta', () => {
  it('returns empty object for empty string', () => {
    expect(parsePrivateMeta('')).toEqual({});
  });

  it('parses JSON format {id, channel}', () => {
    expect(parsePrivateMeta(JSON.stringify({ id: 42, channel: 'C123' }))).toEqual({ id: 42, channel: 'C123' });
  });

  it('parses legacy plain number string', () => {
    expect(parsePrivateMeta('7')).toEqual({ id: 7 });
  });

  it('returns empty object for malformed JSON', () => {
    expect(parsePrivateMeta('not-json-or-number')).toEqual({});
  });

  it('handles channel being empty string in JSON', () => {
    expect(parsePrivateMeta(JSON.stringify({ id: 1, channel: '' }))).toEqual({ id: 1, channel: '' });
  });
});

// ── buildRotationModal private_metadata ───────────────────────────────────────

describe('buildRotationModal', () => {
  it('stores id and channel as JSON in private_metadata', () => {
    const modal = buildRotationModal({
      callbackId: 'edit_rotation',
      title: 'Edit',
      rotationId: 5,
      channel: 'C999',
    });
    expect(JSON.parse(modal.private_metadata)).toEqual({ id: 5, channel: 'C999' });
  });

  it('stores undefined id and empty channel for create modal', () => {
    const modal = buildRotationModal({ callbackId: 'create_rotation', title: 'Create' });
    const meta = JSON.parse(modal.private_metadata);
    expect(meta.id).toBeUndefined();
    expect(meta.channel).toBe('');
  });
});

// ── buildRotationList buttons ─────────────────────────────────────────────────

function makeRotationWithMembers(overrides: Partial<Rotation> = {}): Rotation & { members: Member[] } {
  return {
    id: 1, name: 'Test', channel: 'C123', cadence: 'daily', days: null,
    day_of_month: null, hour: 9, minute: 0, timezone: 'America/New_York',
    message_template: null, owners: null, current_index: 0,
    created_at: '2026-01-01', members: [],
    ...overrides,
  };
}

describe('buildRotationList', () => {
  it('includes open_create_rotation button', () => {
    const blocks = buildRotationList([makeRotationWithMembers()]);
    const json = JSON.stringify(blocks);
    expect(json).toContain('open_create_rotation');
  });

  it('includes skip_rotation button', () => {
    const blocks = buildRotationList([makeRotationWithMembers()]);
    const json = JSON.stringify(blocks);
    expect(json).toContain('skip_rotation');
  });

  it('includes trigger confirm text', () => {
    const blocks = buildRotationList([makeRotationWithMembers({ name: 'Standup' })]);
    const json = JSON.stringify(blocks);
    expect(json).toContain('advance the queue');
  });

  it('shows create button even when list is empty', () => {
    const blocks = buildRotationList([]);
    const json = JSON.stringify(blocks);
    expect(json).toContain('Create rotation');
  });
});

// ── parseModalValues ──────────────────────────────────────────────────────────

describe('parseModalValues', () => {
  it('parses a weekly rotation correctly', () => {
    const form = parseModalValues(makeValues());
    expect(form.name).toBe('Test Rotation');
    expect(form.channel).toBe('C123');
    expect(form.memberIds).toEqual(['U001', 'U002']);
    expect(form.ownerIds).toEqual(['U001']);
    expect(form.cadence).toBe('weekly');
    expect(form.days).toEqual([1, 4]);
    expect(form.hour).toBe(10);
    expect(form.minute).toBe(30);
    expect(form.timezone).toBe('America/New_York');
  });

  it('parses a daily rotation — days_block is undefined (field hidden)', () => {
    const form = parseModalValues(
      makeValues({
        cadence_block: { cadence_select: { selected_option: { value: 'daily' } } },
        days_block: undefined,
      }),
    );
    expect(form.cadence).toBe('daily');
    expect(form.days).toEqual([]);
  });

  it('parses a monthly rotation — day_of_month_block present, days_block absent', () => {
    const form = parseModalValues(
      makeValues({
        cadence_block: { cadence_select: { selected_option: { value: 'monthly' } } },
        days_block: undefined,
        day_of_month_block: { day_of_month_input: { value: '15' } },
      }),
    );
    expect(form.cadence).toBe('monthly');
    expect(form.days).toEqual([]);
    expect(form.dayOfMonth).toBe(15);
  });

  it('returns null dayOfMonth when field is absent', () => {
    const form = parseModalValues(
      makeValues({
        day_of_month_block: undefined,
      }),
    );
    expect(form.dayOfMonth).toBeNull();
  });

  it('parses time correctly — midnight', () => {
    const form = parseModalValues(makeValues({ time_block: { time_picker: { selected_option: { value: '00:00' } } } }));
    expect(form.hour).toBe(0);
    expect(form.minute).toBe(0);
  });

  it('parses time correctly — 15-min increment', () => {
    const form = parseModalValues(makeValues({ time_block: { time_picker: { selected_option: { value: '14:45' } } } }));
    expect(form.hour).toBe(14);
    expect(form.minute).toBe(45);
  });

  it('falls back to default message template when field is blank', () => {
    const form = parseModalValues(
      makeValues({ message_block: { message_input: { value: '' } } }),
    );
    expect(form.messageTemplate).toBe(DEFAULT_MESSAGE_TEMPLATE);
  });

  it('falls back to default message template when field is whitespace', () => {
    const form = parseModalValues(
      makeValues({ message_block: { message_input: { value: '   ' } } }),
    );
    expect(form.messageTemplate).toBe(DEFAULT_MESSAGE_TEMPLATE);
  });

  it('preserves custom message template', () => {
    const custom = 'Hey {{user}}, your turn on {{rotation}}!';
    const form = parseModalValues(
      makeValues({ message_block: { message_input: { value: custom } } }),
    );
    expect(form.messageTemplate).toBe(custom);
  });

  it('returns empty memberIds when none selected', () => {
    const form = parseModalValues(
      makeValues({ members_block: { members_select: { selected_users: null } } }),
    );
    expect(form.memberIds).toEqual([]);
  });

  it('returns empty ownerIds when none selected', () => {
    const form = parseModalValues(
      makeValues({ owners_block: { owners_select: { selected_users: null } } }),
    );
    expect(form.ownerIds).toEqual([]);
  });

  it('falls back to weekly when cadence option is missing', () => {
    const form = parseModalValues(
      makeValues({ cadence_block: { cadence_select: { selected_option: null } } }),
    );
    expect(form.cadence).toBe('weekly');
  });

  it('falls back to ET when timezone option is missing', () => {
    const form = parseModalValues(
      makeValues({ timezone_block: { timezone_select: { selected_option: null } } }),
    );
    expect(form.timezone).toBe('America/New_York');
  });
});
