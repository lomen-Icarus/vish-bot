/**
 * Shared poster plumbing: satori element helpers, bundled Inter fonts and
 * the SVG -> PNG step. Every poster theme (src/render/image.ts and
 * src/render/variants/*) builds on this so themes differ only in design.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { plural } from "../schedule/format.js";
import satori, { type Font } from "satori";
import { Resvg } from "@resvg/resvg-js";
import { logger } from "../logger.js";

export type Style = Record<string, string | number>;
export interface El {
  type: string;
  props: { style?: Style; children?: unknown };
}

/** Element with a style and children (satori consumes React-like objects). */
export const h = (type: string, style: Style, ...children: unknown[]): El => ({ type, props: { style, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) } });
/** Text span. */
export const text = (s: string, style: Style = {}): El => ({ type: "span", props: { style, children: s } });

/** Poster width in px (Telegram shows it at phone width, so ~2x for crispness). */
export const W = 1080;
export const PAD = 56;

/** Subsets are registered as separate families so satori falls back per glyph. */
const SUBSET_FAMILIES: Record<string, string> = { latin: "Inter", cyrillic: "InterCyr", "latin-ext": "InterLatExt", "cyrillic-ext": "InterCyrExt" };
/** font-family value that covers Latin + Cyrillic. Weights available: 400, 500, 600, 700, 800. */
export const FONT = Object.values(SUBSET_FAMILIES).join(", ");

let fontsPromise: Promise<Font[]> | null = null;

export function loadFonts(): Promise<Font[]> {
  fontsPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@fontsource/inter/package.json");
    const dir = path.join(path.dirname(pkg), "files");
    const specs: Array<{ weight: 400 | 500 | 600 | 700 | 800; file: string; name: string }> = [];
    for (const weight of [400, 500, 600, 700, 800] as const) {
      for (const [subset, name] of Object.entries(SUBSET_FAMILIES)) specs.push({ weight, file: `inter-${subset}-${weight}-normal.woff`, name });
    }
    const fonts: Font[] = [];
    for (const s of specs) {
      try {
        fonts.push({ name: s.name, data: await readFile(path.join(dir, s.file)), weight: s.weight, style: "normal" });
      } catch (err) {
        logger.warn({ err, file: s.file }, "font subset missing");
      }
    }
    if (!fonts.length) throw new Error("No Inter font files found");
    return fonts;
  })();
  return fontsPromise;
}

/** Render a satori tree to a PNG buffer at width W. */
export async function toPng(tree: El, fonts: Font[], width = W): Promise<Buffer> {
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], { width, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } }).render().asPng();
  return Buffer.from(png);
}

/** «1 пара, 2 пары, 5 пар» — правило общее с текстовыми экранами. */
export function pluralPairs(n: number): string {
  return plural(n, "пара", "пары", "пар");
}

// ---------- пометки изменений (уведомления об изменениях) ----------

/** Что случилось с парой: изменилась, появилась или отменена. Общие для всех тем цвета и подписи. */
export type MarkKind = "changed" | "added" | "cancelled";

export const MARK_STYLE: Record<MarkKind, { color: string; label: string }> = {
  changed: { color: "#f59e0b", label: "ИЗМЕНЕНО" },
  added: { color: "#22c55e", label: "НОВАЯ ПАРА" },
  cancelled: { color: "#ef4444", label: "ОТМЕНЕНА" },
};

/**
 * Значки рисуем сами (SVG), а не эмодзи: в шрифте постера эмодзи нет.
 * Карандаш — изменение, плюс — новая пара, крестик — отмена.
 */
const ICON_PATH: Record<MarkKind | "alert" | "calendar" | "arrow", string> = {
  changed: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  added: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  cancelled: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  alert: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  calendar: "M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z",
  arrow: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z",
};

/**
 * Текст с «→» для постера: стрелки в шрифте нет, рисуем её значком. Пробелы
 * по краям кусков satori съедает — отступы задаём полями.
 */
export function withArrows(s: string, style: Style & { fontSize: number; color: string }): El[] {
  const parts = s.split("→").map((p) => p.trim());
  const out: El[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(icon("arrow", style.color, Math.round(style.fontSize * 1.15), { margin: "0 6px" }));
    if (p) out.push(text(p, style));
  });
  return out;
}

export function icon(kind: keyof typeof ICON_PATH, color: string, size: number, style: Style = {}): El {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}"><path fill="${color}" d="${ICON_PATH[kind]}"/></svg>`;
  return { type: "img", props: { src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, width: size, height: size, style: { width: size, height: size, ...style } } as El["props"] };
}

/** Плашка над строкой пары: значок, «ИЗМЕНЕНО / НОВАЯ ПАРА / ОТМЕНЕНА» и в чём дело. */
export function markBadge(mark: { kind: MarkKind; note: string }, opts: { fontSize?: number; marginBottom?: number } = {}): El {
  const { color, label } = MARK_STYLE[mark.kind];
  const fs = opts.fontSize ?? 22;
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center", flexWrap: "wrap", alignSelf: "flex-start", padding: "6px 14px 6px 10px", borderRadius: 12, backgroundColor: color + "26", border: `2px solid ${color}`, marginBottom: opts.marginBottom ?? 10 },
    icon(mark.kind, color, fs + 6, { marginRight: 8 }),
    text(label, { fontSize: fs, fontWeight: 800, color, letterSpacing: 0.5, marginRight: mark.note ? 12 : 0 }),
    ...(mark.note ? withArrows(mark.note, { fontSize: fs, fontWeight: 600, color }) : []),
  );
}

/** Полоса во всю ширину сверху постера: «ИЗМЕНЕНИЯ НА СЕГОДНЯ» (красная) или «на будущее» (синяя). */
export function changeBanner(banner: { text: string; tone: "urgent" | "info" }): El {
  const color = banner.tone === "urgent" ? "#ef4444" : "#3b82f6";
  return h(
    "div",
    { display: "flex", flexDirection: "row", alignItems: "center", width: "100%", padding: "16px 22px", borderRadius: 16, backgroundColor: color, marginBottom: 26 },
    icon(banner.tone === "urgent" ? "alert" : "calendar", "#ffffff", 34, { marginRight: 14 }),
    text(banner.text, { fontSize: 30, fontWeight: 800, color: "#ffffff", letterSpacing: 0.5 }),
  );
}
