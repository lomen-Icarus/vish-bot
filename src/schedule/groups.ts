/**
 * Logical groups. The portal lists several "physical" groups that students
 * consider one and the same (individual-track variants like "ВИШ-12-23иот
 * (11.03.04)"), while other look-alikes are genuinely different groups
 * ("ВИШ-11-23 (ЭиЭА)" vs "ВИШ-11-23(РЗиАЭС)").
 *
 * Rule (agreed with the faculty): strip the "иот" marker together with any
 * parenthetical that follows it; keep parentheticals of non-иот groups.
 */
export interface LogicalGroup {
  key: string;
  /** Display title, e.g. "ВИШ-12-23". */
  title: string;
  /** Prefix such as "ВИШ" or "ОЗВИШ". */
  prefix: string;
  /** Group number within the intake, e.g. 12. */
  number: number;
  /** Two-digit intake year, e.g. 23. */
  intake: number;
  /** Course number (1..6) for the given academic year start. */
  course: number;
  /** Portal group ids merged into this logical group. */
  portalIds: number[];
  /** Portal names merged into this logical group. */
  portalNames: string[];
}

const NAME_RE = /^([A-ZА-ЯЁ]+)-(\d{1,2})-(\d{2})\s*(иот)?\s*(\(.*?\))?\s*$/iu;

export interface ParsedGroupName {
  prefix: string;
  number: number;
  intake: number;
  individualTrack: boolean;
  qualifier: string | null;
}

export function parseGroupName(name: string): ParsedGroupName | null {
  const m = NAME_RE.exec(name.trim());
  if (!m) return null;
  return {
    prefix: m[1]!.toUpperCase(),
    number: Number(m[2]),
    intake: Number(m[3]),
    individualTrack: !!m[4],
    qualifier: m[4] ? null : (m[5]?.replace(/^\(|\)$/g, "").trim() ?? null),
  };
}

/** Logical key for a portal group name; unknown shapes map to themselves. */
export function logicalKeyFor(name: string): string {
  const p = parseGroupName(name);
  if (!p) return normalizeKey(name);
  const base = `${p.prefix}-${p.number}-${p.intake}`;
  return normalizeKey(p.qualifier ? `${base} (${p.qualifier})` : base);
}

export function normalizeKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function courseFor(intake: number, academicYearStart: number): number {
  const startYear = 2000 + intake;
  return Math.max(1, academicYearStart - startYear + 1);
}

export function buildLogicalGroups(portal: Array<{ id: number; name: string }>, academicYearStart: number): LogicalGroup[] {
  const map = new Map<string, LogicalGroup>();
  for (const g of portal) {
    const key = logicalKeyFor(g.name);
    const parsed = parseGroupName(g.name);
    let lg = map.get(key);
    if (!lg) {
      const title = parsed ? (parsed.qualifier ? `${parsed.prefix}-${parsed.number}-${parsed.intake} (${parsed.qualifier})` : `${parsed.prefix}-${parsed.number}-${parsed.intake}`) : g.name.trim();
      lg = {
        key,
        title,
        prefix: parsed?.prefix ?? "",
        number: parsed?.number ?? 0,
        intake: parsed?.intake ?? 0,
        course: parsed ? courseFor(parsed.intake, academicYearStart) : 0,
        portalIds: [],
        portalNames: [],
      };
      map.set(key, lg);
    }
    lg.portalIds.push(g.id);
    lg.portalNames.push(g.name.trim());
  }
  return [...map.values()].sort(compareGroups);
}

export function compareGroups(a: LogicalGroup, b: LogicalGroup): number {
  if (a.prefix !== b.prefix) return a.prefix === "ВИШ" ? -1 : b.prefix === "ВИШ" ? 1 : a.prefix.localeCompare(b.prefix, "ru");
  if (a.course !== b.course) return a.course - b.course;
  if (a.number !== b.number) return a.number - b.number;
  return a.title.localeCompare(b.title, "ru");
}

/** Find a logical group by a loose user query ("12-23", "виш 12 23", "ВИШ-12-23 (ЭиЭА)"). */
export function findGroup(groups: LogicalGroup[], query: string): LogicalGroup[] {
  const q = normalizeKey(query).replace(/[\s_]+/g, "-").replace(/-+/g, "-");
  if (!q) return [];
  const exact = groups.filter((g) => g.key === normalizeKey(query) || normalizeKey(g.title) === normalizeKey(query));
  if (exact.length) return exact;
  const numbers = q.match(/\d{1,2}/g) ?? [];
  const prefix = (q.match(/^[a-zа-яё]+/iu)?.[0] ?? "").toUpperCase();
  const matches = groups.filter((g) => {
    if (prefix && g.prefix !== prefix && !g.prefix.startsWith(prefix)) return false;
    if (numbers.length >= 2) return g.number === Number(numbers[0]) && g.intake === Number(numbers[1]);
    if (numbers.length === 1) return g.number === Number(numbers[0]) || g.intake === Number(numbers[0]);
    return prefix ? true : false;
  });
  // "13-26" without a prefix means the day-time group, not the part-time twin.
  if (!prefix && matches.length > 1 && matches.some((g) => g.prefix === "ВИШ")) return matches.filter((g) => g.prefix === "ВИШ");
  return matches;
}

/** «ВИШ-12-23 (ЭиЭА)» → «12-23 ЭиЭА»: для кнопок и постеров, где места мало. */
export function shortGroupTitle(title: string): string {
  return title.replace(/^ВИШ-/, "").replace(/\s*\((.*?)\)\s*$/, " $1").trim();
}

/**
 * Псевдогруппа для экранов, где расписание принадлежит человеку, а не группе:
 * карточка преподавателя, inline-ответ про студента. formatDay/formatWeek
 * печатают её title как заголовок.
 */
export function personGroup(title: string, key: string): LogicalGroup {
  return { key, title, prefix: "", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] };
}
