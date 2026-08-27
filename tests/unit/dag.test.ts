import { describe, it, expect } from 'vitest';
import { sanitizeDag, type DagNode } from '../../src/server/dag.js';

describe('sanitizeDag', () => {
  it('leaves a valid DAG untouched', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a', 'b'] },
    ];
    const { cleaned, drops } = sanitizeDag(nodes);
    expect(drops).toEqual([]);
    expect(cleaned.get('b')).toEqual(['a']);
    expect(cleaned.get('c')).toEqual(['a', 'b']);
  });

  it('leaves a diamond untouched', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ];
    const { drops } = sanitizeDag(nodes);
    expect(drops).toEqual([]);
  });

  it('drops a self-reference', () => {
    const nodes: DagNode[] = [{ id: 'a', dependsOn: ['a'] }];
    const { cleaned, drops } = sanitizeDag(nodes);
    expect(cleaned.get('a')).toEqual([]);
    expect(drops).toEqual([{ id: 'a', dep: 'a', reason: 'self' }]);
  });

  it('drops a dangling dependency on an unknown id', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a', 'ghost'] },
    ];
    const { cleaned, drops } = sanitizeDag(nodes);
    expect(cleaned.get('b')).toEqual(['a']);
    expect(drops).toEqual([{ id: 'b', dep: 'ghost', reason: 'dangling' }]);
  });

  it('breaks a simple 2-node cycle by dropping the closing edge', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ];
    const { cleaned, drops } = sanitizeDag(nodes);
    // a->b is accepted first; b->a would close the cycle, so it's dropped.
    expect(cleaned.get('a')).toEqual(['b']);
    expect(cleaned.get('b')).toEqual([]);
    expect(drops).toEqual([{ id: 'b', dep: 'a', reason: 'cycle' }]);
  });

  it('breaks a 3-node cycle and keeps the acyclic prefix', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependsOn: ['c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ];
    const { cleaned, drops } = sanitizeDag(nodes);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.reason).toBe('cycle');
    // The result must be acyclic: no node can transitively reach itself.
    const reach = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [...(cleaned.get(start) ?? [])];
      while (stack.length) {
        const cur = stack.pop() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const n of cleaned.get(cur) ?? []) stack.push(n);
      }
      return seen;
    };
    for (const id of ['a', 'b', 'c']) expect(reach(id).has(id)).toBe(false);
  });

  it('collapses a duplicate edge without reporting a drop', () => {
    const nodes: DagNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a', 'a'] },
    ];
    const { cleaned, drops } = sanitizeDag(nodes);
    expect(cleaned.get('b')).toEqual(['a']);
    expect(drops).toEqual([]);
  });
});
