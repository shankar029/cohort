import { describe, it, expect } from 'vitest';
import type { SkillInfo } from '../../src/shared/index.js';
import { partitionRecommended, recommendedPresent } from '../../src/web/skills.js';

const s = (name: string): SkillInfo => ({ name, description: '', path: `/x/${name}`, source: 'home' });
const pool = [s('accessibility'), s('design-system'), s('librarian'), s('testing')];

describe('partitionRecommended', () => {
  it('surfaces recommended skills first without hiding the rest', () => {
    const g = partitionRecommended(pool, ['accessibility', 'design-system']);
    expect(g.recommended.map((x) => x.name)).toEqual(['accessibility', 'design-system']);
    expect(g.others.map((x) => x.name)).toEqual(['librarian', 'testing']);
  });

  it('with no recommendations, everything is "others" (flat list)', () => {
    const g = partitionRecommended(pool, []);
    expect(g.recommended).toEqual([]);
    expect(g.others).toHaveLength(4);
  });

  it('ignores recommended names that are not in the pool', () => {
    const g = partitionRecommended(pool, ['accessibility', 'nonexistent']);
    expect(g.recommended.map((x) => x.name)).toEqual(['accessibility']);
  });
});

describe('recommendedPresent', () => {
  it('returns only the recommended names that exist in the pool', () => {
    expect(recommendedPresent(['accessibility', 'security'], pool)).toEqual(['accessibility']);
  });

  it('is empty when none are present', () => {
    expect(recommendedPresent(['security', 'owasp'], pool)).toEqual([]);
  });
});
