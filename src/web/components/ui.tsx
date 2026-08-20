import React from 'react';
import type { AgentStatus } from '@shared/index';
import { api } from '../api';

export const STATUS_META: Record<AgentStatus, { label: string; dot: string; text: string }> = {
  idle: { label: 'Idle', dot: 'bg-status-idle', text: 'text-status-idle' },
  working: {
    label: 'Working',
    dot: 'bg-status-working animate-pulseDot',
    text: 'text-status-working',
  },
  needs_input: {
    label: 'Needs input',
    dot: 'bg-status-input animate-pulseDot',
    text: 'text-status-input',
  },
  blocked: { label: 'Blocked', dot: 'bg-status-blocked', text: 'text-status-blocked' },
  done: { label: 'Done', dot: 'bg-status-done', text: 'text-status-done' },
};

export function StatusPill({ status }: { status: AgentStatus }): React.JSX.Element {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium"
      role="status"
      aria-label={`Status: ${meta.label}`}
    >
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} aria-hidden="true" />
      <span className={meta.text}>{meta.label}</span>
    </span>
  );
}

export function Avatar({
  emoji,
  color,
  size = 36,
}: {
  emoji: string;
  color: string;
  size?: number;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md"
      style={{
        width: size,
        height: size,
        backgroundColor: `${color}22`,
        border: `1px solid ${color}55`,
      }}
      aria-hidden="true"
    >
      <span style={{ fontSize: size * 0.5 }}>{emoji}</span>
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-surface-border p-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {hint && <p className="max-w-sm text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2 text-sm text-slate-400"
      role="status"
      aria-live="polite"
    >
      <span
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-blue-400"
        aria-hidden="true"
      />
      {label ?? 'Loading…'}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-lg p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <button
            className="btn-ghost !min-h-0 px-2 py-1"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: 'error' | 'info';
  children: React.ReactNode;
}): React.JSX.Element {
  const styles =
    kind === 'error'
      ? 'border-red-500/40 bg-red-500/10 text-red-200'
      : 'border-blue-500/40 bg-blue-500/10 text-blue-200';
  return <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>{children}</div>;
}

/** A model picker populated from the models actually enabled on the account. */
export function ModelSelect({
  id,
  value,
  onChange,
  testId,
}: {
  id?: string;
  value: string;
  onChange: (model: string) => void;
  testId?: string;
}): React.JSX.Element {
  const [models, setModels] = React.useState<string[]>([]);
  React.useEffect(() => {
    let active = true;
    void api
      .models()
      .then((r) => active && setModels(r.models))
      .catch(() => active && setModels([]));
    return () => {
      active = false;
    };
  }, []);
  const options = models.includes(value) || !value ? models : [value, ...models];
  return (
    <select
      id={id}
      className="input"
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.length === 0 && <option value={value}>{value || 'auto'}</option>}
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
