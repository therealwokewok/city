import { h, field, money, plainDate, showError, busy, confirmDialog, announce, todayIso, fill } from '../dom.js';
import { api, has, state } from '../api.js';

const safe = (fn, title = 'Settings') => async (...a) => {
  try { return await fn(...a); } catch (e) { return h('div', {}, h('h1', {}, title), h('p', { class: 'error', role: 'alert' }, e.message)); }
};
const back = () => h('a', { href: '#/admin' }, '← Back to administration');
const select = (id, label, options, value, hint) => h('div', { class: 'field' },
  h('label', { for: id }, label), hint ? h('p', { class: 'hint', id: id + '-hint' }, hint) : null,
  h('select', { id, name: id, 'aria-describedby': hint ? id + '-hint' : null },
    options.map(([v, t]) => h('option', { value: v, selected: v === value ? true : null }, t))));
const num = (v) => { const s = String(v).trim().replace(/,/g, ''); return s !== '' && /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null; };
const dollarsToCents = (v) => { const n = num(String(v).replace(/[$]/g, '')); return n === null ? null : Math.round(n * 100); };
// Shows the message and brings it into view, so someone at the bottom of a long form sees it too.
const say = (host, msg) => { fill(host, h('p', { class: 'notice', role: 'status' }, '✓ ' + msg)); announce(msg); host.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); };

// =============== hub ===============
export const hub = safe(async () => {
  const card = (title, text, href) => h('section', { class: 'card' }, h('h2', {}, title), h('p', {}, text), h('a', { class: 'btn secondary', href }, 'Open'));
  const cards = [];
  if (has('city_admin', 'site_admin', 'auditor')) cards.push(card('People and roles', 'Add staff, choose what each person can do, turn off someone who left.', '#/admin/people'));
  if (has('city_admin', 'site_admin')) cards.push(card('City settings', 'Due dates, late charges, online payment fees, phone number, office hours and return address.', '#/admin/settings'));
  if (has('city_admin', 'site_admin')) cards.push(card('Colors, logo and demo mode', 'Match the city website: colors and logo on every page, and the demo notice on or off.', '#/admin/appearance'));
  if (has('city_admin', 'site_admin')) cards.push(card('Updates', 'See if a newer version of this program is ready, and choose where updates come from.', '#/admin/updates'));
  if (has('city_admin', 'billing_clerk')) cards.push(card('Services and rates', 'Turn water, sewer, trash and electric on or off, and set what each one costs.', '#/admin/rates'));
  if (has('city_admin', 'billing_clerk')) cards.push(card('Printing', 'Set the paper and envelope sizes you own and where each item prints.', '#/admin/printing'));
  if (has('city_admin', 'auditor')) cards.push(card('Activity log', 'See who did what, and check that the record has not been changed.', '#/admin/audit'));
  if (!cards.length) return h('div', {}, h('h1', {}, 'Administration'), h('p', { class: 'notice' }, 'Your roles do not include any administration screens.'));
  return h('div', {}, h('h1', {}, 'Administration'), h('div', { class: 'grid' }, cards));
}, 'Administration');

// =============== settings ===============
// Online payment fees. The city's processor charges it for each payment; the city can pass that on as a line item.
function feeFields(s) {
  const radio = (value, label, hint) => h('label', { class: 'radio-card', for: `cf-${value}` },
    h('input', { type: 'radio', name: 'card_fee', id: `cf-${value}`, value, checked: s.card_fee === value ? true : null }), h('span', {}, h('strong', {}, label), hint ? h('span', { class: 'hint' }, ' ' + hint) : null));
  const example = h('p', { class: 'hint', 'aria-live': 'polite' });
  const box = h('fieldset', { class: 'addbox' }, h('legend', {}, h('h2', {}, 'Fees for paying online')),
    h('p', {}, 'Stripe, the payment company, keeps part of each online payment. You can add that cost to what the customer pays, as its own line, so the city receives the full bill amount.'),
    h('p', { class: 'notice warn' }, 'Before turning a card fee on: card company rules allow a fee on credit cards only (not debit), up to 3%, and Visa must be told 30 days ahead. A fee on all cards needs Visa\'s utility Service Fee Program. Please check with Stripe and the city attorney first.'),
    h('div', { role: 'radiogroup', 'aria-label': 'Card fee' },
      radio('off', 'No card fee', '(the city pays it)'), radio('credit', 'Fee on credit cards only', '(debit cards pay no fee)'), radio('all', 'Fee on all cards', '(only with Visa\'s Service Fee Program)')),
    field({ id: 'cfp', label: 'Card: Stripe percentage', hint: 'Stripe\'s standard is 2.9', inputmode: 'decimal', value: s.card_fee_bps / 100 }),
    field({ id: 'cff', label: 'Card: Stripe amount per payment, in cents', hint: 'Stripe\'s standard is 30', inputmode: 'numeric', value: s.card_fee_fixed_cents }),
    field({ id: 'cfm', label: 'Card: never more than this percent of the bill', hint: '3 keeps within card company limits. 0 means no limit.', inputmode: 'decimal', value: s.card_fee_max_bps / 100 }),
    h('label', { class: 'check', for: 'achon' }, h('input', { type: 'checkbox', id: 'achon', checked: s.ach_fee ? true : null }), 'Add a fee to bank account payments'),
    field({ id: 'afp', label: 'Bank: Stripe percentage', hint: 'Stripe\'s standard is 0.8', inputmode: 'decimal', value: s.ach_fee_bps / 100 }),
    field({ id: 'afm', label: 'Bank: largest fee, in dollars', hint: 'Stripe\'s standard limit is 5.00. 0 means no limit.', inputmode: 'decimal', value: s.ach_fee_max_cents / 100 }),
    example);
  // A worked example, so it is easy to see what a customer will pay.
  const show = () => {
    const val = (id) => Number(box.querySelector('#' + id).value) || 0;
    const mode = box.querySelector('input[name=card_fee]:checked')?.value || 'off';
    const bps = val('cfp') * 100, fixed = val('cff'), max = val('cfm') * 100;
    let fee = mode === 'off' ? 0 : Math.ceil(((10000 + fixed) * 10000) / (10000 - bps)) - 10000;
    if (max > 0) fee = Math.min(fee, Math.floor(10000 * max / 10000));
    example.textContent = mode === 'off' ? 'Example: a $100.00 card payment costs the customer $100.00.' : `Example: a $100.00 ${mode === 'credit' ? 'credit card ' : 'card '}payment costs the customer ${money(10000 + Math.max(fee, 0))}.`;
  };
  box.addEventListener('input', show); box.addEventListener('change', show); show();
  return box;
}

// Apple Pay and Google Pay inside the same Stripe boxes. The phone hands the card to Stripe, so nothing changes for
// the city's card-safety (PCI) position. Apple needs the web address checked once; this button does that.
function walletBox() {
  const msg = h('div', { role: 'status' });
  const btn = h('button', { class: 'btn secondary', type: 'button' }, 'Turn on Apple Pay for this web address');
  btn.addEventListener('click', async () => {
    try {
      const r = await busy(btn, 'Checking with Stripe...', () => api('POST', '/api/staff/payments/wallets', {}));
      if (!r.supported) { fill(msg, h('p', { class: 'notice warn' }, 'This payment company does not offer Apple Pay here.')); return; }
      fill(msg, r.apple_pay ? h('p', { class: 'notice' }, `✓ Apple Pay is on for ${r.domain}. Google Pay is ${r.google_pay ? 'on too' : 'not on'}.`)
        : h('p', { class: 'notice warn' }, `Apple Pay is not on yet for ${r.domain}. ${r.problem || 'Stripe could not check the address. Make sure the site is reachable from the internet and try again.'}`));
    } catch (e) { showError(msg, e.message); }
  });
  return h('div', { class: 'addbox' }, h('h2', {}, 'Apple Pay and Google Pay'),
    h('p', {}, 'People can pay with the card on their phone. It shows up on its own in the payment boxes: Google Pay on Android and Chrome, Apple Pay on iPhones, iPads and Safari once the web address is checked. The fee rules above apply to the card inside the wallet.'),
    h('p', { class: 'hint' }, 'Card numbers never reach the city. The phone sends them straight to Stripe, so the city\'s card-safety (PCI) position stays the same.'),
    msg, h('div', { class: 'actions' }, btn));
}

export const settings = safe(async () => {
  const s = await api('GET', '/api/staff/settings');
  // Charges, due dates, fees and approval limits are for the city administrator only.
  const money = has('city_admin');
  const lock = (el) => { if (!money) el.querySelectorAll('input, textarea, select').forEach((i) => { i.disabled = true; }); return el; };
  const form = h('form', { novalidate: true, class: 'card' },
    field({ id: 'phone', label: 'City Hall phone number', value: s.phone, autocomplete: 'off', inputmode: 'tel' }),
    field({ id: 'office_hours', label: 'Office hours', hint: 'Shown at the bottom of every page', value: s.office_hours }),
    field({ id: 'return_address', label: 'City return address', hint: 'Printed on bills and envelopes', tag: 'textarea', value: s.return_address, maxlength: 500 }),
    field({ id: 'remit_to', label: 'Where to mail payments', hint: 'Printed on bills', tag: 'textarea', value: s.remit_to, maxlength: 500 }),
    lock(field({ id: 'due_days', label: 'Days until a bill is due', hint: 'Counted from the day the bill is made', inputmode: 'numeric', value: s.due_days })),
    lock(field({ id: 'penalty', label: 'Late charge (percent)', hint: 'For example 10 for ten percent. Use 0 for none.', inputmode: 'decimal', value: s.penalty_bps / 100 })),
    lock(field({ id: 'shutoff', label: 'Days after the due date before a shutoff can be listed', inputmode: 'numeric', value: s.shutoff_notice_days })),
    lock(field({ id: 'limit', label: 'Extra approval above this amount (dollars)', hint: 'Above this, one-time charges need an approver, and bill changes need two different approvers', inputmode: 'decimal', value: s.approval_limit_cents / 100 })),
    lock(field({ id: 'tax', label: 'Sales tax (percent)', hint: 'Use 0 if the city does not charge tax on utilities', inputmode: 'decimal', value: s.tax_bps / 100 })),
    field({ id: 'factor', label: 'Flag a meter reading that uses this many times the last use', hint: 'For example 3 catches a reading that is three times higher than last time', inputmode: 'decimal', value: s.high_usage_factor }),
    field({ id: 'stepup', label: 'Minutes a safety check stays good', hint: 'Staff retype an emailed code before risky actions. This is how long it lasts, from 1 to 30 minutes.', inputmode: 'numeric', value: s.stepup_minutes }),
    lock(feeFields(s)),
    money ? walletBox() : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save settings')));
  const msg = h('div');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => form.querySelector('#' + id).value;
    const need = (id, label, { min = 0, max = 1e9 } = {}) => { const n = num(v(id)); if (n === null || n < min || n > max) throw new Error(`Please check "${label}". It needs a number${min > 0 ? ' of at least ' + min : ''}.`); return n; };
    try {
      const body = {
        phone: v('phone').trim(), office_hours: v('office_hours').trim(), return_address: v('return_address').trim(), remit_to: v('remit_to').trim(),
        high_usage_factor: need('factor', 'High use flag', { min: 1, max: 1000 }),
        stepup_minutes: Math.round(need('stepup', 'Safety check minutes', { min: 1, max: 30 })),
      };
      if (money) Object.assign(body, {
        due_days: Math.round(need('due_days', 'Days until a bill is due', { min: 1, max: 365 })),
        penalty_bps: Math.round(need('penalty', 'Late charge', { max: 100 }) * 100),
        shutoff_notice_days: Math.round(need('shutoff', 'Days before a shutoff', { max: 365 })),
        approval_limit_cents: Math.round(need('limit', 'Bill change limit') * 100),
        tax_bps: Math.round(need('tax', 'Sales tax', { max: 100 }) * 100),
        card_fee: form.querySelector('input[name=card_fee]:checked')?.value || 'off',
        card_fee_bps: Math.round(need('cfp', 'Card fee percent', { max: 20 }) * 100),
        card_fee_fixed_cents: Math.round(need('cff', 'Card fee cents', { max: 500 })),
        card_fee_max_bps: Math.round(need('cfm', 'Card fee limit', { max: 20 }) * 100),
        ach_fee: form.querySelector('#achon').checked,
        ach_fee_bps: Math.round(need('afp', 'Bank fee percent', { max: 20 }) * 100),
        ach_fee_max_cents: Math.round(need('afm', 'Bank fee limit') * 100),
      });
      await busy(form.querySelector('button[type=submit]'), 'Saving...', () => api('PUT', '/api/staff/settings', body));
      form.querySelector('.error')?.remove();
      say(msg, 'Settings saved.');
    } catch (err) { showError(form, err.message); }
  });
  return h('div', {}, back(), h('h1', {}, 'City settings'), money ? null : h('p', { class: 'notice warn' }, 'The greyed-out money settings (late charges, due dates, fees and approval limits) can only be changed by a city administrator.'), msg, form);
}, 'City settings');

// =============== people and roles ===============
const ROLE_INFO = {
  city_admin: ['City administrator', 'Manages staff, rates and settings.'],
  site_admin: ['Site administrator', 'Runs the system. Cannot see customer accounts or money.'],
  billing_clerk: ['Billing clerk', 'Reviews meter readings and prepares monthly bills.'],
  cashier: ['Cashier', 'Takes payments at the counter.'],
  meter_reader: ['Meter reader', 'Enters meter readings in the field.'],
  approver: ['Approver', 'Approves bill runs and bill changes. Cannot approve their own work.'],
  auditor: ['Auditor', 'Can look at everything. Cannot change anything.'],
  customer_service: ['Customer service', 'Helps customers and handles bill questions.'],
};
const roleName = (r) => ROLE_INFO[r]?.[0] || r;

export const people = safe(async () => {
  const data = await api('GET', '/api/staff/users');
  const canManage = has('city_admin', 'site_admin');
  const host = h('div');
  const note = h('div', { role: 'status' });
  const reload = async (m) => { const fresh = await api('GET', '/api/staff/users'); data.users = fresh.users; data.grantable = fresh.grantable; draw(); if (m) say(note, m); };
  const rows = () => data.users.filter((u) => u.roles.some((r) => r !== 'resident') || !u.roles.length).map((u) => {
    const staffRoles = u.roles.filter((r) => r !== 'resident');
    const mine = state.me?.email === u.email;
    const body = [
      h('h2', { id: `person-${u.id}` }, u.name || u.email), h('p', { class: 'muted' }, u.email, u.active ? '' : ' (turned off)'),
      h('p', {}, staffRoles.length ? staffRoles.map(roleName).join(', ') : 'No staff roles yet'),
    ];
    if (canManage && !mine) {
      const box = h('fieldset', { class: 'roles' }, h('legend', {}, `What ${u.name || 'this person'} can do`),
        (data.grantable || []).map((r) => {
          const cb = h('input', { type: 'checkbox', id: `r-${u.id}-${r}`, checked: staffRoles.includes(r) ? true : null });
          cb.addEventListener('change', async () => {
            try {
              await api('POST', `/api/staff/users/${u.id}/roles`, { role: r, action: cb.checked ? 'grant' : 'revoke' });
              await reload(`${roleName(r)} ${cb.checked ? 'added to' : 'removed from'} ${u.name || u.email}.`);
            } catch (err) { cb.checked = !cb.checked; showError(host, err.message); }
          });
          return h('div', {}, h('label', { class: 'check multi', for: cb.id }, cb, h('span', {}, roleName(r), h('br'), h('span', { class: 'muted small' }, ROLE_INFO[r][1]))));
        }));
      body.push(box);
      if (u.active) {
        const off = h('button', { class: 'btn secondary', type: 'button' }, `Turn off ${u.name || u.email}`);
        off.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: 'Turn off this person?', body: `${u.name || u.email} will be signed out and cannot sign in again. Their past work stays in the record.`, yes: 'Yes, turn them off', no: 'No, keep them' });
          if (!ok) return;
          try { await api('POST', `/api/staff/users/${u.id}/deactivate`, {}); await reload(`${u.name || u.email} was turned off.`); } catch (err) { showError(host, err.message); }
        });
        body.push(h('div', { class: 'actions' }, off));
      }
    } else if (mine) body.push(h('p', { class: 'muted' }, 'This is you. You cannot change your own roles.'));
    return h('section', { class: 'card', 'aria-labelledby': `person-${u.id}` }, body);
  });
  function draw() {
    const add = canManage ? addForm() : null;
    fill(host, add, h('h2', {}, 'Staff'), ...rows());
  }
  function addForm() {
    const f = h('form', { novalidate: true, class: 'card' }, h('h2', {}, 'Add a staff member'),
      field({ id: 'nm', label: 'Full name', autocomplete: 'off', required: true }),
      field({ id: 'em', label: 'Email address', hint: 'They sign in with a code sent to this address. There is no password.', type: 'email', autocomplete: 'off', required: true, inputmode: 'email', autocapitalize: 'none' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Add this person')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = f.querySelector('#nm').value.trim(), email = f.querySelector('#em').value.trim();
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showError(f, 'Please type their name and a full email address.'); return; }
      try { await busy(f.querySelector('button'), 'Adding...', () => api('POST', '/api/staff/users', { email, name })); await reload(`${name} was added. Now choose what they can do.`); } catch (err) { showError(f, err.message); }
    });
    return f;
  }
  draw();
  return h('div', {}, back(), h('h1', {}, 'People and roles'),
    h('p', {}, 'A person can have more than one role. Some combinations are not allowed on purpose, so the same person cannot both start and approve a payment change.'), note, host);
}, 'People and roles');

// =============== services and rates ===============
// A price stored in mills per unit (1 mill = 1/1000 cent) is that many cents per 1,000 units.
const per1000 = (mills) => money(mills);
export function describeRate(c) {
  if (c.type === 'flat') return `${money(c.amount_cents)} flat${c.taxable ? ', taxable' : ''}`;
  const unit = c.unit || 'units';
  const parts = [c.included_units ? `${money(c.base_cents)} covers the first ${c.included_units.toLocaleString()} ${unit}` : `${money(c.base_cents)} base charge`];
  let last = c.included_units;
  for (const t of c.tiers) {
    parts.push(t.up_to === null ? (last ? `then ${per1000(t.mills_per_unit)} per 1,000 ${unit} after ${last.toLocaleString()}` : `then ${per1000(t.mills_per_unit)} per 1,000 ${unit}`) : `${per1000(t.mills_per_unit)} per 1,000 ${unit} up to ${t.up_to.toLocaleString()}`);
    if (t.up_to !== null) last = t.up_to;
  }
  if (c.minimum_cents) parts.push(`minimum ${money(c.minimum_cents)}`);
  if (c.fuel_adjust_mills_per_unit) parts.push(`${(c.adjustment_label || 'fuel adjustment').toLowerCase()} ${per1000(c.fuel_adjust_mills_per_unit)} per 1,000 ${unit}`);
  if (c.usage_factor && c.usage_factor !== 1) parts.push(`meter reading times ${c.usage_factor}`);
  if (c.per_meter) parts.push('billed for each meter');
  if (c.basis) parts.push(`based on ${c.basis} use`);
  return parts.join('; ');
}

export const rates = safe(async () => {
  const [city, r] = await Promise.all([api('GET', '/api/city'), api('GET', '/api/staff/rates')]);
  const canRates = has('city_admin');
  const canToggle = has('city_admin', 'site_admin');
  const host = h('div'); const note = h('div', { role: 'status' });
  const data = { services: city.services, rates: r.rates };
  const reload = async (m) => { const [c2, r2] = await Promise.all([api('GET', '/api/city'), api('GET', '/api/staff/rates')]); data.services = c2.services; data.rates = r2.rates; draw(); if (m) say(note, m); };
  function serviceCard(svc) {
    const mine = data.rates.filter((x) => x.service_code === svc.code);
    const today = todayIso();
    const current = mine.find((x) => String(x.effective_from).slice(0, 10) <= today);
    const parts = [h('h2', { id: `svc-${svc.code}` }, svc.name), h('p', {}, h('span', { class: `status ${svc.enabled ? 'ok' : 'warn'}` }, svc.enabled ? '✓ On' : 'Off'))];
    parts.push(current ? h('p', {}, h('strong', {}, 'Current rate: '), describeRate(current.config), h('br'), h('span', { class: 'muted' }, `Since ${plainDate(String(current.effective_from).slice(0, 10))}`)) : h('p', { class: 'notice warn' }, 'No rate set yet, so bills cannot include this service.'));
    const later = mine.filter((x) => String(x.effective_from).slice(0, 10) > today);
    if (later.length) parts.push(h('p', {}, h('strong', {}, 'Coming: '), later.map((x) => `${plainDate(String(x.effective_from).slice(0, 10))}: ${describeRate(x.config)}`).join(' | ')));
    const actions = h('div', { class: 'actions row' });
    if (canRates) actions.append(h('button', { class: 'btn', type: 'button', onclick: () => rateForm(svc) }, 'Set a new rate'));
    if (canToggle) {
      const t = h('button', { class: 'btn secondary', type: 'button' }, svc.enabled ? `Turn off ${svc.name}` : `Turn on ${svc.name}`);
      t.addEventListener('click', async () => {
        const ok = await confirmDialog({ title: svc.enabled ? `Turn off ${svc.name}?` : `Turn on ${svc.name}?`, body: svc.enabled ? 'New bill runs will leave this service off. Old bills do not change.' : 'New bill runs will include this service.', yes: 'Yes, do it', no: 'No, go back' });
        if (!ok) return;
        try { await api('POST', `/api/staff/services/${svc.code}/enabled`, { enabled: !svc.enabled }); await reload(`${svc.name} is now ${svc.enabled ? 'off' : 'on'}.`); } catch (err) { showError(host, err.message); }
      });
      actions.append(t);
    }
    parts.push(actions);
    if (mine.length > 1) parts.push(h('details', {}, h('summary', {}, 'Past rates'), h('ul', {}, mine.map((x) => h('li', {}, `${plainDate(String(x.effective_from).slice(0, 10))}: ${describeRate(x.config)}`)))));
    return h('section', { class: 'card', 'aria-labelledby': `svc-${svc.code}` }, parts);
  }
  function rateForm(svc) {
    const tiers = h('div');
    const addTier = (up = '', price = '') => {
      const i = tiers.children.length + 1;
      tiers.append(h('div', { class: 'card tier' }, h('h3', {}, `Step ${i}`),
        field({ id: `tu${i}`, label: 'Up to how many units?', hint: 'Leave empty for "everything after"', inputmode: 'decimal', value: up, autocomplete: 'off' }),
        field({ id: `tp${i}`, label: 'Price per 1,000 units (dollars)', hint: 'For example 6.50', inputmode: 'decimal', value: price, autocomplete: 'off' })));
    };
    addTier();
    const others = data.services.filter((x) => x.code !== svc.code).map((x) => [x.code, x.name]);
    const metered = h('div', {},
      field({ id: 'base', label: 'Base charge (dollars)', hint: 'The fixed charge each month', inputmode: 'decimal', value: '0' }),
      field({ id: 'inc', label: 'Units included in the base charge', inputmode: 'decimal', value: '0' }),
      h('h3', {}, 'Price for use above that'), tiers,
      h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => addTier() }, 'Add another step')),
      field({ id: 'min', label: 'Smallest monthly bill (dollars, optional)', inputmode: 'decimal', autocomplete: 'off' }),
      field({ id: 'fuel', label: 'Fuel or supply adjustment per 1,000 units (dollars, optional)', inputmode: 'decimal', autocomplete: 'off' }),
      field({ id: 'adjl', label: 'Name of that adjustment on the bill (optional)', hint: 'For example Purchased gas adjustment. Empty means Fuel adjustment', autocomplete: 'off' }),
      field({ id: 'unit', label: 'What is counted (optional)', hint: 'For example gallons, therms, kWh', autocomplete: 'off' }),
      field({ id: 'fac', label: 'Multiply the meter reading by (optional)', hint: 'For example 1.037 to turn gas CCF into therms. Empty means 1', inputmode: 'decimal', autocomplete: 'off' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'pm' }), 'Bill each meter on its own line'),
      select('basis', 'Charge based on use of another service (optional)', [['', 'No, use this service'], ...others], '', 'For example, sewer billed on water use'));
    const flat = h('div', {}, field({ id: 'amt', label: 'Amount each month (dollars)', inputmode: 'decimal', autocomplete: 'off' }));
    const kind = select('kind', 'How is it priced?', [['flat', 'One flat price'], ['metered', 'By how much is used']], 'flat');
    const sync = () => { const m = kind.querySelector('select').value === 'metered'; metered.hidden = !m; flat.hidden = m; };
    kind.querySelector('select').addEventListener('change', sync);
    const f = h('form', { novalidate: true, class: 'card' }, h('h2', {}, `New rate for ${svc.name}`),
      h('p', { class: 'hint' }, 'Old rates are never changed. The new rate starts on the date you pick, and bills before that date keep the old one.'),
      field({ id: 'desc', label: 'Name on the bill', value: svc.name, autocomplete: 'off' }),
      field({ id: 'from', label: 'Starts on', type: 'date', value: todayIso() }), kind, flat, metered,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'tx' }), 'Sales tax applies'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save this rate'), h('button', { class: 'btn secondary', type: 'button', onclick: () => draw() }, 'Cancel')));
    sync();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (id) => f.querySelector('#' + id).value;
      try {
        const taxable = f.querySelector('#tx').checked || undefined;
        let config;
        if (v('kind') === 'flat') {
          const c = dollarsToCents(v('amt')); if (c === null || c < 0) throw new Error('Please type the amount, like 18.00.');
          config = { type: 'flat', code: svc.code, description: v('desc').trim() || svc.name, amount_cents: c, taxable };
        } else {
          const base = dollarsToCents(v('base')), inc = num(v('inc'));
          if (base === null || base < 0) throw new Error('Please type the base charge, like 15.00.');
          if (inc === null || inc < 0) throw new Error('Please type the units included, like 2000. Use 0 for none.');
          const list = []; let last = inc;
          [...tiers.children].forEach((_, k) => {
            const i = k + 1; const upRaw = v('tu' + i).trim(); const price = num(v('tp' + i));
            if (price === null || price < 0) throw new Error(`Step ${i}: please type a price per 1,000 units, like 6.50.`);
            const up = upRaw === '' ? null : num(upRaw);
            if (upRaw !== '' && (up === null || up <= last)) throw new Error(`Step ${i}: "up to" must be a number bigger than the one before it.`);
            if (up === null && i !== tiers.children.length) throw new Error(`Step ${i}: only the last step can be empty.`);
            list.push({ up_to: up, mills_per_unit: Math.round(price * 100) }); if (up !== null) last = up;
          });
          const minC = v('min').trim() ? dollarsToCents(v('min')) : null, fuel = v('fuel').trim() ? num(v('fuel')) : null;
          if (v('min').trim() && (minC === null || minC < 0)) throw new Error('Smallest bill must be an amount like 12.00.');
          if (v('fuel').trim() && (fuel === null || fuel < 0)) throw new Error('Fuel adjustment must be an amount like 1.20.');
          const fac = v('fac').trim() ? num(v('fac')) : null;
          if (v('fac').trim() && (fac === null || fac <= 0 || fac > 1000)) throw new Error('The multiplier must be a number like 1.037.');
          config = { type: 'metered', code: svc.code, description: v('desc').trim() || svc.name, base_cents: base, included_units: inc, tiers: list, taxable,
            ...(v('adjl').trim() ? { adjustment_label: v('adjl').trim().slice(0, 40) } : {}), ...(v('unit').trim() ? { unit: v('unit').trim().slice(0, 20) } : {}), ...(fac && fac !== 1 ? { usage_factor: fac } : {}),
            ...(minC ? { minimum_cents: minC } : {}), ...(fuel ? { fuel_adjust_mills_per_unit: Math.round(fuel * 100) } : {}),
            ...(f.querySelector('#pm').checked ? { per_meter: true } : {}), ...(v('basis') ? { basis: v('basis') } : {}) };
        }
        if (!v('from')) throw new Error('Please pick the day the rate starts.');
        await busy(f.querySelector('button[type=submit]'), 'Saving...', () => api('POST', '/api/staff/rates', { service_code: svc.code, effective_from: v('from'), config }));
        await reload(`New ${svc.name} rate saved.`);
      } catch (err) { showError(f, err.message); }
    });
    fill(host, f); f.querySelector('input')?.focus();
  }
  // Services in use first, then the rest, each in A to Z order.
  function draw() { fill(host, ...[...data.services].sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name)).map(serviceCard)); }
  draw();
  return h('div', {}, back(), h('h1', {}, 'Services and rates'), note, host);
}, 'Services and rates');

// =============== printing ===============
const SRC_LABEL = {
  static: 'Fixed text you type', 'city.name': 'City name', 'city.return_address': 'City return address', 'city.remit_to': 'Where to mail payments',
  'city.office_hours': 'Office hours', 'account.name': 'Customer name', 'account.number': 'Account number', 'account.service_address': 'Service address',
  'account.mailing_address': 'Mailing address', 'bill.period': 'Billing period', 'bill.due': 'Due date', 'bill.total': 'Total due', 'bill.lines': 'List of charges',
  return_address: 'Return address', recipient: 'Customer name and address', 'city.phone': 'City Hall phone number',
  box: 'A box (frame) around part of the page', line: 'A line across the page (divider)',
};
const BILL_SOURCES = ['static', 'city.name', 'city.return_address', 'city.remit_to', 'city.office_hours', 'city.phone', 'account.name', 'account.number', 'account.service_address', 'account.mailing_address', 'bill.period', 'bill.due', 'bill.total', 'bill.lines', 'box', 'line'];
const ENV_SOURCES = ['static', 'city.name', 'return_address', 'recipient', 'box', 'line'];
const SHAPES = ['box', 'line'];
const UNIT_LABEL = { in: 'inches', mm: 'millimeters', pt: 'points (72 to an inch)' };

// A new layout starts filled in, so nobody prints blank pages. Positions fit US letter paper folded in three for a
// #10 window envelope, and a plain #10 envelope. Staff move things to match their own paper.
const STARTER = {
  // Letter paper folded in three for a #10 double-window envelope. The address area (about 1 to 4.5 inches across,
  // 2 to 3 inches down) is left clear so it shows through the window.
  bill: { units: 'in', page: { width: 8.5, height: 11 }, fields: [
    { source: 'city.name', x: 0.5, y: 0.45, size: 18, bold: true },
    { source: 'city.return_address', x: 0.5, y: 0.8, size: 9, width: 3.5 },
    { source: 'box', x: 4.6, y: 0.4, width: 3.4, height: 1.45, text: 'Your account' },
    { source: 'account.number', x: 4.75, y: 0.7, size: 10, label: 'Account number: ', width: 3.1 },
    { source: 'account.service_address', x: 4.75, y: 0.92, size: 10, label: 'Service at: ', width: 3.1 },
    { source: 'bill.period', x: 4.75, y: 1.14, size: 9, label: 'Billing period: ', width: 3.1 },
    { source: 'city.phone', x: 4.75, y: 1.5, size: 9, label: 'Questions? Call City Hall at ', width: 3.1 },
    { source: 'account.name', x: 1, y: 2.15, size: 11 },
    { source: 'account.mailing_address', x: 1, y: 2.35, size: 11, width: 3.4 },
    { source: 'box', x: 4.85, y: 2.15, width: 3.15, height: 1.05, shade: true, text: 'Amount due' },
    { source: 'bill.total', x: 5, y: 2.45, size: 22, bold: true, width: 2.85 },
    { source: 'bill.due', x: 5, y: 2.88, size: 10, bold: true, label: 'Please pay by ', width: 2.85 },
    { source: 'line', x: 0.5, y: 3.5, width: 7.5 },
    { source: 'static', x: 0.5, y: 3.65, size: 12, bold: true, text: 'What you are being charged for' },
    { source: 'bill.lines', x: 0.5, y: 3.95, size: 10, width: 7.5, height: 3.9 },
    { source: 'city.office_hours', x: 0.5, y: 8.05, size: 9, width: 7.5, label: 'City Hall hours: ' },
    { source: 'line', x: 0.5, y: 8.55, width: 7.5, shade: true, text: 'Cut here and send the bottom part with your payment' },
    { source: 'box', x: 0.5, y: 8.8, width: 7.5, height: 1.85, text: 'Payment stub' },
    { source: 'account.name', x: 0.7, y: 9.12, size: 10, bold: true, width: 3.6 },
    { source: 'account.number', x: 0.7, y: 9.34, size: 10, label: 'Account number: ', width: 3.6 },
    { source: 'city.remit_to', x: 0.7, y: 9.66, size: 9, label: 'Mail to: ', width: 3.6 },
    { source: 'bill.total', x: 4.75, y: 9.12, size: 11, bold: true, label: 'Amount due: ', width: 3.1 },
    { source: 'bill.due', x: 4.75, y: 9.36, size: 10, label: 'Please pay by ', width: 3.1 },
    { source: 'static', x: 4.75, y: 9.86, size: 10, text: 'Amount paid: $ ______________', width: 3.1 },
    { source: 'static', x: 0.7, y: 10.3, size: 9, text: 'Please write your account number on your check.', width: 7.1 },
  ] },
  envelope: { units: 'in', page: { width: 9.5, height: 4.125 }, fields: [
    { source: 'return_address', x: 0.35, y: 0.3, size: 9, width: 3 },
    { source: 'recipient', x: 4.25, y: 2, size: 12, width: 4.5 },
  ] },
};

export const printing = safe(async () => {
  const { profiles } = await api('GET', '/api/staff/print-profiles');
  const canManage = has('city_admin');
  const host = h('div'); const note = h('div', { role: 'status' });
  const data = { profiles };
  const reload = async (m) => { data.profiles = (await api('GET', '/api/staff/print-profiles')).profiles; draw(); if (m) say(note, m); };
  function list() {
    const out = [];
    for (const [kind, title, none] of [['bill', 'Bill layouts', 'No bill layout yet.'], ['envelope', 'Envelope layouts', 'No envelope layout yet.']]) {
      const mine = data.profiles.filter((p) => p.kind === kind);
      out.push(h('section', { class: 'card' }, h('h2', {}, title),
        mine.length ? h('ul', { class: 'list' }, mine.map((p) => h('li', {}, h('div', { class: 'row2' }, h('span', {}, h('strong', {}, p.name), h('br'), h('span', { class: 'muted' }, `${p.config.page.width} by ${p.config.page.height} ${UNIT_LABEL[p.config.units] || p.config.units}`)),
          h('span', { class: 'actions row' },
            h('a', { class: 'btn small secondary', href: `/api/staff/print/test/${p.id}`, target: '_blank', rel: 'noopener' }, 'Print a test page'),
            canManage ? h('button', { class: 'btn small', type: 'button', onclick: () => editor(p) }, 'Change') : null))))) : h('p', { class: 'muted' }, none),
        canManage ? h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => editor({ kind, name: '', config: STARTER[kind] }) }, kind === 'bill' ? 'Add a bill layout' : 'Add an envelope layout')) : null));
    }
    return out;
  }
  function editor(p) {
    const sources = p.kind === 'bill' ? BILL_SOURCES : ENV_SOURCES;
    const rowsHost = h('div');
    const addRow = (fd = { source: sources[1], x: '', y: '' }) => {
      const i = rowsHost.children.length;
      const row = h('fieldset', { class: 'card pf' }, h('legend', {}, `Item ${i + 1}`),
        select(`s${i}`, 'What prints here', sources.map((s) => [s, SRC_LABEL[s] || s]), fd.source),
        h('div', { class: 'st', hidden: fd.source === 'static' || SHAPES.includes(fd.source) ? null : true }, field({ id: `t${i}`, label: 'Text to print (for a box or line: an optional heading)', value: fd.text || '', maxlength: 300, autocomplete: 'off' })),
        h('div', { class: 'lb', hidden: fd.source === 'static' || SHAPES.includes(fd.source) ? true : null }, field({ id: `l${i}`, label: 'Words printed before it (optional)', hint: 'For example "Due: " or "Account: "', value: fd.label || '', maxlength: 40, autocomplete: 'off' })),
        h('div', { class: 'hg', hidden: fd.source === 'bill.lines' || fd.source === 'box' ? null : true }, field({ id: `g${i}`, label: 'Height, top to bottom', hint: 'For the list of charges, it stops here so it never prints over what is below it', inputmode: 'decimal', value: fd.height ?? '', autocomplete: 'off' })),
        h('label', { class: 'check sh', hidden: SHAPES.includes(fd.source) ? null : true }, h('input', { type: 'checkbox', id: `d${i}`, checked: fd.shade ? true : null }), 'Gray inside the box, or a dashed "cut here" line'),
        field({ id: `x${i}`, label: 'Distance from the left edge', inputmode: 'decimal', value: fd.x, autocomplete: 'off' }),
        field({ id: `y${i}`, label: 'Distance from the top edge', inputmode: 'decimal', value: fd.y, autocomplete: 'off' }),
        field({ id: `w${i}`, label: 'Width (optional)', hint: 'Text wraps at this width', inputmode: 'decimal', value: fd.width ?? '', autocomplete: 'off' }),
        field({ id: `z${i}`, label: 'Text size in points (optional)', hint: '10 to 12 is normal print', inputmode: 'decimal', value: fd.size ?? '', autocomplete: 'off' }),
        select(`a${i}`, 'Line up text', [['left', 'On the left'], ['center', 'In the middle'], ['right', 'On the right']], fd.align || 'left'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: `b${i}`, checked: fd.bold ? true : null }), 'Bold'),
        h('div', { class: 'actions' }, h('button', { class: 'btn secondary small', type: 'button', onclick: () => { row.remove(); renumber(); } }, 'Remove this item')));
      row.querySelector('select').addEventListener('change', (e) => {
        const v = e.target.value, shape = SHAPES.includes(v);
        row.querySelector('.st').hidden = v !== 'static' && !shape;
        row.querySelector('.lb').hidden = v === 'static' || shape;
        row.querySelector('.hg').hidden = v !== 'bill.lines' && v !== 'box';
        row.querySelector('.sh').hidden = !shape;
      });
      row._src = fd; rowsHost.append(row);
    };
    const renumber = () => { [...rowsHost.children].forEach((r, i) => { r.querySelector('legend').textContent = `Item ${i + 1}`; }); };
    p.config.fields.forEach((fd) => addRow(fd));
    const f = h('form', { novalidate: true, class: 'card' }, h('h2', {}, p.id ? `Change ${p.name}` : p.kind === 'bill' ? 'New bill layout' : 'New envelope layout'),
      h('p', { class: 'hint' }, 'Measure your paper or envelope and type its real size. Nothing is assumed. Print a test page to check where things land.'),
      field({ id: 'nm', label: 'Name for this layout', hint: 'For example "Window envelope" or "Bill, half sheet"', value: p.name, required: true, autocomplete: 'off' }),
      select('un', 'Measured in', Object.entries(UNIT_LABEL), p.config.units),
      field({ id: 'pw', label: 'Paper width', inputmode: 'decimal', value: p.config.page.width, required: true, autocomplete: 'off' }),
      field({ id: 'ph', label: 'Paper height', inputmode: 'decimal', value: p.config.page.height, required: true, autocomplete: 'off' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'mk', checked: p.config.marks ? true : null }), 'Print corner marks'),
      h('h3', {}, 'What prints, and where'), rowsHost,
      h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => addRow() }, 'Add an item')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'submit' }, 'Save layout'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => draw() }, 'Cancel'),
        p.id ? h('button', { class: 'btn secondary', type: 'button', id: 'del' }, 'Delete this layout') : null));
    f.querySelector('#del')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Delete this layout?', body: `"${p.name}" will be removed. Bill runs already printed are not affected.`, yes: 'Yes, delete it', no: 'No, keep it' });
      if (!ok) return;
      try { await api('DELETE', `/api/staff/print-profiles/${p.id}`); await reload('Layout deleted.'); } catch (err) { showError(f, err.message); }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (id) => f.querySelector('#' + id).value;
      try {
        const name = v('nm').trim(); if (!name) throw new Error('Please give this layout a name.');
        const w = num(v('pw')), hh = num(v('ph'));
        if (!(w > 0) || !(hh > 0)) throw new Error('Please type the paper width and height as numbers, like 8.5 and 11.');
        const fields = [...rowsHost.children].map((row, i) => {
          // keep settings this form does not show (such as row spacing), then apply what it does show
          const o = { ...(row._src?.row_height ? { row_height: row._src.row_height } : {}), source: v('s' + i), x: num(v('x' + i)), y: num(v('y' + i)), align: v('a' + i) };
          if (o.x === null || o.y === null) throw new Error(`Item ${i + 1}: please type how far it sits from the left and from the top.`);
          if (o.source === 'static') o.text = v('t' + i);
          if (SHAPES.includes(o.source)) {
            if (v('t' + i).trim()) o.text = v('t' + i).trim();
            if (f.querySelector('#d' + i).checked) o.shade = true;
            if (!v('w' + i).trim()) throw new Error(`Item ${i + 1}: a box or line needs a width.`);
          }
          const wd = v('w' + i).trim() ? num(v('w' + i)) : undefined, sz = v('z' + i).trim() ? num(v('z' + i)) : undefined;
          if (wd !== undefined) { if (!(wd > 0)) throw new Error(`Item ${i + 1}: width must be a number.`); o.width = wd; }
          if (sz !== undefined) { if (!(sz >= 4 && sz <= 72)) throw new Error(`Item ${i + 1}: text size must be between 4 and 72.`); o.size = sz; }
          if (f.querySelector('#b' + i).checked) o.bold = true;
          if (o.source !== 'static' && !SHAPES.includes(o.source) && v('l' + i)) o.label = v('l' + i);
          if (o.source === 'box' && !v('g' + i).trim()) throw new Error(`Item ${i + 1}: a box needs a height.`);
          if ((o.source === 'bill.lines' || o.source === 'box') && v('g' + i).trim()) { const g = num(v('g' + i)); if (!(g > 0)) throw new Error(`Item ${i + 1}: the room for the list must be a number.`); o.height = g; }
          return o;
        });
        const config = { units: v('un'), page: { width: w, height: hh }, fields, ...(f.querySelector('#mk').checked ? { marks: true } : {}) };
        await busy(f.querySelector('button[type=submit]'), 'Saving...', () => api('POST', '/api/staff/print-profiles', { kind: p.kind, name, config }));
        await reload(`Saved "${name}". Use "Print a test page" to check it.`);
      } catch (err) { showError(f, err.message); }
    });
    fill(host, f); f.querySelector('input')?.focus();
  }
  function draw() { fill(host, ...list()); }
  draw();
  return h('div', {}, back(), h('h1', {}, 'Printing'), h('p', {}, 'Tell utilities the size of the paper and envelopes you actually have. Each layout is yours to change at any time.'), note, host);
}, 'Printing');

// =============== activity log ===============
const ACTION = {
  'settings.update': 'Changed city settings', 'role.grant': 'Gave a role', 'role.revoke': 'Took away a role', 'user.create': 'Added a staff member',
  'user.deactivate': 'Turned off a staff member', 'rate.create': 'Set a new rate', 'service.toggle': 'Turned a service on or off',
  'run.create': 'Started a bill run', 'run.calculate': 'Calculated a bill run', 'run.approve': 'Approved a bill run',
  'payment.counter': 'Took a payment at the counter', 'payment.start': 'A resident started an online payment',
  'print.profile.save': 'Saved a print layout', 'print.profile.delete': 'Deleted a print layout',
  'reading.submit': 'Meter reading entered', 'reading.accept': 'Accepted a meter reading', 'reading.reject': 'Rejected a meter reading',
  'approval.request': 'Asked for approval of a bill change', 'approval.first': 'First approval given', 'approval.approve': 'Approved a bill change',
  'approval.reject': 'Turned down a bill change', 'charge.create': 'Added a one-time charge', 'dispute.open': 'A resident asked about a bill',
  'dispute.resolve': 'Answered a bill question', 'ledger.reverse': 'Reversed a ledger entry', 'meter.create': 'Added a meter',
  'penalty.run': 'Added late charges', 'account.create': 'Added a customer account', 'account.linkcode.regen': 'Made a new link code',
  'account.service': 'Changed a customer service', 'request.create': 'A resident made a service request', 'request.update': 'Updated a service request', 'auth.login': 'Signed in', 'auth.stepup': 'Passed a safety check', 'city.bootstrap': 'City was set up', 'payments.wallets': 'Turned on Apple Pay for the web address',
};
const humanAction = (a) => ACTION[a] || a.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Plain details only. Internal ids mean nothing to a person, so they are left out. */
const detailText = (d) => {
  if (!d || typeof d !== 'object') return '';
  const out = [];
  for (const [k, v] of Object.entries(d)) {
    if (/(^|_)id$/.test(k) || (typeof v === 'string' && UUID.test(v)) || v === null || v === undefined) continue;
    const label = k.replace(/_cents$/, '').replace(/_/g, ' ');
    if (/_cents$/.test(k) && typeof v === 'number') out.push(`${label}: ${money(v)}`);
    else if (Array.isArray(v)) out.push(`${label}: ${v.map((x) => String(x).replace(/_/g, ' ')).join(', ')}`);
    else if (typeof v === 'object') continue;
    else out.push(`${label}: ${String(v).replace(/_/g, ' ')}`);
  }
  return out.join(', ');
};

export const audit = safe(async () => {
  const [log, users] = await Promise.all([api('GET', '/api/staff/audit?limit=200'), api('GET', '/api/staff/users').catch(() => ({ users: [] }))]);
  const who = new Map(users.users.map((u) => [u.id, u.name || u.email]));
  const result = h('div', { role: 'status' });
  const check = h('button', { class: 'btn', type: 'button' }, 'Check that the record is untouched');
  check.addEventListener('click', async () => {
    try {
      const r = await busy(check, 'Checking...', () => api('GET', '/api/staff/audit/verify'));
      fill(result, r.intact ? h('p', { class: 'notice' }, '✓ The record is complete. Nothing has been changed or removed.') : h('p', { class: 'error', role: 'alert' }, `The record was changed at entry number ${r.first_bad_seq}. Tell your site administrator right away.`));
    } catch (err) { showError(result, err.message); }
  });
  const table = log.entries.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'Details'].map((t) => h('th', {}, t)))),
    h('tbody', {}, log.entries.map((e) => h('tr', {},
      h('td', { 'data-label': 'When' }, new Date(e.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })),
      h('td', { 'data-label': 'Who' }, who.get(e.actor_id) || (e.actor_id ? 'Someone no longer listed' : 'The system')),
      h('td', { 'data-label': 'What' }, humanAction(e.action)),
      h('td', { 'data-label': 'Details' }, detailText(e.detail)))))) : h('p', { class: 'muted' }, 'Nothing has been recorded yet.');
  return h('div', {}, back(), h('h1', {}, 'Activity log'), h('p', {}, 'Every change to money, people, rates and settings is written here. Entries cannot be edited or deleted.'),
    h('div', { class: 'actions' }, check), result, table);
}, 'Activity log');


// =============== colors and logo ===============
export const appearance = safe(async () => {
  const s = await api('GET', '/api/staff/settings');
  const msg = h('div', { role: 'status' });
  const pick = (id, label, hint, value, fallback) => h('div', { class: 'field' }, h('label', { for: id }, label), h('p', { class: 'hint', id: id + '-hint' }, hint),
    h('input', { id, type: 'color', value: value || fallback, 'aria-describedby': id + '-hint' }));
  const form = h('form', { novalidate: true, class: 'card' }, h('h2', {}, 'City colors'),
    h('p', { class: 'hint' }, 'Match your city website. The words on the top bar and on buttons are white, so those two colors must be dark. Colors that are too light are not accepted.'),
    pick('color', 'Top bar and headings', 'The band across the top of every page.', s.theme_color, '#0b4f8a'),
    pick('accent', 'Buttons', 'Buttons such as Pay my bill.', s.accent_color || s.theme_color, '#0b4f8a'),
    pick('rule', 'Stripe under the top bar', 'A thin line of color. Any color works.', s.rule_color, '#d9a33a'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'no-rule', checked: !s.rule_color }), 'No stripe'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save the colors'), h('button', { class: 'btn secondary', type: 'button', id: 'reset-color' }, 'Go back to the standard colors')));
  const save = async (value, btn, done) => { try { await busy(btn, 'Saving...', () => api('PUT', '/api/staff/settings', value)); say(msg, done + ' Reload the page to see it.'); } catch (e) { showError(form, e.message); } };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => form.querySelector('#' + id).value;
    save({ theme_color: v('color'), accent_color: v('accent'), rule_color: form.querySelector('#no-rule').checked ? '' : v('rule') }, form.querySelector('button[type=submit]'), 'Colors saved.');
  });
  form.querySelector('#reset-color').addEventListener('click', (e) => save({ theme_color: '', accent_color: '', rule_color: '' }, e.target, 'Back to the standard colors.'));
  const file = h('input', { id: 'logo', type: 'file', accept: 'image/png,image/jpeg' });
  const logoForm = h('form', { novalidate: true, class: 'card' }, h('h2', {}, 'City logo'),
    h('p', { class: 'hint' }, 'A PNG or JPEG picture under 300 KB. It shows in the top bar of every page.'),
    state.city?.has_logo ? h('p', {}, h('img', { src: '/api/city/logo', alt: 'The current city logo', class: 'logo-preview' })) : h('p', { class: 'muted' }, 'No logo yet.'),
    h('div', { class: 'field' }, h('label', { for: 'logo' }, 'Choose a picture'), file),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save the logo'), h('button', { class: 'btn secondary', type: 'button', id: 'rm-logo' }, 'Remove the logo')));
  logoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = file.files[0];
    if (!f) { showError(logoForm, 'Please choose a picture first.'); return; }
    if (f.size > 300 * 1024) { showError(logoForm, 'That picture is too big. Please use one under 300 KB.'); return; }
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
    try { await busy(logoForm.querySelector('button[type=submit]'), 'Saving...', () => api('PUT', '/api/staff/logo', { data })); say(msg, 'Logo saved. Reload the page to see it.'); } catch (err) { showError(logoForm, err.message); }
  });
  logoForm.querySelector('#rm-logo').addEventListener('click', async (e) => { try { await busy(e.target, 'Removing...', () => api('PUT', '/api/staff/logo', { data: null })); say(msg, 'Logo removed. Reload the page to see the change.'); } catch (err) { showError(logoForm, err.message); } });
  const demoBox = h('input', { type: 'checkbox', id: 'demo-on', checked: !!state.city?.demo });
  const demoForm = h('form', { novalidate: true, class: 'card' }, h('h2', {}, 'Demo mode'),
    h('p', { class: 'hint' }, 'While this is on, every page shows a yellow bar saying this is a demo, a faint DEMO sits behind the pages, search engines are told to stay away, and no real payments can be made. Turn it off when the city is ready to use this for real.'),
    h('label', { class: 'check' }, demoBox, 'This is a demo'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save')));
  demoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await busy(demoForm.querySelector('button[type=submit]'), 'Saving...', () => api('PUT', '/api/staff/settings', { demo_mode: demoBox.checked })); say(msg, 'Saved. Reload the page to see the change.'); } catch (err) { showError(demoForm, err.message); }
  });
  return h('div', {}, back(), h('h1', {}, 'Colors, logo and demo mode'), msg, form, logoForm, demoForm);
}, 'Colors, logo and demo mode');

// =============== updates ===============
export const updates = safe(async () => {
  const [s, u] = await Promise.all([api('GET', '/api/staff/settings'), api('GET', '/api/staff/updates')]);
  const msg = h('div', { role: 'status' });
  const status = !u.enabled ? h('p', { class: 'notice' }, 'Update checking is off.')
    : u.problem ? h('p', { class: 'notice warn' }, `Could not check: ${u.problem}.`)
    : u.newer ? h('div', { class: 'notice warn' }, h('p', {}, `A newer version is ready: ${u.latest}. This city is running ${u.running}.`), u.url ? h('a', { href: u.url, rel: 'noopener noreferrer', target: '_blank' }, 'What is new (opens GitHub)') : null, h('p', {}, 'Whoever hosts this program installs it. If automatic updating is switched on at the host, it will arrive on its own.'))
    : h('p', { class: 'notice' }, `✓ Up to date. This city is running ${u.running}.`);
  const form = h('form', { novalidate: true, class: 'card' }, h('h2', {}, 'Where updates come from'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'uc', checked: s.update_check }), 'Look for new versions'),
    field({ id: 'repo', label: 'GitHub address', hint: 'Only github.com addresses are accepted. This tells the program where to look for new versions.', value: s.update_repo, autocomplete: 'off' }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save'), h('button', { class: 'btn secondary', type: 'button', id: 'rd' }, 'Use the standard address')));
  form.querySelector('#rd').addEventListener('click', () => { form.querySelector('#repo').value = 'https://github.com/therealwokewok/city'; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await busy(form.querySelector('button[type=submit]'), 'Saving...', () => api('PUT', '/api/staff/settings', { update_check: form.querySelector('#uc').checked, update_repo: form.querySelector('#repo').value.trim() })); say(msg, 'Saved.'); } catch (err) { showError(form, err.message); }
  });
  return h('div', {}, back(), h('h1', {}, 'Updates'), status, msg, form);
}, 'Updates');
