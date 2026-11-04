// Starts a bare copy of the program with no database configured, so the setup page is what answers.
// The database it will create is dropped first, and the config folder emptied, so every run is a true first run.
import fs from 'node:fs';
import pg from 'pg';

const n = process.env.SETUP_DB!;
if (!/^utilities_e2e_setup_[a-z0-9_]*$/.test(n)) throw new Error('SETUP_DB must start with utilities_e2e_setup_');
const a = new pg.Client({ connectionString: 'postgres://utilities_owner:dev@localhost/postgres' });
await a.connect();
await a.query(`drop database if exists ${n} with (force)`);
await a.end();
fs.rmSync(process.env.CONFIG_DIR!, { recursive: true, force: true });
delete process.env.DATABASE_URL;
await import('../src/main.js');
