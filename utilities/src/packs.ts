import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSettings } from './settings.js';

export interface StatePack { state: string; name: string; timezone: string; settings: Record<string, unknown>; review_with_your_attorney: string[]; note: string }

/** Loads packs/<STATE>.json. A pack only supplies starting values; the city can change every one of them. */
export function loadPack(state: string, dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packs')): StatePack | null {
  if (!/^[A-Z]{2}$/.test(state)) return null;
  const file = path.join(dir, `${state}.json`);
  if (!fs.existsSync(file)) return null;
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as StatePack;
  if (p.state !== state || typeof p.timezone !== 'string' || !Array.isArray(p.review_with_your_attorney)) throw new Error(`pack ${state} is malformed`);
  validateSettings(p.settings); // throws on a bad key or value
  return p;
}
