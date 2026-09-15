/**
 * "timeline" poster theme: a refined dark timeline. Deep graphite ground, a
 * continuous vertical rail with one dot per lesson (filled for the ongoing
 * one) and a current-time marker, large thin hour numerals next to heavy
 * subject lines, no cards: rows are separated by hairline rules and air.
 * The single accent depends on week parity: amber for odd, ice for even, and
 * it also paints a stripe along the whole left page edge.
 */
import type { LogicalGroup } from "../../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import type { WeekInfo } from "../../schedule/service.js";
import { filterSubgroup } from "../../schedule/format.js";
import { addDays, fmtDayMonth, fmtHHMM, weekdayName, weekdayOf, type LocalDate, type WallClock } from "../../time.js";
import { FONT, PAD, W, h, loadFonts, pluralPairs, text, toPng as corePng, type El, type Style } from "../core.js";
import type { DayRenderInput, Renderer, StreamRenderInput, StreamRenderRow, WeekRenderInput } from "../image.js";

// ---------- palette ----------
const BG_TOP = "#15181b";
const BG_BOTTOM = "#0e1012";
const FG = "#f2f3f4";
const SOFT = "#c9ccd1";
const MUTED = "#8d9298";
const DIM = "#5d6268";
const RULE = "#24282c";
const RAIL = "#33383d";
const AMBER = "#f5b300";
const ICE = "#8ad4ff";
const NEUTRAL = "#b9bec4";

const STRIPE = 12;
const INNER = W - STRIPE - PAD * 2;

/** Muted pastel per weekday (1 = Monday) for the week poster headings. */
const WEEKDAY_TINT = ["", "#b7c8e8", "#b3d6bf", "#e8d3a2", "#e4b0bd", "#c9b8e6", "#a7d6cf", "#b0b6bd"];

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

function weekLabel(info: WeekInfo): string {
  return info.week != null ? `${info.week}-я неделя` : "";
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
    { display: "flex", padding: "4px 12px", borderRadius: 999, border: `1px solid ${color}${filled ? "" : "99"}`, backgroundColor: filled ? color : "transparent", marginRight: 12, marginTop: 6 },
    text(label.toUpperCase(), { fontSize: 17, fontWeight: 600, letterSpacing: 1.5, color: filled ? "#111315" : color, lineHeight: 1.2 }),
  );
}

/** Soft filled badge for statuses (перенос, замена, дистанционно, сейчас). */
function badge(label: string, color: string): El {
  return h("div", { display: "flex", padding: "5px 12px", borderRadius: 6, backgroundColor: color + "22", marginRight: 10, marginTop: 6 }, text(label, { fontSize: 18, fontWeight: 600, color, lineHeight: 1.2 }));
}

/** Rail dot: hollow by default, filled (with halo) when active. */
function dot(color: string, active: boolean, size = 16, filled = active): El {
  if (active) {
    return h(
      "div",
      { display: "flex", width: size + 14, height: size + 14, borderRadius: 999, backgroundColor: color + "33", alignItems: "center", justifyContent: "center" },
      h("div", { display: "flex", width: size, height: size, borderRadius: 999, backgroundColor: color, boxShadow: `0 0 18px ${color}` }),
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
    { width: "100%", alignItems: "center", padding: "6px 0" },
    row({ width: timeWidth, justifyContent: "flex-end", paddingRight: 18 }, text(fmtHHMM(minutes), { fontSize: 20, fontWeight: 700, color: accent, letterSpacing: 1 })),
    row({ width: railWidth, justifyContent: "center" }, h("div", { display: "flex", width: 12, height: 12, borderRadius: 999, backgroundColor: accent, boxShadow: `0 0 14px ${accent}` })),
    h("div", { display: "flex", flex: 1, height: 2, backgroundImage: `linear-gradient(90deg, ${accent} 0%, ${accent}00 100%)` }),
  );
}

/** Glowing parity pill with the week number below. */
function parityBlock(info: WeekInfo, accent: Accent): El | null {
  if (!accent.label) return null;
  return col(
    { alignItems: "flex-end" },
    h(
      "div",
      { display: "flex", padding: "12px 26px", borderRadius: 999, backgroundColor: accent.color, boxShadow: `0 0 44px ${accent.color}99` },
      text(accent.label, { fontSize: 28, fontWeight: 800, letterSpacing: 2, color: "#111315", lineHeight: 1.1 }),
    ),
    weekLabel(info) ? text(weekLabel(info).toUpperCase(), { fontSize: 20, fontWeight: 600, letterSpacing: 2, color: accent.color, marginTop: 14 }) : null,
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
    text(left, { fontSize: 22, fontWeight: 600, color: SOFT }),
    text(right, { fontSize: 21, fontWeight: 500, color: DIM, letterSpacing: 0.5 }),
  );
}

function page(accent: string, children: unknown[]): El {
  return row(
    { width: W, backgroundColor: BG_BOTTOM, fontFamily: FONT },
    h("div", { display: "flex", width: STRIPE, backgroundImage: `linear-gradient(180deg, ${accent} 0%, ${accent} 55%, ${accent}22 100%)` }),
    col({ flex: 1, minWidth: 0, padding: `${PAD}px ${PAD}px ${PAD - 8}px ${PAD}px`, backgroundImage: `linear-gradient(180deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)` }, ...children),
  );
}

function emptyState(title: string, sub: string): El {
  return col({ width: "100%", alignItems: "flex-start", padding: "70px 0 60px 0" }, text(title, { fontSize: 64, fontWeight: 800, color: FG, letterSpacing: -2 }), text(sub, { fontSize: 26, fontWeight: 500, color: MUTED, marginTop: 14 }));
}

// ---------- day ----------
const DAY_TIME_W = 180;
const DAY_RAIL_W = 44;
const DAY_RAIL_X = DAY_TIME_W + DAY_RAIL_W / 2;

function dayLesson(o: Occurrence, accent: string, ongoing: boolean, tint: boolean): El {
  const moved = o.status === "moved";
  const hasTime = o.start != null && o.end != null;
  const meta: string[] = [];
  if (o.isDistance) meta.push("дистанционно");
  else if (o.room) meta.push(`ауд. ${o.room}`);
  if (o.teacher) meta.push(o.teacher);
  if (o.subgroup) meta.push(`${o.subgroup} подгруппа`);
  const badges: El[] = [];
  if (moved && o.movedTo) badges.push(badge(`перенесена на ${o.movedTo.date.slice(8, 10)}.${o.movedTo.date.slice(5, 7)}${o.movedTo.slot ? `, ${o.movedTo.slot} пара` : ""}`, "#e0a3ad"));
  if (o.movedFrom) badges.push(badge(`перенос с ${o.movedFrom.date.slice(8, 10)}.${o.movedFrom.date.slice(5, 7)}`, "#d6c19a"));
  if (o.substituted) badges.push(badge("замена", "#e4b0bd"));
  if (o.isDistance) badges.push(badge("ДОТ", "#a9bfd6"));
  if (ongoing) badges.push(badge("сейчас", accent));

  return row(
    { width: "100%", padding: "26px 0", borderBottom: `1px solid ${RULE}`, opacity: moved ? 0.5 : 1, backgroundColor: tint ? accent + "12" : "transparent", borderRadius: tint ? 14 : 0 },
    col(
      { width: DAY_TIME_W, alignItems: "flex-end", paddingRight: 18 },
      text(hasTime ? fmtHHMM(o.start!) : "—", { fontSize: 56, fontWeight: 400, color: ongoing ? accent : FG, lineHeight: 1, letterSpacing: -1 }),
      hasTime ? text(fmtHHMM(o.end!), { fontSize: 24, fontWeight: 400, color: MUTED, marginTop: 8, lineHeight: 1 }) : null,
      o.slot != null ? text(`${o.slot} пара`, { fontSize: 19, fontWeight: 500, color: DIM, marginTop: 10, lineHeight: 1 }) : null,
    ),
    row({ width: DAY_RAIL_W, justifyContent: "center", alignItems: "flex-start", paddingTop: ongoing ? 13 : 20 }, dot(accent, ongoing)),
    col(
      { flex: 1, minWidth: 0, paddingLeft: 16, paddingRight: 12 },
      text(o.subject, { fontSize: 34, fontWeight: 700, color: FG, lineHeight: 1.18, letterSpacing: -0.5, textDecoration: moved ? "line-through" : "none", marginTop: 6 }),
      row(
        { flexWrap: "wrap", alignItems: "center", marginTop: 8 },
        capsule(lessonTypeLabel(o.type), typeTint(o.type)),
        ...meta.map((m, i) => text(m, { fontSize: 23, fontWeight: 500, color: SOFT, marginTop: 6, marginRight: i < meta.length - 1 ? 0 : 0, lineHeight: 1.3, paddingRight: 14 })),
      ),
      badges.length ? row({ flexWrap: "wrap", marginTop: 6 }, ...badges) : null,
    ),
  );
}

function gapRow(minutes: number): El {
  const label = minutes >= 60 ? `окно ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `перерыв ${minutes} мин`;
  return row(
    { width: "100%", alignItems: "center", padding: "12px 0" },
    h("div", { display: "flex", width: DAY_TIME_W + DAY_RAIL_W }),
    text(label, { fontSize: 19, fontWeight: 500, color: DIM, paddingLeft: 16, letterSpacing: 0.5 }),
  );
}

// ---------- week ----------
const WK_TIME_W = 104;
const WK_RAIL_W = 36;
const WK_RAIL_X = WK_TIME_W + WK_RAIL_W / 2;

function weekLesson(o: Occurrence, accent: string, last: boolean): El {
  const moved = o.status === "moved";
  const meta = [lessonTypeLabel(o.type), o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.movedFrom ? "перенос" : "", o.substituted ? "замена" : ""].filter(Boolean).join("  ·  ");
  return row(
    { width: "100%", padding: "14px 0", borderBottom: last ? "none" : `1px solid ${RULE}`, opacity: moved ? 0.5 : 1 },
    row({ width: WK_TIME_W, justifyContent: "flex-end", paddingRight: 14 }, text(o.start != null ? fmtHHMM(o.start) : "—", { fontSize: 30, fontWeight: 400, color: FG, lineHeight: 1, letterSpacing: -0.5 })),
    row({ width: WK_RAIL_W, justifyContent: "center", paddingTop: 9 }, dot(accent, false, 12)),
    col(
      { flex: 1, minWidth: 0, paddingLeft: 12 },
      text(o.subject, { fontSize: 26, fontWeight: 700, color: FG, lineHeight: 1.18, letterSpacing: -0.3, textDecoration: moved ? "line-through" : "none" }),
      text(meta, { fontSize: 20, fontWeight: 500, color: MUTED, marginTop: 5, lineHeight: 1.3 }),
    ),
  );
}

function weekSection(date: LocalDate, list: Occurrence[], accent: string, isToday: boolean): El {
  const wd = weekdayOf(date);
  const tint = WEEKDAY_TINT[wd] ?? SOFT;
  const scheduled = list.filter((o) => o.status === "scheduled").length;
  const rows = list.map((o, i) => weekLesson(o, accent, i === list.length - 1));
  const head = row(
    { width: "100%", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
    row(
      { alignItems: "center", flex: 1, minWidth: 0 },
      text(weekdayName(date), { fontSize: 34, fontWeight: 800, color: isToday ? accent : tint, letterSpacing: -0.8, lineHeight: 1.1 }),
      text(fmtDayMonth(date), { fontSize: 22, fontWeight: 500, color: MUTED, marginLeft: 22, lineHeight: 1.1 }),
      isToday ? h("div", { display: "flex", padding: "4px 12px", borderRadius: 999, backgroundColor: accent, marginLeft: 18 }, text("СЕГОДНЯ", { fontSize: 15, fontWeight: 800, letterSpacing: 1.5, color: "#111315", lineHeight: 1.2 })) : null,
    ),
    text(scheduled ? `${scheduled} ${pluralPairs(scheduled)}` : "", { fontSize: 20, fontWeight: 500, color: DIM }),
  );
  return col(
    { width: isToday ? INNER + 40 : "100%", marginLeft: isToday ? -20 : 0, marginTop: 18, padding: isToday ? "22px 20px 8px 20px" : "22px 0 8px 0", borderTop: `1px solid ${RULE}`, backgroundColor: isToday ? accent + "12" : "transparent", borderRadius: isToday ? 18 : 0 },
    head,
    list.length
      ? h("div", { display: "flex", flexDirection: "column", width: "100%", position: "relative" }, railLine(WK_RAIL_X, 22, 22), ...rows)
      : row({ width: "100%", padding: "8px 0 12px 0" }, text("пар нет", { fontSize: 22, fontWeight: 500, color: DIM })),
  );
}

// ---------- stream ----------
const ST_TIME_W = 160;
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
        { display: "flex", padding: "4px 12px", borderRadius: 6, backgroundColor: mine ? accent : "transparent", border: `1px solid ${mine ? accent : RAIL}`, marginRight: 8, marginBottom: 6, boxShadow: mine ? `0 0 16px ${accent}66` : "none" },
        text(g, { fontSize: 19, fontWeight: 700, color: mine ? "#111315" : MUTED, letterSpacing: 0.5, lineHeight: 1.2 }),
      ),
    ),
  );
}

function streamSlot(s: Slot, accent: string, ongoing: boolean): El {
  const anyMine = s.rows.some((r) => r.mine);
  return row(
    { width: "100%", padding: "24px 0", borderBottom: `1px solid ${RULE}`, backgroundColor: ongoing ? accent + "12" : "transparent", borderRadius: ongoing ? 14 : 0 },
    col(
      { width: ST_TIME_W, alignItems: "flex-end", paddingRight: 18 },
      text(s.start != null ? fmtHHMM(s.start) : "—", { fontSize: 52, fontWeight: 400, color: ongoing ? accent : FG, lineHeight: 1, letterSpacing: -1 }),
      s.end != null ? text(fmtHHMM(s.end), { fontSize: 22, fontWeight: 400, color: MUTED, marginTop: 8, lineHeight: 1 }) : null,
      s.slot != null ? text(`${s.slot} пара`, { fontSize: 18, fontWeight: 500, color: DIM, marginTop: 10, lineHeight: 1 }) : null,
    ),
    row({ width: ST_RAIL_W, justifyContent: "center", alignItems: "flex-start", paddingTop: ongoing ? 11 : 18 }, dot(accent, ongoing, 16, anyMine)),
    col(
      { flex: 1, minWidth: 0, paddingLeft: 16, paddingRight: 12 },
      ...s.rows.map((r, i) => {
        const moved = r.status === "moved";
        const meta = [r.isDistance ? "дистанционно" : r.room ? `ауд. ${r.room}` : "", r.subgroup ? `${r.subgroup} подгруппа` : ""].filter(Boolean);
        return col(
          { width: "100%", marginTop: i === 0 ? 4 : 18, paddingTop: i === 0 ? 0 : 16, borderTop: i === 0 ? "none" : `1px solid ${RULE}`, opacity: moved ? 0.5 : 1 },
          groupChips(r.groups, r.mine, accent),
          text(r.subject, { fontSize: r.mine ? 30 : 26, fontWeight: 700, color: r.mine ? FG : SOFT, lineHeight: 1.18, letterSpacing: -0.4, marginTop: 4, textDecoration: moved ? "line-through" : "none" }),
          row(
            { flexWrap: "wrap", alignItems: "center", marginTop: 4 },
            capsule(lessonTypeLabel(r.type), typeTint(r.type)),
            ...meta.map((m) => text(m, { fontSize: 21, fontWeight: 500, color: r.mine ? SOFT : MUTED, marginTop: 6, paddingRight: 14, lineHeight: 1.3 })),
          ),
        );
      }),
    ),
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
      const marker = () => nowMarker(accent.color, DAY_TIME_W, DAY_RAIL_W, now!.minutes);
      for (const o of lessons) {
        const ongoing = isToday && o.start != null && o.end != null && now!.minutes >= o.start && now!.minutes < o.end && o.status === "scheduled";
        if (isToday && !markerPlaced && o.start != null && now!.minutes < o.start) {
          items.push(marker());
          markerPlaced = true;
        }
        if (prevEnd != null && o.start != null && o.start - prevEnd >= 20) items.push(gapRow(o.start - prevEnd));
        if (ongoing) markerPlaced = true;
        items.push(dayLesson(o, accent.color, ongoing, ongoing));
        if (o.status === "scheduled" && o.end != null) prevEnd = o.end;
      }
      if (isToday && !markerPlaced && lessons.length) items.push(marker());

      const active = lessons.filter((o) => o.status === "scheduled");
      const withTime = active.filter((o) => o.start != null && o.end != null);
      const span = withTime.length ? `${fmtHHMM(Math.min(...withTime.map((o) => o.start!)))} – ${fmtHHMM(Math.max(...withTime.map((o) => o.end!)))}` : "";
      const subtitle = [group.title, fmtDayMonth(date), relDay(date, today)].filter(Boolean).join("  ·  ");
      const body = lessons.length
        ? h("div", { display: "flex", flexDirection: "column", width: "100%", position: "relative", marginTop: 40, borderTop: `1px solid ${RULE}` }, railLine(DAY_RAIL_X, 30, 24), ...items)
        : emptyState("Пар нет", "свободный день, можно выспаться");
      const tree = page(accent.color, [
        header(weekdayName(date), subtitle, weekInfo, accent),
        body,
        footer(active.length ? `${active.length} ${pluralPairs(active.length)}${span ? `  ·  ${span}` : ""}` : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },

    async renderWeek(input: WeekRenderInput) {
      const { group, monday, byDate, weekInfo, today, subgroup } = input;
      const accent = accentFor(weekInfo);
      const sections: El[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        const list = filterSubgroup(byDate.get(date) ?? [], subgroup);
        if (i === 6 && !list.length) continue;
        sections.push(weekSection(date, list, accent.color, date === today));
      }
      const subtitle = `${group.title}  ·  ${fmtDayMonth(monday)} – ${fmtDayMonth(addDays(monday, 6))}`;
      const tree = page(accent.color, [header("Неделя", subtitle, weekInfo, accent), col({ width: "100%", marginTop: 26 }, ...sections), footer(group.title, "tt.chuvsu.ru")]);
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
        items.push(streamSlot(s, accent.color, ongoing));
      }
      if (isToday && !markerPlaced && slots.length) items.push(nowMarker(accent.color, ST_TIME_W, ST_RAIL_W, now!.minutes));
      const subtitle = [`Поток 20${intake}`, fmtDayMonth(date), relDay(date, today)].filter(Boolean).join("  ·  ");
      const body = slots.length
        ? h("div", { display: "flex", flexDirection: "column", width: "100%", position: "relative", marginTop: 40, borderTop: `1px solid ${RULE}` }, railLine(ST_RAIL_X, 30, 24), ...items)
        : emptyState("У потока пар нет", "ни у одной группы потока занятий не найдено");
      const tree = page(accent.color, [
        header(weekdayName(date), subtitle, weekInfo, accent),
        body,
        footer(rows.some((r) => r.mine) ? "выделена твоя группа" : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },
  };
}
