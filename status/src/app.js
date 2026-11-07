// Фильтры ленты, открытие строки по ссылке и «настроение» в планах. Без скрипта страница читается целиком.
(() => {
  const form = document.getElementById("filters");
  const rows = [...document.querySelectorAll(".row")];
  const groups = [...document.querySelectorAll(".grp")];
  const found = document.getElementById("found");
  const empty = document.getElementById("empty");
  const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };

  function apply() {
    const st = form.elements.st.value;
    const grp = form.elements.grp.value;
    const senior = form.elements.senior.checked;
    const q = form.elements.q.value.trim().toLowerCase();
    const filtering = st !== "all" || grp !== "all" || senior || q !== "";
    let shown = 0;
    for (const g of groups) {
      let inGroup = 0;
      const open = filtering || g.classList.contains("is-open");
      const groupOk = grp === "all" || g.dataset.group === grp;
      for (const r of g.querySelectorAll(".row")) {
        const ok = groupOk
          && (st === "all" || r.dataset.status === st)
          && (!senior || (r.dataset.seniorWaits === "1" && r.dataset.status !== "plan"))
          && (!q || r.dataset.search.includes(q));
        r.hidden = !ok || (!open && r.hasAttribute("data-more"));
        if (ok) inGroup++;
      }
      const more = g.querySelector(".more");
      if (more) more.hidden = open;
      g.hidden = inGroup === 0;
      shown += inGroup;
    }
    found.value = `${shown} ${plural(shown, "обновление", "обновления", "обновлений")}`;
    empty.hidden = shown !== 0;
  }

  for (const btn of document.querySelectorAll(".more")) {
    btn.addEventListener("click", () => {
      const g = btn.closest(".grp");
      g.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
      apply();
      g.querySelector(".row[data-more]")?.querySelector("summary")?.focus();
    });
  }

  if (form) {
    form.addEventListener("input", apply);
    form.addEventListener("submit", (e) => e.preventDefault());
    apply();
  }

  // Ссылка на строку (#u-…) открывает её, даже если фильтр её прятал.
  function openFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id.startsWith("u-")) return;
    const row = document.getElementById(id);
    if (!row) return;
    if (row.hidden || row.closest(".grp")?.hidden) { form.reset(); row.closest(".grp")?.classList.add("is-open"); apply(); }
    const d = row.querySelector("details");
    if (d) d.open = true;
    row.scrollIntoView({ block: "center" });
  }
  window.addEventListener("hashchange", openFromHash);
  openFromHash();

  // План «Настроение»: как бот мог бы отвечать при разном настроении.
  const mood = document.getElementById("mood");
  const face = document.querySelector(".mood__face");
  const n = document.getElementById("mood-n");
  const t = document.getElementById("mood-t");
  const say = (v) =>
    v === 0 ? "Обиделся и молчит, пока не придут огоньки."
    : v < 30 ? "Расстроен, отвечает коротко."
    : v < 60 ? "Так себе. Ждёт лайков под файлом."
    : v < 90 ? "Доволен, огоньки пришли."
    : v < 100 ? "Сияет, до сотни чуть-чуть."
    : "Сто из ста. Выше не собрать.";
  if (mood && face) {
    const set = () => { const v = Number(mood.value); n.textContent = String(v); t.textContent = say(v); face.style.setProperty("--mood", String(v)); };
    mood.addEventListener("input", set);
    set();
  }
})();
