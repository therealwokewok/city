import type pg from 'pg';
import { audit } from '../db.js';
import { bad, notFound } from './accounts.js';
import { balance, shutoffList } from './billing.js';

/** Is service currently off for this account? True when the newest finished order is a shutoff. */
export async function isShutOff(c: pg.PoolClient, accountId: string): Promise<boolean> {
  const r = await c.query(`select kind from work_orders where account_id = $1 and status = 'done' order by completed_at desc limit 1`, [accountId]);
  return r.rows[0]?.kind === 'shutoff';
}

/** Office orders a shutoff only for an account that is on today's shutoff list, and never twice. */
export async function createWorkOrder(c: pg.PoolClient, actor: string, o: { account_id: string; kind: 'shutoff' | 'reconnect'; note?: string; as_of: string }) {
  const a = (await c.query('select id, service_address, status from accounts where id = $1', [o.account_id])).rows[0];
  if (!a) throw notFound('No such account');
  if (o.kind === 'shutoff') {
    if (await isShutOff(c, a.id)) throw bad('Service is already off for this account');
    const list = await shutoffList(c, o.as_of);
    if (!list.some((x) => x.id === a.id)) throw bad('This account is not past the notice period, so a shutoff cannot be ordered');
  } else {
    if (!(await isShutOff(c, a.id))) throw bad('Service is not off for this account');
    if ((await balance(c, a.id)) > 0) throw bad('The account still owes money. Reconnect after it is paid up');
  }
  try {
    const r = await c.query(
      `insert into work_orders (city_id, account_id, kind, address, note, created_by) values (app_city(), $1, $2, $3, $4, $5) returning id`,
      [a.id, o.kind, a.service_address, (o.note ?? '').slice(0, 500), actor]);
    await audit(c, actor, 'workorder.create', { id: r.rows[0].id, kind: o.kind, account_id: a.id });
    return r.rows[0].id as string;
  } catch (e: any) {
    if (e.code === '23505') throw bad('There is already an open order of that kind for this account');
    throw e;
  }
}

export async function finishWorkOrder(c: pg.PoolClient, actor: string, id: string, action: 'done' | 'cancelled', note: string) {
  const r = await c.query(
    `update work_orders set status = $2, completed_by = $3, completed_at = now(), completion_note = $4 where id = $1 and status = 'open' returning id, kind, account_id`,
    [id, action, actor, note.slice(0, 500)]);
  if (!r.rows[0]) throw notFound('That order is not open');
  await audit(c, actor, 'workorder.' + action, { id, kind: r.rows[0].kind, account_id: r.rows[0].account_id });
}
