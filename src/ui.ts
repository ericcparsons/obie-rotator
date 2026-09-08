import type { Rotation, Member } from "./db.js";
import { DEFAULT_MESSAGE_TEMPLATE } from "./db.js";
import { describeSchedule } from "./rotations.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const TIMEZONES = [
  { label: "UTC", value: "UTC" },
  { label: "ET — New York (UTC−5/−4)", value: "America/New_York" },
  { label: "CT — Chicago (UTC−6/−5)", value: "America/Chicago" },
  { label: "MT — Denver (UTC−7/−6)", value: "America/Denver" },
  { label: "AZ — Phoenix (UTC−7, no DST)", value: "America/Phoenix" },
  { label: "PT — Los Angeles (UTC−8/−7)", value: "America/Los_Angeles" },
  { label: "GMT — London (UTC+0/+1)", value: "Europe/London" },
  { label: "CET — Amsterdam/Paris", value: "Europe/Amsterdam" },
  { label: "IST — India (UTC+5:30)", value: "Asia/Kolkata" },
  { label: "JST — Tokyo (UTC+9)", value: "Asia/Tokyo" },
  { label: "AEST — Sydney (UTC+10/+11)", value: "Australia/Sydney" },
];

export const CADENCES = [
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
];

export const DAYS_OF_WEEK = [
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
  { label: "Sunday", value: "0" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function optionFor(label: string, value: string) {
  return { text: { type: "plain_text" as const, text: label }, value };
}

function toHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatHour12(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h}:00`.replace(":00", ""); // just the hour, minutes added below
}

// All 15-minute increments across a 24-hour day (96 options)
const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => {
  const hour = Math.floor(i / 4);
  const minute = (i % 4) * 15;
  const value = toHHMM(hour, minute);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const mm = String(minute).padStart(2, "0");
  const ampm = hour < 12 ? "AM" : "PM";
  const label = `${h}:${mm} ${ampm}`;
  return optionFor(label, value);
});

function nearestTimeOption(hour: number, minute: number): typeof TIME_OPTIONS[number] {
  const target = toHHMM(hour, minute);
  return (
    TIME_OPTIONS.find((o) => o.value === target) ??
    // Round minute down to nearest 15 if no exact match
    TIME_OPTIONS.find((o) => o.value === toHHMM(hour, Math.floor(minute / 15) * 15)) ??
    TIME_OPTIONS[0]
  );
}

// ── Main menu (ephemeral message) ─────────────────────────────────────────────

export function buildMainMenu() {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Obie Rotator* — manage your team rotations.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "➕ Create rotation" },
          action_id: "open_create_rotation",
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "📋 List rotations" },
          action_id: "open_list_rotations",
        },
      ],
    },
  ];
}

// ── Rotation list (ephemeral message) ─────────────────────────────────────────

export function buildRotationList(
  rotations: Array<Rotation & { members: Member[] }>,
) {
  if (rotations.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "No rotations yet. Click *➕ Create rotation* to add one.",
        },
      },
    ];
  }

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Active Rotations" },
    },
  ];

  for (const rotation of rotations) {
    const currentMember =
      rotation.members[rotation.current_index % rotation.members.length];

    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${rotation.name}*`,
            `📅 ${describeSchedule(rotation)}`,
            `👥 ${rotation.members.length} member(s) — next up: ${currentMember ? `<@${currentMember.slack_user_id}>` : "_none_"}`,
            `📢 <#${rotation.channel}>`,
          ].join("\n"),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "▶ Trigger now" },
            action_id: "trigger_rotation",
            value: String(rotation.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "↕ Reorder" },
            action_id: "open_reorder_rotation",
            value: String(rotation.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "✏ Edit" },
            action_id: "open_edit_rotation",
            value: String(rotation.id),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "🗑 Delete" },
            action_id: "delete_rotation",
            value: String(rotation.id),
            style: "danger",
            confirm: {
              title: { type: "plain_text", text: "Delete rotation?" },
              text: {
                type: "mrkdwn",
                text: `This will permanently delete *${rotation.name}* and stop all scheduled posts.`,
              },
              confirm: { type: "plain_text", text: "Delete" },
              deny: { type: "plain_text", text: "Cancel" },
              style: "danger",
            },
          },
        ],
      },
    );
  }

  return blocks;
}

// ── Create / Edit modal ───────────────────────────────────────────────────────

/**
 * Builds the modal payload for creating or editing a rotation.
 * When `prefill` is provided the fields are pre-populated (edit mode).
 */
export function buildRotationModal(opts: {
  callbackId: "create_rotation" | "edit_rotation";
  title: string;
  /** Rotation ID — passed through private_metadata in edit mode */
  rotationId?: number;
  prefill?: Rotation & { memberIds: string[]; ownerIds: string[] };
  /**
   * Cadence to use for field visibility — set by the live cadence_select action.
   * Falls back to prefill?.cadence, then 'weekly'.
   */
  activeCadence?: "daily" | "weekly" | "monthly";
}) {
  const { callbackId, title, rotationId, prefill, activeCadence } = opts;

  const cadenceOptions = CADENCES.map((c) => optionFor(c.label, c.value));
  const timezoneOptions = TIMEZONES.map((tz) => optionFor(tz.label, tz.value));
  const dayOptions = DAYS_OF_WEEK.map((d) => optionFor(d.label, d.value));

  const cadence: "daily" | "weekly" | "monthly" =
    activeCadence ?? prefill?.cadence ?? "weekly";

  // Pre-fill helpers
  const prefillCadence = cadenceOptions.find(
    (o) => o.value === cadence,
  );
  const prefillDays = prefill?.days
    ? (JSON.parse(prefill.days) as number[])
        .map((d) => dayOptions.find((o) => o.value === String(d)))
        .filter(Boolean)
    : undefined;
  const prefillTimezone = timezoneOptions.find(
    (o) => o.value === (prefill?.timezone ?? "America/New_York"),
  );
  const prefillTime =
    prefill != null ? toHHMM(prefill.hour, prefill.minute) : undefined;

  return {
    type: "modal" as const,
    callback_id: callbackId,
    private_metadata: rotationId != null ? String(rotationId) : "",
    title: { type: "plain_text" as const, text: title },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      // ── Name ──────────────────────────────────────────────────────
      {
        type: "input",
        block_id: "name_block",
        label: { type: "plain_text", text: "Rotation name" },
        element: {
          type: "plain_text_input",
          action_id: "name_input",
          placeholder: { type: "plain_text", text: "e.g. Prism New Issues" },
          initial_value: prefill?.name,
        },
      },

      // ── Channel ───────────────────────────────────────────────────
      {
        type: "input",
        block_id: "channel_block",
        label: { type: "plain_text", text: "Post to channel" },
        element: {
          type: "channels_select",
          action_id: "channel_select",
          placeholder: { type: "plain_text", text: "Select a channel" },
          initial_channel: prefill?.channel,
        },
      },

      // ── Members ───────────────────────────────────────────────────
      {
        type: "input",
        block_id: "members_block",
        label: { type: "plain_text", text: "Queue members (in order)" },
        hint: {
          type: "plain_text",
          text: "The order you select them here is the rotation order.",
        },
        element: {
          type: "multi_users_select",
          action_id: "members_select",
          placeholder: { type: "plain_text", text: "Pick team members" },
          initial_users: prefill?.memberIds,
        },
      },

      // ── Owners ────────────────────────────────────────────────────
      {
        type: "input",
        block_id: "owners_block",
        label: { type: "plain_text", text: "Owners" },
        hint: {
          type: "plain_text",
          text: "Owners can edit, delete, and manage this rotation. Only owners can see it.",
        },
        element: {
          type: "multi_users_select",
          action_id: "owners_select",
          placeholder: { type: "plain_text", text: "Select owners" },
          initial_users: prefill?.ownerIds,
        },
      },

      // ── Message template ──────────────────────────────────────────
      {
        type: "input",
        block_id: "message_block",
        label: { type: "plain_text", text: "Message template" },
        hint: {
          type: "plain_text",
          text: "{{user}} = tagged person, {{rotation}} = rotation name",
        },
        element: {
          type: "plain_text_input",
          action_id: "message_input",
          multiline: true,
          initial_value:
            prefill?.message_template ?? DEFAULT_MESSAGE_TEMPLATE,
        },
      },

      { type: "divider" },

      // ── Cadence ───────────────────────────────────────────────────
      {
        type: "input",
        block_id: "cadence_block",
        dispatch_action: true,
        label: { type: "plain_text", text: "Cadence" },
        element: {
          type: "static_select",
          action_id: "cadence_select",
          options: cadenceOptions,
          initial_option: prefillCadence ?? cadenceOptions[1], // default weekly
        },
      },

      // ── Days of week (weekly only) ────────────────────────────────
      ...(cadence === "weekly"
        ? [
            {
              type: "input",
              block_id: "days_block",
              label: { type: "plain_text", text: "Days of week" },
              optional: true,
              element: {
                type: "checkboxes",
                action_id: "days_checkboxes",
                options: dayOptions,
                ...(prefillDays && prefillDays.length > 0
                  ? { initial_options: prefillDays }
                  : {}),
              },
            },
          ]
        : []),

      // ── Day of month (monthly only) ───────────────────────────────
      ...(cadence === "monthly"
        ? [
            {
              type: "input",
              block_id: "day_of_month_block",
              label: { type: "plain_text", text: "Day of month (1–28)" },
              optional: true,
              element: {
                type: "number_input",
                action_id: "day_of_month_input",
                is_decimal_allowed: false,
                min_value: "1",
                max_value: "28",
                initial_value:
                  prefill?.day_of_month != null
                    ? String(prefill.day_of_month)
                    : undefined,
              },
            },
          ]
        : []),

      { type: "divider" },

      // ── Time ──────────────────────────────────────────────────────
      {
        type: "input",
        block_id: "time_block",
        label: { type: "plain_text", text: "Time" },
        element: {
          type: "static_select",
          action_id: "time_picker",
          options: TIME_OPTIONS,
          initial_option:
            prefill != null
              ? nearestTimeOption(prefill.hour, prefill.minute)
              : nearestTimeOption(9, 0),
        },
      },

      // ── Timezone ──────────────────────────────────────────────────
      {
        type: "input",
        block_id: "timezone_block",
        label: { type: "plain_text", text: "Timezone" },
        element: {
          type: "static_select",
          action_id: "timezone_select",
          options: timezoneOptions,
          initial_option: prefillTimezone ?? timezoneOptions[1], // default ET
        },
      },
    ],
  };
}

// ── Parse modal submission values ─────────────────────────────────────────────

export interface ParsedRotationForm {
  name: string;
  channel: string;
  memberIds: string[];
  ownerIds: string[];
  cadence: "daily" | "weekly" | "monthly";
  days: number[];
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timezone: string;
  messageTemplate: string;
}

export function parseModalValues(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: Record<string, Record<string, any>>,
): ParsedRotationForm {
  const name: string = values.name_block.name_input.value;
  const channel: string = values.channel_block.channel_select.selected_channel;
  const memberIds: string[] =
    values.members_block.members_select.selected_users ?? [];
  const ownerIds: string[] =
    values.owners_block.owners_select.selected_users ?? [];
  const cadence: "daily" | "weekly" | "monthly" =
    values.cadence_block.cadence_select.selected_option?.value ?? "weekly";

  const selectedDays: Array<{ value: string }> =
    values.days_block?.days_checkboxes?.selected_options ?? [];
  const days = selectedDays.map((o) => parseInt(o.value, 10));

  const dayOfMonthRaw: string | null =
    values.day_of_month_block?.day_of_month_input?.value ?? null;
  const dayOfMonth = dayOfMonthRaw != null ? parseInt(dayOfMonthRaw, 10) : null;

  const timeParts = (
    values.time_block.time_picker.selected_option?.value as string
  ).split(":");
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1], 10);

  const timezone: string =
    values.timezone_block.timezone_select.selected_option?.value ??
    "America/New_York";

  const messageTemplate: string =
    values.message_block.message_input.value?.trim() || DEFAULT_MESSAGE_TEMPLATE;

  return {
    name,
    channel,
    memberIds,
    ownerIds,
    cadence,
    days,
    dayOfMonth,
    hour,
    minute,
    timezone,
    messageTemplate,
  };
}

// ── Reorder Queue modal ───────────────────────────────────────────────────────

/**
 * One row per current member, each with a user_select pre-filled to their slot.
 * On submit, read each slot's selected user to get the new order.
 */
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

export function buildReorderModal(
  rotation: Rotation,
  members: Member[],
  /** Map of slack_user_id → display name, resolved by the handler */
  nameMap: Map<string, string>,
  /** Next N firing dates, one per member, in queue order */
  firingDates: Date[],
) {
  function displayName(userId: string): string {
    return nameMap.get(userId) ?? userId;
  }

  const memberBlocks = members.map((member, i) => {
    const dateLabel =
      firingDates[i] != null ? ` — ${DATE_FMT.format(firingDates[i])}` : "";
    return {
    type: "input",
    block_id: `slot_block_${i}`,
    label: { type: "plain_text" as const, text: `Position ${i + 1}${dateLabel}` },
    element: {
      type: "static_select" as const,
      action_id: "slot_user_select",
      options: members.map((m) =>
        optionFor(displayName(m.slack_user_id), m.slack_user_id),
      ),
      initial_option: optionFor(
        displayName(member.slack_user_id),
        member.slack_user_id,
      ),
    },
  };
  });

  return {
    type: "modal" as const,
    callback_id: "reorder_rotation",
    private_metadata: String(rotation.id),
    title: { type: "plain_text" as const, text: "Reorder Queue" },
    submit: { type: "plain_text" as const, text: "Save order" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${rotation.name}* — assign a member to each position.\nPosition 1 will be next up after saving.`,
        },
      },
      { type: "divider" },
      ...memberBlocks,
    ],
  };
}
