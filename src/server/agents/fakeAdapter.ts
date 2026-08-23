import type { AgentSession, AgentSessionConfig, CopilotAdapter, SessionEvent } from './adapter.js';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const TICK = Number(process.env.ATEAM_FAKE_TICK ?? 2);

/**
 * Deterministic, offline stand-in for a single agent's Copilot session. Replies
 * are role-aware and honor markers embedded in the prompt so every branch
 * (discussion, escalation, permission-gated write, group-chat request) can be
 * driven from tests and Playwright E2E without an LLM:
 *   [[ASK]]              → the agent asks a question; the Team Lead resolves it
 *   [[ASK_USER]]         → the agent asks a question the Lead escalates to the user
 *   [[WRITE]]            → the agent requests a file-write permission
 *   [[NEEDS_DISCUSSION]] → the agent asks the Lead to open a group chat
 *   [[POST: text]]       → the agent posts a message to the team via its app tools
 *   [[NOTE: text]]       → the agent appends a note to its scratchpad
 *   [[PLAN: text]]       → the agent updates its living plan
 *   [[REVIEW: iteration=N]] → reviewer verdict: request changes on iter 1, approve after
 *   [[NOOP]]             → the agent narrates but writes no files (empty build)
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
      const posted = /\[\[POST:\s*([^\]]+)\]\]/.exec(prompt);
      if (posted) {
        app.postMessage({ content: posted[1]!.trim() });
        onEvent({ kind: 'tool_call', toolName: 'post_message', detail: {} });
      }
      const noted = /\[\[NOTE:\s*([^\]]+)\]\]/.exec(prompt);
      if (noted) {
        app.writeNote({ content: noted[1]!.trim() });
        onEvent({ kind: 'tool_call', toolName: 'write_note', detail: {} });
      }
      const planned = /\[\[PLAN:\s*([^\]]+)\]\]/.exec(prompt);
      if (planned) {
        app.updatePlan({ content: planned[1]!.trim() });
        onEvent({ kind: 'tool_call', toolName: 'update_plan', detail: {} });
      }
      const progressed = /\[\[PROGRESS:\s*(\d+)\]\]/.exec(prompt);
      if (progressed) {
        app.updateProgress({ progress: Number(progressed[1]), note: 'milestone reached' });
        onEvent({ kind: 'tool_call', toolName: 'update_progress', detail: {} });
      }
      // [[REVIEW_COMMENT: stream | body]] — a reviewer files a routed PR comment.
      // Read from the persona so a test reviewer files it on every review round;
      // the orchestrator dedupes by body so the loop still converges.
      const rc = /\[\[REVIEW_COMMENT:\s*([^|\]]+)\|([^\]]+)\]\]/.exec(this.config.persona);
      if (rc && /review/i.test(prompt)) {
        app.addReviewComment({ targetStream: rc[1]!.trim(), body: rc[2]!.trim() });
        onEvent({ kind: 'tool_call', toolName: 'add_review_comment', detail: {} });
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

    // Faithful build behavior: when the Lead assigns a task, a real agent writes
    // real files into its working directory. Do the same so the orchestrator's
    // "did this task produce deliverable changes?" gate is exercised for real.
    // `[[NOOP]]` (in prompt or persona) simulates an agent that narrates but
    // produces nothing, so the empty-build repair/escalation path is testable.
    if (
      /assigned you this task/i.test(prompt) &&
      !/\[\[NOOP\]\]/.test(prompt + this.config.persona)
    ) {
      try {
        const safeAgent = this.config.agentName.replace(/[^a-z0-9_-]/gi, '') || 'agent';
        const rel = path.join('deliverables', `${safeAgent}-${messageId}.md`);
        const abs = path.join(this.config.workingDirectory, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `# ${this.config.displayName} deliverable\n\n${summarize(prompt)}\n`);
        onEvent({ kind: 'tool_call', toolName: 'edit_file', detail: { file: rel } });
      } catch {
        /* best-effort: cwd may not exist for non-epic asks */
      }
    }

    let extra = '';
    const askUser = /\[\[ASK_USER\]\]/.test(prompt);
    if (askUser || /\[\[ASK\]\]/.test(prompt)) {
      const answer = await this.config.onUserInput({
        question: askUser
          ? `Which approach should the ${displayName} take? (needs user decision)`
          : `Which approach should the ${displayName} take?`,
        choices: ['Option A', 'Option B'],
      });
      extra = ` I'll proceed with: ${answer}.`;
    }

    let text: string;
    const review = /\[\[REVIEW:\s*iteration=(\d+)\]\]/.exec(prompt);
    if (review) {
      const iter = Number(review[1]);
      text =
        iter >= 2
          ? `Reviewed the diff; correctness and tests look good. [[APPROVE]]`
          : `Reviewed the diff; needs coverage before merge. [[REQUEST_CHANGES: add tests for edge cases]]`;
    } else if (role === 'lead') {
      // When resolving a specialist's blocking question, defer to the user only
      // when the question explicitly needs a human decision; otherwise decide.
      if (/needs a decision to continue/i.test(prompt) && /needs user decision/i.test(prompt)) {
        text = `ESCALATE: The team needs your call. ${summarize(prompt)}`;
      } else {
        text = `Here's my read as Team Lead: ${summarize(prompt)}.${extra}`;
      }
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
