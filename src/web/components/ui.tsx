import React from 'react';
import { Clock, Coins } from 'lucide-react';
import type { AgentStatus, SkillInfo } from '@shared/index';
import { api } from '../api';
import { partitionRecommended } from '../skills';
import { useTheme, usePalette } from '../theme';
import { formatDuration, formatTokens } from '../usage';

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

/** Toggles the Comic palette (an independent axis layered over dark/light). */
export function PaletteToggle({ className = '' }: { className?: string }): React.JSX.Element {
  const { palette, toggle } = usePalette();
  const isComic = palette === 'comic';
  return (
    <button
      type="button"
      onClick={toggle}
      className={`btn-ghost h-9 w-9 !px-0 ${isComic ? '!border-accent-500 !text-accent-400' : ''} ${className}`}
      title={isComic ? 'Switch to the standard theme' : 'Switch to the Comic theme'}
      aria-label={isComic ? 'Disable comic theme' : 'Enable comic theme'}
      aria-pressed={isComic}
      data-testid="palette-toggle"
    >
      <span aria-hidden="true" className="text-base leading-none">
        💥
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
    // Illustrated comic avatars come with mixed backgrounds (some transparent, most
    // with a baked comic-burst). Render them inside a uniform rounded frame with
    // object-cover so every agent reads as a consistent comic badge.
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        width={size}
        height={size}
        className="shrink-0 rounded-[28%] object-cover ring-1 ring-black/25"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
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

/**
 * Compact time + token usage chip. Renders nothing when there's no usage yet, so
 * it can be dropped onto cards without adding visual noise to fresh items.
 */
export function UsageChip({
  tokens,
  timeMs,
  title,
  className = '',
}: {
  tokens: number;
  timeMs: number;
  title?: string;
  className?: string;
}): React.JSX.Element | null {
  if (tokens <= 0 && timeMs <= 0) return null;
  return (
    <span
      data-testid="usage-chip"
      title={title ?? 'Time and model tokens spent'}
      className={`inline-flex items-center gap-2 text-[0.7rem] tabular-nums text-slate-400 ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        <Clock className="h-3 w-3 opacity-70" aria-hidden="true" />
        {formatDuration(timeMs)}
      </span>
      <span className="inline-flex items-center gap-1">
        <Coins className="h-3 w-3 opacity-70" aria-hidden="true" />
        {formatTokens(tokens)}
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

/**
 * Module-level cache + in-flight de-dupe so every ModelSelect on a page shares a
 * single `/api/models` fetch (the first one is a slow cold SDK connect). Once
 * loaded, later pickers render populated instantly.
 */
let modelsCache: string[] | null = null;
let modelsInFlight: Promise<string[]> | null = null;
function loadModels(): Promise<string[]> {
  if (modelsCache) return Promise.resolve(modelsCache);
  if (!modelsInFlight) {
    modelsInFlight = api
      .models()
      .then((r) => {
        modelsCache = r.models;
        return r.models;
      })
      .catch((err) => {
        modelsInFlight = null; // allow a retry on the next mount
        throw err;
      });
  }
  return modelsInFlight;
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
  const [models, setModels] = React.useState<string[]>(modelsCache ?? []);
  const [loading, setLoading] = React.useState(modelsCache === null);
  React.useEffect(() => {
    let active = true;
    void loadModels()
      .then((list) => active && (setModels(list), setLoading(false)))
      .catch(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);
  // Always include the current value so a saved/custom model is never dropped.
  const options = !value || models.includes(value) ? models : [value, ...models];
  return (
    <select
      id={id}
      className="input"
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.length === 0 && (
        <option value={value}>{loading ? 'Loading models…' : value || 'auto'}</option>
      )}
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

/** One toggle pill for a skill. `rec` highlights it as recommended for the role. */
function SkillPill({
  skill,
  selected,
  rec,
  onToggle,
}: {
  skill: SkillInfo;
  selected: boolean;
  rec?: boolean;
  onToggle: (name: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`rounded-full border px-2 py-1 text-xs ${
        selected
          ? 'border-accent-500 bg-accent-500/20 text-accent-200'
          : rec
            ? 'border-accent-500/40 text-slate-300'
            : 'border-surface-border text-slate-400'
      }`}
      title={`${skill.description || skill.name} (${skill.source})`}
      data-testid={`skill-${skill.name}`}
      aria-pressed={selected}
      onClick={() => onToggle(skill.name)}
    >
      {skill.name}
      <span className="ml-1 text-[10px] text-slate-500">{skill.source}</span>
    </button>
  );
}

/**
 * Reusable skill selector. Surfaces skills recommended for the agent's role
 * first (recommend, don't restrict) while keeping every discovered skill
 * selectable. Pass `recommended` (skill names) to enable the grouping; omit it
 * for a flat list (e.g. custom agents, which can pick anything).
 */
export function SkillPicker({
  skills,
  selected,
  recommended = [],
  onToggle,
}: {
  skills: SkillInfo[];
  selected: string[];
  recommended?: string[];
  onToggle: (name: string) => void;
}): React.JSX.Element {
  const sel = new Set(selected);
  const rec = new Set(recommended);
  const groups = partitionRecommended(skills, recommended);

  if (skills.length === 0) {
    return <p className="text-xs text-slate-500">No skills discovered.</p>;
  }

  return (
    <div className="space-y-2" data-testid="skill-picker">
      {groups.recommended.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Recommended for this role
          </p>
          <div className="flex flex-wrap gap-2">
            {groups.recommended.map((s) => (
              <SkillPill key={s.path} skill={s} selected={sel.has(s.name)} rec onToggle={onToggle} />
            ))}
          </div>
        </div>
      )}
      {groups.others.length > 0 && (
        <div className="space-y-1">
          {groups.recommended.length > 0 && (
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Other skills
            </p>
          )}
          <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">
            {groups.others.map((s) => (
              <SkillPill
                key={s.path}
                skill={s}
                selected={sel.has(s.name)}
                rec={rec.has(s.name)}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
