import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Source: the new transparent "A Team" logo (triangle mark + ATEAM wordmark).
const SRC = process.argv[2];
const outDir = path.join(process.cwd(), 'public', 'brand');
const buf = fs.readFileSync(SRC);
const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(crop, size) {
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
      const sx = crop ? crop.x : 0;
      const sy = crop ? crop.y : 0;
      const sw = crop ? crop.w : img.width;
      const sh = crop ? crop.h : img.height;
      // contain into size×size, centered
      const scale = Math.min(size / sw, size / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(img, sx, sy, sw, sh, (size - dw) / 2, (size - dh) / 2, dw, dh);
      return c.toDataURL('image/png');
    },
    { dataUrl, crop, size },
  );
}

function write(name, dataURL) {
  const b64 = dataURL.replace(/^data:image\/png;base64,/, '');
  const out = path.join(outDir, name);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`${name}: ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
}

// mark.png = just the triangle (crop above the wordmark), 256×256
write('mark.png', await render({ x: 172, y: 60, w: 680, h: 680 }, 256));
// logo.png = full lockup (triangle + wordmark), 512×512
write('logo.png', await render(null, 512));

await browser.close();
