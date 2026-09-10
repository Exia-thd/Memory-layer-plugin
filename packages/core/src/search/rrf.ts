import type { FusionReport } from '../types.js';

/** The standard constant, and the same value the reference implementation uses. */
export const RRF_K = 60;

export interface Branch {
  name: string;
  /** Ordered ids, best first. */
  ranked: string[];
  /**
   * Set when the branch could not run at all, as opposed to running and matching
   * nothing. The distinction is the whole point of the fusion report.
   */
  unavailableReason?: string;
  /**
   * Set when the branch answered, but through a lesser route than intended.
   *
   * Distinct from being unavailable: the results are real and are used. It still
   * belongs in the report, because a fallback nobody is told about is the same
   * failure as a branch nobody is told is empty.
   */
  degradedReason?: string;
}

export interface FusedHit {
  id: string;
  score: number;
  ranks: Record<string, number>;
}

export interface FusionOutcome {
  hits: FusedHit[];
  report: FusionReport;
}

/**
 * Reciprocal rank fusion over any number of branches, keyed by node id.
 *
 * Keyed by node id rather than by file, because one file can hold several
 * unrelated decisions and collapsing them to the file would merge memories that
 * disagree with each other.
 *
 * Every branch that contributed nothing is named in the report. A branch that
 * returns empty and says nothing is how fusion quietly decays into whichever
 * branch still works -- the failure this whole layer is built around.
 */
export function fuse(branches: Branch[], k = RRF_K): FusionOutcome {
  const scores = new Map<string, number>();
  const ranks = new Map<string, Record<string, number>>();
  const counts: Record<string, number> = {};
  const degraded: string[] = [];
  const reasons: Record<string, string> = {};

  for (const branch of branches) {
    counts[branch.name] = branch.ranked.length;

    if (branch.unavailableReason) {
      degraded.push(branch.name);
      reasons[branch.name] = branch.unavailableReason;
    } else if (branch.ranked.length === 0) {
      degraded.push(branch.name);
      // A branch that knows why it found nothing has more to say than the
      // generic line, and this is the case where the difference matters: "no
      // memories are linked yet" is actionable and "matched nothing" is not.
      reasons[branch.name] = branch.degradedReason ?? 'Branch ran and matched nothing.';
    } else if (branch.degradedReason) {
      degraded.push(branch.name);
      reasons[branch.name] = branch.degradedReason;
    }

    for (const [index, id] of branch.ranked.entries()) {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));

      let perBranch = ranks.get(id);
      if (!perBranch) {
        perBranch = {};
        ranks.set(id, perBranch);
      }
      perBranch[branch.name] = rank;
    }
  }

  const hits = [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id) ?? {} }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return { hits, report: { branches: counts, degraded, reasons, k } };
}
