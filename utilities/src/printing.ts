import PDFDocument from 'pdfkit';
import { fmt } from './money.js';

/**
 * Print profiles describe any paper or envelope the city owns. Nothing here assumes a size:
 * the profile states the page width and height and where each field goes. Units are inches, millimetres or points.
 */
export type Units = 'in' | 'mm' | 'pt';
export interface Field {
  source: string; x: number; y: number; width?: number; size?: number; align?: 'left' | 'center' | 'right';
  bold?: boolean; text?: string; label?: string; row_height?: number;
  height?: number; // for bill.lines: how much room the list may use, so it never prints over what is below it
}
export interface PrintProfile {
  units: Units;
  page: { width: number; height: number };
  marks?: boolean;      // corner marks, off by default; some printers and mailers want them
  fields: Field[];
}

export const BILL_SOURCES = ['static', 'city.name', 'city.return_address', 'city.remit_to', 'city.office_hours', 'account.name',
  'account.number', 'account.service_address', 'account.mailing_address', 'bill.period', 'bill.due', 'bill.total', 'bill.lines'];
export const ENVELOPE_SOURCES = ['static', 'city.name', 'return_address', 'recipient'];

const PT: Record<Units, number> = { in: 72, mm: 72 / 25.4, pt: 1 };

/** "2026-11-18" as "November 18, 2026": easier to read on paper. */
export function longDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso.slice(0, 10) + 'T12:00:00Z') : iso;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
export const longPeriod = (start: string | Date, end: string | Date) => `${longDate(start)} to ${longDate(end)}`;

/**
 * The address to mail to. Without a separate mailing address, the service address gets the town line
 * ("Osceola, MO 64776") taken from the last line of the city's return address, so the Post Office can deliver it.
 */
export function mailingLines(mailing: string | null, service: string, returnAddress: string): string[] {
  if (mailing && mailing.trim()) return mailing.split('\n').map((x) => x.trim()).filter(Boolean);
  const lines = service.split('\n').map((x) => x.trim()).filter(Boolean);
  const town = returnAddress.split('\n').map((x) => x.trim()).filter(Boolean).pop() ?? '';
  const looksLikeTown = /,\s*[A-Za-z]{2}\s+\d{5}(-\d{4})?$/.test(town);
  return looksLikeTown && !/\d{5}(-\d{4})?$/.test(lines[lines.length - 1] ?? '') ? [...lines, town] : lines;
}

/** How many charge lines to print in `rows` rows; when they do not all fit, the last row says how many more. */
export function linesThatFit(count: number, rows: number): { show: number; more: number } {
  if (rows <= 0) return { show: 0, more: count };
  if (count <= rows) return { show: count, more: 0 };
  return { show: rows - 1, more: count - (rows - 1) };
}
export const moreText = (n: number) => `...and ${n} more charge${n === 1 ? '' : 's'}, included in the total`;

export function validateProfile(kind: 'bill' | 'envelope', cfg: any): PrintProfile {
  const bad = (m: string): never => { throw new Error('invalid print profile: ' + m); };
  if (!cfg || typeof cfg !== 'object') bad('missing');
  if (!['in', 'mm', 'pt'].includes(cfg.units)) bad('units must be in, mm or pt');
  const w = cfg.page?.width, h = cfg.page?.height;
  if (!(typeof w === 'number' && w > 0) || !(typeof h === 'number' && h > 0)) bad('page width and height are required');
  const wPt = w * PT[cfg.units as Units], hPt = h * PT[cfg.units as Units];
  if (wPt < 72 || hPt < 72 || wPt > 72 * 40 || hPt > 72 * 40) bad('page size looks wrong; check the units');
  if (!Array.isArray(cfg.fields) || cfg.fields.length > 60) bad('fields must be a list of up to 60');
  if (cfg.fields.length === 0) bad('add at least one item to print, or the pages come out blank');
  const allowed = kind === 'bill' ? BILL_SOURCES : ENVELOPE_SOURCES;
  for (const f of cfg.fields as Field[]) {
    if (!allowed.includes(f.source)) bad(`unknown field source ${String(f.source).slice(0, 40)}`);
    if (typeof f.x !== 'number' || typeof f.y !== 'number') bad('each field needs x and y');
    if (f.x < 0 || f.y < 0 || f.x > w || f.y > h) bad(`field ${f.source} is outside the page`);
    if (f.size !== undefined && !(f.size >= 4 && f.size <= 72)) bad('font size must be 4 to 72 points');
    if (f.width !== undefined && !(f.width > 0 && f.width <= w)) bad('field width is off the page');
    if (f.height !== undefined && !(f.height > 0 && f.y + f.height <= h + 1e-9)) bad('field height runs off the page');
    if (f.source === 'static' && (typeof f.text !== 'string' || f.text.length > 300)) bad('static text must be under 300 characters');
    if (f.align !== undefined && !['left', 'center', 'right'].includes(f.align)) bad('align');
    if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 40)) bad('words before an item must be under 40 characters');
  }
  return cfg as PrintProfile;
}

export interface BillData {
  city: { name: string; return_address: string; remit_to: string; office_hours: string };
  account: { name: string; number: string; service_address: string; mailing_address: string | null };
  period: string; due: string; total_cents: number;
  lines: { code: string; description: string; amount_cents: number; meter?: string; units?: number; unit?: string }[];
}

function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: 'utilities print' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((res, rej) => {
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => res(Buffer.concat(chunks)));
    doc.on('error', rej);
  });
  build(doc);
  doc.end();
  return done;
}

function newPage(doc: PDFKit.PDFDocument, p: PrintProfile) {
  const k = PT[p.units];
  doc.addPage({ size: [p.page.width * k, p.page.height * k], margin: 0 });
  return k;
}

function cornerMarks(doc: PDFKit.PDFDocument, wPt: number, hPt: number) {
  const m = 14, len = 10;
  doc.lineWidth(0.5).strokeColor('#000');
  for (const [x, y, dx, dy] of [[m, m, 1, 1], [wPt - m, m, -1, 1], [m, hPt - m, 1, -1], [wPt - m, hPt - m, -1, -1]] as number[][]) {
    doc.moveTo(x, y).lineTo(x + dx * len, y).stroke();
    doc.moveTo(x, y).lineTo(x, y + dy * len).stroke();
  }
}

function put(doc: PDFKit.PDFDocument, k: number, f: Field, text: string, pageW: number) {
  doc.font(f.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(f.size ?? 10).fillColor('#000');
  const width = (f.width ?? Math.max(1, pageW - f.x)) * k;
  doc.text(text, f.x * k, f.y * k, { width, align: f.align ?? 'left', lineBreak: true });
}

export function renderBills(profile: PrintProfile, bills: BillData[]): Promise<Buffer> {
  return render((doc) => {
    for (const b of bills) {
      const k = newPage(doc, profile);
      if (profile.marks) cornerMarks(doc, profile.page.width * k, profile.page.height * k);
      for (const f of profile.fields) {
        switch (f.source) {
          case 'static': put(doc, k, f, f.text ?? '', profile.page.width); break;
          case 'city.name': put(doc, k, f, (f.label ?? '') + (b.city.name), profile.page.width); break;
          case 'city.return_address': put(doc, k, f, (f.label ?? '') + (b.city.return_address), profile.page.width); break;
          case 'city.remit_to': put(doc, k, f, (f.label ?? '') + (b.city.remit_to), profile.page.width); break;
          case 'city.office_hours': put(doc, k, f, (f.label ?? '') + (b.city.office_hours), profile.page.width); break;
          case 'account.name': put(doc, k, f, (f.label ?? '') + (b.account.name), profile.page.width); break;
          case 'account.number': put(doc, k, f, (f.label ?? '') + b.account.number, profile.page.width); break;
          case 'account.service_address': put(doc, k, f, (f.label ?? '') + (b.account.service_address), profile.page.width); break;
          case 'account.mailing_address': put(doc, k, f, (f.label ?? '') + mailingLines(b.account.mailing_address, b.account.service_address, b.city.return_address).join('\n'), profile.page.width); break;
          case 'bill.period': put(doc, k, f, (f.label ?? '') + b.period, profile.page.width); break;
          case 'bill.due': put(doc, k, f, (f.label ?? '') + b.due, profile.page.width); break;
          case 'bill.total': put(doc, k, f, (f.label ?? '') + fmt(b.total_cents), profile.page.width); break;
          case 'bill.lines': {
            const size = f.size ?? 9;
            const rowH = f.row_height ?? (size * 1.5) / PT[profile.units]; // in profile units
            const width = f.width ?? profile.page.width - f.x;
            let y = f.y;
            const maxY = f.height ? f.y + f.height : profile.page.height;
            const fit = linesThatFit(b.lines.length, Math.floor((maxY - f.y + 1e-9) / rowH));
            for (const l of b.lines.slice(0, fit.show)) {
              doc.font('Helvetica').fontSize(size).fillColor('#000');
              doc.text(l.code, f.x * k, y * k, { width: width * 0.15 * k, lineBreak: false });
              const used = l.units != null ? `, ${Number(l.units).toLocaleString('en-US')}${l.unit ? ' ' + l.unit : ''} used` : '';
              doc.text(l.description + (l.meter ? ` (${l.meter})` : '') + used, (f.x + width * 0.17) * k, y * k, { width: width * 0.55 * k, lineBreak: false });
              doc.text(fmt(l.amount_cents), (f.x + width * 0.72) * k, y * k, { width: width * 0.28 * k, align: 'right', lineBreak: false });
              y += rowH;
            }
            // Out of room: say so on the last row, so nobody thinks a charge is missing from the total.
            if (fit.more) {
              doc.font('Helvetica-Oblique').fontSize(size).fillColor('#000')
                .text(moreText(fit.more), f.x * k, y * k, { width: width * k, lineBreak: false });
            }
            break;
          }
        }
      }
    }
  });
}

export interface EnvelopeData { recipient: string[]; return_address: string; city_name: string }

export function renderEnvelopes(profile: PrintProfile, items: EnvelopeData[]): Promise<Buffer> {
  return render((doc) => {
    for (const e of items) {
      const k = newPage(doc, profile);
      if (profile.marks) cornerMarks(doc, profile.page.width * k, profile.page.height * k);
      for (const f of profile.fields) {
        if (f.source === 'static') put(doc, k, f, f.text ?? '', profile.page.width);
        else if (f.source === 'city.name') put(doc, k, f, e.city_name, profile.page.width);
        else if (f.source === 'return_address') put(doc, k, f, e.return_address, profile.page.width);
        else if (f.source === 'recipient') put(doc, k, f, e.recipient.filter(Boolean).join('\n'), profile.page.width);
      }
    }
  });
}

/** A page of rulers and boxes so staff can print it, hold it up to the real paper, and adjust positions. */
export function renderTestPage(profile: PrintProfile, name: string): Promise<Buffer> {
  return render((doc) => {
    const k = newPage(doc, profile);
    const W = profile.page.width, H = profile.page.height;
    doc.lineWidth(1).strokeColor('#000').rect(0.5, 0.5, W * k - 1, H * k - 1).stroke();
    doc.font('Helvetica').fontSize(7).fillColor('#444');
    const step = profile.units === 'mm' ? 10 : profile.units === 'in' ? 0.5 : 36;
    for (let x = step; x < W; x += step) {
      doc.moveTo(x * k, 0).lineTo(x * k, 6).stroke();
      doc.text(String(+x.toFixed(2)), x * k + 1, 7, { lineBreak: false });
    }
    for (let y = step; y < H; y += step) {
      doc.moveTo(0, y * k).lineTo(6, y * k).stroke();
      doc.text(String(+y.toFixed(2)), 8, y * k - 3, { lineBreak: false });
    }
    doc.dash(3, { space: 3 }).strokeColor('#888');
    for (const f of profile.fields) {
      const w = (f.width ?? Math.min(W - f.x, W / 3)) * k;
      const h = (f.source === 'bill.lines' ? Math.min(H - f.y, H / 3) : (f.size ?? 10) * 3 / k) * k;
      doc.rect(f.x * k, f.y * k, w, Math.max(14, h)).stroke();
      doc.font('Helvetica').fontSize(Math.min(f.size ?? 10, 9)).fillColor('#000');
      doc.text(f.source === 'static' ? (f.text ?? '') : `[${f.source}]`, f.x * k + 2, f.y * k + 2, { width: w - 4, lineBreak: false });
    }
    doc.undash();
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
    doc.text(`TEST PAGE  ${name}  page ${W} x ${H} ${profile.units}${profile.marks ? '  marks on' : '  marks off'}`,
      14, Math.max(24, H * k / 2), { width: W * k - 28 });
    if (profile.marks) cornerMarks(doc, W * k, H * k);
  });
}
