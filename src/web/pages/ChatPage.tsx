import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp, useBundle } from '../state';
import { Banner, EmptyState } from '../components/ui';

export function ChatPage(): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { sendChat, answerQuestion } = useApp();
  const bundle = useBundle(projectId);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pending = bundle.questions.filter((q) => q.status === 'pending');

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [bundle.chat, pending.length]);

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

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-surface-border px-6 py-4">
        <h1 className="text-lg font-semibold text-slate-100">Chat · Team Lead</h1>
        <p className="text-sm text-slate-500">
          Talk to your Team Lead. It delegates work to specialists for you.
        </p>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-auto p-6">
        {bundle.chat.length === 0 && pending.length === 0 && (
          <EmptyState
            title="Say hello to your Team Lead"
            hint="Describe what you want built. The Team Lead will coordinate the right specialists — you only talk to the Lead."
          />
        )}

        {bundle.chat.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] whitespace-pre-wrap rounded-lg px-4 py-2 text-sm ${
                m.role === 'user' ? 'bg-blue-600 text-white' : 'card text-slate-200'
              }`}
              data-testid={m.role === 'lead' ? 'lead-message' : 'user-message'}
            >
              {m.role === 'lead' && (
                <div className="mb-1 text-xs font-semibold text-status-idle">🧭 Team Lead</div>
              )}
              {m.content || <span className="text-slate-500">…</span>}
            </div>
          </div>
        ))}

        {pending.map((q) => (
          <QuestionCard
            key={q.id}
            question={q.question}
            choices={q.choices}
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
      </form>
    </div>
  );
}

function QuestionCard({
  question,
  choices,
  onAnswer,
}: {
  question: string;
  choices: string[] | null;
  onAnswer: (answer: string) => Promise<void>;
}): React.JSX.Element {
  const [text, setText] = useState('');
  return (
    <div
      className="mx-auto max-w-[85%] rounded-lg border border-status-input/50 bg-status-input/10 p-4"
      data-testid="question-card"
    >
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-status-input">
        Needs your input
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
