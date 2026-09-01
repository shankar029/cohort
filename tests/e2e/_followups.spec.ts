import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function createProject(page: Page): Promise<void> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-flw-'));
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Flow Demo');
  await page.getByTestId('project-repo').fill(repoDir);
  await page.getByTestId('project-submit').click();
  await page.getByTestId('add-agent').waitFor();
}

test('empty board shows a hint linking to chat', async ({ page }) => {
  await createProject(page);
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(page.getByTestId('board-empty-hint')).toBeVisible();
  await page.getByRole('link', { name: 'open Chat' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('sidebar How it works reopens the collapsed About panel', async ({ page }) => {
  await createProject(page);
  const projUrl = page.url();
  // Collapse the About panel from the home page first.
  await page.goto('/');
  await page.getByTestId('about-toggle').click(); // now collapsed
  await expect(page.getByText(/local orchestrator for a team/i)).toBeHidden();

  // From inside the project, click the sidebar "How it works".
  await page.goto(projUrl);
  await page.getByTestId('how-it-works-link').click();
  await expect(page).toHaveURL(/\/$|\/\?/);
  // Panel is expanded again (intro paragraph visible), and the query param cleared.
  await expect(page.getByText(/local orchestrator for a team/i)).toBeVisible();
  await expect(page).not.toHaveURL(/about=1/);
});
