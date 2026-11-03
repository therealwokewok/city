import pg from 'pg';

export interface Ctx {
  cityId: string;
  userId: string | null;
  perms: string[];
}

// Keep dates as plain 'YYYY-MM-DD' strings, and bigint/numeric as JS numbers (cents fit well within 2^53).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => parseFloat(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  // In production connect directly as utilities_app. For local runs and tests, connect as the
  // owner and drop to the restricted role so row-level security applies exactly as in production.
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    ...(process.env.DB_SET_ROLE === '1' ? { options: '-c role=utilities_app' } : {}),
  });
  return pool;
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}

/** Run fn in one transaction with the row-level-security context set. */
export async function tx<T>(ctx: Ctx, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('begin');
    await setCtx(c, ctx);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function setCtx(c: pg.PoolClient, ctx: Ctx) {
  await c.query(
    `select set_config('app.city_id', $1, true), set_config('app.user_id', $2, true), set_config('app.perms', $3, true)`,
    [ctx.cityId, ctx.userId ?? '', ctx.perms.join(',')],
  );
}

/**
 * Domain code calls this after it has checked its own business rules (for example, that the approver is
 * not the requester) to add one extra permission for the rest of the transaction.
 */
export async function elevate(c: pg.PoolClient, perm: string) {
  await c.query(`select set_config('app.perms', current_setting('app.perms', true) || ',' || $1, true)`, [perm]);
}

export async function audit(c: pg.PoolClient, actor: string | null, action: string, detail: object = {}) {
  await c.query('select audit_append($1, $2, $3::jsonb)', [actor, action, JSON.stringify(detail)]);
}
