import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Thread } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, Banner, EmptyState } from '../components/ui';
import { Markdown } from '../components/Markdown';

const THREAD_META: Record<Thread['kind'], { icon: string; label: string }> = {
  main: { icon: '💬', label: 'Team Lead' },
  group: { icon: '🗣️', label: 'Discussion' },
  dm: { icon: '✉️', label: 'Direct' },
};

export function ChatPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { sendChat, answerQuestion } = useApp();
  const bundle = useBundle(projectId);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pending = bundle.questions.filter((q) => q.status === 'pending');

  // Main thread first, then discussions by recency.
  const threads = useMemo(() => {
    const main = bundle.threads.filter((t) => t.kind === 'main');
    const rest = bundle.threads
      .filter((t) => t.kind !== 'main')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...main, ...rest];
  }, [bundle.threads]);

  const mainThreadId = threads.find((t) => t.kind === 'main')?.id ?? null;
  const selectedId = activeThread ?? mainThreadId;
  const selected = threads.find((t) => t.id === selectedId) ?? null;

  // Messages for the selected thread (fall back to all when threads aren't loaded yet).
  const messages = useMemo(() => {
    if (!selectedId) return bundle.chat;
    return bundle.chat.filter((m) => m.threadId === selectedId || m.threadId === '');
  }, [bundle.chat, selectedId]);

  const onMain = !selected || selected.kind === 'main';

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending.length]);

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const content = input.trim();
    if (!content || !projectId) return;
    setInput('');
    setError(null);
    try {
      await sendChat(projectId, content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    }
  };

  const agentName = (id: string | null): string | undefined =>
    id ? bundle.agents.find((a) => a.id === id)?.displayName : undefined;

  const working = bundle.agents.filter((a) => a.status === 'working');

  return (
    <div className="flex h-full">
      {/* Threads rail */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-surface-border bg-surface-1/40 md:flex">
        <div className="border-b border-surface-border px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Threads</h2>
        </div>
        <div className="flex-1 space-y-1 overflow-auto p-2" data-testid="thread-list">
          {threads.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-slate-600">No threads yet</p>
          )}
          {threads.map((t) => {
            const meta = THREAD_META[t.kind];
            const isActive = t.id === selectedId;
            const count = bundle.chat.filter((m) => m.threadId === t.id).length;
            return (
              <button
                key={t.id}
                onClick={() => setActiveThread(t.id)}
                className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                  isActive ? 'bg-surface-3 text-white' : 'text-slate-400 hover:bg-surface-2'
                }`}
                data-testid="thread-item"
              >
                <span aria-hidden="true">{meta.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {t.kind === 'main' ? 'Team Lead' : t.topic || meta.label}
                  </span>
                  <span className="text-[0.7rem] text-slate-600">
                    {meta.label}
                    {count > 0 && ` · ${count}`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-surface-border px-6 py-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            {selected ? THREAD_META[selected.kind].icon : '💬'}{' '}
            {selected && selected.kind !== 'main'
              ? selected.topic || 'Discussion'
              : 'Chat · Team Lead'}
          </h1>
          <p className="text-sm text-slate-500">
            {onMain
              ? "Talk to your Team Lead. The whole team's discussions and decisions show up here."
              : 'A team discussion — watch specialists brainstorm and align.'}
          </p>
          {working.length > 0 && (
            <div
              className="mt-2 flex items-center gap-2 text-xs text-slate-400"
              data-testid="team-working"
            >
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-status-working [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-status-working [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-status-working" />
              </span>
              <span>
                {working.map((a) => a.displayName).join(', ')} {working.length === 1 ? 'is' : 'are'}{' '}
                working…
              </span>
            </div>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto p-6">
          {messages.length === 0 && pending.length === 0 && (
            <EmptyState
              title="Say hello to your Team Lead"
              hint="Describe what you want built. The Team Lead will coordinate the right specialists — you only talk to the Lead."
            />
          )}

          {messages.map((m) => {
            const author = m.authorAgentId
              ? bundle.agents.find((a) => a.id === m.authorAgentId)
              : undefined;
            const isUser = m.role === 'user';
            const isLead = author?.kind === 'lead';
            return (
              <div
                key={m.id}
                className={`flex animate-fadeIn items-start gap-2.5 ${
                  isUser ? 'flex-row-reverse' : ''
                }`}
              >
                {!isUser &&
                  (author ? (
                    <Avatar emoji={author.emoji} color={author.color} size={30} />
                  ) : (
                    <span className="flex h-[30px] w-[30px] items-center justify-center rounded-md bg-accent-600/20 text-accent-400">
                      🧭
                    </span>
                  ))}
                <div
                  className={`max-w-[72%] rounded-2xl px-4 py-2.5 text-sm shadow-card ${
                    isUser
                      ? 'whitespace-pre-wrap rounded-tr-sm bg-accent-600 text-white'
                      : 'rounded-tl-sm border border-surface-border bg-surface-1 text-slate-200'
                  }`}
                  data-testid={isUser ? 'user-message' : isLead ? 'lead-message' : 'agent-message'}
                >
                  {!isUser && author && (
                    <div className="mb-1 text-xs font-semibold" style={{ color: author.color }}>
                      {author.displayName}
                      {isLead && <span className="ml-1 text-slate-500">· Team Lead</span>}
                    </div>
                  )}
                  {m.content ? (
                    isUser ? (
                      m.content
                    ) : (
                      <Markdown content={m.content} />
                    )
                  ) : (
                    <WorkingIndicator status={author?.status} />
                  )}
                </div>
              </div>
            );
          })}

          {onMain &&
            pending.map((q) => (
              <QuestionCard
                key={q.id}
                question={q.question}
                choices={q.choices}
                from={agentName(q.agentId)}
                onAnswer={(a) => answerQuestion(q.id, a)}
              />
            ))}
        </div>

        <form onSubmit={send} className="border-t border-surface-border p-4">
          {error && (
            <div className="mb-2">
              <Banner kind="error">{error}</Banner>
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              className="input min-h-[2.75rem] flex-1 resize-none"
              placeholder="Ask the Team Lead to build something…"
              data-testid="chat-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) void send(e);
              }}
            />
            <button
              type="submit"
              className="btn-primary"
              data-testid="chat-send"
              disabled={!input.trim()}
            >
              Send
            </button>
          </div>
          <p className="mt-2 text-[0.7rem] text-slate-600">
            You always talk to the Team Lead. Enter to send · Shift+Enter for a new line.
          </p>
        </form>
      </div>
    </div>
  );
}

function WorkingIndicator({ status }: { status?: string }): React.JSX.Element {
  const label =
    status === 'needs_input'
      ? 'waiting for input'
      : status === 'blocked'
        ? 'blocked'
        : status === 'idle'
          ? 'queued…'
          : 'working…';
  return (
    <span className="inline-flex items-center gap-2 text-slate-400" data-testid="working-indicator">
      <span className="flex gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:-0.2s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:-0.1s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500" />
      </span>
      <span className="text-xs italic">{label}</span>
    </span>
  );
}

function QuestionCard({
  question,
  choices,
  from,
  onAnswer,
}: {
  question: string;
  choices: string[] | null;
  from?: string;
  onAnswer: (answer: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  return (
    <div
      className="mx-auto max-w-[85%] animate-fadeIn rounded-xl border border-status-input/50 bg-status-input/10 p-4"
      data-testid="question-card"
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-status-input">
        Needs your input{from && ` · ${from}`}
      </div>
      <p className="mb-3 text-sm text-slate-100">{question}</p>
      {choices && choices.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {choices.map((c) => (
            <button
              key={c}
              className="btn-ghost"
              data-testid="question-choice"
              onClick={() => void onAnswer(c)}
            >
              {c}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void onAnswer(text.trim());
          }}
        >
          <input
            className="input flex-1"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Your answer"
          />
          <button type="submit" className="btn-primary">
            Answer
          </button>
        </form>
      )}
    </div>
  );
}
