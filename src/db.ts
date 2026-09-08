import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.resolve(process.env.DB_PATH ?? "data/rotator.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

// Migrations: add columns introduced after initial schema
for (const col of [
  `ALTER TABLE rotations ADD COLUMN message_template TEXT`,
  `ALTER TABLE rotations ADD COLUMN owners TEXT`,
]) {
  try { db.exec(col); } catch { /* already exists */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS rotations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    channel          TEXT    NOT NULL,
    -- 'daily' | 'weekly' | 'monthly'
    cadence          TEXT    NOT NULL DEFAULT 'weekly',
    -- JSON array of day numbers (0=Sun … 6=Sat), only for weekly
    days             TEXT,
    -- 1–31, only for monthly
    day_of_month     INTEGER,
    -- wall-clock time in the rotation's own timezone
    hour             INTEGER NOT NULL DEFAULT 9,
    minute           INTEGER NOT NULL DEFAULT 0,
    -- IANA timezone name, e.g. "America/New_York"
    timezone         TEXT    NOT NULL DEFAULT 'America/New_York',
    -- Handlebars-style template: {{user}} and {{rotation}} are substituted at fire time
    message_template TEXT,
    -- JSON array of slack_user_ids who can manage this rotation.
    -- NULL = no restriction (legacy rotations created before owners were added).
    owners TEXT,
    current_index    INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    rotation_id   INTEGER NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
    slack_user_id TEXT    NOT NULL,
    -- 0-based position in the queue
    position      INTEGER NOT NULL,
    UNIQUE(rotation_id, position)
  );
`);

// ── Types ─────────────────────────────────────────────────────────────────────

export const DEFAULT_MESSAGE_TEMPLATE =
  "*{{rotation}}*\n<@{{user}}> you're up! 🔄";

export interface Rotation {
  id: number;
  name: string;
  channel: string;
  cadence: "daily" | "weekly" | "monthly";
  /** JSON-encoded number[] for weekly, null otherwise */
  days: string | null;
  day_of_month: number | null;
  hour: number;
  minute: number;
  timezone: string;
  /** null means use DEFAULT_MESSAGE_TEMPLATE */
  message_template: string | null;
  /** JSON-encoded string[], null = no restriction (legacy) */
  owners: string | null;
  current_index: number;
  created_at: string;
}

export interface Member {
  id: number;
  rotation_id: number;
  slack_user_id: string;
  position: number;
}

// ── Statements ────────────────────────────────────────────────────────────────

export const stmts = {
  allRotations: db.prepare("SELECT * FROM rotations ORDER BY name ASC"),

  rotationById: db.prepare("SELECT * FROM rotations WHERE id = ?"),

  rotationByName: db.prepare("SELECT * FROM rotations WHERE name = ?"),

  insertRotation: db.prepare(`
    INSERT INTO rotations (name, channel, cadence, days, day_of_month, hour, minute, timezone, message_template, owners)
    VALUES (@name, @channel, @cadence, @days, @day_of_month, @hour, @minute, @timezone, @message_template, @owners)
  `),

  updateRotation: db.prepare(`
    UPDATE rotations
    SET name = @name, channel = @channel, cadence = @cadence,
        days = @days, day_of_month = @day_of_month,
        hour = @hour, minute = @minute, timezone = @timezone,
        message_template = @message_template, owners = @owners
    WHERE id = @id
  `),

  deleteRotation: db.prepare("DELETE FROM rotations WHERE id = ?"),

  advanceIndex: db.prepare(
    "UPDATE rotations SET current_index = ? WHERE id = ?",
  ),

  membersForRotation: db.prepare(
    "SELECT * FROM members WHERE rotation_id = ? ORDER BY position ASC",
  ),

  deleteMembersForRotation: db.prepare(
    "DELETE FROM members WHERE rotation_id = ?",
  ),

  insertMember: db.prepare(`
    INSERT INTO members (rotation_id, slack_user_id, position)
    VALUES (@rotation_id, @slack_user_id, @position)
  `),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function allRotations(): Rotation[] {
  return stmts.allRotations.all() as unknown as Rotation[];
}

export function getRotation(id: number): Rotation | undefined {
  return stmts.rotationById.get(id) as unknown as Rotation | undefined;
}

export function getMembers(rotationId: number): Member[] {
  return stmts.membersForRotation.all(rotationId) as unknown as Member[];
}

/**
 * Replaces the member list for a rotation and resets current_index to 0
 * so the queue starts fresh from position 0.
 */
// node:sqlite has no transaction() helper — use manual BEGIN/COMMIT/ROLLBACK
function withTransaction(fn: () => void): void {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setMembers(rotationId: number, slackUserIds: string[]): void {
  withTransaction(() => {
    stmts.deleteMembersForRotation.run(rotationId);
    slackUserIds.forEach((slack_user_id, position) => {
      stmts.insertMember.run({
        rotation_id: rotationId,
        slack_user_id,
        position,
      });
    });
    // Reset index so we start from the top of the new list
    stmts.advanceIndex.run(0, rotationId);
  });
}

/**
 * Returns true if userId is an owner of the rotation.
 * Rotations with null owners (legacy) are visible to everyone.
 */
export function isOwner(rotation: Rotation, userId: string): boolean {
  if (rotation.owners === null) return true;
  return (JSON.parse(rotation.owners) as string[]).includes(userId);
}

/**
 * Reorders the queue without resetting current_index — the "next up" person
 * follows their new position so the rotation continues smoothly.
 */
export function reorderMembers(
  rotationId: number,
  orderedUserIds: string[],
): void {
  withTransaction(() => {
    const rotation = getRotation(rotationId);
    if (!rotation) return;

    stmts.deleteMembersForRotation.run(rotationId);
    orderedUserIds.forEach((slack_user_id, position) => {
      stmts.insertMember.run({ rotation_id: rotationId, slack_user_id, position });
    });

    // After reorder, slot #1 is always "next up"
    stmts.advanceIndex.run(0, rotationId);
  });
}

/**
 * Returns the member who is currently "up" and advances the index for next time.
 */
export function popNextMember(rotationId: number): Member | null {
  let result: Member | null = null;

  withTransaction(() => {
    const rotation = getRotation(rotationId);
    if (!rotation) return;

    const members = getMembers(rotationId);
    if (members.length === 0) return;

    const idx = rotation.current_index % members.length;
    result = members[idx];

    const nextIdx = (idx + 1) % members.length;
    stmts.advanceIndex.run(nextIdx, rotationId);
  });

  return result;
}
