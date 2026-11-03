import type pg from 'pg';

export interface CitySettings {
  penalty_bps: number;            // late charge, 1000 = 10%
  due_days: number;               // days from bill date to due date
  shutoff_notice_days: number;    // days after due date before a shutoff may be listed
  approval_limit_cents: number;   // adjustments above this need a second approver
  tax_bps: number;
  high_usage_factor: number;      // flag a read above this multiple of last usage
  stepup_minutes: number;
  remit_to: string;
  return_address: string;
  office_hours: string;
  phone: string;
  theme_color: string;            // '#RRGGBB' for the top bar and links; dark enough for white text; empty means the default blue
  accent_color: string;           // '#RRGGBB' for buttons; dark enough for white text; empty means the same as theme_color
  rule_color: string;             // '#RRGGBB' for the stripe under the top bar; empty means none
  update_check: boolean;          // look for new versions on GitHub
  update_repo: string;            // where new versions come from
  demo_mode: boolean;             // banner, watermark, hidden from search engines, no real money moves
  // Online payment fees passed on to the customer (see fees.ts). Off by default.
  card_fee: 'off' | 'credit' | 'all'; // 'credit': credit cards only (a surcharge); 'all': any card (service fee program)
  card_fee_bps: number;           // processor's percentage, 290 = 2.9%
  card_fee_fixed_cents: number;   // processor's fixed part, 30 = 30 cents
  card_fee_max_bps: number;       // never more than this share of the bill, 300 = 3%; 0 = no cap
  ach_fee: boolean;
  ach_fee_bps: number;            // 80 = 0.8%
  ach_fee_max_cents: number;      // 500 = $5.00; 0 = no cap
}

export const DEFAULT_UPDATE_REPO = 'https://github.com/therealwokewok/city';

/** WCAG contrast ratio of a #RRGGBB color against white. */
export function contrastOnWhite(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return 1.05 / (lum + 0.05);
}
export const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const DEFAULT_SETTINGS: CitySettings = {
  penalty_bps: 1000, due_days: 15, shutoff_notice_days: 5, approval_limit_cents: 50000, tax_bps: 0,
  high_usage_factor: 3, stepup_minutes: 10, remit_to: '', return_address: '', office_hours: '', phone: '',
  theme_color: '', accent_color: '', rule_color: '', update_check: true, update_repo: DEFAULT_UPDATE_REPO,
  card_fee: 'off', card_fee_bps: 290, card_fee_fixed_cents: 30, card_fee_max_bps: 300,
  ach_fee: false, ach_fee_bps: 80, ach_fee_max_cents: 500,
  demo_mode: false, // new cities made by the bootstrap script start in demo mode; see bootstrap.ts
};

export async function loadSettings(c: pg.PoolClient): Promise<CitySettings> {
  const r = await c.query('select settings from cities where id = app_city()');
  return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.settings ?? {}) };
}

const NUMERIC_KEYS = ['penalty_bps', 'due_days', 'shutoff_notice_days', 'approval_limit_cents', 'tax_bps',
  'high_usage_factor', 'stepup_minutes', 'card_fee_bps', 'card_fee_fixed_cents', 'card_fee_max_bps', 'ach_fee_bps', 'ach_fee_max_cents'];
const TEXT_KEYS = ['remit_to', 'return_address', 'office_hours', 'phone'];

export function validateSettings(input: Record<string, unknown>): Partial<CitySettings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (NUMERIC_KEYS.includes(k)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000_000) throw new Error(`bad value for ${k}`);
      out[k] = v;
    } else if (TEXT_KEYS.includes(k)) {
      if (typeof v !== 'string' || v.length > 500) throw new Error(`bad value for ${k}`);
      out[k] = v;
    } else if (k === 'theme_color') {
      if (typeof v !== 'string' || (v !== '' && !/^#[0-9a-fA-F]{6}$/.test(v))) throw new Error('Pick a color like #0b4f8a');
      if (v !== '' && contrastOnWhite(v) < 4.5) throw new Error('That color is too light for white button text. Pick a darker one');
      out[k] = v.toLowerCase();
    } else if (k === 'accent_color') {
      if (typeof v !== 'string' || (v !== '' && !/^#[0-9a-fA-F]{6}$/.test(v))) throw new Error('Pick a color like #8f2f1f');
      if (v !== '' && contrastOnWhite(v) < 4.5) throw new Error('That button color is too light for white text. Pick a darker one');
      out[k] = v.toLowerCase();
    } else if (k === 'rule_color') {
      if (typeof v !== 'string' || (v !== '' && !/^#[0-9a-fA-F]{6}$/.test(v))) throw new Error('Pick a color like #d9a33a');
      out[k] = v.toLowerCase();
    } else if (k === 'update_check') {
      if (typeof v !== 'boolean') throw new Error('bad value for update_check');
      out[k] = v;
    } else if (k === 'card_fee') {
      if (v !== 'off' && v !== 'credit' && v !== 'all') throw new Error('bad value for card_fee');
      out[k] = v;
    } else if (k === 'ach_fee') {
      if (typeof v !== 'boolean') throw new Error('bad value for ach_fee');
      out[k] = v;
    } else if (k === 'demo_mode') {
      if (typeof v !== 'boolean') throw new Error('bad value for demo_mode');
      out[k] = v;
    } else if (k === 'update_repo') {
      if (typeof v !== 'string' || !GITHUB_REPO.test(v.trim())) throw new Error('The update source must be a GitHub address like https://github.com/owner/name');
      out[k] = v.trim();
    } else throw new Error(`unknown setting ${k}`);
  }
  for (const k of ['card_fee_bps', 'ach_fee_bps', 'card_fee_max_bps']) if (typeof out[k] === 'number' && (out[k] as number) > 2000) throw new Error('A fee percentage cannot be more than 20%');
  return out as Partial<CitySettings>;
}

/** While a city is in demo mode, real money must not move. The fake processor and Stripe test keys are fine. */
export async function assertMoneyAllowed(c: pg.PoolClient, processor: { name: string; live?: boolean }) {
  if (processor.name !== 'fake' && processor.live !== false && (await loadSettings(c)).demo_mode) {
    const e: any = new Error('Payments are turned off while this is a demo. No one has been charged.'); e.status = 409; throw e;
  }
}

/** WCAG contrast ratio between two #RRGGBB colors. */
export function contrastBetween(a: string, b: string): number {
  const lum = (hex: string) => { const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The city's colors as CSS variables. Dark mode keeps its own readable colors except the top bar. */
export function themeCss(s: Pick<CitySettings, 'theme_color' | 'accent_color' | 'rule_color'>): string {
  const ok = (c: string) => /^#[0-9a-f]{6}$/.test(c);
  const darker = (h: string) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.78).toString(16).padStart(2, '0')).join('');
  const always: string[] = []; const light: string[] = [];
  if (ok(s.theme_color)) {
    always.push(`--header: ${s.theme_color}`, '--header-text: #ffffff');
    light.push(`--primary: ${s.theme_color}`, `--primary-hover: ${darker(s.theme_color)}`, '--primary-text: #ffffff', `--heading: ${s.theme_color}`);
  }
  const accent = ok(s.accent_color) ? s.accent_color : '';
  if (accent) light.push(`--accent: ${accent}`, `--accent-hover: ${darker(accent)}`);
  if (ok(s.rule_color)) {
    always.push(`--rule: ${s.rule_color}`);
    const header = ok(s.theme_color) ? s.theme_color : '#0b4f8a';
    const onHeader = contrastBetween(s.rule_color, header) >= 3 ? s.rule_color : '#ffffff';
    always.push(`--brand-sub: ${contrastBetween(s.rule_color, header) >= 4.5 ? s.rule_color : '#ffffff'}`, `--rule-on-header: ${onHeader}`);
  }
  let css = '';
  if (always.length) css += `:root { ${always.join('; ')}; }\n`;
  if (light.length) css += `@media not (prefers-color-scheme: dark) { :root { ${light.join('; ')}; } }\n`;
  return css;
}
