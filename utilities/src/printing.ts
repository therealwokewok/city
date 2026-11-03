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
  height?: number; // bill.lines: room the list may use; box: how tall it is
  shade?: boolean;  // box: light gray inside. line: dashed, for a "cut here" line
}
export interface PrintProfile {
  units: Units;
  page: { width: number; height: number };
  marks?: boolean;      // corner marks, off by default; some printers and mailers want them
  fields: Field[];
}

export const BILL_SOURCES = ['static', 'city.name', 'city.return_address', 'city.remit_to', 'city.office_hours', 'city.phone', 'account.name',
  'account.number', 'account.service_address', 'account.mailing_address', 'bill.period', 'bill.due', 'bill.total', 'bill.lines', 'box', 'line'];
export const ENVELOPE_SOURCES = ['static', 'city.name', 'return_address', 'recipient', 'box', 'line'];
/** Shapes, not words: a frame or a divider. */
const SHAPES = ['box', 'line'];

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
    if (SHAPES.includes(f.source) && !(f.width && f.width > 0)) bad(`a ${f.source} needs a width`);
    if (f.source === 'box' && !(f.height && f.height > 0)) bad('a box needs a height');
    if (SHAPES.includes(f.source) && f.text !== undefined && (typeof f.text !== 'string' || f.text.length > 120)) bad('a heading on a box or line must be under 120 characters');
    if (f.x + (f.width ?? 0) > w + 1e-9) bad(`${f.source} runs off the right edge of the page`);
    if (f.align !== undefined && !['left', 'center', 'right'].includes(f.align)) bad('align');
    if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 40)) bad('words before an item must be under 40 characters');
  }
  return cfg as PrintProfile;
}

export interface BillData {
  city: { name: string; return_address: string; remit_to: string; office_hours: string; phone?: string };
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

const INK = '#1a1a1a', RULE = '#8a8a8a', SHADE = '#ececec';

/** A frame, light gray inside when shaded, with an optional small heading in its top left corner. */
function drawBox(doc: PDFKit.PDFDocument, k: number, f: Field) {
  const x = f.x * k, y = f.y * k, w = (f.width ?? 1) * k, h = (f.height ?? 1) * k;
  doc.save().lineWidth(1).strokeColor(INK);
  if (f.shade) doc.roundedRect(x, y, w, h, 4).fillAndStroke(SHADE, INK); else doc.roundedRect(x, y, w, h, 4).stroke();
  doc.restore();
  if (f.text) doc.font('Helvetica-Bold').fontSize(f.size ?? 8).fillColor(INK).text(f.text.toUpperCase(), x + 7, y + 6, { width: w - 14, lineBreak: false, characterSpacing: 0.6 });
}
/** A divider across the page. Dashed with words in the middle, it makes a clear "cut here" line. */
function drawLine(doc: PDFKit.PDFDocument, k: number, f: Field) {
  const x = f.x * k, y = f.y * k, w = (f.width ?? 1) * k;
  doc.save().lineWidth(f.shade ? 1 : 1.5).strokeColor(f.shade ? RULE : INK);
  if (f.shade) doc.dash(5, { space: 4 });
  doc.moveTo(x, y).lineTo(x + w, y).stroke();
  doc.undash().restore();
  if (f.text) {
    const size = f.size ?? 8;
    doc.font('Helvetica-Oblique').fontSize(size);
    const tw = Math.min(doc.widthOfString(f.text) + 12, w);
    doc.rect(x + (w - tw) / 2, y - size * 0.7, tw, size * 1.4).fill('#ffffff');
    doc.fillColor(INK).text(f.text, x + (w - tw) / 2 + 6, y - size * 0.5, { width: tw - 12, align: 'center', lineBreak: false });
  }
}

function put(doc: PDFKit.PDFDocument, k: number, f: Field, text: string, pageW: number) {
  doc.font(f.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(f.size ?? 10).fillColor('#000');
  const width = (f.width ?? Math.max(1, pageW - f.x)) * k;
  // Text may wrap, but never past the bottom of the page: a long address must not push the next bill onto a new sheet.
  const height = Math.max(doc.currentLineHeight(), doc.page.height - f.y * k - 2);
  doc.text(text, f.x * k, f.y * k, { width, height, align: f.align ?? 'left', lineBreak: true, ellipsis: true });
}

export function renderBills(profile: PrintProfile, bills: BillData[]): Promise<Buffer> {
  return render((doc) => {
    for (const b of bills) {
      const k = newPage(doc, profile);
      if (profile.marks) cornerMarks(doc, profile.page.width * k, profile.page.height * k);
      // Shapes first, so words always sit on top of a shaded box.
      for (const f of profile.fields) { if (f.source === 'box') drawBox(doc, k, f); else if (f.source === 'line') drawLine(doc, k, f); }
      for (const f of profile.fields) {
        switch (f.source) {
          case 'city.phone': put(doc, k, f, (f.label ?? '') + (b.city.phone ?? ''), profile.page.width); break;
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
            // A real table: a shaded heading row, light rules between charges, and a bold total at the bottom.
            const size = f.size ?? 9;
            const rowH = f.row_height ?? (size * 1.9) / PT[profile.units]; // in profile units
            const width = f.width ?? profile.page.width - f.x;
            const X = f.x * k, W = width * k, R = rowH * k;
            const col = { svc: X + 6, det: X + W * 0.30, amt: X + W * 0.74, amtW: W * 0.26 - 6 };
            const maxY = f.height ? f.y + f.height : profile.page.height;
            const rows = Math.floor((maxY - f.y + 1e-9) / rowH) - 2; // minus the heading row and the total row
            const fit = linesThatFit(b.lines.length, rows);
            let y = f.y * k;
            const textY = (top: number) => top + (R - size) / 2 + 1;
            doc.save().rect(X, y, W, R).fill(SHADE).restore();
            doc.font('Helvetica-Bold').fontSize(size).fillColor(INK);
            doc.text('Service', col.svc, textY(y), { lineBreak: false });
            doc.text('What it is for', col.det, textY(y), { lineBreak: false });
            doc.text('Amount', col.amt, textY(y), { width: col.amtW, align: 'right', lineBreak: false });
            doc.save().lineWidth(1).strokeColor(INK).moveTo(X, y + R).lineTo(X + W, y + R).stroke().restore();
            y += R;
            for (const l of b.lines.slice(0, fit.show)) {
              const used = l.units != null ? `${Number(l.units).toLocaleString('en-US')}${l.unit ? ' ' + l.unit : ''} used` : '';
              const what = [l.meter ? `Meter ${l.meter}` : '', used].filter(Boolean).join(', ');
              doc.font('Helvetica').fontSize(size).fillColor(INK);
              doc.text(l.description, col.svc, textY(y), { width: col.det - col.svc - 6, lineBreak: false, ellipsis: true });
              doc.fontSize(size - 0.5).fillColor('#333').text(what, col.det, textY(y), { width: col.amt - col.det - 6, lineBreak: false, ellipsis: true });
              doc.fontSize(size).fillColor(INK).text(fmt(l.amount_cents), col.amt, textY(y), { width: col.amtW, align: 'right', lineBreak: false });
              doc.save().lineWidth(0.5).strokeColor('#c8c8c8').moveTo(X, y + R).lineTo(X + W, y + R).stroke().restore();
              y += R;
            }
            // Out of room: say so on the last row, so nobody thinks a charge is missing from the total.
            if (fit.more) {
              doc.font('Helvetica-Oblique').fontSize(size).fillColor(INK).text(moreText(fit.more), col.svc, textY(y), { width: W - 12, lineBreak: false });
              y += R;
            }
            doc.save().lineWidth(1.5).strokeColor(INK).moveTo(X, y).lineTo(X + W, y).stroke().restore();
            doc.font('Helvetica-Bold').fontSize(size + 1).fillColor(INK);
            doc.text('Total for this bill', col.svc, textY(y), { lineBreak: false });
            doc.text(fmt(b.total_cents), col.amt, textY(y), { width: col.amtW, align: 'right', lineBreak: false });
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
      for (const f of profile.fields) { if (f.source === 'box') drawBox(doc, k, f); else if (f.source === 'line') drawLine(doc, k, f); }
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
    for (const f of profile.fields) { if (f.source === 'box') drawBox(doc, k, f); else if (f.source === 'line') drawLine(doc, k, f); }
    doc.dash(3, { space: 3 }).strokeColor('#888');
    for (const f of profile.fields.filter((x) => !SHAPES.includes(x.source))) {
      const w = (f.width ?? Math.min(W - f.x, W / 3)) * k;
      const h = (f.source === 'bill.lines' ? (f.height ?? Math.min(H - f.y, H / 3)) : (f.size ?? 10) * 3 / k) * k;
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
