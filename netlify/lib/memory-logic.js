// ==========================================================================
// SAMVIT — MEMORY LOGIC (pure functions)
// --------------------------------------------------------------------------
// Deliberately has zero imports and touches no storage. Everything here is
// a pure function of its arguments, which is what makes it directly unit
// testable (see tests/memory-logic.test.js) without mocking @netlify/blobs.
// ==========================================================================

/** The small denormalized shape kept in the index blob — enough to filter
 * and sort without loading every record's full content. */
export function indexEntryFor(memory) {
  const { id, category, pinned, archived, timestamp, updatedAt, projectId } = memory;
  return { id, category, pinned, archived, timestamp, updatedAt, projectId };
}

export function applyFilters(entries, { category, query, showArchived }) {
  let list = entries;
  if (category && category !== "all") {
    list = list.filter((m) => (m.category || "").toLowerCase() === category.toLowerCase());
  }
  list = list.filter((m) => Boolean(m.archived) === Boolean(showArchived));
  if (query) {
    list = list.filter(
      (m) =>
        (m.content || "").toLowerCase().includes(query) ||
        (m.category || "").toLowerCase().includes(query) ||
        (m.tags || []).some((t) => t.toLowerCase().includes(query))
    );
  }
  return list;
}

/** Pinned first, then (if a search query was given) simple keyword-match
 * relevance, then recency. Not a vector/semantic ranking — an honest,
 * dependency-free lexical scorer. See ROADMAP.md for what real semantic
 * retrieval would need (an embeddings call + a vector index). */
export function rankMemories(list, query) {
  const scored = list.map((m) => {
    let score = 0;
    if (query) {
      const content = (m.content || "").toLowerCase();
      const occurrences = query ? content.split(query).length - 1 : 0;
      score += occurrences * 2;
      if ((m.tags || []).some((t) => t.toLowerCase() === query)) score += 5;
    }
    return { m, score };
  });
  scored.sort((a, b) => {
    if (Boolean(b.m.pinned) !== Boolean(a.m.pinned)) return b.m.pinned ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.m.updatedAt || b.m.timestamp) - new Date(a.m.updatedAt || a.m.timestamp);
  });
  return scored.map((s) => s.m);
}
