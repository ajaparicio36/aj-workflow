import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RepoKey, Status } from "./config.ts";
import {
  branchName,
  branchesComment,
  desiredStatus,
  extractJiraKey,
  formLabels,
  jiraDescription,
  jiraKeyFromBody,
  jiraLabels,
  jiraSummary,
  mergeOutcome,
  planIssueSync,
  planPrSync,
  prCommentMarker,
  repoKeysOf,
  slugify,
  statusLabelDiff,
  statusOfLabel,
  stripJiraMarker,
  ticketTypeOf,
  withJiraMarker,
} from "./core.ts";
import type { IssueAction, LiveIssue, PrState } from "./core.ts";

interface IssueSpec {
  readonly state?: "open" | "closed";
  /** labels written `name@seq`; no `@` means no labeled event (-1) */
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly lastAssigned?: number;
  readonly lastUnassigned?: number;
  readonly lastReopened?: number;
  readonly title?: string;
  readonly body?: string;
}

function issue(spec: IssueSpec = {}): LiveIssue {
  const labelAdded: Record<string, number> = {};
  const labels = (spec.labels ?? []).map((raw) => {
    const at = raw.lastIndexOf("@");
    if (at === -1) return raw;
    const name = raw.slice(0, at);
    labelAdded[name] = Number(raw.slice(at + 1));
    return name;
  });
  return {
    number: 7,
    nodeId: "I_7",
    title: spec.title ?? "Add cart",
    body: spec.body ?? "",
    state: spec.state ?? "open",
    labels,
    assignees: spec.assignees ?? [],
    htmlUrl: "https://github.com/acme/acme-kb/issues/7",
    history: {
      labelAdded,
      lastAssigned: spec.lastAssigned ?? -1,
      lastUnassigned: spec.lastUnassigned ?? -1,
      lastReopened: spec.lastReopened ?? -1,
    },
  };
}

function pr(over: Partial<PrState> = {}): PrState {
  return {
    state: "open",
    draft: false,
    merged: false,
    headRef: "feat/ACME-12-x",
    baseRef: "master",
    defaultBranch: "master",
    title: "Something",
    htmlUrl: "https://github.com/acme/acme-app/pull/3",
    ...over,
  };
}

describe("status labels (3.1)", () => {
  it("statusOfLabel maps status:done -> done, else null", () => {
    assert.equal(statusOfLabel("status:done"), "done");
    assert.equal(statusOfLabel("status:bogus"), null);
    assert.equal(statusOfLabel("repo:app"), null);
  });

  it("statusLabelDiff adds the missing label and removes every other status:* label", () => {
    assert.deepEqual(statusLabelDiff(["status:todo", "status:bogus", "repo:app"], "in-progress"), {
      add: ["status:in-progress"],
      remove: ["status:todo", "status:bogus"],
    });
  });

  it("statusLabelDiff is empty when exactly the wanted label is present", () => {
    assert.deepEqual(statusLabelDiff(["status:done", "bug"], "done"), { add: [], remove: [] });
  });
});

describe("desiredStatus (3.2)", () => {
  const cases: readonly [string, IssueSpec, Status][] = [
    ["open, [], [] -> todo", {}, "todo"],
    ["open, [], [ana] -> in-progress", { assignees: ["ana"] }, "in-progress"],
    ["open, [status:bogus], [] -> todo", { labels: ["status:bogus"] }, "todo"],
    [
      "open, [status:todo@0], [ana], lastAssigned 1 -> in-progress",
      { labels: ["status:todo@0"], assignees: ["ana"], lastAssigned: 1 },
      "in-progress",
    ],
    [
      "open, [status:todo@3], [ana], lastAssigned 1 -> todo (someone moved it back)",
      { labels: ["status:todo@3"], assignees: ["ana"], lastAssigned: 1 },
      "todo",
    ],
    [
      "open, [status:in-review@2, status:todo@5], [ana], lastAssigned 1 -> todo (manual backward move wins)",
      { labels: ["status:in-review@2", "status:todo@5"], assignees: ["ana"], lastAssigned: 1 },
      "todo",
    ],
    [
      "open, [status:in-progress@1, status:in-review@4] -> in-review",
      { labels: ["status:in-progress@1", "status:in-review@4"] },
      "in-review",
    ],
    [
      "open, [status:in-progress@6, status:in-review@4] -> in-progress",
      { labels: ["status:in-progress@6", "status:in-review@4"] },
      "in-progress",
    ],
    [
      "open, [status:done@4], [ana], lastReopened 2 -> done",
      { labels: ["status:done@4"], assignees: ["ana"], lastReopened: 2 },
      "done",
    ],
    [
      "open, [status:done@4], [ana], lastReopened 6 -> in-progress",
      { labels: ["status:done@4"], assignees: ["ana"], lastReopened: 6 },
      "in-progress",
    ],
    [
      "open, [status:done@4], [], lastReopened 6 -> todo",
      { labels: ["status:done@4"], lastReopened: 6 },
      "todo",
    ],
    ["closed, [status:in-review@1] -> done", { state: "closed", labels: ["status:in-review@1"] }, "done"],
    [
      "open, [status:in-progress@1], [], lastUnassigned 3 -> todo",
      { labels: ["status:in-progress@1"], lastUnassigned: 3 },
      "todo",
    ],
    [
      "open, [status:in-progress@1], [], lastUnassigned 0 -> in-progress",
      { labels: ["status:in-progress@1"], lastUnassigned: 0 },
      "in-progress",
    ],
    [
      "open, [status:in-review@1], [], lastUnassigned 3 -> in-review",
      { labels: ["status:in-review@1"], lastUnassigned: 3 },
      "in-review",
    ],
    [
      "open, [status:todo, status:in-review] with no history -> in-review (tie -> furthest)",
      { labels: ["status:todo", "status:in-review"] },
      "in-review",
    ],
  ];
  for (const [name, spec, want] of cases) {
    it(name, () => {
      assert.equal(desiredStatus(issue(spec)), want);
    });
  }
});

describe("planIssueSync (3.3)", () => {
  const plan = (spec: IssueSpec, action: IssueAction, label: string | null = null): ReturnType<typeof planIssueSync> =>
    planIssueSync(issue(spec), { action, label });

  it("opened; [status:todo@0, repo:app, type:fix]; [ana]; lastAssigned 1 -> in-progress, branches [app], type fix", () => {
    const p = plan(
      { labels: ["status:todo@0", "repo:app", "type:fix"], assignees: ["ana"], lastAssigned: 1 },
      "opened",
    );
    assert.equal(p.status, "in-progress");
    assert.deepEqual(p.labels, { add: ["status:in-progress"], remove: ["status:todo"] });
    assert.deepEqual(p.ensureBranchesIn, ["app"]);
    assert.equal(p.ticketType, "fix");
    assert.deepEqual(p.warnings, []);
  });

  it('labeled "priority:p1"; [status:todo@0, repo:app]; [ana]; lastAssigned 1 -> in-progress, branches [app]', () => {
    const p = plan({ labels: ["status:todo@0", "repo:app"], assignees: ["ana"], lastAssigned: 1 }, "labeled", "priority:p1");
    assert.equal(p.status, "in-progress");
    assert.deepEqual(p.ensureBranchesIn, ["app"]);
    assert.equal(p.ticketType, "chore");
  });

  it("edited; [status:in-progress@2, repo:app]; [ana]; lastAssigned 1 -> branches [] (no trigger)", () => {
    const p = plan({ labels: ["status:in-progress@2", "repo:app"], assignees: ["ana"], lastAssigned: 1 }, "edited");
    assert.equal(p.status, "in-progress");
    assert.deepEqual(p.ensureBranchesIn, []);
    assert.deepEqual(p.labels, { add: [], remove: [] });
  });

  it('labeled "repo:web"; [status:in-progress@2, repo:app, repo:web, repo:zzz]; [ana] -> branches [app, web], warning about repo:zzz', () => {
    const p = plan(
      { labels: ["status:in-progress@2", "repo:web", "repo:app", "repo:zzz"], assignees: ["ana"] },
      "labeled",
      "repo:web",
    );
    assert.deepEqual(p.ensureBranchesIn, ["app", "web"]);
    assert.deepEqual(p.warnings, ["unknown repo label repo:zzz"]);
  });

  it('assigned; [status:todo@0]; [ana]; lastAssigned 1 -> in-progress, branches [], warning "assigned but no repo:* label..."', () => {
    const p = plan({ labels: ["status:todo@0"], assignees: ["ana"], lastAssigned: 1 }, "assigned");
    assert.equal(p.status, "in-progress");
    assert.deepEqual(p.ensureBranchesIn, []);
    assert.deepEqual(p.warnings, ["assigned but no repo:* label, no branch created"]);
  });

  it('labeled "status:done"; open; [status:in-progress@1, status:done@3]; [ana] -> done, closeIssue true, remove [status:in-progress]', () => {
    const p = plan({ labels: ["status:in-progress@1", "status:done@3"], assignees: ["ana"] }, "labeled", "status:done");
    assert.equal(p.status, "done");
    assert.equal(p.closeIssue, true);
    assert.deepEqual(p.labels, { add: [], remove: ["status:in-progress"] });
    assert.deepEqual(p.ensureBranchesIn, []);
  });

  it("closed; [status:in-review@1] -> done, add [status:done], remove [status:in-review], closeIssue false", () => {
    const p = plan({ state: "closed", labels: ["status:in-review@1"] }, "closed");
    assert.equal(p.status, "done");
    assert.deepEqual(p.labels, { add: ["status:done"], remove: ["status:in-review"] });
    assert.equal(p.closeIssue, false);
  });

  it("repoKeysOf dedupes and follows CONFIG.repos key order", () => {
    const { keys, unknown } = repoKeysOf(["repo:web", "repo:app", "repo:web", "repo:nope"]);
    assert.deepEqual(keys, ["app", "web"] satisfies RepoKey[]);
    assert.deepEqual(unknown, ["repo:nope"]);
  });

  it("ticketTypeOf picks the first type in TICKET_TYPES order, else chore", () => {
    assert.equal(ticketTypeOf(["type:docs", "type:fix"]), "fix");
    assert.equal(ticketTypeOf(["bug"]), "chore");
  });
});

describe("formLabels (3.4)", () => {
  it("full form -> [type:feat, repo:app, repo:web, priority:p1]", () => {
    assert.deepEqual(
      formLabels("### Type\n\nfeat\n\n### Repos\n\napp, web\n\n### Priority\n\np1\n\n### Why\n\nx"),
      ["type:feat", "repo:app", "repo:web", "priority:p1"],
    );
  });

  it('"### Repos\\n\\n_No response_" -> []', () => {
    assert.deepEqual(formLabels("### Repos\n\n_No response_"), []);
  });

  it('"### Repos\\n\\napp, zzz" -> [repo:app]', () => {
    assert.deepEqual(formLabels("### Repos\n\napp, zzz"), ["repo:app"]);
  });

  it("plain markdown body -> []", () => {
    assert.deepEqual(formLabels("Just some text\n\n- a list\n"), []);
  });

  it("CRLF bodies, headings in any order and case", () => {
    assert.deepEqual(formLabels("### priority\r\n\r\np2\r\n\r\n### TYPE\r\n\r\nFix\r\n"), ["type:fix", "priority:p2"]);
  });
});

describe("PR planning (3.5)", () => {
  const keyCases: readonly [string, string | null][] = [
    ["feat/ACME-12-add-cart", "ACME-12"],
    ["fix/acme-7-x", "ACME-7"],
    ["ACME-12: add cart", "ACME-12"],
    ["[ACME-3] x", "ACME-3"],
    ["feat/XACME-12-a", null],
    ["feat/ACME-12a", null],
    ["main", null],
  ];
  for (const [text, want] of keyCases) {
    it(`extractJiraKey(${JSON.stringify(text)}) -> ${want}`, () => {
      assert.equal(extractJiraKey(text), want);
    });
  }

  it("open, head feat/ACME-12-x -> ACME-12 in-review", () => {
    assert.deepEqual(planPrSync(pr()), { key: "ACME-12", status: "in-review" });
  });

  it("draft -> in-progress", () => {
    assert.deepEqual(planPrSync(pr({ draft: true })), { key: "ACME-12", status: "in-progress" });
  });

  it("merged into master = default -> done", () => {
    assert.deepEqual(planPrSync(pr({ state: "closed", merged: true })), { key: "ACME-12", status: "done" });
  });

  it("merged into feat/ACME-12-part1 -> status null", () => {
    assert.deepEqual(planPrSync(pr({ state: "closed", merged: true, baseRef: "feat/ACME-12-part1" })), {
      key: "ACME-12",
      status: null,
    });
  });

  it("closed unmerged -> in-progress", () => {
    assert.deepEqual(planPrSync(pr({ state: "closed" })), { key: "ACME-12", status: "in-progress" });
  });

  it("head develop, title `Release ACME-12`, merged -> key null", () => {
    assert.deepEqual(planPrSync(pr({ headRef: "develop", title: "Release ACME-12", state: "closed", merged: true })), {
      key: null,
      status: null,
    });
  });

  it("head develop, title `ACME-9: x`, open -> ACME-9 in-review", () => {
    assert.deepEqual(planPrSync(pr({ headRef: "develop", title: "ACME-9: x" })), { key: "ACME-9", status: "in-review" });
  });

  it("mergeOutcome(n): n <= 1 -> close, else comment", () => {
    assert.equal(mergeOutcome(0), "close");
    assert.equal(mergeOutcome(1), "close");
    assert.equal(mergeOutcome(2), "comment");
  });
});

describe("helpers (3.6)", () => {
  it('slugify("Añadir carrito (POS) ✨") -> anadir-carrito-pos', () => {
    assert.equal(slugify("Añadir carrito (POS) ✨"), "anadir-carrito-pos");
  });

  it('slugify("!!!") -> ticket', () => {
    assert.equal(slugify("!!!"), "ticket");
  });

  it("slugify of a 60-char multi-word title -> <= 40 chars ending on a whole word", () => {
    const title = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const slug = slugify(title);
    assert.ok(slug.length <= 40);
    assert.ok(title.split(" ").includes(slug.split("-").at(-1) ?? ""));
    assert.equal(slug, "alpha-bravo-charlie-delta-echo-foxtrot");
  });

  it("slugify of one long word cuts at max", () => {
    assert.equal(slugify("a".repeat(60)), "a".repeat(40));
  });

  it("branchName -> type/KEY-slug", () => {
    assert.equal(branchName("fix", "ACME-12", "Añadir carrito"), "fix/ACME-12-anadir-carrito");
  });

  it("jiraKeyFromBody reads the marker", () => {
    assert.equal(jiraKeyFromBody("text\n\n<!-- jira:ACME-12 -->"), "ACME-12");
    assert.equal(jiraKeyFromBody("no marker"), null);
  });

  it("withJiraMarker appends, replaces, and handles an empty body", () => {
    assert.equal(withJiraMarker("body\n\n", "ACME-1"), "body\n\n<!-- jira:ACME-1 -->");
    assert.equal(withJiraMarker("body\n\n<!-- jira:ACME-1 -->", "ACME-2"), "body\n\n<!-- jira:ACME-2 -->");
    assert.equal(withJiraMarker("", "ACME-1"), "<!-- jira:ACME-1 -->");
  });

  it("stripJiraMarker removes all markers and trims the end", () => {
    assert.equal(stripJiraMarker("body\n\n<!-- jira:ACME-1 -->\n"), "body");
    assert.equal(stripJiraMarker("<!-- jira:ACME-1 -->"), "");
  });

  it("jiraSummary caps at 255 chars with an ellipsis", () => {
    assert.equal(jiraSummary("short"), "short");
    assert.equal(jiraSummary("x".repeat(255)), "x".repeat(255));
    const cut = jiraSummary("x".repeat(300));
    assert.equal(cut.length, 255);
    assert.ok(cut.endsWith("…"));
  });

  it("jiraDescription appends the source line, strips the marker, handles empty and long bodies", () => {
    const base = { number: 7, htmlUrl: "https://gh/7" };
    const source = "Source of truth: [GitHub #7|https://gh/7]";
    assert.equal(jiraDescription({ ...base, body: "hello\n\n<!-- jira:ACME-1 -->" }), `hello\n\n${source}`);
    assert.equal(jiraDescription({ ...base, body: "" }), source);
    const long = jiraDescription({ ...base, body: "y".repeat(30001) });
    assert.equal(long, `${"y".repeat(30000)}\n\n(truncated, see GitHub)\n\n${source}`);
  });

  it("jiraLabels -> gh-n plus repo-<key>", () => {
    assert.deepEqual(jiraLabels(7, ["app", "web"]), ["gh-7", "repo-app", "repo-web"]);
    assert.deepEqual(jiraLabels(7, []), ["gh-7"]);
  });

  it("branchesComment lists entries, marks created, one switch line per distinct branch", () => {
    assert.equal(
      branchesComment([
        { repo: "acme-app", branch: "fix/ACME-1-x", created: true },
        { repo: "acme-web", branch: "fix/ACME-1-x", created: false },
      ]),
      [
        "<!-- ticket-sync:branches -->",
        "**Branches**",
        "",
        "- `acme-app`: `fix/ACME-1-x` (created)",
        "- `acme-web`: `fix/ACME-1-x`",
        "",
        "```bash",
        "git fetch origin && git switch fix/ACME-1-x",
        "```",
      ].join("\n"),
    );
  });

  it("prCommentMarker", () => {
    assert.equal(prCommentMarker("acme-app", 3), "<!-- ticket-sync:pr:acme-app#3 -->");
  });
});
