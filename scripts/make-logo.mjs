import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error('Usage: node scripts/make-logo.mjs <source.png>');
  process.exit(1);
}
const outDir = path.join(process.cwd(), 'public', 'brand');
fs.mkdirSync(outDir, { recursive: true });

const dataUrl = `data:image/png;base64,${fs.readFileSync(SRC).toString('base64')}`;
const browser = await chromium.launch();
const page = await browser.newPage();

async function render({ crop, size }) {
  return page.evaluate(
    async ({ dataUrl, crop, size }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (crop) {
        // crop is [sx, sy, sw, sh] in source pixels, drawn to fill the square
        ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3], 0, 0, size, size);
      } else {
        const scale = Math.min(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      }
      return c.toDataURL('image/png');
    },
    { dataUrl, crop, size },
  );
}

// Full logo (mark + ATEAM wordmark), contained.
const logo = await render({ crop: null, size: 512 });
fs.writeFileSync(
  path.join(outDir, 'logo.png'),
  Buffer.from(logo.replace(/^data:image\/png;base64,/, ''), 'base64'),
);

// Square mark: crop just the triangle (excludes the wordmark below).
const mark = await render({ crop: [200, 128, 612, 612], size: 256 });
fs.writeFileSync(
  path.join(outDir, 'mark.png'),
  Buffer.from(mark.replace(/^data:image\/png;base64,/, ''), 'base64'),
);

await browser.close();
console.log('wrote public/brand/logo.png and public/brand/mark.png');
