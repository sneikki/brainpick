/** `brainpick recall` (spec/72): prompt-time memory for harness hooks.
 *
 * A harness pipes its prompt-hook payload in; recall searches the brain with the prompt
 * as the situation and the prompt's identifiers as terms, and prints the matching
 * memories as hook context — each one once per session. MCP makes the brain available;
 * this makes it consulted without the agent deciding to search. Twin of recall.py.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { checkFresh } from "./compile/pipeline";
import { loadConfig } from "./config";
import { cmpStr } from "./core/canonical";
import { pyRstrip, pySplitWhitespace } from "./core/pyfmt";
import { brainName, extractSections, loadDoc, searchPayload } from "./mcp";
import { logQuery } from "./querylog";
import { ServeState } from "./serve/state";

export const MIN_WORDS = 6;
export const QUOTED_MAX = 5;
export const ENTRY_CHARS = 1500;
export const MAX_TERMS = 8;
const DEFAULT_EVENT = "UserPromptSubmit";
const HERMES_EVENT = "pre_llm_call"; // Hermes' shell hook: the prompt is extra.user_message

// JS classes and \b are ASCII — the Python twin compiles the same patterns with re.ASCII.
const TERM_PATTERNS = [
  /`[^`]+`/g,
  /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g,
  /[A-Za-z]+_[A-Za-z0-9_]+/g,
  /[a-z]+[A-Z][A-Za-z0-9]+/g,
  /\b[A-Z]{3,}[0-9]*\b/g,
  /[A-Za-z0-9_-]+\.(?:md|py|ts|js|go|sh|json|toml|yaml|yml)\b/g,
];
const ENTRY_HEAD = /^\* \*\*(\d{2}:\d{2})\*\*/;
const UNSAFE_SESSION = /[^A-Za-z0-9_-]/g;

interface Hit {
  path: string;
  title?: string | null;
  description?: string | null;
  snippet?: string | null;
}

/** [prompt, session_id or null, hook event] — null when there is no string prompt. Two dialects
 * (spec/72): the Claude Code protocol's `prompt`, and Hermes' `extra.user_message` when the
 * event is `pre_llm_call`. */
export function parsePayload(payload: unknown): [string, string | null, string] | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const fields = payload as Record<string, unknown>;
  const event = typeof fields["hook_event_name"] === "string" ? fields["hook_event_name"] : DEFAULT_EVENT;
  let prompt: unknown;
  if (event === HERMES_EVENT) {
    const extra = fields["extra"];
    prompt = typeof extra === "object" && extra !== null && !Array.isArray(extra)
      ? (extra as Record<string, unknown>)["user_message"]
      : undefined;
  } else {
    prompt = fields["prompt"];
  }
  if (typeof prompt !== "string") return null;
  const session = fields["session_id"];
  return [prompt, typeof session === "string" && session !== "" ? session : null, event];
}

/** A slash command or an acknowledgement carries no situation to recall for. */
export function gated(prompt: string): boolean {
  return prompt.startsWith("/") || pySplitWhitespace(prompt).length < MIN_WORDS;
}

export function extractTerms(prompt: string): string[] {
  const found = new Set<string>();
  for (const pattern of TERM_PATTERNS) {
    for (const match of prompt.matchAll(pattern)) found.add(match[0].replaceAll("`", ""));
  }
  return [...found].filter((term) => [...term].length > 2).sort(cmpStr).slice(0, MAX_TERMS);
}

export function sessionFile(session: string | null, env: Record<string, string | undefined>): string | null {
  if (!session) return null;
  let base: string;
  if (env["BRAINPICK_RECALL_STATE_DIR"]) base = env["BRAINPICK_RECALL_STATE_DIR"];
  else if (env["XDG_RUNTIME_DIR"]) base = join(env["XDG_RUNTIME_DIR"], "brainpick", "recall");
  else base = join(tmpdir(), "brainpick-recall");
  return join(base, session.replace(UNSAFE_SESSION, "_"));
}

function flat(text: string | null | undefined): string {
  return (text ?? "").replaceAll("\n", " ").replaceAll("\x1f", " ");
}

/** [context or null, the keys rendered] — hits in rank order, 5 quoted, the rest pointers. */
export function render(
  name: string,
  hits: readonly Hit[],
  entryOf: (path: string, hhmm: string) => string,
  seen: ReadonlySet<string>,
): [string | null, string[]] {
  const quoted: string[] = [];
  const pointers: string[] = [];
  const keys: string[] = [];
  for (const hit of hits) {
    const path = hit.path;
    const title = flat(hit.title);
    const description = flat(hit.description);
    const snippet = flat(hit.snippet);
    const head = ENTRY_HEAD.exec(snippet);
    const key = head ? `${path}#${head[1]}` : path;
    if (seen.has(key) || keys.includes(key)) continue;
    keys.push(key);
    if (quoted.length < QUOTED_MAX) {
      if (head) {
        const entry = entryOf(path, head[1]!);
        if (entry) {
          quoted.push(`### ${path} (${head[1]})\n${entry}`);
          continue;
        }
      } else if (description) {
        quoted.push(`### ${path} — ${title}\n${description}` + (snippet ? `\n↳ ${snippet}` : ""));
        continue;
      }
    }
    pointers.push(`- ${path} — ${title}` + (snippet ? `: ${snippet}` : ""));
  }
  if (quoted.length === 0 && pointers.length === 0) return [null, keys];
  let context =
    `${name} memories matching this prompt (each shown once per session; brain_read(path) opens the whole doc):` +
    "\n\n" +
    quoted.map((block) => block + "\n\n").join("");
  if (pointers.length > 0) context += "Further hits (pointers only):\n" + pointers.map((line) => line + "\n").join("");
  return [context, keys];
}

function entryText(state: ServeState, path: string, hhmm: string): string {
  const record = state.records.find((r) => r.path === path);
  if (record === undefined) return "";
  const [, body] = loadDoc(state, record);
  return [...pyRstrip(extractSections(body, [hhmm]))].slice(0, ENTRY_CHARS).join("");
}

/** Everything past the gate and the loaded brain: the line to print, or null. */
export async function recallLine(
  state: ServeState,
  name: string,
  prompt: string,
  session: string | null,
  event: string,
  limit = 10,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const terms = extractTerms(prompt);
  const result = (await searchPayload(state, null, "auto", limit, Number.MAX_SAFE_INTEGER, null, terms, prompt)) as {
    hits: Hit[];
  };
  logQuery(
    `recall-${session ?? "nosession"}`,
    brainName(state),
    { situation: prompt, terms, mode: "auto", limit, scope: null },
    result as unknown as Record<string, unknown>,
  );
  const store = sessionFile(session, env);
  const seen = new Set(store !== null && existsSync(store) ? readFileSync(store, "utf8").split("\n") : []);
  const [context, keys] = render(name, result.hits, (path, hhmm) => entryText(state, path, hhmm), seen);
  if (store !== null && keys.length > 0) {
    mkdirSync(dirname(store), { recursive: true });
    appendFileSync(store, keys.map((key) => key + "\n").join(""), "utf8");
  }
  if (context === null) return null;
  if (event === HERMES_EVENT) return JSON.stringify({ context });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

/** The command (spec/72): stdout (`out`) carries the context or nothing, the reason for
 * nothing goes to stderr (`err`) — never a throw, so the hook never breaks a prompt. */
export async function recallMirror(
  root: string,
  stdin: string,
  limit = 10,
  env: Record<string, string | undefined> = process.env,
): Promise<{ out?: string; err?: string }> {
  try {
    const parsed = parsePayload(JSON.parse(stdin));
    if (parsed === null || gated(parsed[0])) return {};
    const configRoot = resolve(root);
    const config = loadConfig(configRoot);
    const bundle = resolve(configRoot, config.bundle.root);
    const bp = join(bundle, ".brainpick");
    const needed = [join(bp, "manifest.json"), join(bp, "t1", "graph.json"), join(bp, "t1", "docs.jsonl")];
    if (!needed.every((path) => existsSync(path))) {
      return { err: `no compiled brain at ${bundle} — run: brainpick compile --root ${bundle}` };
    }
    const state = new ServeState(bundle, config);
    state.reloadArtifacts();
    const err = checkFresh(bundle).fresh ? undefined : `note: the brain is stale — run: brainpick compile --root ${bundle}`;
    const line = await recallLine(state, basename(configRoot), ...parsed, limit, env);
    return line === null ? { err } : { out: line, err };
  } catch (error) {
    return { err: `brainpick recall: ${error instanceof Error ? error.message : String(error)}` };
  }
}
