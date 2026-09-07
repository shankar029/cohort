import type { AgentSession, AgentSessionConfig, CopilotAdapter, PermissionAsk } from './adapter.js';
import { execFile } from 'node:child_process';
import { deniedBuiltinTools } from './toolPolicy.js';
import { probeApp } from '../appProbe.js';

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
        // Per-model-call token usage (input/output tokens, api-call duration).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('assistant.usage', (e: any) => {
          const d = e?.data ?? {};
          onEvent({
            kind: 'usage',
            inputTokens: Number(d.inputTokens ?? 0) || 0,
            outputTokens: Number(d.outputTokens ?? 0) || 0,
            model: String(d.model ?? ''),
            durationMs: Number(d.duration ?? 0) || 0,
          });
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
          const d = e?.data ?? {};
          const result = d.result ?? {};
          const output = typeof result.content === 'string' ? result.content : undefined;
          onEvent({
            kind: 'tool_result',
            toolName: String(d.toolName ?? d.name ?? 'tool'),
            detail: {
              success: d.success !== false,
              ...(output !== undefined ? { output: output.slice(0, 4000) } : {}),
              ...(d.error?.message ? { error: String(d.error.message).slice(0, 1000) } : {}),
              ...(d.toolTelemetry ? { telemetry: d.toolTelemetry } : {}),
            },
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

    // App tools: let the agent act as a first-class user of the board and chat.
    const app = config.appTools;
    const appTools = app
      ? [
          sdk.defineTool('update_progress', {
            description:
              'Update the completion percentage (0-100) of the work item you are currently on. Keep it current as you make progress so the user and teammates can track it; pass a short note describing the milestone.',
            parameters: {
              type: 'object',
              properties: {
                progress: { type: 'number' },
                workItemId: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['progress'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => app.updateProgress(args),
          }),
          sdk.defineTool('post_message', {
            description:
              'Post a message to the team as yourself. Defaults to the main thread; pass threadId to post in a specific discussion.',
            parameters: {
              type: 'object',
              properties: { content: { type: 'string' }, threadId: { type: 'string' } },
              required: ['content'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => app.postMessage(args),
          }),
          sdk.defineTool('request_group_chat', {
            description:
              'Ask the Team Lead to convene a group chat / brainstorm on a topic with the right teammates.',
            parameters: {
              type: 'object',
              properties: { topic: { type: 'string' } },
              required: ['topic'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => app.requestGroupChat(args),
          }),
          sdk.defineTool('add_review_comment', {
            description:
              'While reviewing a pull request, file a specific, addressable comment and route it to the responsible stream (e.g. frontend, backend, qa). The Team Lead turns each comment into a fix task; the PR is not approved until every comment is resolved.',
            parameters: {
              type: 'object',
              properties: {
                body: { type: 'string' },
                targetStream: { type: 'string' },
              },
              required: ['body'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => app.addReviewComment(args),
          }),
          sdk.defineTool('write_note', {
            description:
              'Append a short note to your personal scratchpad (observations, findings, decisions). Optionally attach a workItemId.',
            parameters: {
              type: 'object',
              properties: { content: { type: 'string' }, workItemId: { type: 'string' } },
              required: ['content'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => app.writeNote(args),
          }),
          sdk.defineTool('update_plan', {
            description:
              'Replace your living plan / checklist (markdown). Keep it current as you work so teammates can see your approach and progress.',
            parameters: {
              type: 'object',
              properties: { content: { type: 'string' } },
              required: ['content'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => app.updatePlan(args),
          }),
          sdk.defineTool('list_board', {
            description:
              'List the current project board (work items with status, stream, assignee).',
            parameters: { type: 'object', properties: {} },
            skipPermission: true,
            handler: async () => app.listBoard(),
          }),
        ]
      : [];

    // Boot-and-probe an app WITHOUT hanging the turn on a blocking start command.
    // Only for agents that may run shell (builders/QA) - the Lead and read-only
    // roles never execute. The server is always torn down before this returns.
    const canShell = config.role === 'specialist' && (config.tools === null || config.tools.includes('bash'));
    const probeTools = canShell
      ? [
          sdk.defineTool('probe_app', {
            description:
              'Boot an app/server in the BACKGROUND, wait until it is ready, run probe commands ' +
              'against it, then stop it - all in one call. Use this to verify a running app instead ' +
              'of executing a blocking start command yourself (which would hang your turn). The ' +
              'process is ALWAYS torn down before this returns, so it never leaks. Prefer launching ' +
              '`node <entryFile>` directly over `npm start`.',
            parameters: {
              type: 'object',
              properties: {
                startCommand: { type: 'string', description: 'e.g. `node server.js`' },
                env: { type: 'object', description: 'Extra env vars, e.g. { "PORT": "3000" }' },
                readyUrl: {
                  type: 'string',
                  description: 'HTTP URL polled until it responds (any status = listening).',
                },
                readyCommand: {
                  type: 'string',
                  description: 'Shell command polled until exit 0 (alternative readiness signal).',
                },
                probeCommands: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Commands run once ready, e.g. curl checks; each output captured.',
                },
                timeoutSeconds: { type: 'number' },
              },
              required: ['startCommand'],
            },
            skipPermission: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: async (args: any) => {
              config.onEvent({
                kind: 'tool_call',
                toolName: 'probe_app',
                detail: { startCommand: String(args.startCommand) },
              });
              const res = await probeApp({
                startCommand: String(args.startCommand),
                cwd: config.workingDirectory,
                env: args.env,
                readyUrl: args.readyUrl,
                readyCommand: args.readyCommand,
                probeCommands: Array.isArray(args.probeCommands) ? args.probeCommands.map(String) : [],
                timeoutSeconds: args.timeoutSeconds,
              });
              config.onEvent({
                kind: 'tool_result',
                toolName: 'probe_app',
                detail: { booted: res.booted, ready: res.ready, probes: res.probes.length },
              });
              return res;
            },
          }),
        ]
      : [];

    const session = await client.createSession({
      model: config.model,
      workingDirectory: config.workingDirectory,
      streaming: true,
      tools: [taskTool, waitTool, pollTool, ...probeTools, ...appTools],
      // The Copilot runtime ships built-in tools an agent can reach for on its own.
      // The `sql` session-store tool (a sandbox todos/history DB) is NOT our board:
      // an agent that grabs it hand-builds a phantom task list disconnected from
      // ateam and can rat-hole on FK errors. The board is materialized in code, so
      // no agent ever needs raw SQL — exclude it. (Bare name matches any source.)
      // Enforce the catalog's tool allowlist at the SDK level so an agent is never
      // OFFERED a tool it can't use (e.g. the Lead + shell) — which previously
      // dead-ended its turn on a permission rejection. See toolPolicy.ts.
      excludedTools: deniedBuiltinTools(config.role, config.tools),
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
        if (reply === 'approve') return { kind: 'approve-once' };
        // Feed a reason back with the rejection instead of a bare reject, so the
        // model can CONTINUE the turn and respond usefully rather than stranding
        // idle. (Belt-and-suspenders for rejections toolPolicy doesn't pre-empt,
        // e.g. a specialist trying to write outside its worktree.)
        return {
          kind: 'reject',
          feedback:
            `That action was blocked (not permitted for your role/workspace). Do NOT retry the ` +
            `same tool. Instead respond in words: if you are the Team Lead, answer the user ` +
            `directly or delegate this to the right specialist and have them report back; if you ` +
            `are a specialist, keep all changes inside your assigned working directory.`,
        };
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
