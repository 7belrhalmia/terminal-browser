import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "shared";

export interface Page {
  url: string;
  title: string;
}

export interface SavedWindow {
  id: string;
  tabs: Page[];
  active: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_KEEP_MS = 180 * DAY_MS;
const HISTORY_KEEP_ROWS = 20_000;
const WINDOW_KEEP_MS = 30 * DAY_MS;
const WINDOW_KEEP_ROWS = 20;
// An open window saves itself every minute, so one that hasn't for this long is gone even if its process ID was reused.
const WINDOW_ALIVE_MS = 3 * 60 * 1000;
const MATCH_SCAN_ROWS = 300;

export function isWebPage(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= 4096;
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, "").toLowerCase();
}

function score(page: Page & { visits: number }, terms: string[]): number {
  const address = withoutScheme(page.url);
  const title = page.title.toLowerCase();
  let points = Math.log2(1 + page.visits);
  for (const term of terms) {
    if (address.startsWith(term)) points += 8;
    else if (address.includes(`.${term}`) || address.includes(`/${term}`)) points += 3;
    if (title.startsWith(term) || title.includes(` ${term}`)) points += 2;
  }
  return points;
}

export class Browsing {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS history (
      profile TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      visits INTEGER NOT NULL,
      last_visit INTEGER NOT NULL,
      PRIMARY KEY (profile, url)
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS history_recent ON history (profile, last_visit)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS windows (
      id TEXT PRIMARY KEY,
      profile TEXT NOT NULL,
      place TEXT,
      tabs TEXT NOT NULL,
      active INTEGER NOT NULL,
      owner TEXT,
      saved_at INTEGER NOT NULL
    )`);
    this.prune();
  }

  visit(profile: string, page: Page, newVisit: boolean, now = Date.now()) {
    if (!isWebPage(page.url)) return;
    this.db
      .prepare(
        `INSERT INTO history (profile, url, title, visits, last_visit) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (profile, url) DO UPDATE SET
           title = CASE WHEN excluded.title = '' THEN history.title ELSE excluded.title END,
           visits = history.visits + ?,
           last_visit = CASE WHEN ? THEN excluded.last_visit ELSE history.last_visit END`,
      )
      .run(profile, page.url, page.title, now, newVisit ? 1 : 0, newVisit ? 1 : 0);
  }

  search(profile: string, query: string, limit: number): Page[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      const recent = this.db
        .prepare("SELECT url, title FROM history WHERE profile = ? ORDER BY last_visit DESC LIMIT ?")
        .all(profile, limit) as unknown as Page[];
      return recent.map((row) => ({ url: row.url, title: row.title }));
    }
    const conditions = terms.map(() => "(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')").join(" AND ");
    const rows = this.db
      .prepare(
        `SELECT url, title, visits FROM history WHERE profile = ? AND ${conditions}
         ORDER BY last_visit DESC LIMIT ${MATCH_SCAN_ROWS}`,
      )
      .all(profile, ...terms.flatMap((term) => [likePattern(term), likePattern(term)])) as unknown as Array<
      Page & { visits: number }
    >;
    return rows
      .map((row, recency) => ({ row, points: score(row, terms) - recency / MATCH_SCAN_ROWS }))
      .sort((a, b) => b.points - a.points)
      .slice(0, limit)
      .map(({ row }) => ({ url: row.url, title: row.title }));
  }

  clearHistory(profile: string) {
    this.db.prepare("DELETE FROM history WHERE profile = ?").run(profile);
  }

  claimWindow(
    profile: string,
    place: string | null,
    owner: string,
    isOpen: (owner: string) => boolean = windowOwnerOpen,
    now = Date.now(),
  ): SavedWindow | null {
    const saved = this.db
      .prepare("SELECT id, place, tabs, active, owner, saved_at FROM windows WHERE profile = ? AND saved_at > ? ORDER BY saved_at DESC")
      .all(profile, now - WINDOW_KEEP_MS) as Array<{
      id: string;
      place: string | null;
      tabs: string;
      active: number;
      owner: string | null;
      saved_at: number;
    }>;
    const free = saved.filter(
      (entry) => entry.owner === null || entry.saved_at < now - WINDOW_ALIVE_MS || !isOpen(entry.owner),
    );
    const row = free.find((entry) => place !== null && entry.place === place) ?? free[0];
    if (!row) return null;
    const tabs = (JSON.parse(row.tabs) as Page[]).filter((tab) => typeof tab.url === "string" && tab.url);
    if (tabs.length === 0) {
      this.db.prepare("DELETE FROM windows WHERE id = ?").run(row.id);
      return this.claimWindow(profile, place, owner, isOpen, now);
    }
    this.db.prepare("UPDATE windows SET owner = ?, place = ?, saved_at = ? WHERE id = ?").run(owner, place, now, row.id);
    return { id: row.id, tabs, active: Math.min(Math.max(row.active, 0), tabs.length - 1) };
  }

  saveWindow(
    window: { id: string; profile: string; place: string | null; owner: string | null },
    tabs: Page[],
    active: number,
    now = Date.now(),
  ) {
    this.db
      .prepare(
        `INSERT INTO windows (id, profile, place, tabs, active, owner, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET place = excluded.place, tabs = excluded.tabs, active = excluded.active,
           owner = excluded.owner, saved_at = excluded.saved_at`,
      )
      .run(window.id, window.profile, window.place, JSON.stringify(tabs), active, window.owner, now);
  }

  private prune(now = Date.now()) {
    this.db.prepare("DELETE FROM history WHERE last_visit < ?").run(now - HISTORY_KEEP_MS);
    this.db
      .prepare(
        `DELETE FROM history WHERE rowid IN (
           SELECT rowid FROM history ORDER BY last_visit DESC LIMIT -1 OFFSET ${HISTORY_KEEP_ROWS})`,
      )
      .run();
    this.db.prepare("DELETE FROM windows WHERE saved_at < ?").run(now - WINDOW_KEEP_MS);
    this.db
      .prepare(
        `DELETE FROM windows WHERE id IN (
           SELECT id FROM windows ORDER BY saved_at DESC LIMIT -1 OFFSET ${WINDOW_KEEP_ROWS})`,
      )
      .run();
  }
}

const openWindowOwners = new Set<string>();

export function windowOpened(owner: string) {
  openWindowOwners.add(owner);
}

export function windowClosed(owner: string) {
  openWindowOwners.delete(owner);
}

// Owners are session keys, which start with the process ID of the browser that runs the window.
function windowOwnerOpen(owner: string): boolean {
  const pid = Number.parseInt(owner, 10);
  if (pid === process.pid) return openWindowOwners.has(owner);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let opened: Browsing | null = null;

export function browsing(): Browsing {
  opened ??= new Browsing(path.join(DATA_DIR, "browsing.db"));
  return opened;
}
