import type { SkillInfo } from '@shared/index';

export interface SkillGroups {
  /** Skills recommended for the agent's role (present in the discovery pool). */
  recommended: SkillInfo[];
  /** Every other discovered skill — still fully selectable (recommend, don't restrict). */
  others: SkillInfo[];
}

/**
 * Split discovered skills into "recommended for this role" vs the rest, so the
 * UI can surface persona-relevant skills first WITHOUT hiding or blocking any
 * others. Order within each group follows the (already name-sorted) input.
 */
export function partitionRecommended(skills: SkillInfo[], recommended: string[]): SkillGroups {
  const rec = new Set(recommended);
  const out: SkillGroups = { recommended: [], others: [] };
  for (const s of skills) (rec.has(s.name) ? out.recommended : out.others).push(s);
  return out;
}

/**
 * The subset of `recommended` names that actually exist in the discovery pool —
 * used to auto-attach a catalog agent's suggested skills when it's added, so we
 * never attach a name the user doesn't have.
 */
export function recommendedPresent(recommended: string[], skills: SkillInfo[]): string[] {
  const have = new Set(skills.map((s) => s.name));
  return recommended.filter((n) => have.has(n));
}
