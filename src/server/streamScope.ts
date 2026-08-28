/**
 * Stream relevance scoping for epic decomposition.
 *
 * The decomposer historically fanned an epic out to EVERY provisioned builder
 * (backend, frontend, ux, researcher, data, ...) regardless of what the request
 * actually needed. Live run #2 showed the cost: a headless HTTP-API request still
 * spawned ux + frontend tasks, and Frontend built an entire React/Vite SPA that
 * violated the "no UI / no external deps" constraints and stalled the epic.
 *
 * This module scopes the builder set DOWN to what the request plausibly needs,
 * using a pure, deterministic heuristic (no LLM turn — dispatch must never block
 * on a planning turn). It is intentionally CONSERVATIVE: when a signal is
 * ambiguous it keeps the stream, so we never strand a genuinely-needed discipline.
 */

export interface StreamScopeDrop {
  stream: string;
  reason: string;
}

export interface StreamScopeResult {
  keep: string[];
  drops: StreamScopeDrop[];
}

/**
 * Roles that are read-only by persona and structurally cannot deliver code.
 * Assigning them a "write real source + tests" task just trips the empty-build
 * repair loop (live run #2: researcher looped twice then got restarted).
 */
const NON_IMPLEMENTING = new Set(['researcher', 'pm', 'architect']);

/** Streams that only make sense when the deliverable has a user-facing surface. */
const UI_STREAMS = new Set(['ux', 'frontend']);

// Strong "no user interface" signals — a headless API, CLI, library, SDK, daemon…
const HEADLESS_RE =
  /\b(headless|no[-\s]?ui|no user interface|api[-\s]?only|backend[-\s]?only|\bcli\b|command[-\s]?line|\blibrary\b|\bsdk\b|microservice|daemon|cron\b|webhook|http server|rest api|grpc|only node'?s? built[-\s]?in http)\b/;

// Any signal that a user-facing surface IS wanted — keeps ux/frontend in scope.
const UI_RE =
  /\b(ui\b|user interface|frontend|front[-\s]?end|react|vue|svelte|angular|\bpage\b|\bscreen\b|dashboard|\bbutton\b|\bform\b|\bcss\b|\bhtml\b|browser|responsive|web app|web-app|website|\bspa\b|user experience|wireframe|mockup|styling|layout)\b/;

/**
 * Decide which builder streams a request needs.
 *
 * @param request  the raw epic request / user prompt text
 * @param streams  candidate builder stream names (pm/architect/verifiers already excluded upstream)
 */
export function scopeStreams(request: string, streams: string[]): StreamScopeResult {
  const text = (request ?? '').toLowerCase();
  const headless = HEADLESS_RE.test(text);
  // Neutralize NEGATED UI phrases ("no UI", "without a frontend", "headless") so
  // they don't count as a UI signal — otherwise "no UI" trips UI_RE via its "ui".
  const uiText = text
    .replace(/\bno[-\s]?(ui|user interface|frontend|front[-\s]?end|web ?app|website)\b/g, ' ')
    .replace(/\bwithout (a |an |the )?(ui|user interface|frontend|front[-\s]?end)\b/g, ' ');
  const hasUi = UI_RE.test(uiText);
  const drops: StreamScopeDrop[] = [];
  const keep: string[] = [];

  for (const s of streams) {
    if (NON_IMPLEMENTING.has(s)) {
      drops.push({ stream: s, reason: 'read-only / non-implementing role cannot deliver code' });
      continue;
    }
    if (UI_STREAMS.has(s) && headless && !hasUi) {
      drops.push({
        stream: s,
        reason: 'request describes a headless/API/library deliverable with no user interface',
      });
      continue;
    }
    keep.push(s);
  }

  // Safety net: never strand an epic with zero builders. If the heuristic pruned
  // everything (pathological input), fall back to the implementing streams only.
  if (keep.length === 0) {
    const fallback = streams.filter((s) => !NON_IMPLEMENTING.has(s));
    return {
      keep: fallback.length ? fallback : streams.slice(),
      drops: drops.filter((d) => !(fallback.length ? fallback : streams).includes(d.stream)),
    };
  }

  return { keep, drops };
}
