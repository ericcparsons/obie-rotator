import { App, type RespondArguments } from "@slack/bolt";
import { getRotation, getMembers, isOwner } from "./db.js";
import {
  createRotation,
  updateRotation,
  deleteRotation,
  listRotationsWithMembers,
  listRotationsOwnedBy,
  getNextFiringDates,
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
  buildReorderModal,
  parseModalValues,
} from "./ui.js";
import { reorderMembers } from "./db.js";

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

// ── /rotation-status — show who's up next for this channel (visible to anyone) ─

app.command("/rotation-status", async ({ command, ack, respond }) => {
  await ack();

  const channelRotations = listRotationsWithMembers().filter(
    (r) => r.channel === command.channel_id,
  );

  if (channelRotations.length === 0) {
    await respond({
      response_type: "ephemeral",
      text: "No rotations are configured for this channel.",
    });
    return;
  }

  const dateFmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];

  for (const rotation of channelRotations) {
    if (rotation.members.length === 0) continue;

    // Rotate so next up is first
    const startIdx = rotation.current_index % rotation.members.length;
    const orderedMembers = [
      ...rotation.members.slice(startIdx),
      ...rotation.members.slice(0, startIdx),
    ];

    const firingDates = getNextFiringDates(rotation, orderedMembers.length);

    const queueLines = orderedMembers.map((m, i) => {
      const date = firingDates[i] ? dateFmt.format(firingDates[i]) : "";
      const marker = i === 0 ? "→" : "  ";
      const suffix = i === 0 ? " _(next up)_" : "";
      return `${marker} ${date} — <@${m.slack_user_id}>${suffix}`;
    });

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rotation.name}*\n${queueLines.join("\n")}`,
        },
      },
      { type: "divider" },
    );
  }

  await respond({
    response_type: "ephemeral",
    text: "Rotation status",
    blocks,
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

app.action("open_list_rotations", async ({ ack, body, respond }) => {
  await ack();
  const rotations = listRotationsOwnedBy(body.user.id);
  await respond({
    response_type: "ephemeral",
    replace_original: true,
    text: "Rotations",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: buildRotationList(rotations) as any,
  });
});

// ── Action: cadence changed — update modal fields live ────────────────────────

app.action("cadence_select", async ({ ack, body, client }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as any;
  const selectedCadence = b.actions[0].selected_option
    ?.value as "daily" | "weekly" | "monthly";
  const view = b.view;
  const callbackId = view.callback_id as "create_rotation" | "edit_rotation";
  const rotationId = view.private_metadata
    ? parseInt(view.private_metadata, 10)
    : undefined;

  await client.views.update({
    view_id: view.id,
    hash: view.hash,
    view: buildRotationModal({
      callbackId,
      title: callbackId === "edit_rotation" ? "Edit Rotation" : "Create Rotation",
      rotationId: isNaN(rotationId as number) ? undefined : rotationId,
      activeCadence: selectedCadence,
    }),
  });
});

// ── Action: open edit modal ───────────────────────────────────────────────────

app.action("open_edit_rotation", async ({ ack, body, client, respond }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotationId = parseInt((body as any).actions[0].value as string, 10);
  const rotation = getRotation(rotationId);
  if (!rotation) return;

  if (!isOwner(rotation, body.user.id)) {
    await respond({ response_type: "ephemeral", text: "You're not an owner of this rotation." });
    return;
  }

  const members = getMembers(rotationId);
  const ownerIds = rotation.owners ? JSON.parse(rotation.owners) as string[] : [];

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: buildRotationModal({
      callbackId: "edit_rotation",
      title: "Edit Rotation",
      rotationId,
      prefill: { ...rotation, memberIds: members.map((m) => m.slack_user_id), ownerIds },
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

  if (!isOwner(rotation, body.user.id)) {
    await respond({ response_type: "ephemeral", text: "You're not an owner of this rotation." });
    return;
  }

  await fireRotation(app, rotation);
});

// ── Action: delete rotation ───────────────────────────────────────────────────

app.action("delete_rotation", async ({ ack, body, respond }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotationId = parseInt((body as any).actions[0].value as string, 10);
  const rotation = getRotation(rotationId);
  const name = rotation?.name ?? `#${rotationId}`;

  if (rotation && !isOwner(rotation, body.user.id)) {
    await respond({ response_type: "ephemeral", text: "You're not an owner of this rotation." });
    return;
  }

  cancelRotation(rotationId);
  deleteRotation(rotationId);

  await respond({
    response_type: "ephemeral",
    replace_original: true,
    text: `Rotation *${name}* deleted.`,
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

  // Always include the creator as an owner
  const ownerIds = Array.from(new Set([body.user.id, ...form.ownerIds]));

  const rotation = createRotation({
    name: form.name,
    channel: form.channel,
    cadence: form.cadence,
    days: form.days,
    dayOfMonth: form.dayOfMonth ?? undefined,
    hour: form.hour,
    minute: form.minute,
    timezone: form.timezone,
    messageTemplate: form.messageTemplate,
    ownerIds,
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
    messageTemplate: form.messageTemplate,
    ownerIds: form.ownerIds,
    memberIds: form.memberIds,
  });

  // Reschedule with updated settings
  scheduleRotation(app, rotation);
});

// ── Action: open reorder modal ────────────────────────────────────────────────

app.action("open_reorder_rotation", async ({ ack, body, client, respond }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotationId = parseInt((body as any).actions[0].value as string, 10);
  const rotation = getRotation(rotationId);
  if (!rotation) return;

  if (!isOwner(rotation, body.user.id)) {
    await respond({ response_type: "ephemeral", text: "You're not an owner of this rotation." });
    return;
  }

  const rawMembers = getMembers(rotationId);
  if (rawMembers.length === 0) return;

  // Rotate so "next up" is first — Slot #1 in the modal = next to fire
  const startIdx = rotation.current_index % rawMembers.length;
  const members = [
    ...rawMembers.slice(startIdx),
    ...rawMembers.slice(0, startIdx),
  ];

  // Resolve display names for all members (requires users:read scope)
  const nameMap = new Map<string, string>();
  await Promise.all(
    members.map(async (m) => {
      try {
        const res = await client.users.info({ user: m.slack_user_id });
        const profile = res.user?.profile;
        const name =
          profile?.display_name_normalized ||
          profile?.real_name_normalized ||
          profile?.real_name ||
          m.slack_user_id;
        nameMap.set(m.slack_user_id, name);
      } catch {
        nameMap.set(m.slack_user_id, m.slack_user_id);
      }
    }),
  );

  const firingDates = getNextFiringDates(rotation, members.length);

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: buildReorderModal(rotation, members, nameMap, firingDates),
  });
});

// ── View submission: reorder rotation ────────────────────────────────────────

app.view("reorder_rotation", async ({ ack, body, view }) => {
  await ack();

  const rotationId = parseInt(view.private_metadata, 10);
  const rotation = getRotation(rotationId);
  if (!rotation) return;

  const members = getMembers(rotationId);
  const values = view.state.values;

  // Read each slot's selected user in slot order
  const newOrder = members.map((_, i) => {
    return values[`slot_block_${i}`].slot_user_select
      .selected_option?.value as string;
  });

  // Validate: no duplicates
  const unique = new Set(newOrder);
  if (unique.size !== newOrder.length) {
    // Can't show modal errors after ack() without response_action — just skip silently
    // TODO: pre-validate before ack if needed
    return;
  }

  reorderMembers(rotationId, newOrder);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log("obie-rotator running (Socket Mode)");
  initScheduler(app);
})();
