import type pg from 'pg';
import { audit, elevate } from '../db.js';
import { penaltyCents } from '../money.js';
import { Line, priceRate, RateConfig, taxLine, validateRate } from '../rates.js';
import { loadSettings } from '../settings.js';
import { bad, forbid, notFound, requirePerm } from './accounts.js';
import { protectedAccounts } from './arrangements.js';
import { applyCorrection } from './corrections.js';

// ---------- meter readings ----------
export async function submitReading(c: pg.PoolClient, actor: string, r: {
  meter_id: string; value: number; read_at: string; client_id: string; note?: string;
}) {
  if (!(r.value >= 0) || !Number.isFinite(r.value)) throw bad('Enter a meter reading of zero or more');
  if (!/^[A-Za-z0-9_\-:.]{8,80}$/.test(r.client_id)) throw bad('Bad client id');
  const m = await c.query('select id, last_value from meters where id = $1 and active', [r.meter_id]);
  if (!m.rows[0]) throw notFound('Meter not found');
  const last: number | null = m.rows[0].last_value;
  let status = 'pending';
  let note = r.note ?? null;
  if (last !== null && r.value < last) { status = 'flagged'; note = ((note ?? '') + ' [lower than last read]').trim(); }
  const ins = await c.query(
    `insert into readings (city_id, meter_id, client_id, value, read_at, submitted_by, status, note)
     values (app_city(), $1, $2, $3, $4, $5, $6, $7) on conflict (city_id, client_id) do nothing returning id, status`,
    [r.meter_id, r.client_id, r.value, r.read_at, actor, status, note],
  );
  if (ins.rows[0]) {
    await audit(c, actor, 'reading.submit', { reading_id: ins.rows[0].id, meter_id: r.meter_id });
    return { id: ins.rows[0].id as string, status: ins.rows[0].status as string, duplicate: false };
  }
  // Phones retry after a bad connection; a repeated client id returns the original instead of a second copy.
  const ex = await c.query('select id, status from readings where client_id = $1', [r.client_id]);
  return { id: ex.rows[0]?.id as string, status: ex.rows[0]?.status as string, duplicate: true };
}

export async function reviewReading(c: pg.PoolClient, actor: string, id: string, decision: 'accept' | 'reject', opts: {
  usage_override?: number; note?: string;
} = {}) {
  const rd = await c.query(
    `select r.*, m.last_value, m.multiplier from readings r join meters m on m.id = r.meter_id
     where r.id = $1 for update of r`, [id]);
  const r = rd.rows[0];
  if (!r) throw notFound();
  if (!['pending', 'flagged'].includes(r.status)) throw bad('That reading was already reviewed');
  if (r.submitted_by === actor) throw forbid('You cannot review a reading you submitted');
  if (decision === 'reject') {
    await c.query(`update readings set status = 'rejected', reviewed_by = $2, reviewed_at = now(), note = coalesce($3, note) where id = $1`,
      [id, actor, opts.note ?? null]);
    await audit(c, actor, 'reading.reject', { reading_id: id });
    return;
  }
  let usage: number;
  if (r.last_value === null) usage = 0; // first read sets the baseline
  else if (opts.usage_override !== undefined) usage = opts.usage_override; // rollover or meter swap, clerk states the usage
  else if (r.value < r.last_value) throw bad('Reading is lower than the last one. Enter the real usage to accept it.');
  else usage = (r.value - r.last_value) * r.multiplier;
  if (usage < 0) throw bad('Usage cannot be negative');
  await c.query(
    `update readings set status = 'accepted', usage = $2, reviewed_by = $3, reviewed_at = now(), note = coalesce($4, note) where id = $1`,
    [id, usage, actor, opts.note ?? null]);
  await c.query('update meters set last_value = $2 where id = $1', [r.meter_id, r.value]);
  await audit(c, actor, 'reading.accept', { reading_id: id, usage });
}

// ---------- bill runs ----------
export async function createRun(c: pg.PoolClient, actor: string, r: { period_start: string; period_end: string; due_date?: string }) {
  await requirePerm(c, 'runs.manage');
  const s = await loadSettings(c);
  if (r.period_end < r.period_start) throw bad('Period end is before period start');
  const due = r.due_date ?? (await c.query(`select ($1::date + $2::int)::text as d`, [r.period_end, s.due_days])).rows[0].d;
  try {
    const ins = await c.query(
      `insert into bill_runs (city_id, period_start, period_end, due_date, created_by) values (app_city(), $1, $2, $3, $4) returning id`,
      [r.period_start, r.period_end, due, actor]);
    await audit(c, actor, 'run.create', { run_id: ins.rows[0].id });
    return ins.rows[0].id as string;
  } catch (e: any) {
    if (e.code === '23505') throw bad('A bill run for that period already exists');
    throw e;
  }
}

export interface RunResult { bills: number; total_cents: number; warnings: { account: string; service: string; reason: string }[] }

export async function calculateRun(c: pg.PoolClient, actor: string, runId: string): Promise<RunResult> {
  await requirePerm(c, 'runs.manage');
  const s = await loadSettings(c);
  const run = (await c.query('select * from bill_runs where id = $1 for update', [runId])).rows[0];
  if (!run) throw notFound();
  if (!['draft', 'calculated'].includes(run.status)) throw bad('This run is already posted');
  const tz = (await c.query('select timezone from cities where id = app_city()')).rows[0].timezone as string;

  // Start clean so a recalculation never double-bills.
  await c.query(`update readings set billed_run_id = null where billed_run_id = $1`, [runId]);
  await c.query(`update extra_charges set billed_run_id = null where billed_run_id = $1 and not recurring`, [runId]);
  await c.query(`delete from bills where run_id = $1`, [runId]);

  const accounts = (await c.query(`select id, account_number from accounts where status = 'active' order by account_number`)).rows;
  const svc = (await c.query(
    `select s.account_id, s.service_code, s.quantity from account_services s
     join services sv on sv.city_id = s.city_id and sv.code = s.service_code
     where s.enabled and sv.enabled order by s.service_code`)).rows;
  const meters = (await c.query(`select id, account_id, service_code, serial from meters where active order by serial`)).rows;
  const usage = new Map<string, number>(
    (await c.query(
      `select meter_id, sum(usage) as u from readings
       where status = 'accepted' and billed_run_id is null
         and read_at < (($1::date + 1)::timestamp at time zone $2) group by meter_id`,
      [run.period_end, tz])).rows.map((r) => [r.meter_id, r.u]));
  const rates = new Map<string, RateConfig>(
    (await c.query(
      `select distinct on (service_code) service_code, config from rates where effective_from <= $1
       order by service_code, effective_from desc`, [run.period_end])).rows.map((r) => [r.service_code, validateRate(r.config)]));
  const extras = (await c.query(
    `select * from extra_charges where active and (recurring or billed_run_id is null) order by created_at`)).rows;

  const out: RunResult = { bills: 0, total_cents: 0, warnings: [] };
  const usedMeters: string[] = [];
  const usedExtras: string[] = [];

  for (const a of accounts) {
    const lines: Line[] = [];
    let taxable = 0;
    const mine = svc.filter((x) => x.account_id === a.id);
    for (const { service_code: code, quantity } of mine as { service_code: string; quantity: number }[]) {
      const rate = rates.get(code);
      if (!rate) { out.warnings.push({ account: a.account_number, service: code, reason: 'no rate set for this service' }); continue; }
      if (rate.type === 'flat') {
        const p = priceRate(rate, 0, undefined, quantity);
        lines.push(...p.lines); taxable += p.taxable;
        continue;
      }
      const basis = rate.basis ?? code;
      const ms = meters.filter((m) => m.account_id === a.id && m.service_code === basis && usage.has(m.id));
      if (!ms.length) { out.warnings.push({ account: a.account_number, service: code, reason: 'no accepted meter reading' }); continue; }
      if (rate.per_meter) {
        for (const m of ms) {
          const p = priceRate(rate, usage.get(m.id)!, m.serial);
          lines.push(...p.lines); taxable += p.taxable;
        }
      } else {
        const p = priceRate(rate, ms.reduce((t, m) => t + usage.get(m.id)!, 0));
        lines.push(...p.lines); taxable += p.taxable;
      }
      usedMeters.push(...ms.map((m) => m.id));
    }
    for (const e of extras.filter((x) => x.account_id === a.id)) {
      lines.push({ code: e.code, description: e.description, amount_cents: e.amount_cents });
      if (!e.recurring) usedExtras.push(e.id);
    }
    const tl = taxLine(taxable, s.tax_bps);
    if (tl) lines.push(tl);
    if (!lines.length) continue;
    const total = lines.reduce((t, l) => t + l.amount_cents, 0);
    await c.query(
      `insert into bills (city_id, run_id, account_id, lines, total_cents, due_date, period_start, period_end) values (app_city(), $1, $2, $3, $4, $5, $6, $7)`,
      [runId, a.id, JSON.stringify(lines), total, run.due_date, run.period_start, run.period_end]);
    out.bills += 1; out.total_cents += total;
  }
  if (usedMeters.length) {
    await c.query(
      `update readings set billed_run_id = $1 where meter_id = any($2::uuid[]) and status = 'accepted' and billed_run_id is null
         and read_at < (($3::date + 1)::timestamp at time zone $4)`, [runId, usedMeters, run.period_end, tz]);
  }
  if (usedExtras.length) await c.query('update extra_charges set billed_run_id = $1 where id = any($2::uuid[])', [runId, usedExtras]);
  await c.query(`update bill_runs set status = 'calculated', calculated_at = now() where id = $1`, [runId]);
  await audit(c, actor, 'run.calculate', { run_id: runId, bills: out.bills, total_cents: out.total_cents, warnings: out.warnings.length });
  return out;
}

/** The second person signs off; this is the moment the bills become real money on the ledger. */
export async function approveRun(c: pg.PoolClient, actor: string, runId: string) {
  await requirePerm(c, 'runs.approve');
  const run = (await c.query('select * from bill_runs where id = $1 for update', [runId])).rows[0];
  if (!run) throw notFound();
  if (run.status !== 'calculated') throw bad('Calculate the run before approving it');
  if (run.created_by === actor) throw forbid('The person who started a bill run cannot approve it');
  await elevate(c, 'ledger.post');
  const bills = (await c.query(`select id, account_id, total_cents from bills where run_id = $1 and status = 'draft'`, [runId])).rows;
  let total = 0;
  for (const b of bills) {
    if (b.total_cents !== 0) {
      await c.query(
        `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo, created_by)
         values (app_city(), $1, 'bill', $2, 'bill', $3, $4, $5)`,
        [b.account_id, b.total_cents, b.id, `Bill ${run.period_start} to ${run.period_end}`, actor]);
    }
    total += b.total_cents;
  }
  await c.query(`update bills set status = 'posted', posted_at = now() where run_id = $1 and status = 'draft'`, [runId]);
  await c.query(`update bill_runs set status = 'posted', approved_by = $2, approved_at = now() where id = $1`, [runId, actor]);
  await audit(c, actor, 'run.approve', { run_id: runId, bills: bills.length, total_cents: total });
  return { bills: bills.length, total_cents: total };
}

// ---------- late charges and shutoff list ----------
export async function runPenalties(c: pg.PoolClient, actor: string, asOf: string) {
  await requirePerm(c, 'runs.manage');
  const s = await loadSettings(c);
  await elevate(c, 'ledger.post');
  const due = (await c.query(
    `select id, account_id, total_cents, posted_at from bills where status = 'posted' and penalized_at is null and due_date < $1::date
     order by due_date, id for update`, [asOf])).rows;
  const plans = await protectedAccounts(c, asOf);
  let count = 0, total = 0, skipped = 0;
  for (const b of due) {
    // A bill that is part of a payment plan the customer is keeping up with gets no late charge.
    const plan = plans.get(b.account_id);
    if (plan && b.posted_at && new Date(b.posted_at) <= plan.since) { skipped++; continue; }
    const bal = (await c.query('select coalesce(sum(amount_cents), 0) as b from ledger_entries where account_id = $1', [b.account_id])).rows[0].b as number;
    const overdue = Math.min(b.total_cents, bal);
    const pen = penaltyCents(overdue, s.penalty_bps);
    if (pen > 0) {
      await c.query(
        `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo, created_by)
         values (app_city(), $1, 'penalty', $2, 'bill', $3, 'Late charge', $4)`, [b.account_id, pen, b.id, actor]);
      count++; total += pen;
    }
    await c.query('update bills set penalized_at = now() where id = $1', [b.id]);
  }
  await audit(c, actor, 'penalty.run', { as_of: asOf, charged: count, total_cents: total, on_payment_plan: skipped });
  return { charged: count, total_cents: total, on_payment_plan: skipped };
}

export async function shutoffList(c: pg.PoolClient, asOf: string) {
  const s = await loadSettings(c);
  const r = await c.query(
    `select a.id, a.account_number, a.name, a.service_address, (bal.balance - coalesce(nd.notyet, 0)) as overdue_cents
     from accounts a
     join lateral (select coalesce(sum(amount_cents), 0) as balance from ledger_entries l where l.account_id = a.id) bal on true
     left join lateral (select sum(total_cents) as notyet from bills b
        where b.account_id = a.id and b.status = 'posted' and b.due_date + $2::int >= $1::date) nd on true
     where a.status = 'active' and bal.balance - coalesce(nd.notyet, 0) > 0
       and coalesce((select kind from work_orders w where w.account_id = a.id and w.status = 'done' order by w.completed_at desc limit 1), '') <> 'shutoff'
     order by a.account_number`,
    [asOf, s.shutoff_notice_days]);
  // What is still to be paid on a plan they are keeping up with does not count as overdue; anything else still does.
  const plans = await protectedAccounts(c, asOf);
  return r.rows
    .map((x) => ({ ...x, overdue_cents: Number(x.overdue_cents) - (plans.get(x.id)?.remaining_cents ?? 0), on_plan: plans.has(x.id) }))
    .filter((x) => x.overdue_cents > 0);
}

/**
 * Posted bills, newest first, each with how much of it is still owed. What is owed is the account balance, counted
 * against the newest bills first, so a partial payment shows the older bill as paid and the newest as partly paid.
 */
export async function billsWithStatus(c: pg.PoolClient, accountId: string, limit = 24) {
  const bills = (await c.query(
    `select id, lines, total_cents, due_date, posted_at, period_start, period_end from bills
     where account_id = $1 and status = 'posted' order by posted_at desc, id desc limit $2`, [accountId, limit])).rows;
  let left = Math.max(0, Number(await balance(c, accountId)));
  for (const b of bills) {
    const t = Number(b.total_cents);
    const owe = Math.max(0, Math.min(t, left));
    left -= owe;
    Object.assign(b, { left_cents: owe, paid_cents: Math.max(0, t - owe), pay_status: owe <= 0 ? 'paid' : owe < t ? 'partly_paid' : 'unpaid' });
  }
  return bills;
}

export async function balance(c: pg.PoolClient, accountId: string): Promise<number> {
  const r = await c.query('select coalesce(sum(amount_cents), 0) as b from ledger_entries where account_id = $1', [accountId]);
  return r.rows[0].b;
}

// ---------- extra charges, adjustments, approvals ----------
export async function createCharge(c: pg.PoolClient, actor: string, ch: {
  account_id: string; code: string; description: string; amount_cents: number; recurring?: boolean;
}) {
  const s = await loadSettings(c);
  if (!Number.isInteger(ch.amount_cents) || ch.amount_cents === 0) throw bad('Enter an amount in cents');
  if (!/^[A-Z0-9]{1,6}$/.test(ch.code)) throw bad('Charge code is 1 to 6 capital letters or numbers');
  const acct = await c.query('select id from accounts where id = $1', [ch.account_id]);
  if (!acct.rows[0]) throw notFound('Account not found');
  if (Math.abs(ch.amount_cents) > s.approval_limit_cents) {
    const id = await requestApproval(c, actor, { kind: 'charge', account_id: ch.account_id, amount_cents: ch.amount_cents,
      code: ch.code, reason: ch.description });
    return { approval_id: id, status: 'needs_approval' as const };
  }
  const r = await c.query(
    `insert into extra_charges (city_id, account_id, code, description, amount_cents, recurring, created_by)
     values (app_city(), $1, $2, $3, $4, $5, $6) returning id`,
    [ch.account_id, ch.code, ch.description, ch.amount_cents, ch.recurring ?? false, actor]);
  await audit(c, actor, 'charge.create', { charge_id: r.rows[0].id, account_id: ch.account_id, amount_cents: ch.amount_cents });
  return { charge_id: r.rows[0].id as string, status: 'created' as const };
}

/** A refund can never be larger than the credit the customer actually has, and only one request per credit at a time. */
async function assertRefundable(c: pg.PoolClient, accountId: string, cents: number, ignoreApproval?: string) {
  const credit = -(await balance(c, accountId));
  const pending = (await c.query(
    `select coalesce(sum(amount_cents), 0) as t from approvals where account_id = $1 and kind = 'refund' and status = 'pending' and ($2::uuid is null or id <> $2)`,
    [accountId, ignoreApproval ?? null])).rows[0].t;
  if (credit - Number(pending) < cents) throw bad('The customer does not have that much credit to refund');
}

export async function requestApproval(c: pg.PoolClient, actor: string, a: {
  kind: 'adjustment' | 'charge' | 'refund'; account_id: string; amount_cents: number; reason: string; code?: string;
}) {
  if (!Number.isInteger(a.amount_cents) || a.amount_cents === 0) throw bad('Enter an amount in cents');
  if (!a.reason.trim()) throw bad('A reason is required');
  const acct = await c.query('select id from accounts where id = $1', [a.account_id]);
  if (!acct.rows[0]) throw notFound('Account not found');
  if (a.kind === 'refund') {
    if (a.amount_cents < 0) throw bad('A refund amount must be more than zero');
    await assertRefundable(c, a.account_id, a.amount_cents);
  }
  const r = await c.query(
    `insert into approvals (city_id, kind, account_id, amount_cents, code, reason, requested_by)
     values (app_city(), $1, $2, $3, $4, $5, $6) returning id`,
    [a.kind, a.account_id, a.amount_cents, a.code ?? null, a.reason.trim(), actor]);
  await audit(c, actor, 'approval.request', { approval_id: r.rows[0].id, kind: a.kind, amount_cents: a.amount_cents });
  return r.rows[0].id as string;
}

export async function decideApproval(c: pg.PoolClient, actor: string, id: string, decision: 'approve' | 'reject') {
  await requirePerm(c, 'approvals.decide');
  const s = await loadSettings(c);
  const ap = (await c.query('select * from approvals where id = $1 for update', [id])).rows[0];
  if (!ap) throw notFound();
  if (ap.status !== 'pending') throw bad('That request was already decided');
  if (ap.requested_by === actor) throw forbid('You cannot decide a request you made');
  if (decision === 'reject') {
    await c.query(`update approvals set status = 'rejected', decided_at = now() where id = $1`, [id]);
    await c.query(`update reading_corrections set status = 'rejected' where approval_id = $1 and status = 'pending'`, [id]);
    await audit(c, actor, 'approval.reject', { approval_id: id });
    return { status: 'rejected' as const };
  }
  const needsSecond = Math.abs(ap.amount_cents) > s.approval_limit_cents;
  if (!ap.approved_by) {
    await c.query('update approvals set approved_by = $2 where id = $1', [id, actor]);
    if (needsSecond) {
      await audit(c, actor, 'approval.first', { approval_id: id });
      return { status: 'needs_second' as const };
    }
  } else {
    if (ap.approved_by === actor) throw forbid('A different approver must give the second approval');
    await c.query('update approvals set second_approved_by = $2 where id = $1', [id, actor]);
  }
  await c.query(`update approvals set status = 'approved', decided_at = now() where id = $1`, [id]);
  await elevate(c, 'ledger.post');
  if (ap.kind === 'refund') {
    await assertRefundable(c, ap.account_id, ap.amount_cents, id);
    await c.query(
      `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo, created_by)
       values (app_city(), $1, 'refund', $2, 'approval', $3, $4, $5)`, [ap.account_id, ap.amount_cents, id, 'Refund: ' + ap.reason, actor]);
  } else if (ap.kind === 'adjustment') {
    // A fixed meter reading: change the reading itself in the same step as the money.
    const fix = (await c.query(`select id from reading_corrections where approval_id = $1 and status = 'pending'`, [id])).rows[0];
    if (fix) await applyCorrection(c, fix.id);
    await c.query(
      `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo, created_by)
       values (app_city(), $1, 'adjustment', $2, 'approval', $3, $4, $5)`, [ap.account_id, ap.amount_cents, id, ap.reason, actor]);
  } else {
    await c.query(
      `insert into extra_charges (city_id, account_id, code, description, amount_cents, created_by)
       values (app_city(), $1, $2, $3, $4, $5)`, [ap.account_id, ap.code, ap.reason, ap.amount_cents, ap.requested_by]);
  }
  await audit(c, actor, 'approval.approve', { approval_id: id, kind: ap.kind, amount_cents: ap.amount_cents });
  return { status: 'approved' as const };
}

/** Reversal is the only way to undo a ledger entry. */
export async function reverseEntry(c: pg.PoolClient, actor: string, entryId: number, reason: string) {
  await requirePerm(c, 'approvals.decide');
  await elevate(c, 'ledger.post');
  const e = (await c.query('select * from ledger_entries where id = $1', [entryId])).rows[0];
  if (!e) throw notFound();
  if (e.kind === 'reversal') throw bad('A reversal cannot be reversed');
  try {
    await c.query(
      `insert into ledger_entries (city_id, account_id, kind, amount_cents, ref_type, ref_id, memo, created_by, reverses_id)
       values (app_city(), $1, 'reversal', $2, 'ledger', $3::text, $4, $5, $3::bigint)`,
      [e.account_id, -e.amount_cents, entryId, reason, actor]);
  } catch (err: any) {
    if (err.code === '23505') throw bad('That entry was already reversed');
    throw err;
  }
  await audit(c, actor, 'ledger.reverse', { entry_id: entryId });
}
