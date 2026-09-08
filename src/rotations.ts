import { CronExpressionParser } from "cron-parser";
import {
  stmts,
  allRotations,
  getRotation,
  getMembers,
  setMembers,
  isOwner,
  type Rotation,
  type Member,
  DEFAULT_MESSAGE_TEMPLATE,
} from "./db.js";

/**
 * Rotates an array so the item at currentIndex comes first.
 * Used to display queues "next up first" in the UI.
 */
export function rotateToCurrentIndex<T>(items: T[], currentIndex: number): T[] {
  if (items.length === 0) return items;
  const idx = currentIndex % items.length;
  return [...items.slice(idx), ...items.slice(0, idx)];
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Cadence = "daily" | "weekly" | "monthly";

export interface RotationInput {
  name: string;
  channel: string;
  cadence: Cadence;
  /** Day numbers 0–6, required when cadence is 'weekly' */
  days?: number[];
  /** 1–31, required when cadence is 'monthly' */
  dayOfMonth?: number;
  hour: number;
  minute: number;
  timezone: string;
  messageTemplate: string;
  ownerIds: string[];
  memberIds: string[];
}

export { DEFAULT_MESSAGE_TEMPLATE };

export interface RotationWithMembers extends Rotation {
  members: Member[];
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function createRotation(input: RotationInput): RotationWithMembers {
  const result = stmts.insertRotation.run({
    name: input.name,
    channel: input.channel,
    cadence: input.cadence,
    days: input.days != null ? JSON.stringify(input.days) : null,
    day_of_month: input.dayOfMonth ?? null,
    hour: input.hour,
    minute: input.minute,
    timezone: input.timezone,
    message_template: input.messageTemplate ?? null,
    owners: JSON.stringify(input.ownerIds),
  });

  const rotation = getRotation(Number(result.lastInsertRowid));
  if (!rotation) throw new Error("Failed to create rotation");

  setMembers(rotation.id, input.memberIds);

  return { ...rotation, members: getMembers(rotation.id) };
}

export function updateRotation(
  id: number,
  input: RotationInput,
): RotationWithMembers {
  stmts.updateRotation.run({
    id,
    name: input.name,
    channel: input.channel,
    cadence: input.cadence,
    days: input.days != null ? JSON.stringify(input.days) : null,
    day_of_month: input.dayOfMonth ?? null,
    hour: input.hour,
    minute: input.minute,
    timezone: input.timezone,
    message_template: input.messageTemplate ?? null,
    owners: JSON.stringify(input.ownerIds),
  });

  const rotation = getRotation(id);
  if (!rotation) throw new Error(`Rotation ${id} not found`);

  // Only reset current_index if the member list actually changed.
  // Editing just the schedule or message template should not bump the queue.
  const oldMemberIds = getMembers(id).map((m) => m.slack_user_id);
  const membersChanged =
    JSON.stringify(oldMemberIds) !== JSON.stringify(input.memberIds);
  setMembers(rotation.id, input.memberIds, membersChanged);

  return { ...rotation, members: getMembers(rotation.id) };
}

export function deleteRotation(id: number): void {
  stmts.deleteRotation.run(id);
}

export function listRotationsWithMembers(): RotationWithMembers[] {
  return allRotations().map((r) => ({ ...r, members: getMembers(r.id) }));
}

/** Returns only rotations the given user owns (or legacy null-owner rotations). */
export function listRotationsOwnedBy(userId: string): RotationWithMembers[] {
  return listRotationsWithMembers().filter((r) => isOwner(r, userId));
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

/**
 * Builds a cron expression from rotation fields.
 * node-cron accepts a `timezone` option separately, so times here are in
 * the rotation's own timezone — no UTC conversion needed.
 */
export function buildCronExpression(rotation: Rotation): string {
  const { minute, hour, cadence, days, day_of_month } = rotation;

  switch (cadence) {
    case "daily":
      return `${minute} ${hour} * * *`;

    case "weekly": {
      const dayList =
        days != null ? (JSON.parse(days) as number[]).join(",") : "1";
      return `${minute} ${hour} * * ${dayList}`;
    }

    case "monthly":
      return `${minute} ${hour} ${day_of_month ?? 1} * *`;
  }
}

/**
 * Returns the next `count` firing dates for a rotation, in order.
 * Uses the rotation's own timezone so DST is handled correctly.
 */
export function getNextFiringDates(rotation: Rotation, count: number): Date[] {
  try {
    const expression = buildCronExpression(rotation);
    const interval = CronExpressionParser.parse(expression, {
      tz: rotation.timezone,
    });
    return Array.from({ length: count }, () => interval.next().toDate());
  } catch {
    return [];
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Returns a human-readable schedule string for display in Slack.
 * e.g. "Weekly on Mon, Thu at 10:00 AM (America/New_York)"
 */
export function describeSchedule(rotation: Rotation): string {
  const hh = rotation.hour % 12 === 0 ? 12 : rotation.hour % 12;
  const mm = String(rotation.minute).padStart(2, "0");
  const ampm = rotation.hour < 12 ? "AM" : "PM";
  const time = `${hh}:${mm} ${ampm}`;
  const tz = rotation.timezone;

  switch (rotation.cadence) {
    case "daily":
      return `Daily at ${time} (${tz})`;

    case "weekly": {
      const days =
        rotation.days != null
          ? (JSON.parse(rotation.days) as number[])
              .map((d) => DAY_NAMES[d])
              .join(", ")
          : "(no days set)";
      return `Weekly on ${days} at ${time} (${tz})`;
    }

    case "monthly":
      return `Monthly on day ${rotation.day_of_month ?? "?"} at ${time} (${tz})`;
  }
}
