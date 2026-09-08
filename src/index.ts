import { App, type RespondArguments } from "@slack/bolt";
import { getRotation, getMembers } from "./db.js";
import {
  createRotation,
  updateRotation,
  deleteRotation,
  listRotationsWithMembers,
} from "./rotations.js";
import {
  initScheduler,
  scheduleRotation,
  cancelRotation,
  fireRotation,
} from "./scheduler.js";
import {
  buildMainMenu,
  buildRotationList,
  buildRotationModal,
  parseModalValues,
} from "./ui.js";

// ── App ───────────────────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  // Socket Mode: no public URL needed — the bot dials out to Slack
  socketMode: true,
});

// ── /rotation command ─────────────────────────────────────────────────────────

app.command("/rotation", async ({ ack, respond }) => {
  await ack();
  await respond({
    response_type: "ephemeral",
    text: "Obie Rotator",
    blocks: buildMainMenu(),
  } as RespondArguments);
});

// ── /rotation-next <name>  (manual trigger, useful for testing) ───────────────

app.command("/rotation-next", async ({ command, ack, respond }) => {
  await ack();

  const name = command.text.trim();
  if (!name) {
    await respond("Usage: `/rotation-next <rotation name>`");
    return;
  }

  const rotations = listRotationsWithMembers();
  const rotation = rotations.find(
    (r) => r.name.toLowerCase() === name.toLowerCase(),
  );

  if (!rotation) {
    await respond(
      `No rotation named "${name}" found. Use \`/rotation\` to see all.`,
    );
    return;
  }

  await fireRotation(app, rotation);
  await respond({
    response_type: "ephemeral",
    text: `Triggered *${rotation.name}*!`,
  });
});

// ── Action: open create modal ─────────────────────────────────────────────────

app.action("open_create_rotation", async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: buildRotationModal({
      callbackId: "create_rotation",
      title: "Create Rotation",
    }),
  });
});

// ── Action: list rotations ────────────────────────────────────────────────────

app.action("open_list_rotations", async ({ ack, respond }) => {
  await ack();
  const rotations = listRotationsWithMembers();
  await respond({
    response_type: "ephemeral",
    replace_original: false,
    text: "Rotations",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: buildRotationList(rotations) as any,
  });
});

// ── Action: open edit modal ───────────────────────────────────────────────────

app.action("open_edit_rotation", async ({ ack, body, client }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotationId = parseInt((body as any).actions[0].value as string, 10);
  const rotation = getRotation(rotationId);
  if (!rotation) return;

  const members = getMembers(rotationId);

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: buildRotationModal({
      callbackId: "edit_rotation",
      title: "Edit Rotation",
      rotationId,
      prefill: { ...rotation, memberIds: members.map((m) => m.slack_user_id) },
    }),
  });
});

// ── Action: trigger rotation now ─────────────────────────────────────────────

app.action("trigger_rotation", async ({ ack, body, respond }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotationId = parseInt((body as any).actions[0].value as string, 10);
  const rotation = getRotation(rotationId);
  if (!rotation) {
    await respond({ response_type: "ephemeral", text: "Rotation not found." });
    return;
  }

  await fireRotation(app, rotation);
  await respond({
    response_type: "ephemeral",
    replace_original: false,
    text: `Triggered *${rotation.name}*!`,
  });
});

// ── Action: delete rotation ───────────────────────────────────────────────────

app.action("delete_rotation", async ({ ack, body, respond }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotationId = parseInt((body as any).actions[0].value as string, 10);
  const rotation = getRotation(rotationId);
  const name = rotation?.name ?? `#${rotationId}`;

  cancelRotation(rotationId);
  deleteRotation(rotationId);

  await respond({
    response_type: "ephemeral",
    replace_original: false,
    text: `Deleted rotation *${name}*.`,
  });
});

// ── View submission: create rotation ─────────────────────────────────────────

app.view("create_rotation", async ({ ack, body, view }) => {
  const form = parseModalValues(view.state.values);

  if (form.memberIds.length === 0) {
    await ack({
      response_action: "errors",
      errors: { members_block: "Add at least one member." },
    });
    return;
  }

  if (form.cadence === "weekly" && form.days.length === 0) {
    await ack({
      response_action: "errors",
      errors: { days_block: "Pick at least one day for a weekly rotation." },
    });
    return;
  }

  await ack();

  const rotation = createRotation({
    name: form.name,
    channel: form.channel,
    cadence: form.cadence,
    days: form.days,
    dayOfMonth: form.dayOfMonth ?? undefined,
    hour: form.hour,
    minute: form.minute,
    timezone: form.timezone,
    memberIds: form.memberIds,
  });

  scheduleRotation(app, rotation);

  // DM the creator a confirmation
  await app.client.chat.postMessage({
    channel: body.user.id,
    text: `✅ Rotation *${rotation.name}* created and scheduled!`,
  });
});

// ── View submission: edit rotation ────────────────────────────────────────────

app.view("edit_rotation", async ({ ack, body, view }) => {
  const rotationId = parseInt(view.private_metadata, 10);
  const form = parseModalValues(view.state.values);

  if (form.memberIds.length === 0) {
    await ack({
      response_action: "errors",
      errors: { members_block: "Add at least one member." },
    });
    return;
  }

  if (form.cadence === "weekly" && form.days.length === 0) {
    await ack({
      response_action: "errors",
      errors: { days_block: "Pick at least one day for a weekly rotation." },
    });
    return;
  }

  await ack();

  const rotation = updateRotation(rotationId, {
    name: form.name,
    channel: form.channel,
    cadence: form.cadence,
    days: form.days,
    dayOfMonth: form.dayOfMonth ?? undefined,
    hour: form.hour,
    minute: form.minute,
    timezone: form.timezone,
    memberIds: form.memberIds,
  });

  // Reschedule with updated settings
  scheduleRotation(app, rotation);

  await app.client.chat.postMessage({
    channel: body.user.id,
    text: `✅ Rotation *${rotation.name}* updated!`,
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log("obie-rotator running (Socket Mode)");
  initScheduler(app);
})();
