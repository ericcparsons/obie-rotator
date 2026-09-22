import { App, type RespondArguments, type BlockButtonAction } from "@slack/bolt";
import { db, getRotation, getMembers, isOwner, reorderMembers, advanceMember } from "./db.js";
import {
  createRotation,
  updateRotation,
  deleteRotation,
  listRotationsWithMembers,
  listRotationsOwnedBy,
  rotateToCurrentIndex,
  getNextFiringDates,
} from "./rotations.js";
import {
  getAnnotatedFiringDates,
  getRotationSkipDates,
  getSkipDatesForRotations,
  removeRotationSkipDateRange,
  toDateString,
} from "./holidays.js";
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
  buildSkipDateModal,
  parseModalValues,
  parsePrivateMeta,
} from "./ui.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function rotationIdFromAction(body: BlockButtonAction): number {
  return parseInt(body.actions[0].value ?? "", 10);
}

/** Channel ID from a button action body */
function channelFromAction(body: BlockButtonAction): string {
  return (body as unknown as { channel?: { id?: string } }).channel?.id ?? "";
}

/** Posts the owner's updated rotation list as a new ephemeral in the given channel */
async function refreshList(
  userId: string,
  channelId: string,
): Promise<void> {
  if (!channelId) return;
  const rotations = listRotationsOwnedBy(userId);
  try {
    await app.client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "Rotations",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: buildRotationList(rotations) as any,
    });
  } catch (err) {
    // channel_not_found can happen with ephemeral action contexts — log and move on
    console.warn("[refreshList] Could not post ephemeral:", (err as Error).message);
  }
}

function validateRotationForm(
  form: ReturnType<typeof parseModalValues>,
): Record<string, string> | null {
  if (form.memberIds.length === 0) {
    return { members_block: "Add at least one member." };
  }
  if (form.cadence === "weekly" && form.days.length === 0) {
    return { days_block: "Pick at least one day for a weekly rotation." };
  }
  return null;
}

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

    const orderedMembers = rotateToCurrentIndex(
      rotation.members,
      rotation.current_index,
    );

    const annotatedDates = getAnnotatedFiringDates(rotation, orderedMembers.length);

    const queueLines: string[] = [];
    let personIdx = 0;
    for (const entry of annotatedDates) {
      const dateStr = dateFmt.format(entry.date);
      if (entry.holiday) {
        const suffix = entry.holiday.isHoliday ? "(holiday)" : "(skipped)";
        queueLines.push(`   ${dateStr} — ${entry.holiday.emoji} _${entry.holiday.label}_ ${suffix}`);
      } else {
        const m = orderedMembers[personIdx];
        const marker = personIdx === 0 ? "→" : "  ";
        const suffix = personIdx === 0 ? " _(next up)_" : "";
        queueLines.push(`${marker} ${dateStr} — <@${m.slack_user_id}>${suffix}`);
        personIdx++;
      }
    }

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

// ── Action: open skip date modal (global — from main menu) ───────────────────

app.action("open_skip_date_global", async ({ ack, body, client }) => {
  await ack();

  const ownedRotations = listRotationsOwnedBy(body.user.id);
  if (ownedRotations.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const firstRotation = ownedRotations[0];

  // Fetch existing skip dates across all owned rotations
  const allSkips = getSkipDatesForRotations(ownedRotations.map((r) => r.id));
  // Deduplicate by date+label so multi-rotation skips show once
  const seen = new Set<string>();
  const existingSkips = allSkips.filter((s) => {
    const key = `${s.date}:${s.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Get channel from action body so we can refresh the list after saving
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = (body as any).channel?.id ?? "";

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: buildSkipDateModal({
      rotation: firstRotation,
      nextDate: today,
      channel,
      ownedRotations: ownedRotations.map((r) => ({ id: r.id, name: r.name })),
      existingSkips,
      preSelectAll: true,
    }),
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
  const { id: rotationId } = parsePrivateMeta(view.private_metadata);

  await client.views.update({
    view_id: view.id,
    hash: view.hash,
    view: buildRotationModal({
      callbackId,
      title: callbackId === "edit_rotation" ? "Edit Rotation" : "Create Rotation",
      rotationId,
      activeCadence: selectedCadence,
    }),
  });
});

// ── Action: open edit modal ───────────────────────────────────────────────────

app.action("open_edit_rotation", async ({ ack, body, client, respond }) => {
  await ack();

  const rotationId = rotationIdFromAction(body as BlockButtonAction);
  const rotation = getRotation(rotationId);
  if (!rotation) return;

  if (!isOwner(rotation, body.user.id)) {
    await respond({ response_type: "ephemeral", text: "You're not an owner of this rotation." });
    return;
  }

  const members = getMembers(rotationId);
  const ownerIds = rotation.owners ? JSON.parse(rotation.owners) as string[] : [];

  const channel = channelFromAction(body as BlockButtonAction);

  await client.views.open({
    trigger_id: (body as { trigger_id: string }).trigger_id,
    view: buildRotationModal({
      callbackId: "edit_rotation",
      title: "Edit Rotation",
      rotationId,
      channel,
      prefill: { ...rotation, memberIds: members.map((m) => m.slack_user_id), ownerIds },
    }),
  });
});

// ── Action: trigger rotation now ─────────────────────────────────────────────

app.action("trigger_rotation", async ({ ack, body, respond }) => {
  await ack();

  const rotationId = rotationIdFromAction(body as BlockButtonAction);
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

// ── Action: overflow menu ─────────────────────────────────────────────────────

app.action("rotation_overflow", async ({ ack, body, client, respond }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as any;
  const selected: string = b.actions[0].selected_option?.value ?? "";
  const [action, idStr] = selected.split(":");
  const rotationId = parseInt(idStr, 10);
  const rotation = getRotation(rotationId);
  if (!rotation) return;

  if (!isOwner(rotation, body.user.id)) {
    await respond({ response_type: "ephemeral", text: "You're not an owner of this rotation." });
    return;
  }

  const channel = channelFromAction(body as BlockButtonAction);

  if (action === "reorder") {
    const rawMembers = getMembers(rotationId);
    if (rawMembers.length === 0) return;
    const members = rotateToCurrentIndex(rawMembers, rotation.current_index);
    const nameMap = new Map<string, string>();
    await Promise.all(
      members.map(async (m) => {
        try {
          const res = await client.users.info({ user: m.slack_user_id });
          const profile = res.user?.profile;
          nameMap.set(
            m.slack_user_id,
            profile?.display_name_normalized ||
            profile?.real_name_normalized ||
            profile?.real_name ||
            m.slack_user_id,
          );
        } catch {
          nameMap.set(m.slack_user_id, m.slack_user_id);
        }
      }),
    );
    const firingDates = getNextFiringDates(rotation, members.length);
    await client.views.open({
      trigger_id: b.trigger_id,
      view: buildReorderModal(rotation, members, nameMap, firingDates, channel),
    });

  } else if (action === "skip_date") {
    const entries = getAnnotatedFiringDates(rotation, 1);
    const nextDate = entries[0]
      ? toDateString(entries[0].date, rotation.timezone)
      : new Date().toISOString().slice(0, 10);
    const existingSkips = getRotationSkipDates(rotation.id);
    const ownedRotations = listRotationsOwnedBy(body.user.id).map((r) => ({
      id: r.id,
      name: r.name,
    }));
    await client.views.open({
      trigger_id: b.trigger_id,
      view: buildSkipDateModal({ rotation, nextDate, channel, existingSkips, ownedRotations }),
    });

  } else if (action === "skip_person") {
    advanceMember(rotationId);
    await refreshList(body.user.id, channel);

  } else if (action === "delete") {
    const name = rotation.name;
    cancelRotation(rotationId);
    deleteRotation(rotationId);
    const updatedRotations = listRotationsOwnedBy(body.user.id);
    await respond({
      response_type: "ephemeral",
      replace_original: true,
      text: `Rotation *${name}* deleted.`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: buildRotationList(updatedRotations) as any,
    });
  }
});

// ── View submission: create rotation ─────────────────────────────────────────

app.view("create_rotation", async ({ ack, body, view }) => {
  const form = parseModalValues(view.state.values);
  const errors = validateRotationForm(form);
  if (errors) {
    await ack({ response_action: "errors", errors });
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
  const { id: rotationId, channel } = parsePrivateMeta(view.private_metadata);
  if (!rotationId) { await ack(); return; }

  const form = parseModalValues(view.state.values);
  const errors = validateRotationForm(form);
  if (errors) {
    await ack({ response_action: "errors", errors });
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

  scheduleRotation(app, rotation);
  await refreshList(body.user.id, channel ?? "");
});



// ── View submission: reorder rotation ────────────────────────────────────────

app.view("reorder_rotation", async ({ ack, body, view }) => {
  const { id: rotationId, channel } = parsePrivateMeta(view.private_metadata);
  if (!rotationId) { await ack(); return; }

  const members = getMembers(rotationId);
  const values = view.state.values;

  const newOrder = members.map((_, i) =>
    values[`slot_block_${i}`].slot_user_select.selected_option?.value as string,
  );

  const unique = new Set(newOrder);
  if (unique.size !== newOrder.length) {
    await ack({
      response_action: "errors",
      errors: { slot_block_0: "Each person can only appear once in the queue." },
    });
    return;
  }

  await ack();
  reorderMembers(rotationId, newOrder);
  await refreshList(body.user.id, channel ?? "");
});

// ── View submission: skip date ────────────────────────────────────────────────

app.view("skip_date", async ({ ack, body, view }) => {
  const fromDate: string = view.state.values.skip_from_block.skip_from_picker.selected_date ?? "";
  const toDate: string = view.state.values.skip_to_block.skip_to_picker.selected_date ?? "";

  if (toDate < fromDate) {
    await ack({
      response_action: "errors",
      errors: { skip_to_block: '"To" date must be on or after "From" date.' },
    });
    return;
  }

  await ack();

  const { id: rotationId, channel } = parsePrivateMeta(view.private_metadata);
  if (!rotationId) return;

  const rotation = getRotation(rotationId);
  if (!rotation) return;

  const reason: string = view.state.values.skip_reason_block?.skip_reason_input?.value?.trim() || "Skipped";
  const emoji: string = view.state.values.skip_emoji_block?.skip_emoji_input?.value?.trim() || ":calendar:";

  // Which rotations to apply the skip to.
  const { rotationIds: defaultRotationIds } = parsePrivateMeta(view.private_metadata);
  const selectedOptions: Array<{ value: string }> =
    view.state.values.skip_rotations_block?.skip_rotations_select?.selected_options ?? [];
  const targetRotationIds: number[] =
    selectedOptions.length > 0
      ? selectedOptions.map((o) => parseInt(o.value, 10))
      : (defaultRotationIds ?? [rotationId ?? 0]).filter(Boolean);

  const stmt = db.prepare("INSERT OR REPLACE INTO skip_dates (date, rotation_id, label, emoji) VALUES (?, ?, ?, ?)");

  for (const targetId of targetRotationIds) {
    const current = new Date(`${fromDate}T12:00:00Z`);
    const end = new Date(`${toDate}T12:00:00Z`);
    while (current <= end) {
      stmt.run(current.toISOString().slice(0, 10), targetId, reason, emoji);
      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  // Checkpoint WAL to main DB file so data survives a container restart
  try { db.exec("PRAGMA wal_checkpoint(FULL)"); } catch { /* ignore */ }

  await refreshList(body.user.id, channel ?? "");
});

// ── Action: remove a rotation-specific skip date ──────────────────────────────

app.action("remove_skip_date", async ({ ack, body, client }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as any;
  const { rotationId, fromDate, toDate } = JSON.parse(
    b.actions[0].value as string,
  ) as { rotationId: number; fromDate: string; toDate: string };

  removeRotationSkipDateRange(rotationId, fromDate, toDate);

  // Rebuild the modal with updated skip dates across all owned rotations
  const { id: modalRotationId, channel } = parsePrivateMeta(b.view.private_metadata);
  const anchorRotationId = modalRotationId ?? rotationId;
  const anchorRotation = getRotation(anchorRotationId);
  if (!anchorRotation) return;

  const ownedRotations = listRotationsOwnedBy(body.user.id).map((r) => ({
    id: r.id,
    name: r.name,
  }));
  const allSkips = getSkipDatesForRotations(ownedRotations.map((r) => r.id));
  const seen = new Set<string>();
  const existingSkips = allSkips.filter((s) => {
    const key = `${s.date}:${s.label}:${s.rotation_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const entries = getAnnotatedFiringDates(anchorRotation, 1);
  const nextDate = entries[0]
    ? toDateString(entries[0].date, anchorRotation.timezone)
    : new Date().toISOString().slice(0, 10);

  await client.views.update({
    view_id: b.view.id,
    hash: b.view.hash,
    view: buildSkipDateModal({
      rotation: anchorRotation,
      nextDate,
      channel,
      ownedRotations,
      existingSkips,
    }),
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("Received SIGTERM — checkpointing WAL and shutting down.");
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT — checkpointing WAL and shutting down.");
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
  process.exit(0);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await app.start();
  console.log("obie-rotator running (Socket Mode)");
  await initScheduler(app);
})();
