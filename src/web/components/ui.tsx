import React from 'react';
import type { AgentStatus } from '@shared/index';
import { api } from '../api';
import { useTheme } from '../theme';

/** Compact light/dark switch backed by the persisted Catppuccin theme. */
export function ThemeToggle({ className = '' }: { className?: string }): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const nextIsDark = theme === 'light';
  return (
    <button
      type="button"
      onClick={toggle}
      className={`btn-ghost h-9 w-9 !px-0 ${className}`}
      title={nextIsDark ? 'Switch to dark (Mocha)' : 'Switch to light (Latte)'}
      aria-label={nextIsDark ? 'Switch to dark theme' : 'Switch to light theme'}
      data-testid="theme-toggle"
    >
      <span aria-hidden="true" className="text-base leading-none">
        {theme === 'dark' ? '☀️' : '🌙'}
      </span>
    </button>
  );
}

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

/**
 * Adjust a hex color toward white (pct>0) or black (pct<0) by a fraction.
 * Used to synthesize an avatar's light/deep gradient stops from one base color.
 */
function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m && m[1] ? parseInt(m[1], 16) : 0x8b8b8b;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (c: number): number => Math.round(pct >= 0 ? c + (255 - c) * pct : c * (1 + pct));
  const to = (c: number): string =>
    Math.max(0, Math.min(255, mix(c)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Catalog ids (and 'team-lead') that have an illustrated avatar under /avatars. */
const AVATAR_IDS = new Set([
  'team-lead',
  'product-manager',
  'architect',
  'ux-designer',
  'frontend-engineer',
  'backend-engineer',
  'qa-engineer',
  'devops-engineer',
  'researcher',
  'docs-writer',
  'code-reviewer',
  'security-auditor',
  'data-engineer',
]);

/**
 * Resolve the illustrated avatar image for an agent by its catalog id (or the
 * Team Lead by kind). Returns null when there's no bespoke art (PM, Architect,
 * and custom agents), so the caller falls back to the emoji gradient badge.
 */
export function agentAvatar(catalogId?: string | null, kind?: string): string | null {
  const id = kind === 'lead' ? 'team-lead' : (catalogId ?? '');
  return AVATAR_IDS.has(id) ? `/avatars/${id}.png` : null;
}

export function Avatar({
  emoji,
  color,
  size = 36,
  src,
}: {
  emoji: string;
  color: string;
  size?: number;
  /** Optional illustrated avatar; when set it renders instead of the emoji badge. */
  src?: string | null;
}): React.JSX.Element {
  if (src) {
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[28%]"
        style={{
          width: size,
          height: size,
          background: `linear-gradient(145deg, ${color}2e, ${color}0d)`,
          boxShadow: `inset 0 0 0 1px ${color}33`,
        }}
        aria-hidden="true"
      >
        <img
          src={src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          style={{ width: size, height: size }}
        />
      </span>
    );
  }
  const light = shade(color, 0.32);
  const deep = shade(color, -0.24);
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[28%]"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(145deg, ${light}, ${color} 52%, ${deep})`,
        boxShadow: `0 1px 2px ${color}66, inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 1px rgba(255,255,255,0.4)`,
      }}
      aria-hidden="true"
    >
      {/* glossy top highlight */}
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2"
        style={{
          background: 'linear-gradient(to bottom, rgba(255,255,255,0.28), rgba(255,255,255,0))',
        }}
      />
      <span
        className="relative leading-none"
        style={{
          fontSize: size * 0.5,
          filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.28))',
        }}
      >
        {emoji}
      </span>
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
