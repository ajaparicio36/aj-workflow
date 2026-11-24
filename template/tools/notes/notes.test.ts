import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import type { TestContext } from "node:test";
import { NOTE_TYPES, main, matchesQuery, notePath, parseFrontmatter, renderNote, scanSecrets, slugToTitle, validateNote } from "./notes.ts";
import type { Finding, Frontmatter, NewNoteInput, NoteType } from "./notes.ts";

// Fake secrets are built at runtime so this file never contains a token-shaped literal.
const GH = "gh" + "p_" + "a".repeat(36);
const GH_PAT = "github" + "_pat_" + "A".repeat(45);
const ATLASSIAN = "ATATT" + "3" + "x".repeat(40);
const AWS = "AKIA" + "A".repeat(16);
const SLACK = "xox" + "b-" + "1234567890" + "-abcdef";
const OPENAI = "sk" + "-" + "b".repeat(24);
const JWT = ["ey" + "J" + "a".repeat(12), "ey" + "J" + "b".repeat(12), "c".repeat(12)].join(".");
const PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE" + " KEY-----";

const rules = (fs: readonly Finding[]): string[] => fs.map((f) => f.rule);

// ---------- note builders ----------

const NOTE = "notes/trap/2026-11-16-cart-total.md";

function note(overrides: Readonly<Record<string, string | null>> = {}): string {
  const base: Record<string, string | null> = {
    type: "trap",
    title: '"Cart total"',
    summary: '"Voided line stays in the total"',
    author: '"AJ"',
    created: "2026-11-16",
    repos: "[web, app]",
    tickets: "[12]",
    status: "active",
  };
  const merged = { ...base, ...overrides };
  const rows = Object.entries(merged).flatMap(([k, v]) => (v === null ? [] : [`${k}: ${v}`]));
  return ["---", ...rows, "---", "", "# Cart total", ""].join("\n");
}

const input = (type: NoteType): NewNoteInput => ({
  type,
  slug: "cart-total",
  summary: "Voided line stays in the total",
  author: 'AJ "the dev" Aparicio',
  created: "2026-11-16",
  repos: ["web", "app"],
  tickets: [12, 7],
});

// ---------- temp git repos ----------

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo(userName: string | null = "Test Author"): string {
  const root = mkdtempSync(join(tmpdir(), "notes-test-"));
  dirs.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.test");
  git(root, "config", "user.name", userName ?? "");
  return root;
}

function put(root: string, path: string, content: string | Buffer, stage = true): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (stage) git(root, "add", "--", path);
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(t: TestContext, root: string, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]): void => void out.push(a.join(" ")));
  t.mock.method(console, "error", (...a: unknown[]): void => void err.push(a.join(" ")));
  const code = await main(argv, root);
  t.mock.restoreAll();
  return { code, out: out.join("\n"), err: err.join("\n") };
}

// ---------- parseFrontmatter ----------

describe("parseFrontmatter", () => {
  test("parses quoted, bare and list values with 1-based key lines", () => {
    const fm = parseFrontmatter(note({ summary: '"say \\"hi\\""', repos: "[]", tickets: "[1, 22]" }));
    assert.ok(fm);
    assert.equal(fm.data.type, "trap");
    assert.equal(fm.data.summary, 'say "hi"');
    assert.deepEqual(fm.data.repos, []);
    assert.deepEqual(fm.data.tickets, ["1", "22"]);
    assert.equal(fm.lines.type, 2);
    assert.equal(fm.lines.status, 9);
  });

  test("strips a BOM and handles CRLF", () => {
    const fm = parseFrontmatter("﻿" + note().replaceAll("\n", "\r\n"));
    assert.equal(fm?.data.title, "Cart total");
  });

  test("returns null without an opening or closing fence", () => {
    assert.equal(parseFrontmatter("# no frontmatter\n"), null);
    assert.equal(parseFrontmatter("\n---\ntype: trap\n---\n"), null);
    assert.equal(parseFrontmatter("---\ntype: trap\n"), null);
    assert.equal(parseFrontmatter(""), null);
  });

  test("keeps a __proto__ key as plain data and never throws on odd input", () => {
    const fm = parseFrontmatter("---\n__proto__: x\n---\n");
    assert.equal(Object.getPrototypeOf(fm?.data), Object.prototype);
    assert.equal(Object.hasOwn(fm?.data ?? {}, "__proto__"), true);
    for (const s of ["---\n---", "---\n\0\n---", "---\n[: ]\n---", '---\na: "\n---', "---\na: [\n---", "\r\n\r\n"]) {
      assert.doesNotThrow(() => parseFrontmatter(s));
      assert.doesNotThrow(() => validateNote(NOTE, s));
      assert.doesNotThrow(() => scanSecrets(NOTE, s));
    }
  });
});

// ---------- validateNote ----------

describe("validateNote", () => {
  test("a valid note returns no findings", () => {
    assert.deepEqual(validateNote(NOTE, note()), []);
    assert.deepEqual(validateNote(NOTE, note({ supersedes: '"notes/trap/x.md"', extra: "whatever", repos: null, tickets: null })), []);
  });

  test("note:path", () => {
    for (const p of [
      "notes/traps/2026-11-16-cart-total.md",
      "notes/x.md",
      "notes/trap/sub/2026-11-16-x.md",
      "notes/trap/2026-11-16-Cart.md",
      "notes/trap/2026-11-16-a--b.md",
      "notes/trap/2026-11-16-a.txt",
      "notes/trap/16-11-2026-a.md",
      `notes/trap/2026-11-16-${"a".repeat(61)}.md`,
    ]) {
      assert.ok(rules(validateNote(p, note())).includes("note:path"), p);
    }
    assert.ok(!rules(validateNote(`notes/trap/2026-11-16-${"a".repeat(60)}.md`, note())).includes("note:path"));
    assert.ok(!rules(validateNote("notes/log/2026-11-16-x.md", note({ type: "log" }))).includes("note:path"));
  });

  test("note:no-frontmatter", () => {
    assert.deepEqual(rules(validateNote(NOTE, "# just text\n")), ["note:no-frontmatter"]);
    assert.ok(!rules(validateNote(NOTE, note())).includes("note:no-frontmatter"));
  });

  test("note:frontmatter for bad lines, bad quoted values and block lists", () => {
    const bad = validateNote(NOTE, note({ summary: '"unterminated' }));
    assert.ok(rules(bad).includes("note:frontmatter"));
    assert.equal(bad.find((f) => f.rule === "note:frontmatter")?.line, 4);
    const junk = ["---", "type: trap", "not a pair", "---"].join("\n");
    assert.equal(validateNote(NOTE, junk).find((f) => f.rule === "note:frontmatter")?.line, 3);
    const block = note().replace("repos: [web, app]", "repos:\n  - web");
    assert.ok(rules(validateNote(NOTE, block)).includes("note:frontmatter"));
    assert.ok(rules(validateNote(NOTE, note({ repos: "[web, app" }))).includes("note:frontmatter"));
    assert.ok(!rules(validateNote(NOTE, note())).includes("note:frontmatter"));
  });

  test("note:missing-key for absent, empty and list-valued required keys", () => {
    for (const key of ["type", "title", "summary", "author", "created", "status"]) {
      const absent = validateNote(NOTE, note({ [key]: null }));
      assert.ok(rules(absent).includes(`note:missing-key:${key}`), key);
      assert.equal(absent.find((f) => f.rule === `note:missing-key:${key}`)?.line, 0);
      assert.ok(rules(validateNote(NOTE, note({ [key]: '""' }))).includes(`note:missing-key:${key}`), `${key} empty`);
      assert.ok(rules(validateNote(NOTE, note({ [key]: "[a]" }))).includes(`note:missing-key:${key}`), `${key} list`);
    }
    const emptyAt = validateNote(NOTE, note({ title: '""' })).find((f) => f.rule === "note:missing-key:title");
    assert.equal(emptyAt?.line, 3);
    assert.ok(!rules(validateNote(NOTE, note())).some((r) => r.startsWith("note:missing-key")));
  });

  test("note:type-mismatch", () => {
    assert.ok(rules(validateNote(NOTE, note({ type: "pattern" }))).includes("note:type-mismatch"));
    assert.ok(rules(validateNote(NOTE, note({ type: "bogus" }))).includes("note:type-mismatch"));
    assert.ok(!rules(validateNote(NOTE, note())).includes("note:type-mismatch"));
  });

  test("note:created", () => {
    for (const created of ["16-11-2026", "2026-2-3", "2026-02-30", "2026-13-01", "2026-11-17", "soon"]) {
      assert.ok(rules(validateNote(NOTE, note({ created }))).includes("note:created"), created);
    }
    assert.ok(!rules(validateNote(NOTE, note())).includes("note:created"));
    assert.ok(!rules(validateNote("notes/trap/2024-02-29-x.md", note({ created: "2024-02-29" }))).includes("note:created"));
  });

  test("note:summary", () => {
    const long = `"${"x".repeat(201)}"`;
    assert.ok(rules(validateNote(NOTE, note({ summary: long }))).includes("note:summary"));
    assert.ok(rules(validateNote(NOTE, note({ summary: '"two\\nlines"' }))).includes("note:summary"));
    assert.ok(rules(validateNote(NOTE, note({ summary: '"  "' }))).includes("note:summary"));
    assert.ok(!rules(validateNote(NOTE, note({ summary: `"${"x".repeat(200)}"` }))).includes("note:summary"));
    assert.ok(!rules(validateNote(NOTE, note())).includes("note:summary"));
  });

  test("note:status", () => {
    assert.ok(rules(validateNote(NOTE, note({ status: "draft" }))).includes("note:status"));
    assert.ok(!rules(validateNote(NOTE, note({ status: "superseded" }))).includes("note:status"));
    assert.ok(!rules(validateNote(NOTE, note())).includes("note:status"));
  });

  test("note:repos", () => {
    assert.ok(rules(validateNote(NOTE, note({ repos: "[web, mobile]" }))).includes("note:repos"));
    assert.ok(rules(validateNote(NOTE, note({ repos: "web" }))).includes("note:repos"));
    const f = validateNote(NOTE, note({ repos: "[nope]" })).find((x) => x.rule === "note:repos");
    assert.equal(f?.line, 7);
    for (const ok of ["[]", "[app, web, kb]"]) assert.ok(!rules(validateNote(NOTE, note({ repos: ok }))).includes("note:repos"));
  });

  test("note:tickets", () => {
    for (const bad of ["[0]", "[-1]", "[abc]", "[01]", "[1.5]", "[1, ]", "12"]) {
      assert.ok(rules(validateNote(NOTE, note({ tickets: bad }))).includes("note:tickets"), bad);
    }
    for (const ok of ["[]", "[1]", "[12, 345]"]) assert.ok(!rules(validateNote(NOTE, note({ tickets: ok }))).includes("note:tickets"), ok);
  });
});

// ---------- scanSecrets ----------

describe("scanSecrets", () => {
  const positives: readonly (readonly [string, string])[] = [
    ["secret:github-token", `x = "${GH}"`],
    ["secret:github-token", `export ${GH_PAT}`],
    ["secret:atlassian-token", `key ${ATLASSIAN}`],
    ["secret:aws-key-id", `id ${AWS}`],
    ["secret:slack-token", `hook ${SLACK}`],
    ["secret:openai-style-key", `key ${OPENAI}`],
    ["secret:jwt", `Bearer ${JWT}`],
    ["secret:private-key", PRIVATE_KEY],
  ];

  test("every token rule fires on a runtime-built value, in any file, without echoing it", () => {
    for (const [rule, text] of positives) {
      const found = scanSecrets("tools/x.ts", `line one\n${text}\n`);
      assert.deepEqual(rules(found), [rule], rule);
      assert.equal(found[0]?.line, 2);
      assert.match(found[0]?.message ?? "", /redacted/);
      assert.ok(!(found[0]?.message ?? "").includes(text.slice(-12)));
    }
  });

  test("near misses do not fire", () => {
    for (const text of [
      "ghp_short",
      "gh" + "p_" + "a".repeat(29),
      "github" + "_pat_" + "A".repeat(10),
      "ATATT" + "3" + "x".repeat(5),
      "AKIA" + "A".repeat(15),
      "xox" + "b-" + "12",
      "sk" + "-" + "b".repeat(5),
      "ey" + "J" + "a".repeat(12) + "." + "b".repeat(12),
      "-----BEGIN " + "CERTIFICATE-----",
      "task-" + "b".repeat(24),
    ]) {
      assert.deepEqual(scanSecrets("tools/x.ts", text), [], text);
    }
  });

  test("notes-check: allow skips only its own line", () => {
    const text = `${GH} // notes-check: allow\n${GH}`;
    const found = scanSecrets("a.ts", text);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.line, 2);
  });

  test("one finding per rule per line, one per line otherwise", () => {
    assert.equal(scanSecrets("a.ts", `${GH} ${GH}`).length, 1);
    assert.deepEqual(rules(scanSecrets("a.ts", `${GH}\n${GH}`)), ["secret:github-token", "secret:github-token"]);
    assert.deepEqual(rules(scanSecrets("a.ts", `${GH} ${AWS}`)).sort(), ["secret:aws-key-id", "secret:github-token"]);
  });

  test("skips binary (NUL) and files over 1 MiB", () => {
    assert.deepEqual(scanSecrets("a.bin", `${GH}\0`), []);
    assert.deepEqual(scanSecrets("a.txt", `${GH}\n` + "x".repeat(1024 * 1024)), []);
    assert.equal(scanSecrets("a.txt", `${GH}\n` + "x".repeat(1024 * 1024 - 100)).length, 1);
  });

  test("credential-assignment: only under notes/", () => {
    const line = "password: hunter2hunter2";
    assert.deepEqual(rules(scanSecrets("notes/trap/2026-11-16-x.md", line)), ["secret:credential-assignment"]);
    assert.deepEqual(scanSecrets("tools/x.ts", line), []);
    assert.deepEqual(scanSecrets("notes.md", line), []);
  });

  test("credential-assignment: env, camelCase and JSON shapes fire; templates and short values do not", () => {
    const p = "notes/runbook/2026-11-16-x.md";
    for (const text of [
      "JWT_SECRET=abcdefghijklmnop",
      "DB_PASSWORD=abcdefghijklmnop",
      "clientSecret: abcdefghijklmnop",
      '"apiKey": "abcdefghijklmnop"',
      "api_key = 'abcdefghijklmnop'",
      "Token: abcdefghijklmnop",
    ]) {
      assert.deepEqual(rules(scanSecrets(p, text)), ["secret:credential-assignment"], text);
    }
    for (const text of ["token: ${{ secrets.X }}", "password: short", "password: ...", "the token is rotated monthly", "passwords: see 1Password"]) {
      assert.deepEqual(scanSecrets(p, text), [], text);
    }
    assert.deepEqual(scanSecrets("notes/README.md", "`password: ...`-style lines"), []);
  });

  test("credential-assignment honours the allow marker", () => {
    assert.deepEqual(scanSecrets("notes/log/2026-11-16-x.md", "password: abcdefghijklmnop notes-check: allow"), []);
  });
});

// ---------- helpers ----------

describe("helpers", () => {
  test("slugToTitle", () => {
    assert.equal(slugToTitle("cart-total-wrong"), "Cart total wrong");
    assert.equal(slugToTitle("x"), "X");
  });

  test("notePath", () => {
    assert.equal(notePath("trap", "2026-11-16", "x"), "notes/trap/2026-11-16-x.md");
  });

  test("renderNote writes the documented frontmatter and sections", () => {
    const text = renderNote({ ...input("trap"), repos: [], tickets: [] });
    assert.ok(text.startsWith('---\ntype: trap\ntitle: "Cart total"\nsummary: "Voided line stays in the total"\nauthor: '));
    assert.ok(text.includes("\ncreated: 2026-11-16\nrepos: []\ntickets: []\nstatus: active\n---\n\n# Cart total\n\n## Symptom\n"));
    assert.ok(text.endsWith("\n"));
    const headings = (t: NoteType): string[] => renderNote(input(t)).split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(headings("trap"), ["## Symptom", "## Cause", "## Fix", "## How to check"]);
    assert.deepEqual(headings("pattern"), ["## When to use", "## How", "## Example"]);
    assert.deepEqual(headings("runbook"), ["## When", "## Steps", "## Verify"]);
    assert.deepEqual(headings("log"), ["## What happened", "## Next"]);
  });

  test("renderNote output validates for every type, including awkward authors and summaries", () => {
    for (const type of NOTE_TYPES) {
      const x = input(type);
      assert.deepEqual(validateNote(notePath(type, x.created, x.slug), renderNote(x)), [], type);
    }
    const odd = { ...input("log"), author: "Zoë: O'Neil # \\", summary: 'a "quoted": [thing], # not a comment' };
    assert.deepEqual(validateNote(notePath("log", odd.created, odd.slug), renderNote(odd)), []);
    assert.equal(parseFrontmatter(renderNote(odd))?.data.author, odd.author);
  });

  test("matchesQuery needs every word in title, summary or tickets, ignoring case", () => {
    const data: Frontmatter = { title: "Cart Total", summary: "Voided line stays", tickets: ["12", "7"] };
    assert.equal(matchesQuery(data, ["cart", "VOIDED"]), true);
    assert.equal(matchesQuery(data, ["12"]), true);
    assert.equal(matchesQuery(data, ["cart", "missing"]), false);
    assert.equal(matchesQuery(data, ["author"]), false);
    assert.equal(matchesQuery({ title: "x", author: "zed" }, ["zed"]), false);
    assert.equal(matchesQuery({}, ["a"]), false);
  });
});

// ---------- main: new ----------

describe("main new", () => {
  test("writes a valid note and prints its repo-relative path", async (t) => {
    const root = repo();
    const r = await run(t, root, "new", "trap", "cart-total", "Voided line stays in the total", "--repos", "web,app", "--ticket", "12", "--ticket", "7");
    assert.equal(r.code, 0);
    assert.match(r.out, /^notes\/trap\/\d{4}-\d{2}-\d{2}-cart-total\.md$/);
    const text = readFileSync(join(root, ...r.out.split("/")), "utf8");
    assert.deepEqual(validateNote(r.out, text), []);
    assert.match(text, /author: "Test Author"/);
    assert.match(text, /repos: \[web, app\]\ntickets: \[12, 7\]/);
    assert.equal(r.err, "");
  });

  test("uses the local date, zero-padded", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 0, 5, 23, 59).getTime() });
    const r = await run(t, repo(), "new", "log", "late", "Written late on the 5th");
    assert.equal(r.out, "notes/log/2026-01-05-late.md");
  });

  test("works for every type", async (t) => {
    const root = repo();
    for (const type of NOTE_TYPES) {
      const r = await run(t, root, "new", type, "same-slug", "One line");
      assert.equal(r.code, 0, type);
    }
  });

  test("refuses to overwrite (wx)", async (t) => {
    const root = repo();
    const first = await run(t, root, "new", "trap", "dup", "One line");
    const path = join(root, ...first.out.split("/"));
    writeFileSync(path, "keep me");
    const second = await run(t, root, "new", "trap", "dup", "One line");
    assert.equal(second.code, 1);
    assert.match(second.err, /already exists/);
    assert.equal(readFileSync(path, "utf8"), "keep me");
  });

  test("input errors exit 1 with a message on stderr and write nothing", async (t) => {
    const root = repo();
    const cases: readonly (readonly string[])[] = [
      ["new", "bogus", "x", "s"],
      ["new", "trap", "Bad Slug", "s"],
      ["new", "trap", "-x", "s"],
      ["new", "trap", "a".repeat(61), "s"],
      ["new", "trap", "x", ""],
      ["new", "trap", "x", "   "],
      ["new", "trap", "x", "a\nb"],
      ["new", "trap", "x", "y".repeat(201)],
      ["new", "trap", "x", "s", "--repos", "mobile"],
      ["new", "trap", "x", "s", "--repos", "app,,web"],
      ["new", "trap", "x", "s", "--ticket", "0"],
      ["new", "trap", "x", "s", "--ticket", "-3"],
      ["new", "trap", "x", "s", "--ticket", "1.5"],
      ["new", "trap", "x", "s", "--ticket", "abc"],
    ];
    for (const argv of cases) {
      const r = await run(t, root, ...argv);
      assert.equal(r.code, 1, argv.join("|"));
      assert.match(r.err, /^notes: /);
      assert.equal(r.out, "");
    }
    assert.equal(existsSync(join(root, "notes")), false);
  });

  test("accepts a 200-char summary and a 60-char slug, and an empty --repos", async (t) => {
    const r = await run(t, repo(), "new", "trap", "a".repeat(60), "y".repeat(200), "--repos", "");
    assert.equal(r.code, 0);
  });

  test("an empty git user.name is an error", async (t) => {
    const r = await run(t, repo(null), "new", "trap", "x", "s");
    assert.equal(r.code, 1);
    assert.match(r.err, /user\.name/);
  });

  test("unknown options, missing values and wrong positional counts print usage and exit 2", async (t) => {
    const root = repo();
    for (const argv of [
      ["new", "trap", "x", "s", "--verbose"],
      ["new", "trap", "x", "s", "--repos=app"],
      ["new", "trap", "x", "s", "--repos"],
      ["new", "trap", "x", "s", "--ticket"],
      ["new", "trap", "x"],
      ["new", "trap", "x", "s", "extra"],
      ["new"],
    ]) {
      const r = await run(t, root, ...argv);
      assert.equal(r.code, 2, argv.join("|"));
      assert.match(r.err, /^usage:/);
    }
  });
});

// ---------- main: check ----------

describe("main check", () => {
  test("--staged fails on a staged token, redacts it and reads the index not the working tree", async (t) => {
    const root = repo();
    put(root, "src/config.ts", `export const t = "${GH}";\n`);
    put(root, "src/config.ts", "export const t = process.env.T;\n", false); // working tree is clean, index is not
    const r = await run(t, root, "check", "--staged");
    assert.equal(r.code, 1);
    assert.match(r.out, /src\/config\.ts:1: secret:github-token: /);
    assert.ok(!r.out.includes(GH));
    assert.ok(!r.err.includes(GH));
    assert.match(r.out, /notes check: 1 files, 1 findings$/);
  });

  test("--staged passes when only the working tree has the token", async (t) => {
    const root = repo();
    put(root, "src/config.ts", "ok\n");
    put(root, "src/config.ts", `${GH}\n`, false);
    assert.equal((await run(t, root, "check", "--staged")).code, 0);
  });

  test("--staged with nothing staged reports zero files", async (t) => {
    const r = await run(t, repo(), "check", "--staged");
    assert.equal(r.code, 0);
    assert.equal(r.out, "notes check: 0 files, 0 findings");
  });

  test("--staged skips deleted files, oversized files and binaries", async (t) => {
    const root = repo();
    put(root, "big.txt", `${GH}\n` + "x".repeat(1024 * 1024 + 10));
    put(root, "blob.bin", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(GH)]));
    const r = await run(t, root, "check", "--staged");
    assert.equal(r.code, 0);
    assert.match(r.out, /notes check: 1 files, 0 findings$/); // big.txt is skipped before reading
  });

  test("--staged scans UTF-16 files by BOM", async (t) => {
    const root = repo();
    put(root, "wide.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`k = ${GH}\n`, "utf16le")]));
    const r = await run(t, root, "check", "--staged");
    assert.equal(r.code, 1);
    assert.match(r.out, /wide\.txt:1: secret:github-token/);
  });

  test("--staged handles UTF-16 big-endian files and an odd trailing byte", async (t) => {
    const root = repo();
    const le = Buffer.from(`k = ${GH}\n`, "utf16le");
    put(root, "be.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16(), Buffer.from([0])]));
    assert.equal((await run(t, root, "check", "--staged")).code, 1);
  });

  test("--staged validates notes and applies the credential rule", async (t) => {
    const root = repo();
    put(root, "notes/trap/2026-11-16-x.md", note({ summary: '"password: abcdefghijklmnop"' }));
    const r = await run(t, root, "check", "--staged");
    assert.equal(r.code, 1);
    assert.match(r.out, /notes\/trap\/2026-11-16-x\.md:4: secret:credential-assignment/);
  });

  test("--all passes on a clean repo with a valid note and the README", async (t) => {
    const root = repo();
    put(root, "notes/README.md", "# Notes\n\n`password: ...`-style lines\n");
    put(root, "notes/trap/2026-11-16-cart-total.md", note());
    put(root, "src/a.ts", "export const a = 1;\n");
    const r = await run(t, root, "check", "--all");
    assert.equal(r.code, 0);
    assert.equal(r.out, "notes check: 3 files, 0 findings");
  });

  test("--all flags misplaced and malformed notes (every .md under notes/ except README)", async (t) => {
    const root = repo();
    put(root, "notes/traps/2026-11-16-x.md", note());
    put(root, "notes/x.md", note());
    put(root, "notes/trap/sub/x.md", note());
    put(root, "notes/trap/2026-11-16-bad.md", "no frontmatter\n");
    put(root, "notes/trap/notes.txt", "not markdown\n");
    const r = await run(t, root, "check", "--all");
    assert.equal(r.code, 1);
    for (const p of ["notes/traps/2026-11-16-x.md", "notes/x.md", "notes/trap/sub/x.md"]) {
      assert.ok(r.out.includes(`${p}:0: note:path`), p);
    }
    assert.ok(r.out.includes("notes/trap/2026-11-16-bad.md:0: note:no-frontmatter"));
    assert.ok(!r.out.includes("notes.txt"));
  });

  test("--all reads from disk, finds committed tokens and skips tracked-but-deleted files", async (t) => {
    const root = repo();
    put(root, "a.ts", `${GH}\n`);
    put(root, "gone.ts", "x\n");
    unlinkSync(join(root, "gone.ts"));
    const r = await run(t, root, "check", "--all");
    assert.equal(r.code, 1);
    assert.match(r.out, /a\.ts:1: secret:github-token/);
    assert.match(r.out, /notes check: 1 files, 1 findings$/);
    assert.ok(!r.out.includes(GH));
  });

  test("a note created by `new` passes check --all", async (t) => {
    const root = repo();
    const made = await run(t, root, "new", "pattern", "retry-with-backoff", "Retry flaky calls with capped backoff", "--repos", "web", "--ticket", "5");
    git(root, "add", "--", made.out);
    assert.equal((await run(t, root, "check", "--all")).code, 0);
    assert.equal((await run(t, root, "check", "--staged")).code, 0);
  });

  test("outside a git repo it fails closed", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "notes-nogit-"));
    dirs.push(dir);
    const r = await run(t, dir, "check", "--all");
    assert.equal(r.code, 1);
    assert.match(r.err, /^notes: /);
  });

  test("bad check arguments print usage and exit 2", async (t) => {
    const root = repo();
    for (const argv of [["check"], ["check", "--bogus"], ["check", "--staged", "--all"]]) {
      const r = await run(t, root, ...argv);
      assert.equal(r.code, 2, argv.join("|"));
      assert.match(r.err, /^usage:/);
    }
  });
});

// ---------- main: find ----------

describe("main find", () => {
  function seed(): string {
    const root = repo();
    const add = (name: string, over: Record<string, string | null>): void => {
      const file = name.replace(/^notes\/[^/]+\//, "");
      put(root, name, note({ created: file.slice(0, 10), ...over }), false);
    };
    add("notes/trap/2026-11-10-old.md", { title: '"Old void bug"', summary: '"Receipt prints twice"', tickets: "[3]" });
    add("notes/trap/2026-11-16-b-new.md", { title: '"New void bug"', summary: '"Total keeps voided line"', tickets: "[12]" });
    add("notes/trap/2026-11-16-a-new.md", { title: '"Same day"', summary: '"Void again"', status: "superseded" });
    put(root, "notes/log/2026-11-01-broken.md", "no frontmatter void\n", false);
    put(root, "notes/README.md", "# void\n", false);
    return root;
  }

  test("prints path, status and summary, newest first with path tie-break", async (t) => {
    const r = await run(t, seed(), "find", "void");
    assert.equal(r.code, 0);
    assert.deepEqual(r.out.split("\n"), [
      "notes/trap/2026-11-16-a-new.md  [superseded]  Void again",
      "notes/trap/2026-11-16-b-new.md  [active]  Total keeps voided line",
      "notes/trap/2026-11-10-old.md  [active]  Receipt prints twice",
    ]);
    assert.ok(!r.out.includes("\\"));
  });

  test("all words must match, case-insensitively, across title, summary and tickets", async (t) => {
    const root = seed();
    assert.equal((await run(t, root, "find", "VOID", "keeps")).out, "notes/trap/2026-11-16-b-new.md  [active]  Total keeps voided line");
    assert.match((await run(t, root, "find", "12")).out, /b-new/);
    assert.match((await run(t, root, "find", "receipt", "old")).out, /old\.md/);
    assert.equal((await run(t, root, "find", "void", "zebra")).out, "no notes match");
  });

  test("no match and a missing notes/ directory both print `no notes match` and exit 0", async (t) => {
    const a = await run(t, seed(), "find", "zebra");
    assert.deepEqual([a.code, a.out], [0, "no notes match"]);
    const b = await run(t, repo(), "find", "anything");
    assert.deepEqual([b.code, b.out], [0, "no notes match"]);
  });

  test("notes whose frontmatter does not parse are skipped", async (t) => {
    const r = await run(t, seed(), "find", "void");
    assert.ok(!r.out.includes("broken"));
  });

  test("zero words prints usage and exits 2", async (t) => {
    const r = await run(t, seed(), "find");
    assert.equal(r.code, 2);
    assert.match(r.err, /^usage:/);
  });
});

// ---------- main: dispatch ----------

describe("main dispatch", () => {
  test("no arguments or an unknown command print usage and exit 2", async (t) => {
    for (const argv of [[], ["frobnicate"]]) {
      const r = await run(t, repo(), ...argv);
      assert.equal(r.code, 2);
      assert.match(r.err, /^usage:/);
      assert.equal(r.out, "");
    }
  });

  test("the CLI runs from any directory and defaults the root to its own clone", () => {
    const out = execFileSync(process.execPath, [join(import.meta.dirname, "notes.ts"), "check", "--all"], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    assert.match(out, /notes check: \d+ files, 0 findings/);
  });
});
