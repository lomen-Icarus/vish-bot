/**
 * Poster theme registry. "midnight" is the original dark theme in image.ts;
 * the others live in ./variants and are picked with POSTER_THEME.
 */
import type { Renderer } from "./image.js";
import { createRenderer as midnight } from "./image.js";
import { logger } from "../logger.js";

export const THEMES = ["midnight", "editorial", "brutalist", "timeline"] as const;
export type ThemeName = (typeof THEMES)[number];

export async function createThemedRenderer(name: string): Promise<Renderer | null> {
  switch (name) {
    case "editorial":
      return (await import("./variants/editorial.js")).createRenderer();
    case "brutalist":
      return (await import("./variants/brutalist.js")).createRenderer();
    case "timeline":
      return (await import("./variants/timeline.js")).createRenderer();
    case "midnight":
      return midnight();
    default:
      logger.warn({ theme: name }, "unknown POSTER_THEME, using midnight");
      return midnight();
  }
}
