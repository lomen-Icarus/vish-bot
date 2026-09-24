/**
 * "timeline" poster theme: a refined dark timeline. Deep graphite ground, a
 * continuous vertical rail with one dot per lesson (filled for the ongoing
 * one) and a current-time marker, large thin hour numerals next to heavy
 * subject lines, no cards: rows are separated by hairline rules and air.
 * The single accent depends on week parity: amber for odd, ice for even, and
 * it also paints a stripe along the whole left page edge.
 */
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import type { WeekInfo } from "../../schedule/service.js";
import { filterSubgroup, posterTeacher, type TeacherView } from "../../schedule/format.js";
import { addDays, fmtDayMonth, fmtHHMM, weekdayName, type LocalDate, type WallClock } from "../../time.js";
import { FONT, PAD, W, h, loadFonts, pluralPairs, text, toPng as corePng, type El, type Style } from "../core.js";
import type { DayRenderInput, Renderer, StreamRenderInput, StreamRenderRow, WeekRenderInput } from "../image.js";

// ---------- palette ----------
const BG_TOP = "#15181b";
const BG_BOTTOM = "#0e1012";
const FG = "#f2f3f4";
const SOFT = "#c9ccd1";
/** Lightest grey still used for text: ~5.8:1 on the ground. */
const MUTED = "#8d9298";
const RULE = "#24282c";
const RAIL = "#33383d";
const AMBER = "#f5b300";
const ICE = "#8ad4ff";
const NEUTRAL = "#b9bec4";
const INK = "#111315";

const STRIPE = 12;

/** Nothing on the poster is allowed below this size. */
const MIN_TYPE = 22;

interface Accent {
  color: string;
  label: string;
}

function accentFor(info: WeekInfo): Accent {
  if (info.parity === "odd") return { color: AMBER, label: "НЕЧЁТНАЯ" };
  if (info.parity === "even") return { color: ICE, label: "ЧЁТНАЯ" };
  return { color: NEUTRAL, label: "" };
}

function typeTint(type: string): string {
  const t = type.replace(/\.$/, "").toLowerCase();
  if (t === "лк") return "#a9bfd6";
  if (t === "пр") return "#a8cdb3";
  if (t === "лб") return "#d6c19a";
  if (["экз", "зач", "зачо", "конс"].includes(t)) return "#e0a3ad";
  return "#bfb3d9";
}

function relDay(date: LocalDate, today: LocalDate): string {
  return date === today ? "сегодня" : date === addDays(today, 1) ? "завтра" : date === addDays(today, -1) ? "вчера" : "";
}

// ---------- atoms ----------
const row = (style: Style, ...children: unknown[]): El => h("div", { display: "flex", flexDirection: "row", ...style }, ...children);
const col = (style: Style, ...children: unknown[]): El => h("div", { display: "flex", flexDirection: "column", ...style }, ...children);

/** Small outlined capsule (lesson type). */
function capsule(label: string, color: string, filled = false): El {
  return h(
    "div",
    { display: "flex", padding: "4px 14px", borderRadius: 999, border: `1px solid ${color}${filled ? "" : "99"}`, backgroundColor: filled ? color : "transparent", marginRight: 14, marginTop: 6 },
    text(label.toUpperCase(), { fontSize: MIN_TYPE, fontWeight: 600, letterSpacing: 1.2, color: filled ? INK : color, lineHeight: 1.2 }),
  );
}

/** Soft filled badge for statuses (перенос, замена, дистанционно, сейчас). */
function badge(label: string, color: string): El {
  return h("div", { display: "flex", padding: "5px 14px", borderRadius: 6, backgroundColor: color + "22", marginRight: 10, marginTop: 8 }, text(label, { fontSize: MIN_TYPE, fontWeight: 600, color, lineHeight: 1.25 }));
}

/** Rail dot: hollow by default, filled (with halo) when active. */
function dot(color: string, active: boolean, size = 16, filled = active): El {
  if (active) {
    return h(
      "div",
      { display: "flex", width: size + 14, height: size + 14, borderRadius: 999, backgroundColor: color + "33", alignItems: "center", justifyContent: "center" },
      h("div", { display: "flex", width: size + 10, height: size + 10, borderRadius: 999, backgroundColor: `${color}33`, alignItems: "center", justifyContent: "center" }, h("div", { display: "flex", width: size, height: size, borderRadius: 999, backgroundColor: color })),
    );
  }
  if (filled) return h("div", { display: "flex", width: size, height: size, borderRadius: 999, backgroundColor: color });
  return h("div", { display: "flex", width: size, height: size, borderRadius: 999, border: `2px solid ${RAIL}`, backgroundColor: BG_BOTTOM });
}

/** Continuous vertical rail line for a `position: relative` list block. */
function railLine(x: number, top: number, bottom: number): El {
  return h("div", { display: "flex", position: "absolute", left: x - 1, top, bottom, width: 2, backgroundColor: RAIL });
}

/** Horizontal "now" marker crossing the rail. */
function nowMarker(accent: string, timeWidth: number, railWidth: number, minutes: number): El {
  return row(
    { width: "100%", alignItems: "center", padding: "8px 0" },
    row({ width: timeWidth, justifyContent: "flex-end", paddingRight: 18 }, text(fmtHHMM(minutes), { fontSize: 26, fontWeight: 700, color: accent, letterSpacing: 0.5, lineHeight: 1.1 })),
    row({ width: railWidth, justifyContent: "center" }, h("div", { display: "flex", width: 22, height: 22, borderRadius: 999, backgroundColor: `${accent}33`, alignItems: "center", justifyContent: "center" }, h("div", { display: "flex", width: 12, height: 12, borderRadius: 999, backgroundColor: accent }))),
    h("div", { display: "flex", flex: 1, height: 2, backgroundImage: `linear-gradient(90deg, ${accent} 0%, ${accent}00 100%)` }),
  );
}

/** Glowing parity pill with the week number below. */
function parityBlock(info: WeekInfo, accent: Accent): El | null {
  if (!accent.label) return null;
  const weekStyle: Style = { fontSize: 24, fontWeight: 600, letterSpacing: 2, color: accent.color, lineHeight: 1.1 };
  return col(
    { alignItems: "flex-end" },
    h(
      "div",
      { display: "flex", padding: "12px 26px", borderRadius: 999, backgroundColor: accent.color, border: `4px solid ${accent.color}40` },
      text(accent.label, { fontSize: 28, fontWeight: 800, letterSpacing: 2, color: INK, lineHeight: 1.1 }),
    ),
    // Two spans with an explicit gap: tracked-out type welds "3-Я НЕДЕЛЯ" into one word.
    info.week != null ? row({ alignItems: "baseline", marginTop: 14 }, text(`${info.week}-Я`, weekStyle), text("НЕДЕЛЯ", { ...weekStyle, marginLeft: 14 })) : null,
  );
}

function header(title: string, subtitle: string, info: WeekInfo, accent: Accent): El {
  return row(
    { width: "100%", alignItems: "flex-start", justifyContent: "space-between" },
    col(
      { flex: 1, minWidth: 0, paddingRight: 24 },
      text(title, { fontSize: 76, fontWeight: 800, color: FG, letterSpacing: -2.5, lineHeight: 1 }),
      text(subtitle, { fontSize: 26, fontWeight: 500, color: MUTED, marginTop: 16, lineHeight: 1.3 }),
    ),
    h("div", { display: "flex", marginTop: 8 }, parityBlock(info, accent)),
  );
}

function footer(left: string, right: string): El {
  return row(
    { width: "100%", justifyContent: "space-between", alignItems: "center", marginTop: 30, paddingTop: 22, borderTop: `1px solid ${RULE}` },
    text(left, { fontSize: MIN_TYPE, fontWeight: 600, color: SOFT }),
    text(right, { fontSize: MIN_TYPE, fontWeight: 500, color: MUTED, letterSpacing: 0.5 }),
  );
}

function page(accent: string, children: unknown[]): El {
  return row(
    { width: W, backgroundColor: BG_BOTTOM, fontFamily: FONT },
    h("div", { display: "flex", width: STRIPE, backgroundImage: `linear-gradient(180deg, ${accent} 0%, ${accent} 55%, ${accent}22 100%)` }),
    col({ flex: 1, minWidth: 0, padding: `${PAD}px ${PAD}px ${PAD - 8}px ${PAD}px`, backgroundImage: `linear-gradient(180deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)` }, ...children),
  );
}

/** Empty state that keeps the rail: the timeline is the theme's identity. */
function emptyRail(timeW: number, railW: number, railX: number, title: string, sub: string): El {
  return h(
    "div",
    { display: "flex", flexDirection: "column", width: "100%", position: "relative", marginTop: 40, borderTop: `1px solid ${RULE}` },
    railLine(railX, 34, 34),
    row(
      { width: "100%", padding: "60px 0 64px 0" },
      col({ width: timeW, alignItems: "flex-end", paddingRight: 18 }, text("—", { fontSize: 52, fontWeight: 400, color: RAIL, lineHeight: 1 })),
      row({ width: railW, justifyContent: "center", alignItems: "flex-start", paddingTop: 16 }, dot(NEUTRAL, false, 16)),
      col(
        { flex: 1, minWidth: 0, paddingLeft: 16, paddingRight: 12 },
        text(title, { fontSize: 56, fontWeight: 800, color: FG, letterSpacing: -2, lineHeight: 1.05 }),
        text(sub, { fontSize: 26, fontWeight: 500, color: MUTED, marginTop: 14, lineHeight: 1.3 }),
      ),
    ),
  );
}

// ---------- day ----------
const DAY_TIME_W = 190;
const DAY_RAIL_W = 44;
const DAY_RAIL_X = DAY_TIME_W + DAY_RAIL_W / 2;

/** Start time large and thin, end time hung below with a range dash. */
function timeStack(start: number | null, end: number | null, width: number, big: number, accent: string | null): El {
  return col(
    { width, alignItems: "flex-end", paddingRight: 18 },
    text(start != null ? fmtHHMM(start) : "—", { fontSize: big, fontWeight: 400, color: accent ?? FG, lineHeight: 1, letterSpacing: -1 }),
    end != null ? text(`–${fmtHHMM(end)}`, { fontSize: 28, fontWeight: 600, color: accent ?? FG, marginTop: 10, lineHeight: 1 }) : null,
  );
}

function metaSpans(parts: string[], color: string): El[] {
  return parts.map((m, i) => text(i ? `·  ${m}` : m, { fontSize: 23, fontWeight: 500, color, marginTop: 6, paddingRight: 14, lineHeight: 1.3 }));
}

function dayLesson(o: Occurrence, accent: string, ongoing: boolean, view: TeacherView | undefined): El {
  const moved = o.status === "moved";
  const meta: string[] = [];
  if (o.slot != null) meta.push(`${o.slot} пара`);
  if (o.isDistance) meta.push("дистанционно");
  else if (o.room) meta.push(`ауд. ${o.room}`);

  if (o.subgroup) meta.push(`${o.subgroup} подгруппа`);
  const badges: El[] = [];
  if (moved && o.movedTo) badges.push(badge(`перенесена на ${o.movedTo.date.slice(8, 10)}.${o.movedTo.date.slice(5, 7)}${o.movedTo.slot ? `, ${o.movedTo.slot} пара` : ""}`, "#e0a3ad"));
  if (o.movedFrom) badges.push(badge(`перенос с ${o.movedFrom.date.slice(8, 10)}.${o.movedFrom.date.slice(5, 7)}`, "#d6c19a"));
  if (o.substituted) badges.push(badge("замена", "#e4b0bd"));
  if (ongoing) badges.push(badge("сейчас", accent));

  return row(
    { width: "100%", padding: "26px 0", borderBottom: `1px solid ${RULE}`, opacity: moved ? 0.5 : 1 },
    timeStack(o.start, o.end, DAY_TIME_W, 56, ongoing ? accent : null),
    row({ width: DAY_RAIL_W, justifyContent: "center", alignItems: "flex-start", paddingTop: ongoing ? 11 : 18 }, dot(accent, ongoing)),
    col(
      { flex: 1, minWidth: 0, paddingLeft: 16, paddingRight: 12 },
      text(o.subject, { fontSize: 34, fontWeight: 700, color: FG, lineHeight: 1.18, letterSpacing: -0.5, textDecoration: moved ? "line-through" : "none", marginTop: 6 }),
      // Преподаватель в той же строке, что тип и аудитория; не влез — переносится целиком.
      row(
        { flexWrap: "wrap", alignItems: "center", marginTop: 8 },
        capsule(lessonTypeLabel(o.type), typeTint(o.type)),
        ...metaSpans(meta, SOFT),
        posterTeacher(o.teacher, view) ? text(`·\u00a0${posterTeacher(o.teacher, view)!}`, { fontSize: 23, fontWeight: view === "plain" ? 400 : 700, color: view === "plain" ? SOFT : FG, marginTop: 6, lineHeight: 1.3 }) : null,
      ),
      badges.length ? row({ flexWrap: "wrap", marginTop: 4 }, ...badges) : null,
    ),
  );
}

function gapRow(minutes: number): El {
  const label = minutes >= 60 ? `окно ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `перерыв ${minutes} мин`;
  return row(
    { width: "100%", alignItems: "center", padding: "14px 0" },
    h("div", { display: "flex", width: DAY_TIME_W + DAY_RAIL_W }),
    text(label, { fontSize: MIN_TYPE, fontWeight: 500, color: MUTED, paddingLeft: 16, letterSpacing: 0.5 }),
  );
}

// ---------- week ----------
const WK_TIME_W = 110;
const WK_RAIL_W = 36;
const WK_RAIL_X = WK_TIME_W + WK_RAIL_W / 2;

function weekLesson(o: Occurrence, accent: string, last: boolean, view: TeacherView | undefined): El {
  const moved = o.status === "moved";
  const meta = [lessonTypeLabel(o.type), o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.movedFrom ? "перенос" : "", o.substituted ? "замена" : ""].filter(Boolean).join("  ·  ");
  const who = posterTeacher(o.teacher, view);
  return row(
    { width: "100%", padding: "14px 0", borderBottom: last ? "none" : `1px solid ${RULE}`, opacity: moved ? 0.5 : 1 },
    col(
      { width: WK_TIME_W, alignItems: "flex-end", paddingRight: 14 },
      text(o.start != null ? fmtHHMM(o.start) : "—", { fontSize: 30, fontWeight: 400, color: FG, lineHeight: 1, letterSpacing: -0.5 }),
      text(o.end != null ? `–${fmtHHMM(o.end)}` : "", { fontSize: 21, fontWeight: 400, color: MUTED, marginTop: 4, lineHeight: 1 }),
    ),
    row({ width: WK_RAIL_W, justifyContent: "center", paddingTop: 9 }, dot(accent, false, 12)),
    col(
      { flex: 1, minWidth: 0, paddingLeft: 12 },
      text(o.subject, { fontSize: 26, fontWeight: 700, color: FG, lineHeight: 1.18, letterSpacing: -0.3, textDecoration: moved ? "line-through" : "none" }),
      row(
        { flexWrap: "wrap", alignItems: "baseline", marginTop: 5 },
        text(meta, { fontSize: MIN_TYPE, fontWeight: 500, color: MUTED, lineHeight: 1.3 }),
        who ? text(`· ${who}`, { marginLeft: 8, fontSize: MIN_TYPE, fontWeight: view === "plain" ? 500 : 700, color: view === "plain" ? MUTED : FG, lineHeight: 1.3 }) : null,
      ),
    ),
  );
}

function weekSection(date: LocalDate, list: Occurrence[], accent: string, isToday: boolean, view: TeacherView | undefined): El {
  const scheduled = list.filter((o) => o.status === "scheduled").length;
  const rows = list.map((o, i) => weekLesson(o, accent, i === list.length - 1, view));
  const head = row(
    { width: "100%", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
    row(
      { alignItems: "center", flex: 1, minWidth: 0 },
      // Monochrome by default: only today's heading is allowed the accent.
      text(weekdayName(date), { fontSize: 34, fontWeight: 800, color: isToday ? accent : FG, letterSpacing: -0.8, lineHeight: 1.1 }),
      text(fmtDayMonth(date), { fontSize: MIN_TYPE, fontWeight: 500, color: MUTED, marginLeft: 20, lineHeight: 1.1 }),
      isToday ? h("div", { display: "flex", padding: "5px 14px", borderRadius: 999, backgroundColor: accent, marginLeft: 18 }, text("СЕГОДНЯ", { fontSize: MIN_TYPE, fontWeight: 800, letterSpacing: 1.2, color: INK, lineHeight: 1.2 })) : null,
    ),
    text(scheduled ? `${scheduled} ${pluralPairs(scheduled)}` : "", { fontSize: MIN_TYPE, fontWeight: 500, color: MUTED }),
  );
  return col(
    { width: "100%", marginTop: 18, padding: "22px 0 8px 0", borderTop: isToday ? `2px solid ${accent}` : `1px solid ${RULE}` },
    head,
    list.length
      ? h("div", { display: "flex", flexDirection: "column", width: "100%", position: "relative" }, railLine(WK_RAIL_X, 22, 22), ...rows)
      : row(
          { width: "100%", alignItems: "center", padding: "10px 0 14px 0" },
          h("div", { display: "flex", width: WK_TIME_W }),
          row({ width: WK_RAIL_W, justifyContent: "center" }, dot(RAIL, false, 12)),
          text("пар нет", { fontSize: MIN_TYPE, fontWeight: 500, color: MUTED, paddingLeft: 12 }),
        ),
  );
}

// ---------- stream ----------
const ST_TIME_W = 170;
const ST_RAIL_W = 44;
const ST_RAIL_X = ST_TIME_W + ST_RAIL_W / 2;

interface Slot {
  key: string;
  slot: number | null;
  start: number | null;
  end: number | null;
  rows: StreamRenderRow[];
}

function groupChips(groups: string[], mine: boolean, accent: string): El {
  return row(
    { flexWrap: "wrap", alignItems: "center" },
    ...groups.map((g) =>
      h(
        "div",
        { display: "flex", padding: "4px 13px", borderRadius: 6, backgroundColor: mine ? accent : "transparent", border: `1px solid ${mine ? accent : RAIL}`, marginRight: 8, marginBottom: 6 },
        text(g, { fontSize: 24, fontWeight: 700, color: mine ? INK : SOFT, letterSpacing: 0.5, lineHeight: 1.2 }),
      ),
    ),
  );
}

/**
 * One slot = one hour, but every lesson inside it gets its own rail dot (filled
 * only for the viewer's group) and its own tick in the time gutter, so a slot
 * with five groups still reads as five points on the rail.
 */
function streamSlot(s: Slot, accent: string, ongoing: boolean, view: TeacherView | undefined): El {
  return col(
    { width: "100%", padding: "24px 0", borderBottom: `1px solid ${RULE}` },
    ...s.rows.map((r, i) => {
      const moved = r.status === "moved";
      const meta = [r.isDistance ? "дистанционно" : r.room ? `ауд. ${r.room}` : "", r.subgroup ? `${r.subgroup} подгруппа` : ""].filter(Boolean);
      const first = i === 0;
      return row(
        { width: "100%", marginTop: first ? 0 : 20, opacity: moved ? 0.5 : 1 },
        first
          ? timeStack(s.start, s.end, ST_TIME_W, 52, ongoing ? accent : null)
          : col({ width: ST_TIME_W, alignItems: "flex-end", paddingRight: 18 }, h("div", { display: "flex", width: 36, height: 2, backgroundColor: RULE, marginTop: 19 })),
        row({ width: ST_RAIL_W, justifyContent: "center", alignItems: "flex-start", paddingTop: ongoing && r.mine ? 6 : 13 }, dot(accent, ongoing && r.mine, 14, r.mine)),
        col(
          { flex: 1, minWidth: 0, paddingLeft: 16, paddingRight: 12, paddingTop: first ? 0 : 2 },
          groupChips(r.groups, r.mine, accent),
          text(r.subject, { fontSize: r.mine ? 30 : 26, fontWeight: 700, color: r.mine ? FG : SOFT, lineHeight: 1.18, letterSpacing: -0.4, marginTop: 4, textDecoration: moved ? "line-through" : "none" }),
          row(
            { flexWrap: "wrap", alignItems: "center", marginTop: 4 },
            capsule(lessonTypeLabel(r.type), typeTint(r.type)),
            ...metaSpans(meta, r.mine ? SOFT : MUTED),
            posterTeacher(r.teacher, view) ? text(`· ${posterTeacher(r.teacher, view)}`, { marginLeft: 8, fontSize: MIN_TYPE, fontWeight: view === "plain" ? 500 : 700, color: view === "plain" ? MUTED : FG }) : null,
          ),
        ),
      );
    }),
  );
}

// ---------- renderer ----------
export async function createRenderer(): Promise<Renderer | null> {
  const fonts = await loadFonts();
  const toPng = (tree: El): Promise<Buffer> => corePng(tree, fonts);

  return {
    async renderDay(input: DayRenderInput) {
      const { group, date, lessons, weekInfo, today, now } = input;
      const accent = accentFor(weekInfo);
      const isToday = !!now && now.date === date;
      const items: unknown[] = [];
      let prevEnd: number | null = null;
      let markerPlaced = false;
      const marker = (): El => nowMarker(accent.color, DAY_TIME_W, DAY_RAIL_W, (now as WallClock).minutes);
      for (const o of lessons) {
        const ongoing = isToday && o.start != null && o.end != null && now!.minutes >= o.start && now!.minutes < o.end && o.status === "scheduled";
        const gap = prevEnd != null && o.start != null && o.start - prevEnd >= 20 ? o.start - prevEnd : 0;
        const markerHere = isToday && !markerPlaced && o.start != null && now!.minutes < o.start;
        // The rail must stay monotonic: if "now" falls inside a break, the break
        // row is emitted first and the marker splits it, not the other way round.
        const markerAfterGap = markerHere && gap > 0 && now!.minutes >= prevEnd!;
        if (markerHere && !markerAfterGap) {
          items.push(marker());
          markerPlaced = true;
        }
        if (gap > 0) items.push(gapRow(gap));
        if (markerAfterGap) {
          items.push(marker());
          markerPlaced = true;
        }
        if (ongoing) markerPlaced = true;
        items.push(dayLesson(o, accent.color, ongoing, input.teacherView));
        if (o.status === "scheduled" && o.end != null) prevEnd = o.end;
      }
      if (isToday && !markerPlaced && lessons.length) items.push(marker());

      const active = lessons.filter((o) => o.status === "scheduled");
      const withTime = active.filter((o) => o.start != null && o.end != null);
      const span = withTime.length ? `${fmtHHMM(Math.min(...withTime.map((o) => o.start!)))} – ${fmtHHMM(Math.max(...withTime.map((o) => o.end!)))}` : "";
      const subtitle = [group.title, fmtDayMonth(date), relDay(date, today)].filter(Boolean).join("  ·  ");
      const body = lessons.length
        ? h("div", { display: "flex", flexDirection: "column", width: "100%", position: "relative", marginTop: 40, borderTop: `1px solid ${RULE}` }, railLine(DAY_RAIL_X, 30, 24), ...items)
        : emptyRail(DAY_TIME_W, DAY_RAIL_W, DAY_RAIL_X, "Пар нет", "свободный день, можно выспаться");
      const tree = page(accent.color, [
        header(weekdayName(date), subtitle, weekInfo, accent),
        body,
        footer(active.length ? `${active.length} ${pluralPairs(active.length)}${span ? `  ·  ${span}` : ""}` : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },

    async renderWeek(input: WeekRenderInput) {
      // Total lessons of the week, so the footer says as much as the day poster does.
      const weekTotal = [...input.byDate.values()].flat().filter((o) => o.status === "scheduled" && (!input.subgroup || o.subgroup == null || o.subgroup === input.subgroup)).length;
      const { group, monday, byDate, weekInfo, today, subgroup } = input;
      const accent = accentFor(weekInfo);
      const sections: El[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        const list = filterSubgroup(byDate.get(date) ?? [], subgroup);
        if (i === 6 && !list.length) continue;
        sections.push(weekSection(date, list, accent.color, date === today, input.teacherView));
      }
      const subtitle = `${group.title}  ·  ${fmtDayMonth(monday)} – ${fmtDayMonth(addDays(monday, 6))}`;
      const tree = page(accent.color, [header("Неделя", subtitle, weekInfo, accent), col({ width: "100%", marginTop: 26 }, ...sections), footer(`${group.title}${weekTotal ? ` · ${weekTotal} ${pluralPairs(weekTotal)} за неделю` : ""}`, "tt.chuvsu.ru")]);
      return toPng(tree);
    },

    async renderStreamDay(input: StreamRenderInput) {
      const { intake, date, rows, weekInfo, today, now } = input;
      const accent = accentFor(weekInfo);
      const slots: Slot[] = [];
      for (const r of rows) {
        const key = `${r.slot ?? "-"}|${r.start ?? "-"}`;
        const last = slots[slots.length - 1];
        if (last && last.key === key) last.rows.push(r);
        else slots.push({ key, slot: r.slot, start: r.start, end: r.end, rows: [r] });
      }
      const isToday = !!now && now.date === date;
      const items: unknown[] = [];
      let markerPlaced = false;
      for (const s of slots) {
        const ongoing = isToday && s.start != null && s.end != null && now!.minutes >= s.start && now!.minutes < s.end;
        if (isToday && !markerPlaced && s.start != null && now!.minutes < s.start) {
          items.push(nowMarker(accent.color, ST_TIME_W, ST_RAIL_W, now!.minutes));
          markerPlaced = true;
        }
        if (ongoing) markerPlaced = true;
        items.push(streamSlot(s, accent.color, ongoing, input.teacherView));
      }
      if (isToday && !markerPlaced && slots.length) items.push(nowMarker(accent.color, ST_TIME_W, ST_RAIL_W, now!.minutes));
      const subtitle = [`Поток 20${intake}`, fmtDayMonth(date), relDay(date, today)].filter(Boolean).join("  ·  ");
      const body = slots.length
        ? h("div", { display: "flex", flexDirection: "column", width: "100%", position: "relative", marginTop: 40, borderTop: `1px solid ${RULE}` }, railLine(ST_RAIL_X, 30, 24), ...items)
        : emptyRail(ST_TIME_W, ST_RAIL_W, ST_RAIL_X, "У потока пар нет", "ни у одной группы потока занятий не найдено");
      const tree = page(accent.color, [
        header(weekdayName(date), subtitle, weekInfo, accent),
        body,
        footer(rows.some((r) => r.mine) ? "выделена твоя группа" : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },
  };
}
