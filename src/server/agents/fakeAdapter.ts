import type { AgentSession, AgentSessionConfig, CopilotAdapter, SessionEvent } from './adapter.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TICK = Number(process.env.ATEAM_FAKE_TICK ?? 2);

/**
 * Deterministic, offline stand-in for a single agent's Copilot session. Replies
 * are role-aware and honor markers embedded in the prompt so every branch
 * (discussion, escalation, permission-gated write, group-chat request) can be
 * driven from tests and Playwright E2E without an LLM:
 *   [[ASK]]              → the agent escalates a question to the user
 *   [[WRITE]]            → the agent requests a file-write permission
 *   [[NEEDS_DISCUSSION]] → the agent asks the Lead to open a group chat
 *   [[CREATE_TASK: t]]   → the agent creates a board work item via its app tools
 *   [[POST: text]]       → the agent posts a message to the team via its app tools
 */
class FakeAgentSession implements AgentSession {
  constructor(private readonly config: AgentSessionConfig) {}

  async ask(prompt: string, messageId: string): Promise<string> {
    const { onEvent, displayName, role } = this.config;

    onEvent({ kind: 'reasoning', text: `Considering: ${prompt.slice(0, 60)}` });
    await sleep(TICK);

    // Exercise agent app tools (board + chat) when markers are present.
    const app = this.config.appTools;
    if (app) {
      const created = /\[\[CREATE_TASK:\s*([^\]]+)\]\]/.exec(prompt);
      if (created) {
        const res = app.createWorkItem({ title: created[1]!.trim() });
        onEvent({ kind: 'tool_call', toolName: 'create_work_item', detail: res });
      }
      const posted = /\[\[POST:\s*([^\]]+)\]\]/.exec(prompt);
      if (posted) {
        app.postMessage({ content: posted[1]!.trim() });
        onEvent({ kind: 'tool_call', toolName: 'post_message', detail: {} });
      }
    }

    if (/\[\[WRITE\]\]/.test(prompt)) {
      const decision = await this.config.onPermission({
        kind: 'write',
        toolName: 'edit_file',
        fileName: 'src/example.ts',
      });
      if (decision === 'approve') {
        onEvent({ kind: 'tool_call', toolName: 'edit_file', detail: { file: 'src/example.ts' } });
        await sleep(TICK);
        onEvent({ kind: 'tool_result', toolName: 'edit_file', detail: { ok: true } });
      }
    }

    let extra = '';
    if (/\[\[ASK\]\]/.test(prompt)) {
      const answer = await this.config.onUserInput({
        question: `Which approach should the ${displayName} take?`,
        choices: ['Option A', 'Option B'],
      });
      extra = ` I'll proceed with: ${answer}.`;
    }

    let text: string;
    if (role === 'lead') {
      text = `Here's my read as Team Lead: ${summarize(prompt)}.${extra}`;
    } else {
      text = `As the ${displayName}, my recommendation: ${idea(displayName, prompt)}.${extra}`;
      if (/\[\[NEEDS_DISCUSSION\]\]/.test(prompt)) {
        text += ` [[REQUEST_GROUPCHAT: ${topicOf(prompt)}]]`;
      }
    }

    await this.stream(messageId, text, onEvent);
    onEvent({ kind: 'idle' });
    return text;
  }

  private async stream(
    messageId: string,
    text: string,
    onEvent: (e: SessionEvent) => void,
  ): Promise<void> {
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      onEvent({ kind: 'delta', messageId, delta: (i === 0 ? '' : ' ') + words[i]! });
      await sleep(TICK);
    }
    onEvent({ kind: 'message', messageId, text });
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

function summarize(prompt: string): string {
  const first = prompt.split('\n').find((l) => l.trim().length > 0) ?? prompt;
  return (
    first
      .replace(/\[\[[^\]]+\]\]/g, '')
      .trim()
      .slice(0, 80) || 'let me coordinate the team'
  );
}

function topicOf(prompt: string): string {
  return summarize(prompt).slice(0, 40);
}

/** A short, role-flavored contribution so brainstorms read like a real discussion. */
function idea(displayName: string, prompt: string): string {
  const topic = summarize(prompt);
  const byRole: Record<string, string> = {
    'Product Manager': `clarify the user outcome and success metric for "${topic}"`,
    'UX Designer': `sketch the primary flow and keep the UI low-friction for "${topic}"`,
    'Frontend Engineer': `build accessible components with tests for "${topic}"`,
    'Backend Engineer': `expose a validated API with error handling for "${topic}"`,
    'QA Engineer': `cover happy path + edge cases with automated tests for "${topic}"`,
    'Code Reviewer': `gate the change on correctness, security, and test quality`,
  };
  return byRole[displayName] ?? `apply ${displayName} best practices to "${topic}"`;
}

export class FakeCopilotAdapter implements CopilotAdapter {
  readonly name = 'fake';

  async createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new FakeAgentSession(config);
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
