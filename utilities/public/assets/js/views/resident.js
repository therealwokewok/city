import { h, field, money, plainDate, plainNote, showError, busy, confirmDialog, announce, fill } from '../dom.js';
import { api, state } from '../api.js';
import { mountPaymentElement } from '../stripe.js';

const period = (b) => (b.period_start ? new Date(+b.period_end.slice(0, 4), +b.period_end.slice(5, 7) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : plainDate(b.posted_at));
const owedText = (c) => (c > 0 ? 'You owe' : c < 0 ? 'Your credit' : 'Your balance');

export async function home() {
  const { accounts } = await api('GET', '/api/resident/accounts');
  if (!accounts.length) {
    return h('div', {},
      h('h1', {}, 'Welcome'),
      h('p', {}, "Let's connect your utility account so you can see and pay your bill. It takes about a minute. You will need a recent paper bill."),
      h('a', { class: 'btn', href: '#/link' }, 'Connect my account'),
      h('p', {}, 'New in town or moving? ', h('a', { href: '#/requests/new/start' }, 'Ask for new service')));
  }
  return h('div', {},
    h('h1', {}, 'Your utility bills'),
    accounts.map((a) => {
      const owes = a.balance_cents > 0;
      return h('section', { class: 'card', 'aria-label': `Account at ${a.service_address}` },
        h('h2', {}, a.service_address),
        h('p', { class: 'muted' }, `Account ${a.account_number}`),
        h('p', { class: 'muted' }, owedText(a.balance_cents)),
        h('p', { class: 'owe' }, money(Math.abs(a.balance_cents))),
        owes ? null : h('p', {}, h('span', { class: 'status ok' }, '✓ ', a.balance_cents < 0 ? 'You have a credit' : "You're all paid up")),
        h('div', { class: 'actions' },
          owes ? h('a', { class: 'btn', href: `#/pay/${a.id}` }, `Pay ${money(a.balance_cents)} now`) : null,
          h('a', { class: owes ? 'btn secondary' : 'btn', href: `#/account/${a.id}` }, 'See my bills and history')));
    }),
    h('p', {}, h('a', { href: '#/requests' }, 'Start, stop or move my service'), ' or ', h('a', { href: '#/link' }, 'add another account')));
}

export function link() {
  const form = h('form', { novalidate: true },
    h('p', {}, 'Find these two things on your paper bill or in the letter the city sent you.'),
    field({ id: 'num', label: 'Account number', hint: 'Numbers and letters near the top of your bill', autocomplete: 'off', inputmode: 'text', autocapitalize: 'characters', required: true }),
    field({ id: 'code', label: 'Link code', hint: 'Looks like ABCDE-12345. Capital letters or small ones both work.', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: true }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Connect my account')),
    h('p', { class: 'muted' }, "Don't have a code? Call City Hall and we will help you. This keeps your account private."));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = form.querySelector('#num').value.trim(), code = form.querySelector('#code').value.trim();
    if (!num || !code) { showError(form, 'Please fill in both boxes.'); return; }
    try {
      await busy(form.querySelector('button'), 'Connecting...', () => api('POST', '/api/resident/link', { account_number: num, code }));
      location.hash = '#/';
    } catch (err) { showError(form, err.message); }
  });
  return h('div', {}, h('h1', {}, 'Connect your account'), form);
}

export async function account(id) {
  const d = await api('GET', `/api/resident/accounts/${id}`);
  const ap = await api('GET', `/api/resident/accounts/${id}/autopay`).catch(() => ({ on: false }));
  const autoMsg = h('div', { role: 'status' });
  const autoBtn = h('button', { class: ap.on ? 'btn secondary' : 'btn', type: 'button' }, ap.on ? 'Turn autopay off' : 'Set up autopay');
  autoBtn.addEventListener('click', async () => {
    try {
      if (ap.on) {
        const ok = await confirmDialog({ title: 'Turn autopay off?', body: 'We will stop taking your payment automatically. You will need to pay each bill yourself.', yes: 'Yes, turn it off', no: 'No, keep it on' });
        if (!ok) return;
        await busy(autoBtn, 'Turning off...', () => api('POST', `/api/resident/accounts/${id}/autopay/stop`, {}));
        location.reload();
      } else {
        const r = await busy(autoBtn, 'One moment...', () => api('POST', `/api/resident/accounts/${id}/autopay/start`, {}));
        if (r.url) { location.href = r.url; return; } // the demo's pretend processor
        const fields = h('div', { class: 'pe-host' }); const msg = h('div', { role: 'alert' });
        const save = h('button', { class: 'btn', type: 'submit' }, 'Save and turn on autopay');
        const f = h('form', { novalidate: true }, h('p', {}, 'Type the card or bank account to use. Stripe keeps it, not the city.'), fields, msg, h('div', { class: 'actions' }, save));
        autoBtn.hidden = true; fill(autoMsg, f); save.disabled = true;
        const { stripe, elements } = await mountPaymentElement(fields, { publishableKey: r.publishable_key, clientSecret: r.client_secret });
        save.disabled = false;
        f.addEventListener('submit', async (ev) => {
          ev.preventDefault(); fill(msg);
          const res = await busy(save, 'Saving...', () => stripe.confirmSetup({ elements, redirect: 'if_required', confirmParams: { return_url: r.return_url } }));
          if (res.error) { showError(msg, res.error.message || 'That was not saved. Please try again.'); return; }
          try { await api('POST', `/api/resident/accounts/${id}/autopay/confirm`, { setup_ref: r.setup_ref }); location.reload(); } catch (err) { showError(msg, err.message); }
        });
      }
    } catch (err) { showError(autoMsg, err.message); }
  });
  const autoSection = h('section', { class: 'card', 'aria-labelledby': 'autopay-h' }, h('h2', { id: 'autopay-h' }, 'Autopay'),
    ap.on ? h('p', {}, `On. We take your payment on the due date from: ${ap.label}.`) : h('p', {}, 'Let us take your payment on the due date so you never pay late.'),
    h('p', { class: 'hint' }, 'You type your card or bank details into Stripe\'s secure boxes on this page. Stripe is the city\'s payment company; City Hall never sees or keeps your details. You can turn this off at any time.'),
    autoMsg, h('div', { class: 'actions' }, autoBtn));
  const a = d.account;
  const toggle = h('input', { type: 'checkbox', id: 'paperless', checked: a.paperless ? true : null });
  toggle.addEventListener('change', async () => {
    try { await api('PATCH', `/api/resident/accounts/${id}`, { paperless: toggle.checked }); announce(toggle.checked ? 'Paper bills turned off' : 'Paper bills turned on'); }
    catch (err) { toggle.checked = !toggle.checked; showError(toggle.closest('section'), err.message); }
  });
  return h('div', {},
    h('a', { href: '#/' }, '← Back'),
    h('h1', {}, a.service_address),
    h('p', { class: 'muted' }, `Account ${a.account_number}`),
    h('section', { class: 'card' },
      h('p', { class: 'muted' }, owedText(d.balance_cents)),
      h('p', { class: 'owe' }, money(Math.abs(d.balance_cents))),
      d.balance_cents > 0 ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: `#/pay/${id}` }, `Pay ${money(d.balance_cents)} now`)) : h('span', { class: 'status ok' }, '✓ Nothing due')),
    h('h2', {}, 'Your bills'),
    d.bills.length ? h('ul', { class: 'list' }, d.bills.map((b) => h('li', {},
      h('div', { class: 'row2' }, h('strong', {}, period(b)), h('span', { class: 'amount' }, money(b.total_cents))),
      h('p', { class: 'muted' }, `Due ${plainDate(b.due_date)}`),
      h('a', { href: `#/bill/${id}/${b.id}` }, 'Open this bill')))) : h('p', { class: 'muted' }, 'No bills yet.'),
    h('h2', {}, 'Recent activity'),
    d.ledger.length ? h('ul', { class: 'list' }, d.ledger.map((l) => h('li', {},
      h('div', { class: 'row2' }, h('span', {}, kindName(l.kind)), h('span', { class: 'amount' + (l.amount_cents < 0 ? ' credit' : '') }, money(l.amount_cents))),
      h('p', { class: 'muted' }, `${plainDate(l.created_at)}${l.memo ? ' - ' + plainNote(l.memo) : ''}`)))) : h('p', { class: 'muted' }, 'Nothing yet.'),
    h('section', { class: 'card' },
      h('h2', {}, 'Paper bills'),
      h('label', { class: 'check', for: 'paperless' }, toggle, 'Stop mailing me a paper bill'),
      h('p', { class: 'hint' }, "You'll still see every bill here, and we will email you when a new one is ready. You can turn paper back on anytime.")),
    autoSection);
}

const kindName = (k) => ({ bill: 'New bill', payment: 'Payment', adjustment: 'Adjustment by City Hall', penalty: 'Late charge', reversal: 'Correction', charge: 'Charge', refund: 'Refund' }[k] || k);

export async function bill(accountId, billId) {
  const d = await api('GET', `/api/resident/accounts/${accountId}`);
  const b = d.bills.find((x) => x.id === billId);
  if (!b) return h('div', {}, h('h1', {}, 'Bill not found'), h('a', { href: `#/account/${accountId}` }, 'Back to my account'));
  const disputeForm = h('form', { novalidate: true, hidden: true },
    field({ id: 'why', label: 'What looks wrong?', hint: 'For example: "My water use seems too high." A clerk will look at it and get back to you.', tag: 'textarea', maxlength: 2000, required: true }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Send to City Hall')));
  disputeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = disputeForm.querySelector('#why').value.trim();
    if (!reason) { showError(disputeForm, 'Please tell us what looks wrong.'); return; }
    try {
      await busy(disputeForm.querySelector('button'), 'Sending...', () => api('POST', `/api/resident/bills/${billId}/dispute`, { reason }));
      fill(disputeForm, h('p', { class: 'notice' }, "Thank you. City Hall got your message and will contact you. You don't need to pay the part in question until it is checked, but please call us if the due date is close."));
    } catch (err) { showError(disputeForm, err.message); }
  });
  const askBtn = h('button', { class: 'btn secondary', type: 'button', 'aria-expanded': 'false', onclick: (e) => { disputeForm.hidden = false; e.target.setAttribute('aria-expanded', 'true'); disputeForm.querySelector('textarea').focus(); } }, 'Something looks wrong');
  return h('div', {},
    h('a', { href: `#/account/${accountId}` }, '← Back'),
    h('h1', {}, `Bill for ${period(b)}`),
    h('p', {}, `Due ${plainDate(b.due_date)}`),
    h('table', { class: 'bill' },
      h('caption', {}, 'What you were charged for'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Charge'), h('th', { scope: 'col', class: 'amt' }, 'Amount'))),
      h('tbody', {}, b.lines.map((l) => h('tr', {}, h('td', {}, l.description, l.quantity > 1 ? h('span', { class: 'muted' }, ` (${l.quantity} at ${money(l.amount_cents / l.quantity)} each)`) : null, l.meter ? h('span', { class: 'muted' }, ` (meter ${l.meter})`) : null, l.units != null ? h('div', { class: 'muted' }, `${l.units}${l.unit ? ' ' + l.unit : ''} used`) : null), h('td', { class: 'amt' }, money(l.amount_cents))))),
      h('tfoot', {}, h('tr', {}, h('th', { scope: 'row' }, 'Total'), h('td', { class: 'amt' }, money(b.total_cents))))),
    h('div', { class: 'actions' }, d.balance_cents > 0 ? h('a', { class: 'btn', href: `#/pay/${accountId}` }, `Pay my whole balance: ${money(d.balance_cents)}`) : null, askBtn),
    disputeForm);
}

export async function pay(id) {
  const d = await api('GET', `/api/resident/accounts/${id}`);
  const owed = Math.max(d.balance_cents, 0);
  const full = h('input', { type: 'radio', name: 'amt', id: 'amt-full', value: 'full', checked: true });
  const other = h('input', { type: 'radio', name: 'amt', id: 'amt-other', value: 'other' });
  const custom = h('input', { type: 'text', inputmode: 'decimal', id: 'custom', autocomplete: 'off', disabled: true, 'aria-describedby': 'custom-hint' });
  const sync = () => { custom.disabled = !other.checked; if (other.checked) custom.focus(); };
  full.addEventListener('change', sync); other.addEventListener('change', sync);
  const form = h('form', { novalidate: true },
    h('p', { class: 'muted' }, d.account.service_address),
    owed ? h('label', { class: 'radio-card', for: 'amt-full' }, full, h('span', {}, 'Pay everything I owe: ', h('strong', {}, money(owed)))) : null,
    h('label', { class: 'radio-card', for: 'amt-other' }, owed ? other : (other.checked = true, other), h('span', {}, 'Pay a different amount')),
    h('div', { class: 'field' }, h('label', { for: 'custom' }, 'Amount in dollars'), h('p', { class: 'hint', id: 'custom-hint' }, 'For example 25.00. The smallest payment is $1.00.'), custom),
    h('p', { class: 'hint' }, 'Next, you type your card or bank account right here. Those details go straight to Stripe, the city\'s payment company. The city never sees or stores them.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Continue'), h('a', { class: 'btn secondary', href: '#/' }, 'Cancel')));
  const host = h('div');
  if (!owed) { other.checked = true; sync(); }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let cents = owed;
    if (other.checked || !owed) {
      const v = custom.value.replace(/[$,\s]/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(v)) { showError(form, 'Please type an amount like 25.00.'); custom.focus(); return; }
      cents = Math.round(parseFloat(v) * 100);
    }
    if (cents < 100 || cents > 1000000) { showError(form, 'You can pay between $1.00 and $10,000.00 at a time.'); custom.focus(); return; }
    try {
      const r = await busy(form.querySelector('button[type=submit]'), 'One moment...', () => api('POST', `/api/resident/accounts/${id}/pay`, { amount_cents: cents }));
      if (r.url) { location.assign(r.url); return; } // the demo's pretend processor has no card form
      await cardStep(host, form, r, cents);
    } catch (err) { showError(form, err.message); }
  });
  return h('div', {}, h('a', { href: '#/' }, '← Back'), h('h1', {}, 'Pay your bill'), form, host);
}

// Step 2: Stripe's card and bank fields, right here on the page.
async function cardStep(host, form, r, cents) {
  const fields = h('div', { class: 'pe-host', id: 'payment-element' });
  const msg = h('div', { role: 'alert' });
  const payBtn = h('button', { class: 'btn', type: 'submit' }, `Pay ${money(cents)}`);
  const back = h('button', { class: 'btn secondary', type: 'button' }, 'Change the amount');
  const card = h('form', { class: 'card', novalidate: true }, h('h2', {}, `Paying ${money(cents)}`),
    h('p', { class: 'hint' }, 'Type your card, or choose "US bank account" to pay from checking or savings. These boxes are run by Stripe, the city\'s payment company, so your details go straight to them. The city never sees or keeps them.'),
    fields, msg, h('div', { class: 'actions' }, payBtn, back));
  // Stripe draws its fields only into a box that is already on the page, so show the card first.
  form.hidden = true;
  const loadingNote = h('p', { class: 'loading' }, 'Loading the secure payment form...');
  fields.before(loadingNote); payBtn.disabled = true;
  fill(host, card);
  card.querySelector('h2').setAttribute('tabindex', '-1'); card.querySelector('h2').focus();
  const { stripe, elements } = await mountPaymentElement(fields, { publishableKey: r.publishable_key, clientSecret: r.client_secret }).catch((e) => { form.hidden = false; fill(host); throw e; });
  loadingNote.remove(); payBtn.disabled = false;
  back.addEventListener('click', () => { fill(host); form.hidden = false; });
  card.addEventListener('submit', async (e) => {
    e.preventDefault(); fill(msg);
    const res = await busy(payBtn, 'Paying...', () => stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: r.return_url } }));
    if (res.error) { showError(msg, res.error.message || 'That did not go through. Nothing was charged.'); return; }
    const done = await api('POST', `/api/resident/payments/${r.payment_id}/check`, {}).catch(() => ({ status: 'processing' }));
    fill(host.parentNode, await payResult(done.status === 'failed' ? 'failed' : 'done', r.payment_id, done.status));
  });
}

export async function payResult(result, p, status) {
  // Coming back from a bank or card check on another page: ask the processor how it went.
  if (result === 'done' && p && !status) { status = (await api('POST', `/api/resident/payments/${p}/check`, {}).catch(() => ({}))).status; }
  if (result === 'failed' || status === 'failed') {
    return h('div', {}, h('h1', {}, 'Payment not made'), h('p', { class: 'error' }, 'The card or bank turned the payment down. No money was taken.'), h('a', { class: 'btn', href: '#/' }, 'Back to my bills'));
  }
  if (status === 'processing') {
    return h('div', {}, h('h1', {}, 'Thank you'),
      h('p', { class: 'notice' }, '✓ Your bank payment has started. Bank payments take a few business days to finish, and your account will show it then.'),
      h('a', { class: 'btn', href: '#/' }, 'Back to my bills'));
  }
  if (result === 'cancelled') {
    return h('div', {}, h('h1', {}, 'Payment not made'), h('p', {}, 'No money was taken. You can try again whenever you are ready.'), h('a', { class: 'btn', href: '#/' }, 'Back to my bills'));
  }
  return h('div', {},
    h('h1', {}, 'Thank you'),
    h('p', { class: 'notice' }, status === 'completed' ? '✓ Your payment went through and is on your account.' : '✓ Your payment went through. It can take a minute to show on your account.'),
    h('p', {}, 'You will get a receipt by email from Stripe, the city\'s payment company.'),
    h('a', { class: 'btn', href: '#/' }, 'Back to my bills'));
}

void state;

// =============== service requests ===============
export const REQUEST_KINDS = {
  start: ['Start new service', 'I am new in town, or moving to an address in town.'],
  stop: ['Stop service (disconnect)', 'Turn service off but keep my account.'],
  move_out: ['Move out', 'I am leaving. Send me a final bill.'],
  transfer: ['Move to a new address', 'Stop service here and start it at my new home in town.'],
  leak: ['Report a leak', 'Water is leaking at a meter, line or street.'],
};
const STATUS_TEXT = { open: ['Received', 'warn'], scheduled: ['Scheduled', 'warn'], done: ['Done', 'ok'], declined: ['Could not be done', 'bad'] };
const ICON = { open: '', scheduled: '', done: '✓ ', declined: '! ' };

export async function requests() {
  const { requests: list } = await api('GET', '/api/resident/requests');
  return h('div', {},
    h('a', { href: '#/' }, '← Back'),
    h('h1', {}, 'Service requests'),
    h('p', {}, 'Need to start, stop or move your service? Pick one below. City Hall will take it from there.'),
    h('div', { class: 'card' }, h('h2', {}, 'Make a new request'),
      h('ul', { class: 'list' }, Object.entries(REQUEST_KINDS).map(([k, [t, d]]) =>
        h('li', {}, h('a', { class: 'row2', href: `#/requests/new/${k}` }, h('span', {}, h('strong', {}, t), h('br'), h('span', { class: 'muted' }, d))))))),
    h('h2', {}, 'Your requests'),
    list.length ? h('ul', { class: 'list' }, list.map((r) => {
      const [label, tone] = STATUS_TEXT[r.status];
      return h('li', { class: 'card' },
        h('h3', {}, REQUEST_KINDS[r.kind][0]),
        h('p', {}, h('span', { class: `status ${tone}` }, ICON[r.status], label)),
        h('p', { class: 'muted' }, [r.account_number ? `Account ${r.account_number}` : null, r.service_address, r.requested_date ? `For ${plainDate(String(r.requested_date).slice(0, 10))}` : null].filter(Boolean).join(', ')),
        r.resolution ? h('p', {}, h('strong', {}, 'From City Hall: '), r.resolution) : null);
    })) : h('p', { class: 'muted' }, 'You have not made any requests yet.'));
}

export async function requestNew(kind) {
  const meta = REQUEST_KINDS[kind];
  if (!meta) return h('div', {}, h('h1', {}, 'Request not found'), h('a', { class: 'btn', href: '#/requests' }, 'Back to requests'));
  const { accounts } = await api('GET', '/api/resident/accounts');
  const needsAccount = kind !== 'start';
  if (needsAccount && !accounts.length) {
    return h('div', {}, h('a', { href: '#/requests' }, '← Back'), h('h1', {}, meta[0]), h('p', {}, 'First connect your account, so we know which one you mean.'), h('a', { class: 'btn', href: '#/link' }, 'Connect my account'));
  }
  const phone = state.city?.phone;
  const acct = needsAccount ? h('div', { class: 'field' }, h('label', { for: 'account' }, kind === 'transfer' ? 'Which account are you moving from?' : 'Which account is this about?'),
    h('select', { id: 'account', name: 'account' }, accounts.map((a) => h('option', { value: a.id }, `${a.service_address} (account ${a.account_number})`)))) : null;
  const date = (label, hint) => field({ id: 'date', label, hint, type: 'date', required: true });
  const parts = {
    start: [field({ id: 'name', label: 'Your name', autocomplete: 'name', required: true }), field({ id: 'addr', label: 'Address where you want service', hint: 'Street number and name', autocomplete: 'off', required: true }), date('Day you want service to start'), field({ id: 'phone', label: 'Phone number (so we can reach you)', type: 'tel', inputmode: 'tel', autocomplete: 'tel' })],
    stop: [acct, date('Last day you need service'), field({ id: 'note', label: 'Anything we should know? (optional)', tag: 'textarea', maxlength: 2000 })],
    move_out: [acct, date('Day you are moving out'), field({ id: 'fwd', label: 'Where should we mail your final bill?', hint: 'Full mailing address', autocomplete: 'street-address', required: true }), field({ id: 'phone', label: 'Phone number (optional)', type: 'tel', inputmode: 'tel', autocomplete: 'tel' })],
    transfer: [acct, field({ id: 'addr', label: 'Your new address in town', autocomplete: 'off', required: true }), date('Day you are moving'), field({ id: 'phone', label: 'Phone number (optional)', type: 'tel', inputmode: 'tel', autocomplete: 'tel' })],
    leak: [phone ? h('p', { class: 'notice warn' }, `If water is flooding a home or street, call City Hall now at ${phone}.`) : null, acct, field({ id: 'note', label: 'Where is the leak?', hint: 'For example: at the meter in the front yard', tag: 'textarea', maxlength: 2000, required: true }), field({ id: 'phone', label: 'Phone number (optional)', type: 'tel', inputmode: 'tel', autocomplete: 'tel' })],
  }[kind];
  const form = h('form', { novalidate: true }, h('p', {}, meta[1]), parts, h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Send my request'), h('a', { class: 'btn secondary', href: '#/requests' }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => form.querySelector('#' + id)?.value.trim() || undefined;
    const body = { kind, account_id: needsAccount ? v('account') : undefined, requested_date: v('date'), service_address: v('addr'), forwarding_address: v('fwd'), contact_name: v('name'), phone: v('phone'), note: v('note') };
    try {
      await busy(form.querySelector('button[type=submit]'), 'Sending...', () => api('POST', '/api/resident/requests', body));
      announce('Request sent.');
      location.hash = '#/requests/sent';
    } catch (err) { showError(form, err.message); }
  });
  return h('div', {}, h('a', { href: '#/requests' }, '← Back'), h('h1', {}, meta[0]), form);
}

export function requestSent() {
  return h('div', {}, h('h1', {}, 'Request sent'),
    h('p', { class: 'notice' }, 'Thank you. City Hall has your request.'),
    h('p', {}, 'We will update the status on this site. You do not need to do anything else.'),
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/requests' }, 'See my requests'), h('a', { class: 'btn secondary', href: '#/' }, 'Back to my bills')));
}
