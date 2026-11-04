// A written-down quality standard for every screen, checked by measuring the page, not by looking at it.
// Each rule names the standard it comes from. auditLayout() returns a list of plain-English problems; an empty list passes.
//
//   WCAG 2.2 AA               axe-core, all rules tagged wcag2a/2aa/21a/21aa/22aa
//   WCAG 2.5.5 target size    every control at least 44 by 44 CSS px
//   WCAG 1.4.10 reflow        no sideways scrolling (checked at phone width and, by the caller, at 320px)
//   WCAG 1.4.8 reading        lines of body text no longer than 80 characters
//   4-point spacing grid      padding, gap and margin on components are multiples of 4px
//   Content inset             text and controls sit at least 12px inside any bordered or filled box
//   Legibility                body text at least 16px, small print at least 14px
//   Structure                 exactly one h1, heading levels never skip
//   No collisions             visible elements never overlap, nothing is clipped or cut off
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export const BOXES = '.card, dialog, .notice, .addbox, fieldset, .radio-card, .status, .tbl tr, .btn, input:not([type=checkbox]):not([type=radio]), select, textarea';

export async function auditLayout(page: Page, screen: string): Promise<string[]> {
  const problems: string[] = [];
  // On phones the menu is fixed to the bottom of the window and floats over whatever is scrolled under it; the page
  // leaves room so nothing ends up beneath it, but axe measures contrast through it. Lift it out for the scan.
  await page.evaluate(() => { const t = document.getElementById('tabs'); if (t) t.style.visibility = 'hidden'; });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await page.evaluate(() => { const t = document.getElementById('tabs'); if (t) t.style.visibility = ''; });
  for (const v of axe.violations) problems.push(`WCAG ${v.id}: ${v.help} (${v.nodes.length} place${v.nodes.length === 1 ? '' : 's'}, e.g. ${v.nodes[0]?.target.join(' ')}: ${(v.nodes[0]?.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 220)})`);

  const found: string[] = await page.evaluate((BOXES) => {
    const out: string[] = [];
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !(el.closest('details:not([open])') && !el.matches('summary, summary *')); };
    const label = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
    const px = (v: string) => parseFloat(v) || 0;
    const inDialog = (el: Element) => !!el.closest('dialog[open]');
    const dialogOpen = !!document.querySelector('dialog[open]');
    // When a dialog is open, the page behind it is inert and may legitimately be covered.
    const relevant = (el: Element) => (dialogOpen ? inDialog(el) : true) && !el.closest('#tabs') && !el.closest('[hidden]');

    // 1. Sideways scroll (WCAG 1.4.10)
    const over = document.documentElement.scrollWidth - window.innerWidth;
    if (over > 1) out.push(`Reflow: the page is ${over}px wider than the screen`);

    // 2. Target size (WCAG 2.5.5): 44px, measured on what a finger lands on
    for (const el of document.querySelectorAll<HTMLElement>('main a.btn, main button, main input:not([type=checkbox]):not([type=radio]), main select, #tabs a, header button, dialog button')) {
      if (!vis(el) || !relevant(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) out.push(`Target size: ${label(el)} is ${Math.round(r.width)}x${Math.round(r.height)}px, needs 44x44`);
    }

    // 3. Spacing grid and content inset, on every box-like component
    const textRects = (root: Element) => {
      const rects: (DOMRect & { what?: string })[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (!n.textContent || !n.textContent.trim()) continue;
        const p = n.parentElement; if (!p || !vis(p) || p.closest('legend')) continue; // a legend sits on the border by design
        const range = document.createRange(); range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0 && r.right > 0) rects.push(Object.assign(r, { what: '"' + n.textContent.trim().slice(0, 30) + '"' })); // off-screen helpers for screen readers do not count
      }
      for (const el of root.querySelectorAll('input, select, textarea, button, img, svg, .status')) if (vis(el) && el !== root) rects.push(Object.assign(el.getBoundingClientRect(), { what: label(el) }));
      return rects;
    };
    const isGrid4 = (v: number) => Math.abs(v / 4 - Math.round(v / 4)) < 0.26; // computed values are fractional (rem), allow a pixel of rounding
    for (const el of document.querySelectorAll<HTMLElement>(BOXES)) {
      if (!vis(el) || !relevant(el)) continue;
      const s = getComputedStyle(el);
      const isTableRow = el.matches('.tbl tr');
      if (isTableRow && s.display !== 'block') continue; // only the phone card form of a row has its own box
      const framed = px(s.borderTopWidth) > 0 && px(s.borderBottomWidth) > 0 && px(s.borderLeftWidth) > 0 && px(s.borderRightWidth) > 0;
      const boxed = isTableRow || framed || (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent');
      // 4-point grid: padding and gap are multiples of 4
      for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap', 'marginBottom'] as const) {
        const v = s[prop]; if (v === 'normal' || v === 'auto' || (prop === 'marginBottom' && el.tagName === 'DIALOG')) continue;
        const n = px(v);
        if (n > 0 && !isGrid4(n)) out.push(`Spacing grid: ${label(el)} has ${prop} ${n.toFixed(1)}px, not a multiple of 4`);
      }
      // content inset: at least 12px from a visible edge, for things that hold other content
      if (!boxed || el.matches('.btn, input, select, textarea, .status')) continue;
      const r = el.getBoundingClientRect();
      const inner = { left: r.left + px(s.borderLeftWidth), right: r.right - px(s.borderRightWidth), top: r.top + px(s.borderTopWidth), bottom: r.bottom - px(s.borderBottomWidth) };
      const min: Record<string, { v: number; what?: string }> = { left: { v: Infinity }, right: { v: Infinity }, top: { v: Infinity }, bottom: { v: Infinity } };
      for (const t of textRects(el)) {
        for (const [k, v] of [['left', t.left - inner.left], ['right', inner.right - t.right], ['top', t.top - inner.top], ['bottom', inner.bottom - t.bottom]] as [string, number][]) if (v < min[k].v) min[k] = { v, what: t.what };
      }
      const need = 12;
      const bad = Object.entries(min).filter(([, m]) => m.v < need - 0.5 && Number.isFinite(m.v));
      if (bad.length) out.push(`Content inset: ${label(el)} content is only ${bad.map(([k, m]) => `${Math.round(m.v)}px from the ${k} (${m.what})`).join(', ')} (needs ${need}px)`);
    }

    // 4. Nothing cut off or clipped
    for (const el of document.querySelectorAll<HTMLElement>('main *, #tabs a, header *, dialog *')) {
      if (!vis(el) || !relevant(el)) continue;
      const s = getComputedStyle(el);
      if (el.matches('select, textarea, input, .sr, .sr *')) continue; // screen-reader-only text is clipped on purpose
      if (el.scrollWidth > el.clientWidth + 1 && (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.whiteSpace === 'nowrap') && !el.matches('details, summary')) {
        if (s.textOverflow !== 'ellipsis') out.push(`Cut off: ${label(el)} content is ${el.scrollWidth - el.clientWidth}px wider than its box`);
      }
      // a child that pokes out of a parent that clips
      const clip = el.parentElement && getComputedStyle(el.parentElement);
      if (clip && (clip.overflow === 'hidden' || clip.overflowX === 'hidden')) {
        const pr = el.parentElement!.getBoundingClientRect(), r = el.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) out.push(`Clipped: ${label(el)} sticks out of ${label(el.parentElement!)}`);
      }
    }

    // 5. No overlaps between visible leaf elements that hold text
    // Inline text that wraps is several boxes, one per line, so each fragment is compared on its own.
    const leaves: { el: Element; rs: DOMRect[] }[] = [];
    for (const el of document.querySelectorAll('main *, dialog *')) {
      if (!vis(el) || !relevant(el)) continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      const isControl = el.matches('input, select, textarea, button, img');
      if (!hasText && !isControl) continue;
      const rs = [...el.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2 && r.right > 0);
      if (rs.length) leaves.push({ el, rs });
    }
    const contains = (a: Element, b: Element) => a.contains(b) || b.contains(a);
    const seen = new Set<string>();
    for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (contains(a.el, b.el)) continue;
      for (const ra of a.rs) for (const rb of b.rs) {
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        const key = label(a.el) + label(b.el);
        if (w > 2 && h > 2 && !seen.has(key)) { seen.add(key); out.push(`Overlap: ${label(a.el)} overlaps ${label(b.el)} by ${Math.round(w)}x${Math.round(h)}px`); }
      }
    }

    // 6. Reading: line length and text size
    {
      // measured line by line: each client rect of a text node is one line fragment, and a Latin glyph averages about half an em
      const walker = document.createTreeWalker(document.querySelector('main')!, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const p = n.parentElement; if (!p || !n.textContent?.trim() || !vis(p) || !relevant(p)) continue;
        const size = px(getComputedStyle(p).fontSize);
        const range = document.createRange(); range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          const chars = r.width / (size * 0.5);
          if (chars > 84) { out.push(`Line length: ${label(p)} has a line of about ${Math.round(chars)} characters (max 80)`); break; }
        }
      }
    }
    for (const el of document.querySelectorAll<HTMLElement>('main *, dialog *, #tabs a, .foot *')) {
      if (!vis(el) || !relevant(el)) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue;
      const size = px(getComputedStyle(el).fontSize);
      const small = el.closest('.hint, .muted, .small, small, .foot, .status, #tabs, .brand-sub, .tier legend, legend');
      if (size < (small ? 14 : 16) - 0.3) out.push(`Text size: ${label(el)} is ${size.toFixed(1)}px (${small ? 'small print needs 14' : 'body text needs 16'})`);
    }

    // 7. Nothing half-rendered: a bare "null" or "undefined" is a value that was never turned into words
    {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = n.textContent!.trim(); const p = n.parentElement;
        if (!p || !vis(p) || p.closest('script, style')) continue;
        if (/^(null|undefined|NaN|\[object Object\])$/.test(t) || /\b(undefined|NaN|\[object Object\])\b/.test(t)) out.push(`Unfinished text: ${label(p)} shows "${t.slice(0, 40)}"`);
      }
    }

    // 8. Structure: one h1, no skipped levels
    const hs = [...document.querySelectorAll('main h1, main h2, main h3, main h4, dialog h2')].filter(vis);
    const h1s = hs.filter((h) => h.tagName === 'H1').length;
    if (h1s !== 1) out.push(`Structure: ${h1s} h1 headings on the page (needs exactly 1)`);
    let last = 1;
    for (const h of hs) { const lvl = Number(h.tagName[1]); if (lvl > last + 1) out.push(`Structure: ${label(h)} skips from h${last} to h${lvl}`); last = lvl; }
    return out;
  }, BOXES);

  return [...problems, ...found].map((p) => `[${screen}] ${p}`);
}
