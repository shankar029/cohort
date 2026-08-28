import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  AgentKind,
  RecordedSessionEvent,
  RecordedTurn,
  RecordedTurnSummary,
} from '@shared/index';

interface OpenTurn {
  id: string;
  projectId: string;
  agentId: string | null;
  agentName: string;
  agentKind: AgentKind;
  workItemId: string | null;
  workItemTitle: string | null;
  threadId: string;
  cwd: string;
  model: string;
  prompt: string;
  startedAt: number;
  events: RecordedSessionEvent[];
}

const PREVIEW = 240;
const MAX_LIST = 500;

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW)}…` : t;
}

/** Sum per-call token usage recorded in a turn's events. */
function sumTokens(events: RecordedSessionEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const e of events) {
    if (e.kind !== 'usage' || !e.detail) continue;
    input += Number(e.detail.inputTokens ?? 0) || 0;
    output += Number(e.detail.outputTokens ?? 0) || 0;
  }
  return { input, output };
}

/** A compact one-line detail string for a recorded step (tool output, usage). */
function stepDetail(e: RecordedSessionEvent): string {
  if (!e.detail) return '';
  if (e.kind === 'usage') {
    const i = Number(e.detail.inputTokens ?? 0) || 0;
    const o = Number(e.detail.outputTokens ?? 0) || 0;
    return `${i} in / ${o} out`;
  }
  if (e.kind === 'tool_result') {
    const parts: string[] = [];
    if (e.detail.success === false) parts.push('FAILED');
    if (typeof e.detail.error === 'string') parts.push(e.detail.error);
    else if (typeof e.detail.output === 'string')
      parts.push(e.detail.output.replace(/\s+/g, ' ').trim());
    const s = parts.join(': ');
    return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s;
  }
  if (e.kind === 'tool_call') {
    const f = e.detail.file ?? e.detail.command ?? e.detail.path;
    return typeof f === 'string' ? f : '';
  }
  return '';
}

/**
 * Records full agent turns (prompt, response, reasoning, tool calls) to disk as
 * newline-delimited JSON, one file per project. Opt-in per project. All writes
 * are best-effort and serialized so parallel agents never interleave a line; a
 * recorder failure must never break an agent turn.
 */
export class SessionRecorder {
  /** One in-flight turn per agent (an actor's mailbox serializes its own asks). */
  private readonly open = new Map<string, OpenTurn>();
  /** Serialized append queue so concurrent actors don't interleave file writes. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDir: string) {}

  private fileFor(projectId: string): string {
    return path.join(this.baseDir, projectId, 'sessions.jsonl');
  }

  /** Begin recording a turn. Keyed by agent (null agentId → the Lead/main key). */
  begin(meta: Omit<OpenTurn, 'id' | 'startedAt' | 'events'>): string {
    const id = crypto.randomUUID();
    this.open.set(meta.agentId ?? '__lead__', {
      ...meta,
      id,
      startedAt: Date.now(),
      events: [],
    });
    return id;
  }

  /** Append a reasoning/tool event to the agent's currently open turn, if any. */
  event(agentId: string | null, event: RecordedSessionEvent): void {
    const turn = this.open.get(agentId ?? '__lead__');
    if (turn) turn.events.push(event);
  }

  /** Finalize the agent's open turn and persist it. */
  end(agentId: string | null, response: string): void {
    const key = agentId ?? '__lead__';
    const turn = this.open.get(key);
    if (!turn) return;
    this.open.delete(key);
    const endedAt = Date.now();
    const tokens = sumTokens(turn.events);
    const record: RecordedTurn = {
      id: turn.id,
      projectId: turn.projectId,
      agentId: turn.agentId,
      agentName: turn.agentName,
      agentKind: turn.agentKind,
      workItemId: turn.workItemId,
      workItemTitle: turn.workItemTitle,
      threadId: turn.threadId,
      cwd: turn.cwd,
      model: turn.model,
      prompt: turn.prompt,
      response,
      events: turn.events,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      startedAt: new Date(turn.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - turn.startedAt,
    };
    const line = `${JSON.stringify(record)}\n`;
    const file = this.fileFor(turn.projectId);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.appendFile(file, line, 'utf8');
      })
      .catch(() => undefined);
  }

  /** Drop any open turn for an agent without persisting (e.g. session restart). */
  discard(agentId: string | null): void {
    this.open.delete(agentId ?? '__lead__');
  }

  private readAll(projectId: string): RecordedTurn[] {
    const file = this.fileFor(projectId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: RecordedTurn[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as RecordedTurn);
      } catch {
        /* skip a corrupt line */
      }
    }
    return out;
  }

  /** Most-recent-first summaries, capped for the list view. */
  list(projectId: string): RecordedTurnSummary[] {
    const turns = this.readAll(projectId);
    turns.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return turns.slice(0, MAX_LIST).map((t) => ({
      id: t.id,
      projectId: t.projectId,
      agentId: t.agentId,
      agentName: t.agentName,
      agentKind: t.agentKind,
      workItemId: t.workItemId,
      workItemTitle: t.workItemTitle,
      model: t.model,
      promptPreview: preview(t.prompt),
      responsePreview: preview(t.response),
      eventCount: t.events.length,
      toolCount: t.events.filter((e) => e.kind === 'tool_call').length,
      inputTokens: t.inputTokens ?? sumTokens(t.events).input,
      outputTokens: t.outputTokens ?? sumTokens(t.events).output,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.durationMs,
    }));
  }

  /** Full detail for one recorded turn. */
  get(projectId: string, turnId: string): RecordedTurn | null {
    return this.readAll(projectId).find((t) => t.id === turnId) ?? null;
  }

  /** Raw JSONL for export/download. */
  rawJsonl(projectId: string): string {
    try {
      return fs.readFileSync(this.fileFor(projectId), 'utf8');
    } catch {
      return '';
    }
  }

  /** Human-readable Markdown transcript of all recorded turns for a project. */
  markdown(projectId: string, projectName: string): string {
    const turns = this.readAll(projectId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const lines: string[] = [
      `# Session recordings — ${projectName}`,
      '',
      `Generated ${new Date().toISOString()} · ${turns.length} turn(s)`,
      '',
    ];
    for (const t of turns) {
      const secs = (t.durationMs / 1000).toFixed(1);
      const tok = t.inputTokens ?? sumTokens(t.events).input;
      const tokOut = t.outputTokens ?? sumTokens(t.events).output;
      lines.push(
        `## ${t.agentName}${t.workItemTitle ? ` — ${t.workItemTitle}` : ''}`,
        '',
        `- **When:** ${t.startedAt} (${secs}s)`,
        `- **Model:** ${t.model}`,
        `- **Tokens:** ${tok} in / ${tokOut} out`,
        `- **Working dir:** \`${t.cwd}\``,
        '',
        '### Prompt',
        '',
        '```',
        t.prompt,
        '```',
        '',
      );
      if (t.events.length) {
        lines.push('### Steps', '');
        for (const e of t.events) {
          const extra = stepDetail(e);
          lines.push(`- \`${e.kind}\` ${e.label}${extra ? ` — ${extra}` : ''}`);
        }
        lines.push('');
      }
      lines.push('### Response', '', t.response || '_(no text — tool-only turn)_', '', '---', '');
    }
    return lines.join('\n');
  }

  /** Delete all recordings for a project. */
  clear(projectId: string): void {
    for (const [key, turn] of this.open) {
      if (turn.projectId === projectId) this.open.delete(key);
    }
    try {
      fs.rmSync(path.join(this.baseDir, projectId), { recursive: true, force: true });
    } catch {
      /* nothing to clear */
    }
  }
}
