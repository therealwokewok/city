import { describe, expect, it } from 'vitest';
import { checkForUpdate, isNewer, parseVersion, RUNNING_VERSION } from '../src/updates.js';

const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const rel = (tag: string, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false, ...extra });

describe('update check', () => {
  it('compares versions by number, not by text', () => {
    expect(isNewer(parseVersion('utilities-v0.10.0')!, parseVersion('v0.9.9')!)).toBe(true);
    expect(isNewer([1, 0, 0], [1, 0, 0])).toBe(false);
  });
  it('finds the newest utilities release and ignores other releases, drafts and prereleases', async () => {
    const info = await checkForUpdate('https://github.com/o/r', fakeFetch(200, [rel('website-v9.0.0'), rel('utilities-v99.0.0', { draft: true }), rel('utilities-v98.0.0', { prerelease: true }), rel('utilities-v5.2.0'), rel('utilities-v5.10.0')]));
    expect(info).toMatchObject({ latest: '5.10.0', newer: true, running: RUNNING_VERSION });
  });
  it('says plainly when there is nothing, or GitHub cannot be reached', async () => {
    expect((await checkForUpdate('https://github.com/o/r', fakeFetch(404, {}))).problem).toMatch(/No releases/);
    const none = await checkForUpdate('https://github.com/o/r', fakeFetch(200, [])); expect(none.problem).toBeUndefined(); expect(none.newer).toBe(false);
    expect((await checkForUpdate('https://github.com/o/r', (async () => { throw new Error('x'); }) as any)).problem).toMatch(/Could not reach/);
  });
  it('never sends a request for a non-GitHub address', async () => {
    let called = false;
    const r = await checkForUpdate('https://evil.example/o/r', (async () => { called = true; return new Response('[]'); }) as any);
    expect(called).toBe(false);
    expect(r.problem).toBeTruthy();
  });
});
