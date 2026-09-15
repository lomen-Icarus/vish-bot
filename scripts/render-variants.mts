/**
 * Render every poster theme (day, week, stream) with real data from the local
 * database into out/variants/<theme>-{day,week,stream}.png.
 *   PORTAL_TLS_INSECURE=1 npx tsx scripts/render-variants.mts [theme...] [--group 12-23] [--date 2026-09-15]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { PortalClient } from "../src/portal/client.js";
import { ScheduleService } from "../src/schedule/service.js";
import { findGroup } from "../src/schedule/groups.js";
import { mergeStream } from "../src/schedule/stream.js";
import { THEMES, createThemedRenderer } from "../src/render/themes.js";
import type { Occurrence } from "../src/schedule/model.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../src/time.js";

loadDotEnv();
const config = loadConfig({ ...process.env, BOT_TOKEN: process.env.BOT_TOKEN ?? "x".repeat(30) });
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const themes = args.filter((a) => !a.startsWith("--") && !args.includes(`--${a}`) && (THEMES as readonly string[]).includes(a));
const wanted = themes.length ? themes : [...THEMES];
const groupQuery = opt("group", "12-23");
const date = opt("date", todayMsk()) as LocalDate;

const repo = new Repo(openDatabase(config.DB_PATH));
const service = new ScheduleService(repo, new PortalClient({ insecureTls: config.PORTAL_TLS_INSECURE, proxyUrl: config.HTTPS_PROXY }), { facultyId: config.FACULTY_ID, hiddenPrefixes: config.HIDDEN_GROUP_PREFIXES });
const group = findGroup(service.groups(), groupQuery)[0];
if (!group) throw new Error(`group ${groupQuery} not found; groups: ${service.groups().map((g) => g.title).join(", ")}`);
mkdirSync("out/variants", { recursive: true });

const monday = mondayOf(date);
const byDate = new Map<LocalDate, Occurrence[]>();
for (const o of service.materialize(group, monday, addDays(monday, 6))) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);
const streamGroups = service.stream(group.intake);
const streamBy = new Map<string, Occurrence[]>();
for (const g of streamGroups) streamBy.set(g.key, service.materialize(g, date, date));
const rows = mergeStream(streamGroups, streamBy).filter((r) => r.date === date).map((r) => ({ ...r, mine: r.groupKeys.includes(group.key) }));

for (const theme of wanted) {
  const renderer = await createThemedRenderer(theme);
  if (!renderer) throw new Error(`renderer ${theme} unavailable`);
  const t0 = Date.now();
  writeFileSync(`out/variants/${theme}-day.png`, await renderer.renderDay({ group, date, lessons: service.lessonsOn(group, date), weekInfo: service.weekInfo(date), today: todayMsk(), now: wallClock() }));
  writeFileSync(`out/variants/${theme}-week.png`, await renderer.renderWeek({ group, monday, byDate, weekInfo: service.weekInfo(monday), today: todayMsk(), subgroup: null }));
  writeFileSync(`out/variants/${theme}-stream.png`, await renderer.renderStreamDay({ intake: group.intake, date, rows, weekInfo: service.weekInfo(date), today: todayMsk(), now: wallClock() }));
  console.log(`${theme}: 3 posters in ${Date.now() - t0} ms -> out/variants/${theme}-*.png`);
}
