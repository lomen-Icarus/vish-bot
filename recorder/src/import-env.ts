/**
 * Перенос учёток студентов из .env (WEBINAR_LOGIN_2 … _9) в слоты
 * (data/accounts.json): там их видно в боте (/slots), раз в 6 часов
 * проверяется «аккаунт жив», о потере доступа приходит весть. Профиль 1 —
 * общая учётка владельца — остаётся в .env.
 *
 * Запускается только при остановленной записывалке: она держит слоты в
 * памяти и при следующем сохранении затёрла бы перенесённое. Поэтому не
 * руками, а скриптом deploy/env-to-slots.sh (остановит, перенесёт, уберёт
 * строки из .env, поднимет заново).
 *
 * Один профиль — один слот: группа — та, где учится владелец учётки (по
 * кабинету), коды — группы профиля из .env плюс своя (поток, куда профиль
 * заходил раньше, остаётся). Печатает номер профиля, группу и итог — ни
 * логина, ни пароля. Строка «IMPORTED <n>» — для скрипта.
 */
import { dirname } from "node:path";
import { AccountStore } from "./accounts.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { profileToSlot } from "./envslot.js";
import { checkStudentLogin } from "./lk.js";
import { Portal } from "./portal.js";

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const store = AccountStore.inDir(dirname(cfg.outDir));
  const proxyUrl = process.env.HTTPS_PROXY;
  const portal = new Portal({ proxyUrl });
  const extra = cfg.profiles.filter((p) => p.name !== "1");
  if (!extra.length) {
    console.log("В .env нет профилей 2…9 — переносить нечего.");
    return;
  }
  for (const p of extra) {
    if (p.authMode !== "1") {
      console.log(`Профиль ${p.name}: режим ${p.authMode}, не «обучающийся» — это не учётка студента, оставляю в .env.`);
      continue;
    }
    const check = await checkStudentLogin(p.login, p.password, { proxyUrl });
    if (check.verdict !== "ok") {
      console.log(`Профиль ${p.name}: ${check.verdict === "bad" ? "вход в кабинет не прошёл (неверный пароль?)" : "кабинет не ответил"} — оставляю в .env.`);
      continue;
    }
    const own = check.groupId != null ? await portal.groupName(check.groupId).catch(() => null) : null;
    if (!own) {
      console.log(`Профиль ${p.name}: вход прошёл, но группу владельца не узнал — оставляю в .env.`);
      continue;
    }
    if (store.get(own)) {
      console.log(`Профиль ${p.name} → ${own}: у группы уже есть слот — оставляю профиль в .env, реши руками.`);
      continue;
    }
    const slot = profileToSlot(p, own);
    store.install({ ...slot, login: p.login, password: p.password, requestId: 0, userId: 0 });
    console.log(`Профиль ${p.name} → слот ${own} (пары групп: ${slot.codes.join(", ")}).`);
    console.log(`IMPORTED ${p.name}`);
  }
}

main().catch((err: unknown) => {
  console.log(`Перенос упал: ${String(err).slice(0, 200)}`);
  process.exitCode = 1;
});
