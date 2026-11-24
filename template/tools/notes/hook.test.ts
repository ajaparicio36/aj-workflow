import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

// Fake secret is built at runtime so this file never contains a token-shaped literal.
const GH = "gh" + "p_" + "a".repeat(36);

const repoRoot = resolve(import.meta.dirname, "../..");
const COPIED = [".githooks/pre-commit", "tools/notes/notes.ts"] as const;

interface Run {
  readonly status: number | null;
  readonly out: string;
}

let tmp = "";

function git(...args: string[]): Run {
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf8" });
  assert.equal(r.error, undefined, `git ${args.join(" ")} failed to spawn`);
  return { status: r.status, out: r.stdout + r.stderr };
}

// True when HEAD contains the path (false on an empty repo too).
const committed = (path: string): boolean => git("cat-file", "-e", `HEAD:${path}`).status === 0;

before((): void => {
  tmp = mkdtempSync(join(tmpdir(), "notes-hook-"));
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "core.hooksPath", ".githooks");
  git("config", "commit.gpgsign", "false");
  for (const rel of COPIED) {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    copyFileSync(join(repoRoot, rel), join(tmp, rel));
  }
  chmodSync(join(tmp, ".githooks/pre-commit"), 0o755);
});

after((): void => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pre-commit hook", () => {
  test("rejects a commit containing a secret", (): void => {
    writeFileSync(join(tmp, "leak.txt"), `token = ${GH}\n`);
    git("add", "leak.txt");
    const commit = git("commit", "-m", "chore: leak");
    assert.notEqual(commit.status, 0, commit.out);
    assert.match(commit.out, /leak\.txt:1: secret:github-token/);
    assert.ok(!commit.out.includes(GH), "the hook must not print the token");
    assert.equal(committed("leak.txt"), false);
    git("rm", "-q", "--cached", "leak.txt");
    rmSync(join(tmp, "leak.txt"));
  });

  test("accepts a clean commit", (): void => {
    writeFileSync(join(tmp, "clean.txt"), "nothing secret here\n");
    git("add", "clean.txt");
    const commit = git("commit", "-m", "chore: clean");
    assert.equal(commit.status, 0, commit.out);
    assert.equal(committed("clean.txt"), true);
  });
});
