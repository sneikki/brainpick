/** The query log (spec/70): every brain_search call, raw, one JSON line per call, one file
 * per session — so a month later the question "do agents search with sentences or with
 * keyword lists?" is answered from the record, not from memory. Nothing is aggregated here.
 *
 * Location: $BRAINPICK_QUERY_LOG_DIR, else $XDG_STATE_HOME/brainpick/queries (default
 * ~/.local/state/brainpick/queries), file <session_id>.jsonl. BRAINPICK_QUERY_LOG=0 disables.
 * The session id is the MCP server process's (one per agent session under stdio) or the one
 * a CLI caller passes with --session, so a harness hook can log under its own session.
 * Mirrors brainpick/querylog.py. */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // YYYYMMDDTHHMMSS
  return `${stamp}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

export function logDir(): string | null {
  if (["0", "false", "off", ""].includes(process.env["BRAINPICK_QUERY_LOG"] ?? "1")) return null;
  const override = process.env["BRAINPICK_QUERY_LOG_DIR"];
  if (override) return override;
  const state = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(state, "brainpick", "queries");
}

/** Append one line; never throws (a log must not break a search). */
export function logQuery(
  sessionId: string,
  brain: string,
  request: Record<string, unknown>,
  result: Record<string, unknown>,
): string | null {
  const directory = logDir();
  if (directory === null) return null;
  const hits = (result["hits"] as Array<Record<string, unknown>> | undefined) ?? [];
  const line = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    brain,
    ...request,
    used_modes: result["used_modes"] ?? null,
    degraded_from: result["degraded_from"] ?? null,
    hits: hits.map((h) => h["path"] ?? null),
  };
  try {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionId}.jsonl`);
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
    return path;
  } catch {
    return null;
  }
}
