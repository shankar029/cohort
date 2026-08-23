import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'public', 'avatars');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
const browser = await chromium.launch();
const page = await browser.newPage();
const SIZE = 256;
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  const out = await page.evaluate(
    async ({ dataUrl, SIZE }) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = dataUrl;
      });
      const c = document.createElement('canvas');
      c.width = SIZE;
      c.height = SIZE;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const scale = Math.min(SIZE / img.width, SIZE / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
      return c.toDataURL('image/png');
    },
    { dataUrl, SIZE },
  );
  const b64 = out.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(dir, f), Buffer.from(b64, 'base64'));
  console.log(
    `${f}: ${(buf.length / 1024).toFixed(0)}KB -> ${(Buffer.from(b64, 'base64').length / 1024).toFixed(0)}KB`,
  );
}
await browser.close();
