/**
 * "editorial" theme: a Swiss / European print poster on warm paper.
 * Near-black ink, hairline rules instead of cards, a huge weekday word as
 * the hero, small-caps tracked labels, and ONE accent colour that flips with
 * the week parity (odd = signal orange, even = cobalt). The parity is also a
 * full-width solid band under the header so it can't be missed.
 */
import type { LogicalGroup } from "../../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import type { WeekInfo } from "../../schedule/service.js";
import { filterSubgroup } from "../../schedule/format.js";
import { addDays, fmtDayMonth, fmtHHMM, weekdayName, weekdayOf, type LocalDate, type WallClock } from "../../time.js";
import { FONT, PAD, W, h, loadFonts, pluralPairs, text, toPng as corePng, type El, type Style } from "../core.js";
import type { DayRenderInput, Renderer, StreamRenderInput, StreamRenderRow, WeekRenderInput } from "../image.js";

// ---------- palette ----------
const PAPER = "#f4f1ea";
const INK = "#15130f";
const INK2 = "#4a463e";
const MUTED = "#7a7468";
const RULE = "#d3ccbd";
const RULE_SOFT = "#e4dfd3";

const ACCENT = { odd: "#ff5a1f", even: "#1d3fd6", none: INK } as const;
const PARITY_LABEL = { odd: "НЕЧЁТНАЯ", even: "ЧЁТНАЯ" } as const;

function typeColor(type: string): string {
  const t = type.replace(/\.$/, "").toLowerCase();
  if (t === "лк") return "#2b6cb0";
  if (t === "пр") return "#2f855a";
  if (t === "лб") return "#b7791f";
  if (["экз", "зач", "зачо", "конс"].includes(t)) return "#d1495b";
  return "#6b46c1";
}

const up = (s: string): string => s.toUpperCase();
const ddmm = (d: LocalDate): string => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

function accentFor(info: WeekInfo): string {
  return info.parity ? ACCENT[info.parity] : ACCENT.none;
}

// ---------- atoms ----------
const col = (style: Style, ...children: unknown[]): El => h("div", { display: "flex", flexDirection: "column", ...style }, ...children);
const row = (style: Style, ...children: unknown[]): El => h("div", { display: "flex", flexDirection: "row", ...style }, ...children);

function rule(color = RULE, thickness = 1, style: Style = {}): El {
  return h("div", { display: "flex", width: "100%", height: thickness, backgroundColor: color, ...style });
}

/** Small-caps style label with tracking. Never below the 22px legibility floor. */
function label(s: string, style: Style = {}): El {
  return text(up(s), { fontSize: 22, fontWeight: 600, letterSpacing: 2.2, color: MUTED, ...style });
}

/** Outlined (or filled) square-cornered tag. */
function tag(s: string, color: string, filled = false, style: Style = {}): El {
  return h(
    "div",
    { display: "flex", border: `2px solid ${color}`, backgroundColor: filled ? color : "transparent", padding: "6px 12px 5px 12px", marginRight: 10, marginTop: 8, ...style },
    text(up(s), { fontSize: 23, fontWeight: 700, letterSpacing: 1.6, color: filled ? PAPER : color, lineHeight: 1.1 }),
  );
}

function square(color: string, size = 14, style: Style = {}): El {
  return h("div", { display: "flex", width: size, height: size, backgroundColor: color, flexShrink: 0, ...style });
}

/** Vertical accent bar drawn in the left page margin of a `position: relative` block. */
function marginBar(color: string): El {
  return h("div", { display: "flex", position: "absolute", left: -PAD + 22, top: 0, bottom: 0, width: 8, backgroundColor: color });
}

/** Lesson type as coloured square + label. */
function typeMark(type: string, size = 24, color = INK): El {
  return row({ alignItems: "center", marginRight: 22 }, square(typeColor(type), Math.round(size * 0.55), { marginRight: 10 }), text(lessonTypeLabel(type), { fontSize: size, fontWeight: 500, color }));
}

// ---------- header ----------
function masthead(right: string): El {
  return col(
    { width: "100%" },
    row({ width: "100%", justifyContent: "space-between", alignItems: "center" }, label("Расписание · ВИШ ЧувГУ"), label(right, { color: INK, fontWeight: 700 })),
    rule(INK, 3, { marginTop: 14 }),
  );
}

function hero(word: string, subline: unknown[], trailing?: El): El {
  return col(
    { width: "100%", marginTop: 26, paddingBottom: 26 },
    row({ width: "100%", justifyContent: "space-between", alignItems: "flex-end" }, text(up(word), { fontSize: 108, fontWeight: 800, letterSpacing: -4.5, lineHeight: 0.95, color: INK }), trailing ?? null),
    row({ width: "100%", alignItems: "center", marginTop: 18 }, ...subline),
  );
}

function parityBand(info: WeekInfo): El {
  if (info.week == null || !info.parity) {
    return row({ width: "100%", marginTop: 24, padding: "16px 0", borderTop: `1px solid ${RULE}`, borderBottom: `1px solid ${RULE}` }, label("сессия · чётность недели не применяется"));
  }
  const accent = ACCENT[info.parity];
  return row(
    { width: "100%", marginTop: 24, backgroundColor: accent, padding: "20px 26px", alignItems: "center", justifyContent: "space-between" },
    row(
      { alignItems: "baseline" },
      text(PARITY_LABEL[info.parity], { fontSize: 40, fontWeight: 800, letterSpacing: 2.5, color: PAPER, lineHeight: 1 }),
      text("НЕДЕЛЯ", { fontSize: 40, fontWeight: 400, letterSpacing: 2.5, color: PAPER, lineHeight: 1, marginLeft: 16 }),
    ),
    row(
      { alignItems: "baseline" },
      text("№", { fontSize: 26, fontWeight: 500, color: PAPER, opacity: 0.85, marginRight: 8 }),
      text(String(info.week), { fontSize: 40, fontWeight: 800, color: PAPER, lineHeight: 1 }),
    ),
  );
}

function relWord(date: LocalDate, today: LocalDate): string {
  return date === today ? "сегодня" : date === addDays(today, 1) ? "завтра" : date === addDays(today, -1) ? "вчера" : "";
}

function dateSubline(date: LocalDate, today: LocalDate, accent: string): unknown[] {
  const rel = relWord(date, today);
  return [
    text(fmtDayMonth(date), { fontSize: 34, fontWeight: 500, color: INK, letterSpacing: -0.5 }),
    rel ? tag(rel, accent, true, { marginLeft: 20, marginTop: 0 }) : null,
  ];
}

function footer(left: string, right: string): El {
  return col(
    { width: "100%", marginTop: 34 },
    rule(INK, 3),
    row({ width: "100%", justifyContent: "space-between", alignItems: "center", paddingTop: 16 }, label(left, { color: INK }), text(right, { fontSize: 22, fontWeight: 500, color: MUTED })),
  );
}

function page(children: unknown[]): El {
  return col({ width: W, padding: `${PAD - 8}px ${PAD}px ${PAD}px ${PAD}px`, backgroundColor: PAPER, fontFamily: FONT }, ...children);
}

// ---------- day rows ----------
const TIME_COL = 172;

/**
 * Time column. The "сейчас" tag always lives here (day and stream alike) so the
 * marker sits next to the clock it refers to rather than under the subject.
 */
function timeColumn(start: number | null, end: number | null, slot: number | null, opts: { faded?: boolean; nowAccent?: string } = {}): El {
  const c = opts.faded ? MUTED : INK;
  return col(
    { width: TIME_COL, flexShrink: 0, alignItems: "flex-start" },
    text(start != null ? fmtHHMM(start) : "—", { fontSize: 42, fontWeight: 700, color: c, lineHeight: 1, letterSpacing: -1 }),
    text(end != null ? fmtHHMM(end) : "", { fontSize: 24, fontWeight: 400, color: MUTED, marginTop: 8, lineHeight: 1 }),
    slot != null ? label(`${slot} пара`, { marginTop: 14 }) : null,
    opts.nowAccent ? tag("сейчас", opts.nowAccent, true, { marginTop: 14, marginRight: 0 }) : null,
  );
}

function lessonRow(o: Occurrence, accent: string, ongoing: boolean): El {
  const moved = o.status === "moved";
  const badges: El[] = [];
  if (moved && o.movedTo) badges.push(tag(`перенесена на ${ddmm(o.movedTo.date)}${o.movedTo.slot ? `, ${o.movedTo.slot} пара` : ""}`, MUTED));
  if (o.movedFrom) badges.push(tag(`перенос с ${ddmm(o.movedFrom.date)}`, accent));
  if (o.substituted) badges.push(tag("замена", "#d1495b"));
  if (o.isDistance) badges.push(tag("ДОТ", "#0f8a8a"));

  const meta: El[] = [typeMark(o.type, 24, moved ? MUTED : INK)];
  meta.push(text(o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", { fontSize: 24, fontWeight: 500, color: MUTED, marginRight: 22 }));
  if (o.subgroup) meta.push(text(`${o.subgroup} подгруппа`, { fontSize: 24, fontWeight: 500, color: MUTED, marginRight: 22 }));

  return row(
    { width: "100%", position: "relative", padding: "24px 0 26px 0", borderTop: `1px solid ${RULE}`, opacity: moved ? 0.55 : 1 },
    ongoing ? marginBar(accent) : null,
    timeColumn(o.start, o.end, o.slot, { faded: moved, nowAccent: ongoing ? accent : undefined }),
    col(
      { flex: 1, minWidth: 0 },
      text(o.subject, { fontSize: 36, fontWeight: 700, color: INK, lineHeight: 1.15, letterSpacing: -0.8, textDecoration: moved ? "line-through" : "none" }),
      row({ flexWrap: "wrap", alignItems: "center", marginTop: 12 }, ...meta),
      o.teacher ? text(o.teacher, { fontSize: 24, fontWeight: 400, color: MUTED, marginTop: 6 }) : null,
      badges.length ? row({ flexWrap: "wrap", marginTop: 4 }, ...badges) : null,
    ),
  );
}

function gapRow(minutes: number): El {
  const s = minutes >= 60 ? `окно ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `перерыв ${minutes} мин`;
  return row(
    { width: "100%", alignItems: "center", paddingLeft: TIME_COL, paddingTop: 4, paddingBottom: 4 },
    label(s, { marginRight: 18 }),
    h("div", { display: "flex", flex: 1, height: 1, backgroundColor: RULE_SOFT }),
  );
}

function emptyBlock(title: string, sub: string): El {
  return col(
    { width: "100%", padding: "56px 0 40px 0", borderTop: `1px solid ${RULE}` },
    text(up(title), { fontSize: 92, fontWeight: 800, letterSpacing: -3, lineHeight: 1, color: INK }),
    text(sub, { fontSize: 28, fontWeight: 400, color: MUTED, marginTop: 18 }),
  );
}

// ---------- renderer ----------
export async function createRenderer(): Promise<Renderer | null> {
  const fonts = await loadFonts();
  const toPng = (tree: El): Promise<Buffer> => corePng(tree, fonts);
  const clock = (now?: WallClock): string => `tt.chuvsu.ru · ${now ? fmtHHMM(now.minutes) : ""}`.replace(/ · $/, "");

  return {
    async renderDay(input: DayRenderInput) {
      const { group, date, weekInfo, today, now } = input;
      const accent = accentFor(weekInfo);
      const list = input.lessons;
      const rows: unknown[] = [];
      let prevEnd: number | null = null;
      for (const o of list) {
        if (prevEnd != null && o.start != null && o.start - prevEnd >= 20) rows.push(gapRow(o.start - prevEnd));
        const ongoing = !!now && now.date === date && o.start != null && o.end != null && now.minutes >= o.start && now.minutes < o.end && o.status === "scheduled";
        rows.push(lessonRow(o, accent, ongoing));
        if (o.status === "scheduled" && o.end != null) prevEnd = o.end;
      }
      const active = list.filter((o) => o.status === "scheduled");
      const withTime = active.filter((o) => o.start != null && o.end != null);
      const span = withTime.length ? `${fmtHHMM(Math.min(...withTime.map((o) => o.start!)))} – ${fmtHHMM(Math.max(...withTime.map((o) => o.end!)))}` : "";
      const body = list.length ? rows : [emptyBlock("Пар нет", "свободный день — можно выспаться")];
      const tree = page([
        masthead(group.title),
        hero(weekdayName(date), dateSubline(date, today, accent)),
        parityBand(weekInfo),
        col({ width: "100%", marginTop: 22 }, ...body),
        footer(active.length ? `${active.length} ${pluralPairs(active.length)}${span ? ` · ${span}` : ""}` : "", clock(now)),
      ]);
      return toPng(tree);
    },

    async renderWeek(input: WeekRenderInput) {
      // Total lessons of the week, so the footer says as much as the day poster does.
      const weekTotal = [...input.byDate.values()].flat().filter((o) => o.status === "scheduled" && (!input.subgroup || o.subgroup == null || o.subgroup === input.subgroup)).length;
      const { group, monday, byDate, weekInfo, today, subgroup } = input;
      const accent = accentFor(weekInfo);
      const sections: unknown[] = [];
      const sunday = addDays(monday, 6);
      const days = filterSubgroup(byDate.get(sunday) ?? [], subgroup).length ? 7 : 6;
      for (let i = 0; i < days; i++) {
        const date = addDays(monday, i);
        const list = filterSubgroup(byDate.get(date) ?? [], subgroup);
        const scheduled = list.filter((o) => o.status === "scheduled").length;
        const isToday = date === today;
        // One accent only: the weekday mark is ink, and turns accent for today.
        const mark = isToday ? accent : INK;
        const rows = list.length
          ? list.map((o) => {
              const moved = o.status === "moved";
              const extra = [o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.movedFrom ? `перенос с ${ddmm(o.movedFrom.date)}` : "", o.substituted ? "замена" : ""].filter(Boolean);
              return row(
                { width: "100%", alignItems: "flex-start", padding: "12px 0", borderTop: `1px solid ${RULE_SOFT}`, opacity: moved ? 0.5 : 1 },
                text(o.start != null ? fmtHHMM(o.start) : "—", { fontSize: 27, fontWeight: 700, color: INK, width: 112, flexShrink: 0, lineHeight: 1.2, letterSpacing: -0.5 }),
                col(
                  { flex: 1, minWidth: 0 },
                  text(o.subject, { fontSize: 27, fontWeight: 600, color: INK, lineHeight: 1.2, letterSpacing: -0.4, textDecoration: moved ? "line-through" : "none" }),
                  row({ flexWrap: "wrap", alignItems: "center", marginTop: 6 }, typeMark(o.type, 23, MUTED), text(extra.join(" · "), { fontSize: 23, fontWeight: 500, color: INK2 })),
                ),
              );
            })
          : [row({ width: "100%", padding: "12px 0 8px 0", borderTop: `1px solid ${RULE_SOFT}` }, text("пар нет", { fontSize: 24, fontWeight: 400, color: MUTED, marginLeft: 112 }))];
        sections.push(
          col(
            // The ink rule is a child, not a border, so the today tint and the
            // margin bar start and end on exactly the same line.
            { width: "100%", position: "relative", marginTop: 22, paddingBottom: 12, backgroundColor: isToday ? accent + "14" : "transparent" },
            isToday ? marginBar(accent) : null,
            rule(INK, 3),
            row(
              { width: "100%", alignItems: "center", justifyContent: "space-between", padding: "16px 0 12px 0" },
              row(
                { alignItems: "center" },
                square(mark, 16, { marginRight: 14 }),
                text(up(weekdayName(date)), { fontSize: 34, fontWeight: 800, letterSpacing: -0.5, color: INK, lineHeight: 1 }),
                text(fmtDayMonth(date), { fontSize: 24, fontWeight: 400, color: MUTED, marginLeft: 36, lineHeight: 1 }),
                isToday ? tag("сегодня", accent, true, { marginLeft: 20, marginTop: 0 }) : null,
              ),
              scheduled ? label(`${scheduled} ${pluralPairs(scheduled)}`) : null,
            ),
            ...rows,
          ),
        );
      }
      const weekNo = weekInfo.week != null ? text(String(weekInfo.week).padStart(2, "0"), { fontSize: 108, fontWeight: 800, letterSpacing: -4.5, lineHeight: 0.95, color: accent }) : undefined;
      const tree = page([
        masthead(group.title),
        hero("Неделя", [text(`${fmtDayMonth(monday)} – ${fmtDayMonth(sunday)}`, { fontSize: 34, fontWeight: 500, color: INK, letterSpacing: -0.5 })], weekNo),
        parityBand(weekInfo),
        col({ width: "100%", marginTop: 8 }, ...sections),
        footer(`${group.title}${subgroup ? ` · ${subgroup} подгруппа` : ""}${weekTotal ? ` · ${weekTotal} ${pluralPairs(weekTotal)}` : ""}`, "tt.chuvsu.ru"),
      ]);
      return toPng(tree);
    },

    async renderStreamDay(input: StreamRenderInput) {
      const { intake, date, rows, weekInfo, today, now } = input;
      const accent = accentFor(weekInfo);
      const slots: Array<{ key: string; slot: number | null; start: number | null; end: number | null; rows: StreamRenderRow[] }> = [];
      for (const r of rows) {
        const key = `${r.slot ?? "-"}|${r.start ?? "-"}`;
        const last = slots[slots.length - 1];
        if (last && last.key === key) last.rows.push(r);
        else slots.push({ key, slot: r.slot, start: r.start, end: r.end, rows: [r] });
      }
      const blocks = slots.map((s) => {
        const ongoing = !!now && now.date === date && s.start != null && s.end != null && now.minutes >= s.start && now.minutes < s.end;
        return row(
          { width: "100%", position: "relative", padding: "22px 0 24px 0", borderTop: `1px solid ${RULE}` },
          ongoing ? marginBar(accent) : null,
          timeColumn(s.start, s.end, s.slot, { nowAccent: ongoing ? accent : undefined }),
          col(
            { flex: 1, minWidth: 0 },
            ...s.rows.map((r, i) => {
              const moved = r.status === "moved";
              const extra = [r.isDistance ? "дистанционно" : r.room ? `ауд. ${r.room}` : "", r.subgroup ? `${r.subgroup} подгруппа` : ""].filter(Boolean).join(" · ");
              return col(
                { width: "100%", paddingTop: i === 0 ? 0 : 16, marginTop: i === 0 ? 0 : 16, borderTop: i === 0 ? "none" : `1px solid ${RULE_SOFT}`, opacity: moved ? 0.5 : 1 },
                row(
                  { flexWrap: "wrap", alignItems: "center" },
                  ...r.groups.map((g) =>
                    h(
                      "div",
                      // Group chips are the primary navigation of this poster:
                      // 24px, and the outlined ones get an ink-grey stroke.
                      { display: "flex", border: `2px solid ${r.mine ? accent : MUTED}`, backgroundColor: r.mine ? accent : "transparent", padding: "5px 12px 4px 12px", marginRight: 8, marginBottom: 8 },
                      text(g, { fontSize: 24, fontWeight: 700, letterSpacing: 0.8, color: r.mine ? PAPER : INK2, lineHeight: 1.15 }),
                    ),
                  ),
                ),
                text(r.subject, { fontSize: 30, fontWeight: r.mine ? 700 : 500, color: r.mine ? INK : INK2, lineHeight: 1.15, letterSpacing: -0.5, marginTop: 4, textDecoration: moved ? "line-through" : "none" }),
                row({ flexWrap: "wrap", alignItems: "center", marginTop: 8 }, typeMark(r.type, 22, r.mine ? INK : INK2), text(extra, { fontSize: 22, fontWeight: 400, color: MUTED })),
              );
            }),
          ),
        );
      });
      const body = blocks.length ? blocks : [emptyBlock("Пар нет", "у потока сегодня свободный день")];
      const tree = page([
        masthead(`Поток 20${intake}`),
        hero(weekdayName(date), dateSubline(date, today, accent)),
        parityBand(weekInfo),
        col({ width: "100%", marginTop: 22 }, ...body),
        footer(rows.some((r) => r.mine) ? "выделена твоя группа" : "", clock(now)),
      ]);
      return toPng(tree);
    },
  };
}
