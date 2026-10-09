// Offered-but-not-chosen tracks receive a decaying preference penalty, never
// an eligibility exclusion. Separate from airplay recency and model recovery.
export class CandidateOffers {
  private readonly entries = new Map<string, { count: number; at: number }>();
  constructor(private readonly now = () => Date.now()) {}

  penalty(id: string): number {
    const entry = this.entries.get(id);
    return entry && this.now() - entry.at < 30 * 60_000 ? Math.min(0.45, entry.count * 0.15) : 0;
  }

  order<T extends { id: string }>(candidates: T[]): T[] {
    return candidates.map((candidate, index) => ({ candidate, index, penalty: this.penalty(candidate.id) }))
      .sort((a, b) => a.penalty - b.penalty || a.index - b.index)
      .map(({ candidate }) => candidate);
  }

  record(ids: Iterable<string>): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (now - entry.at >= 30 * 60_000) this.entries.delete(id);
    for (const id of ids) {
      if (!id) continue;
      const count = (this.entries.get(id)?.count ?? 0) + 1;
      this.entries.delete(id);
      this.entries.set(id, { count, at: now });
    }
    while (this.entries.size > 1000) this.entries.delete(this.entries.keys().next().value!);
  }

  chosen(id: string): void { this.entries.delete(id); }
  clear(): void { this.entries.clear(); }
}

export const shortlistOffers = new CandidateOffers();
