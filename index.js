#!/usr/bin/env node
/**
 * Launcher for hosting panels whose Node image is older than the bot needs
 * (Pterodactyl "nodejs_18" egg). On Node >= 22.19 it runs dist/main.js with
 * the current binary. Otherwise it downloads a portable Node 22 into .runtime/
 * once, installs the (pure-JS) dependencies with it and starts the bot.
 * Uses only syntax available on Node 18.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = [22, 19, 0];
const NODE_VERSION = process.env.BOT_NODE_VERSION || "22.23.2";
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"]; // node:sqlite still prints one on 22.x
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const ENTRY = path.join(ROOT, "dist", "main.js");

function versionOk(v) {
  const p = v.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (p[i] > REQUIRED[i]) return true;
    if (p[i] < REQUIRED[i]) return false;
  }
  return true;
}

function archName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Unsupported architecture ${process.arch}`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects) => {
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            res.resume();
            get(new URL(res.headers.location, u).toString(), redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", reject);
    };
    get(url, 0);
  });
}

async function ensureRuntime() {
  const home = path.join(RUNTIME_DIR, `node-v${NODE_VERSION}-linux-${archName()}`);
  const bin = path.join(home, "bin", "node");
  if (fs.existsSync(bin)) return { bin, home };
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const name = `node-v${NODE_VERSION}-linux-${archName()}.tar.gz`;
  const tar = path.join(RUNTIME_DIR, name);
  console.log(`[launcher] Node ${process.version} is too old, downloading portable Node ${NODE_VERSION}…`);
  await download(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`, tar);
  // --no-same-permissions/--touch keep tar from calling utime(), which some hosts forbid.
  execFileSync("tar", ["-xzf", tar, "-C", RUNTIME_DIR, "--touch", "--no-same-owner"]);
  fs.unlinkSync(tar);
  if (!fs.existsSync(bin)) throw new Error("portable Node extraction failed");
  console.log(`[launcher] portable Node ready at ${bin}`);
  return { bin, home };
}

/** Re-install dependencies once per lockfile+runtime, using the runtime that will load them. */
function ensureDependencies(runtime) {
  const lock = path.join(ROOT, "package-lock.json");
  const hash = createHash("sha1").update(fs.existsSync(lock) ? fs.readFileSync(lock) : "").update(NODE_VERSION).digest("hex").slice(0, 12);
  const stamp = path.join(ROOT, "node_modules", ".vish-bot-runtime");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === hash) return;
  console.log("[launcher] installing dependencies with the portable runtime…");
  const npmCli = path.join(runtime.home, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const args = [npmCli, fs.existsSync(lock) ? "ci" : "install", "--omit=dev", "--no-audit", "--no-fund"];
  execFileSync(runtime.bin, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, PATH: `${path.join(runtime.home, "bin")}:${process.env.PATH ?? ""}` } });
  fs.writeFileSync(stamp, hash);
}

function launch(bin) {
  const child = spawn(bin, [...NODE_FLAGS, ENTRY], { cwd: ROOT, stdio: "inherit", env: process.env });
  const forward = (sig) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

async function main() {
  if (!fs.existsSync(ENTRY)) {
    console.error(`[launcher] ${ENTRY} not found. Run "npm run build" (or deploy the built dist/).`);
    process.exit(1);
  }
  if (versionOk(process.version) && !process.env.BOT_FORCE_PORTABLE) {
    launch(process.execPath);
    return;
  }
  const runtime = await ensureRuntime();
  ensureDependencies(runtime);
  launch(runtime.bin);
}

main().catch((err) => {
  console.error("[launcher] fatal:", err);
  process.exit(1);
});
