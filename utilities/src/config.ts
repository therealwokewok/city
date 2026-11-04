// Where the database lives, and how to reach it. Read at start-up, written by the setup page and the site
// administrator's Database screen. Settings given by the host as environment variables always win (twelve-factor);
// otherwise the connection comes from CONFIG_DIR/database.json, which the app owns and keeps readable by itself only.
//
// Ways to connect, in the order most cities meet them:
//   url     one connection address, as managed services hand out ("postgres://user:pass@host/db?sslmode=require")
//   fields  host, port, database, user and password typed separately
//   socket  a PostgreSQL on the same computer, over its Unix socket
// Plus TLS (required, or verified with a CA certificate), the pool size, and a separate owner connection for
// migrations, because the app itself runs as the limited utilities_app role.
//
// Two rules are never optional: every connection has a password (also over a socket), and a database that is not on
// this same computer is reached over TLS. "Off" is only accepted for localhost.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';
/** Where the CA certificate for verified TLS comes from: pasted in, the system's trusted roots, or Amazon's RDS bundle. */
export type CaSource = 'paste' | 'system' | 'aws-rds';
export const PROVIDERS = ['generic', 'aws-rds', 'google-cloud-sql', 'azure', 'neon', 'supabase', 'digitalocean', 'heroku', 'crunchy', 'docker', 'local'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const AWS_RDS_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
export interface DbConfig {
  mode: 'url' | 'fields' | 'socket';
  provider?: Provider;
  ca_source?: CaSource;
  url?: string;
  host?: string; port?: number; database?: string; user?: string; password?: string;
  socket?: string;
  ssl?: SslMode; ca?: string;
  pool_max?: number; connect_timeout_s?: number;
  /** The database owner, used only to create tables and run migrations. Same shape, or just a url. */
  owner?: { url?: string; user?: string; password?: string };
}
export interface DbSource { source: 'env' | 'file' | 'none'; config?: DbConfig; file: string }

export const configDir = () => process.env.CONFIG_DIR || path.join(process.cwd(), 'config');
export const configFile = () => path.join(configDir(), 'database.json');

/** Reads VAR, or the file named by VAR_FILE (how Docker and Kubernetes hand secrets to a program). */
export function envValue(name: string): string | undefined {
  const file = process.env[name + '_FILE'];
  if (file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return undefined; } }
  return process.env[name];
}

export function loadDbConfig(): DbSource {
  const file = configFile();
  const url = envValue('DATABASE_URL');
  if (url) {
    const owner = envValue('OWNER_DATABASE_URL');
    return { source: 'env', file, config: { mode: 'url', url, ssl: sslFromUrl(url), pool_max: Number(process.env.DB_POOL_MAX) || undefined, ...(owner ? { owner: { url: owner } } : {}) } };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as DbConfig;
    return { source: 'file', file, config: validateDbConfig(cfg) };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { source: 'none', file };
    throw new Error(`${file} could not be read: ${e.message}`);
  }
}

function sslFromUrl(url: string): SslMode | undefined {
  const m = /[?&]sslmode=([a-z-]+)/.exec(url);
  if (!m) return undefined;
  return m[1] === 'disable' ? 'disable' : m[1] === 'verify-full' ? 'verify-full' : m[1] === 'verify-ca' ? 'verify-ca' : 'require';
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLoopback = (host: string | undefined) => !!host && LOOPBACK.has(host.toLowerCase());
export function validateDbConfig(raw: unknown): DbConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, max = 500) => { const v = c[k]; if (v === undefined || v === null || v === '') return undefined; if (typeof v !== 'string' || v.length > max) throw new Error(`${k} is not valid`); return v; };
  const num = (k: string, lo: number, hi: number) => { const v = c[k]; if (v === undefined || v === null || v === '') return undefined; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} must be a whole number from ${lo} to ${hi}`); return n; };
  const mode = c.mode;
  if (mode !== 'url' && mode !== 'fields' && mode !== 'socket') throw new Error('Choose how to connect: an address, separate fields, or a socket');
  const out: DbConfig = { mode };
  let remote = false;
  if (mode === 'url') {
    const url = str('url', 2000);
    if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new Error('The connection address starts with postgres://');
    let u: URL;
    try { u = new URL(url); } catch { throw new Error('That connection address is not well formed'); }
    if (!u.username) throw new Error('The connection address needs a user, like postgres://user:password@host/db');
    if (!u.password) throw new Error('A password is required. Put it in the address: postgres://user:password@host/db');
    remote = !isLoopback(u.hostname.replace(/^\[|\]$/g, ''));
    out.url = url;
  } else if (mode === 'fields') {
    const host = str('host', 253); if (!host || !HOST.test(host)) throw new Error('Type the database host, like db.example.gov');
    out.host = host; out.port = num('port', 1, 65535) ?? 5432;
    out.database = str('database', 63) ?? 'utilities'; out.user = str('user', 63) ?? 'utilities_app'; out.password = str('password', 500);
    if (!out.password) throw new Error('A password is required');
    remote = !isLoopback(host);
  } else {
    const sock = str('socket', 300) ?? '/var/run/postgresql';
    if (!path.isAbsolute(sock)) throw new Error('The socket directory is a full path, like /var/run/postgresql');
    out.socket = sock; out.database = str('database', 63) ?? 'utilities'; out.user = str('user', 63) ?? 'utilities_app'; out.password = str('password', 500);
    if (!out.password) throw new Error('A password is required, even over the local socket');
  }
  const provider = str('provider', 30);
  if (provider) { if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error('Unknown database provider'); out.provider = provider as Provider; }
  const ssl = str('ssl', 20);
  if (ssl !== undefined && !['disable', 'require', 'verify-ca', 'verify-full'].includes(ssl)) throw new Error('TLS is off, required, or verified');
  if (ssl) out.ssl = ssl as SslMode;
  const caSource = str('ca_source', 20);
  if (caSource) { if (!['paste', 'system', 'aws-rds'].includes(caSource)) throw new Error('Unknown certificate source'); out.ca_source = caSource as CaSource; }
  const ca = str('ca', 20000);
  if (ca) { if (!/-----BEGIN CERTIFICATE-----/.test(ca)) throw new Error('The CA certificate is a PEM file starting with -----BEGIN CERTIFICATE-----'); out.ca = ca; out.ca_source ??= 'paste'; }
  if (out.ssl === 'verify-ca' || out.ssl === 'verify-full') {
    out.ca_source ??= out.ca ? 'paste' : 'system';
    if (out.ca_source === 'paste' && !out.ca) throw new Error('Verified TLS with a pasted certificate needs the CA certificate your database provider gives you');
    if (out.ssl === 'verify-ca' && out.ca_source === 'system') throw new Error('"Verified certificate only" needs the provider\'s CA certificate (Google Cloud SQL gives you one in the console)');
  }
  // A database on another computer is reached over TLS, always. The address may say so itself (sslmode=require or
  // verify-full); otherwise the TLS choice must.
  if (remote) {
    const inUrl = out.mode === 'url' ? sslFromUrl(out.url!) : undefined;
    const effective = out.ssl ?? inUrl;
    if (effective !== 'require' && effective !== 'verify-ca' && effective !== 'verify-full') throw new Error('A database on another computer must use TLS. Choose "Required" or "Verified" (or put sslmode=require in the address).');
  }
  out.pool_max = num('pool_max', 1, 100);
  out.connect_timeout_s = num('connect_timeout_s', 1, 120);
  if (c.owner && typeof c.owner === 'object') {
    const o = c.owner as Record<string, unknown>;
    const owner: DbConfig['owner'] = {};
    if (typeof o.url === 'string' && o.url) { if (!/^postgres(ql)?:\/\//.test(o.url)) throw new Error('The owner address starts with postgres://'); owner.url = o.url; }
    if (typeof o.user === 'string' && o.user) owner.user = o.user.slice(0, 63);
    if (typeof o.password === 'string' && o.password) owner.password = o.password.slice(0, 500);
    if (Object.keys(owner).length) out.owner = owner;
  }
  return out;
}

/** pg's connection settings for the app (or the owner, for migrations). */
/** The CA to trust for verified TLS: pasted text, Amazon's cached bundle, or nothing (the system's own roots). */
export function resolveCa(cfg: DbConfig): string | undefined {
  if (cfg.ca_source === 'aws-rds') { try { return fs.readFileSync(awsBundleFile(), 'utf8'); } catch { throw new Error('Amazon\'s RDS certificate bundle has not been downloaded yet. Test the connection first (it fetches the bundle).'); } }
  if (cfg.ca_source === 'system') return undefined;
  return cfg.ca;
}
export const awsBundleFile = () => path.join(configDir(), 'aws-rds-global-bundle.pem');
/** Downloads Amazon's RDS bundle once (it changes rarely); later starts use the copy on disk. */
export async function ensureAwsBundle(fetchImpl: typeof fetch = fetch): Promise<void> {
  const file = awsBundleFile();
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 90 * 86_400_000) return;
  const r = await fetchImpl(AWS_RDS_BUNDLE_URL);
  if (!r.ok) throw new Error(`Could not download Amazon's RDS certificate bundle (${r.status}). Check this server's internet access, or paste the bundle instead.`);
  const text = await r.text();
  if (!/-----BEGIN CERTIFICATE-----/.test(text)) throw new Error('The downloaded RDS bundle did not look like certificates');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

export function poolConfig(cfg: DbConfig, who: 'app' | 'owner' = 'app'): pg.PoolConfig {
  const ssl = cfg.ssl === 'disable' ? false
    : cfg.ssl === 'verify-full' ? { rejectUnauthorized: true, ...(resolveCa(cfg) ? { ca: resolveCa(cfg) } : {}) }
    // Google Cloud SQL's server certificates carry no host name, so only the chain is checked, against the instance's CA.
    : cfg.ssl === 'verify-ca' ? { rejectUnauthorized: true, ca: resolveCa(cfg), checkServerIdentity: () => undefined }
    : cfg.ssl === 'require' ? { rejectUnauthorized: false } : undefined;
  const base: pg.PoolConfig = { max: cfg.pool_max ?? 10, connectionTimeoutMillis: (cfg.connect_timeout_s ?? 10) * 1000, ...(ssl !== undefined ? { ssl } : {}) };
  if (who === 'owner') {
    if (cfg.owner?.url) return { ...base, connectionString: cfg.owner.url };
    if (!cfg.owner?.user) throw new Error('No owner connection is set. Migrations need the database owner.');
    if (cfg.mode === 'url') return { ...base, ...fromUrl(cfg.url!, cfg.owner.user, cfg.owner.password) };
    return { ...poolConfig(cfg, 'app'), user: cfg.owner.user, password: cfg.owner.password };
  }
  if (cfg.mode === 'url') return { ...base, connectionString: cfg.url };
  if (cfg.mode === 'socket') return { ...base, host: cfg.socket, database: cfg.database, user: cfg.user, password: cfg.password };
  return { ...base, host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password };
}
function fromUrl(url: string, user: string, password?: string): pg.PoolConfig {
  const u = new URL(url);
  return { host: decodeURIComponent(u.hostname), port: u.port ? Number(u.port) : 5432, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'utilities', user, password };
}

/** What the screens may show: never a password, never the owner secret. */
export function describeDb(src: DbSource) {
  const c = src.config;
  if (!c) return { source: src.source, file: src.file };
  let host = c.host, port = c.port, database = c.database, user = c.user;
  if (c.mode === 'url' && c.url) { try { const u = new URL(c.url); host = u.hostname; port = u.port ? Number(u.port) : 5432; database = u.pathname.replace(/^\//, ''); user = decodeURIComponent(u.username); } catch { /* shown as is */ } }
  return { source: src.source, file: src.file, mode: c.mode, host, port, database, user, socket: c.socket, ssl: c.ssl ?? (c.mode === 'url' ? 'as written in the address' : 'disable'),
    has_ca: !!c.ca, ca_source: c.ca_source, provider: c.provider, pool_max: c.pool_max ?? 10, connect_timeout_s: c.connect_timeout_s ?? 10, has_owner: !!(c.owner?.url || c.owner?.user), owner_user: c.owner?.user ?? (c.owner?.url ? safeUser(c.owner.url) : undefined) };
}
const safeUser = (url: string) => { try { return decodeURIComponent(new URL(url).username); } catch { return undefined; } };

export interface DbTest {
  ok: boolean; problem?: string; version?: string; user?: string; ssl?: boolean; superuser?: boolean;
  /** The server answered but the named database is not there yet; the setup page will create it. */
  missing_db?: string;
  tables: 'none' | 'some' | 'current'; pending?: number; cities?: number; owner_ok?: boolean; owner_problem?: string;
}
/** Connects once with the app settings (and once as the owner, if given) and reports what it found. Changes nothing. */
export async function testDb(cfg: DbConfig, migrationsDir: string, fetchImpl: typeof fetch = fetch): Promise<DbTest> {
  const out: DbTest = { ok: false, tables: 'none' };
  if (cfg.ca_source === 'aws-rds') { try { await ensureAwsBundle(fetchImpl); } catch (e: any) { out.problem = e.message; return out; } }
  const client = new pg.Client({ ...poolConfig(cfg), connectionTimeoutMillis: (cfg.connect_timeout_s ?? 10) * 1000 });
  try {
    await client.connect();
    const v = await client.query('select version() as v, current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su, (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl');
    out.version = String(v.rows[0].v).split(' on ')[0]; out.user = v.rows[0].u; out.superuser = !!v.rows[0].su; out.ssl = !!v.rows[0].ssl;
    const major = Number(/PostgreSQL (\d+)/.exec(out.version)?.[1] ?? 0);
    if (major && major < 16) { out.problem = `${out.version} is too old; this program needs PostgreSQL 16 or newer`; return out; }
    const has = (await client.query(`select to_regclass('public.schema_migrations') as m, to_regclass('public.cities') as c`)).rows[0];
    if (has.m) {
      try {
        const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
        const all = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
        out.pending = all.filter((f) => !done.has(f)).length;
        out.tables = out.pending === 0 ? 'current' : 'some';
      } catch { out.tables = 'current'; } // an older app role may not read the migration list; the tables are there
      // Row security hides every city from the app role, so only an owner connection can count them.
      if (has.c && out.user !== 'utilities_app') { try { out.cities = Number((await client.query('select count(*)::int as n from cities')).rows[0].n); } catch { /* not allowed to count */ } }
    }
    out.ok = true;
  } catch (e: any) {
    out.problem = plainPgError(e);
    if (e?.code === '3D000') {
      // The server is there and the account works; only the database itself is missing. Say so, as good news.
      const name = dbName(cfg);
      const admin = new pg.Client({ ...poolConfig({ ...cfg, ...(cfg.mode === 'url' ? { url: cfg.url!.replace(/\/[^/?]*(\?|$)/, '/postgres$1') } : { database: 'postgres' }) }), connectionTimeoutMillis: (cfg.connect_timeout_s ?? 10) * 1000 });
      try {
        await admin.connect();
        const v = await admin.query('select version() as v, current_user as u, (select rolsuper or rolcreatedb from pg_roles where rolname = current_user) as can');
        if (v.rows[0].can && name) { out.ok = true; out.problem = undefined; out.missing_db = name; out.version = String(v.rows[0].v).split(' on ')[0]; out.user = v.rows[0].u; }
      } catch { /* keep the plain message */ } finally { await admin.end().catch(() => {}); }
    }
  } finally { await client.end().catch(() => {}); }
  if (cfg.owner?.url || cfg.owner?.user) {
    const o = new pg.Client({ ...poolConfig(cfg, 'owner'), connectionTimeoutMillis: (cfg.connect_timeout_s ?? 10) * 1000 });
    try { await o.connect(); await o.query('select 1'); out.owner_ok = true; } catch (e: any) { out.owner_ok = false; out.owner_problem = plainPgError(e); } finally { await o.end().catch(() => {}); }
  }
  return out;
}

function dbName(cfg: DbConfig): string | undefined {
  if (cfg.mode !== 'url') return cfg.database;
  try { return decodeURIComponent(new URL(cfg.url!).pathname.replace(/^\//, '')) || undefined; } catch { return undefined; }
}

export function plainPgError(e: any): string {
  const m = String(e?.message ?? e);
  if (e?.code === 'ECONNREFUSED') return 'Nothing is answering at that host and port. Is PostgreSQL running, and is the port open to this server?';
  if (e?.code === 'ENOTFOUND') return 'That host name could not be found. Check the spelling.';
  if (e?.code === 'ETIMEDOUT' || /timeout/i.test(m)) return 'The database did not answer in time. A firewall may be blocking this server.';
  if (e?.code === '28P01') return 'The password was not accepted.';
  if (e?.code === '28000') return 'That user may not connect from this server (check pg_hba.conf).';
  if (e?.code === '3D000') return 'That database does not exist yet. Create it first, or check the name.';
  if (/self.signed|certificate/i.test(m)) return 'The server\'s certificate could not be verified. Choose "required" TLS, or paste the provider\'s CA certificate.';
  if (/SSL/i.test(m) && /not supported|off/i.test(m)) return 'That server does not offer TLS. Turn TLS off, or enable it on the server.';
  return m.slice(0, 300);
}

/** Writes the connection file, readable by this program only. */
export function saveDbConfig(cfg: DbConfig) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}
