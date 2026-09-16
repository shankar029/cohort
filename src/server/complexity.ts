/**
 * Pure, deterministic helpers for design-first decomposition. No I/O, no LLM —
 * safe to call on the dispatch hot path (never blocks, never throws).
 */

export type Complexity = 'trivial' | 'standard';

export interface ComplexityInput {
  /** Raw epic request / user prompt. */
  request: string;
  /** Core builder stream names kept in scope (verifiers/pm/architect/post excluded). */
  keptCoreStreams: string[];
  /** Whether the request clearly spans multiple code layers (pickBrownfieldBuilders). */
  multiLayer: boolean;
  /** Whether the repo already has an established codebase. */
  brownfield: boolean;
  /** Number of hard constraints detected (detectConstraints). */
  constraintCount: number;
}

// Explicit "small change" signals — safe to skip the design step even on a
// brownfield repo. Deliberately narrow: a false "standard" only costs one design
// turn; a false "trivial" could skip a needed design.
const TRIVIAL_RE =
  /\b(typo|misspell|spelling|punctuation|whitespace|formatting|lint|rename|reword|wording|copy[-\s]?edit|comment|changelog|version bump|bump (the )?version|one[-\s]?line|readme wording)\b/i;

// Scope-expanding words — if present, the ask is not a simple single change.
const MULTI_RE =
  /\b(and|then|also|plus|as well as|multiple|several|end[-\s]?to[-\s]?end|full|complete|entire|whole|system|platform|application|\bapp\b|feature|dashboard|workflow|pipeline)\b/i;

/**
 * Decide whether an epic needs an up-front design turn ('standard') or the Lead
 * can split it directly ('trivial'/simple). Conservative: only classifies as
 * trivial when confidently small.
 */
export function classifyComplexity(i: ComplexityInput): Complexity {
  // Any hard constraint, multi-layer scope, or more than one builder stream ⇒ design.
  if (i.constraintCount > 0) return 'standard';
  if (i.multiLayer) return 'standard';
  if (i.keptCoreStreams.length > 1) return 'standard';

  const text = (i.request ?? '').trim();
  // An explicit tiny change is trivial even on an existing repo.
  if (TRIVIAL_RE.test(text)) return 'trivial';
  // Greenfield real work always earns a design (the stack/convention decision).
  if (!i.brownfield) return 'standard';
  // Brownfield, single-stream, unconstrained, short, no scope-expanding words ⇒ simple.
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 14 && !MULTI_RE.test(text)) return 'trivial';
  return 'standard';
}

export interface DesignTask {
  stream: string;
  title: string;
  acceptance: string;
}

/**
 * Parse an Architect/Lead structured breakdown into per-stream tasks. Expected
 * line format (tolerant of surrounding prose):
 *
 *   [stream] <task title> :: <acceptance criteria>
 *
 * Only streams in `allowedStreams` are returned (the deterministic template is
 * the floor — a breakdown can add detail to a kept stream but never introduce or
 * drop one). Garbled/partial output simply yields fewer or zero rows.
 */
export function parseDesignBreakdown(raw: string, allowedStreams: string[]): DesignTask[] {
  const allowed = new Set(allowedStreams.map((s) => s.toLowerCase()));
  const seen = new Set<string>();
  const out: DesignTask[] = [];
  const re = /^\s*[-*]?\s*\[([a-z][a-z0-9-]*)\]\s*(.+?)\s*::\s*(.+?)\s*$/i;
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const stream = m[1]!.toLowerCase();
    if (!allowed.has(stream) || seen.has(stream)) continue;
    const title = m[2]!.trim();
    const acceptance = m[3]!.trim();
    if (!title || !acceptance) continue;
    seen.add(stream);
    out.push({ stream, title, acceptance });
  }
  return out;
}
