import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPack } from '../src/packs.js';

describe('state packs', () => {
  it('loads the Missouri pack and only allows real settings', () => {
    const p = loadPack('MO')!;
    expect(p.settings.penalty_bps).toBe(1000);
    expect(p.review_with_your_attorney.length).toBeGreaterThan(0);
  });
  it('returns nothing for a state without a pack or a bad code', () => {
    expect(loadPack('ZZ')).toBeNull();
    expect(loadPack('../etc')).toBeNull();
  });
  it('refuses a pack with an unknown setting', async () => {
    const fs = await import('node:fs'); const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
    fs.writeFileSync(path.join(dir, 'XX.json'), JSON.stringify({ state: 'XX', name: 'x', timezone: 'UTC', settings: { admin_password: 'x' }, review_with_your_attorney: [], note: '' }));
    expect(() => loadPack('XX', dir)).toThrow();
  });
});
