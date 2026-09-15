/**
 * Renderer that draws posters in a child process and recycles it.
 *
 * resvg leaks the pixmap of every rendered image (see worker.ts), so the only
 * reliable way to give that memory back is to end the process holding it. The
 * pool renders one poster at a time, restarts the worker after a set number of
 * posters, and falls back to an error the caller can handle when the worker
 * dies or hangs.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DayRenderInput, Renderer, StreamRenderInput, WeekRenderInput } from "./image.js";
import { createThemedRenderer } from "./themes.js";
import type { RenderRequest, RenderResponse, WeekWireInput } from "./worker.js";
import { logger } from "../logger.js";

export interface PoolOptions {
  theme: string;
  /** Posters drawn before the worker is replaced (each leaks ~5 MB in resvg). */
  rendersPerWorker?: number;
  /** A single poster may never take longer than this. */
  timeoutMs?: number;
}

interface Pending {
  resolve(png: Buffer): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

class RenderPool implements Renderer {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private renders = 0;
  private nextId = 1;
  private stopped = false;

  constructor(private readonly opts: Required<PoolOptions>) {}

  private spawn(): Promise<ChildProcess> {
    if (this.starting) return this.starting;
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js");
      const child = fork(worker, [], { env: { ...process.env, POSTER_THEME: this.opts.theme }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      const ready = setTimeout(() => reject(new Error("render worker did not start")), 30_000);
      child.once("message", (msg: RenderResponse) => {
        clearTimeout(ready);
        if (msg.ok) {
          this.child = child;
          this.renders = 0;
          child.on("message", (m: RenderResponse) => this.settle(m));
          child.once("exit", (code) => {
            if (this.child === child) this.child = null;
            for (const [id, p] of this.pending) {
              clearTimeout(p.timer);
              p.reject(new Error(`render worker exited (${code})`));
              this.pending.delete(id);
            }
          });
          logger.debug({ theme: this.opts.theme, pid: child.pid }, "render worker started");
          resolve(child);
        } else {
          child.kill();
          reject(new Error(msg.error ?? "render worker failed to start"));
        }
      });
      child.once("error", (err) => {
        clearTimeout(ready);
        reject(err);
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private settle(msg: RenderResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok && msg.png) p.resolve(Buffer.from(msg.png, "base64"));
    else p.reject(new Error(msg.error ?? "render failed"));
  }

  private recycle(reason: string): void {
    const child = this.child;
    this.child = null;
    if (child) {
      logger.debug({ reason, pid: child.pid }, "recycling render worker");
      child.kill();
    }
  }

  /** One poster at a time: two concurrent renders would double the peak memory. */
  private run(kind: RenderRequest["kind"], input: unknown): Promise<Buffer> {
    const task = this.queue.then(async () => {
      if (this.stopped) throw new Error("renderer stopped");
      if (this.child && this.renders >= this.opts.rendersPerWorker) this.recycle("render budget reached");
      const child = this.child ?? (await this.spawn());
      const id = this.nextId++;
      this.renders++;
      return await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.recycle("render timed out");
          reject(new Error("render timed out"));
        }, this.opts.timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        child.send({ id, kind, input } satisfies RenderRequest, (err) => {
          if (!err) return;
          this.pending.delete(id);
          clearTimeout(timer);
          this.recycle("send failed");
          reject(err);
        });
      });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  renderDay(input: DayRenderInput): Promise<Buffer> {
    return this.run("day", input);
  }

  renderWeek(input: WeekRenderInput): Promise<Buffer> {
    const wire: WeekWireInput = { ...input, byDate: [...input.byDate.entries()] };
    return this.run("week", wire);
  }

  renderStreamDay(input: StreamRenderInput): Promise<Buffer> {
    return this.run("stream", input);
  }

  stop(): void {
    this.stopped = true;
    this.recycle("shutdown");
  }
}

export interface PooledRenderer extends Renderer {
  stop(): void;
}

/**
 * Pooled renderer when running the built bot, in-process renderer when running
 * from source (tsx cannot fork a .ts worker directly).
 */
export async function createPooledRenderer(opts: PoolOptions): Promise<PooledRenderer | null> {
  const fromSource = import.meta.url.endsWith(".ts");
  if (fromSource) {
    const renderer = await createThemedRenderer(opts.theme);
    if (!renderer) return null;
    return Object.assign(renderer, { stop: () => undefined });
  }
  const pool = new RenderPool({ theme: opts.theme, rendersPerWorker: opts.rendersPerWorker ?? 30, timeoutMs: opts.timeoutMs ?? 25_000 });
  // Fail fast if the worker cannot start at all (missing fonts, bad theme).
  await pool.renderDay({
    group: { key: "probe", title: "ВИШ", prefix: "ВИШ", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] },
    date: "2026-09-01",
    lessons: [],
    weekInfo: { week: 1, parity: "odd", semester: 1 },
    today: "2026-09-01",
  });
  return pool;
}
