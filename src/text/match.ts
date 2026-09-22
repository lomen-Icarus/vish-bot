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
  /**
   * True, когда хоть одно слово совпало только с натяжкой (опечатка или более
   * длинная форма). Такое совпадение можно предложить кнопкой, но нельзя молча
   * принять за нужного человека: «Салодилин Егор» не должен открывать
   * расписание Солодилина только потому, что имя совпало буква в букву.
   */
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
      else if (qw.startsWith(nw) && nw.length >= 3) {
        // Набрали более длинную форму: «иванова» против «иванов». Это догадка —
        // «Кимаев» точно так же начинается с «Ким», а это разные люди.
        s = 2;
        f = true;
      }
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
    if (best >= 2 && qw.length >= 2 && (n[bestIdx]?.length ?? 0) >= 2) substantive = true;
  }
  if (!substantive || score <= 0) return { score: 0, fuzzy: false };
  if (q.length === 1 && q[0]!.length >= 3 && surname.startsWith(q[0]!)) score += 2;
  return { score, fuzzy };
}

/** Convenience wrapper: just the score. */
export function nameMatchScore(name: string, query: string): number {
  return nameMatch(name, query).score;
}

// ---- ФИО как личность: «тот же это человек или другой» ----

/**
 * Должность и степень идут перед фамилией и к имени не относятся. Точка после
 * них бывает и со следующим пробелом, и без него («доц. Иванов», «доц.Иванов»).
 */
const TITLE_RE = /^(?:проф|доц|ст\.?\s?преп|преп|асс|зав\.?\s?каф|дир|зам)(?:\.\s*|\s+)|^[кд]\.[а-яё.-]*н\.\s*/iu;

/** Снимает все звания подряд: у одного человека их бывает сразу два. */
export function stripTitles(raw: string): string {
  let out = raw.trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(TITLE_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Слова ФИО без званий: «доц. к.х.н. Иванова И.И.» → ["иванова","и","и"]. */
export function nameWords(raw: string): string[] {
  return normName(stripTitles(raw)).split(" ").filter(Boolean);
}

/** «Иванова Ирина Ивановна» → «Иванова И. И.»; звания отбрасываются. */
export function shortName(raw: string): string {
  // Точка не разделяет слова («Иванова И.И.» — это два инициала), а дефис,
  // наоборот, часть фамилии: «Иванов-Петров» рвать нельзя.
  const parts = stripTitles(raw).replace(/\./g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!parts.length) return raw.trim();
  if (parts.length < 2) return parts[0]!;
  return [parts[0], ...parts.slice(1, 3).map((w) => `${w[0]!.toUpperCase()}.`)].join(" ");
}

/**
 * Один ли это человек. Сравниваем пословно: полное слово обязано совпасть с
 * полным, инициал совпадает с любым словом на ту же букву, а недостающее слово
 * ничему не противоречит.
 *
 * Отсюда: «Смирнов» и «Смирнов С. С.» — один человек (второй источник просто
 * подробнее), «Иванова И. И.» и «Иванова Ирина Ивановна» — тоже. А вот
 * «Иванова Ирина Ивановна» и «Иванова Инна Игоревна» — разные: сравнение по
 * одним инициалам их бы склеило, и настоящая замена преподавателя прошла бы
 * незамеченной.
 */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return samePersonWords(nameWords(a), nameWords(b));
}

/** То же сравнение по уже разобранным словам: для списков, где их считают заранее. */
export function samePersonWords(pa: string[], pb: string[]): boolean {
  if (!pa.length || !pb.length) return false;
  const n = Math.min(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const [x, y] = [pa[i]!, pb[i]!];
    if (x === y) continue;
    // Инициал против полного слова — совпадение; два полных слова — нет.
    if ((x.length === 1 || y.length === 1) && x[0] === y[0]) continue;
    return false;
  }
  return true;
}
