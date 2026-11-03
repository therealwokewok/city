import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(databaseUrl: string, appPassword?: string) {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query('create table if not exists schema_migrations (name text primary key, at timestamptz not null default now())');
    const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('begin');
      try {
        await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await c.query('insert into schema_migrations (name) values ($1)', [f]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
    if (appPassword) {
      await c.query(`alter role utilities_app login password ${pg.escapeLiteral(appPassword)}`);
    }
  } finally {
    await c.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate(process.env.OWNER_DATABASE_URL ?? process.env.DATABASE_URL!, process.env.APP_DB_PASSWORD)
    .then(() => console.log('migrations applied'))
    .catch((e) => { console.error(e); process.exit(1); });
}
