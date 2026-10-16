/**
 * Проверка учётки студента без вебинара: вход в личный кабинет lk.chuvsu.ru
 * (тот же логин и пароль, что «обучающийся» на вебинаре — это и проверяем) и
 * номер его группы в расписании. На этом будет держаться проверка заявок на
 * запись и «аккаунт жив» раз в 6 часов, поэтому сначала — руками:
 *
 *   docker exec vish-recorder node dist/probe-account.js 3
 *
 * где 3 — номер профиля из .env (WEBINAR_LOGIN_3). Печатает только «вход
 * прошёл/не прошёл» и группу — ни логина, ни пароля, ни личных данных
 * (страницу с ФИО, телефоном и датой рождения не открываем вовсе).
 */
import { loadConfig, loadDotEnv } from "./config.js";
import { checkStudentLogin } from "./lk.js";
import { Portal } from "./portal.js";

async function main(): Promise<void> {
  loadDotEnv();
  const which = process.argv[2] ?? "";
  const cfg = loadConfig();
  const profile = cfg.profiles.find((p) => p.name === which);
  if (!profile) {
    console.log(`Профиля «${which}» нет. Есть: ${cfg.profiles.map((p) => p.name).join(", ")}. Запуск: node dist/probe-account.js <номер профиля>`);
    process.exitCode = 2;
    return;
  }
  if (profile.authMode !== "1") console.log(`Внимание: у профиля ${profile.name} режим ${profile.authMode}, а личный кабинет студента — это режим 1 (обучающийся). Проверяю всё равно.`);
  const proxyUrl = process.env.HTTPS_PROXY;
  const check = await checkStudentLogin(profile.login, profile.password, { proxyUrl });
  if (check.verdict === "bad") {
    console.log(`Профиль ${profile.name}: вход в lk.chuvsu.ru НЕ прошёл — кабинет ответил «неверный логин или пароль».`);
    process.exitCode = 1;
    return;
  }
  if (check.verdict === "down") {
    console.log(`Профиль ${profile.name}: кабинет lk.chuvsu.ru не ответил как обычно (недоступен?) — проверь позже.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Профиль ${profile.name}: вход в lk.chuvsu.ru прошёл.`);
  const groupId = check.groupId ?? null;
  if (groupId == null) {
    console.log("Номер группы в расписании не нашёлся.");
    return;
  }
  const name = await new Portal({ proxyUrl }).groupName(groupId).catch(() => null);
  console.log(`Группа в расписании: ${name ?? "?"} (номер ${groupId}). Группы профиля в .env: ${profile.groups.join(", ") || "не заданы (общий)"}.`);
}

main().catch((err: unknown) => {
  console.log(`Проверка упала: ${String(err).slice(0, 200)}`);
  process.exitCode = 1;
});
