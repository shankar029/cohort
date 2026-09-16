import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Create a real local git repo with one commit; returns its absolute path. */
function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-e2e-src-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
  return dir;
}

test('New Project modal offers Local vs Import tabs (AC2.3)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-project').click();

  // Local tab is the default: repo-dir field is shown, URL field is not.
  await expect(page.getByTestId('project-repo')).toBeVisible();
  await expect(page.getByTestId('project-url')).toHaveCount(0);

  // Switch to Import: URL + parent-folder inputs appear.
  await page.getByTestId('project-tab-import').click();
  await expect(page.getByTestId('project-url')).toBeVisible();
  await expect(page.getByTestId('project-parent')).toBeVisible();
  await expect(page.getByTestId('project-repo')).toHaveCount(0);
});

test('Import rejects a malformed URL with a clear inline error (AC2.1)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-tab-import').click();
  await page.getByTestId('project-url').fill('not-a-git-url');
  await page.getByTestId('project-parent').fill(os.tmpdir());
  await page.getByTestId('project-submit').click();

  await expect(page.getByText(/valid git URL/i)).toBeVisible();
  // Still on the modal (no navigation) — project not created.
  await expect(page.getByTestId('project-submit')).toBeVisible();
});

test('Import clones a git URL and opens the new project (AC2)', async ({ page }) => {
  const src = makeFixtureRepo();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-e2e-parent-'));
  try {
    await page.goto('/');
    await page.getByTestId('new-project').click();
    await page.getByTestId('project-tab-import').click();
    await page.getByTestId('project-url').fill(pathToFileURL(src).href);
    await page.getByTestId('project-parent').fill(parent);
    await page.getByTestId('project-submit').click();

    // On success we navigate into the new project's agents view.
    await page.getByTestId('add-agent').waitFor();

    // The repo was cloned into <parent>/<repoName>.
    const cloned = path.join(parent, path.basename(src));
    expect(fs.existsSync(path.join(cloned, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(cloned, 'README.md'))).toBe(true);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
