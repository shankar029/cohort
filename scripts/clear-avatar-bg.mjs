import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Two-stage clean-up that removes the soft background glow AND the scattered
// near-opaque dithering specks without jagging the character edge:
//   1. Smooth alpha curve (smoothstep LO..HI): crushes the faint glow to zero
//      while keeping the character's own antialiased edge smooth.
//   2. Keep-largest-connected-component: once the glow that linked them is gone,
//      the leftover specks are detached islands and get dropped.
const LO = Number(process.env.LO ?? 140); // alpha <= LO -> fully transparent
const HI = Number(process.env.HI ?? 215); // alpha >= HI -> fully opaque
const APPLY = process.env.APPLY === '1';
const dir = fileURLToPath(new URL('../public/avatars/', import.meta.url));
const preview = fileURLToPath(new URL('../test-results/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.png'));

const browser = await chromium.launch();
const page = await browser.newPage();
const imgs = files.map((f) => `data:image/png;base64,${readFileSync(dir + f).toString('base64')}`);

const outs = await page.evaluate(
  async ({ srcs, LO, HI, __ER__ }) => {
    const results = [];
    for (const src of srcs) {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const w = c.width,
        h = c.height,
        n = w * h;
      const id = ctx.getImageData(0, 0, w, h);
      const d = id.data;

      // 1. Smoothstep alpha curve: crush the soft glow, keep a smooth edge.
      for (let i = 0; i < n; i++) {
        const a = d[i * 4 + 3];
        let t = (a - LO) / (HI - LO);
        t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
        d[i * 4 + 3] = Math.round(255 * t);
      }

      // 2. Keep only the largest connected component of visible pixels; the
      //    detached dithering specks become their own tiny islands and drop out.
      const vis = new Uint8Array(n);
      for (let i = 0; i < n; i++) vis[i] = d[i * 4 + 3] > 0 ? 1 : 0;
      const comp = new Int32Array(n).fill(-1);
      const q = new Int32Array(n);
      let best = -1,
        bestSize = 0;
      for (let s = 0; s < n; s++) {
        if (!vis[s] || comp[s] !== -1) continue;
        let head = 0,
          tail = 0,
          size = 0;
        q[tail++] = s;
        comp[s] = s;
        while (head < tail) {
          const i = q[head++];
          size++;
          const x = i % w,
            y = (i / w) | 0;
          const nb = [];
          if (x > 0) nb.push(i - 1);
          if (x < w - 1) nb.push(i + 1);
          if (y > 0) nb.push(i - w);
          if (y < h - 1) nb.push(i + w);
          for (const j of nb)
            if (vis[j] && comp[j] === -1) {
              comp[j] = s;
              q[tail++] = j;
            }
        }
        if (size > bestSize) {
          bestSize = size;
          best = s;
        }
      }
      for (let i = 0; i < n; i++) if (comp[i] !== best) d[i * 4 + 3] = 0;

      // 3. Morphological opening (erode ER px, then dilate ER px) on the kept
      //    mask to shave the ragged 1-2px dithered fringe off the edge without
      //    shrinking the body.
      const ER = Number(__ER__);
      let m = new Uint8Array(n);
      for (let i = 0; i < n; i++) m[i] = d[i * 4 + 3] > 0 ? 1 : 0;
      const morph = (src, erode) => {
        const dst = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const x = i % w,
            y = (i / w) | 0;
          const l = x > 0 ? src[i - 1] : erode ? 0 : src[i];
          const r = x < w - 1 ? src[i + 1] : erode ? 0 : src[i];
          const u = y > 0 ? src[i - w] : erode ? 0 : src[i];
          const dn = y < h - 1 ? src[i + w] : erode ? 0 : src[i];
          dst[i] = erode
            ? src[i] && l && r && u && dn
              ? 1
              : 0
            : src[i] || l || r || u || dn
              ? 1
              : 0;
        }
        return dst;
      };
      for (let k = 0; k < ER; k++) m = morph(m, true);
      for (let k = 0; k < ER; k++) m = morph(m, false);
      for (let i = 0; i < n; i++) if (!m[i]) d[i * 4 + 3] = 0;

      ctx.putImageData(id, 0, 0);
      results.push(c.toDataURL('image/png'));
    }
    return results;
  },
  { srcs: imgs, LO, HI, __ER__: Number(process.env.ER ?? 1) },
);

// Montage at true display size (~48px) on the app surface — the size users see.
const montage = await page.evaluate(async (srcs) => {
  const cols = 7,
    cell = 72,
    icon = 48,
    pad = (cell - icon) / 2,
    rows = Math.ceil(srcs.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * cell;
  c.height = rows * cell;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#181825';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < srcs.length; i++) {
    const img = new Image();
    img.src = srcs[i];
    await img.decode();
    ctx.drawImage(img, (i % cols) * cell + pad, ((i / cols) | 0) * cell + pad, icon, icon);
  }
  return c.toDataURL('image/png');
}, outs);
writeFileSync(preview + 'alpha-fixed.png', Buffer.from(montage.split(',')[1], 'base64'));

if (APPLY) {
  outs.forEach((out, i) =>
    writeFileSync(dir + files[i], Buffer.from(out.split(',')[1], 'base64')),
  );
  console.log(`APPLIED curve+component (LO=${LO}, HI=${HI}) to ${files.length}`);
} else {
  console.log(`PREVIEW (LO=${LO}, HI=${HI}) -> test-results/alpha-fixed.png`);
}
await browser.close();
