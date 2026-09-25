/**
 * Poster theme registry. "midnight" is the original dark theme in image.ts;
 * the others live in ./variants. A student picks one in the settings, so a
 * renderer has to be able to draw any of them.
 */
import type { DayRenderInput, Renderer, StreamRenderInput, WeekRenderInput } from "./image.js";
import { createRenderer as midnight } from "./image.js";
import { logger } from "../logger.js";
import type { Occurrence } from "../schedule/model.js";
import { shortGroupTitle } from "../schedule/groups.js";
import { literalLabel } from "../schedule/format.js";

export const THEMES = ["midnight", "editorial", "brutalist", "timeline"] as const;
export type ThemeName = (typeof THEMES)[number];

export const THEME_LABELS: Record<string, string> = {
  midnight: "Тёмная",
  editorial: "Журнальная",
  brutalist: "Плакатная",
  timeline: "Лента",
};

export function isTheme(name: string | null | undefined): name is ThemeName {
  return !!name && (THEMES as readonly string[]).includes(name);
}

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
      logger.warn({ theme: name }, "unknown poster theme, using midnight");
      return midnight();
  }
}

/**
 * Группы пары вместо преподавателя — для постера расписания самого
 * преподавателя. Все темы рисуют строку пары через posterTeacher, поэтому
 * подпись кладётся туда с меткой «как есть»; делается это только здесь, на
 * входе в отрисовку, и в данные расписания метка не попадает.
 */
export function groupsAsLabel(o: Occurrence): Occurrence {
  if (!o.groups?.length) return { ...o, teacher: null };
  const short = o.groups.map(shortGroupTitle);
  return { ...o, teacher: literalLabel(short.length > 3 ? `${short.slice(0, 3).join(", ")}…` : short.join(", ")) };
}

/**
 * Renderer that draws in whichever theme the input asks for, building each
 * theme once. Fonts are loaded once for the process, so an extra theme costs
 * almost nothing.
 */
export class MultiThemeRenderer implements Renderer {
  private readonly cache = new Map<string, Promise<Renderer | null>>();

  constructor(private readonly fallback: string) {}

  private renderer(theme?: string): Promise<Renderer | null> {
    const name = isTheme(theme) ? theme : this.fallback;
    let r = this.cache.get(name);
    if (!r) {
      r = createThemedRenderer(name);
      this.cache.set(name, r);
    }
    return r;
  }

  private async pick(theme: string | undefined): Promise<Renderer> {
    const r = (await this.renderer(theme)) ?? (await this.renderer(this.fallback));
    if (!r) throw new Error("no renderer available");
    return r;
  }

  async renderDay(input: DayRenderInput): Promise<Buffer> {
    return (await this.pick(input.theme)).renderDay(input.labels === "groups" ? { ...input, lessons: input.lessons.map(groupsAsLabel), teacherView: "plain" } : input);
  }

  async renderWeek(input: WeekRenderInput): Promise<Buffer> {
    if (input.labels !== "groups") return (await this.pick(input.theme)).renderWeek(input);
    const byDate = new Map([...input.byDate].map(([d, list]) => [d, list.map(groupsAsLabel)] as const));
    return (await this.pick(input.theme)).renderWeek({ ...input, byDate, teacherView: "plain" });
  }

  async renderStreamDay(input: StreamRenderInput): Promise<Buffer> {
    return (await this.pick(input.theme)).renderStreamDay(input);
  }
}
