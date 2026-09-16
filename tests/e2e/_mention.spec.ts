import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function createProject(page: Page, name: string): Promise<void> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-e2e-mention-'));
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-repo').fill(repoDir);
  await page.getByTestId('project-submit').click();
  await expect(page.getByTestId('add-agent')).toBeVisible();
}

async function nav(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click();
}

test('the "@ Team Lead" affordance inserts the mention token and sends it (AC5)', async ({ page }) => {
  await createProject(page, 'Mention');
  await nav(page, 'Threads');

  const input = page.getByTestId('chat-input');
  await input.fill('are you looking into this issue?');

  // Clicking the @ button prepends the mention token the server recognizes.
  await page.getByTestId('mention-lead').click();
  await expect(input).toHaveValue(/@Team Lead\s*$/);

  // The composed message includes both the mention and the user's text.
  await expect(input).toHaveValue(/are you looking into this issue\?\s+@Team Lead\s*$/);

  // It sends like any other message (the mention is plain text the Lead parses).
  await page.getByTestId('chat-send').click();
  await expect(page.getByText('are you looking into this issue?').first()).toBeVisible();
});
