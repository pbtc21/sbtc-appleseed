import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export type EndpointStatus =
  | "discovered"
  | "contacted"
  | "evaluating"
  | "pr_opened"
  | "awaiting_verification"
  | "verified"
  | "monitoring"
  | "broken";

export interface Endpoint {
  id: number;
  url: string;
  repo_url: string | null;
  issue_url: string | null;
  pr_url: string | null;
  status: EndpointStatus;
  token_type: string;
  last_check: string | null;
  last_result: string | null;
  total_spent: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

let _db: Database | null = null;

export function getDb(dbPath: string): Database {
  if (_db) return _db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.run("PRAGMA journal_mode = WAL");
  _db.run(`
    CREATE TABLE IF NOT EXISTS endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      repo_url TEXT,
      issue_url TEXT,
      pr_url TEXT,
      status TEXT NOT NULL DEFAULT 'discovered',
      token_type TEXT NOT NULL DEFAULT 'STX',
      last_check TEXT,
      last_result TEXT,
      total_spent INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return _db;
}

export function addEndpoint(
  dbPath: string,
  url: string,
  opts?: { repo_url?: string; token_type?: string; status?: EndpointStatus }
): Endpoint {
  const db = getDb(dbPath);
  const stmt = db.prepare(`
    INSERT INTO endpoints (url, repo_url, token_type, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET updated_at = datetime('now')
    RETURNING *
  `);
  return stmt.get(
    url,
    opts?.repo_url || null,
    opts?.token_type || "STX",
    opts?.status || "discovered"
  ) as Endpoint;
}

export function getEndpoint(dbPath: string, urlOrId: string | number): Endpoint | null {
  const db = getDb(dbPath);
  if (typeof urlOrId === "number") {
    return db.prepare("SELECT * FROM endpoints WHERE id = ?").get(urlOrId) as Endpoint | null;
  }
  return db.prepare("SELECT * FROM endpoints WHERE url = ?").get(urlOrId) as Endpoint | null;
}

export function listEndpoints(dbPath: string, status?: EndpointStatus): Endpoint[] {
  const db = getDb(dbPath);
  if (status) {
    return db.prepare("SELECT * FROM endpoints WHERE status = ? ORDER BY updated_at DESC").all(status) as Endpoint[];
  }
  return db.prepare("SELECT * FROM endpoints ORDER BY updated_at DESC").all() as Endpoint[];
}

export function updateEndpoint(
  dbPath: string,
  urlOrId: string | number,
  updates: Partial<Omit<Endpoint, "id" | "created_at">>
): void {
  const db = getDb(dbPath);
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");

  const where = typeof urlOrId === "number" ? "id = ?" : "url = ?";
  values.push(urlOrId);

  db.prepare(`UPDATE endpoints SET ${fields.join(", ")} WHERE ${where}`).run(...values);
}

export function getEndpointsDue(
  dbPath: string,
  healthyIntervalHours: number,
  brokenIntervalHours: number
): Endpoint[] {
  const db = getDb(dbPath);
  return db
    .prepare(
      `SELECT * FROM endpoints
       WHERE (status IN ('verified', 'monitoring')
              AND (last_check IS NULL OR last_check < datetime('now', ?)))
          OR (status = 'broken'
              AND (last_check IS NULL OR last_check < datetime('now', ?)))
       ORDER BY last_check ASC`
    )
    .all(`-${healthyIntervalHours} hours`, `-${brokenIntervalHours} hours`) as Endpoint[];
}
