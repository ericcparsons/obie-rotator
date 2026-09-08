import cron, { type ScheduledTask } from "node-cron";
import type { App } from "@slack/bolt";
import { allRotations, popNextMember, type Rotation } from "./db.js";
import { buildCronExpression, describeSchedule } from "./rotations.js";

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
  const member = popNextMember(rotation.id);
  if (!member) {
    console.warn(`[${rotation.name}] No members configured — skipping.`);
    return;
  }

  await app.client.chat.postMessage({
    channel: rotation.channel,
    text: `*${rotation.name}* — <@${member.slack_user_id}> you're up! 🔄`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rotation.name}*\n<@${member.slack_user_id}> you're up! 🔄`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `📅 ${describeSchedule(rotation)}`,
          },
        ],
      },
    ],
  });

  console.log(`[${rotation.name}] Fired — <@${member.slack_user_id}> is up.`);
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
      fireRotation(app, rotation).catch((err) => {
        console.error(`[${rotation.name}] Error firing rotation:`, err);
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
 * Call once at startup.
 */
export function initScheduler(app: App): void {
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
