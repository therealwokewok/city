import type pg from 'pg';
import { audit, elevate } from '../db.js';
import { priceRate, taxLine, validateRate, type RateConfig } from '../rates.js';
import { loadSettings } from '../settings.js';
import { bad, notFound, requirePerm } from './accounts.js';
import { requestApproval } from './billing.js';

/*
 * Fixing a wrong meter reading. Example: the reader wrote 15,000 when the meter said 14,500, so the customer was
 * billed for 500 units too many. Changing that reading also changes the usage of the next reading (it is counted
 * from this one), so the two together always add up to what the meter really shows. For every bill that already
 * used one of those readings, we price the bill again with the right usage and the rate that applied then. The
 * difference becomes an adjustment that a different person approves, exactly like any other adjustment.
 */

interface Change { reading_id: string; old_usage: number; new_usage: number; billed_run_id: string | null }

export async function previewCorrection(c: pg.PoolClient, readingId: string, newValue: number) {
  if (!(newValue >= 0) || !Number.isFinite(newValue)) throw bad('Enter the right meter number, zero or more');
  const r = (await c.query(
    `select r.*, m.account_id, m.service_code, m.serial, m.multiplier from readings r join meters m on m.id = r.meter_id where r.id = $1`,
    [readingId])).rows[0];
  if (!r) throw notFound('Reading not found');
  if (r.status !== 'accepted') throw bad('Only an accepted reading can be corrected. Check the reading instead.');
  const oldValue = Number(r.value);
  if (oldValue === newValue) throw bad('That is the same number that is already saved');
  const hasPrev = !!(await c.query(
    `select 1 from readings where meter_id = $1 and status = 'accepted' and id <> $2 and (read_at, created_at) < ($3, $4) limit 1`,
    [r.meter_id, r.id, r.read_at, r.created_at])).rows[0];
  const next = (await c.query(
    `select * from readings where meter_id = $1 and status = 'accepted' and id <> $2 and (read_at, created_at) > ($3, $4)
     order by read_at, created_at limit 1`, [r.meter_id, r.id, r.read_at, r.created_at])).rows[0];
  const delta = (newValue - oldValue) * Number(r.multiplier);
  const changes: Change[] = [];
  if (hasPrev) changes.push({ reading_id: r.id, old_usage: Number(r.usage), new_usage: Number(r.usage) + delta, billed_run_id: r.billed_run_id });
  if (next) changes.push({ reading_id: next.id, old_usage: Number(next.usage), new_usage: Number(next.usage) - delta, billed_run_id: next.billed_run_id });
  if (changes.some((x) => x.new_usage < 0)) throw bad('That number would make the usage less than zero. Check the number, or the reading after it.');

  // Price each bill that used a changed reading, before and after.
  const s = await loadSettings(c);
  let amount = 0;
  const bills: { run_id: string; period_end: string; old_cents: number; new_cents: number }[] = [];
  for (const runId of [...new Set(changes.filter((x) => x.billed_run_id).map((x) => x.billed_run_id!))]) {
    const run = (await c.query('select id, period_end from bill_runs where id = $1', [runId])).rows[0];
    const periodEnd = typeof run.period_end === 'string' ? run.period_end.slice(0, 10) : (run.period_end as Date).toISOString().slice(0, 10);
    // usage per meter on this account for this service, as billed in that run
    const used = (await c.query(
      `select m.id, m.serial, coalesce(sum(rd.usage), 0) as u from meters m
       join readings rd on rd.meter_id = m.id and rd.billed_run_id = $1 and rd.status = 'accepted'
       where m.account_id = $2 and m.service_code = $3 group by m.id, m.serial order by m.serial`,
      [runId, r.account_id, r.service_code])).rows.map((x) => ({ id: x.id as string, serial: x.serial as string, u: Number(x.u) }));
    const after = used.map((m) => ({ ...m, u: m.u + changes.filter((x) => x.billed_run_id === runId && m.id === r.meter_id).reduce((t, x) => t + x.new_usage - x.old_usage, 0) }));
    const services = (await c.query(
      `select distinct on (rt.service_code) rt.service_code, rt.config from rates rt
       join account_services s on s.service_code = rt.service_code and s.account_id = $2 and s.enabled
       where rt.effective_from <= $1 order by rt.service_code, rt.effective_from desc`, [periodEnd, r.account_id])).rows;
    let oldCents = 0, newCents = 0, oldTax = 0, newTax = 0;
    for (const sv of services) {
      const rate = validateRate(sv.config) as RateConfig;
      if (rate.type !== 'metered' || (rate.basis ?? sv.service_code) !== r.service_code) continue;
      const price = (ms: typeof used) => {
        const parts = rate.per_meter ? ms.map((m) => priceRate(rate, m.u, m.serial)) : [priceRate(rate, ms.reduce((t, m) => t + m.u, 0))];
        return { cents: parts.flatMap((p) => p.lines).reduce((t, l) => t + l.amount_cents, 0), taxable: parts.reduce((t, p) => t + p.taxable, 0) };
      };
      const o = price(used), n = price(after);
      oldCents += o.cents; newCents += n.cents; oldTax += o.taxable; newTax += n.taxable;
    }
    oldCents += taxLine(oldTax, s.tax_bps)?.amount_cents ?? 0;
    newCents += taxLine(newTax, s.tax_bps)?.amount_cents ?? 0;
    bills.push({ run_id: runId, period_end: periodEnd, old_cents: oldCents, new_cents: newCents });
    amount += newCents - oldCents;
  }
  return {
    reading_id: r.id as string, meter_id: r.meter_id as string, account_id: r.account_id as string, serial: r.serial as string,
    service_code: r.service_code as string, old_value: oldValue, new_value: newValue, usage_change: delta,
    changes, bills, amount_cents: amount, next_reading_id: (next?.id ?? null) as string | null,
  };
}

/** Asks for a correction. With no money involved (not billed yet) it is fixed right away; otherwise it waits for approval. */
export async function requestCorrection(c: pg.PoolClient, actor: string, readingId: string, newValue: number, reason: string) {
  await requirePerm(c, 'runs.manage');
  if (!reason.trim()) throw bad('Please say what was wrong with the reading');
  const p = await previewCorrection(c, readingId, newValue);
  const units = Math.abs(p.usage_change);
  const summary = `Corrected meter reading: meter ${p.serial} was saved as ${p.old_value}, the right number is ${p.new_value} (${units} ${p.usage_change < 0 ? 'fewer' : 'more'} units). ${reason.trim()}`.slice(0, 1000);
  const open = (await c.query(`select 1 from reading_corrections where reading_id = $1 and status = 'pending'`, [readingId])).rows[0];
  if (open) throw bad('A fix for this reading is already waiting for approval');
  const approvalId = p.amount_cents !== 0
    ? await requestApproval(c, actor, { kind: 'adjustment', account_id: p.account_id, amount_cents: p.amount_cents, reason: summary })
    : null;
  const row = (await c.query(
    `insert into reading_corrections (city_id, reading_id, old_value, new_value, reason, amount_cents, approval_id, requested_by)
     values (app_city(), $1, $2, $3, $4, $5, $6, $7) returning id`,
    [readingId, p.old_value, p.new_value, reason.trim(), p.amount_cents, approvalId, actor])).rows[0];
  if (!approvalId) await applyCorrection(c, row.id);
  await audit(c, actor, 'reading.correct.request', { correction_id: row.id, reading_id: readingId, amount_cents: p.amount_cents });
  return { id: row.id as string, status: approvalId ? 'needs_approval' as const : 'applied' as const, preview: p, approval_id: approvalId };
}

/** Changes the reading (and the next one's usage) once the money side is approved. */
export async function applyCorrection(c: pg.PoolClient, correctionId: string) {
  for (const p of ['runs.manage', 'accounts.manage', 'meters.read', 'runs.read']) await elevate(c, p);
  const k = (await c.query('select * from reading_corrections where id = $1 for update', [correctionId])).rows[0];
  if (!k || k.status !== 'pending') throw bad('That fix is not waiting');
  const p = await previewCorrection(c, k.reading_id, Number(k.new_value));
  if (p.old_value !== Number(k.old_value) || p.amount_cents !== Number(k.amount_cents)) {
    throw bad('The readings changed after this fix was asked for. Decline it and ask again.');
  }
  for (const ch of p.changes) await c.query('update readings set usage = $2 where id = $1', [ch.reading_id, ch.new_usage]);
  await c.query(`update readings set value = $2, note = trim(coalesce(note, '') || ' [corrected from ' || $3 || ']') where id = $1`, [p.reading_id, p.new_value, String(p.old_value)]);
  if (!p.next_reading_id) await c.query('update meters set last_value = $2 where id = $1', [p.meter_id, p.new_value]);
  await c.query(`update reading_corrections set status = 'applied', applied_at = now() where id = $1`, [correctionId]);
  await audit(c, null, 'reading.correct.apply', { correction_id: correctionId, reading_id: p.reading_id, old_value: p.old_value, new_value: p.new_value });
}
