// Shrinks the screenshots to small palette PNGs so the guide stays light. Run after the screenshot pass.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.dirname(new URL(import.meta.url).pathname);
let before = 0, after = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png'))) {
  const p = path.join(dir, f);
  before += fs.statSync(p).size;
  const buf = await sharp(p).png({ palette: true, colours: 128, dither: 0, compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(p, buf);
  after += buf.length;
}
console.log(`screenshots: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
