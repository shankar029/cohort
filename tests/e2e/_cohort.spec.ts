import { test, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'test-results', 'cohort');
fs.mkdirSync(OUT, { recursive: true });

async function createProject(page: Page, name: string): Promise<void> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-cohort-'));
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-repo').fill(repoDir);
  await page.getByTestId('project-submit').click();
  await page.getByTestId('add-agent').waitFor();
}

async function addSpecialist(page: Page, id: string): Promise<void> {
  await page.getByTestId('add-agent').click();
  await page.getByTestId(`add-catalog-${id}`).click();
  await page.getByTestId(`added-${id}`).waitFor();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('agent-list').waitFor();
}

async function setLook(page: Page, mode: 'dark' | 'light', comic: boolean): Promise<void> {
  await page.evaluate(
    ({ mode, comic }) => {
      localStorage.setItem('ateam-theme', mode);
      localStorage.setItem('ateam-palette', comic ? 'comic' : 'default');
    },
    { mode, comic },
  );
  await page.reload();
  await page.waitForTimeout(400);
}

test('cohort: brand + avatars across all four looks', async ({ page }) => {
  await createProject(page, 'Cohort Demo');
  for (const id of [
    'product-manager',
    'architect',
    'frontend-engineer',
    'backend-engineer',
    'qa-engineer',
    'code-reviewer',
    'security-auditor',
    'data-engineer',
  ])
    await addSpecialist(page, id);
  const projUrl = page.url();

  const looks: Array<['dark' | 'light', boolean, string]> = [
    ['dark', false, 'default-dark'],
    ['light', false, 'default-light'],
    ['dark', true, 'comic-dark'],
    ['light', true, 'comic-light'],
  ];
  for (const [mode, comic, label] of looks) {
    await page.goto(projUrl);
    await setLook(page, mode, comic);
    // Agents page shows the avatar grid + brand.
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await page.getByTestId('agent-list').waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `agents-${label}.png`), fullPage: true });
    // Projects landing shows the Cohort wordmark + mark.
    await page.goto('/');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `projects-${label}.png`), fullPage: true });
  }
});
