/**
 * Fuzzy matching of Russian personal names ("Троишестова Д. С.", "Иванова
 * Ирина"). Shared by the teacher directory and the student directory: both get
 * typed by hand, with typos, in any word order, sometimes with initials.
 */

/** Lower case, ё → е, punctuation → spaces. */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.,;:()"'«»_/\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Damerau–Levenshtein distance, stopped as soon as it passes `max`
 * (so a long list of names costs almost nothing).
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  let cur: number[] = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      // transposition ("ивавнов" → "иванвов")
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array(m + 1).fill(0);
  }
  return prev[m]!;
}

/** How many typos a word of this length may carry and still be the same word. */
export function typoBudget(len: number): number {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

export interface NameMatch {
  score: number;
  /** True when the match needed typo tolerance: good enough to offer, not to assume. */
  fuzzy: boolean;
}

/**
 * Score how well a directory entry ("Иванова И.И." / "Иванова Ирина Ивановна")
 * matches a typed query ("иванова", "Ирина Иванова", "иванова и", "иван",
 * "троишестава"). Words may come in any order; a one-letter name word is an
 * initial and matches any query word starting with it. 0 = no match.
 */
export function nameMatch(name: string, query: string): NameMatch {
  const q = normName(query).split(" ").filter(Boolean);
  const n = normName(name).split(" ").filter(Boolean);
  if (!q.length || !n.length) return { score: 0, fuzzy: false };
  const surname = n[0]!;
  let score = 0;
  // At least one query word must match a real name word: matching only initials
  // ("Троишестова" against the "Т." of "Кожина Т. Н.") is not a match at all.
  let substantive = false;
  let fuzzy = false;
  let exactHits = 0;
  const used = new Set<number>();
  for (const qw of q) {
    let best = 0;
    let bestIdx = -1;
    let bestFuzzy = false;
    n.forEach((nw, i) => {
      if (used.has(i)) return;
      let s = 0;
      let f = false;
      if (nw === qw) s = i === 0 ? 6 : 4;
      else if (nw.length === 1 && qw.startsWith(nw)) s = 1; // initial
      else if (qw.length === 1 && nw.startsWith(qw)) s = 1; // typed initial
      else if (nw.startsWith(qw) && qw.length >= 2) s = i === 0 ? 5 : 3;
      else if (qw.startsWith(nw) && nw.length >= 3) s = 2; // typed a longer form ("иванова" vs "иванов")
      else if (qw.length >= 4 && nw.includes(qw)) s = 1;
      else if (qw.length >= 4 && nw.length >= 4) {
        // Typos: "троишестава" → "троишестова", "иванав" → "иванов".
        const budget = typoBudget(Math.min(qw.length, nw.length));
        if (budget > 0 && editDistance(qw, nw, budget) <= budget) {
          s = i === 0 ? 4 : 2;
          f = true;
        }
      }
      if (s > best) {
        best = s;
        bestIdx = i;
        bestFuzzy = f;
      }
    });
    if (best === 0) {
      // An extra word the entry does not have ("преподаватель Иванова") costs a
      // point instead of killing the match outright.
      score -= 1;
      continue;
    }
    used.add(bestIdx);
    score += best;
    if (bestFuzzy) fuzzy = true;
    // Matching an initial (a one-letter name word) never counts as substantive,
    // even when it is exact: "к ю" must not match every "… К. Ю." in the directory.
    if (best >= 2 && qw.length >= 2 && (n[bestIdx]?.length ?? 0) >= 2) {
      substantive = true;
      if (!bestFuzzy) exactHits++;
    }
  }
  if (!substantive || score <= 0) return { score: 0, fuzzy: false };
  if (q.length === 1 && q[0]!.length >= 3 && surname.startsWith(q[0]!)) score += 2;
  return { score, fuzzy: fuzzy && exactHits === 0 };
}

/** Convenience wrapper: just the score. */
export function nameMatchScore(name: string, query: string): number {
  return nameMatch(name, query).score;
}
