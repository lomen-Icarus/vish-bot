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
