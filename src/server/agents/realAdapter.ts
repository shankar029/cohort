import type { CopilotAdapter, PermissionAsk, TeamSession, TeamSessionConfig } from './adapter.js';

/**
 * Real adapter backed by @github/copilot-sdk, driving the local Copilot CLI.
 *
 * The SDK is imported lazily so the Fake adapter (tests / offline / UI dev) never
 * loads it. Team Lead = the session's default agent; specialists = customAgents.
 * Sub-agent lifecycle + tool events are normalized into AdapterEvent, attributing
 * work to whichever specialist is currently active.
 */

// Tool the specialists use to maintain their own visible task board.
const TASK_TOOL = 'update_task_board';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySdk = any;

class RealTeamSession implements TeamSession {
  private currentAgent: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: AnySdk,
    private readonly config: TeamSessionConfig,
  ) {
    this.wireEvents();
  }

  private wireEvents(): void {
    const { onEvent } = this.config;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.session.on((event: any) => {
      const data = event?.data ?? {};
      switch (event?.type) {
        case 'subagent.selected':
          this.currentAgent = data.agentName ?? this.currentAgent;
          break;
        case 'subagent.started':
          this.currentAgent = data.agentName ?? this.currentAgent;
          onEvent({
            kind: 'subagent_started',
            agentName: data.agentName,
            displayName: data.agentDisplayName ?? data.agentName,
            description: data.agentDescription,
          });
          break;
        case 'subagent.completed':
          onEvent({
            kind: 'subagent_completed',
            agentName: data.agentName,
            displayName: data.agentDisplayName ?? data.agentName,
            detail: {
              durationMs: data.durationMs,
              totalTokens: data.totalTokens,
              totalToolCalls: data.totalToolCalls,
            },
          });
          this.currentAgent = null;
          break;
        case 'subagent.failed':
          onEvent({
            kind: 'subagent_failed',
            agentName: data.agentName,
            displayName: data.agentDisplayName ?? data.agentName,
            error: String(data.error ?? 'unknown error'),
          });
          this.currentAgent = null;
          break;
        case 'subagent.deselected':
          this.currentAgent = null;
          break;
        case 'assistant.reasoning':
          if (data.content)
            onEvent({
              kind: 'reasoning',
              agentName: this.currentAgent,
              text: String(data.content),
            });
          break;
        case 'tool.execution_start':
          onEvent({
            kind: 'tool_call',
            agentName: this.currentAgent,
            toolName: String(data.toolName ?? data.name ?? 'tool'),
            detail: data.arguments ?? data.args,
          });
          break;
        case 'tool.execution_complete':
          onEvent({
            kind: 'tool_result',
            agentName: this.currentAgent,
            toolName: String(data.toolName ?? data.name ?? 'tool'),
            detail: { status: data.status },
          });
          break;
        default:
          break;
      }
    });
  }

  send(prompt: string, messageId: string): Promise<void> {
    // Serialize sends so streaming from one turn never interleaves with another.
    // Crucially, a failed turn must NOT poison the chain: both branches run the
    // next turn, so one bad message can never wedge the session permanently.
    const turn = this.queue.then(
      () => this.runTurn(prompt, messageId),
      () => this.runTurn(prompt, messageId),
    );
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private runTurn(prompt: string, messageId: string): Promise<void> {
    const { onEvent } = this.config;
    return new Promise<void>((resolve) => {
      const offs: Array<() => void> = [];
      let settled = false;
      let gotMessage = false;
      let buffer = '';
      const cleanup = (): void => {
        for (const off of offs) {
          try {
            off?.();
          } catch {
            /* listener removal is best-effort */
          }
        }
      };
      // A turn always resolves (never rejects) so the serialized queue keeps
      // draining. Errors are surfaced as events + a visible lead message.
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(safety);
        // If the model streamed its reply as deltas without a discrete
        // assistant.message, finalize from the accumulated buffer so the stored
        // chat message is never left empty.
        if (!gotMessage && buffer.trim()) {
          onEvent({ kind: 'lead_message', messageId, text: buffer });
        }
        cleanup();
        resolve();
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        gotMessage = true;
        onEvent({
          kind: 'lead_message',
          messageId,
          text: `⚠️ The agent run failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        onEvent({ kind: 'idle' });
        finish();
      };

      // Absolute safety net: never let a stuck turn freeze the whole session.
      const safety = setTimeout(() => finish(), 15 * 60_000);
      safety.unref?.();

      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('assistant.message_delta', (e: any) => {
          if (e?.data?.deltaContent) {
            buffer += String(e.data.deltaContent);
            onEvent({ kind: 'lead_delta', messageId, delta: String(e.data.deltaContent) });
          }
        }),
      );
      offs.push(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.session.on('assistant.message', (e: any) => {
          if (e?.data?.content) {
            gotMessage = true;
            onEvent({ kind: 'lead_message', messageId, text: String(e.data.content) });
          }
        }),
      );
      offs.push(
        // session.idle is the SDK's authoritative end-of-turn signal (it lands
        // after the final assistant.message), so it reliably completes the turn.
        this.session.on('session.idle', () => {
          onEvent({ kind: 'idle' });
          finish();
        }),
      );

      // session.send() resolves immediately with a message-id ack — it is NOT a
      // turn-completion signal, so it is used only to catch a synchronous send
      // failure (e.g. an unavailable model). Completion comes from session.idle.
      Promise.resolve(this.session.send({ prompt })).catch((err: unknown) => fail(err));
    });
  }

  async abort(): Promise<void> {
    await this.session.abort?.();
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

  async createTeamSession(config: TeamSessionConfig): Promise<TeamSession> {
    const client = await this.ensureClient();
    const sdk = this.sdk;

    // A custom tool each specialist uses to maintain its own task board.
    const taskTool = sdk.defineTool(TASK_TOOL, {
      description:
        'Update your personal task board so the user can see your progress. Call this when you start, work on, or finish a step.',
      // Minimal JSON schema (avoids a hard zod dependency in the tool def).
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title' },
          status: { type: 'string', enum: ['todo', 'doing', 'done'] },
        },
        required: ['title', 'status'],
      },
      skipPermission: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any, invocation: any) => {
        config.onEvent({
          kind: 'task_update',
          agentName: invocation?.agentName ?? null,
          title: String(args.title),
          status: (args.status as 'todo' | 'doing' | 'done') ?? 'doing',
        });
        return { ok: true };
      },
    });

    const customAgents = config.specialists.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      prompt: s.prompt,
      tools: s.tools ? [...s.tools, TASK_TOOL] : null,
      skills: s.skills,
      model: s.model,
    }));

    const session = await client.createSession({
      model: config.leadModel,
      workingDirectory: config.workingDirectory,
      streaming: true,
      tools: [taskTool],
      skillDirectories: config.skillDirectories,
      customAgents,
      systemMessage: { content: config.leadPrompt },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onPermissionRequest: async (request: any): Promise<any> => {
        const ask: PermissionAsk = {
          kind: request?.kind ?? 'custom-tool',
          agentName: null,
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
          agentName: null,
          question: String(request?.question ?? 'The agent needs your input.'),
          choices: request?.choices,
        });
        return { answer, wasFreeform: true };
      },
    });

    return new RealTeamSession(session, config);
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.stop?.();
      this.client = null;
    }
  }

  async listModels(): Promise<string[]> {
    const client = await this.ensureClient();
    const models = (await client.listModels?.()) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return models.map((m: any) => (typeof m === 'string' ? m : (m.id ?? m.name))).filter(Boolean);
  }
}
