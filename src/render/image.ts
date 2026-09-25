/**
 * Schedule posters: satori (JSX-like tree -> SVG) + resvg (SVG -> PNG).
 * No browser, no system fonts: Inter is bundled via @fontsource/inter.
 */
import type { LogicalGroup } from "../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../schedule/model.js";
import type { WeekInfo } from "../schedule/service.js";
import { filterSubgroup, posterTeacher, type TeacherView } from "../schedule/format.js";
import { addDays, fmtDayMonth, fmtHHMM, weekdayName, type LocalDate, type WallClock } from "../time.js";
import { FONT, PAD, W, h, loadFonts, pluralPairs, text, toPng as corePng, type El } from "./core.js";

export interface DayRenderInput {
  /** Poster look for this one render; the bot default when absent. */
  theme?: string;
  /**
   * Что писать в строке пары после аудитории: преподавателя (по умолчанию) или
   * группы — на постере расписания самого преподавателя фамилия там его же.
   */
  labels?: "teacher" | "groups";
  /** Показывать ли преподавателя и выделять ли его; по умолчанию с выделением. */
  teacherView?: TeacherView;
  group: LogicalGroup;
  date: LocalDate;
  lessons: Occurrence[];
  weekInfo: WeekInfo;
  today: LocalDate;
  now?: WallClock;
}

export interface WeekRenderInput {
  /** Poster look for this one render; the bot default when absent. */
  theme?: string;
  /** См. DayRenderInput.labels. */
  labels?: "teacher" | "groups";
  teacherView?: TeacherView;
  group: LogicalGroup;
  monday: LocalDate;
  byDate: Map<LocalDate, Occurrence[]>;
  weekInfo: WeekInfo;
  today: LocalDate;
  subgroup: number | null;
}

export interface StreamRenderRow {
  slot: number | null;
  start: number | null;
  end: number | null;
  subject: string;
  type: string;
  room: string | null;
  isDistance: boolean;
  subgroup: number | null;
  status: Occurrence["status"];
  groups: string[];
  teacher: string | null;
  /** Whether the viewer's own group attends this row. */
  mine: boolean;
}

export interface StreamRenderInput {
  /** Poster look for this one render; the bot default when absent. */
  theme?: string;
  teacherView?: TeacherView;
  intake: number;
  date: LocalDate;
  rows: StreamRenderRow[];
  weekInfo: WeekInfo;
  today: LocalDate;
  now?: WallClock;
}

export interface Renderer {
  renderDay(input: DayRenderInput): Promise<Buffer>;
  renderWeek(input: WeekRenderInput): Promise<Buffer>;
  renderStreamDay(input: StreamRenderInput): Promise<Buffer>;
}

const THEME = {
  bg: "#0b1020",
  card: "#131a2e",
  card2: "#182038",
  line: "#243052",
  fg: "#f4f6fb",
  muted: "#8b95b3",
  dim: "#5b6588",
  accent: "#7c9cff",
};

function typeColor(type: string): string {
  const t = type.toLowerCase();
  if (t === "лк") return "#6ea8ff";
  if (t === "пр") return "#4ade80";
  if (t === "лб") return "#fbbf24";
  if (["экз", "зач", "зачо", "конс"].includes(t)) return "#fb7185";
  return "#c084fc";
}

const WEEKDAY_ACCENT = ["", "#6ea8ff", "#4ade80", "#fbbf24", "#f472b6", "#a78bfa", "#34d399", "#94a3b8"];

// ---------- building blocks ----------
const PARITY = { odd: { label: "НЕЧЁТНАЯ", color: "#fbbf24" }, even: { label: "ЧЁТНАЯ", color: "#38bdf8" } } as const;

function parityPill(info: WeekInfo): El | null {
  if (info.week == null || !info.parity) return null;
  const p = PARITY[info.parity];
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center", padding: "10px 18px", borderRadius: 14, backgroundColor: p.color + "26", border: `2px solid ${p.color}`, marginBottom: 12 },
    h("div", { display: "flex", width: 14, height: 14, borderRadius: 7, backgroundColor: p.color, marginRight: 12 }),
    text(`${p.label} НЕДЕЛЯ`, { fontSize: 22, fontWeight: 800, color: p.color, letterSpacing: 1 }),
    text(`${info.week}-я`, { fontSize: 22, fontWeight: 600, color: THEME.muted, marginLeft: 12, paddingLeft: 12, borderLeft: `2px solid ${p.color}66` }),
  );
}

function header(title: string, subtitle: string, group: LogicalGroup, accent: string, info?: WeekInfo): El {
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", width: "100%" },
    h(
      "div",
      { display: "flex", flexDirection: "column" },
      text(title, { fontSize: 64, fontWeight: 800, color: THEME.fg, letterSpacing: -2, lineHeight: 1.05 }),
      text(subtitle, { fontSize: 28, fontWeight: 500, color: THEME.muted, marginTop: 10 }),
    ),
    h(
      "div",
      { display: "flex", flexDirection: "column", alignItems: "flex-end" },
      info ? parityPill(info) : null,
      h(
        "div",
        { display: "flex", padding: "12px 22px", borderRadius: 999, backgroundColor: accent + "22", border: `2px solid ${accent}66` },
        text(group.title, { fontSize: 30, fontWeight: 700, color: accent }),
      ),
    ),
  );
}

function lessonRow(o: Occurrence, opts: { ongoing: boolean; variantCount: number; teacherView?: TeacherView }): El {
  const color = typeColor(o.type);
  const moved = o.status === "moved";
  const time = o.start != null && o.end != null ? [fmtHHMM(o.start), fmtHHMM(o.end)] : ["—", ""];
  const meta: string[] = [lessonTypeLabel(o.type)];
  if (o.isDistance) meta.push("дистанционно");
  else if (o.room) meta.push(`ауд. ${o.room}`);
  const teacher = posterTeacher(o.teacher, opts.teacherView);

  if (o.subgroup) meta.push(`${o.subgroup} подгруппа`);
  const badges: Array<{ label: string; color: string }> = [];
  if (moved && o.movedTo) badges.push({ label: `перенесена на ${o.movedTo.date.slice(8, 10)}.${o.movedTo.date.slice(5, 7)}${o.movedTo.slot ? `, ${o.movedTo.slot} пара` : ""}`, color: "#fb7185" });
  if (o.movedFrom) badges.push({ label: `перенос с ${o.movedFrom.date.slice(8, 10)}.${o.movedFrom.date.slice(5, 7)}`, color: "#fbbf24" });
  if (o.substituted) badges.push({ label: "замена", color: "#f472b6" });
  if (o.isDistance) badges.push({ label: "ДОТ", color: "#38bdf8" });
  if (opts.ongoing) badges.push({ label: "сейчас", color: "#4ade80" });

  return h(
    "div",
    { display: "flex", flexDirection: "row", width: "100%", backgroundColor: opts.ongoing ? THEME.card2 : THEME.card, borderRadius: 24, padding: "22px 26px", opacity: moved ? 0.55 : 1, border: opts.ongoing ? `2px solid #4ade8066` : `2px solid ${THEME.card}` },
    h(
      "div",
      { display: "flex", flexDirection: "column", width: 150, alignItems: "flex-start" },
      text(time[0]!, { fontSize: 36, fontWeight: 700, color: THEME.fg, lineHeight: 1 }),
      // Конец пары крупно и светло: «когда освобожусь» — такой же частый вопрос, как «когда начало».
      text(time[1] ? `до ${time[1]}` : "", { fontSize: 27, fontWeight: 600, color: THEME.fg, marginTop: 8 }),
      o.slot != null ? text(`${o.slot} пара`, { fontSize: 20, fontWeight: 500, color: THEME.dim, marginTop: 10 }) : null,
    ),
    h("div", { display: "flex", width: 8, borderRadius: 8, backgroundColor: color, marginRight: 26, alignSelf: "stretch" }),
    h(
      "div",
      { display: "flex", flexDirection: "column", flex: 1 },
      text(o.subject, { fontSize: 34, fontWeight: 700, color: THEME.fg, lineHeight: 1.2, textDecoration: moved ? "line-through" : "none" }),
      // Преподаватель — в той же строке, что тип и аудитория: с короткими
      // «ЛК/ПР/ЛБ» он туда помещается. Не поместился — уходит на следующую
      // строку целиком (подпись неразрывная), а не рвётся посередине.
      h(
        "div",
        { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", marginTop: 10 },
        text(meta.join("  ·  "), { fontSize: 24, fontWeight: 500, color: THEME.muted, marginRight: 12 }),
        teacher
          ? text(`·\u00a0${teacher}`, {
              fontSize: 24,
              fontWeight: opts.teacherView === "plain" ? 500 : 700,
              color: opts.teacherView === "plain" ? THEME.muted : THEME.fg,
            })
          : null,
      ),
      badges.length
        ? h(
            "div",
            { display: "flex", flexDirection: "row", flexWrap: "wrap", marginTop: 12 },
            ...badges.map((b) => h("div", { display: "flex", padding: "6px 14px", borderRadius: 999, backgroundColor: b.color + "22", marginRight: 10, marginTop: 6 }, text(b.label, { fontSize: 20, fontWeight: 600, color: b.color }))),
          )
        : null,
    ),
  );
}

function gapRow(minutes: number): El {
  const label = minutes >= 60 ? `окно ${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `перерыв ${minutes} мин`;
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", padding: "4px 0 4px 176px" },
    h("div", { display: "flex", flex: 1, height: 2, backgroundColor: THEME.line }),
    text(label, { fontSize: 20, fontWeight: 500, color: THEME.dim, margin: "0 16px" }),
    h("div", { display: "flex", flex: 1, height: 2, backgroundColor: THEME.line }),
  );
}

function footer(left: string, right: string): El {
  return h(
    "div",
    { display: "flex", flexDirection: "row", justifyContent: "space-between", width: "100%", marginTop: 12 },
    text(left, { fontSize: 24, fontWeight: 600, color: THEME.muted }),
    text(right, { fontSize: 22, fontWeight: 500, color: THEME.dim }),
  );
}

function page(children: unknown[]): El {
  return h("div", { display: "flex", flexDirection: "column", width: W, padding: PAD, backgroundColor: THEME.bg, fontFamily: FONT }, ...children);
}

function subtitleFor(date: LocalDate, info: WeekInfo, today: LocalDate): string {
  const rel = date === today ? "сегодня" : date === addDays(today, 1) ? "завтра" : date === addDays(today, -1) ? "вчера" : "";
  return [fmtDayMonth(date), rel].filter(Boolean).join("  ·  ");
}

// ---------- renderer ----------
export async function createRenderer(): Promise<Renderer | null> {
  const fonts = await loadFonts();

  const toPng = (tree: El): Promise<Buffer> => corePng(tree, fonts);

  return {
    async renderDay(input) {
      const { group, date, weekInfo, today, now } = input;
      const list = input.lessons;
      const accent = WEEKDAY_ACCENT[new Date(date).getUTCDay() || 7] ?? THEME.accent;
      const rows: unknown[] = [];
      let prevEnd: number | null = null;
      for (const o of list) {
        if (prevEnd != null && o.start != null && o.start - prevEnd >= 20) rows.push(gapRow(o.start - prevEnd));
        const ongoing = !!now && now.date === date && o.start != null && o.end != null && now.minutes >= o.start && now.minutes < o.end && o.status === "scheduled";
        rows.push(h("div", { display: "flex", width: "100%", marginTop: 14 }, lessonRow(o, { ongoing, variantCount: group.portalIds.length, teacherView: input.teacherView })));
        if (o.status === "scheduled" && o.end != null) prevEnd = o.end;
      }
      const active = list.filter((o) => o.status === "scheduled");
      const withTime = active.filter((o) => o.start != null && o.end != null);
      const span = withTime.length ? `${fmtHHMM(Math.min(...withTime.map((o) => o.start!)))} – ${fmtHHMM(Math.max(...withTime.map((o) => o.end!)))}` : "";
      const body = list.length
        ? rows
        : [h("div", { display: "flex", flexDirection: "column", alignItems: "center", width: "100%", padding: "80px 0" }, text("Пар нет", { fontSize: 56, fontWeight: 800, color: THEME.fg }), text("можно выспаться", { fontSize: 28, color: THEME.muted, marginTop: 12 }))];
      const tree = page([
        header(weekdayName(date), subtitleFor(date, weekInfo, today), group, accent, weekInfo),
        h("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: 34 }, ...body),
        footer(active.length ? `${active.length} ${pluralPairs(active.length)}${span ? `  ·  ${span}` : ""}` : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },

    async renderStreamDay(input) {
      const { intake, date, rows, weekInfo, today, now } = input;
      const accent = WEEKDAY_ACCENT[new Date(date).getUTCDay() || 7] ?? THEME.accent;
      const pseudo: LogicalGroup = { key: "", title: `Поток 20${intake}`, prefix: "", number: 0, intake, course: 0, portalIds: [], portalNames: [] };
      // Group rows by slot/time.
      const slots: Array<{ key: string; slot: number | null; start: number | null; end: number | null; rows: StreamRenderRow[] }> = [];
      for (const r of rows) {
        const key = `${r.slot ?? "-"}|${r.start ?? "-"}`;
        const last = slots[slots.length - 1];
        if (last && last.key === key) last.rows.push(r);
        else slots.push({ key, slot: r.slot, start: r.start, end: r.end, rows: [r] });
      }
      const blocks = slots.map((s) => {
        const ongoing = !!now && now.date === date && s.start != null && s.end != null && now.minutes >= s.start && now.minutes < s.end;
        return h(
          "div",
          { display: "flex", flexDirection: "row", width: "100%", marginTop: 16, backgroundColor: ongoing ? THEME.card2 : THEME.card, borderRadius: 24, padding: "20px 24px", border: ongoing ? "2px solid #4ade8066" : `2px solid ${THEME.card}` },
          h(
            "div",
            { display: "flex", flexDirection: "column", width: 140 },
            text(s.start != null ? fmtHHMM(s.start) : "—", { fontSize: 34, fontWeight: 700, color: THEME.fg, lineHeight: 1 }),
            text(s.end != null ? fmtHHMM(s.end) : "", { fontSize: 22, fontWeight: 500, color: THEME.muted, marginTop: 6 }),
            s.slot != null ? text(`${s.slot} пара`, { fontSize: 20, fontWeight: 500, color: THEME.dim, marginTop: 8 }) : null,
          ),
          h(
            "div",
            { display: "flex", flexDirection: "column", flex: 1 },
            ...s.rows.map((r, i) =>
              h(
                "div",
                { display: "flex", flexDirection: "row", alignItems: "flex-start", width: "100%", marginTop: i === 0 ? 0 : 14, opacity: r.status === "moved" ? 0.55 : 1 },
                h("div", { display: "flex", width: 8, borderRadius: 8, backgroundColor: typeColor(r.type), marginRight: 18, alignSelf: "stretch" }),
                h(
                  "div",
                  { display: "flex", flexDirection: "column", flex: 1 },
                  h(
                    "div",
                    { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
                    ...r.groups.map((g) =>
                      h(
                        "div",
                        { display: "flex", padding: "4px 12px", borderRadius: 999, backgroundColor: r.mine ? accent + "33" : THEME.line, marginRight: 8, marginBottom: 6, border: r.mine ? `2px solid ${accent}` : `2px solid ${THEME.line}` },
                        text(g, { fontSize: 20, fontWeight: 700, color: r.mine ? THEME.fg : THEME.muted }),
                      ),
                    ),
                  ),
                  text(r.subject, { fontSize: 28, fontWeight: 700, color: THEME.fg, lineHeight: 1.2, textDecoration: r.status === "moved" ? "line-through" : "none" }),
                  h(
                    "div",
                    { display: "flex", flexDirection: "row", alignItems: "baseline", marginTop: 4 },
                    text([lessonTypeLabel(r.type), r.isDistance ? "дистанционно" : r.room ? `ауд. ${r.room}` : "", r.subgroup ? `${r.subgroup} подгруппа` : ""].filter(Boolean).join("  ·  "), { fontSize: 22, fontWeight: 500, color: THEME.muted }),
                    posterTeacher(r.teacher, input.teacherView)
                      ? text(`· ${posterTeacher(r.teacher, input.teacherView)}`, { marginLeft: 8, fontSize: 22, fontWeight: input.teacherView === "plain" ? 500 : 700, color: input.teacherView === "plain" ? THEME.muted : THEME.fg })
                      : null,
                  ),
                ),
              ),
            ),
          ),
        );
      });
      const body = blocks.length ? blocks : [h("div", { display: "flex", flexDirection: "column", alignItems: "center", width: "100%", padding: "80px 0" }, text("У потока пар нет", { fontSize: 52, fontWeight: 800, color: THEME.fg }))];
      const tree = page([
        header(weekdayName(date), subtitleFor(date, weekInfo, today), pseudo, accent, weekInfo),
        h("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: 30 }, ...body),
        footer(rows.some((r) => r.mine) ? "выделена твоя группа" : "", `tt.chuvsu.ru  ·  ${now ? fmtHHMM(now.minutes) : ""}`),
      ]);
      return toPng(tree);
    },

    async renderWeek(input) {
      const { group, monday, byDate, weekInfo, today, subgroup } = input;
      const sections: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        const date = addDays(monday, i);
        const list = filterSubgroup(byDate.get(date) ?? [], subgroup);
        const accent = WEEKDAY_ACCENT[i + 1] ?? THEME.accent;
        const isToday = date === today;
        const rows = list.length
          ? list.map((o) =>
              h(
                "div",
                { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", padding: "10px 0", borderBottom: `2px solid ${THEME.line}` },
                h(
                  "div",
                  { display: "flex", flexDirection: "column", width: 110, flexShrink: 0 },
                  text(o.start != null ? fmtHHMM(o.start) : "—", { fontSize: 26, fontWeight: 700, color: THEME.fg, lineHeight: 1.1 }),
                  text(o.end != null ? fmtHHMM(o.end) : "", { fontSize: 21, fontWeight: 500, color: THEME.muted, marginTop: 4, lineHeight: 1 }),
                ),
                h("div", { display: "flex", width: 6, height: 34, borderRadius: 6, backgroundColor: typeColor(o.type), marginRight: 18 }),
                h(
                  "div",
                  { display: "flex", flexDirection: "column", flex: 1 },
                  text(o.subject, { fontSize: 27, fontWeight: 600, color: o.status === "moved" ? THEME.dim : THEME.fg, textDecoration: o.status === "moved" ? "line-through" : "none", lineHeight: 1.15 }),
                  h(
                    "div",
                    { display: "flex", flexDirection: "row", alignItems: "baseline", marginTop: 4 },
                    text([lessonTypeLabel(o.type), o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.movedFrom ? "перенос" : "", o.substituted ? "замена" : ""].filter(Boolean).join("  ·  "), { fontSize: 21, color: THEME.muted }),
                    posterTeacher(o.teacher, input.teacherView)
                      ? text(`· ${posterTeacher(o.teacher, input.teacherView)}`, {
                          marginLeft: 8,
                          fontSize: 21,
                          fontWeight: input.teacherView === "plain" ? 400 : 700,
                          color: input.teacherView === "plain" ? THEME.muted : THEME.fg,
                        })
                      : null,
                  ),
                ),
              ),
            )
          : [text("пар нет", { fontSize: 24, color: THEME.dim, padding: "8px 0" })];
        sections.push(
          h(
            "div",
            { display: "flex", flexDirection: "column", width: "100%", marginTop: 26, backgroundColor: isToday ? THEME.card2 : THEME.card, borderRadius: 24, padding: "20px 26px", border: `2px solid ${isToday ? accent + "88" : THEME.card}` },
            h(
              "div",
              { display: "flex", flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", width: "100%", marginBottom: 6 },
              h("div", { display: "flex", flexDirection: "row", alignItems: "baseline" }, text(weekdayName(date), { fontSize: 32, fontWeight: 800, color: accent }), text(`${fmtDayMonth(date)}${isToday ? "  ·  сегодня" : ""}`, { fontSize: 24, color: THEME.muted, marginLeft: 16 })),
              text(list.filter((o) => o.status === "scheduled").length ? `${list.filter((o) => o.status === "scheduled").length} ${pluralPairs(list.filter((o) => o.status === "scheduled").length)}` : "", { fontSize: 22, color: THEME.dim }),
            ),
            ...rows,
          ),
        );
      }
      // Total lessons of the week, so the footer says as much as the day poster does.
      const weekTotal = [...byDate.values()].flat().filter((o) => o.status === "scheduled" && (!subgroup || o.subgroup == null || o.subgroup === subgroup)).length;
      const tree = page([
        header("Неделя", `${fmtDayMonth(monday)} – ${fmtDayMonth(addDays(monday, 6))}`, group, THEME.accent, weekInfo),
        h("div", { display: "flex", flexDirection: "column", width: "100%", marginTop: 10 }, ...sections),
        footer(weekTotal ? `${weekTotal} ${pluralPairs(weekTotal)} за неделю` : "", "tt.chuvsu.ru"),
      ]);
      return toPng(tree);
    },
  };
}
