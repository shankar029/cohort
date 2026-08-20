import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RealCopilotAdapter } from '../../src/server/agents/realAdapter.js';
import type { AdapterEvent } from '../../src/server/agents/adapter.js';

/**
 * Opt-in smoke test for the REAL @github/copilot-sdk path. Requires a working,
 * authenticated Copilot CLI. Skipped unless ATEAM_LIVE=1 so normal CI/offline
 * runs stay deterministic. Run with:  ATEAM_LIVE=1 npx vitest run tests/live
 */
const LIVE = process.env.ATEAM_LIVE === '1';
const MODEL = process.env.ATEAM_LIVE_MODEL ?? 'auto';

describe.skipIf(!LIVE)('RealCopilotAdapter (live)', () => {
  it('creates a real team session and gets a streamed reply from the Team Lead', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-live-'));
    const adapter = new RealCopilotAdapter();
    const events: AdapterEvent[] = [];

    const session = await adapter.createTeamSession({
      projectId: 'live',
      workingDirectory: repoDir,
      leadName: 'team-lead',
      leadDisplayName: 'Team Lead',
      leadModel: MODEL,
      leadPrompt: 'You are a concise Team Lead. Answer in one short sentence.',
      specialists: [],
      skillDirectories: [],
      approvalMode: 'auto-workspace',
      onEvent: (e) => events.push(e),
      onPermission: async () => 'approve',
      onUserInput: async () => 'yes',
    });

    await session.send('Reply with exactly: ateam live check ok', 'live-msg-1');
    await session.dispose();
    await adapter.shutdown();

    const finalMessage = events.find((e) => e.kind === 'lead_message');
    expect(finalMessage, 'expected a final lead_message event').toBeTruthy();
    expect(events.some((e) => e.kind === 'idle')).toBe(true);

    fs.rmSync(repoDir, { recursive: true, force: true });
  }, 120_000);
});
