/**
 * Страница Mini App «Записывать мою группу». Логин и пароль шифруются
 * прямо здесь, в браузере студента, открытым ключом записывалки (тот же конверт
 * v1, что в recorder/src/crypto.ts). Боту уходит только шифровка. Страница
 * самодостаточна; данные берёт у /tma/context и шлёт в /tma/submit.
 */
export const TMA_PAGE = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Запись пар группы</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--tg-theme-bg-color, #fff); color: var(--tg-theme-text-color, #111); }
  .wrap { max-width: 460px; margin: 0 auto; padding: 18px 16px 40px; }
  h1 { font-size: 20px; margin: 4px 0 10px; }
  p, label { font-size: 15px; line-height: 1.45; }
  .hint { color: var(--tg-theme-hint-color, #777); font-size: 13.5px; }
  label.field { display: block; margin: 14px 0 4px; font-weight: 600; }
  select, input { width: 100%; box-sizing: border-box; padding: 11px 12px; font-size: 16px; border: 1px solid var(--tg-theme-hint-color, #ccc); border-radius: 10px; background: var(--tg-theme-secondary-bg-color, #f5f5f5); color: inherit; }
  .consent { display: flex; gap: 10px; margin: 14px 0; align-items: flex-start; }
  .consent input { width: 22px; height: 22px; flex: none; margin-top: 1px; }
  button { width: 100%; margin-top: 18px; padding: 14px; font-size: 16px; font-weight: 600; border: 0; border-radius: 12px; background: var(--tg-theme-button-color, #3390ec); color: var(--tg-theme-button-text-color, #fff); }
  button:disabled { opacity: .5; }
  .box { padding: 14px; border-radius: 12px; background: var(--tg-theme-secondary-bg-color, #f0f0f0); margin-top: 14px; }
  .warn { font-size: 13.5px; }
  #msg { margin-top: 16px; font-size: 15px; }
  .ok { color: #1a9a4b; } .err { color: #d14343; }
  .hidden { display: none; }
</style></head>
<body><div class="wrap">
  <h1>🎥 Запись пар группы</h1>
  <div id="loading" class="hint">Загрузка…</div>

  <div id="blocked" class="hidden box"></div>

  <form id="form" class="hidden">
    <p class="hint">Бот будет заходить на онлайн-пары под твоей учёткой портала и присылать слайды всем в группе. Логин и пароль шифруются прямо здесь и видны только серверу записи — админу бота они не показываются.</p>

    <label class="field" for="group">Группа</label>
    <select id="group"></select>

    <label class="field" for="login">Логин от tt.chuvsu.ru / личного кабинета</label>
    <input id="login" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="email">

    <label class="field" for="password">Пароль</label>
    <input id="password" type="password" autocomplete="off">

    <div class="box">
      <label class="consent"><input type="checkbox" id="c1"><span class="warn">Понимаю, что на онлайн-паре бот будет виден в списке участников под моим именем.</span></label>
      <label class="consent"><input type="checkbox" id="c2"><span class="warn">Понимаю, что бот будет периодически заходить в мой аккаунт, чтобы проверить, что доступ ещё работает, и что я могу отозвать доступ в боте.</span></label>
    </div>

    <button type="submit" id="send" disabled>Отправить заявку</button>
    <div id="msg"></div>
  </form>
</div>
<script>
const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
let initData = tg?.initData || "";
const $ = (id) => document.getElementById(id);
let ctx = null;

async function seal(pubB64, creds, aad) {
  const der = Uint8Array.from(atob(pubB64), (c) => c.charCodeAt(0));
  const rsa = await crypto.subtle.importKey("spki", der, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, aes, enc.encode(JSON.stringify(creds)));
  const k = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, await crypto.subtle.exportKey("raw", aes));
  const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  return { v: 1, k: b64(k), iv: b64(iv), c: b64(c) };
}

function block(text) {
  $("loading").classList.add("hidden");
  const b = $("blocked"); b.textContent = text; b.classList.remove("hidden");
}

function refresh() {
  const ok = $("group").value && $("login").value.trim() && $("password").value && $("c1").checked && $("c2").checked;
  $("send").disabled = !ok;
}

async function load() {
  if (!initData) return block("Открой форму из бота: 🗂 Ещё → 🎥 Записывать мою группу.");
  let res;
  try { res = await fetch("/tma/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData }) }); }
  catch { return block("Нет связи с ботом. Попробуй позже."); }
  if (!res.ok) return block("Не удалось открыть форму. Попробуй позже.");
  ctx = await res.json();
  if (!ctx.recorderReady) return block("Сервис записи ещё не подключён. Попробуй позже.");
  if (ctx.busy) return block("У тебя уже есть заявка или учётка в записи. Статус и отзыв: 🗂 Ещё → 🎥 Запись моей группы.");
  if (ctx.remaining <= 0) return block("Ты уже подавал(а) заявки в этом месяце. Можно не больше " + (ctx.limit || 2) + " в месяц — попробуй позже.");
  const sel = $("group");
  for (const g of ctx.groups) { const o = document.createElement("option"); o.value = g.key; o.textContent = g.title; if (g.key === ctx.myGroupKey) o.selected = true; sel.appendChild(o); }
  $("loading").classList.add("hidden");
  $("form").classList.remove("hidden");
  for (const id of ["group", "login", "password", "c1", "c2"]) $(id).addEventListener("input", refresh);
  refresh();
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("send").disabled = true;
  const msg = $("msg"); msg.textContent = "Шифрую и отправляю…"; msg.className = "";
  try {
    initData = tg?.initData || initData;
    const group = ctx.groups.find((g) => g.key === $("group").value);
    const aad = "vish-rec|" + ctx.userId + "|" + group.title;
    const envelope = await seal(ctx.publicKey, { login: $("login").value.trim(), password: $("password").value }, aad);
    const res = await fetch("/tma/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData, groupKey: group.key, envelope }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      $("form").querySelectorAll("input,select,button").forEach((el) => (el.disabled = true));
      msg.textContent = "✅ Заявка отправлена. Бот проверит вход на портал, админ рассмотрит заявку — о решении бот напишет. Статус и отзыв: 🗂 Ещё → 🎥 Запись моей группы.";
      msg.className = "ok";
      tg?.HapticFeedback?.notificationOccurred("success");
    } else {
      msg.textContent = (res.status === 401 ? "Форма устарела — закрой и открой заново из бота." : data.error) || "Не отправилось. Попробуй позже.";
      msg.className = "err";
      $("send").disabled = res.status !== 401 ? false : true;
    }
  } catch {
    msg.textContent = "Не удалось зашифровать. Обнови Telegram и попробуй снова.";
    msg.className = "err";
    $("send").disabled = false;
  }
});

load();
</script>
</body></html>`;
