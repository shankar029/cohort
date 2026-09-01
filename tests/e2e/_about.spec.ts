import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'test-results', 'cohort');
fs.mkdirSync(OUT, { recursive: true });

async function setLook(page: Page, mode: 'dark' | 'light', comic: boolean): Promise<void> {
  await page.evaluate(
    ({ mode, comic }) => {
      localStorage.setItem('ateam-theme', mode);
      localStorage.setItem('ateam-palette', comic ? 'comic' : 'default');
      localStorage.removeItem('cohort-about-collapsed');
    },
    { mode, comic },
  );
  await page.reload();
  await page.waitForTimeout(400);
}

test('cohort about panel', async ({ page }) => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-about-'));
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Demo App');
  await page.getByTestId('project-repo').fill(repoDir);
  await page.getByTestId('project-submit').click();
  await page.getByTestId('add-agent').waitFor();

  for (const [mode, comic, label] of [
    ['light', true, 'comic-light'],
    ['dark', true, 'comic-dark'],
    ['dark', false, 'default-dark'],
  ] as Array<['dark' | 'light', boolean, string]>) {
    await page.goto('/');
    await setLook(page, mode, comic);
    await page.getByTestId('about-cohort').waitFor();
    await page.screenshot({ path: path.join(OUT, `about-${label}.png`) });
  }
});
