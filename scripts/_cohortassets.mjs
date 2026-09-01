import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/shbs/Downloads/Cohort';
const AV = path.join(process.cwd(), 'public', 'avatars');
const BRAND = path.join(process.cwd(), 'public', 'brand');
const SIZE = 256;

// role -> source file. team-lead + mark come from the logo head (top-cropped).
const MAP = {
  'product-manager': 'agent11.png',
  architect: 'agent2.png',
  'ux-designer': 'agent9.png',
  'frontend-engineer': 'agent7.png',
  'backend-engineer': 'agent5.png',
  'qa-engineer': 'agent6.png',
  'devops-engineer': 'agent8.png',
  'docs-writer': 'agent1.png',
  researcher: 'agent3.png',
  'code-reviewer': 'agentr12.png',
  'security-auditor': 'agent4.png',
  'data-engineer': 'agent10.png',
};

const toDataUrl = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();

// Cover-crop a source image to a centered SIZE×SIZE PNG. `topBias` (0..1) shifts
// the crop window upward to keep heads in frame; `cropH` (0..1) limits the source
// height sampled (used to drop the logo's wordmark and keep just the head).
async function square(dataUrl, { topBias = 0.5, cropH = 1 } = {}) {
  return page.evaluate(
    async ({ dataUrl, SIZE, topBias, cropH }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const sw = img.width;
      const sh = img.height * cropH; // sample only the top cropH of the source
      const side = Math.min(sw, sh);
      const sx = (sw - side) / 2;
      const sy = (sh - side) * topBias;
      const c = document.createElement('canvas');
      c.width = SIZE;
      c.height = SIZE;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
      return c.toDataURL('image/png').split(',')[1];
    },
    { dataUrl, SIZE, topBias, cropH },
  );
}

const write = (dir, name, b64) => {
  fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
  console.log('  wrote', path.relative(process.cwd(), path.join(dir, name)));
};

// 12 catalog roles.
for (const [role, file] of Object.entries(MAP)) {
  const b64 = await square(toDataUrl(path.join(SRC, file)), { topBias: 0.4 });
  write(AV, `${role}.png`, b64);
}

// Team-Lead + brand mark from the logo head (crop out the "COHORT" wordmark: keep
// the top ~66% where the head is, biased slightly up).
const logo = toDataUrl(path.join(SRC, 'Cohort Logo.png'));
const head = await square(logo, { topBias: 0.28, cropH: 0.66 });
write(AV, 'team-lead.png', head);
write(BRAND, 'mark.png', head);
// Keep a full-logo copy too (unused in UI today, handy for docs/README).
write(BRAND, 'logo.png', Buffer.from(fs.readFileSync(path.join(SRC, 'Cohort Logo.png'))).toString('base64'));

await browser.close();
console.log('done');
