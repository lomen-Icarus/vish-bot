/**
 * Съёмка слайдов из комнаты BigBlueButton.
 *
 * Идея простая: заходим в комнату слушателем, закрываем диалог про звук,
 * находим область презентации и снимаем её. Кадр сохраняем, только когда
 * слайд действительно сменился — по номеру слайда, если он виден, иначе по
 * хэшу картинки, и обязательно дождавшись, что картинка «устоялась». Так в
 * пачку не попадают полупрорисованные кадры и дрожание от чужого курсора.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { log } from "./log.js";

export interface CaptureOptions {
  url: string;
  outDir: string;
  /** Как часто смотреть на слайд. */
  intervalSeconds: number;
  /** Сколько максимум сидеть в комнате. */
  maxMinutes: number;
  headless: boolean;
  chromiumPath?: string;
  displayName?: string;
  /** Вызывается на каждом новом слайде — удобно для логов и живого прогресса. */
  onSlide?: (index: number, file: string) => void;
}

export interface CaptureResult {
  slides: Array<{ index: number; file: string; at: string; slideNumber: string | null }>;
  startedAt: string;
  finishedAt: string;
  /** Какой селектор в итоге сработал — это главное, что нужно знать при отладке. */
  usedSelector: string | null;
  notes: string[];
}

/** Кандидаты на область презентации: у разных версий BBB разметка своя. */
const PRESENTATION_SELECTORS = [
  '[data-test="presentationContainer"]',
  '[data-test="whiteboard"]',
  "#whiteboard-element",
  "#slide-background-shape",
  'svg[data-test="svggroup"]',
  "#presentationAreaData",
  '[class*="presentationContainer"]',
  '[class*="whiteboard"]',
];

/** Кнопки, которыми BBB встречает гостя. Нажимаем то, что найдём. */
const ENTRY_BUTTONS = [
  '[data-test="listenOnlyBtn"]',
  '[data-test="closeModal"]',
  'button[aria-label*="Слушать"]',
  'button[aria-label*="Listen"]',
  'button:has-text("Слушать только")',
  'button:has-text("Listen only")',
  'button:has-text("Отмена")',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function firstVisible(page: Page, selectors: string[], minWidth = 200): Promise<{ locator: Locator; selector: string } | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (!(await locator.isVisible({ timeout: 500 }))) continue;
      const box = await locator.boundingBox();
      if (!box || box.width < minWidth || box.height < 100) continue;
      return { locator, selector };
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}

/** Номер слайда, если BBB его показывает («3 / 20»). */
async function slideNumber(page: Page): Promise<string | null> {
  const candidates = ['[data-test="currentSlideText"]', '[data-test="slideNumber"]', "select#skipSlide", '[class*="skipSlide"] select', '[class*="presentationPaginationLabel"]'];
  for (const selector of candidates) {
    try {
      const el = page.locator(selector).first();
      if (!(await el.isVisible({ timeout: 300 }))) continue;
      const text = (await el.inputValue().catch(() => null)) ?? (await el.textContent());
      if (text && text.trim()) return text.trim().slice(0, 40);
    } catch {
      /* следующий кандидат */
    }
  }
  return null;
}

export async function captureWebinar(opts: CaptureOptions): Promise<CaptureResult> {
  const notes: string[] = [];
  mkdirSync(opts.outDir, { recursive: true });
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const result: CaptureResult = { slides: [], startedAt: new Date().toISOString(), finishedAt: "", usedSelector: null, notes };
  try {
    browser = await chromium.launch({
      headless: opts.headless,
      ...(opts.chromiumPath ? { executablePath: opts.chromiumPath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: "ru-RU", permissions: [] });
    const page = await context.newPage();
    page.on("console", (msg) => log.debug({ text: msg.text().slice(0, 200) }, "browser console"));
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 90_000 });

    // BBB иногда сам спрашивает имя — подставляем то, под которым бот виден в списке.
    if (opts.displayName) {
      const nameInput = page.locator('input[name="joinName"], input#joinName, input[placeholder*="мя"]').first();
      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill(opts.displayName).catch(() => undefined);
        await page.keyboard.press("Enter").catch(() => undefined);
        notes.push("ввели имя участника вручную");
      }
    }

    // Диалог «как подключиться к аудио»: нам нужен режим «только слушать».
    for (const selector of ENTRY_BUTTONS) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click({ timeout: 5000 }).catch(() => undefined);
        notes.push(`нажали ${selector}`);
        break;
      }
    }
    await sleep(3000);

    // Чужие курсоры и всплывающие подсказки дрожат поверх слайда и создают
    // ложные «смены слайда» — прячем их, чтобы кадры были стабильными.
    await page
      .addStyleTag({
        content: `[data-test="cursor"], [class*="cursor"], [class*="tooltip"], [class*="Toast"], [class*="toast"], [class*="chat"], [class*="notification"] { visibility: hidden !important; }`,
      })
      .catch(() => undefined);

    // Клиент BBB дорисовывает доску не сразу, и одной попытки мало: ищем
    // область снова на каждом круге, пока не найдём.
    let area = await firstVisible(page, PRESENTATION_SELECTORS);
    result.usedSelector = area?.selector ?? null;
    if (!area) notes.push("область презентации сразу не нашлась, ищу дальше");

    const deadline = Date.now() + opts.maxMinutes * 60_000;
    let lastHash = "";
    let pendingHash = "";
    let pendingShots = 0;
    let index = 0;
    let lastNumber: string | null = null;

    while (Date.now() < deadline) {
      await sleep(opts.intervalSeconds * 1000);
      if (page.isClosed()) break;
      if (!area) {
        area = await firstVisible(page, PRESENTATION_SELECTORS);
        if (area) {
          result.usedSelector = area.selector;
          notes.push(`область презентации нашлась позже: ${area.selector}`);
        }
      }
      let png: Buffer;
      try {
        png = area ? await area.locator.screenshot({ timeout: 15_000 }) : await page.screenshot({ timeout: 15_000 });
      } catch (err) {
        log.debug({ err: String(err) }, "кадр не снялся");
        continue;
      }
      const hash = createHash("sha1").update(png).digest("hex");
      const number = await slideNumber(page);
      const numberChanged = number != null && number !== lastNumber;
      if (hash === lastHash && !numberChanged) {
        pendingShots = 0;
        continue;
      }
      // Ждём, пока картинка перестанет меняться: анимация перехода между
      // слайдами иначе попадёт в пачку полурисованным кадром.
      if (hash !== pendingHash) {
        pendingHash = hash;
        pendingShots = 1;
        continue;
      }
      pendingShots++;
      if (pendingShots < 2) continue;
      index++;
      const file = path.join(opts.outDir, `slide-${String(index).padStart(3, "0")}.png`);
      writeFileSync(file, png);
      result.slides.push({ index, file, at: new Date().toISOString(), slideNumber: number });
      opts.onSlide?.(index, file);
      lastHash = hash;
      lastNumber = number;
      pendingShots = 0;
      log.info({ index, slideNumber: number, bytes: png.length }, "снят слайд");

      // Комната закрылась — дальше сидеть незачем.
      const ended = await page
        .locator('[data-test="meetingEndedModal"], :text("Конференция завершена"), :text("Meeting ended")')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);
      if (ended) {
        notes.push("вебинар завершён ведущим");
        break;
      }
    }
  } finally {
    result.finishedAt = new Date().toISOString();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
  return result;
}
