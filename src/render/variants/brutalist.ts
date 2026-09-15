/**
 * "brutalist" poster theme: neo-brutalist flyer. Flat saturated blocks, thick
 * black borders, hard offset shadows (a solid block behind, no blur), zero
 * radius, oversized ultra-bold uppercase headings. The week parity decides the
 * dominant colour of the header block (acid yellow = odd, lilac = even).
 */
import type { LogicalGroup } from "../../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import type { WeekInfo } from "../../schedule/service.js";
import { filterSubgroup } from "../../schedule/format.js";
import { addDays, fmtDayMonth, fmtHHMM, weekdayName, type LocalDate } from "../../time.js";
import { FONT, PAD, W, h, loadFonts, pluralPairs, text, toPng as corePng, type El } from "../core.js";
import type { DayRenderInput, Renderer, StreamRenderInput, StreamRenderRow, WeekRenderInput } from "../image.js";

const INK = "#111111";
const PAPER = "#efece3";
const CARD = "#fbfaf5";
const MUTED = "#4c4a45";
/** Secondary text on an inverted (ink) block: light enough to stay readable at phone size. */
const INV_SUB = "#d0cdc4";
const ODD = "#d9ff00";
const EVEN = "#b8a6ff";
const NEUTRAL = "#d8d4c6";
const BORDER = 4;
const SHADOW = 10;
/** Own-group marker width in the stream poster. */
const MINE_BAR = 10;

const up = (s: string): string => s.toUpperCase();

/** Type-tag hues. Weekday headers deliberately do NOT reuse these (colour = one meaning). */
function typeColor(type: string): string {
  const t = type.replace(/\.$/, "").toLowerCase();
  if (t === "лк") return "#8fd3ff";
  if (t === "пр") return "#7dffb3";
  if (t === "лб") return "#ffc247";
  if (["экз", "зач", "зачо", "конс"].includes(t)) return "#ff9a8b";
  return "#e2b8ff";
}

interface Parity {
  color: string;
  label: string | null;
  week: number | null;
}

function parityOf(info: WeekInfo): Parity {
  if (!info.parity) return { color: NEUTRAL, label: null, week: info.week };
  return { color: info.parity === "odd" ? ODD : EVEN, label: info.parity === "odd" ? "НЕЧЁТНАЯ" : "ЧЁТНАЯ", week: info.week };
}

/** Bordered block with a hard offset solid shadow behind it. */
function block(style: Record<string, string | number>, ...children: unknown[]): El {
  return h(
    "div",
    { display: "flex", position: "relative", width: "100%", paddingRight: SHADOW, paddingBottom: SHADOW },
    h("div", { display: "flex", position: "absolute", top: SHADOW, left: SHADOW, right: 0, bottom: 0, backgroundColor: INK }),
    h("div", { display: "flex", flexDirection: "column", width: "100%", border: `${BORDER}px solid ${INK}`, backgroundColor: CARD, ...style }, ...children),
  );
}

/** Small solid tag: colored fill + black border. Default size sits above the 22 px floor. */
function tag(label: string, opts: { bg: string; fg?: string; size?: number; border?: string; mr?: number; mt?: number }): El {
  return h(
    "div",
    { display: "flex", padding: "5px 12px 4px", backgroundColor: opts.bg, border: `3px solid ${opts.border ?? INK}`, marginRight: opts.mr ?? 10, marginTop: opts.mt ?? 0 },
    text(up(label), { fontSize: opts.size ?? 24, fontWeight: 800, color: opts.fg ?? INK, letterSpacing: 1, lineHeight: 1.1 }),
  );
}

/** Ink chip with text in the parity colour (used for "сегодня", group title). */
function inkChip(label: string, color: string, size: number, ml = 0): El {
  return h("div", { display: "flex", padding: size >= 30 ? "10px 20px" : "7px 14px 6px", backgroundColor: INK, marginLeft: ml, flexShrink: 0 }, text(up(label), { fontSize: size, fontWeight: 800, color, letterSpacing: size >= 30 ? 1 : 2, lineHeight: 1 }));
}

function relDate(date: LocalDate, today: LocalDate): string {
  return date === today ? "сегодня" : date === addDays(today, 1) ? "завтра" : date === addDays(today, -1) ? "вчера" : "";
}

/** Rough advance width of uppercase Inter 800 (satori gives no measuring API). Deliberately over-estimates. */
function approxWidth(s: string, size: number, letterSpacing = 0): number {
  return s.length * (size * 0.62 + letterSpacing);
}

/** Inner content width of the header block (page minus padding, shadow, border and block padding). */
const HEADER_INNER = W - 2 * PAD - SHADOW - 2 * BORDER - 60;

/**
 * Pick font sizes for the header date line + group chip so a long group title
 * ("ВИШ-11-23 (РЗИАЭС)") next to a long date range cannot overflow the block.
 * Every step stays above the 22 px legibility floor.
 */
function headerRowSizes(dateLine: string, rel: string | undefined, groupTitle: string): { date: number; chip: number } {
  const relW = rel ? approxWidth(up(rel), 24, 2) + 28 + 16 : 0;
  for (const [date, chip] of [
    [38, 32],
    [34, 30],
    [32, 28],
    [30, 26],
    [28, 24],
  ] as const) {
    const chipW = approxWidth(up(groupTitle), chip, chip >= 30 ? 1 : 2) + (chip >= 30 ? 40 : 28) + 16;
    if (approxWidth(up(dateLine), date) + relW + chipW <= HEADER_INNER) return { date, chip };
  }
  return { date: 28, chip: 24 };
}

/**
 * Header block (parity colour) + black parity strip.
 * Row 1: title + week number block (fills the right side); row 2: date line + rel chip + group chip.
 */
function header(opts: { title: string; dateLine: string; rel?: string; groupTitle: string; info: WeekInfo }): El {
  const p = parityOf(opts.info);
  const size = headerRowSizes(opts.dateLine, opts.rel, opts.groupTitle);
  const title = up(opts.title);
  const titleSize = title.length >= 10 ? 80 : 100;
  const strip = p.label
    ? h(
        "div",
        { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", backgroundColor: INK, marginTop: 18, border: `${BORDER}px solid ${INK}`, padding: "14px 24px" },
        text(`${p.label} НЕДЕЛЯ`, { fontSize: 44, fontWeight: 800, color: p.color, letterSpacing: 1, lineHeight: 1 }),
      )
    : null;
  return h(
    "div",
    { display: "flex", flexDirection: "column", width: "100%" },
    block(
      { backgroundColor: p.color, padding: "26px 30px 28px" },
      h(
        "div",
        { display: "flex", flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", width: "100%" },
        text(title, { fontSize: titleSize, fontWeight: 800, color: INK, letterSpacing: -3, lineHeight: 0.95, flex: 1, minWidth: 0 }),
        p.week != null
          ? h(
              "div",
              { display: "flex", flexDirection: "column", alignItems: "center", backgroundColor: INK, padding: "12px 22px 10px", marginLeft: 20, flexShrink: 0 },
              text(`${p.week}-Я`, { fontSize: 64, fontWeight: 800, color: p.color, lineHeight: 1, letterSpacing: -1 }),
              text("НЕДЕЛЯ", { fontSize: 22, fontWeight: 800, color: p.color, lineHeight: 1, letterSpacing: 3, marginTop: 8 }),
            )
          : null,
      ),
      h(
        "div",
        { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", marginTop: 24, paddingTop: 20, borderTop: `${BORDER}px solid ${INK}` },
        text(up(opts.dateLine), { fontSize: size.date, fontWeight: 800, color: INK, letterSpacing: 0, lineHeight: 1, flexShrink: 0 }),
        opts.rel ? inkChip(opts.rel, p.color, 24, 16) : null,
        h("div", { display: "flex", flex: 1, minWidth: 16 }),
        inkChip(opts.groupTitle, p.color, size.chip, 16),
      ),
    ),
    strip,
  );
}

function footer(left: string, right: string): El {
  return h(
    "div",
    { display: "flex", flexDirection: "row", justifyContent: "space-between", alignItems: "center", width: "100%", marginTop: 26, paddingTop: 16, borderTop: `${BORDER}px solid ${INK}` },
    text(up(left), { fontSize: 24, fontWeight: 800, color: INK, letterSpacing: 1 }),
    text(right, { fontSize: 22, fontWeight: 600, color: MUTED, letterSpacing: 1 }),
  );
}

function page(children: unknown[]): El {
  return h("div", { display: "flex", flexDirection: "column", width: W, padding: PAD, backgroundColor: PAPER, fontFamily: FONT }, ...children);
}

function timeCol(start: number | null, end: number | null, slot: number | null, inverted: boolean, width: number): El {
  const fg = inverted ? CARD : INK;
  const sub = inverted ? INV_SUB : MUTED;
  return h(
    "div",
    { display: "flex", flexDirection: "column", width, flexShrink: 0, padding: "18px 0 18px 20px" },
    text(start != null ? fmtHHMM(start) : "—", { fontSize: 42, fontWeight: 800, color: fg, letterSpacing: 1, lineHeight: 1 }),
    text(end != null ? fmtHHMM(end) : "", { fontSize: 26, fontWeight: 600, color: sub, letterSpacing: 1, marginTop: 6 }),
    slot != null ? text(`${slot} ПАРА`, { fontSize: 24, fontWeight: 800, color: sub, letterSpacing: 2, marginTop: 12 }) : null,
  );
}

/** Full-width shout strip across the top of the ongoing (inverted) block. */
function nowStrip(accent: string, end: number | null): El {
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "100%", backgroundColor: accent, padding: "10px 22px 9px", borderBottom: `${BORDER}px solid ${INK}` },
    text("СЕЙЧАС ИДЁТ", { fontSize: 26, fontWeight: 800, color: INK, letterSpacing: 3, lineHeight: 1 }),
    end != null ? text(`ДО ${fmtHHMM(end)}`, { fontSize: 26, fontWeight: 800, color: INK, letterSpacing: 2, lineHeight: 1 }) : null,
  );
}

function lessonRow(o: Occurrence, ongoing: boolean, accent: string): El {
  const moved = o.status === "moved";
  const inv = ongoing;
  const fg = inv ? CARD : INK;
  const sub = inv ? INV_SUB : MUTED;
  const meta: string[] = [];
  if (o.isDistance) meta.push("дистанционно");
  else if (o.room) meta.push(`ауд. ${o.room}`);
  if (o.subgroup) meta.push(`${o.subgroup} подгруппа`);
  const badges: Array<{ label: string; bg: string }> = [];
  if (moved && o.movedTo) badges.push({ label: `перенесена на ${o.movedTo.date.slice(8, 10)}.${o.movedTo.date.slice(5, 7)}${o.movedTo.slot ? `, ${o.movedTo.slot} пара` : ""}`, bg: "#ff9a8b" });
  if (o.movedFrom) badges.push({ label: `перенос с ${o.movedFrom.date.slice(8, 10)}.${o.movedFrom.date.slice(5, 7)}`, bg: "#ffc247" });
  if (o.substituted) badges.push({ label: "замена", bg: "#ff9a8b" });

  return block(
    { flexDirection: "column", backgroundColor: inv ? INK : CARD, opacity: moved ? 0.6 : 1 },
    ongoing ? nowStrip(accent, o.end) : null,
    h(
      "div",
      { display: "flex", flexDirection: "row", alignItems: "stretch", width: "100%" },
      timeCol(o.start, o.end, o.slot, inv, 190),
      h("div", { display: "flex", width: BORDER, backgroundColor: inv ? CARD : INK, flexShrink: 0 }),
      h(
        "div",
        { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, padding: "18px 22px 18px 22px" },
        text(o.subject, { fontSize: 34, fontWeight: 700, color: fg, lineHeight: 1.15, textDecoration: moved ? "line-through" : "none" }),
        h(
          "div",
          { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", width: "100%", marginTop: 10 },
          tag(lessonTypeLabel(o.type), { bg: typeColor(o.type), mt: 6, border: inv ? typeColor(o.type) : INK }),
          ...meta.map((m) => text(up(m), { fontSize: 24, fontWeight: 700, color: fg, letterSpacing: 1, marginRight: 16, marginTop: 6 })),
        ),
        o.teacher ? text(o.teacher, { fontSize: 24, fontWeight: 500, color: sub, marginTop: 8 }) : null,
        badges.length
          ? h("div", { display: "flex", flexDirection: "row", flexWrap: "wrap", width: "100%", marginTop: 8 }, ...badges.map((b) => tag(b.label, { bg: b.bg, mt: 6, border: inv ? b.bg : INK })))
          : null,
      ),
    ),
  );
}

/** Break between lessons: solid 4 px rules flanking a small ink label block. */
function gapRow(minutes: number): El {
  const label = minutes >= 60 ? `окно ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `перерыв ${minutes} мин`;
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", padding: "10px 0 6px 0" },
    h("div", { display: "flex", width: 190, height: BORDER, backgroundColor: INK }),
    h("div", { display: "flex", padding: "7px 16px 6px", backgroundColor: INK, flexShrink: 0 }, text(up(label), { fontSize: 22, fontWeight: 800, color: CARD, letterSpacing: 2, lineHeight: 1 })),
    h("div", { display: "flex", flex: 1, height: BORDER, backgroundColor: INK }),
  );
}

function emptyBlock(title: string, subtitle: string, accent: string): El {
  return block(
    { alignItems: "flex-start", padding: "44px 34px", backgroundColor: INK },
    text(up(title), { fontSize: 76, fontWeight: 800, color: accent, letterSpacing: -2, lineHeight: 1 }),
    text(up(subtitle), { fontSize: 26, fontWeight: 700, color: CARD, letterSpacing: 2, marginTop: 16 }),
  );
}

export async function createRenderer(): Promise<Renderer | null> {
  const fonts = await loadFonts();
  const toPng = (tree: El): Promise<Buffer> => corePng(tree, fonts);

  return {
    async renderDay(input: DayRenderInput) {
      const { group, date, weekInfo, today, now } = input;
      const list = input.lessons;
      const p = parityOf(weekInfo);
      const rows: unknown[] = [];
      let prevEnd: number | null = null;
      for (const o of list) {
        if (prevEnd != null && o.start != null && o.start - prevEnd >= 20) rows.push(gapRow(o.start - prevEnd));
        const ongoing = !!now && now.date === date && o.start != null && o.end != null && now.minutes >= o.start && now.minutes < o.end && o.status === "scheduled";
        rows.push(h("div", { display: "flex", width: "100%", marginTop: 14 }, lessonRow(o, ongoing, p.color)));
        if (o.status === "scheduled" && o.end != null) prevEnd = o.end;
      }
      const active = list.filter((o) => o.status === "scheduled");
      const withTime = active.filter((o) => o.start != null && o.end != null);
      const span = withTime.length ? `${fmtHHMM(Math.min(...withTime.map((o) => o.start!)))} – ${fmtHHMM(Math.max(...withTime.map((o) => o.end!)))}` : "";
      const body = list.length ? rows : [h("div", { display: "flex", width: "100%", marginTop: 14 }, emptyBlock("Пар нет", "можно выспаться", p.color))];
      const rel = relDate(date, today);
      const tree = page([
        header({ title: weekdayName(date), dateLine: fmtDayMonth(date), rel: rel || undefined, groupTitle: group.title, info: weekInfo }),
        h("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: 20 }, ...body),
        footer(active.length ? `${active.length} ${pluralPairs(active.length)}${span ? `  /  ${span}` : ""}` : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },

    async renderWeek(input: WeekRenderInput) {
      // Total lessons of the week, so the footer says as much as the day poster does.
      const weekTotal = [...input.byDate.values()].flat().filter((o) => o.status === "scheduled" && (!input.subgroup || o.subgroup == null || o.subgroup === input.subgroup)).length;
      const { group, monday, byDate, weekInfo, today, subgroup } = input;
      const p = parityOf(weekInfo);
      const sections: unknown[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        const list = filterSubgroup(byDate.get(date) ?? [], subgroup);
        if (i === 6 && !list.length) continue;
        const isToday = date === today;
        const count = list.filter((o) => o.status === "scheduled").length;
        const rows = list.length
          ? list.map((o, k) => {
              const moved = o.status === "moved";
              const meta = [o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.movedFrom ? "перенос" : "", o.substituted ? "замена" : ""].filter(Boolean);
              return h(
                "div",
                { display: "flex", flexDirection: "row", alignItems: "stretch", width: "100%", borderTop: k === 0 ? "none" : `${BORDER}px solid ${INK}`, opacity: moved ? 0.55 : 1 },
                h("div", { display: "flex", width: 134, flexShrink: 0, alignItems: "flex-start", padding: "14px 0 14px 20px" }, text(o.start != null ? fmtHHMM(o.start) : "—", { fontSize: 30, fontWeight: 800, color: INK, letterSpacing: 1, lineHeight: 1.1 })),
                h("div", { display: "flex", width: BORDER, backgroundColor: INK, flexShrink: 0 }),
                h(
                  "div",
                  { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, padding: "12px 18px 14px" },
                  text(o.subject, { fontSize: 27, fontWeight: 700, color: INK, lineHeight: 1.15, textDecoration: moved ? "line-through" : "none" }),
                  h(
                    "div",
                    { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", width: "100%", marginTop: 4 },
                    tag(lessonTypeLabel(o.type), { bg: typeColor(o.type), size: 24, mt: 6 }),
                    ...meta.map((m) => text(up(m), { fontSize: 24, fontWeight: 700, color: MUTED, letterSpacing: 1, marginRight: 14, marginTop: 6 })),
                  ),
                ),
              );
            })
          : [h("div", { display: "flex", padding: "16px 20px" }, text("ПАР НЕТ", { fontSize: 24, fontWeight: 800, color: MUTED, letterSpacing: 2 }))];
        // Weekday names are all paper-white on ink; only "today" takes the parity colour, so hue means one thing.
        sections.push(
          h(
            "div",
            { display: "flex", width: "100%", marginTop: 22 },
            block(
              { backgroundColor: CARD },
              h(
                "div",
                { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", backgroundColor: isToday ? p.color : INK, padding: "12px 20px", borderBottom: `${BORDER}px solid ${INK}` },
                text(up(weekdayName(date)), { fontSize: 34, fontWeight: 800, color: isToday ? INK : CARD, letterSpacing: 1, lineHeight: 1 }),
                text(up(fmtDayMonth(date)), { fontSize: 24, fontWeight: 700, color: isToday ? INK : INV_SUB, letterSpacing: 2, marginLeft: 24, lineHeight: 1 }),
                isToday ? inkChip("сегодня", p.color, 22, 16) : null,
                h("div", { display: "flex", flex: 1 }),
                text(count ? up(`${count} ${pluralPairs(count)}`) : "", { fontSize: 22, fontWeight: 800, color: isToday ? INK : INV_SUB, letterSpacing: 2, lineHeight: 1 }),
              ),
              ...rows,
            ),
          ),
        );
      }
      const tree = page([
        header({ title: "Неделя", dateLine: `${fmtDayMonth(monday)} – ${fmtDayMonth(addDays(monday, 6))}`, groupTitle: group.title, info: weekInfo }),
        h("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: 4 }, ...sections),
        footer(weekTotal ? `${weekTotal} ${pluralPairs(weekTotal).toUpperCase()} ЗА НЕДЕЛЮ` : "", "tt.chuvsu.ru"),
      ]);
      return toPng(tree);
    },

    async renderStreamDay(input: StreamRenderInput) {
      const { intake, date, rows, weekInfo, today, now } = input;
      const p = parityOf(weekInfo);
      const slots: Array<{ key: string; slot: number | null; start: number | null; end: number | null; rows: StreamRenderRow[] }> = [];
      for (const r of rows) {
        const key = `${r.slot ?? "-"}|${r.start ?? "-"}`;
        const last = slots[slots.length - 1];
        if (last && last.key === key) last.rows.push(r);
        else slots.push({ key, slot: r.slot, start: r.start, end: r.end, rows: [r] });
      }
      const blocks = slots.map((s) => {
        const ongoing = !!now && now.date === date && s.start != null && s.end != null && now.minutes >= s.start && now.minutes < s.end;
        const inv = ongoing;
        const fg = inv ? CARD : INK;
        const sub = inv ? INV_SUB : MUTED;
        const rule = inv ? CARD : INK;
        return h(
          "div",
          { display: "flex", width: "100%", marginTop: 14 },
          block(
            { flexDirection: "column", backgroundColor: inv ? INK : CARD },
            ongoing ? nowStrip(p.color, s.end) : null,
            h(
              "div",
              { display: "flex", flexDirection: "row", alignItems: "stretch", width: "100%" },
              timeCol(s.start, s.end, s.slot, inv, 170),
              h("div", { display: "flex", width: BORDER, backgroundColor: rule, flexShrink: 0 }),
              h(
                "div",
                { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
                ...s.rows.map((r, i) => {
                  const moved = r.status === "moved";
                  const meta = [r.isDistance ? "дистанционно" : r.room ? `ауд. ${r.room}` : "", r.subgroup ? `${r.subgroup} подгр.` : ""].filter(Boolean);
                  // Own group: one signal everywhere — solid parity bar on the left + parity tag. Same in normal and inverted blocks.
                  return h(
                    "div",
                    { display: "flex", flexDirection: "row", alignItems: "stretch", width: "100%", borderTop: i === 0 ? "none" : `${BORDER}px solid ${rule}`, opacity: moved ? 0.55 : 1 },
                    h("div", { display: "flex", width: MINE_BAR, flexShrink: 0, backgroundColor: r.mine ? p.color : "transparent" }),
                    h(
                      "div",
                      { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, padding: "16px 20px 16px 14px" },
                      h(
                        "div",
                        { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", width: "100%" },
                        ...r.groups.map((g) => (r.mine ? tag(g, { bg: p.color, fg: INK, size: 24, border: inv ? p.color : INK, mr: 8, mt: 0 }) : tag(g, { bg: inv ? INK : CARD, fg: sub, size: 24, border: inv ? INV_SUB : INK, mr: 8, mt: 0 }))),
                      ),
                      text(r.subject, { fontSize: 30, fontWeight: 700, color: fg, lineHeight: 1.15, marginTop: 10, textDecoration: moved ? "line-through" : "none" }),
                      h(
                        "div",
                        { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", width: "100%", marginTop: 4 },
                        tag(lessonTypeLabel(r.type), { bg: typeColor(r.type), size: 24, mt: 6, border: inv ? typeColor(r.type) : INK }),
                        ...meta.map((m) => text(up(m), { fontSize: 24, fontWeight: 700, color: sub, letterSpacing: 1, marginRight: 14, marginTop: 6 })),
                      ),
                    ),
                  );
                }),
              ),
            ),
          ),
        );
      });
      const body = blocks.length ? blocks : [h("div", { display: "flex", width: "100%", marginTop: 14 }, emptyBlock("У потока пар нет", "свободный день", p.color))];
      const rel = relDate(date, today);
      const tree = page([
        header({ title: weekdayName(date), dateLine: fmtDayMonth(date), rel: rel || undefined, groupTitle: `Поток 20${intake}`, info: weekInfo }),
        h("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: 20 }, ...body),
        footer(rows.some((r) => r.mine) ? "выделена твоя группа" : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },
  };
}
