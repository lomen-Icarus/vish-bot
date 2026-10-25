/**
 * Сайт сервиса календарей на calendar.secretvish.ru: главная и политика
 * конфиденциальности. Их адреса указаны на экране входа Google (OAuth), поэтому
 * они должны открываться публично. Отдаёт их сам бот: nginx на VPS
 * (recorder/deploy/setup-front.sh) пересылает боту все запросы этого имени,
 * и отдельный статический сайт перехватил бы ленты /cal/, /health и /tma.
 * Почта для связи — из .env (CONTACT_EMAIL): репозиторий публичный.
 */

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function homePage(email?: string): string {
  const contact = email ? escAttr(email) : "";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Расписание от ВИШботика</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:680px;margin:0 auto;padding:32px 16px;line-height:1.55;color:#1d1d1f;background:#fff}
  h1{font-size:1.6em;margin:0 0 .4em}
  a{color:#0b57d0}
  footer{margin-top:40px;font-size:.9em;color:#555}
</style>
</head>
<body>
<h1>Расписание от ВИШботика</h1>
<p>Сервис Telegram-бота расписания ВИШ. Он добавляет расписание занятий в твой календарь (Google Календарь или Яндекс Календарь), чтобы пары были видны рядом с остальными делами.</p>
<p>Как это работает:</p>
<ol>
  <li>В боте выбираешь группу и нажимаешь «Подключить календарь».</li>
  <li>Бот присылает ссылку. По ней ты входишь в свой аккаунт и разрешаешь доступ.</li>
  <li>Бот создаёт в календаре отдельный календарь с расписанием и обновляет его, когда расписание меняется.</li>
</ol>
<p>В Google Календаре бот получает доступ только к календарю, который создал сам. Другие твои календари и события он не видит.</p>
<p>Отключить можно в любой момент: в боте или в настройках доступа своего аккаунта Google.</p>
<footer>
  <a href="/privacy">Политика конфиденциальности</a>${contact ? ` · Связь: <a href="mailto:${contact}">${contact}</a>` : ""}
</footer>
</body>
</html>
`;
}

export function privacyPage(email?: string): string {
  const contact = email ? escAttr(email) : "";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Политика конфиденциальности</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:680px;margin:0 auto;padding:32px 16px;line-height:1.55;color:#1d1d1f;background:#fff}
  h1{font-size:1.6em;margin:0 0 .4em}
  h2{font-size:1.15em;margin:1.6em 0 .4em}
  a{color:#0b57d0}
</style>
</head>
<body>
<h1>Политика конфиденциальности</h1>
<p>Сервис «Расписание от ВИШботика» (calendar.secretvish.ru) связан с Telegram-ботом расписания ВИШ. Он добавляет расписание занятий в календарь пользователя.</p>

<h2>Какие данные мы получаем</h2>
<ul>
  <li><b>Telegram ID</b> — чтобы знать, чьё расписание и какой календарь обновлять.</li>
  <li><b>Выбранная учебная группа</b> — чтобы знать, какое расписание выгружать.</li>
  <li><b>Токены доступа OAuth</b> от Google или Яндекса. Их выдаёт сам сервис после твоего разрешения.</li>
</ul>
<p>Паролей от аккаунтов мы не получаем и не храним.</p>

<h2>Доступ к Google Календарю</h2>
<p>Мы запрашиваем только право <code>https://www.googleapis.com/auth/calendar.app.created</code>. С ним сервис может создать отдельный календарь, а затем добавлять, менять и удалять события только в нём. Другие твои календари и события сервис не видит и не меняет.</p>
<p>Данные из Google сервис использует только для того, чтобы выгружать и обновлять расписание в созданный им календарь. Мы не продаём и не передаём их третьим лицам, не используем для рекламы и не используем для обучения моделей ИИ.</p>
<p>Использование и передача информации, полученной через Google API, соответствуют <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, включая требования Limited Use.</p>

<h2>Доступ к Яндекс Календарю</h2>
<p>Для Яндекса сервис запрашивает право «Календарь: чтение и запись». Яндекс выдаёт его на весь календарь аккаунта, отдельного права «только свой календарь» у Яндекса нет. Сервис использует его только для того, чтобы создать отдельный календарь с расписанием (или найти календарь, который ты создал для этого сам, по названию) и записывать пары в него. Названия твоих календарей сервис смотрит только чтобы найти свой; события в других календарях он не читает и не меняет; данные не продаются, не передаются третьим лицам, не используются для рекламы и обучения моделей ИИ.</p>

<h2>Хранение и удаление</h2>
<p>Токены хранятся на сервере сервиса в зашифрованном виде и нужны только для обновления расписания. Отключить календарь можно двумя способами:</p>
<ul>
  <li>в боте;</li>
  <li>в настройках доступа своего аккаунта: Google — <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, Яндекс — в разделе управления доступами Яндекс ID.</li>
</ul>
<p>После отключения токены удаляются. Созданный календарь остаётся в твоём аккаунте, и его можно удалить вручную.</p>

<h2>Контакты</h2>
<p>Вопросы и запросы на удаление данных: ${contact ? `<a href="mailto:${contact}">${contact}</a>` : "через Telegram-бота"}.</p>

<p><a href="/">← На главную</a></p>
</body>
</html>
`;
}

/** Страница после входа в Google или Яндекс: получилось или почему нет. Ни токенов, ни кода в ней нет. */
export function oauthResultPage(
  r: { ok: true; calendarName: string; reused: boolean } | { ok: false; reason: "expired" | "no_group" | "denied" | "scope" | "failed" | "need_calendar"; calendarName?: string },
  service = "Google Календарь",
): string {
  const again = `Нажми «⚡ ${escAttr(service)}» в боте ещё раз.`;
  const where = service.startsWith("Яндекс") ? "в твоём Яндекс Календаре" : "в твоём Google Календаре";
  const [title, text] = r.ok
    ? [
        `${service} подключён`,
        `${r.reused ? "Пары снова записываются в календарь" : `${where[0]!.toUpperCase()}${where.slice(1)} появился календарь`} «${escAttr(r.calendarName)}». Пары появятся в течение нескольких минут, переносы и отмены — сами. Можно вернуться в Telegram.`,
      ]
    : r.reason === "denied"
      ? ["Подключение отменено", `Доступ не выдан — бот ничего не записывает. Передумаешь — ${again[0]!.toLowerCase()}${again.slice(1)}`]
      : r.reason === "scope"
        ? ["Нет доступа к календарю", `Ты вошёл, но не разрешил доступ к календарю — без него бот не может записывать пары. ${again} Оставь галочку у календаря.`]
        : r.reason === "need_calendar"
          ? [
              "Создай календарь — один раз",
              `Яндекс не даёт боту создать календарь сам. Открой Яндекс Календарь, слева «Мои календари» → «+ Добавить» → «Новый календарь», назови его «${escAttr(r.calendarName ?? "")}» и сохрани. Потом ${again[0]!.toLowerCase()}${again.slice(1)} Бот найдёт календарь по названию и будет писать пары только в него.`,
            ]
          : r.reason === "no_group"
            ? ["Сначала выбери группу", "Бот не знает твою группу. Выбери её в боте и подключи календарь снова."]
            : r.reason === "expired"
              ? ["Ссылка устарела", `Ссылка для входа действует 30 минут и один раз. ${again}`]
              : ["Не получилось", `Сервис не ответил как надо. Попробуй ещё раз через пару минут: ${again[0]!.toLowerCase()}${again.slice(1)}`];
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;line-height:1.55;color:#1d1d1f;background:#fff}
  h1{font-size:1.4em;margin:0 0 .5em}
  a{color:#0b57d0}
</style>
</head>
<body>
<h1>${r.ok ? "✅" : "⚠️"} ${title}</h1>
<p>${text}</p>
<p><a href="/">Расписание от ВИШботика</a> · <a href="/privacy">Политика конфиденциальности</a></p>
</body>
</html>`;
}
