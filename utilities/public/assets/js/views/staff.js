import { h, field, money, plainDate, showError, busy, confirmDialog, announce, todayIso, fill } from '../dom.js';
import { api, has } from '../api.js';

const dollarsToCents = (v) => {
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
};
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return h('div', {}, h('h1', {}, 'Staff'), h('p', { class: 'error', role: 'alert' }, e.message)); } };

export const dashboard = safe(async () => {
  const cards = [];
  const count = async (url, key) => (await api('GET', url))[key].length;
  if (has('billing_clerk')) {
    const n = (await count('/api/staff/readings?status=pending', 'readings')) + (await count('/api/staff/readings?status=flagged', 'readings'));
    cards.push(card(n, 'readings to check', '#/staff/readings', 'Review readings'));
  }
  if (has('billing_clerk', 'city_admin', 'approver', 'cashier', 'customer_service', 'auditor')) {
    cards.push(card(await count('/api/staff/approvals', 'approvals'), 'requests waiting for approval', '#/staff/approvals', 'See approvals'));
  }
  if (has('billing_clerk', 'customer_service')) {
    cards.push(card(await count('/api/staff/disputes', 'disputes'), 'bill questions from residents', '#/staff/disputes', 'See questions'));
  }
  if (has('billing_clerk', 'customer_service', 'city_admin')) {
    cards.push(card(await count('/api/staff/requests', 'requests'), 'service requests to handle', '#/staff/requests', 'See requests'));
  }
  if (has('billing_clerk', 'city_admin', 'customer_service')) cards.push(card(await count('/api/staff/work-orders', 'orders'), 'shutoff and reconnect orders', '#/staff/shutoffs', 'See orders'));
  if (has('billing_clerk', 'city_admin', 'approver', 'auditor')) cards.push(card('', 'Monthly billing', '#/staff/runs', 'Open bill runs'));
  if (has('billing_clerk', 'city_admin', 'approver', 'cashier', 'customer_service', 'auditor')) cards.push(card('', 'Look up a customer', '#/staff/accounts', 'Find an account'));
  if (has('billing_clerk', 'city_admin', 'site_admin', 'auditor')) cards.push(card('', 'People, settings, rates and printing', '#/admin', 'Open administration'));
  return h('div', {}, h('h1', {}, 'Staff home'), h('div', { class: 'grid' }, cards));
});
const card = (n, label, href, cta) => h('section', { class: 'card' }, n !== '' ? h('p', { class: 'big-number' }, String(n)) : null, h('p', {}, label), h('a', { class: 'btn secondary', href }, cta));

// ---------- readings ----------
export const readings = safe(async () => {
  const [p, f] = await Promise.all([api('GET', '/api/staff/readings?status=pending'), api('GET', '/api/staff/readings?status=flagged')]);
  const all = [...f.readings, ...p.readings];
  const list = h('ul', { class: 'list' });
  const draw = () => {
    fill(list, ...(all.length ? all.map((r) => {
      const low = r.last_value != null && r.value < r.last_value;
      const usage = h('input', { type: 'text', inputmode: 'decimal', id: 'u-' + r.id, autocomplete: 'off' });
      const err = h('div');
      const act = async (decision, btn) => {
        const body = { decision };
        if (decision === 'accept' && low) {
          const u = parseFloat(usage.value);
          if (!(u >= 0)) { showError(err, 'This reading is lower than the last one. Type the real amount used (for a rolled-over or replaced meter), or reject it.'); usage.focus(); return; }
          body.usage_override = u;
        }
        try {
          await busy(btn, 'Saving...', () => api('POST', `/api/staff/readings/${r.id}/review`, body));
          all.splice(all.indexOf(r), 1); announce(decision === 'accept' ? 'Reading accepted' : 'Reading rejected'); draw();
        } catch (e) { showError(err, e.message); }
      };
      const ok = h('button', { class: 'btn small', type: 'button' }, 'Accept');
      const no = h('button', { class: 'btn small secondary', type: 'button' }, 'Reject');
      ok.addEventListener('click', () => act('accept', ok)); no.addEventListener('click', () => act('reject', no));
      return h('li', {}, err,
        h('div', { class: 'row2' }, h('strong', {}, r.location || r.serial), r.status === 'flagged' ? h('span', { class: 'status warn' }, '! Check this') : null),
        h('p', { class: 'muted' }, `Meter ${r.serial.split('-').pop()}, read ${plainDate(r.read_at)}`),
        h('p', {}, `Last: ${r.last_value ?? 'none'}  →  Now: `, h('strong', {}, String(r.value))),
        r.note ? h('p', { class: 'muted' }, `Note: ${r.note}`) : null,
        low ? h('div', { class: 'field' }, h('label', { for: 'u-' + r.id }, 'Real amount used (needed because it is lower than last time)'), usage) : null,
        h('div', { class: 'actions row' }, ok, no));
    }) : [h('li', {}, h('p', { class: 'notice' }, '✓ Nothing to check. All readings are done.'))]));
  };
  draw();
  return h('div', {}, h('h1', {}, 'Review readings'), h('p', {}, 'Accept a reading if it looks right. Flagged ones are listed first.'), list);
});

// ---------- bill runs ----------
export const runs = safe(async () => {
  const { runs: rs } = await api('GET', '/api/staff/runs');
  const d = new Date(); const first = new Date(d.getFullYear(), d.getMonth() - 1, 1), last = new Date(d.getFullYear(), d.getMonth(), 0);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  let form = null;
  const autoBox = h('section', { class: 'card', 'aria-labelledby': 'auto-h' });
  if (has('billing_clerk')) {
    const am = h('div', { role: 'status' });
    const ab = h('button', { class: 'btn secondary', type: 'button' }, 'Collect autopay for bills that are due');
    ab.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Collect autopay now?', body: 'This charges the saved payment method of every autopay customer whose bill is due. Each bill is only ever charged once.', yes: 'Yes, collect', no: 'Not yet' });
      if (!ok) return;
      try { const r = await busy(ab, 'Collecting...', () => api('POST', '/api/staff/autopay/run', {})); fill(am, h('p', { class: 'notice' }, `Started ${r.charged} payments. ${r.failed ? r.failed + ' could not be collected and those customers were emailed. ' : ''}${r.skipped ? r.skipped + ' skipped because nothing is owed.' : ''}`)); announce('Autopay done.'); } catch (e) { showError(am, e.message); }
    });
    fill(autoBox, h('h2', { id: 'auto-h' }, 'Autopay'), h('p', { class: 'hint' }, 'Run this on or after the due date. Payments finish a moment later and then appear on each account.'), am, h('div', { class: 'actions' }, ab));
  }
  if (has('billing_clerk')) {
    form = h('form', { class: 'card', novalidate: true },
      h('h2', {}, 'Start a new bill run'),
      field({ id: 'ps', label: 'First day billed', type: 'date', value: iso(first), required: true }),
      field({ id: 'pe', label: 'Last day billed', type: 'date', value: iso(last), required: true }),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Start bill run')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await busy(form.querySelector('button'), 'Starting...', () => api('POST', '/api/staff/runs', { period_start: form.querySelector('#ps').value, period_end: form.querySelector('#pe').value })); location.hash = `#/staff/runs/${r.id}`; }
      catch (err) { showError(form, err.message); }
    });
  }
  return h('div', {}, h('h1', {}, 'Bill runs'), form, has('billing_clerk') ? autoBox : null,
    h('h2', {}, 'Past and current runs'),
    rs.length ? h('ul', { class: 'list' }, rs.map((r) => h('li', {}, h('a', { class: 'row2', href: `#/staff/runs/${r.id}` }, h('span', {}, `${plainDate(r.period_start)} to ${plainDate(r.period_end)}`), h('span', { class: `status ${r.status === 'posted' ? 'ok' : 'warn'}` }, runLabel(r.status)))))) : h('p', { class: 'muted' }, 'No bill runs yet.'));
});
const runLabel = (s) => ({ draft: 'Not calculated', calculated: 'Ready for approval', posted: '✓ Approved and sent to accounts', void: 'Cancelled' }[s] || s);

export const run = safe(async (id) => {
  let data = await api('GET', `/api/staff/runs/${id}`);
  const host = h('div');
  const draw = (note) => {
    const { run: r, bills } = data;
    const total = bills.reduce((t, b) => t + b.total_cents, 0);
    const actions = h('div', { class: 'actions row' });
    let needsOther = null;
    if (['draft', 'calculated'].includes(r.status) && has('billing_clerk')) {
      const b = h('button', { class: 'btn', type: 'button' }, r.status === 'draft' ? 'Calculate bills' : 'Calculate again');
      b.addEventListener('click', async () => {
        try {
          const res = await busy(b, 'Calculating...', () => api('POST', `/api/staff/runs/${id}/calculate`, {}));
          data = await api('GET', `/api/staff/runs/${id}`);
          draw(res.warnings.length ? { warn: `${res.bills} bills made. ${res.warnings.length === 1 ? '1 thing needs' : res.warnings.length + ' things need'} a look:`, list: res.warnings.map((w) => `Account ${w.account}: ${w.service} - ${w.reason}`) } : { ok: `${res.bills} bills calculated.` });
        } catch (e) { showError(host, e.message); }
      });
      actions.append(b);
    }
    if (r.status === 'calculated' && has('approver')) {
      const b = h('button', { class: 'btn', type: 'button' }, `Approve ${bills.length} bills (${money(total)})`);
      b.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: 'Approve this bill run?', body: `${bills.length} bills totaling ${money(total)} will be added to customer accounts. This cannot be undone, only corrected.`, yes: 'Yes, approve', no: 'Not yet' });
        if (!ok) return;
        try { await busy(b, 'Approving...', () => api('POST', `/api/staff/runs/${id}/approve`, {})); data = await api('GET', `/api/staff/runs/${id}`); draw({ ok: 'Approved. Bills are now on customer accounts.' }); }
        catch (e) { showError(host, e.message); }
      });
      actions.append(b);
    } else if (r.status === 'calculated') {
      needsOther = h('p', { class: 'notice warn' }, "A different person with the Approver role must approve this run. You can't approve a run you started.");
    }
    const printBox = h('div');
    if (r.status === 'posted' && has('billing_clerk')) {
      const mailBtn = h('button', { class: 'btn secondary', type: 'button' }, 'Email bills to paperless customers');
      const mailMsg = h('div', { role: 'status' });
      mailBtn.addEventListener('click', async () => {
        try {
          const res = await busy(mailBtn, 'Sending...', () => api('POST', `/api/staff/runs/${id}/email-bills`, {}));
          fill(mailMsg, h('p', { class: 'notice' }, res.emails ? `Sent ${res.emails} emails for ${res.bills} bills.${res.failed ? ` ${res.failed} could not be sent. Press the button again to retry those.` : ''}` : 'Nothing to send. Every paperless bill has already been emailed.'));
        } catch (e) { showError(mailMsg, e.message); }
      });
      actions.append(mailBtn, mailMsg);
    }
    if (r.status === 'posted' && has('billing_clerk')) {
      api('GET', '/api/staff/print-profiles').then(({ profiles }) => {
        const bills_ = profiles.filter((p) => p.kind === 'bill'), envs = profiles.filter((p) => p.kind === 'envelope');
        if (!bills_.length && !envs.length) { fill(printBox, h('p', { class: 'muted' }, 'To print, an administrator first sets up the paper and envelope sizes.')); return; }
        const sel = (kind, list) => h('select', { id: 'pp-' + kind }, list.map((p) => h('option', { value: p.id }, p.name)));
        const b = sel('bill', bills_), e = sel('env', envs);
        const openBtn = (label, path, selEl) => h('button', { class: 'btn secondary', type: 'button', onclick: () => window.open(`/api/staff/runs/${id}/print/${path}?profile=${selEl.value}`, '_blank', 'noopener') }, label);
        fill(printBox, h('h2', {}, 'Print'),
          bills_.length ? h('div', { class: 'field' }, h('label', { for: 'pp-bill' }, 'Bill paper'), b, h('div', { class: 'actions' }, openBtn('Open bills (PDF)', 'bills', b))) : null,
          envs.length ? h('div', { class: 'field' }, h('label', { for: 'pp-env' }, 'Envelope'), e, h('div', { class: 'actions' }, openBtn('Open envelopes (PDF)', 'envelopes', e))) : null);
      }).catch(() => {});
    }
    fill(host, 
      h('a', { href: '#/staff/runs' }, '← All bill runs'),
      h('h1', {}, `${plainDate(r.period_start)} to ${plainDate(r.period_end)}`),
      h('p', {}, h('span', { class: `status ${r.status === 'posted' ? 'ok' : 'warn'}` }, runLabel(r.status)), `  Due date: ${plainDate(r.due_date)}`),
      note?.ok ? h('p', { class: 'notice', role: 'status' }, note.ok) : null,
      note?.warn ? h('div', { class: 'notice warn', role: 'status' }, h('p', {}, note.warn), h('ul', {}, note.list.map((x) => h('li', {}, x)))) : null,
      actions, needsOther,
      h('h2', {}, `${bills.length} bills, ${money(total)}`),
      bills.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Name'), h('th', {}, 'Total'))),
        h('tbody', {}, bills.map((b) => h('tr', {}, h('td', { 'data-label': 'Account' }, b.account_number), h('td', { 'data-label': 'Name' }, b.name), h('td', { 'data-label': 'Total', class: 'amount' }, money(b.total_cents)))))) : h('p', { class: 'muted' }, 'No bills yet. Calculate to make them.'),
      printBox);
  };
  draw();
  return host;
});

// ---------- approvals ----------
export const approvals = safe(async () => {
  const { approvals: list } = await api('GET', '/api/staff/approvals');
  const ul = h('ul', { class: 'list' });
  const draw = () => {
    fill(ul, ...(list.length ? list.map((a) => {
      const err = h('div');
      const decide = async (decision, btn) => {
        try {
          const r = await busy(btn, 'Saving...', () => api('POST', `/api/staff/approvals/${a.id}/decide`, { decision }));
          if (r.status === 'needs_second') { a.approved_by = 'you'; announce('First approval recorded. A second approver is needed.'); } else { list.splice(list.indexOf(a), 1); }
          draw();
        } catch (e) { showError(err, e.message); }
      };
      const yes = h('button', { class: 'btn small', type: 'button' }, 'Approve'), no = h('button', { class: 'btn small secondary', type: 'button' }, 'Decline');
      yes.addEventListener('click', () => decide('approve', yes)); no.addEventListener('click', () => decide('reject', no));
      return h('li', {}, err,
        h('div', { class: 'row2' }, h('strong', {}, `${a.kind === 'charge' ? 'Charge' : a.kind === 'refund' ? 'Refund' : 'Adjustment'} on account ${a.account_number}`), h('span', { class: 'amount' + (a.amount_cents < 0 ? ' credit' : '') }, money(a.amount_cents))),
        h('p', { class: 'muted' }, a.name), h('p', {}, `Reason: ${a.reason}`),
        a.approved_by ? h('p', { class: 'notice warn' }, 'One approver has signed. A different approver must give the second approval.') : null,
        has('approver') ? h('div', { class: 'actions row' }, yes, no) : null);
    }) : [h('li', {}, h('p', { class: 'notice' }, '✓ Nothing waiting.'))]));
  };
  draw();
  return h('div', {}, h('h1', {}, 'Approvals'), h('p', {}, 'Requests from staff to change a customer account. The person who asked cannot approve their own request.'), ul);
});

// ---------- accounts ----------
export const accounts = safe(async () => {
  const input = h('input', { type: 'search', id: 'q', autocomplete: 'off', 'aria-controls': 'results' });
  const results = h('ul', { class: 'list', id: 'results' });
  let t;
  const run_ = async () => {
    try {
      const { accounts: a } = await api('GET', `/api/staff/accounts?q=${encodeURIComponent(input.value.trim())}`);
      fill(results, ...(a.length ? a.map((x) => h('li', {}, h('a', { class: 'row2', href: `#/staff/accounts/${x.id}` }, h('span', {}, h('strong', {}, x.name), h('br'), h('span', { class: 'muted' }, x.service_address)), h('span', { class: 'amount' }, x.account_number)))) : [h('li', { class: 'muted' }, 'No accounts found.')]));
    } catch (e) { fill(results, h('li', {}, h('p', { class: 'error' }, e.message))); }
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run_, 250); });
  run_();
  let add = null;
  if (has('billing_clerk', 'city_admin', 'customer_service')) {
    const host = h('div');
    const svcBox = h('div', { class: 'stack' });
    api('GET', '/api/city').then((city) => fill(svcBox, ...city.services.filter((x) => x.enabled).map((x) => {
      const q = h('input', { type: 'number', min: '1', max: '99', value: '1', id: `q-${x.code}`, 'aria-label': `How many ${x.name}`, class: 'qty', disabled: true });
      const cb = h('input', { type: 'checkbox', name: 'svc', value: x.code, 'data-kind': x.kind });
      cb.addEventListener('change', () => { q.disabled = !cb.checked; });
      return h('div', { class: 'svc-pick' }, h('label', { class: 'check' }, cb, x.name), x.kind === 'flat' ? h('span', { class: 'muted' }, ' How many: ', q) : null);
    }))).catch(() => {});
    const form = h('form', { novalidate: true },
      field({ id: 'an', label: 'Account number', required: true, autocomplete: 'off' }), field({ id: 'nm', label: 'Name on the account', required: true }),
      field({ id: 'ad', label: 'Service address', required: true }),
      h('p', { class: 'label' }, 'Services'),
      svcBox,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Add account')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { account_number: form.querySelector('#an').value.trim(), name: form.querySelector('#nm').value.trim(), service_address: form.querySelector('#ad').value.trim(), services: [...form.querySelectorAll('input[name=svc]:checked')].map((i) => ({ code: i.value, quantity: i.dataset.kind === 'flat' ? Math.max(1, Math.min(99, parseInt(form.querySelector('#q-' + i.value)?.value, 10) || 1)) : 1 })) };
      if (!body.account_number || !body.name || !body.service_address) { showError(form, 'Please fill in the account number, name and address.'); return; }
      try {
        const r = await busy(form.querySelector('button[type=submit]'), 'Adding...', () => api('POST', '/api/staff/accounts', body));
        fill(host, h('div', { class: 'card' }, h('p', { class: 'notice' }, `Account ${body.account_number} added.`), h('p', {}, 'Print this link code on the first bill. It is shown only now:'), h('p', { class: 'owe' }, r.link_code), h('a', { class: 'btn secondary', href: `#/staff/accounts/${r.id}` }, 'Open the account')));
        run_();
      } catch (err) { showError(form, err.message); }
    });
    const det = h('details', { class: 'card' }, h('summary', { class: 'label' }, 'Add a new account'), form);
    add = h('div', {}, det, host);
  }
  return h('div', {}, h('h1', {}, 'Accounts'),
    h('div', { class: 'field' }, h('label', { for: 'q' }, 'Find a customer'), h('p', { class: 'hint' }, 'Type a name, address or account number'), input), results, add);
});

export const account = safe(async (id) => {
  const d = await api('GET', `/api/staff/accounts/${id}`);
  const a = d.account;
  const out = h('div');
  const panel = h('div');
  const mini = (title, fields, submitLabel, onSubmit) => {
    const f = h('form', { class: 'card', novalidate: true }, h('h2', {}, title), fields, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, submitLabel), h('button', { class: 'btn secondary', type: 'button', onclick: () => fill(panel, ) }, 'Cancel')));
    f.addEventListener('submit', async (e) => { e.preventDefault(); try { await busy(f.querySelector('button[type=submit]'), 'Saving...', () => onSubmit(f)); } catch (err) { showError(f, err.message); } });
    fill(panel, f); f.querySelector('input,textarea')?.focus();
  };
  const buttons = h('div', { class: 'actions row' });
  const refresh = () => { location.hash = `#/staff/accounts/${id}`; render2(); };
  const render2 = () => { /* hash same: force re-render */ window.dispatchEvent(new Event('hashchange')); };
  if (has('cashier')) buttons.append(h('button', { class: 'btn', type: 'button', onclick: () => mini('Take a payment at the counter', [
    field({ id: 'pa', label: 'Amount in dollars', hint: 'For example 45.00', inputmode: 'decimal', required: true }),
    h('div', { class: 'field' }, h('label', { for: 'pm' }, 'Paid by'), h('select', { id: 'pm' }, h('option', { value: 'cash' }, 'Cash'), h('option', { value: 'check' }, 'Check'))),
    field({ id: 'pr', label: 'Check number (if a check)', autocomplete: 'off' })], 'Record payment', async (f) => {
    const c = dollarsToCents(f.querySelector('#pa').value);
    if (!c || c <= 0) throw new Error('Please type an amount like 45.00.');
    await api('POST', '/api/staff/payments/counter', { account_id: id, amount_cents: c, method: f.querySelector('#pm').value, reference: f.querySelector('#pr').value.trim() || undefined });
    refresh();
  }) }, 'Take a payment'));
  if (has('billing_clerk', 'customer_service', 'cashier')) buttons.append(h('button', { class: 'btn secondary', type: 'button', onclick: () => mini('Ask for an adjustment', [
    field({ id: 'aa', label: 'Amount in dollars', hint: 'Use a minus sign to lower the bill, like -25.00', inputmode: 'text', required: true }),
    field({ id: 'ar', label: 'Reason', hint: 'A different person must approve this', tag: 'textarea', required: true })], 'Send for approval', async (f) => {
    const c = dollarsToCents(f.querySelector('#aa').value);
    if (!c) throw new Error('Please type an amount like -25.00 or 10.00.');
    await api('POST', '/api/staff/adjustments', { account_id: id, amount_cents: c, reason: f.querySelector('#ar').value.trim() });
    fill(panel, h('p', { class: 'notice' }, 'Sent. It will appear on the account after a different person approves it.'));
  }) }, 'Ask for an adjustment'));
  if (d.balance_cents < 0 && has('billing_clerk', 'customer_service', 'cashier')) buttons.append(h('button', { class: 'btn secondary', type: 'button', onclick: () => mini('Refund a credit', [
    h('p', { class: 'hint' }, `This customer has a credit of ${money(-d.balance_cents)}. A different person must approve the refund before it is posted.`),
    field({ id: 'ra', label: 'Amount to refund in dollars', hint: 'No more than the credit', inputmode: 'decimal', required: true }),
    field({ id: 'rr', label: 'Reason and how it will be paid back', tag: 'textarea', required: true })], 'Send for approval', async (f) => {
    const c = dollarsToCents(f.querySelector('#ra').value);
    if (!c || c <= 0) throw new Error('Please type an amount like 25.00.');
    if (c > -d.balance_cents) throw new Error('That is more than the credit on the account.');
    await api('POST', '/api/staff/refunds', { account_id: id, amount_cents: c, reason: f.querySelector('#rr').value.trim() });
    fill(panel, h('p', { class: 'notice' }, 'Sent. The refund is posted after a different person approves it. The city pays the money back by check or its own bank.'));
  }) }, 'Refund a credit'));
  if (has('billing_clerk', 'customer_service')) buttons.append(h('button', { class: 'btn secondary', type: 'button', onclick: () => mini('Add a one-time charge', [
    field({ id: 'cc', label: 'Short code', hint: 'Letters or numbers, up to 6. Example: WF', maxlength: 6, required: true, autocapitalize: 'characters' }),
    field({ id: 'cd', label: 'What it is for', required: true }), field({ id: 'ca', label: 'Amount in dollars', inputmode: 'decimal', required: true })], 'Add charge', async (f) => {
    const c = dollarsToCents(f.querySelector('#ca').value);
    if (!c) throw new Error('Please type an amount like 15.00.');
    const r = await api('POST', '/api/staff/charges', { account_id: id, code: f.querySelector('#cc').value.trim().toUpperCase(), description: f.querySelector('#cd').value.trim(), amount_cents: c });
    fill(panel, h('p', { class: 'notice' }, r.status === 'created' ? 'Added. It will be on the next bill.' : 'That amount is large, so it was sent for approval first.'));
  }) }, 'Add a charge'));
  if (has('billing_clerk', 'customer_service', 'city_admin')) buttons.append(h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
    const ok = await confirmDialog({ title: 'Make a new link code?', body: 'The old code will stop working. The new code is shown once. Print it on the next bill or give it to the customer.', yes: 'Yes, make a new code', no: 'No' });
    if (!ok) return;
    try { const r = await api('POST', `/api/staff/accounts/${id}/link-code`, {}); fill(panel, h('div', { class: 'card' }, h('p', {}, 'New link code (shown once):'), h('p', { class: 'owe' }, r.link_code))); } catch (e) { showError(panel, e.message); }
  } }, 'Make a new link code'));
  const canManage = has('billing_clerk', 'customer_service', 'city_admin');
  const setSvc = async (code, enabled, quantity, msg) => {
    try { await api('POST', `/api/staff/accounts/${id}/services`, { code, enabled, quantity }); await redo(); announce(msg); } catch (e) { showError(svcSec, e.message); }
  };
  const redo = async () => { const d2 = await api('GET', `/api/staff/accounts/${id}`); d.services = d2.services; d.meters = d2.meters; drawSvc(); };
  const svcSec = h('section', { class: 'card', 'aria-labelledby': 'svc-h' });
  const drawSvc = async () => {
    const city = canManage ? await api('GET', '/api/city') : { services: [] };
    const have = new Set(d.services.map((x) => x.code));
    const rows = d.services.map((x) => {
      const q = h('input', { type: 'number', min: '1', max: '99', value: String(x.quantity), class: 'qty', id: `sq-${x.code}`, 'aria-label': `How many ${x.name}`, disabled: !canManage });
      const info = x.enabled ? (x.kind === 'flat' && x.quantity > 1 && !canManage ? `${x.quantity} of these` : (x.kind === 'flat' ? 'Flat charge' : 'Metered')) : 'Stopped';
      return h('li', { class: 'svc-row' },
        h('div', { class: 'svc-name' }, h('strong', {}, x.name), h('span', { class: 'muted' }, info)),
        h('div', { class: 'svc-actions' },
          canManage && x.kind === 'flat' ? h('span', { class: 'qty-group' }, h('label', { for: `sq-${x.code}`, class: 'inline' }, 'How many'), q,
            h('button', { class: 'btn secondary small', type: 'button', 'aria-label': `Save how many ${x.name}`, onclick: () => setSvc(x.code, x.enabled, Math.max(1, parseInt(q.value, 10) || 1), `${x.name} saved.`) }, 'Save')) : null,
          canManage ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => setSvc(x.code, !x.enabled, x.quantity, x.enabled ? `${x.name} stopped.` : `${x.name} started.`) }, x.enabled ? `Stop ${x.name}` : `Start ${x.name} again`) : null));
    });
    const addable = city.services.filter((x) => x.enabled && !have.has(x.code));
    const sel = h('select', { id: 'addsvc' }, addable.map((x) => h('option', { value: x.code }, x.name)));
    const aq = h('input', { type: 'number', min: '1', max: '99', value: '1', class: 'qty', id: 'addq' });
    const meterRows = d.meters.map((m) => h('li', { class: 'svc-row' },
      h('div', { class: 'svc-name' }, h('strong', {}, `${(d.services.find((x) => x.code === m.service_code) || {}).name || m.service_code} meter ${m.serial}`), h('span', { class: 'muted' }, `${m.location || 'No location noted'}${m.active ? '' : ' (off)'}`)),
      canManage ? h('div', { class: 'svc-actions' }, h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await api('POST', `/api/staff/meters/${m.id}/active`, { active: !m.active }); await redo(); announce('Meter updated.'); } catch (e) { showError(svcSec, e.message); } } }, m.active ? 'Turn this meter off' : 'Turn this meter on')) : null));
    const mser = h('input', { id: 'mser', type: 'text', autocomplete: 'off' }), mloc = h('input', { id: 'mloc', type: 'text', autocomplete: 'off' });
    // Only services this account already has can get a meter.
    const msel = h('select', { id: 'msvc' }, city.services.filter((x) => x.kind === 'metered' && x.enabled && have.has(x.code)).map((x) => h('option', { value: x.code }, x.name)));
    fill(svcSec, h('h2', { id: 'svc-h' }, 'Services and meters'),
      rows.length ? h('ul', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'No services yet.'),
      canManage && addable.length ? h('div', { class: 'addbox' }, h('h3', {}, 'Add a service'),
        h('div', { class: 'addgrid' }, h('div', {}, h('label', { for: 'addsvc' }, 'Service to add'), sel), h('div', {}, h('label', { for: 'addq' }, 'How many'), aq),
          h('button', { class: 'btn', type: 'button', onclick: () => setSvc(sel.value, true, Math.max(1, parseInt(aq.value, 10) || 1), 'Service added.') }, 'Add this service'))) : null,
      h('h3', {}, 'Meters'), meterRows.length ? h('ul', { class: 'list' }, meterRows) : h('p', { class: 'muted' }, 'No meters.'),
      canManage && msel.children.length ? h('div', { class: 'addbox' }, h('h3', {}, 'Add a meter'),
        h('div', { class: 'addgrid' }, h('div', {}, h('label', { for: 'msvc' }, 'Meter for'), msel), h('div', {}, h('label', { for: 'mser' }, 'Meter number'), mser), h('div', {}, h('label', { for: 'mloc' }, 'Where it is (optional)'), mloc),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!mser.value.trim()) { showError(svcSec, 'Please type the meter number.'); return; }
          try { await api('POST', '/api/staff/meters', { account_id: id, service_code: msel.value, serial: mser.value.trim(), location: mloc.value.trim() || undefined }); await redo(); announce('Meter added.'); } catch (e) { showError(svcSec, e.message); }
        } }, 'Add this meter'))) : null);
  };
  drawSvc();
  out.append(h('a', { href: '#/staff/accounts' }, '← All accounts'), h('h1', {}, a.name), h('p', { class: 'muted' }, `${a.service_address} - Account ${a.account_number}`),
    h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Balance'), h('p', { class: 'owe' }, money(d.balance_cents))), buttons, panel, svcSec,
    h('h2', {}, 'History'),
    d.ledger.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'What'), h('th', {}, 'Amount'))),
      h('tbody', {}, d.ledger.map((l) => h('tr', {}, h('td', { 'data-label': 'Date' }, plainDate(l.created_at)), h('td', { 'data-label': 'What' }, `${l.kind}${l.memo ? ' - ' + l.memo : ''}`), h('td', { 'data-label': 'Amount', class: 'amount' }, money(l.amount_cents)))))) : h('p', { class: 'muted' }, 'No activity yet.'));
  return out;
});

// ---------- disputes ----------
export const disputes = safe(async () => {
  const { disputes: list } = await api('GET', '/api/staff/disputes');
  const ul = h('ul', { class: 'list' });
  const draw = () => fill(ul, ...(list.length ? list.map((d) => {
    const f = h('form', { novalidate: true },
      h('p', {}, h('strong', {}, 'Resident says: '), d.reason), h('p', { class: 'muted' }, `Sent ${plainDate(d.created_at)}`),
      field({ id: 'r-' + d.id, label: 'Your answer to the resident', tag: 'textarea', required: true }),
      h('div', { class: 'actions row' }, h('button', { class: 'btn small', type: 'submit', 'data-s': 'resolved' }, 'Mark fixed or explained'), h('button', { class: 'btn small secondary', type: 'submit', 'data-s': 'rejected' }, 'Bill is correct')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = e.submitter?.dataset.s || 'resolved'; const resolution = f.querySelector('textarea').value.trim();
      if (!resolution) { showError(f, 'Please write a short answer.'); return; }
      try { await api('POST', `/api/staff/disputes/${d.id}/resolve`, { status, resolution }); list.splice(list.indexOf(d), 1); announce('Saved'); draw(); } catch (err) { showError(f, err.message); }
    });
    return h('li', {}, f);
  }) : [h('li', {}, h('p', { class: 'notice' }, '✓ No open questions.'))]));
  draw();
  return h('div', {}, h('h1', {}, 'Bill questions'), ul);
});

void todayIso;


// ---------- service requests ----------
const KIND = { start: 'New service', stop: 'Disconnect', move_out: 'Move out', transfer: 'Move to a new address', leak: 'Report a leak' };
const NEXT_STEP = {
  start: 'When you set up the account, use Add account on the Accounts screen, then mark this done. Any deposit goes through the normal charge screen.',
  stop: 'Schedule the disconnect and the final read. The account stays open.',
  move_out: 'Schedule the final read. After the final bill is made and mailed to the forwarding address, mark this done.',
  transfer: 'Final read at the old address, then start service at the new one. Any carried balance follows the city rules.',
  leak: 'Send the meter reader or public works the same day. Mark it done when it is fixed.',
};

export const requests = safe(async () => {
  const host = h('div'); const note = h('div', { role: 'status' });
  const tabs = h('div', { class: 'actions row', role: 'group', 'aria-label': 'Which requests to show' });
  let which = 'active';
  const load = async () => {
    const { requests: list } = await api('GET', `/api/staff/requests?status=${which}`);
    fill(host, ...(list.length ? list.map(card2) : [h('p', { class: 'muted' }, which === 'active' ? 'Nothing waiting. Nice work.' : 'Nothing here yet.')]));
  };
  const card2 = (r) => {
    const who = r.account_name ? `${r.account_name}, account ${r.account_number}` : (r.contact_name || 'New customer');
    const lines = [
      r.service_address ? ['Address', r.service_address] : r.account_address ? ['Service address', r.account_address] : null,
      r.requested_date ? ['Date wanted', plainDate(String(r.requested_date).slice(0, 10))] : null,
      r.forwarding_address ? ['Mail final bill to', r.forwarding_address] : null,
      r.phone ? ['Phone', r.phone] : null,
      r.note ? ['Note', r.note] : null,
      r.resolution ? ['Our note', r.resolution] : null,
    ].filter(Boolean);
    const msg = h('label', { for: `m-${r.id}` }, 'Note to the resident (they will see it)');
    const ta = h('textarea', { id: `m-${r.id}`, maxlength: 1000 });
    const act = (status, label, cls) => {
      const b = h('button', { class: `btn ${cls}`, type: 'button' }, label);
      b.addEventListener('click', async () => {
        try {
          await busy(b, 'Saving...', () => api('POST', `/api/staff/requests/${r.id}`, { status, resolution: ta.value.trim() || undefined }));
          fill(note, h('p', { class: 'notice', role: 'status' }, status === 'declined' ? 'Request declined. The resident can see your note.' : status === 'done' ? 'Marked done.' : 'Marked scheduled.')); announce('Saved.');
          await load();
        } catch (err) { showError(card, err.message); }
      });
      return b;
    };
    const card = h('section', { class: 'card', 'aria-labelledby': `rq-${r.id}` },
      h('h2', { id: `rq-${r.id}` }, `${KIND[r.kind]}: ${who}`),
      h('p', {}, h('span', { class: `status ${r.kind === 'leak' ? 'bad' : r.status === 'done' ? 'ok' : 'warn'}` }, r.kind === 'leak' && r.status !== 'done' ? '! Urgent' : r.status === 'open' ? 'New' : r.status === 'scheduled' ? 'Scheduled' : r.status === 'done' ? '✓ Done' : 'Declined')),
      h('dl', { class: 'facts' }, lines.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      ['open', 'scheduled'].includes(r.status) ? h('div', {}, h('p', { class: 'hint' }, NEXT_STEP[r.kind]), h('div', { class: 'field' }, msg, ta),
        h('div', { class: 'actions row' }, r.status === 'open' ? act('scheduled', 'Mark scheduled', 'secondary') : null, act('done', 'Mark done', ''), act('declined', 'Cannot do this', 'secondary'))) : null);
    return card;
  };
  for (const [k, t] of [['active', 'Waiting'], ['done', 'Done'], ['declined', 'Declined']]) {
    const b = h('button', { class: 'btn secondary', type: 'button', 'aria-pressed': k === which ? 'true' : 'false' }, t);
    b.addEventListener('click', async () => { which = k; for (const x of tabs.children) x.setAttribute('aria-pressed', String(x === b)); await load(); });
    tabs.append(b);
  }
  await load();
  return h('div', {}, h('h1', {}, 'Service requests'), note, tabs, host);
});


// ---------- shutoff and reconnect work orders ----------
export const shutoffs = safe(async () => {
  const canOrder = has('billing_clerk');
  const host = h('div'), msg = h('div', { role: 'status' });
  const load = async () => {
    const [o, l] = await Promise.all([api('GET', '/api/staff/work-orders'), canOrder ? api('GET', `/api/staff/shutoff?as_of=${todayIso()}`) : { accounts: [] }]);
    const order = async (account_id, kind) => {
      const ok = await confirmDialog({ title: kind === 'shutoff' ? 'Order a shutoff?' : 'Order a reconnect?', body: kind === 'shutoff' ? 'A field worker will see the address and shut off service. Please be sure the customer has had their notice.' : 'A field worker will see the address and turn service back on.', yes: 'Yes, send the order', no: 'No, go back' });
      if (!ok) return;
      try { await api('POST', '/api/staff/work-orders', { account_id, kind }); announce('Order sent.'); await load(); } catch (e) { showError(msg, e.message); }
    };
    const cancel = async (id) => { try { await api('POST', `/api/staff/work-orders/${id}/cancel`, {}); announce('Order cancelled.'); await load(); } catch (e) { showError(msg, e.message); } };
    const kindLabel = (k) => (k === 'shutoff' ? 'Shut off' : 'Turn back on');
    const open = o.orders.filter((x) => x.status === 'open'), done = o.orders.filter((x) => x.status !== 'open');
    const latest = new Map();
    for (const x of done.filter((y) => y.status === 'done')) { const c = latest.get(x.account_id); if (!c || new Date(x.completed_at) > new Date(c.completed_at)) latest.set(x.account_id, x); }
    const doneShutoffs = [...latest.values()].filter((x) => x.kind === 'shutoff' && !open.some((y) => y.account_id === x.account_id && y.kind === 'reconnect'));
    fill(host,
      canOrder ? h('section', { class: 'card', 'aria-labelledby': 'so-h' }, h('h2', { id: 'so-h' }, 'Past due and past the notice period'),
        l.accounts.length ? h('ul', { class: 'list' }, l.accounts.map((a) => h('li', {}, h('div', { class: 'row2' }, h('span', {}, h('strong', {}, `${a.account_number} ${a.name}`), h('br'), h('span', { class: 'muted' }, a.service_address)), h('span', { class: 'amount' }, money(a.overdue_cents))),
          open.some((x) => x.address === a.service_address && x.kind === 'shutoff') ? h('p', { class: 'muted' }, 'Shutoff already ordered') : h('button', { class: 'btn secondary', type: 'button', 'aria-label': `Order shutoff for ${a.name}`, onclick: () => order(a.id, 'shutoff') }, 'Order shutoff')))) : h('p', { class: 'notice' }, '✓ No accounts to shut off.')) : null,
      h('section', { class: 'card', 'aria-labelledby': 'oo-h' }, h('h2', { id: 'oo-h' }, 'Open orders'),
        open.length ? h('ul', { class: 'list' }, open.map((x) => h('li', {}, h('strong', {}, `${kindLabel(x.kind)}: ${x.address}`), h('p', { class: 'muted' }, `Account ${x.account_number}, ${x.name}`),
          canOrder ? h('button', { class: 'btn secondary', type: 'button', 'aria-label': `Cancel order for ${x.address}`, onclick: () => cancel(x.id) }, 'Cancel this order') : null))) : h('p', { class: 'muted' }, 'None waiting for the field crew.')),
      canOrder && doneShutoffs.length ? h('section', { class: 'card', 'aria-labelledby': 'rc-h' }, h('h2', { id: 'rc-h' }, 'Service is off'),
        h('ul', { class: 'list' }, doneShutoffs.map((x) => h('li', {}, h('span', {}, `${x.account_number} ${x.name}, ${x.address}`),
          h('button', { class: 'btn secondary', type: 'button', 'aria-label': `Order reconnect for ${x.name}`, onclick: () => order(x.account_id, 'reconnect') }, 'Order reconnect'))))) : null,
      done.length ? h('details', { class: 'card' }, h('summary', {}, 'Finished orders'), h('ul', {}, done.slice(0, 30).map((x) => h('li', {}, `${kindLabel(x.kind)}, ${x.address}: ${x.status === 'done' ? 'done' : 'cancelled'}${x.completion_note ? ' - ' + x.completion_note : ''}`)))) : null);
  };
  await load();
  return h('div', {}, h('a', { href: '#/staff' }, '← Staff home'), h('h1', {}, 'Shutoffs and reconnects'), msg, host);
}, 'Shutoffs and reconnects');
