import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { recordKey } from "./instances";
import { instances } from "./registry";

const STATE_HOME = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
const REMOTE_DIR = path.join(STATE_HOME, "terminal-browser-remote");
const REMOTE_DIR_SCRIPT =
  'd="${XDG_STATE_HOME:-$HOME/.local/state}/terminal-browser-remote"; mkdir -p "$d" && chmod 700 "$d" && printf %s "$d"';
const KEY_PREFIX = "ssh-";
const ASK_TIMEOUT_MS = 130_000;
const RUN_TIMEOUT_MS = 120_000;

export interface RemoteReply {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RemoteBrowser {
  key: string;
  tabs: unknown[];
  [field: string]: unknown;
}

interface Tunnel {
  destination: string;
  controlPath: string;
}

// A page on the machine that owns the browser must never be reachable from the other side.
const WEB_ADDRESS = /^(https?:\/\/)?[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s\x00-\x1f]*)?$/;

const PAGE_COMMANDS = new Set([
  "open", "goto", "navigate", "back", "forward", "reload", "snapshot", "click", "dblclick", "fill",
  "type", "press", "hover", "focus", "select", "check", "uncheck", "scroll", "scrollintoview", "wait",
  "get", "is", "find", "eval", "tab", "title", "url", "console", "errors", "highlight", "mouse",
  "keyboard", "frame", "dialog",
]);

// Flags that would point the automation at another browser, profile or local file.
const REFUSED_FLAG =
  /^--(cdp|session|profile|executable-path|state|headers|proxy|args|extension|provider|auto-connect|allow-file-access|config|download-path|user-data-dir|port)\b/;

function refusal(passthrough: string[]): string | null {
  const words = passthrough.filter((arg) => !arg.startsWith("-"));
  const command = words[0];
  if (!command || !PAGE_COMMANDS.has(command)) {
    return `not available from the remote side: ${command ?? "(nothing)"}`;
  }
  const refused = passthrough.find((arg) => REFUSED_FLAG.test(arg));
  if (refused) return `not available from the remote side: ${refused}`;
  const address =
    command === "open" || command === "goto" || command === "navigate"
      ? words[1]
      : command === "tab" && words[1] === "new"
        ? words[2]
        : undefined;
  if (address !== undefined && !WEB_ADDRESS.test(address)) return `not a web address: ${address}`;
  return null;
}

function runSelf(self: string[], args: string[]): Promise<RemoteReply> {
  // The request comes from another machine: which terminal app this process sits in says nothing about it.
  const { TERM_PROGRAM, TERM_PROGRAM_VERSION, ...env } = process.env;
  return new Promise((resolve) => {
    execFile(
      self[0],
      [...self.slice(1), ...args],
      {
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ status, stdout, stderr: stderr || (error && status === 1 && !stdout ? error.message : "") });
      },
    );
  });
}

async function answer(argv: string[], tty: string | null, self: string[], destination: string): Promise<RemoteReply> {
  const mine = (await instances()).find((record) => tty !== null && record.tty === tty);
  if (!mine) return { status: 1, stdout: "", stderr: "the browser is still starting\n" };
  const key = recordKey(mine);
  const [command, ...rest] = argv;
  if (command === "ls") {
    const listed = await runSelf(self, ["ls", "--all", "--json"]);
    if (listed.status !== 0) return listed;
    const all = (JSON.parse(listed.stdout) as { browsers: RemoteBrowser[] }).browsers;
    const shown = all
      .filter((browser) => browser.key === key)
      .map((browser) => ({ ...browser, key: `${KEY_PREFIX}${browser.key}`, shownOn: os.hostname(), via: destination }));
    return { status: 0, stdout: JSON.stringify({ browsers: shown }), stderr: "" };
  }
  if (command === "new-tab") {
    const url = rest[0];
    if (url !== undefined && !WEB_ADDRESS.test(url)) {
      return { status: 1, stdout: "", stderr: `not a web address: ${url}\n` };
    }
    return runSelf(self, ["new-tab", "--browser", key, ...(url ? [url] : [])]);
  }
  if (command === "action") {
    const split = rest.indexOf("--");
    const own = split === -1 ? rest : rest.slice(0, split);
    const passthrough = split === -1 ? [] : rest.slice(split + 1);
    const kept: string[] = [];
    for (let i = 0; i < own.length; i++) {
      if (own[i] === "--tab" || own[i] === "--target") kept.push(own[i], own[++i] ?? "");
      else if (own[i] === "--follow" || own[i] === "done") kept.push(own[i]);
      else return { status: 1, stdout: "", stderr: `not available from the remote side: ${own[i]}\n` };
    }
    if (passthrough.length > 0) {
      const why = refusal(passthrough);
      if (why) return { status: 1, stdout: "", stderr: `${why}\n` };
    }
    return runSelf(self, ["action", "--browser", key, ...kept, ...(passthrough.length > 0 ? ["--", ...passthrough] : [])]);
  }
  return { status: 1, stdout: "", stderr: `not available from the remote side: ${command}\n` };
}

// Lets programs on the ssh target (coding agents there) list, open tabs in and drive this browser:
// a private socket on the target, carried by the ssh connection this browser already uses.
export function serveRemote(tunnel: Tunnel, tty: string | null, self: string[]): void {
  const local = `${tunnel.controlPath}.agents`;
  fs.rmSync(local, { force: true });
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      let argv: string[];
      try {
        argv = (JSON.parse(line) as { argv: string[] }).argv.map(String);
      } catch {
        connection.end(`${JSON.stringify({ status: 1, stdout: "", stderr: "bad request\n" })}\n`);
        return;
      }
      answer(argv, tty, self, tunnel.destination)
        .catch((error) => ({ status: 1, stdout: "", stderr: `${String(error)}\n` }))
        .then((reply) => connection.end(`${JSON.stringify(reply)}\n`));
    });
  });
  server.on("error", () => {});
  server.listen(local, () => {
    fs.chmodSync(local, 0o600);
    let remote: string;
    try {
      const dir = execFileSync("ssh", ["-S", tunnel.controlPath, tunnel.destination, REMOTE_DIR_SCRIPT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      });
      remote = `${dir}/${os.hostname().replace(/[^A-Za-z0-9.-]/g, "-")}-${process.pid}.sock`;
      execFileSync("ssh", ["-S", tunnel.controlPath, "-O", "forward", "-R", `${remote}:${local}`, tunnel.destination], {
        stdio: "ignore",
        timeout: 15_000,
      });
    } catch {
      server.close();
      return;
    }
    process.on("exit", () => {
      try {
        execFileSync("ssh", ["-S", tunnel.controlPath, tunnel.destination, `rm -f '${remote}'`], {
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {}
      fs.rmSync(local, { force: true });
    });
  });
  server.unref();
}

function ask(socket: string, argv: string[]): Promise<RemoteReply | null> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    let buffer = "";
    const done = (reply: RemoteReply | null) => {
      connection.destroy();
      resolve(reply);
    };
    connection.setEncoding("utf8");
    connection.setTimeout(ASK_TIMEOUT_MS, () => done(null));
    connection.once("error", () => done(null));
    connection.once("connect", () => connection.write(`${JSON.stringify({ argv })}\n`));
    connection.on("data", (chunk: string) => {
      buffer += chunk;
    });
    connection.once("end", () => {
      try {
        done(JSON.parse(buffer) as RemoteReply);
      } catch {
        done(null);
      }
    });
  });
}

export interface RemoteSide {
  socket: string;
  browsers: RemoteBrowser[];
}

// Browsers shown on another computer that is connected here over ssh (terminal-browser open --ssh).
export async function remoteSides(): Promise<RemoteSide[]> {
  let names: string[];
  try {
    names = fs.readdirSync(REMOTE_DIR).filter((name) => name.endsWith(".sock"));
  } catch {
    return [];
  }
  const sides = await Promise.all(
    names.map(async (name) => {
      const socket = path.join(REMOTE_DIR, name);
      const reply = await ask(socket, ["ls"]);
      if (!reply) {
        fs.rmSync(socket, { force: true });
        return null;
      }
      if (reply.status !== 0) return null;
      try {
        return { socket, browsers: (JSON.parse(reply.stdout) as { browsers: RemoteBrowser[] }).browsers };
      } catch {
        return null;
      }
    }),
  );
  return sides.filter((side): side is RemoteSide => side !== null && side.browsers.length > 0);
}

export function isRemoteKey(key: string | undefined): boolean {
  return key !== undefined && key.startsWith(KEY_PREFIX);
}

export function isWebAddress(url: string): boolean {
  return WEB_ADDRESS.test(url) && !fs.existsSync(url);
}

// The side a command should go to: the one holding that browser, or the only one when none is named.
export function pickSide(sides: RemoteSide[], key: string | undefined): RemoteSide | null {
  if (key === undefined) return sides[0] ?? null;
  return sides.find((side) => side.browsers.some((browser) => browser.key === key)) ?? null;
}

export async function forward(side: RemoteSide, argv: string[]): Promise<number> {
  const reply = await ask(side.socket, argv);
  if (!reply) {
    process.stderr.write("the computer showing this browser did not answer\n");
    return 1;
  }
  process.stdout.write(reply.stdout);
  process.stderr.write(reply.stderr);
  return reply.status;
}
