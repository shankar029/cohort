import type { AdapterEvent, CopilotAdapter, TeamSession, TeamSessionConfig } from './adapter.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Small deterministic tick so streaming feels real without slowing tests. */
const TICK = Number(process.env.ATEAM_FAKE_TICK ?? 4);

function extractDelegateTarget(prompt: string): string | null {
  const m =
    prompt.match(/delegate[^`]*`([a-z0-9-]+)`/i) ??
    prompt.match(/agent named `([a-z0-9-]+)`/i) ??
    prompt.match(/specialist `([a-z0-9-]+)`/i);
  return m ? m[1]! : null;
}

/**
 * Deterministic, offline stand-in for the Copilot runtime. It parses the
 * orchestrator's prompt for a delegation directive and an escalation marker
 * (`[[ASK]]`) so every branch (delegate, tool-use, task-board, escalation,
 * permission) can be driven from tests and Playwright E2E without an LLM.
 */
class FakeTeamSession implements TeamSession {
  private aborted = false;

  constructor(private readonly config: TeamSessionConfig) {}

  async send(prompt: string, messageId: string): Promise<void> {
    this.aborted = false;
    const { onEvent, specialists } = this.config;

    const targetName = extractDelegateTarget(prompt);
    const target = targetName ? specialists.find((s) => s.name === targetName) : undefined;
    const wantsAsk = /\[\[ASK\]\]/.test(prompt);

    const lead = (text: string): Promise<void> => this.stream(messageId, text, onEvent);

    if (!target) {
      // Plain conversational reply from the Team Lead — no delegation.
      await lead(
        specialists.length === 0
          ? `I'm your Team Lead. Add specialists to your team and I'll delegate work to them.`
          : `I'm your Team Lead. I can delegate to: ${specialists.map((s) => s.displayName).join(', ')}. What should we build?`,
      );
      onEvent({ kind: 'idle' });
      return;
    }

    // Delegation path.
    onEvent({
      kind: 'subagent_started',
      agentName: target.name,
      displayName: target.displayName,
      description: target.description,
    });
    await sleep(TICK);
    if (this.aborted) return this.finishAborted(onEvent);

    onEvent({
      kind: 'task_update',
      agentName: target.name,
      title: `Analyze request`,
      status: 'doing',
    });
    onEvent({
      kind: 'reasoning',
      agentName: target.name,
      text: `Planning the ${target.displayName} work.`,
    });
    await sleep(TICK);

    // Permission-gated tool use.
    const decision = await this.config.onPermission({
      kind: 'write',
      agentName: target.name,
      toolName: 'edit_file',
      fileName: 'src/example.ts',
    });
    if (decision === 'reject') {
      onEvent({
        kind: 'subagent_failed',
        agentName: target.name,
        displayName: target.displayName,
        error: 'Write permission denied.',
      });
      await lead(
        `The ${target.displayName} could not complete the task because file writes were denied.`,
      );
      onEvent({ kind: 'idle' });
      return;
    }

    onEvent({
      kind: 'tool_call',
      agentName: target.name,
      toolName: 'edit_file',
      detail: { file: 'src/example.ts' },
    });
    await sleep(TICK);
    onEvent({
      kind: 'tool_result',
      agentName: target.name,
      toolName: 'edit_file',
      detail: { ok: true },
    });
    onEvent({
      kind: 'task_update',
      agentName: target.name,
      title: `Analyze request`,
      status: 'done',
    });

    if (wantsAsk) {
      onEvent({
        kind: 'task_update',
        agentName: target.name,
        title: `Awaiting clarification`,
        status: 'doing',
      });
      const answer = await this.config.onUserInput({
        agentName: target.name,
        question: `Which approach should the ${target.displayName} take?`,
        choices: ['Option A', 'Option B'],
      });
      onEvent({ kind: 'reasoning', agentName: target.name, text: `Proceeding with: ${answer}` });
      onEvent({
        kind: 'task_update',
        agentName: target.name,
        title: `Awaiting clarification`,
        status: 'done',
      });
      await sleep(TICK);
    }

    onEvent({
      kind: 'task_update',
      agentName: target.name,
      title: `Finalize work`,
      status: 'done',
    });
    onEvent({
      kind: 'subagent_completed',
      agentName: target.name,
      displayName: target.displayName,
      detail: { totalToolCalls: 1 },
    });
    await lead(`The ${target.displayName} finished the task. Work is ready for review.`);
    onEvent({ kind: 'idle' });
  }

  private async stream(
    messageId: string,
    text: string,
    onEvent: (e: AdapterEvent) => void,
  ): Promise<void> {
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (this.aborted) break;
      onEvent({ kind: 'lead_delta', messageId, delta: (i === 0 ? '' : ' ') + words[i]! });
      await sleep(TICK);
    }
    onEvent({ kind: 'lead_message', messageId, text });
  }

  private finishAborted(onEvent: (e: AdapterEvent) => void): void {
    onEvent({ kind: 'idle' });
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async dispose(): Promise<void> {
    this.aborted = true;
  }
}

export class FakeCopilotAdapter implements CopilotAdapter {
  readonly name = 'fake';

  async createTeamSession(config: TeamSessionConfig): Promise<TeamSession> {
    return new FakeTeamSession(config);
  }

  async listModels(): Promise<string[]> {
    return [
      'auto',
      'claude-sonnet-4.5',
      'claude-opus-4.5',
      'gpt-5',
      'gpt-5-mini',
      'gemini-2.5-pro',
    ];
  }

  async shutdown(): Promise<void> {
    /* nothing to release */
  }
}
