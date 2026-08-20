import type { AgentSession, AgentSessionConfig, CopilotAdapter, PermissionAsk } from './adapter.js';
import { execFile } from 'node:child_process';

/**
 * Real adapter backed by @github/copilot-sdk. Each agent gets its OWN session
 * (independent actor), so agents run concurrently and the orchestrator routes
 * their messages between the main thread and group chats.
 *
 * The SDK is imported lazily so the Fake adapter (tests / offline) never loads it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

// Tool each agent uses to maintain its own visible task board.
const TASK_TOOL = 'update_task_board';

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32' ? ['/c', command] : ['-c', command],
      { cwd, timeout: timeoutMs, windowsHide: true },
      (err) => resolve(!err),
    );
  });
}

class RealAgentSession implements AgentSession {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly session: AnySdk,
    private readonly config: AgentSessionConfig,
  ) {}

  ask(prompt: string, messageId: string): Promise<string> {
    // Serialize turns for THIS agent; a failed turn never poisons the chain.
    const turn = this.queue.then(
      () => this.runTurn(prompt, messageId),
      () => this.runTurn(prompt, messageId),
    );
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private runTurn(prompt: string, messageId: string): Promise<string> {
    const { onEvent } = this.config;
    return new Promise<string>((resolve) => {
      const offs: Array<() => void> = [];
      let settled = false;
      let final = '';
      let buffer = '';
      const cleanup = (): void => {
        for (const off of offs) {
          try {
            off?.();
          } catch {
            /* best-effort */
          }
        }
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(safety);
        if (!final && buffer.trim()) {
          final = buffer;
          onEvent({ kind: 'message', messageId, text: buffer });
        }
        cleanup();
        resolve(final);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        final = `⚠️ ${this.config.displayName} run failed: ${err instanceof Error ? err.message : String(err)}`;
        onEvent({ kind: 'message', messageId, text: final });
        onEvent({ kind: 'idle' });
        finish();
      };

      const safety = setTimeout(() => finish(), 15 * 60_000);
      safety.unref?.();

      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('assistant.message_delta', (e: any) => {
          if (e?.data?.deltaContent) {
            buffer += String(e.data.deltaContent);
            onEvent({ kind: 'delta', messageId, delta: String(e.data.deltaContent) });
          }
        }),
      );
      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('assistant.message', (e: any) => {
          if (e?.data?.content) {
            final = String(e.data.content);
            onEvent({ kind: 'message', messageId, text: final });
          }
        }),
      );
      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('assistant.reasoning', (e: any) => {
          if (e?.data?.content) onEvent({ kind: 'reasoning', text: String(e.data.content) });
        }),
      );
      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('tool.execution_start', (e: any) => {
          onEvent({
            kind: 'tool_call',
            toolName: String(e?.data?.toolName ?? e?.data?.name ?? 'tool'),
            detail: e?.data?.arguments ?? e?.data?.args,
          });
        }),
      );
      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('tool.execution_complete', (e: any) => {
          onEvent({
            kind: 'tool_result',
            toolName: String(e?.data?.toolName ?? e?.data?.name ?? 'tool'),
            detail: { status: e?.data?.status },
          });
        }),
      );
      offs.push(
        this.session.on('session.idle', () => {
          onEvent({ kind: 'idle' });
          finish();
        }),
      );

      Promise.resolve(this.session.send({ prompt })).catch((err: unknown) => fail(err));
    });
  }

  async dispose(): Promise<void> {
    await this.session.disconnect?.();
  }
}

export class RealCopilotAdapter implements CopilotAdapter {
  readonly name = 'copilot-sdk';
  private client: AnySdk | null = null;
  private sdk: AnySdk | null = null;

  private async ensureClient(): Promise<AnySdk> {
    if (this.client) return this.client;
    const sdk = (await import('@github/copilot-sdk')) as AnySdk;
    this.sdk = sdk;
    const client = new sdk.CopilotClient();
    await client.start();
    this.client = client;
    return client;
  }

  async createAgentSession(config: AgentSessionConfig): Promise<AgentSession> {
    const client = await this.ensureClient();
    const sdk = this.sdk;

    const taskTool = sdk.defineTool(TASK_TOOL, {
      description:
        'Update your personal task board so the user can see your progress. Call this when you start, work on, or finish a step.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        },
        required: ['title', 'status'],
      },
      skipPermission: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        config.onEvent({
          kind: 'tool_result',
          toolName: TASK_TOOL,
          detail: { title: String(args.title), status: String(args.status) },
        });
        return { ok: true };
      },
    });

    const sleep = (ms: number): Promise<void> =>
      config.scheduler
        ? config.scheduler.sleep(ms, config.projectId)
        : new Promise((r) => setTimeout(r, ms));

    // Lets an agent wait/retry after a delay.
    const waitTool = sdk.defineTool('wait', {
      description:
        'Pause for a number of seconds before continuing — use to wait-and-retry or let an async operation settle. Capped at 300s.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number' }, reason: { type: 'string' } },
        required: ['seconds'],
      },
      skipPermission: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const seconds = Math.max(0, Math.min(300, Number(args.seconds) || 0));
        config.onEvent({
          kind: 'tool_call',
          toolName: 'wait',
          detail: { seconds, reason: args.reason },
        });
        await sleep(seconds * 1000);
        return { waited: seconds };
      },
    });

    // Lets an agent poll a shell check until it passes (e.g. wait for a server/file/event).
    const pollTool = sdk.defineTool('poll', {
      description:
        'Repeatedly run a shell command every intervalSeconds until it exits 0 (condition met) or timeoutSeconds elapses. Returns whether the condition was met.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          intervalSeconds: { type: 'number' },
          timeoutSeconds: { type: 'number' },
        },
        required: ['command'],
      },
      skipPermission: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const interval = Math.max(1, Math.min(60, Number(args.intervalSeconds) || 3)) * 1000;
        const timeout = Math.max(1, Math.min(600, Number(args.timeoutSeconds) || 60)) * 1000;
        const command = String(args.command);
        config.onEvent({
          kind: 'tool_call',
          toolName: 'poll',
          detail: { command, interval, timeout },
        });
        const deadline = Date.now() + timeout;
        let met = await runOnce(command, config.workingDirectory, interval);
        while (!met && Date.now() < deadline) {
          await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
          met = await runOnce(command, config.workingDirectory, interval);
        }
        config.onEvent({ kind: 'tool_result', toolName: 'poll', detail: { met } });
        return { met };
      },
    });

    const session = await client.createSession({
      model: config.model,
      workingDirectory: config.workingDirectory,
      streaming: true,
      tools: [taskTool, waitTool, pollTool],
      skillDirectories: config.skillDirectories,
      systemMessage: { content: config.persona },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onPermissionRequest: async (request: any): Promise<any> => {
        const ask: PermissionAsk = {
          kind: request?.kind ?? 'custom-tool',
          toolName: request?.toolName,
          fileName: request?.fileName,
          command: request?.fullCommandText,
        };
        const reply = await config.onPermission(ask);
        return reply === 'approve' ? { kind: 'approve-once' } : { kind: 'reject' };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onUserInputRequest: async (request: any) => {
        const answer = await config.onUserInput({
          question: String(request?.question ?? 'The agent needs your input.'),
          choices: request?.choices,
        });
        return { answer, wasFreeform: true };
      },
    });

    return new RealAgentSession(session, config);
  }

  async listModels(): Promise<string[]> {
    const client = await this.ensureClient();
    const models = (await client.listModels?.()) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return models.map((m: any) => (typeof m === 'string' ? m : (m.id ?? m.name))).filter(Boolean);
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.stop?.();
      this.client = null;
    }
  }
}
