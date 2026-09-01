import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('new project can create a missing directory', async ({ page }) => {
  // A nested path that does NOT exist yet.
  const target = path.join(os.tmpdir(), `ateam-createdir-${Date.now()}`, 'nested', 'repo');
  expect(fs.existsSync(target)).toBe(false);

  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('Fresh Repo');
  await page.getByTestId('project-repo').fill(target);
  await page.getByTestId('project-createdir').check();
  await page.getByTestId('project-submit').click();

  // On success we navigate into the new project's agents view.
  await page.getByTestId('add-agent').waitFor();
  expect(fs.statSync(target).isDirectory()).toBe(true);
  fs.rmSync(path.join(os.tmpdir(), path.basename(path.dirname(path.dirname(target)))), {
    recursive: true,
    force: true,
  });
});

test('missing directory without the option shows an error and auto-ticks the box', async ({
  page,
}) => {
  const target = path.join(os.tmpdir(), `ateam-nocreate-${Date.now()}`, 'repo');
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill('No Create');
  await page.getByTestId('project-repo').fill(target);
  await page.getByTestId('project-submit').click();

  // Error surfaced, checkbox auto-enabled, folder NOT created.
  await expect(page.getByText(/doesn.t exist yet/i)).toBeVisible();
  await expect(page.getByTestId('project-createdir')).toBeChecked();
  expect(fs.existsSync(target)).toBe(false);
});
