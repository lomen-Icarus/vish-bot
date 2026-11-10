// Генератор презентации для студенческой конференции «Разработка класса для отслеживания изменений в расписании ВИШ ЧувГУ».
// Не входит в сборку бота. Запуск: в отдельной папке `npm i pptxgenjs sharp react react-dom react-icons`, затем `node build-deck.cjs out.pptx`.
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const Lu = require("react-icons/lu");

// ---------- палитра ----------
const COL = {
  light: "F7F9FC",
  ink: "111827",
  inkMuted: "475569",
  overline: "2F6BEA",
  blue: "2563EB",
  blueDeep: "1E3A8A",
  code: "1E1E2E",
  cyan: "38BDF8",
  yellow: "FACC15",
  line: "E2E8F0",
  frame: "94A3B8",
  white: "FFFFFF",
  onBlueMuted: "DBEAFE",
  // плейсхолдеры «[...]», которые заполняются вручную
  phText: "9A3412",
  phHi: "FEF08A",
};
const FONT = "Inter";
const MONO = "Consolas"; // есть в Windows и Office; без лигатур, чтобы !== выглядело как в исходнике
const W = 13.333, H = 7.5, M = 0.6;

// ---------- растровые ресурсы ----------
async function svgPng(svg, wPx, hPx) {
  const buf = await sharp(Buffer.from(svg)).resize(wPx, hPx).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
async function icon(name, color, px = 256, stroke = 1.5) {
  const el = React.createElement(Lu[name], { color: "#" + color, size: px, strokeWidth: stroke });
  const svg = ReactDOMServer.renderToStaticMarkup(el);
  return svgPng(svg, px, px);
}

// Едва заметные фигуры на синем фоне: круг, треугольник, квадрат.
async function blueBackdrop() {
  const k = 150; // px на дюйм
  const s = (v) => (v * k).toFixed(1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s(W)}" height="${s(H)}" viewBox="0 0 ${s(W)} ${s(H)}">
    <circle cx="${s(1.3)}" cy="${s(6.7)}" r="${s(2.3)}" fill="#FFFFFF" fill-opacity="0.07"/>
    <polygon points="${s(3.0)},${s(-0.4)} ${s(5.6)},${s(-0.4)} ${s(4.3)},${s(1.9)}" fill="#FFFFFF" fill-opacity="0.06"/>
    <rect x="${s(11.2)}" y="${s(5.4)}" width="${s(2.6)}" height="${s(2.6)}" fill="#FFFFFF" fill-opacity="0.07" transform="rotate(18 ${s(12.5)} ${s(6.7)})"/>
  </svg>`;
  return svgPng(svg, Math.round(W * k), Math.round(H * k));
}

// Титульная композиция: сине-голубой круг и жёлтый скруглённый многоугольник, обрезанные краем.
const COMP_W = 4.8;
async function titleComposition() {
  const k = 200;
  const s = (v) => (v * k).toFixed(1);
  const hex = (cx, cy, r, rot) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = ((60 * i + rot) * Math.PI) / 180;
      return `${s(cx + r * Math.cos(a))},${s(cy + r * Math.sin(a))}`;
    }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s(COMP_W)}" height="${s(H)}" viewBox="0 0 ${s(COMP_W)} ${s(H)}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#7DD3FC"/><stop offset="1" stop-color="#2563EB"/>
      </linearGradient>
    </defs>
    <polygon points="${hex(1.95, 6.35, 1.45, 15)}" fill="#FACC15" stroke="#FACC15" stroke-width="${s(0.34)}" stroke-linejoin="round"/>
    <circle cx="${s(3.75)}" cy="${s(3.2)}" r="${s(2.25)}" fill="url(#g)"/>
  </svg>`;
  return svgPng(svg, Math.round(COMP_W * k), Math.round(H * k));
}

// ---------- подсветка TypeScript (палитра Catppuccin Mocha на #1E1E2E) ----------
const SYN = {
  text: "CDD6F4", kw: "CBA6F7", type: "F9E2AF", fn: "89B4FA", str: "A6E3A1",
  num: "FAB387", op: "89DCEB", punct: "9399B2", prop: "B4BEFE", konst: "FAB387",
};
const KW = new Set(["export", "function", "const", "let", "if", "return", "null", "this", "new"]);
const TYPES = new Set(["LocalDate", "WeekInfo", "Occurrence", "string", "Math", "Date"]);
function highlight(code) {
  const runs = [];
  const lines = code.split("\n");
  lines.forEach((line, li) => {
    const re = /("(?:[^"\\]|\\.)*")|(\b\d[\d_]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([=!<>&|?:+\-*/%]+)|(.)/g;
    let m;
    const toks = [];
    while ((m = re.exec(line))) toks.push(m);
    toks.forEach((t, i) => {
      let color = SYN.text;
      const v = t[0];
      if (t[1]) color = SYN.str;
      else if (t[2]) color = SYN.num;
      else if (t[3]) {
        const prev = toks[i - 1]?.[0];
        const next = toks[i + 1]?.[0];
        if (KW.has(v)) color = SYN.kw;
        else if (TYPES.has(v)) color = SYN.type;
        else if (/^[A-Z][A-Z0-9_]+$/.test(v)) color = SYN.konst;
        else if (next === "(") color = SYN.fn;
        else if (prev === "." || prev === "?.") color = SYN.prop;
      } else if (t[5]) color = SYN.op;
      else if (t[6]) color = SYN.punct;
      runs.push({ text: v, options: { color } });
    });
    if (toks.length === 0) runs.push({ text: " ", options: { color: SYN.text } });
    if (li < lines.length - 1) runs[runs.length - 1].options.breakLine = true;
  });
  return runs;
}

// ---------- общие элементы ----------
function marker(slide, onBlue) {
  // ● ▲ ■ — голубой, синий, жёлтый
  const y = 0.42, sz = 0.2, x0 = W - M - 3 * sz - 2 * 0.09;
  slide.addShape("ellipse", { x: x0, y, w: sz, h: sz, fill: { color: COL.cyan }, line: { type: "none" }, objectName: "Маркер: круг" });
  slide.addShape("triangle", { x: x0 + sz + 0.09, y, w: sz, h: sz, fill: { color: onBlue ? COL.blueDeep : COL.blue }, line: { type: "none" }, objectName: "Маркер: треугольник" });
  slide.addShape("rect", { x: x0 + 2 * (sz + 0.09), y, w: sz, h: sz, fill: { color: COL.yellow }, line: { type: "none" }, objectName: "Маркер: квадрат" });
}

const PH = (text, extra = {}) => ({ text, options: { color: COL.phText, highlight: COL.phHi, ...extra } });

// Список с тонкими иконками слева и тонкими разделителями между пунктами.
function iconList(slide, items, o) {
  const { x, y, w, rowH, iconSz = 0.34, fontSize = 15, color, divColor, divTransp = 0 } = o;
  items.forEach((it, i) => {
    const ry = y + i * rowH;
    slide.addImage({ data: it.icon, x, y: ry + (rowH - iconSz) / 2, w: iconSz, h: iconSz });
    slide.addText(it.text, {
      x: x + iconSz + 0.22, y: ry, w: w - iconSz - 0.22, h: rowH, margin: 0,
      fontFace: FONT, fontSize, color, valign: "middle", isTextBox: true,
    });
    if (i < items.length - 1) {
      slide.addShape("line", { x, y: ry + rowH, w, h: 0, line: { color: divColor, width: 0.75, transparency: divTransp } });
    }
  });
}

function codeBlock(slide, code, o) {
  const { x, y, w, h, fontSize = 14 } = o;
  slide.addShape("roundRect", { x, y, w, h, rectRadius: 0.1, fill: { color: COL.code }, line: { type: "none" }, objectName: "Блок кода" });
  slide.addText(highlight(code), {
    x: x + 0.3, y: y + 0.25, w: w - 0.6, h: h - 0.5, margin: 0,
    fontFace: MONO, fontSize, valign: "top", lineSpacingMultiple: 1.12, isTextBox: true, objectName: "Код",
  });
}

function blueTitle(slide, title, caption) {
  slide.addText(title, {
    x: M, y: 0.9, w: 3.95, h: 1.7, margin: 0, fontFace: FONT, fontSize: 36, bold: true,
    color: COL.white, valign: "top", isTextBox: true, objectName: "Заголовок",
  });
  if (caption) {
    slide.addText(caption, {
      x: M, y: 2.85, w: 3.7, h: 1.6, margin: 0, fontFace: FONT, fontSize: 17,
      color: COL.onBlueMuted, valign: "top", isTextBox: true, objectName: "Подпись",
    });
  }
}

function lightTitle(slide, title) {
  slide.addText(title, {
    x: M, y: 0.45, w: 10.5, h: 0.75, margin: 0, fontFace: FONT, fontSize: 36, bold: true,
    color: COL.ink, valign: "top", isTextBox: true, objectName: "Заголовок",
  });
}

// ---------- сборка ----------
(async () => {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };
  pres.title = "Разработка класса для отслеживания изменений в расписании ВИШ ЧувГУ";
  pres.lang = "ru-RU";

  const backdrop = await blueBackdrop();
  pres.defineSlideMaster({ title: "Светлый", background: { color: COL.light }, objects: [] });
  pres.defineSlideMaster({
    title: "Синий", background: { color: COL.blue },
    objects: [{ image: { x: 0, y: 0, w: W, h: H, data: backdrop } }],
  });

  const ic = {};
  const want = {
    clock: ["LuClockAlert", COL.blue], users: ["LuUsers", COL.blue], chat: ["LuMessagesSquare", COL.blue],
    bell: ["LuBellRing", COL.blue], tasks: ["LuListChecks", COL.blue],
    db: ["LuDatabase", COL.white], globe: ["LuGlobe", COL.white], sliders: ["LuSlidersHorizontal", COL.white],
    layers: ["LuLayers", COL.white], refresh: ["LuRefreshCw", COL.white],
    book: ["LuBookOpen", COL.white], tag: ["LuTag", COL.white], door: ["LuDoorOpen", COL.white],
    user: ["LuUser", COL.white], cal: ["LuCalendarDays", COL.white], move: ["LuArrowLeftRight", COL.white],
    repeat: ["LuRepeat", COL.white],
    image: ["LuImage", COL.frame], qr: ["LuQrCode", COL.frame],
    domain: ["LuWaypoints", COL.blue], code: ["LuCodeXml", COL.blue], bot: ["LuBot", COL.blue],
  };
  for (const [k, [n, c]] of Object.entries(want)) ic[k] = await icon(n, c);

  // ===== СЛАЙД 1. Титул =====
  {
    const s = pres.addSlide({ masterName: "Светлый" });
    s.addImage({ data: await titleComposition(), x: W - COMP_W, y: 0, w: COMP_W, h: H, altText: "Абстрактная композиция: круг и многоугольник" });
    marker(s, false);
    s.addText([PH("[ТОЧНОЕ НАЗВАНИЕ КОНФЕРЕНЦИИ ИЛИ СЕКЦИИ]", { color: COL.overline, bold: true })], {
      x: M, y: 0.55, w: 7.8, h: 0.35, margin: 0, fontFace: FONT, fontSize: 14, charSpacing: 1, isTextBox: true, objectName: "Надзаголовок",
    });
    s.addText("Разработка класса для\u00A0отслеживания изменений в\u00A0расписании ВИШ ЧувГУ", {
      x: M, y: 1.0, w: 7.7, h: 1.85, margin: 0, fontFace: FONT, fontSize: 34, bold: true, color: COL.ink,
      valign: "top", lineSpacingMultiple: 1.0, isTextBox: true, objectName: "Заголовок",
    });
    s.addText([PH("[ФИО, группа]")], {
      x: M, y: 3.0, w: 7.7, h: 0.4, margin: 0, fontFace: FONT, fontSize: 16, isTextBox: true, objectName: "Авторы",
    });
    iconList(s, [
      { icon: ic.clock, text: "Студенты узнают о переносах пар слишком поздно" },
      { icon: ic.users, text: "Студенты и преподаватели ВИШ" },
      { icon: ic.chat, text: "Чат-бот в Telegram и МАКС" },
      { icon: ic.bell, text: "Автоматически находить изменения и сообщать о них" },
      { icon: ic.tasks, text: "Задачи в реализации проекта" },
    ], { x: M, y: 3.7, w: 7.4, rowH: 0.62, fontSize: 15, color: COL.ink, divColor: COL.line });
  }

  // ===== СЛАЙД 2. Онтология =====
  {
    const s = pres.addSlide({ masterName: "Светлый" });
    marker(s, false);
    lightTitle(s, "Онтология предметной области");

    const node = (x, y, w, h, title, sub, opt = {}) => {
      s.addShape("rect", { x, y, w, h, fill: { color: COL.white }, line: { color: opt.border || "CBD5E1", width: opt.bw || 1 } });
      const runs = [{ text: title, options: { bold: true, fontSize: 15, color: opt.titleColor || COL.ink, breakLine: !!sub } }];
      if (sub) runs.push({ text: sub, options: { fontSize: opt.subSize || 12, color: COL.inkMuted, fontFace: opt.subMono ? MONO : FONT } });
      s.addText(runs, { x: x + 0.15, y, w: w - 0.3, h, margin: 0, fontFace: FONT, valign: "middle", lineSpacingMultiple: 1.1, isTextBox: true });
    };
    const arrow = (x1, y1, x2, y2) => {
      s.addShape("line", {
        x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
        flipH: x2 < x1, flipV: y2 < y1,
        line: { color: "64748B", width: 1.25, endArrowType: "triangle" },
      });
    };
    const label = (text, x, y, w, align = "center") => {
      s.addText(text, { x, y, w, h: 0.28, margin: 0, fontFace: FONT, fontSize: 12, italic: true, color: COL.overline, align, valign: "middle", isTextBox: true });
    };

    // левая колонка
    node(M, 1.5, 3.4, 0.7, "Физическая группа портала");
    node(M, 2.8, 3.4, 1.0, "Логическая группа", "ВИШ\u201112\u201123 = ВИШ\u201112\u201123 + ВИШ\u201112\u201123иот", { subSize: 12 });
    node(M, 4.3, 3.4, 0.7, "Преподаватель");
    arrow(M + 1.7, 2.2, M + 1.7, 2.8); label("объединяется в", M + 1.85, 2.36, 1.6, "left");

    // центр: Пара
    const px = 5.35, py = 1.5, pw = 3.0, hdr = 0.55, rowH = 0.5;
    const attrs = ["предмет", "тип (ЛК / ПР / ЛБ / экзамен)", "аудитория", "дата", "номер пары", "подгруппа"];
    const ph = hdr + attrs.length * rowH;
    s.addShape("rect", { x: px, y: py, w: pw, h: ph, fill: { color: COL.white }, line: { color: COL.blue, width: 1.5 } });
    s.addShape("rect", { x: px, y: py, w: pw, h: hdr, fill: { color: COL.blue }, line: { color: COL.blue, width: 1.5 } });
    s.addText("Пара", { x: px + 0.18, y: py, w: pw - 0.36, h: hdr, margin: 0, fontFace: FONT, fontSize: 16, bold: true, color: COL.white, valign: "middle", isTextBox: true });
    attrs.forEach((a, i) => {
      const ry = py + hdr + i * rowH;
      s.addText(a, { x: px + 0.18, y: ry, w: pw - 0.36, h: rowH, margin: 0, fontFace: FONT, fontSize: 13, color: COL.ink, valign: "middle", isTextBox: true });
      if (i > 0) s.addShape("line", { x: px + 0.18, y: ry, w: pw - 0.36, h: 0, line: { color: COL.line, width: 0.75 } });
    });
    const pRight = px + pw;

    arrow(M + 3.4, 3.3, px, 3.3); label("посещает", M + 3.4, 2.97, px - M - 3.4);
    arrow(M + 3.4, 4.65, px, 4.65); label("ведёт", M + 3.4, 4.32, px - M - 3.4);

    // правая колонка
    const rx = 9.75, rw = 2.98;
    node(rx, 1.5, rw, 0.85, "Неделя", "чётная / нечётная");
    node(rx, 2.75, rw, 0.85, "Период", "семестр / сессия");
    node(rx, 3.9, rw, 1.45, "Изменение", "было / стало\nвиды: добавлена, убрана, изменена, перенесена", { border: COL.blue, bw: 1.5, titleColor: COL.blue });
    arrow(pRight, 1.93, rx, 1.93); label("относится к", pRight, 1.6, rx - pRight);
    arrow(pRight, 3.18, rx, 3.18); label("относится к", pRight, 2.85, rx - pRight);
    arrow(rx, 4.62, pRight, 4.62); label("ссылается на", pRight, 4.29, rx - pRight);

    // две строки внизу
    s.addShape("line", { x: M, y: 6.0, w: W - 2 * M, h: 0, line: { color: COL.line, width: 0.75 } });
    s.addImage({ data: ic.code, x: M, y: 6.17, w: 0.28, h: 0.28 });
    s.addText([
      { text: "Понятия описаны интерфейсами TypeScript, поведение собрано в классе " },
      { text: "ScheduleService", options: { fontFace: MONO } },
    ], { x: M + 0.45, y: 6.12, w: 11.5, h: 0.38, margin: 0, fontFace: FONT, fontSize: 14, color: COL.ink, valign: "middle", isTextBox: true });
    s.addImage({ data: ic.bot, x: M, y: 6.62, w: 0.28, h: 0.28 });
    s.addText([
      { text: "Бот не ведёт сообщество, а сам находит изменения расписания на портале " },
      { text: "tt.chuvsu.ru", options: { fontFace: MONO } },
    ], { x: M + 0.45, y: 6.57, w: 11.5, h: 0.38, margin: 0, fontFace: FONT, fontSize: 14, color: COL.ink, valign: "middle", isTextBox: true });
  }

  // ===== СЛАЙД 3. Поля =====
  {
    const s = pres.addSlide({ masterName: "Синий" });
    marker(s, true);
    blueTitle(s, "Используемые поля");
    const colW = 3.85, x1 = 4.85, x2 = x1 + colW + 0.3, y0 = 0.95;
    const head = (x, a, b) => s.addText([
      { text: a + " ", options: { fontFace: FONT, color: COL.onBlueMuted } },
      { text: b, options: { fontFace: MONO, bold: true, color: COL.white } },
    ], { x, y: y0, w: colW, h: 0.5, margin: 0, fontSize: 17, valign: "middle", isTextBox: true });
    head(x1, "Класс", "ScheduleService");
    head(x2, "Интерфейс пары", "Occurrence");

    const field = (name, desc) => [
      { text: name, options: { fontFace: MONO, bold: true, color: COL.white, breakLine: true } },
      { text: desc, options: { fontFace: FONT, color: COL.onBlueMuted, fontSize: 13 } },
    ];
    const rows = (x, items, rowH) => items.forEach((it, i) => {
      const ry = y0 + 0.65 + i * rowH;
      s.addImage({ data: it[0], x, y: ry + 0.14, w: 0.32, h: 0.32 });
      s.addText(field(it[1], it[2]), { x: x + 0.52, y: ry + 0.06, w: colW - 0.52, h: rowH - 0.12, margin: 0, fontSize: 15, valign: "top", lineSpacingMultiple: 1.05, isTextBox: true });
      if (i < items.length - 1) s.addShape("line", { x, y: ry + rowH, w: colW, h: 0, line: { color: COL.white, width: 0.75, transparency: 60 } });
    });
    rows(x1, [
      [ic.db, "repo", "хранилище расписания (SQLite)"],
      [ic.globe, "portal", "клиент портала tt.chuvsu.ru"],
      [ic.sliders, "opts", "факультет и скрытые группы"],
      [ic.layers, "groupsCache", "кэш логических групп"],
      [ic.refresh, "polling", "текущий опрос (защита от двух опросов одновременно)"],
    ], 1.0);
    rows(x2, [
      [ic.book, "subject", "предмет"],
      [ic.tag, "type", "тип занятия"],
      [ic.door, "room", "аудитория"],
      [ic.user, "teacher", "преподаватель"],
      [ic.cal, "date, slot", "дата и номер пары"],
      [ic.move, "status", "по расписанию / перенесена"],
    ], 0.833);
  }

  // ===== СЛАЙД 4. Методы =====
  {
    const s = pres.addSlide({ masterName: "Синий" });
    marker(s, true);
    blueTitle(s, "Используемые методы", [
      { text: "ScheduleService.weekInfo", options: { fontFace: MONO, bold: true, color: COL.white, breakLine: true } },
      { text: "номер и чётность учебной недели" },
    ]);
    codeBlock(s, [
      "weekInfo(date: LocalDate): WeekInfo {",
      "  const semester = this.semesterFor(date);",
      "  const anchor = this.weekOneMonday(semester);",
      "  if (!anchor) return { week: null, parity: null, semester };",
      "  const week = Math.floor((Date.parse(mondayOf(date))",
      "      - Date.parse(anchor)) / (7 * 86_400_000)) + 1;",
      "  if (week < 1 || week > SEMESTER_WEEKS + 4)",
      "    return { week: null, parity: null, semester };",
      "  return { week, parity: week % 2 === 1 ? \"odd\" : \"even\",",
      "           semester };",
      "}",
    ].join("\n"), { x: 4.75, y: 1.0, w: 7.98, h: 3.75 });
  }

  // ===== СЛАЙД 5. Функции =====
  {
    const s = pres.addSlide({ masterName: "Синий" });
    marker(s, true);
    blueTitle(s, "Используемые функции", [
      { text: "changedFields", options: { fontFace: MONO, bold: true, color: COL.white, breakLine: true } },
      { text: "что именно изменилось в паре" },
    ]);
    codeBlock(s, [
      "export function changedFields(",
      "  a: Occurrence, b: Occurrence): string[] {",
      "  const f: string[] = [];",
      "  if (a.room !== b.room) f.push(\"room\");",
      "  if (a.teacher && b.teacher",
      "      && !samePerson(a.teacher, b.teacher)) f.push(\"teacher\");",
      "  if (a.start !== b.start || a.end !== b.end) f.push(\"time\");",
      "  if (a.isDistance !== b.isDistance) f.push(\"distance\");",
      "  if (a.status !== b.status) f.push(\"status\");",
      "  if ((a.movedTo?.date ?? \"\") !== (b.movedTo?.date ?? \"\")",
      "      || (a.movedTo?.slot ?? \"\") !== (b.movedTo?.slot ?? \"\"))",
      "    f.push(\"movedTo\");",
      "  return f;",
      "}",
    ].join("\n"), { x: 4.75, y: 1.0, w: 7.98, h: 4.45 });
    iconList(s, [
      { icon: ic.move, text: "«Убрана здесь + появилась там» = одно событие «перенесена»" },
      { icon: ic.repeat, text: "Пустую страницу портала принимаем только после 3 опросов подряд" },
    ], { x: 4.75, y: 5.75, w: 7.98, rowH: 0.55, iconSz: 0.3, fontSize: 15, color: COL.white, divColor: COL.white, divTransp: 60 });
  }

  // ===== СЛАЙД 6. Демонстрация =====
  {
    const s = pres.addSlide({ masterName: "Светлый" });
    marker(s, false);
    lightTitle(s, "Демонстрация");
    const frame = (x, y, w, h, name) => s.addShape("roundRect", {
      x, y, w, h, rectRadius: 0.12, fill: { color: COL.white }, line: { color: COL.frame, width: 1.25, dashType: "dash" }, objectName: name,
    });
    // скриншот
    frame(M, 1.45, 7.6, 4.85, "Рамка под скриншот");
    s.addImage({ data: ic.image, x: M + 3.8 - 0.35, y: 3.2, w: 0.7, h: 0.7 });
    s.addText("скриншот: уведомление об изменении", { x: M, y: 4.0, w: 7.6, h: 0.4, margin: 0, fontFace: FONT, fontSize: 14, color: "64748B", align: "center", isTextBox: true });
    // QR
    const qx = 9.05, qs = 3.68;
    frame(qx, 1.45, qs, qs, "Рамка под QR-код");
    s.addImage({ data: ic.qr, x: qx + qs / 2 - 0.35, y: 2.55, w: 0.7, h: 0.7 });
    s.addText([PH("[@имя_бота]")], { x: qx, y: 3.4, w: qs, h: 0.4, margin: 0, fontFace: FONT, fontSize: 15, align: "center", isTextBox: true });
    s.addText("Попробовать бота", { x: qx, y: 5.3, w: qs, h: 0.5, margin: 0, fontFace: FONT, fontSize: 20, bold: true, color: COL.ink, align: "center", valign: "middle", isTextBox: true });
    // строка с цифрами
    s.addText([PH("[N пользователей]"), { text: "  ·  ", options: { color: COL.inkMuted } }, PH("[N групп]")], {
      x: M, y: 6.6, w: 7.6, h: 0.4, margin: 0, fontFace: FONT, fontSize: 16, isTextBox: true, objectName: "Цифры",
    });
  }

  // ===== СЛАЙД 7. Заключение и литература =====
  {
    const s = pres.addSlide({ masterName: "Светлый" });
    marker(s, false);
    lightTitle(s, "Заключение");
    iconList(s, [
      { icon: ic.domain, text: "Описали предметную область и перенесли её в код" },
      { icon: ic.code, text: "Разработали класс отслеживания изменений расписания" },
      { icon: ic.users, text: "Ботом пользуются студенты ВИШ" },
    ], { x: M, y: 1.6, w: 4.9, rowH: 0.95, iconSz: 0.38, fontSize: 16, color: COL.ink, divColor: COL.line });

    const lx = 6.05, lw = W - M - lx;
    s.addShape("rect", { x: lx, y: 1.0, w: lw, h: 5.6, fill: { color: COL.white }, line: { color: COL.line, width: 0.75 }, objectName: "Литература: подложка" });
    s.addText("Литература", { x: lx + 0.35, y: 1.2, w: lw - 0.7, h: 0.45, margin: 0, fontFace: FONT, fontSize: 20, bold: true, color: COL.ink, isTextBox: true });
    const refs = [
      "Гамма Э., Хелм Р., Джонсон Р., Влиссидес Дж. Паттерны объектно-ориентированного проектирования. СПб.: Питер, 2021. 448 с.",
      "Гольчевский Ю. В., Непеин А. В. Проектирование и разработка чат-бота для представления расписания в социальной сети // Вестник Сыктывкарского университета. Сер. 1: Математика. Механика. Информатика. 2021. Вып. 3 (40). С. 41–61. DOI: 10.34130/1992-2752_2021_3_41.",
      "Данилина Е. К. Обучение с помощью технологии чат-бот: терминология и общая характеристика // Территория новых возможностей. Вестник Владивостокского государственного университета. 2024. Т. 16, № 4. С. 154–162. DOI: 10.29039/2949-1258/2024-4/154-162.",
      "Дейнеко Т. А., Бобров Д. А. Чат-бот ВКонтакте «Расписание занятий ОмГУ» // Математические структуры и моделирование. 2020. № 3 (55). С. 117–122. DOI: 10.24147/2222-8772.2020.3.117-122.",
      "Загорулько Ю. А., Боровикова О. И. Использование системы разнородных паттернов онтологического проектирования для разработки онтологий научных предметных областей // Программирование. 2020. № 4. С. 27–35.",
      "Сазанов В. А., Хлобыстова А. О., Абрамов М. В. Разработка чат-бота для отслеживания расписания учебных занятий в университете // Программные продукты и системы. 2023. Т. 36, № 3. С. 466–473. DOI: 10.15827/0236-235X.143.466-473.",
    ];
    s.addText(refs.map((r, i) => ({
      text: r, options: { bullet: { type: "number" }, paraSpaceAfter: 6, breakLine: i < refs.length - 1 },
    })), { x: lx + 0.35, y: 1.8, w: lw - 0.7, h: 4.95, margin: 0, fontFace: FONT, fontSize: 11, color: "334155", valign: "top", isTextBox: true, objectName: "Литература" });
  }

  const out = process.argv[2] || "schedule-changes-conference.pptx";
  await pres.writeFile({ fileName: out });
  console.log("written", out);
})();
