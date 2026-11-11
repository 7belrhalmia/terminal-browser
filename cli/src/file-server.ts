import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
const SERVERS_DIR = path.join(STATE_HOME, "terminal-browser-remote", "files");
const TOKEN_ENV = "TERMINAL_BROWSER_FILES_TOKEN";
const IDLE_MS = 30 * 60_000;
const START_TIMEOUT_MS = 5000;

interface Served {
  pid: number;
  port: number;
  token: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

function recordPath(dir: string): string {
  return path.join(SERVERS_DIR, `${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 24)}.json`);
}

function running(record: string): Served | null {
  try {
    const served = JSON.parse(fs.readFileSync(record, "utf8")) as Served;
    process.kill(served.pid, 0);
    return served;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A browser shown on another computer cannot read this machine's files: it gets them over http
// from this machine's own loopback address, which it reaches through its ssh connection.
export async function serveFile(file: string, self: string[]): Promise<string> {
  const real = fs.realpathSync(file);
  const dir = path.dirname(real);
  const record = recordPath(dir);
  let served = running(record);
  if (!served) {
    fs.rmSync(record, { force: true });
    // The secret goes through the environment: a command line is visible to every user of the machine.
    const child = spawn(self[0], [...self.slice(1), "serve-files", dir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", [TOKEN_ENV]: crypto.randomBytes(24).toString("hex") },
    });
    child.unref();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!served && Date.now() < deadline) {
      await sleep(50);
      served = running(record);
    }
    if (!served) throw new Error(`could not serve ${dir} to the browser`);
  }
  return `http://127.0.0.1:${served.port}/${served.token}/${encodeURIComponent(path.basename(real))}`;
}

export function serveFilesCommand(dir: string | undefined): Promise<number> {
  const token = process.env[TOKEN_ENV];
  if (!dir || !token) {
    process.stderr.write("serve-files is started by terminal-browser itself\n");
    return Promise.resolve(1);
  }
  const root = fs.realpathSync(dir);
  const record = recordPath(root);
  const prefix = `/${token}/`;
  let idle: NodeJS.Timeout;
  const stop = () => {
    fs.rmSync(record, { force: true });
    process.exit(0);
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, IDLE_MS);
  };
  const server = http.createServer((request, response) => {
    touch();
    const refuse = (status: number) => {
      response.writeHead(status, { "Content-Type": "text/plain" });
      response.end();
    };
    if (request.method !== "GET" && request.method !== "HEAD") return refuse(405);
    const pathname = (request.url ?? "").split("?")[0];
    if (!pathname.startsWith(prefix)) return refuse(404);
    let target: string;
    try {
      target = fs.realpathSync(path.join(root, decodeURIComponent(pathname.slice(prefix.length))));
    } catch {
      return refuse(404);
    }
    if (target !== root && !target.startsWith(root + path.sep)) return refuse(404);
    let stat = fs.statSync(target);
    if (stat.isDirectory()) {
      target = path.join(target, "index.html");
      try {
        stat = fs.statSync(target);
      } catch {
        return refuse(404);
      }
    }
    response.writeHead(200, {
      "Content-Type": TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    if (request.method === "HEAD") return response.end();
    fs.createReadStream(target).on("error", () => response.destroy()).pipe(response);
  });
  return new Promise(() => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      fs.mkdirSync(SERVERS_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(record, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
      touch();
    });
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}
