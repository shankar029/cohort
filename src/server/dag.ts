/**
 * Dependency-graph safety for epic task cards.
 *
 * A task's `dependsOn` holds the ids of sibling tasks that must land before it
 * can start. A malformed graph — a self-reference, a dependency on an id that
 * doesn't exist, or a cycle — would silently STALL an epic forever, because the
 * blocked task's dependency can never reach `review`/`done`. `sanitizeDag`
 * repairs such graphs deterministically: it drops the offending edges (and only
 * those edges) so the rest of the ordering is preserved and the epic can make
 * progress. This is the safe foundation for finer, multi-task-per-stream
 * decomposition.
 */

export interface DagNode {
  id: string;
  dependsOn: string[];
}

export type DagDropReason = 'self' | 'dangling' | 'cycle';

export interface DagDrop {
  id: string;
  dep: string;
  reason: DagDropReason;
}

export interface DagResult {
  /** id → cleaned, acyclic dependency list (input order preserved). */
  cleaned: Map<string, string[]>;
  /** The edges that were removed, with the reason, in the order discovered. */
  drops: DagDrop[];
}

/**
 * Return a cleaned, acyclic dependency set for the given nodes:
 *  - self-references are dropped,
 *  - dependencies on ids not in the node set are dropped (dangling),
 *  - edges that would close a cycle are dropped.
 *
 * Nodes are processed in input order and each node's deps keep their order, so
 * the result is deterministic. A node's first-seen edges win: when a cycle would
 * form, it's the later edge (the one that closes the loop) that's dropped.
 */
export function sanitizeDag(nodes: DagNode[]): DagResult {
  const ids = new Set(nodes.map((n) => n.id));
  const drops: DagDrop[] = [];
  // Adjacency of ACCEPTED dependsOn edges, built up incrementally so we can
  // reject any edge that would close a cycle against what's already accepted.
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);

  // Can `target` be reached from `from` by following accepted dependsOn edges?
  const reaches = (from: string, target: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop() as string;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) ?? []) stack.push(next);
    }
    return false;
  };

  for (const n of nodes) {
    const accepted = adj.get(n.id) as string[];
    for (const dep of n.dependsOn) {
      if (dep === n.id) {
        drops.push({ id: n.id, dep, reason: 'self' });
        continue;
      }
      if (!ids.has(dep)) {
        drops.push({ id: n.id, dep, reason: 'dangling' });
        continue;
      }
      if (accepted.includes(dep)) continue; // duplicate edge, ignore silently
      // Adding "n depends on dep" closes a cycle iff dep already (transitively)
      // depends on n.
      if (reaches(dep, n.id)) {
        drops.push({ id: n.id, dep, reason: 'cycle' });
        continue;
      }
      accepted.push(dep);
    }
  }

  const cleaned = new Map<string, string[]>();
  for (const n of nodes) cleaned.set(n.id, adj.get(n.id) ?? []);
  return { cleaned, drops };
}
