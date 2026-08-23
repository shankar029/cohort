import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Each test works against a fresh on-disk repo directory the server can validate. */
function makeRepoDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-e2e-'));
}

async function createProject(page: import('@playwright/test').Page, name: string): Promise<void> {
  const repoDir = makeRepoDir();
  await page.goto('/');
  await page.getByTestId('new-project').click();
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-repo').fill(repoDir);
  await page.getByTestId('project-submit').click();
  // Lands on the Agents page for the new project.
  await expect(page.getByTestId('add-agent')).toBeVisible();
}

async function addSpecialist(
  page: import('@playwright/test').Page,
  catalogId: string,
): Promise<void> {
  await page.getByTestId('add-agent').click();
  await page.getByTestId(`add-catalog-${catalogId}`).click();
  await expect(page.getByTestId(`added-${catalogId}`)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('agent-list')).toBeVisible();
}

test('end-to-end: build a team, assign work, watch autonomous pickup, tasks and logs', async ({
  page,
}) => {
  await createProject(page, 'E2E Delivery');
  await addSpecialist(page, 'frontend-engineer');
  await expect(page.getByTestId('agent-list')).toContainText('Frontend Engineer');

  // Go to the board and create an assigned work item.
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await page.getByTestId('add-workitem').click();
  await page.getByTestId('workitem-title').fill('Build the login screen');
  await page.getByTestId('workitem-assignee').selectOption({ label: '🖥️ Frontend Engineer' });
  await page.getByTestId('workitem-submit').click();

  // The assigned agent auto-picks it up and it advances to Review.
  await expect(page.getByTestId('column-review')).toContainText('Build the login screen', {
    timeout: 20000,
  });

  // The agent maintained a personal task board.
  await page.getByRole('link', { name: 'Agents' }).click();
  await page.getByTestId('agent-card').filter({ hasText: 'Frontend Engineer' }).click();
  await expect(page.getByTestId('task-board')).toBeVisible();
  await expect(page.getByTestId('task-card').first()).toBeVisible();

  // Activity log shows the sub-agent lifecycle.
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByTestId('activity-log')).toContainText('Frontend Engineer');
});

test('chat: a build request becomes an epic and a specialist contributes', async ({ page }) => {
  await createProject(page, 'E2E Chat');
  await addSpecialist(page, 'frontend-engineer');

  await page.getByRole('link', { name: 'Chat' }).click();
  await page.getByTestId('chat-input').fill('Please build the header component.');
  await page.getByTestId('chat-send').click();

  // The Team Lead responds…
  await expect(page.getByTestId('lead-message').last()).toBeVisible({ timeout: 20000 });
  // …and the assigned specialist contributes as itself while working the decomposed task.
  await expect(page.getByTestId('agent-message').first()).toContainText('Frontend Engineer', {
    timeout: 20000,
  });
});

test('pull requests: a completed epic raises a PR that merges', async ({ page }) => {
  await createProject(page, 'E2E PR');
  await addSpecialist(page, 'frontend-engineer');
  await addSpecialist(page, 'qa-engineer');

  await page.getByRole('link', { name: 'Chat' }).click();
  await page.getByTestId('chat-input').fill('Please build a profile page.');
  await page.getByTestId('chat-send').click();

  await page.getByRole('link', { name: 'Pull Requests' }).click();
  // A PR card appears and reaches the merged state after review.
  await expect(page.getByTestId('pr-card').first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('pr-card').first()).toContainText('Merged', { timeout: 30000 });
});

test('escalation: a specialist question is surfaced and answering resumes the work', async ({
  page,
}) => {
  await createProject(page, 'E2E Escalation');
  await addSpecialist(page, 'backend-engineer');

  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await page.getByTestId('add-workitem').click();
  await page.getByTestId('workitem-title').fill('Ambiguous API [[ASK_USER]]');
  await page.getByTestId('workitem-assignee').selectOption({ label: '⚙️ Backend Engineer' });
  await page.getByTestId('workitem-submit').click();

  // The escalation appears on the Chat page.
  await page.getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByTestId('question-card')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('question-choice').first().click();

  // After answering, the work reaches Review.
  await page.getByRole('link', { name: 'Board', exact: true }).click();
  await expect(page.getByTestId('column-review')).toContainText('Ambiguous API', {
    timeout: 20000,
  });
});
