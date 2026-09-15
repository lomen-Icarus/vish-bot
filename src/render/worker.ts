/**
 * Poster renderer running in its own process.
 *
 * @resvg/resvg-js (2.6.2, and the 2.7 alphas) never frees the pixmap of a
 * rendered image: every poster leaks about 5 MB of native memory that no
 * garbage collection reclaims, so a long-lived bot would exhaust a 2 GB
 * container after a few hundred posters. Rendering here lets the parent
 * recycle the whole process, which returns everything to the OS, and keeps
 * the heavy rasterisation off the bot's event loop.
 */
import { MultiThemeRenderer } from "./themes.js";
import type { DayRenderInput, StreamRenderInput, WeekRenderInput } from "./image.js";
import type { Occurrence } from "../schedule/model.js";
import type { LocalDate } from "../time.js";

export interface RenderRequest {
  id: number;
  kind: "day" | "week" | "stream";
  /** Week input carries a Map, which does not survive IPC; it travels as pairs. */
  input: unknown;
}

export interface RenderResponse {
  id: number;
  ok: boolean;
  png?: string;
  error?: string;
}

export type WeekWireInput = Omit<WeekRenderInput, "byDate"> & { byDate: Array<[LocalDate, Occurrence[]]> };

async function main(): Promise<void> {
  // One renderer per theme, built on first use: a student can pick any of them.
  const renderer = new MultiThemeRenderer(process.env.POSTER_THEME || "midnight");
  try {
    await renderer.renderDay({
      group: { key: "probe", title: "ВИШ", prefix: "ВИШ", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] },
      date: "2026-09-01",
      lessons: [],
      weekInfo: { week: 1, parity: "odd", semester: 1 },
      today: "2026-09-01",
    });
  } catch (err) {
    process.send?.({ id: 0, ok: false, error: String(err) } satisfies RenderResponse);
    process.exit(1);
  }
  process.send?.({ id: 0, ok: true } satisfies RenderResponse); // ready

  process.on("message", (msg: RenderRequest) => {
    void (async () => {
      try {
        let png: Buffer;
        if (msg.kind === "day") png = await renderer.renderDay(msg.input as DayRenderInput);
        else if (msg.kind === "stream") png = await renderer.renderStreamDay(msg.input as StreamRenderInput);
        else {
          const wire = msg.input as WeekWireInput;
          png = await renderer.renderWeek({ ...wire, byDate: new Map(wire.byDate) });
        }
        process.send?.({ id: msg.id, ok: true, png: png.toString("base64") } satisfies RenderResponse);
      } catch (err) {
        process.send?.({ id: msg.id, ok: false, error: String(err) } satisfies RenderResponse);
      }
    })();
  });
}

void main();
