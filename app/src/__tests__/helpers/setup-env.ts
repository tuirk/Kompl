// Vitest global setup — runs before any module under test is imported.
// db.ts captures DB_PATH at module load, so this MUST run first.
//
// Points DB_PATH at an OS temp dir so:
//   - readRawMarkdown / storeRawMarkdown read & write under <tmp>/raw/
//   - tests calling __setDbForTesting can ignore the file path entirely
//     (their in-memory db never touches disk)

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(tmpdir(), `kompl-test-${process.pid}`);
process.env.DB_PATH = join(root, 'db', 'kompl.db');
Object.assign(process.env, { NODE_ENV: 'test' });

mkdirSync(join(root, 'db'), { recursive: true });
mkdirSync(join(root, 'raw'), { recursive: true });
mkdirSync(join(root, 'pages'), { recursive: true });
