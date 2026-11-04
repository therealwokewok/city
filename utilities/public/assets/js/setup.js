// First-run setup: the database connection, then the city. Plain words, one step at a time.
import { $, h, field, showError, busy, fill } from './dom.js';

const main = $('#main');
const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Check where the program was started for details.');
  return data;
};
const select = (id, label, options, value, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), hint ? h('p', { class: 'hint', id: id + '-hint' }, hint) : null,
  h('select', { id, 'aria-describedby': hint ? id + '-hint' : null }, options.map(([v, t]) => h('option', { value: v, selected: v === value ? true : null }, t))));
const tokenField = () => field({ id: 'token', label: 'Setup code', hint: 'The 8 numbers printed where the program was started. Only the person at the server has it.', inputmode: 'numeric', autocomplete: 'off', class: 'code', required: true });

/** Builds the database part of the form and a function that reads it back as settings. Shared with the site administrator's Database page. */
/** Where the database runs. Each preset picks the right way to connect and verify, and says what to type. */
export const PROVIDERS = [
  ['generic', 'Any PostgreSQL 16 or newer', 'Use the connection your administrator or host gave you. A database on another computer must use TLS.', { ssl: 'require', ca_source: 'system' }],
  ['aws-rds', 'Amazon Web Services: RDS or Aurora PostgreSQL', 'Use the endpoint from the RDS console (port 5432) and the master user, or an RDS Proxy. Amazon\'s certificate bundle is downloaded for you, so the connection is verified.', { ssl: 'verify-full', ca_source: 'aws-rds' }],
  ['google-cloud-sql', 'Google Cloud SQL for PostgreSQL', 'Either run the Cloud SQL Auth Proxy on this server and connect to 127.0.0.1 (it handles sign-in and encryption), or connect to the public address with "Verified certificate only" and paste the server CA from the instance\'s Connections page.', { ssl: 'verify-ca', ca_source: 'paste' }],
  ['azure', 'Microsoft Azure Database for PostgreSQL', 'Flexible server, with the user name as shown in the portal. Azure\'s certificates chain to a public authority, so the connection is verified without pasting anything.', { ssl: 'verify-full', ca_source: 'system' }],
  ['neon', 'Neon', 'Paste the connection string from the Neon dashboard. Its certificates chain to a public authority, so it is verified.', { ssl: 'verify-full', ca_source: 'system' }],
  ['supabase', 'Supabase', 'Use the direct connection (port 5432), not the transaction pooler. For a verified connection, download the CA certificate under Database settings and paste it.', { ssl: 'require', ca_source: 'system' }],
  ['digitalocean', 'DigitalOcean Managed Databases', 'Use the public connection details and download the CA certificate from the cluster\'s overview page to paste here.', { ssl: 'verify-full', ca_source: 'paste' }],
  ['heroku', 'Heroku Postgres', 'Paste the DATABASE_URL from the add-on. Heroku\'s certificates are self-signed, so "Required" is the most it allows.', { ssl: 'require', ca_source: 'system' }],
  ['crunchy', 'Crunchy Bridge', 'Paste the connection string and the CA certificate from the cluster page.', { ssl: 'verify-full', ca_source: 'paste' }],
  ['local', 'PostgreSQL on this same computer', 'Connect to 127.0.0.1 or the local socket. Encryption is optional on this computer; a password is still required.', { ssl: '', ca_source: 'system' }],
];

export function dbFields(initial = {}) {
  const provider = select('provider', 'Where is the database?', PROVIDERS.map(([k, n]) => [k, n]), initial.provider || 'generic');
  const tip = h('p', { class: 'notice', id: 'provider-tip' });
  const mode = h('div', { role: 'radiogroup', 'aria-label': 'How to connect' });
  const radio = (v, label, hint) => h('label', { class: 'radio-card', for: 'm-' + v }, h('input', { type: 'radio', name: 'mode', id: 'm-' + v, value: v, checked: (initial.mode || 'url') === v ? true : null }), h('span', {}, h('strong', {}, label), h('span', { class: 'hint' }, ' ' + hint)));
  mode.append(radio('url', 'One connection address', 'What most database services give you, starting with postgres://'),
    radio('fields', 'Host, port, name, user and password', 'Typed separately'),
    radio('socket', 'PostgreSQL on this same computer', 'Over its local socket. A password is still required.'));
  const urlBox = h('div', {}, field({ id: 'url', label: 'Connection address', hint: 'For example postgres://owner:password@db.example.com:5432/utilities?sslmode=require', value: initial.url || '', autocomplete: 'off', spellcheck: 'false' }));
  const fieldsBox = h('div', {},
    field({ id: 'host', label: 'Host', hint: 'The database computer, like db.example.gov or 10.0.0.5', value: initial.host || '', autocomplete: 'off' }),
    field({ id: 'port', label: 'Port', value: initial.port || 5432, inputmode: 'numeric', class: 'short' }),
    field({ id: 'database', label: 'Database name', value: initial.database || 'utilities', autocomplete: 'off' }),
    field({ id: 'user', label: 'User', value: initial.user || '', autocomplete: 'off' }),
    field({ id: 'password', label: 'Password', type: 'password', autocomplete: 'new-password' }));
  const sockBox = h('div', {},
    field({ id: 'socket', label: 'Socket directory', hint: 'Usually /var/run/postgresql', value: initial.socket || '/var/run/postgresql', autocomplete: 'off' }),
    field({ id: 'sdatabase', label: 'Database name', value: initial.database || 'utilities', autocomplete: 'off' }),
    field({ id: 'suser', label: 'User', value: initial.user || '', autocomplete: 'off' }),
    field({ id: 'spassword', label: 'Password', type: 'password', autocomplete: 'new-password' }));
  const tls = select('ssl', 'Encryption (TLS) to the database', [['', 'As written in the address (sslmode=...), or off for this computer only'], ['require', 'Required (encrypted, server not verified)'], ['verify-full', 'Required and verified (recommended)'], ['verify-ca', 'Verified certificate only (Google Cloud SQL)']], initial.ssl || '',
    'A database on another computer must be encrypted; "off" is only accepted for this computer.');
  const caSrc = select('ca_source', 'How to verify the server', [['system', 'With the authorities this computer already trusts'], ['aws-rds', 'With Amazon\'s RDS certificate bundle (downloaded for you)'], ['paste', 'With a CA certificate I paste below']], initial.ca_source || 'system');
  const ca = field({ id: 'ca', label: 'CA certificate', hint: 'Paste the PEM text, starting with -----BEGIN CERTIFICATE-----', tag: 'textarea', value: initial.ca || '' });
  const pool = field({ id: 'pool_max', label: 'Connections to keep open', hint: '10 is right for a small city', value: initial.pool_max || 10, inputmode: 'numeric', class: 'short' });
  const sync = () => {
    const m = mode.querySelector('input:checked').value; const t = tls.querySelector('select').value;
    urlBox.hidden = m !== 'url'; fieldsBox.hidden = m !== 'fields'; sockBox.hidden = m !== 'socket';
    const verified = t === 'verify-full' || t === 'verify-ca';
    caSrc.hidden = !verified; ca.hidden = !verified || caSrc.querySelector('select').value !== 'paste';
    const p = PROVIDERS.find((x) => x[0] === provider.querySelector('select').value); tip.textContent = p ? p[2] : '';
  };
  provider.addEventListener('change', () => {
    const p = PROVIDERS.find((x) => x[0] === provider.querySelector('select').value);
    if (p) { tls.querySelector('select').value = p[3].ssl; caSrc.querySelector('select').value = p[3].ca_source; if (p[0] === 'local') mode.querySelector('#m-fields').checked = true; }
    sync();
  });
  mode.addEventListener('change', sync); tls.addEventListener('change', sync); caSrc.addEventListener('change', sync); sync();
  const root = h('div', {}, provider, tip, mode, urlBox, fieldsBox, sockBox, tls, caSrc, ca, pool);
  const read = () => {
    const v = (id) => root.querySelector('#' + id)?.value ?? '';
    const m = mode.querySelector('input:checked').value;
    const t = v('ssl');
    const verified = t === 'verify-full' || t === 'verify-ca';
    const out = { mode: m, provider: v('provider'), ssl: t || undefined, ca_source: verified ? v('ca_source') : undefined, ca: verified && v('ca_source') === 'paste' ? v('ca').trim() : undefined, pool_max: Number(v('pool_max')) || 10 };
    if (m === 'url') out.url = v('url').trim();
    else if (m === 'fields') Object.assign(out, { host: v('host').trim(), port: Number(v('port')) || 5432, database: v('database').trim(), user: v('user').trim(), password: v('password') });
    else Object.assign(out, { socket: v('socket').trim(), database: v('sdatabase').trim(), user: v('suser').trim(), password: v('spassword') });
    return out;
  };
  return { root, read };
}

/** Plain words for what a test found. */
export function testReport(r) {
  if (!r.ok) return h('p', { class: 'error', role: 'alert' }, r.problem || 'Could not connect.');
  const bits = [`Connected to ${r.version} as ${r.user}.`, r.ssl ? 'The connection is encrypted.' : 'The connection is not encrypted.'];
  if (r.missing_db) return h('p', { class: 'notice' }, `✓ ${bits[0]} The database "${r.missing_db}" does not exist yet; it will be created for you.`);
  if (r.superuser) bits.push('That user is a superuser; the program will create a limited role for its own use.');
  bits.push(r.tables === 'none' ? 'The database is empty; the tables will be created.' : r.tables === 'some' ? `The tables exist and ${r.pending} update${r.pending === 1 ? '' : 's'} will be applied.` : 'The tables are up to date.');
  if (r.cities) bits.push(`${r.cities} city is already set up there.`);
  if (r.owner_ok === false) return h('div', {}, h('p', { class: 'notice' }, bits.join(' ')), h('p', { class: 'error', role: 'alert' }, `The owner connection failed: ${r.owner_problem}`));
  return h('p', { class: 'notice' }, '✓ ' + bits.join(' '));
}

async function stepDatabase(state) {
  const db = dbFields();
  const report = h('div', { 'aria-live': 'polite' });
  const createRole = h('input', { type: 'checkbox', id: 'cr', checked: true });
  const form = h('form', { novalidate: true, class: 'card' },
    h('h2', {}, stepTitle(state, 'database', 'the database')),
    h('p', {}, 'Type the connection for the database owner (the account your database service or administrator gave you). It is used to create the tables, and later to update them. The program itself then connects as a limited user it creates, so a bug in the website can never reach past one customer\'s records.'),
    db.root,
    h('label', { class: 'check multi', for: 'cr' }, createRole, h('span', {}, 'Create the limited app user for me (recommended)', h('br'), h('span', { class: 'muted small' }, 'Untick only if your administrator already made a utilities_app role and you typed its password above. The owner is then needed only for updates.'))),
    tokenField(),
    h('div', { class: 'actions row' }, h('button', { class: 'btn secondary', type: 'button', id: 'test' }, 'Test the connection'), h('button', { class: 'btn', type: 'submit' }, 'Create the tables and continue')),
    report);
  form.querySelector('#test').addEventListener('click', async (e) => {
    try { fill(report, testReport(await busy(e.target, 'Testing...', () => post('/api/setup/test', { token: form.querySelector('#token').value, db: db.read() })))); }
    catch (err) { fill(report, h('p', { class: 'error', role: 'alert' }, err.message)); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await busy(form.querySelector('button[type=submit]'), 'Working...', () => post('/api/setup/database', { token: form.querySelector('#token').value, db: db.read(), create_app_role: createRole.checked }));
      go(r.next, { ...state, token: form.querySelector('#token').value });
    } catch (err) { showError(form, err.message); }
  });
  fill(main, h('h1', {}, 'Set up utilities'), h('p', {}, 'A few short steps. Nothing here is hard to undo: the database and email can be changed later under Administration, and everything about the city under City settings.'), form);
}

const ZONES = [['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona (no daylight saving)'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'], ['America/Indiana/Indianapolis', 'Eastern (Indiana)'], ['America/Detroit', 'Eastern (Michigan)'], ['America/Puerto_Rico', 'Atlantic (Puerto Rico)']];

function stepCity(state) {
  const form = h('form', { novalidate: true, class: 'card' },
    h('h2', {}, stepTitle(state, 'city', 'the city')),
    h('p', {}, 'Everything here can be changed later. The first administrator signs in with a code emailed to them; there are no passwords.'),
    field({ id: 'name', label: 'City name', hint: 'As it should appear at the top of every page and on bills. For example "City of Example" or "Village of Example".', required: true, maxlength: 80 }),
    field({ id: 'state', label: 'State', hint: 'Two letters. Missouri starting values are included; other states use plain defaults.', maxlength: 2, class: 'short', autocapitalize: 'characters', required: true }),
    select('timezone', 'Time zone', ZONES.map(([z, n]) => [z, `${n} (${z})`]), 'America/Chicago'),
    field({ id: 'hosts', label: 'Web address', hint: `The address people will type, like utilities.example.gov. You reached this page at ${state.host}. More than one? One per line.`, tag: 'textarea', value: state.host && state.host !== 'localhost' ? state.host : '', required: true }),
    field({ id: 'office_name', label: 'What residents call the office', hint: 'Used in messages such as "Call City Hall". City Hall, Village Hall, Town Hall, Utility Office...', value: 'City Hall', maxlength: 60 }),
    field({ id: 'phone', label: 'Office phone number', inputmode: 'tel', autocomplete: 'off' }),
    field({ id: 'office_hours', label: 'Office hours', hint: 'Shown at the bottom of every page, like "Monday to Friday, 8:00 to 4:30"', maxlength: 120 }),
    field({ id: 'return_address', label: 'Mailing address of the city', hint: 'Printed on bills and envelopes', tag: 'textarea', maxlength: 500 }),
    field({ id: 'remit_to', label: 'Where to mail payments', hint: 'Printed on the payment stub. Often the same address.', tag: 'textarea', maxlength: 500 }),
    h('h3', {}, 'The first administrator'),
    field({ id: 'admin_name', label: 'Full name', required: true, autocomplete: 'off' }),
    field({ id: 'admin_email', label: 'Email address', hint: 'They get the City administrator role and sign in with a code sent here.', type: 'email', required: true, autocomplete: 'off' }),
    field({ id: 'site_admin_email', label: 'Email of the person who runs the server (optional)', hint: 'They get the Site administrator role: the database and server settings, but never customer records.', type: 'email', autocomplete: 'off' }),
    h('label', { class: 'check multi', for: 'demo' }, h('input', { type: 'checkbox', id: 'demo', checked: true }), h('span', {}, 'Start in demo mode (recommended)', h('br'), h('span', { class: 'muted small' }, 'A yellow bar says this is a demo, search engines stay away, and no real money can move. Turn it off under Administration when the city is ready.'))),
    tokenField(),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, isLast(state, 'city') ? 'Create the city and finish' : 'Create the city and continue')));
  if (state.token) form.querySelector('#token').value = state.token;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => form.querySelector('#' + id).value;
    try {
      const r = await busy(form.querySelector('button[type=submit]'), 'Creating...', () => post('/api/setup/city', {
        token: v('token'), name: v('name'), state: v('state'), timezone: v('timezone'), hosts: v('hosts'), office_name: v('office_name'), phone: v('phone'), office_hours: v('office_hours'),
        return_address: v('return_address'), remit_to: v('remit_to'), admin_name: v('admin_name'), admin_email: v('admin_email'), site_admin_email: v('site_admin_email'), demo_mode: form.querySelector('#demo').checked }));
      go(r.next, { ...state, host: r.host, pack: r.pack });
    } catch (err) { showError(form, err.message); }
  });
  fill(main, h('h1', {}, 'Set up utilities'), form);
  window.scrollTo(0, 0);
}

function finished(host, pack) {
  fill(main, h('h1', {}, 'All set'),
    h('p', { class: 'notice' }, '✓ The program is starting. Give it a few seconds.'),
    h('p', {}, 'Then sign in with the administrator\'s email address at ', h('a', { href: `https://${host}/` }, `https://${host}/`), '. A code is emailed; if email is not set up yet, the code is printed where the program runs.'),
    pack ? h('div', { class: 'card' }, h('h2', {}, pack.name), h('p', {}, 'These starting values are not legal advice. Please check with the city attorney:'), h('ul', {}, pack.review.map((x) => h('li', {}, x)))) : null,
    h('p', {}, 'Next steps: set the rates under Administration, then add accounts or import them.'));
}

// ---------- email and online payments, shared with the administration screens ----------
export const EMAIL_SERVICES = [
  ['resend', 'Resend', 'Free for 3,000 messages a month, which covers a small city. Sign up, add the city\'s domain, create an API key. This page fetches the DNS records for you.'],
  ['postmark', 'Postmark', 'Very reliable delivery; from about $15 a month. The API key is the Server API token.'],
  ['sendgrid', 'SendGrid (Twilio)', 'Free for 100 messages a day. Create an API key with Mail Send permission.'],
  ['mailgun', 'Mailgun', 'Needs the sending domain (for example mg.example.gov) and the private API key.'],
  ['ses', 'Amazon SES', 'Cheapest at volume. Needs an IAM access key with ses:SendEmail and the region. New accounts start in the sandbox; request production access.'],
  ['relay', 'A relay of your own', 'Any HTTPS address that accepts a JSON POST of {from, to, subject, text} with a bearer token, such as the Cloudflare Worker in deploy/mail-relay.'],
];
export function emailFields(initial = {}) {
  const provider = select('provider', 'Email service', EMAIL_SERVICES.map(([k, n]) => [k, n]), initial.provider || 'resend');
  const tip = h('p', { class: 'notice' });
  const from = field({ id: 'from', label: 'Send mail as', hint: 'For example "City of Example Utilities <utilities@example.gov>". The domain must be one the city owns and verifies with the service.', value: initial.from || '', autocomplete: 'off' });
  const key = field({ id: 'api_key', label: 'API key', hint: initial.has_key ? 'Leave empty to keep the saved key' : 'From the service\'s dashboard. Kept on the server, never shown again.', type: 'password', autocomplete: 'new-password' });
  const url = field({ id: 'url', label: 'Relay address', hint: 'Starts with https://', value: initial.url || '', autocomplete: 'off' });
  const domain = field({ id: 'domain', label: 'Sending domain', hint: 'As set up in Mailgun, for example mg.example.gov', value: initial.domain || '', autocomplete: 'off' });
  const mgRegion = select('mgregion', 'Mailgun region', [['us', 'US'], ['eu', 'EU']], initial.region === 'eu' ? 'eu' : 'us');
  const access = field({ id: 'access_key', label: 'AWS access key id', value: initial.access_key || '', autocomplete: 'off' });
  const secret = field({ id: 'secret_key', label: 'AWS secret access key', hint: initial.has_key ? 'Leave empty to keep the saved key' : 'Kept on the server, never shown again.', type: 'password', autocomplete: 'new-password' });
  const region = field({ id: 'region', label: 'AWS region', hint: 'Where the SES identity was created, like us-east-1', value: initial.region && initial.region !== 'eu' && initial.region !== 'us' ? initial.region : 'us-east-1', autocomplete: 'off', class: 'short' });
  const sync = () => {
    const p = provider.querySelector('select').value; const info = EMAIL_SERVICES.find((x) => x[0] === p);
    tip.textContent = info ? info[2] : '';
    key.hidden = p === 'ses'; url.hidden = p !== 'relay'; domain.hidden = p !== 'mailgun'; mgRegion.hidden = p !== 'mailgun';
    access.hidden = p !== 'ses'; secret.hidden = p !== 'ses'; region.hidden = p !== 'ses';
  };
  provider.addEventListener('change', sync); sync();
  const root = h('div', {}, provider, tip, from, key, url, domain, mgRegion, access, secret, region);
  const read = () => {
    const v = (id) => root.querySelector('#' + id)?.value ?? '';
    const p = v('provider');
    const out = { provider: p, from: v('from').trim() };
    if (p === 'ses') Object.assign(out, { access_key: v('access_key').trim(), secret_key: v('secret_key'), region: v('region').trim() });
    else out.api_key = v('api_key');
    if (p === 'relay') out.url = v('url').trim();
    if (p === 'mailgun') { out.domain = v('domain').trim(); out.region = v('mgregion'); }
    return out;
  };
  return { root, read };
}
/** Shows DNS records as a table the city can hand to whoever manages its domain. */
export function dnsTable(d) {
  const rows = d.records.map((r) => h('tr', {}, h('td', { 'data-label': 'Type' }, r.type), h('td', { 'data-label': 'Name' }, h('code', {}, r.name)), h('td', { 'data-label': 'Value' }, h('code', {}, r.value)), h('td', { 'data-label': 'Status' }, r.status || ''), h('td', { 'data-label': 'For' }, r.purpose)));
  return h('div', {},
    h('p', { class: d.verified ? 'notice' : 'notice warn' }, (d.verified === true ? '✓ ' : '') + `${d.domain}: ${d.advice}`),
    rows.length ? h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Type', 'Name', 'Value', 'Status', 'For'].map((t) => h('th', {}, t)))), h('tbody', {}, rows)) : null);
}

function stepEmail(state) {
  const ef = emailFields();
  const report = h('div', { 'aria-live': 'polite' });
  const testTo = field({ id: 'testto', label: 'Send a test message to', hint: 'Your own address. The message says where it came from.', type: 'email', autocomplete: 'off' });
  const optional = (state.optional || []).includes('email');
  const form = h('form', { novalidate: true, class: 'card' },
    h('h2', {}, stepTitle(state, 'email', 'email')),
    h('p', {}, 'Every sign-in code, paperless bill and payment-plan decision goes out by email, so this matters. Pick a service, paste its key, say what address mail comes from, and send yourself a test.'),
    ef.root,
    h('div', { class: 'actions row' }, h('button', { class: 'btn secondary', type: 'button', id: 'dns' }, 'Show the DNS records the domain needs')),
    h('div', { id: 'dnsout' }),
    testTo,
    tokenField(),
    h('div', { class: 'actions row' }, h('button', { class: 'btn secondary', type: 'button', id: 'test' }, 'Send the test message'), h('button', { class: 'btn', type: 'submit' }, isLast(state, 'email') ? 'Save and finish' : 'Save and continue'),
      optional ? h('button', { class: 'btn secondary', type: 'button', id: 'skip' }, 'Skip for now') : null),
    report);
  const token = () => form.querySelector('#token').value;
  form.querySelector('#dns').addEventListener('click', async (e) => {
    try { fill(form.querySelector('#dnsout'), dnsTable(await busy(e.target, 'Asking...', () => post('/api/setup/email/domain', { token: token(), email: ef.read() })))); }
    catch (err) { fill(form.querySelector('#dnsout'), h('p', { class: 'error', role: 'alert' }, err.message)); }
  });
  form.querySelector('#test').addEventListener('click', async (e) => {
    try { await busy(e.target, 'Sending...', () => post('/api/setup/email/test', { token: token(), email: ef.read(), to: form.querySelector('#testto').value.trim() })); fill(report, h('p', { class: 'notice' }, '✓ Sent. Check that inbox (and its spam folder) before you continue.')); }
    catch (err) { fill(report, h('p', { class: 'error', role: 'alert' }, err.message)); }
  });
  form.querySelector('#skip')?.addEventListener('click', async (e) => {
    try { const r = await busy(e.target, 'One moment...', () => post('/api/setup/skip', { token: token() })); go(r.next, { ...state, token: token() }); } catch (err) { showError(form, err.message); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await busy(form.querySelector('button[type=submit]'), 'Saving...', () => post('/api/setup/email', { token: token(), email: ef.read() })); go(r.next, { ...state, token: token() }); }
    catch (err) { showError(form, err.message); }
  });
  if (state.token) form.querySelector('#token').value = state.token;
  fill(main, h('h1', {}, 'Set up utilities'), form); window.scrollTo(0, 0);
}

export function stripeFields(initial = {}) {
  const pk = field({ id: 'pk', label: 'Publishable key', hint: 'Starts with pk_test_ or pk_live_. Found under Developers, API keys in the city\'s own Stripe account.', value: initial.publishable_key || '', autocomplete: 'off', spellcheck: 'false' });
  const sk = field({ id: 'sk', label: 'Secret key', hint: 'Starts with sk_test_ or sk_live_ (or rk_ for a restricted key). Kept on the server, never shown again.', type: 'password', autocomplete: 'new-password' });
  const root = h('div', {}, pk, sk);
  return { root, read: () => ({ publishable_key: root.querySelector('#pk').value.trim(), secret_key: root.querySelector('#sk').value.trim() }) };
}
export function stripeCheckReport(r) {
  if (!r.ok) return h('p', { class: 'error', role: 'alert' }, r.problem);
  return h('p', { class: 'notice' }, `✓ This is the ${r.live ? 'LIVE' : 'test'} key for "${r.business}"${r.country ? ' (' + r.country + ')' : ''}. ${r.charges_enabled ? 'The account can take payments.' : 'The account cannot take payments yet; finish Stripe\'s own activation first.'}`);
}

function stepPayments(state) {
  const sf = stripeFields();
  const report = h('div', { 'aria-live': 'polite' });
  const form = h('form', { novalidate: true, class: 'card' },
    h('h2', {}, stepTitle(state, 'payments', 'online payments')),
    h('p', {}, 'Online card and bank payments go through Stripe, in the city\'s own Stripe account (the city keeps the keys and the money; this program adds no fee). Paste the two keys and the connection is checked and finished for you, including the webhook Stripe uses to report payments. This can also be done later under Administration.'),
    h('p', { class: 'hint' }, 'Use the test keys first. Switch to live keys when the city is ready to take real money, and turn demo mode off.'),
    sf.root,
    tokenField(),
    h('div', { class: 'actions row' }, h('button', { class: 'btn secondary', type: 'button', id: 'chk' }, 'Check the keys'), h('button', { class: 'btn', type: 'submit' }, isLast(state, 'payments') ? 'Connect Stripe and finish' : 'Connect Stripe and continue'), h('button', { class: 'btn secondary', type: 'button', id: 'skip' }, 'Skip for now')),
    report);
  const token = () => form.querySelector('#token').value;
  form.querySelector('#chk').addEventListener('click', async (e) => {
    try { fill(report, stripeCheckReport(await busy(e.target, 'Checking...', () => post('/api/setup/payments/check', { token: token(), secret_key: sf.read().secret_key })))); }
    catch (err) { fill(report, h('p', { class: 'error', role: 'alert' }, err.message)); }
  });
  form.querySelector('#skip').addEventListener('click', async (e) => {
    try { const r = await busy(e.target, 'One moment...', () => post('/api/setup/skip', { token: token() })); go(r.next, { ...state, token: token() }); } catch (err) { showError(form, err.message); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await busy(form.querySelector('button[type=submit]'), 'Connecting...', () => post('/api/setup/payments', { token: token(), ...sf.read() })); go(r.next, { ...state, token: token() }); }
    catch (err) { showError(form, err.message); }
  });
  if (state.token) form.querySelector('#token').value = state.token;
  fill(main, h('h1', {}, 'Set up utilities'), form); window.scrollTo(0, 0);
}

const ORDER = ['database', 'city', 'email', 'payments'];
const NAMES = { database: 'the database', city: 'the city', email: 'email', payments: 'online payments' };
/** True when this is the last step, so the button can say "finish". */
function isLast(state, step) { const steps = state.allSteps || ORDER; return steps.indexOf(step) === steps.length - 1; }
function stepTitle(state, step, name) {
  const steps = state.allSteps || ORDER; const i = steps.indexOf(step);
  return `Step ${i + 1} of ${steps.length}: ${name || NAMES[step]}`;
}
function go(next, state) {
  if (next === 'done' || !next) return finished(state.host, state.pack);
  ({ database: stepDatabase, city: stepCity, email: stepEmail, payments: stepPayments })[next](state);
}

(async () => {
  try {
    const state = await (await fetch('/api/setup/state')).json();
    state.allSteps = state.steps;
    go(state.step, state);
  } catch { fill(main, h('h1', {}, 'Setup'), h('p', { class: 'error' }, 'The setup page could not load. Check where the program was started.')); }
})();
