import { createRequire } from 'node:module';
import { GITHUB_REPO } from './settings.js';

const require_ = createRequire(import.meta.url);
export const RUNNING_VERSION: string = (() => { try { return require_('../package.json').version; } catch { return '0.0.0'; } })();

export const parseVersion = (tag: string): number[] | null => {
  const m = tag.match(/(\d+)\.(\d+)\.(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
export const isNewer = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; };

export interface UpdateInfo { running: string; latest?: string; newer: boolean; url?: string; checked_at: string; problem?: string }

/**
 * Looks for a newer release of this app on GitHub. It only reads public release information from api.github.com.
 * It never downloads or runs code: installing an update is up to whoever hosts the app (see docs/updates.md).
 */
export async function checkForUpdate(repoUrl: string, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo> {
  const base: UpdateInfo = { running: RUNNING_VERSION, newer: false, checked_at: new Date().toISOString() };
  if (!GITHUB_REPO.test(repoUrl)) return { ...base, problem: 'The update source is not a GitHub address' };
  const [owner, repo] = repoUrl.replace('https://github.com/', '').split('/');
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'utilities-update-check' }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ...base, problem: res.status === 404 ? 'No releases found at that address yet' : `GitHub answered with ${res.status}` };
    const list = (await res.json()) as { tag_name: string; html_url: string; draft: boolean; prerelease: boolean }[];
    const mine = list.filter((r) => !r.draft && !r.prerelease && /^utilities-v\d+\.\d+\.\d+$/.test(r.tag_name));
    const best = mine.map((r) => ({ r, v: parseVersion(r.tag_name)! })).sort((x, y) => (isNewer(x.v, y.v) ? -1 : 1))[0];
    if (!best) return { ...base, problem: 'No release named like utilities-v1.2.3 was found' };
    const running = parseVersion('v' + RUNNING_VERSION) ?? [0, 0, 0];
    const url = /^https:\/\/github\.com\//.test(best.r.html_url) ? best.r.html_url : undefined;
    return { ...base, latest: best.r.tag_name.replace('utilities-v', ''), newer: isNewer(best.v, running), url };
  } catch {
    return { ...base, problem: 'Could not reach GitHub just now' };
  }
}
