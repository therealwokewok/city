// Retakes the guide's screenshots: the desktop walk-through into docs/screens, then shrinks them.
import { spawnSync } from 'node:child_process';
const run = (cmd, args, env = {}) => { const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ...env } }); if (r.status) process.exit(r.status); };
run('npx', ['playwright', 'test', '-c', 'playwright.screens.config.ts'], { SHOT_DIR: 'docs/screens' });
run('node', ['docs/screens/shrink.mjs']);
