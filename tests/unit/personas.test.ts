import { describe, it, expect } from 'vitest';
import { AGENT_CATALOG, getCatalogAgent } from '../../src/server/agents/catalog.js';

/**
 * I1 (AC4/AC5-wording): every builder persona must be able to decide under
 * uncertainty on a greenfield/empty repo instead of stalling, WITHOUT losing the
 * "reuse existing patterns" behavior on a brownfield repo. The Architect must own
 * the greenfield stack decision and honor existing-repo docs.
 */

const BUILDERS = ['frontend', 'backend', 'ux', 'data', 'devops'] as const;

function prompt(name: string): string {
  const a = AGENT_CATALOG.find((c) => c.name === name);
  if (!a) throw new Error(`no catalog agent named ${name}`);
  return a.prompt.toLowerCase();
}

describe('builder personas decide under uncertainty (AC4)', () => {
  for (const name of BUILDERS) {
    it(`${name}: has an empty/greenfield escape hatch and does not blanket-stall`, () => {
      const p = prompt(name);
      // Mentions the empty/greenfield case explicitly...
      expect(p).toMatch(/empty|greenfield/);
      // ...and instructs to pick a default / proceed rather than block.
      expect(p).toMatch(/default|proceed|start building/);
      // ...and scopes escalation to irreversible/product decisions only.
      expect(p).toMatch(/irreversible|product|user must own/);
    });

    it(`${name}: still preserves brownfield "follow existing conventions"`, () => {
      const p = prompt(name);
      expect(p).toMatch(/existing|project.?s|convention|pattern/);
    });
  }
});

describe('frontend persona targets the reported stall (AC4)', () => {
  it('keeps the "matches existing framework" guard but adds the greenfield license', () => {
    const p = prompt('frontend');
    // The original guard remains (brownfield correctness)...
    expect(p).toContain('never introduce a new pattern when one already exists');
    // ...but greenfield no longer means "ask": it must not loop on clarifying questions.
    expect(p).toMatch(/do not stall or loop on clarifying questions/);
    expect(p).toMatch(/react \+ vite|mainstream default/);
  });
});

describe('architect owns greenfield stack + honors existing-repo docs (AC5)', () => {
  const a = getCatalogAgent('architect');
  it('exists and is read-only (does not write production code)', () => {
    expect(a).toBeTruthy();
    expect(a!.prompt.toLowerCase()).toContain('do not write production code');
  });
  it('decides the stack on greenfield', () => {
    const p = a!.prompt.toLowerCase();
    expect(p).toMatch(/greenfield/);
    expect(p).toMatch(/decide and state the tech stack|choose/);
  });
  it('honors AGENTS.md / README / CONTRIBUTING on an existing repo', () => {
    const p = a!.prompt;
    expect(p).toMatch(/AGENTS\.md/);
    expect(p).toMatch(/CONTRIBUTING/);
    expect(p).toMatch(/README/);
  });
});
