/**
 * Разведка: один запуск, который отвечает на вопросы «пускает ли учётка»,
 * «видно ли нужную пару» и «что вообще в комнате». Запускать на сервере
 * записи во время живого вебинара:
 *
 *   npm run probe            — проверить портал и показать пары на сегодня
 *   npm run probe -- join    — ещё и зайти в первую доступную комнату и снять кадр
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { loadConfig, loadDotEnv } from "./config.js";
import { Portal, parseWebinarRows } from "./portal.js";
import { mskNow, wanted } from "./plan.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const wantJoin = process.argv.includes("join");
  const portal = new Portal({ proxyUrl: process.env.HTTPS_PROXY });
  await portal.loginAsGuest();
  const now = mskNow();
  const html = await portal.webinarPage(now.date, cfg.facultyId);
  const rows = parseWebinarRows(html);
  console.log(`Дата: ${now.date}, сейчас ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")} МСК`);
  console.log(`Строк на странице: ${rows.length}, подходящих под фильтры: ${rows.filter((r) => wanted(r, cfg)).length}`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  ${r.startMinutes ?? "??"}–${r.endMinutes ?? "??"} | ${r.subject.slice(0, 40)} | ${r.teacher} | ${r.groups.join(",")} | подключиться: ${r.joinId ? `да (idw=${r.joinId}, idwt=${r.joinType})` : "нет"}`);
  }
  const ready = rows.find((r) => r.joinId && wanted(r, cfg)) ?? rows.find((r) => r.joinId);
  if (!ready) {
    console.log("\nСейчас ни к одному вебинару подключиться нельзя — кнопка появляется незадолго до начала. Запусти разведку во время пары.");
    return;
  }
  const join = await portal.getJoinUrl(ready, { name: cfg.login, pass: cfg.password, mode: cfg.authMode });
  if (!join.url) {
    console.log(`\nПортал не пустил: ${join.error}`);
    console.log("Проверь WEBINAR_AUTH (0 слушатель, 1 обучающийся, 2 сотрудник, 4 преподаватель), логин и пароль.");
    return;
  }
  console.log(`\nКомната получена: ${join.url.slice(0, 80)}…`);
  if (!wantJoin) {
    console.log("Чтобы зайти в неё и снять кадр, запусти: npm run probe -- join");
    return;
  }
  const dir = path.resolve(cfg.outDir, "probe");
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ headless: cfg.headless, ...(cfg.chromiumPath ? { executablePath: cfg.chromiumPath } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, locale: "ru-RU" });
    await page.goto(join.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(8000);
    writeFileSync(path.join(dir, "room.png"), await page.screenshot({ fullPage: false }));
    // Слепок разметки: по нему подбираются селекторы области презентации.
    const outline = await page.evaluate(() => {
      const bits: string[] = [];
      document.querySelectorAll<HTMLElement>("[data-test], svg, canvas").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 60) return;
        bits.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} data-test=${el.getAttribute("data-test") ?? "-"} class=${(el.className || "").toString().slice(0, 60)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      return bits.slice(0, 60).join("\n");
    });
    writeFileSync(path.join(dir, "outline.txt"), `${join.url}\n\n${outline}\n`);
    console.log(`Скриншот и слепок разметки: ${dir}`);
    console.log(outline.split("\n").slice(0, 15).join("\n"));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  log.error({ err: String(err) }, "разведка не удалась");
  process.exit(1);
});
