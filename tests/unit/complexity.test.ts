import { describe, it, expect } from 'vitest';
import {
  classifyComplexity,
  parseDesignBreakdown,
  type ComplexityInput,
} from '../../src/server/complexity.js';

const base: ComplexityInput = {
  request: 'improve the thing',
  keptCoreStreams: ['backend'],
  multiLayer: false,
  brownfield: true,
  constraintCount: 0,
};

describe('classifyComplexity (AC2)', () => {
  it('trivial: an explicit tiny change on a brownfield repo skips design', () => {
    expect(classifyComplexity({ ...base, request: 'fix a typo in the README' })).toBe('trivial');
    expect(classifyComplexity({ ...base, request: 'bump the version to 1.2.0' })).toBe('trivial');
    expect(classifyComplexity({ ...base, request: 'rename getUser to fetchUser' })).toBe('trivial');
  });

  it('trivial: a short, single-stream, unconstrained brownfield ask', () => {
    expect(classifyComplexity({ ...base, request: 'add a null check to parseDate' })).toBe(
      'trivial',
    );
  });

  it('standard: any hard constraint forces a design', () => {
    expect(classifyComplexity({ ...base, request: 'fix a typo', constraintCount: 1 })).toBe(
      'standard',
    );
  });

  it('standard: multi-layer scope forces a design', () => {
    expect(classifyComplexity({ ...base, request: 'small tweak', multiLayer: true })).toBe(
      'standard',
    );
  });

  it('standard: more than one builder stream forces a design', () => {
    expect(
      classifyComplexity({ ...base, request: 'tweak', keptCoreStreams: ['frontend', 'backend'] }),
    ).toBe('standard');
  });

  it('standard: greenfield real work always earns a design (stack decision)', () => {
    expect(
      classifyComplexity({
        ...base,
        request: 'build a login page',
        brownfield: false,
        keptCoreStreams: ['frontend'],
      }),
    ).toBe('standard');
  });

  it('standard: a scope-expanding brownfield ask (feature/app/and)', () => {
    expect(
      classifyComplexity({ ...base, request: 'add an export button and a settings dashboard' }),
    ).toBe('standard');
    expect(classifyComplexity({ ...base, request: 'build the whole billing feature' })).toBe(
      'standard',
    );
  });

  it('greenfield: an explicit typo is still trivial (never nonsensical design)', () => {
    expect(
      classifyComplexity({ ...base, request: 'fix a typo in the comment', brownfield: false }),
    ).toBe('trivial');
  });
});

describe('parseDesignBreakdown (AC1/AC5)', () => {
  const raw = [
    'Technical design: use a typed contract.',
    '[backend] Build the API :: POST /orders returns 201 and persists',
    '- [frontend] Build the form :: the form submits and shows errors',
    '[data] ignored line without separator',
    '[qa] Verify :: e2e passes', // qa not in allowed → dropped
    'noise',
  ].join('\n');

  it('extracts only allowed streams, in the [stream] title :: acceptance format', () => {
    const out = parseDesignBreakdown(raw, ['backend', 'frontend', 'data']);
    expect(out).toEqual([
      { stream: 'backend', title: 'Build the API', acceptance: 'POST /orders returns 201 and persists' },
      { stream: 'frontend', title: 'Build the form', acceptance: 'the form submits and shows errors' },
    ]);
  });

  it('is robust to garbled / empty output (never throws, returns fewer rows)', () => {
    expect(parseDesignBreakdown('', ['backend'])).toEqual([]);
    expect(parseDesignBreakdown('no structure at all', ['backend'])).toEqual([]);
    expect(parseDesignBreakdown('[backend] only a title, no separator', ['backend'])).toEqual([]);
  });

  it('never under-dispatches: a stream not in the allowed floor is dropped', () => {
    const out = parseDesignBreakdown('[devops] Do CI :: pipeline green', ['backend']);
    expect(out).toEqual([]);
  });

  it('de-duplicates repeated streams (first wins)', () => {
    const out = parseDesignBreakdown(
      ['[backend] First :: a', '[backend] Second :: b'].join('\n'),
      ['backend'],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('First');
  });
});
