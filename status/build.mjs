#!/usr/bin/env node
// Сборка страницы статуса: data/*.json + src/* → dist/ (статичный HTML, читается и без JS).
//   node status/build.mjs            — собрать в status/dist
//   node status/build.mjs --check    — только проверить данные (для CI и тестов)
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const roadmap = JSON.parse(read("data/roadmap.json"));
const debt = JSON.parse(read("data/debt.json"));

// ---------- проверка данных ----------
export function validate(rm, db) {
  const errors = [];
  const groups = new Set(rm.groups.map((g) => g.id));
  const ids = new Set();
  const STATUS = new Set(["done", "progress", "plan"]);
  const REVIEW = new Set(["ok", "notes", "none", "na"]);
  const KIND = new Set(["base", "feature", "change", "fix", "infra", "plan"]);
  for (const it of rm.items) {
    const at = it.id ?? JSON.stringify(it).slice(0, 40);
    if (!it.id || ids.has(it.id)) errors.push(`${at}: id пустой или повторяется`);
    ids.add(it.id);
    if (!groups.has(it.group)) errors.push(`${at}: нет группы ${it.group}`);
    if (!STATUS.has(it.status)) errors.push(`${at}: статус ${it.status}`);
    if (!KIND.has(it.kind)) errors.push(`${at}: вид ${it.kind}`);
    if (it.status !== "plan" && !/^\d{4}-\d{2}-\d{2}$/.test(it.date ?? "")) errors.push(`${at}: нет даты`);
    for (const who of ["claude", "author", "senior"]) if (!REVIEW.has(it.review?.[who])) errors.push(`${at}: ревью ${who}`);
    if (!it.title?.trim() || !it.text?.trim()) errors.push(`${at}: пустой заголовок или текст`);
    // Страница без длинных тире и точек-разделителей (правило оформления).
    if (/[—–·]/.test(it.title + it.text)) errors.push(`${at}: тире или «·» в тексте`);
  }
  for (const a of db.areas) {
    const sum = a.params.reduce((s, p) => s + p.points, 0);
    if (sum > 100) errors.push(`долг ${a.id}: баллов ${sum} больше 100`);
  }
  const w = db.areas.reduce((s, a) => s + a.weight, 0);
  if (w !== 100) errors.push(`долг: сумма весов ${w}, а не 100`);
  return errors;
}

export function debtScore(db) {
  const areas = db.areas.map((a) => {
    const score = Math.min(100, a.params.reduce((s, p) => s + p.points, 0));
    return { ...a, score, part: (a.weight * score) / 100 };
  });
  const total = areas.reduce((s, a) => s + a.part, 0);
  return { areas, total: Math.round(total) };
}

// ---------- помощники ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const shortDate = (d) => { const [, m, day] = d.split("-"); return `${+day} ${MONTHS[+m - 1]}`; };
const longDate = (d) => { const [y, m, day] = d.split("-"); return `${+day} ${MONTHS_FULL[+m - 1]} ${y}`; };
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const fmt = (x) => String(Math.round(x * 10) / 10).replace(".", ",");

const STATUS_LABEL = { done: "сделано", progress: "в работе", plan: "в планах" };
const REVIEW_LABEL = {
  claude: { ok: "Claude: проверено", notes: "Claude: есть замечания", none: "Claude: ревью не было", na: "Claude: не нужно" },
  author: { ok: "Автор: принято", notes: "Автор: есть замечания", none: "Автор: ещё не смотрел", na: "Автор: не нужно" },
  senior: { ok: "Сеньор: одобрено", notes: "Сеньор: есть замечания", none: "Сеньор: ещё не смотрел", na: "Сеньор: не нужно" },
};
const ICON = {
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  notes: '<path d="M12 6.5v7M12 17.2v.3"/>',
  none: "",
  na: '<path d="M7 12h10"/>',
};
const mark = (who, state) =>
  `<span class="mark mark--${state}" role="img" aria-label="${esc(REVIEW_LABEL[who][state])}" title="${esc(REVIEW_LABEL[who][state])}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[state]}</svg></span>`;

// ---------- данные для страницы ----------
const items = roadmap.items;
const done = items.filter((i) => i.status === "done");
const progress = items.filter((i) => i.status === "progress");
const plans = items.filter((i) => i.status === "plan");
const shipped = [...done, ...progress];
const latest = [...done].sort((a, b) => b.date.localeCompare(a.date) || (b.adr ?? 0) - (a.adr ?? 0))[0];
const first = [...shipped].sort((a, b) => a.date.localeCompare(b.date))[0];
const count = (who, state) => shipped.filter((i) => i.review[who] === state).length;
const groupsOrdered = roadmap.groups
  .map((g) => {
    const list = items.filter((i) => i.group === g.id).sort((a, b) => {
      const ka = a.status === "plan" ? "9999" : a.date, kb = b.status === "plan" ? "9999" : b.date;
      return kb.localeCompare(ka) || (b.adr ?? 0) - (a.adr ?? 0);
    });
    const last = list.filter((i) => i.date).map((i) => i.date).sort().at(-1) ?? "";
    return { ...g, list, last };
  })
  .filter((g) => g.list.length)
  .sort((a, b) => b.last.localeCompare(a.last));
const { areas, total } = debtScore(debt);

// ---------- разметка ----------
const SHOW = 5;
function row(it, i) {
  const no = it.adr ? `№ ${it.adr}` : it.status === "plan" ? "план" : "git";
  const when = it.date ? `<time datetime="${it.date}">${shortDate(it.date)}</time>` : `<span class="row__when">позже</span>`;
  const seniorWaits = it.review.senior === "none" ? "1" : "0";
  const reviews = `${REVIEW_LABEL.claude[it.review.claude]}. ${REVIEW_LABEL.author[it.review.author]}. ${REVIEW_LABEL.senior[it.review.senior]}.`;
  return `<li class="row" id="u-${it.id}"${i >= SHOW ? " data-more" : ""} data-status="${it.status}" data-senior-waits="${seniorWaits}" data-search="${esc((it.title + " " + it.text + " " + no).toLowerCase())}">
<details><summary><span class="row__no num">${no}</span><span class="row__title">${esc(it.title)}</span><span class="row__date num">${when}</span><span class="state state--${it.status}">${STATUS_LABEL[it.status]}</span><span class="marks">${mark("claude", it.review.claude)}${mark("author", it.review.author)}${mark("senior", it.review.senior)}</span></summary>
<div class="row__body"><p>${esc(it.text)}</p><p class="row__reviews">${esc(reviews)}</p></div></details></li>`;
}

function group(g) {
  return `<section class="grp" id="g-${g.id}" data-group="${g.id}" aria-labelledby="h-${g.id}">
<div class="grp__head"><h3 id="h-${g.id}">${esc(g.name)}</h3><p>${esc(g.about)}</p><span class="grp__count num" aria-label="${g.list.length} ${plural(g.list.length, "обновление", "обновления", "обновлений")}">${g.list.length}</span></div>
<ol class="rows">${g.list.map(row).join("\n")}</ol>${g.list.length > SHOW ? `<button type="button" class="more" aria-expanded="false" aria-controls="g-${g.id}">Ещё ${g.list.length - SHOW}</button>` : ""}</section>`;
}

const bigPlans = ["p-mood", "p-audio", "p-personal"].map((id) => plans.find((p) => p.id === id)).filter(Boolean);
const smallPlans = plans.filter((p) => !bigPlans.includes(p));

const debtBar = areas
  .map((a, i) => `<span class="bar__seg" style="--w:${a.part.toFixed(2)}; --c:var(--debt-${i + 1})"></span>`)
  .join("");
const debtRows = areas
  .map((a, i) => {
    const top = [...a.params].sort((x, y) => y.points - x.points)[0];
    return `<li class="area">
<details><summary><span class="swatch" style="--c:var(--debt-${i + 1})" aria-hidden="true"></span><span class="area__name">${esc(a.name)}</span><span class="area__why">${esc(top.name)}: ${esc(top.value)}</span><span class="area__part num" aria-label="${fmt(a.part)} пункта из ${total}">+${fmt(a.part)}</span></summary>
<div class="area__body"><p>${esc(a.plain)}</p>
<p class="area__calc num">Вес ${a.weight}. Баллы ${a.score} из 100. В индекс: ${a.weight} × ${a.score} / 100 = ${fmt(a.part)}.</p>
<div class="table-wrap"><table><thead><tr><th scope="col">Что считали</th><th scope="col">Сейчас</th><th scope="col">Правило</th><th scope="col" class="num">Баллы</th></tr></thead>
<tbody>${a.params.map((p) => `<tr><th scope="row">${esc(p.name)}</th><td data-label="Сейчас">${esc(p.value)}</td><td data-label="Правило">${esc(p.rule)}</td><td class="num" data-label="Баллы">${p.points}</td></tr>`).join("")}</tbody></table></div></div></details></li>`;
  })
  .join("\n");

const groupOptions = groupsOrdered.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.list.length})</option>`).join("");
const updated = longDate(roadmap.updated);

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Статус ВИШботика</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Все обновления бота расписания ВИШ ЧГУ, их ревью, планы и технический долг.">
<meta name="theme-color" content="#385e8a">
<link rel="preload" href="fonts/montserrat-cyrillic-800-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="site.css">
<script>document.documentElement.classList.add('js');</script>
</head>
<body>
<a class="skip" href="#main">К содержанию</a>
<header class="hero" id="top">
<svg class="hero__art" viewBox="0 0 1440 760" preserveAspectRatio="xMaxYMid slice" aria-hidden="true"><circle class="sg sg--2" cx="1180" cy="120" r="300"/><circle class="sg sg--3" cx="760" cy="860" r="250"/><polygon class="sg sg--3" points="0,760 300,520 600,760"/><polygon class="sg sg--2" points="1040,-20 1260,-20 1150,140"/></svg>
<div class="container nav-wrap">
<nav class="nav" aria-label="Разделы страницы">
<a class="wordmark" href="#top" aria-label="ВИШботик, в начало страницы">ВИШботик</a>
<ul><li><a href="#map">Обновления</a></li><li><a href="#plans">Планы</a></li><li><a href="#reviews">Ревью</a></li><li><a href="#debt">Долг</a></li></ul>
</nav>
</div>
<div class="container hero__body">
<div class="hero__text">
<h1>Как растёт ВИШботик</h1>
<p class="lead">Каждое обновление бота расписания ВИШ, его ревью и технический долг.</p>
<div class="actions"><a class="btn btn--light" href="#map">Смотреть обновления</a><a class="link-light" href="#plans">Что в планах</a></div>
<div class="lens" role="group" aria-label="Сводка на ${esc(updated)}">
<dl class="lens__stats">
<div><dt>сделано</dt><dd class="num">${done.length}</dd></div>
<div><dt>в работе</dt><dd class="num">${progress.length}</dd></div>
<div><dt>в планах</dt><dd class="num">${plans.length}</dd></div>
</dl>
<p class="lens__last">Последнее: <a href="#u-${latest.id}">${esc(latest.title)}</a>, <time datetime="${latest.date}">${longDate(latest.date)}</time></p>
</div>
</div>
<figure class="mascot"><img src="images/mascot.webp" srcset="images/mascot-560.webp 560w, images/mascot.webp 923w" sizes="(max-width: 60rem) 70vw, 36vw" width="923" height="893" alt="ВИШботик, маскот бота: синий шлем, жёлтые глаза, рука показывает «мир»" fetchpriority="high"></figure>
</div>
</header>

<main id="main">
<section class="map" id="map" aria-labelledby="map-h">
<div class="container map__head">
<h2 id="map-h">${shipped.length + plans.length} ${plural(shipped.length + plans.length, "шаг", "шага", "шагов")} с ${longDate(first.date).replace(/ \d{4}$/, "")}</h2>
<p class="lead">Решения из журнала проекта, правки из истории кода и планы. Нажми на строку, чтобы прочитать.</p>
</div>
<form class="filters" id="filters" role="search" aria-label="Фильтр обновлений">
<div class="container filters__in">
<fieldset class="seg"><legend class="visually-hidden">Статус</legend>
<input type="radio" name="st" id="st-all" value="all" checked><label for="st-all">Все</label>
<input type="radio" name="st" id="st-done" value="done"><label for="st-done">Сделано</label>
<input type="radio" name="st" id="st-progress" value="progress"><label for="st-progress">В работе</label>
<input type="radio" name="st" id="st-plan" value="plan"><label for="st-plan">Планы</label>
</fieldset>
<label class="field"><span class="visually-hidden">Тема</span><select id="grp" name="grp"><option value="all">Все темы</option>${groupOptions}</select></label>
<label class="check"><input type="checkbox" id="senior" name="senior"><span>Ждут ревью сеньора</span></label>
<label class="field field--search"><span class="visually-hidden">Найти</span><input type="search" id="q" name="q" placeholder="Найти: календарь, МАКС, слайды" autocomplete="off"></label>
<output class="filters__count num" id="found" for="grp q senior" aria-live="polite">${items.length}</output>
</div>
</form>
<div class="container ledger">
<div class="ledger__cols" aria-hidden="true"><span>№</span><span>Обновление</span><span>Дата</span><span>Статус</span><span class="ledger__rev">Claude, автор, сеньор</span></div>
${groupsOrdered.map(group).join("\n")}
<p class="ledger__empty" id="empty" hidden>Ничего не нашлось. Сбрось фильтр или поищи другим словом.</p>
</div>
</section>

<section class="plans" id="plans" aria-labelledby="plans-h">
<div class="container">
<h2 id="plans-h">Чему ВИШботик научится</h2>
<div class="mood" id="${bigPlans[0]?.id ?? "p-mood"}">
<div class="mood__text">
<h3>${esc(bigPlans[0]?.title ?? "")}</h3>
<p>${esc(bigPlans[0]?.text ?? "")}</p>
<div class="mood__try">
<label for="mood">Покрути настроение</label>
<input type="range" id="mood" min="0" max="100" value="82" step="1" aria-describedby="mood-say">
<p class="mood__say" id="mood-say" aria-live="polite"><span class="num" id="mood-n">82</span><span id="mood-t">Доволен, огоньки пришли.</span></p>
</div>
</div>
<figure class="mood__face"><img src="images/mascot-560.webp" width="560" height="542" alt="" loading="lazy" decoding="async" id="mood-img"><figcaption>Так это может выглядеть. Функция ещё не сделана.</figcaption></figure>
</div>
<ul class="plans__big">${bigPlans.slice(1).map((p) => `<li id="${p.id}"><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p></li>`).join("")}</ul>
<ul class="plans__small">${smallPlans.map((p) => `<li id="${p.id}"><h3>${esc(p.title)}</h3><p>${esc(p.text)}</p></li>`).join("")}</ul>
</div>
</section>

<section class="reviews" id="reviews" aria-labelledby="rev-h">
<div class="container">
<h2 id="rev-h">Три ревью у каждого обновления</h2>
<dl class="reviews__list">
<div>${mark("claude", "ok")}<dt>Claude</dt><dd>Читает код до мёржа: ошибки, утечки, крайние случаи.</dd><dd class="reviews__n num">${count("claude", "ok")} <span>из ${shipped.length}</span></dd></div>
<div>${mark("author", "ok")}<dt>Автор</dt><dd>Владелец бота проверяет обновление вживую, в своём Telegram.</dd><dd class="reviews__n num">${count("author", "ok")} <span>из ${shipped.length}</span></dd></div>
<div>${mark("senior", "none")}<dt>Сеньор</dt><dd>Опытный разработчик смотрит код и решения. Отметку ставит автор с его слов.</dd><dd class="reviews__n num">${count("senior", "ok")} <span>из ${shipped.length}</span></dd></div>
</dl>
<p class="reviews__legend"><span>${mark("claude", "ok")} проверено</span><span>${mark("claude", "notes")} есть замечания</span><span>${mark("claude", "none")} ещё не смотрели</span><span>${mark("claude", "na")} не нужно</span></p>
</div>
</section>

<section class="debt" id="debt" aria-labelledby="debt-h">
<div class="container">
<div class="debt__head">
<h2 id="debt-h"><span class="debt__figure num">${total}</span><span class="debt__of">из 100 по шкале технического долга</span></h2>
<p>${esc(debt.about)}</p>
</div>
<div class="bar" role="img" aria-label="Индекс долга ${total} из 100, по областям: ${areas.map((a) => `${a.name} ${fmt(a.part)}`).join(", ")}">${debtBar}</div>
<div class="bar__scale num" aria-hidden="true"><span>0</span><span>50</span><span>100</span></div>
<ol class="areas">${debtRows}</ol>
<div class="debt__next">
<h3>Что чиним первым</h3>
<ol>${debt.next.map((n) => `<li><span class="debt__id num">${esc(n.id)}</span>${esc(n.title)}<span class="debt__cost">${esc(n.cost)}</span></li>`).join("")}</ol>
<p class="debt__src">Аудит от <time datetime="${debt.audited}">${longDate(debt.audited)}</time>. <a href="${esc(debt.report)}">Полный отчёт с доказательствами</a></p>
</div>
</div>
</section>
</main>

<footer class="foot">
<div class="container foot__in">
<p class="foot__mark">ВИШботик</p>
<p>Бот расписания Высшей инженерной школы ЧГУ им. И. Н. Ульянова. Данные на ${esc(updated)}.</p>
<ul><li><a href="https://github.com/lomen-Icarus/vish-bot">Код на GitHub</a></li><li><a href="https://parlament.secretvish.ru/quorum">Кворум: кто уже в боте</a></li><li><a href="${esc(debt.report)}">Отчёт об аудите</a></li></ul>
</div>
</footer>
<script src="app.js" defer></script>
</body>
</html>
`;

const errors = validate(roadmap, debt);
if (errors.length) {
  console.error("Ошибки в данных:\n" + errors.join("\n"));
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log(`данные в порядке: ${items.length} записей, индекс долга ${total}`);
  process.exit(0);
}
const out = join(ROOT, "dist");
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), html);
const css = ["src/tokens.css", "src/base.css", "src/site.css"].map(read).join("\n");
// Штамп Hallmark должен стоять первой строкой итогового CSS.
const site = read("src/site.css");
const stamp = site.slice(0, site.indexOf("*/", site.lastIndexOf("/* Hallmark")) + 2);
writeFileSync(join(out, "site.css"), stamp + "\n" + css.replace(stamp, ""));
writeFileSync(join(out, "app.js"), read("src/app.js"));
for (const d of ["fonts", "images", "data"]) cpSync(join(ROOT, d), join(out, d), { recursive: true });
console.log(`собрано: status/dist (${items.length} записей, индекс долга ${total})`);
