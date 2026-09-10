import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.resolve(process.env.DB_PATH ?? 'data/rotator.db');
const db = new DatabaseSync(dbPath);

db.prepare("DELETE FROM skip_dates WHERE label = 'Test Holiday'").run();

console.log('✅ Test holiday removed.');
