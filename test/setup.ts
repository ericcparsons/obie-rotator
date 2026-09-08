import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Each test process gets a unique temp DB so files don't interfere with each other
process.env.DB_PATH = join(tmpdir(), `obie-test-${randomBytes(6).toString('hex')}.db`);
