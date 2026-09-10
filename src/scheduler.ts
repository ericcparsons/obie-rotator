import cron, { type ScheduledTask } from "node-cron";
import type { App } from "@slack/bolt";
import {
  allRotations,
  getRotation,
  peekNextMember,
  advanceMember,
  type Rotation,
  DEFAULT_MESSAGE_TEMPLATE,
} from "./db.js";
import { buildCronExpression, describeSchedule } from "./rotations.js";
import {
  getTodayInTimezone,
  getSkipDate,
  hasSkipDatesForYear,
  refreshHolidaysForYear,
} from "./holidays.js";

// Keyed by rotation ID so we can cancel/replace individual jobs
const activeTasks = new Map<number, ScheduledTask>();

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Posts the rotation message to the channel and advances the queue.
 */
export async function fireRotation(
  app: App,
  rotation: Rotation,
): Promise<void> {
  // Fetch fresh data so the cron closure never uses a stale snapshot
  const fresh = getRotation(rotation.id);
  if (!fresh) {
    console.warn(`[${rotation.name}] Rotation no longer exists — skipping.`);
    return;
  }

  // Check if today is a company holiday — skip without advancing the queue
  const today = getTodayInTimezone(fresh.timezone);
  const holiday = getSkipDate(today);
  if (holiday) {
    console.log(
      `[${fresh.name}] Holiday — ${holiday.emoji} ${holiday.label}. Skipping (queue unchanged).`,
    );
    return;
  }

  // Peek without advancing — index only moves after a successful Slack post
  const member = peekNextMember(fresh.id);
  if (!member) {
    console.warn(`[${fresh.name}] No members configured — skipping.`);
    return;
  }

  const template = fresh.message_template ?? DEFAULT_MESSAGE_TEMPLATE;
  const message = template
    .replace(/\{\{user\}\}/g, member.slack_user_id)
    .replace(/\{\{rotation\}\}/g, fresh.name);

  try {
    await app.client.chat.postMessage({
      channel: fresh.channel,
      text: message,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: message },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `📅 ${describeSchedule(fresh)}` },
          ],
        },
      ],
    });

    // Only advance after the post succeeds — prevents silent skips on Slack errors
    advanceMember(fresh.id);
    console.log(`[${fresh.name}] Fired — <@${member.slack_user_id}> is up.`);
  } catch (err) {
    console.error(`[${fresh.name}] Failed to post — index not advanced:`, err);
  }
}

// ── Job management ────────────────────────────────────────────────────────────

/**
 * Creates (or replaces) the cron job for a single rotation.
 */
export function scheduleRotation(app: App, rotation: Rotation): void {
  // Cancel the existing job for this rotation if one is running
  cancelRotation(rotation.id);

  const expression = buildCronExpression(rotation);

  if (!cron.validate(expression)) {
    console.error(
      `[${rotation.name}] Invalid cron expression "${expression}" — not scheduled.`,
    );
    return;
  }

  const task = cron.schedule(
    expression,
    () => {
      // Always fetch fresh — fireRotation handles staleness internally
      const fresh = getRotation(rotation.id);
      if (!fresh) return;
      fireRotation(app, fresh).catch((err) => {
        console.error(`[${rotation.name}] Unhandled error in fireRotation:`, err);
      });
    },
    { timezone: rotation.timezone },
  );

  activeTasks.set(rotation.id, task);
  console.log(
    `[${rotation.name}] Scheduled: ${expression} in ${rotation.timezone}`,
  );
}

/**
 * Stops and removes the cron job for a rotation.
 */
export function cancelRotation(id: number): void {
  const existing = activeTasks.get(id);
  if (existing) {
    existing.stop();
    activeTasks.delete(id);
  }
}

/**
 * Loads all rotations from the DB and starts their cron jobs.
 * Also ensures holidays are loaded for the current year.
 * Call once at startup.
 */
export async function initScheduler(app: App): Promise<void> {
  // Load holidays for the current year if not already done
  const year = new Date().getFullYear();
  if (!hasSkipDatesForYear(year)) {
    await refreshHolidaysForYear(year);
  }

  // Refresh holidays every Jan 1 at midnight UTC for the new year
  cron.schedule("0 0 1 1 *", async () => {
    await refreshHolidaysForYear(new Date().getFullYear());
  }, { timezone: "UTC" });

  const rotations = allRotations();

  if (rotations.length === 0) {
    console.log("No rotations in DB yet. Use /rotation to create one.");
    return;
  }

  for (const rotation of rotations) {
    scheduleRotation(app, rotation);
  }

  console.log(`Scheduler started with ${rotations.length} rotation(s).`);
}
