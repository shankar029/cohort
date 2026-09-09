import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RealCopilotAdapter } from '../../src/server/agents/realAdapter.js';
import type { SessionEvent } from '../../src/server/agents/adapter.js';

/**
 * Opt-in smoke test for the REAL @github/copilot-sdk path (per-agent session).
 * Skipped unless ATEAM_LIVE=1. Run: ATEAM_LIVE=1 npx vitest run tests/live
 */
const LIVE = process.env.ATEAM_LIVE === '1';
const MODEL = process.env.ATEAM_LIVE_MODEL ?? 'auto';

describe.skipIf(!LIVE)('RealCopilotAdapter (live)', () => {
  it('creates a real agent session and gets a streamed reply', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-live-'));
    const adapter = new RealCopilotAdapter();
    const events: SessionEvent[] = [];

    const session = await adapter.createAgentSession({
      projectId: 'live',
      agentId: 'lead',
      agentName: 'team-lead',
      displayName: 'Team Lead',
      role: 'lead',
      persona: 'You are a concise Team Lead. Answer in one short sentence.',
      model: MODEL,
      tools: null,
      skills: [],
      workingDirectory: repoDir,
      skillDirectories: [],
      disabledSkills: [],
      approvalMode: 'auto-workspace',
      onEvent: (e: SessionEvent) => events.push(e),
      onPermission: async () => 'approve',
      onUserInput: async () => 'yes',
    });

    const text = await session.ask('Reply with exactly: ateam live check ok', 'live-msg-1');
    await session.dispose();
    await adapter.shutdown();

    expect(text.length, 'expected a non-empty final reply').toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'idle')).toBe(true);

    fs.rmSync(repoDir, { recursive: true, force: true });
  }, 120_000);
});
