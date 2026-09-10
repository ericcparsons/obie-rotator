import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.resolve(process.env.DB_PATH ?? 'data/rotator.db');
const db = new DatabaseSync(dbPath);

// Use tomorrow so it appears in the upcoming rotation-status list
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const date = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

db.prepare('INSERT OR REPLACE INTO skip_dates (date, label, emoji) VALUES (?, ?, ?)')
  .run(date, 'Test Holiday', ':tada:');

console.log(`✅ Inserted test holiday for ${date}`);
console.log('Now hit ▶ Trigger now in Slack — it should skip and log the holiday.');
console.log('Run `yarn holiday:remove-test` when done.');
