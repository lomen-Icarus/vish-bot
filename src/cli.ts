/**
 * Developer CLI: run the portal pipeline without Telegram.
 *   tsx src/cli.ts poll [--force]         fetch, diff, print events
 *   tsx src/cli.ts groups                 list logical groups
 *   tsx src/cli.ts day <group> [dd.mm]    print a day
 *   tsx src/cli.ts week <group> [dd.mm]   print a week
 *   tsx src/cli.ts render <group> [dd.mm] write day/week PNGs to ./out
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig, loadDotEnv } from "./config.js";
import { logger } from "./logger.js";
import { openDatabase } from "./db/index.js";
import { Repo } from "./db/repo.js";
import { PortalClient } from "./portal/client.js";
import { ScheduleService } from "./schedule/service.js";
import { findGroup } from "./schedule/groups.js";
import { formatChanges, formatDay, formatWeek } from "./schedule/format.js";
import { addDays, mondayOf, parseRuDate, todayMsk, wallClock, type LocalDate } from "./time.js";
import { createRenderer } from "./render/image.js";
import { groupByDate } from "./schedule/model.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig({ ...process.env, BOT_TOKEN: process.env.BOT_TOKEN ?? "0".repeat(40) });
  logger.level = config.LOG_LEVEL;
  const [cmd = "poll", ...rest] = process.argv.slice(2);
  const db = openDatabase(config.DB_PATH);
  const repo = new Repo(db);
  const portal = new PortalClient({ insecureTls: config.PORTAL_TLS_INSECURE, proxyUrl: config.HTTPS_PROXY });
  const service = new ScheduleService(repo, portal, { facultyId: config.FACULTY_ID, hiddenPrefixes: config.HIDDEN_GROUP_PREFIXES });
  const strip = (s: string) => s.replace(/<[^>]+>/g, "");

  const pickGroup = (q: string | undefined) => {
    const groups = service.groups();
    const found = q ? findGroup(groups, q) : [];
    if (found.length !== 1) throw new Error(`group "${q}" not found or ambiguous; known: ${groups.map((g) => g.title).join(", ")}`);
    return found[0]!;
  };
  const pickDate = (s: string | undefined): LocalDate => (s ? (parseRuDate(s) ?? todayMsk()) : todayMsk());

  switch (cmd) {
    case "poll": {
      const r = await service.poll({ force: rest.includes("--force") });
      console.log(`groups=${r.groupsTotal} pages=${r.pagesFetched} changed=${r.groupsChanged.join(",") || "-"} events=${r.events.length} in ${r.durationMs}ms`);
      const byGroup = new Map<string, typeof r.events>();
      for (const e of r.events) byGroup.set(e.groupKey, [...(byGroup.get(e.groupKey) ?? []), e]);
      for (const [k, evs] of byGroup) console.log("\n" + strip(formatChanges(service.group(k)!, evs)));
      if (r.noticeChanged !== null) console.log("\nNOTICE:", r.noticeChanged);
      break;
    }
    case "groups":
      for (const g of service.groups()) console.log(`${g.key.padEnd(24)} ${g.title.padEnd(22)} course ${g.course}  <- ${g.portalNames.join(" | ")}`);
      break;
    case "day": {
      const g = pickGroup(rest[0]);
      const d = pickDate(rest[1]);
      console.log(strip(formatDay(g, d, service.lessonsOn(g, d), service.weekInfo(d), todayMsk(), { now: wallClock() })));
      break;
    }
    case "week": {
      const g = pickGroup(rest[0]);
      const monday = mondayOf(pickDate(rest[1]));
      const byDate = groupByDate(service.materialize(g, monday, addDays(monday, 6)));
      console.log(strip(formatWeek(g, monday, byDate, service.weekInfo(monday), todayMsk())));
      break;
    }
    case "render": {
      const g = pickGroup(rest[0]);
      const d = pickDate(rest[1]);
      const renderer = await createRenderer();
      if (!renderer) throw new Error("image renderer unavailable");
      mkdirSync("out", { recursive: true });
      const day = await renderer.renderDay({ group: g, date: d, lessons: service.lessonsOn(g, d), weekInfo: service.weekInfo(d), today: todayMsk(), now: wallClock() });
      writeFileSync(`out/day-${g.title}-${d}.png`, day);
      const monday = mondayOf(d);
      const byDate = groupByDate(service.materialize(g, monday, addDays(monday, 6)));
      const week = await renderer.renderWeek({ group: g, monday, byDate, weekInfo: service.weekInfo(monday), today: todayMsk(), subgroup: null });
      writeFileSync(`out/week-${g.title}-${monday}.png`, week);
      console.log("written to ./out");
      break;
    }
    default:
      console.log("commands: poll [--force] | groups | day <group> [dd.mm] | week <group> [dd.mm] | render <group> [dd.mm]");
  }
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
