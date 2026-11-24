import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const NOTE_TYPES = ["trap", "pattern", "runbook", "log"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const NOTE_REPOS = ["app", "web", "kb"] as const;

export type FrontmatterValue = string | readonly string[];
export interface Frontmatter {
  readonly [key: string]: FrontmatterValue;
}

export interface Finding {
  readonly path: string; // repo-relative, forward slashes
  readonly line: number; // 1-based; 0 = whole file
  readonly rule: string; // e.g. "secret:github-token", "note:missing-key:summary"
  readonly message: string; // never contains the matched secret
}

export interface NewNoteInput {
  readonly type: NoteType;
  readonly slug: string;
  readonly summary: string;
  readonly author: string;
  readonly created: string; // YYYY-MM-DD
  readonly repos: readonly string[];
  readonly tickets: readonly number[];
}

const MAX_BYTES = 1024 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TICKET = /^[1-9][0-9]*$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NOTE_PATH = new RegExp(`^notes/(${NOTE_TYPES.join("|")})/(\\d{4}-\\d{2}-\\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\\.md$`);
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const REQUIRED_KEYS = ["type", "title", "summary", "author", "created", "status"] as const;

const SECTIONS = {
  trap: ["Symptom", "Cause", "Fix", "How to check"],
  pattern: ["When to use", "How", "Example"],
  runbook: ["When", "Steps", "Verify"],
  log: ["What happened", "Next"],
} as const satisfies Record<NoteType, readonly string[]>;

// ---------- frontmatter ----------

interface ParseIssue {
  readonly line: number;
  readonly message: string;
}

interface Parsed {
  readonly data: Frontmatter;
  readonly lines: Readonly<Record<string, number>>;
  readonly issues: readonly ParseIssue[];
}

type ValueResult =
  | { readonly ok: true; readonly value: FrontmatterValue }
  | { readonly ok: false; readonly message: string };

function jsonString(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function parseValue(raw: string): ValueResult {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const s = jsonString(v);
    return s === null ? { ok: false, message: "value is not a valid double-quoted string" } : { ok: true, value: s };
  }
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) return { ok: false, message: "unterminated inline list" };
    const inner = v.slice(1, -1).trim();
    return { ok: true, value: inner === "" ? [] : inner.split(",").map((item) => item.trim()) };
  }
  return { ok: true, value: v };
}

function parseDocument(content: string): Parsed | null {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows = text.split(/\r?\n/);
  if (rows[0]?.trimEnd() !== "---") return null;
  const end = rows.findIndex((row, i) => i > 0 && row.trimEnd() === "---");
  if (end < 0) return null;
  const values = new Map<string, FrontmatterValue>();
  const lines = new Map<string, number>();
  const issues: ParseIssue[] = [];
  for (const [i, row] of rows.slice(1, end).entries()) {
    if (row.trim() === "") continue;
    const line = i + 2;
    const m = KEY_LINE.exec(row);
    if (m === null) {
      issues.push({ line, message: "line is not `key: value`" });
      continue;
    }
    const [, key = "", raw = ""] = m;
    const result = parseValue(raw);
    if (!result.ok) {
      issues.push({ line, message: `${key}: ${result.message}` });
      continue;
    }
    values.set(key, result.value);
    lines.set(key, line);
  }
  // fromEntries defines own properties, so a `__proto__` key stays plain data
  return { data: Object.fromEntries(values), lines: Object.fromEntries(lines), issues };
}

export function parseFrontmatter(
  content: string,
): { readonly data: Frontmatter; readonly lines: Readonly<Record<string, number>> } | null {
  const parsed = parseDocument(content);
  return parsed === null ? null : { data: parsed.data, lines: parsed.lines };
}

// ---------- validation ----------

function isNoteType(s: string): s is NoteType {
  return (NOTE_TYPES as readonly string[]).includes(s);
}

function isRealDate(s: string): boolean {
  const m = DATE.exec(s);
  if (m === null) return false;
  const [y = 0, mo = 0, d = 0] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function validateNote(path: string, content: string): Finding[] {
  const out: Finding[] = [];
  const add = (line: number, rule: string, message: string): void => {
    out.push({ path, line, rule, message });
  };
  const pathMatch = NOTE_PATH.exec(path);
  if (pathMatch === null || (pathMatch[3] ?? "").length > 60) {
    add(0, "note:path", "path must be notes/<type>/<YYYY-MM-DD>-<slug>.md (type: trap|pattern|runbook|log; slug: a-z0-9-, max 60)");
  }
  const parsed = parseDocument(content);
  if (parsed === null) {
    add(0, "note:no-frontmatter", "file must start with a `---` frontmatter block closed by `---`");
    return out;
  }
  for (const issue of parsed.issues) add(issue.line, "note:frontmatter", issue.message);

  const { data, lines } = parsed;
  const lineOf = (key: string): number => lines[key] ?? 0;
  const str = (key: string): string | undefined => {
    const v = data[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  for (const key of REQUIRED_KEYS) {
    if (str(key) === undefined) add(lineOf(key), `note:missing-key:${key}`, `required key \`${key}\` is missing or empty`);
  }

  const folder = /^notes\/([^/]+)\//.exec(path)?.[1];
  const type = str("type");
  if (type !== undefined && (!isNoteType(type) || (folder !== undefined && type !== folder))) {
    add(lineOf("type"), "note:type-mismatch", `type \`${type}\` is not a note type or does not match the folder`);
  }

  const created = str("created");
  if (created !== undefined) {
    const fileDate = /^(\d{4}-\d{2}-\d{2})-/.exec(path.slice(path.lastIndexOf("/") + 1))?.[1];
    if (!isRealDate(created) || (fileDate !== undefined && created !== fileDate)) {
      add(lineOf("created"), "note:created", "created must be a real YYYY-MM-DD date equal to the filename date");
    }
  }

  const summary = data.summary;
  if (typeof summary === "string" && (summary.trim() === "" || /[\r\n]/.test(summary) || summary.length > 200)) {
    add(lineOf("summary"), "note:summary", "summary must be one non-empty line of at most 200 characters");
  }

  const status = str("status");
  if (status !== undefined && status !== "active" && status !== "superseded") {
    add(lineOf("status"), "note:status", "status must be active or superseded");
  }

  const repos = data.repos;
  if (repos !== undefined && (typeof repos === "string" || repos.some((r) => !(NOTE_REPOS as readonly string[]).includes(r)))) {
    add(lineOf("repos"), "note:repos", `repos must be a list of ${NOTE_REPOS.join(", ")}`);
  }

  const tickets = data.tickets;
  if (tickets !== undefined && (typeof tickets === "string" || tickets.some((t) => !TICKET.test(t)))) {
    add(lineOf("tickets"), "note:tickets", "tickets must be a list of positive integers");
  }
  return out;
}

// ---------- secrets ----------

interface SecretRule {
  readonly rule: string;
  readonly patterns: readonly RegExp[];
  readonly notesOnly?: true;
}

const SECRET_RULES = [
  { rule: "secret:github-token", patterns: [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/] },
  { rule: "secret:atlassian-token", patterns: [/\bATATT3[A-Za-z0-9_\-=]{30,}/] },
  { rule: "secret:aws-key-id", patterns: [/\bAKIA[0-9A-Z]{16}\b/] },
  { rule: "secret:slack-token", patterns: [/\bxox[abprs]-[A-Za-z0-9-]{10,}/] },
  { rule: "secret:openai-style-key", patterns: [/\bsk-[A-Za-z0-9_-]{20,}/] },
  { rule: "secret:jwt", patterns: [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/] },
  { rule: "secret:private-key", patterns: [/-----BEGIN [A-Z ]*PRIVATE KEY-----/] },
  {
    rule: "secret:credential-assignment",
    patterns: [/(password|passwd|secret|api[_-]?key|token)["']?\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}/i],
    notesOnly: true,
  },
] as const satisfies readonly SecretRule[];

export function scanSecrets(path: string, content: string): Finding[] {
  if (content.includes("\0") || Buffer.byteLength(content) > MAX_BYTES) return [];
  const inNotes = path.startsWith("notes/");
  const out: Finding[] = [];
  for (const [i, text] of content.split(/\r?\n/).entries()) {
    if (text.includes("notes-check: allow")) continue;
    for (const { rule, patterns, ...rest } of SECRET_RULES) {
      if ("notesOnly" in rest && !inNotes) continue;
      if (patterns.some((p) => p.test(text))) {
        out.push({ path, line: i + 1, rule, message: `${rule} pattern matched; value redacted` });
      }
    }
  }
  return out;
}

// ---------- helpers ----------

export function slugToTitle(slug: string): string {
  const s = slug.replaceAll("-", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function notePath(type: NoteType, created: string, slug: string): string {
  return `notes/${type}/${created}-${slug}.md`;
}

export function renderNote(input: NewNoteInput): string {
  const title = slugToTitle(input.slug);
  const body = SECTIONS[input.type].flatMap((heading) => [`## ${heading}`, "", ""]);
  return (
    [
      "---",
      `type: ${input.type}`,
      `title: ${JSON.stringify(title)}`,
      `summary: ${JSON.stringify(input.summary)}`,
      `author: ${JSON.stringify(input.author)}`,
      `created: ${input.created}`,
      `repos: [${input.repos.join(", ")}]`,
      `tickets: [${input.tickets.join(", ")}]`,
      "status: active",
      "---",
      "",
      `# ${title}`,
      "",
      ...body,
    ].join("\n") + "\n"
  );
}

function asText(v: FrontmatterValue | undefined): string {
  return v === undefined ? "" : typeof v === "string" ? v : v.join(" ");
}

export function matchesQuery(data: Frontmatter, words: readonly string[]): boolean {
  const text = [asText(data.title), asText(data.summary), asText(data.tickets)].join(" ").toLowerCase();
  return words.every((w) => text.includes(w.toLowerCase()));
}

// ---------- CLI ----------

const USAGE = [
  "usage:",
  '  node tools/notes/notes.ts new <trap|pattern|runbook|log> <slug> "<summary>" [--repos app,web,kb] [--ticket <n>]...',
  "  node tools/notes/notes.ts check --staged | --all",
  "  node tools/notes/notes.ts find <word>...",
].join("\n");

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function git(root: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

function nulList(buf: Buffer): string[] {
  return buf.toString("utf8").split("\0").filter((p) => p !== "");
}

// UTF-16 files show NULs between ASCII when read as utf8, so decode by BOM first
function decode(buf: Buffer): string {
  const [a, b] = buf;
  if (a === 0xff && b === 0xfe) return buf.toString("utf16le");
  if (a === 0xfe && b === 0xff) return Buffer.from(buf.subarray(0, buf.length - (buf.length % 2))).swap16().toString("utf16le");
  return buf.toString("utf8");
}

function readStaged(root: string, path: string): string | null {
  try {
    const size = Number(git(root, ["cat-file", "-s", `:0:${path}`]).toString("utf8").trim());
    return size > MAX_BYTES ? null : decode(git(root, ["show", `:0:${path}`]));
  } catch {
    return null; // gitlinks and other non-blobs
  }
}

function readDisk(root: string, path: string): string | null {
  try {
    const abs = join(root, ...path.split("/"));
    const st = statSync(abs);
    return st.isFile() && st.size <= MAX_BYTES ? decode(readFileSync(abs)) : null;
  } catch {
    return null; // missing (deleted but still tracked) or unreadable
  }
}

function isNotePath(path: string): boolean {
  return path.startsWith("notes/") && path.endsWith(".md") && path !== "notes/README.md";
}

function runCheck(mode: "staged" | "all", root: string): number {
  const paths =
    mode === "staged"
      ? nulList(git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]))
      : nulList(git(root, ["ls-files", "-z"]));
  const scanned: string[] = [];
  const findings: Finding[] = [];
  for (const path of paths) {
    const content = mode === "staged" ? readStaged(root, path) : readDisk(root, path);
    if (content === null) continue;
    scanned.push(path);
    findings.push(...scanSecrets(path, content));
    if (isNotePath(path)) findings.push(...validateNote(path, content));
  }
  for (const f of findings) console.log(`${f.path}:${f.line}: ${f.rule}: ${f.message}`);
  console.log(`notes check: ${scanned.length} files, ${findings.length} findings`);
  return findings.length > 0 ? 1 : 0;
}

interface NewArgs {
  readonly positionals: readonly string[];
  readonly repos: readonly string[];
  readonly tickets: readonly string[];
}

function parseNewArgs(args: readonly string[]): NewArgs | null {
  const queue = [...args];
  const positionals: string[] = [];
  const repos: string[] = [];
  const tickets: string[] = [];
  while (queue.length > 0) {
    const a = queue.shift() ?? "";
    if (a === "--repos" || a === "--ticket") {
      const value = queue.shift();
      if (value === undefined) return null;
      if (a === "--ticket") tickets.push(value);
      else if (value !== "") repos.push(...value.split(",").map((r) => r.trim()));
    } else if (a.startsWith("--")) {
      return null;
    } else {
      positionals.push(a);
    }
  }
  return positionals.length === 3 ? { positionals, repos, tickets } : null;
}

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function gitUserName(root: string): string {
  try {
    return git(root, ["config", "user.name"]).toString("utf8").trim();
  } catch {
    return "";
  }
}

function fail(message: string): number {
  console.error(`notes: ${message}`);
  return 1;
}

function runNew(args: readonly string[], root: string): number {
  const parsed = parseNewArgs(args);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const [type = "", slug = "", rawSummary = ""] = parsed.positionals;
  if (!isNoteType(type)) return fail(`unknown type "${type}" (expected ${NOTE_TYPES.join(", ")})`);
  if (!SLUG.test(slug) || slug.length > 60) return fail(`bad slug "${slug}" (a-z, 0-9 and single dashes, max 60 chars)`);
  const summary = rawSummary.trim();
  if (summary === "" || /[\r\n]/.test(summary) || summary.length > 200) {
    return fail("summary must be one non-empty line of at most 200 characters");
  }
  const badRepo = parsed.repos.find((r) => !(NOTE_REPOS as readonly string[]).includes(r));
  if (badRepo !== undefined) return fail(`unknown repo "${badRepo}" (expected ${NOTE_REPOS.join(", ")})`);
  const badTicket = parsed.tickets.find((t) => !TICKET.test(t) || !Number.isSafeInteger(Number(t)));
  if (badTicket !== undefined) return fail(`ticket "${badTicket}" is not a positive integer`);
  const author = gitUserName(root);
  if (author === "") return fail("git config user.name is empty; set it first");

  const path = notePath(type, todayLocal(), slug);
  const abs = join(root, ...path.split("/"));
  const content = renderNote({ type, slug, summary, author, created: todayLocal(), repos: parsed.repos, tickets: parsed.tickets.map(Number) });
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, { flag: "wx" });
  } catch (e: unknown) {
    return fail(typeof e === "object" && e !== null && "code" in e && e.code === "EEXIST" ? `${path} already exists` : errMessage(e));
  }
  console.log(path);
  return 0;
}

function runFind(words: readonly string[], root: string): number {
  if (words.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const hits: { readonly path: string; readonly created: string; readonly line: string }[] = [];
  try {
    for (const dir of readdirSync(join(root, "notes"), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const file of readdirSync(join(root, "notes", dir.name)).filter((f) => f.endsWith(".md"))) {
        const path = `notes/${dir.name}/${file}`;
        const fm = parseFrontmatter(readFileSync(join(root, "notes", dir.name, file), "utf8"));
        if (fm === null || !matchesQuery(fm.data, words)) continue;
        const { data } = fm;
        hits.push({ path, created: asText(data.created), line: `${path}  [${asText(data.status)}]  ${asText(data.summary)}` });
      }
    }
  } catch {
    // no notes/ directory (or unreadable): treated as no matches
  }
  hits.sort((a, b) => (a.created === b.created ? (a.path < b.path ? -1 : 1) : a.created < b.created ? 1 : -1));
  if (hits.length === 0) console.log("no notes match");
  for (const h of hits) console.log(h.line);
  return 0;
}

export async function main(argv: readonly string[], root: string = resolve(import.meta.dirname, "../..")): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "new") return runNew(rest, root);
    if (command === "find") return runFind(rest, root);
    if (command === "check" && rest.length === 1 && (rest[0] === "--staged" || rest[0] === "--all")) {
      return runCheck(rest[0] === "--staged" ? "staged" : "all", root);
    }
  } catch (e: unknown) {
    return fail(errMessage(e));
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
