import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Thread } from '@shared/index';
import { useApp, useBundle } from '../state';
import { Avatar, Banner, EmptyState, agentAvatar } from '../components/ui';
import { Markdown } from '../components/Markdown';

const THREAD_META: Record<Thread['kind'], { icon: string; label: string }> = {
  main: { icon: '💬', label: 'Team Lead' },
  group: { icon: '🗣️', label: 'Discussion' },
  dm: { icon: '💬', label: 'Conversation' },
};

export function ChatPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { sendChat, answerQuestion, createThread, markThreadsSeen, loadThreadMessages } = useApp();
  const bundle = useBundle(projectId);
  const loadedThreads = useRef<Set<string>>(new Set());

  // While the Threads page is open, keep it marked as read so the nav badge stays
  // cleared as new messages stream in.
  useEffect(() => {
    if (projectId) markThreadsSeen(projectId);
  }, [projectId, bundle.chat.length, markThreadsSeen]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the viewport is pinned to the newest message. Auto-scroll only when
  // true, so a user reading older messages up top isn't yanked down by streaming
  // updates. A ref (not state) so the scroll handler never triggers re-renders.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const pending = bundle.questions.filter((q) => q.status === 'pending');

  // Resolve a thread's epic from its linked work item (epic itself, or a task's
  // parent epic) so discussions can be grouped per epic.
  const wiById = useMemo(() => new Map(bundle.workItems.map((w) => [w.id, w])), [bundle.workItems]);
  const epicOf = React.useCallback(
    (t: Thread): { id: string; title: string } | null => {
      if (!t.workItemId) return null;
      const wi = wiById.get(t.workItemId);
      if (!wi) return null;
      const epicId = wi.kind === 'epic' ? wi.id : wi.parentId;
      if (!epicId) return null;
      return { id: epicId, title: wiById.get(epicId)?.title ?? 'Epic' };
    },
    [wiById],
  );

  const mainThread = useMemo(
    () => bundle.threads.find((t) => t.kind === 'main') ?? null,
    [bundle.threads],
  );

  // User↔Lead side conversations (kept alongside the main channel at the top).
  const conversations = useMemo(
    () =>
      bundle.threads
        .filter((t) => t.kind === 'dm')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [bundle.threads],
  );

  // Discussions grouped by epic, plus a 'General' bucket for unlinked threads.
  const grouped = useMemo(() => {
    const epics = new Map<string, { id: string; title: string; threads: Thread[] }>();
    const general: Thread[] = [];
    const rest = bundle.threads
      .filter((t) => t.kind === 'group')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const t of rest) {
      const e = epicOf(t);
      if (!e) {
        general.push(t);
        continue;
      }
      let g = epics.get(e.id);
      if (!g) {
        g = { id: e.id, title: e.title, threads: [] };
        epics.set(e.id, g);
      }
      g.threads.push(t);
    }
    return { epics: [...epics.values()], general };
  }, [bundle.threads, epicOf]);

  const hasThreads = bundle.threads.length > 0;
  const mainThreadId = mainThread?.id ?? null;
  const selectedId = activeThread ?? mainThreadId;
  const selected = bundle.threads.find((t) => t.id === selectedId) ?? null;
  const toggle = (id: string): void =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Messages for the selected thread (fall back to all when threads aren't loaded yet).
  const messages = useMemo(() => {
    if (!selectedId) return bundle.chat;
    return bundle.chat.filter((m) => m.threadId === selectedId || m.threadId === '');
  }, [bundle.chat, selectedId]);

  const onMain = !selected || selected.kind === 'main';
  // Whether the user can post here: the main channel or a user↔Lead conversation.
  // Epic `group` threads are team discussions and stay read-only for the user.
  const isConversation = !selected || selected.kind === 'main' || selected.kind === 'dm';
  const sendTargetId = isConversation ? selectedId : null;

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = 'smooth'): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance < 80;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  // New messages / streaming progress scroll to the newest content ONLY when the
  // user is already at the bottom; otherwise their scroll position is preserved.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom('smooth');
  }, [messages, pending.length, scrollToBottom]);

  // Switching threads always jumps to that thread's latest message.
  useEffect(() => {
    scrollToBottom('auto');
  }, [selectedId, scrollToBottom]);

  // Load a non-main thread's history the first time it's opened (main history is
  // fetched with the bundle; other threads are lazy).
  useEffect(() => {
    if (!projectId || !selectedId || onMain) return;
    if (loadedThreads.current.has(selectedId)) return;
    loadedThreads.current.add(selectedId);
    void loadThreadMessages(projectId, selectedId);
  }, [projectId, selectedId, onMain, loadThreadMessages]);

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const content = input.trim();
    if (!content || !projectId || !isConversation) return;
    setInput('');
    setError(null);
    try {
      await sendChat(projectId, content, sendTargetId ?? undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    }
  };

  const onNewThread = async (): Promise<void> => {
    if (!projectId) return;
    setError(null);
    try {
      const thread = await createThread(projectId);
      setActiveThread(thread.id);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start a conversation');
    }
  };

  const agentName = (id: string | null): string | undefined =>
    id ? bundle.agents.find((a) => a.id === id)?.displayName : undefined;

  const working = bundle.agents.filter((a) => a.status === 'working');

  // Only messages with real content render as bubbles. In-flight agents (empty
  // placeholders that stream in) are shown as ONE typing row at the end, instead
  // of a pile of “…” bubbles.
  const visible = messages.filter((m) => m.role === 'user' || !!(m.content && m.content.trim()));

  return (
    <div className="flex h-full">
      {/* Threads rail */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-surface-border bg-surface-1/40 md:flex">
        <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Threads</h2>
          <button
            type="button"
            onClick={() => void onNewThread()}
            title="Start a new conversation with the Team Lead"
            data-testid="new-thread"
            className="rounded-md border border-surface-border px-2 py-1 text-[0.7rem] font-medium text-slate-300 transition-colors hover:bg-surface-2 hover:text-slate-100"
          >
            + New
          </button>
        </div>
        <div className="flex-1 space-y-1 overflow-auto p-2" data-testid="thread-list">
          {!hasThreads && (
            <p className="px-2 py-4 text-center text-xs text-slate-600">No threads yet</p>
          )}
          {mainThread && (
            <ThreadButton
              thread={mainThread}
              active={mainThread.id === selectedId}
              count={bundle.chat.filter((m) => m.threadId === mainThread.id).length}
              onClick={() => setActiveThread(mainThread.id)}
            />
          )}
          {conversations.map((t) => (
            <ThreadButton
              key={t.id}
              thread={t}
              active={t.id === selectedId}
              count={bundle.chat.filter((m) => m.threadId === t.id).length}
              onClick={() => setActiveThread(t.id)}
            />
          ))}
          {grouped.epics.map((g) => {
            const isCollapsed = collapsed.has(g.id);
            return (
              <div key={g.id} data-testid="thread-epic-group">
                <button
                  onClick={() => toggle(g.id)}
                  className="mt-2 flex w-full items-center gap-1.5 px-2 py-1 text-left text-[0.7rem] font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-300"
                >
                  <span aria-hidden="true" className="text-[0.6rem]">
                    {isCollapsed ? '▶' : '▼'}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={g.title}>
                    {g.title}
                  </span>
                  <span className="text-slate-600">{g.threads.length}</span>
                </button>
                {!isCollapsed &&
                  g.threads.map((t) => (
                    <ThreadButton
                      key={t.id}
                      thread={t}
                      active={t.id === selectedId}
                      count={bundle.chat.filter((m) => m.threadId === t.id).length}
                      onClick={() => setActiveThread(t.id)}
                      indent
                    />
                  ))}
              </div>
            );
          })}
          {grouped.general.length > 0 && (
            <div data-testid="thread-epic-group">
              <div className="mt-2 px-2 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-slate-500">
                General
              </div>
              {grouped.general.map((t) => (
                <ThreadButton
                  key={t.id}
                  thread={t}
                  active={t.id === selectedId}
                  count={bundle.chat.filter((m) => m.threadId === t.id).length}
                  onClick={() => setActiveThread(t.id)}
                  indent
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-surface-border px-6 py-4">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            {selected ? THREAD_META[selected.kind].icon : '💬'}{' '}
            {selected && selected.kind !== 'main' ? selected.topic || 'Discussion' : 'Team Lead'}
          </h1>
          <p className="text-sm text-slate-500">
            {isConversation
              ? 'Talk to your Team Lead here. Use “+ New” for a fresh conversation per initiative; each epic gets its own thread on the left where its delivery discussion happens.'
              : 'A team discussion — watch specialists brainstorm and align.'}
          </p>
        </header>

        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="h-full space-y-4 overflow-auto p-6">
            {messages.length === 0 && pending.length === 0 && (
              <EmptyState
                title="Say hello to your Team Lead"
                hint="Describe what you want built. The Team Lead will coordinate the right specialists — you only talk to the Lead."
              />
            )}

            {visible.map((m) => {
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
                      <Avatar
                        emoji={author.emoji}
                        color={author.color}
                        src={agentAvatar(author.catalogId, author.kind)}
                        size={30}
                      />
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
                    data-testid={
                      isUser ? 'user-message' : isLead ? 'lead-message' : 'agent-message'
                    }
                  >
                    {!isUser && author && (
                      <div className="mb-1 text-xs font-semibold" style={{ color: author.color }}>
                        {author.displayName}
                        {isLead && <span className="ml-1 text-slate-500">· Team Lead</span>}
                      </div>
                    )}
                    {isUser ? m.content : <Markdown content={m.content} />}
                  </div>
                </div>
              );
            })}

            {working.length > 0 && (
              <div className="flex animate-fadeIn items-center gap-2.5" data-testid="team-working">
                <div className="flex -space-x-1.5">
                  {working.slice(0, 4).map((a) => (
                    <Avatar
                      key={a.id}
                      emoji={a.emoji}
                      color={a.color}
                      src={agentAvatar(a.catalogId, a.kind)}
                      size={30}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-surface-border bg-surface-1 px-4 py-2.5">
                  <span className="flex gap-1" aria-hidden="true">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-status-working [animation-delay:-0.2s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-status-working [animation-delay:-0.1s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-status-working" />
                  </span>
                  <span className="text-xs text-slate-400">
                    {working.length <= 2
                      ? `${working.map((a) => a.displayName).join(' and ')} ${working.length === 1 ? 'is' : 'are'} working…`
                      : `${working.length} teammates are working…`}
                  </span>
                </div>
              </div>
            )}

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
          {showJump && (
            <button
              type="button"
              onClick={() => scrollToBottom('smooth')}
              className="absolute bottom-3 right-4 rounded-full border border-surface-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-slate-200 shadow-pop hover:bg-surface-3"
              data-testid="jump-to-latest"
            >
              ↓ Latest
            </button>
          )}
        </div>

        <form onSubmit={send} className="border-t border-surface-border p-4">
          {error && (
            <div className="mb-2">
              <Banner kind="error">{error}</Banner>
            </div>
          )}
          {isConversation ? (
            <>
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
            </>
          ) : (
            <p className="py-2 text-center text-sm text-slate-500">
              This is a team discussion. Switch to a Team Lead conversation to chat.
            </p>
          )}
        </form>
      </div>
    </div>
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

/** A single thread row in the rail; used for the pinned main channel and for
 * threads nested under an epic (indented). */
function ThreadButton({
  thread,
  active,
  count,
  onClick,
  indent,
}: {
  thread: Thread;
  active: boolean;
  count: number;
  onClick: () => void;
  indent?: boolean;
}): React.JSX.Element {
  const meta = THREAD_META[thread.kind];
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-lg py-2 pr-2.5 text-left text-sm transition-colors ${
        indent ? 'pl-5' : 'pl-2.5'
      } ${active ? 'bg-surface-3 text-slate-100' : 'text-slate-400 hover:bg-surface-2'}`}
      data-testid="thread-item"
    >
      <span aria-hidden="true">{meta.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {thread.kind === 'main' ? 'Team Lead' : thread.topic || meta.label}
        </span>
        <span className="text-[0.7rem] text-slate-600">
          {meta.label}
          {count > 0 && ` · ${count}`}
        </span>
      </span>
    </button>
  );
}
