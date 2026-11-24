import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKERS } from "./config.ts";
import type { LinkedBranch, LiveIssue, PrState } from "./core.ts";
import type { GitHubClient, RepoRef } from "./github.ts";
import type { JiraClient, JiraCreate, JiraFields, TransitionResult } from "./jira.ts";
import { runIssueEvent, runPullRequestEvent } from "./main.ts";
import type { Deps } from "./main.ts";

const HUB = "acme-kb";
const NO_HISTORY = { labelAdded: {}, lastAssigned: -1, lastUnassigned: -1, lastReopened: -1 } as const;

function issueOf(over: Partial<LiveIssue> = {}): LiveIssue {
  return {
    number: 7,
    nodeId: "I_7",
    title: "Add cart",
    body: "",
    state: "open",
    labels: [],
    assignees: [],
    htmlUrl: "https://github.com/acme/acme-kb/issues/7",
    history: NO_HISTORY,
    ...over,
  };
}

interface GhOpts {
  readonly issues: readonly LiveIssue[];
  readonly linked?: readonly LinkedBranch[];
  readonly branches?: readonly string[];
  readonly prs?: Readonly<Record<string, PrState>>;
}

interface FakeGh {
  readonly client: GitHubClient;
  readonly calls: string[];
  readonly issues: Map<number, LiveIssue>;
  readonly comments: Map<string, string>;
}

function fakeGh(opts: GhOpts): FakeGh {
  const calls: string[] = [];
  const issues = new Map(opts.issues.map((i) => [i.number, i]));
  const comments = new Map<string, string>();
  const get = (n: number): LiveIssue => {
    const i = issues.get(n);
    if (!i) throw new Error(`no issue ${n}`);
    return i;
  };
  const client: GitHubClient = {
    getIssue: async (_repo, n) => get(n),
    addLabels: async (_repo, n, labels) => {
      calls.push(`addLabels ${n} ${labels.join(",")}`);
      issues.set(n, { ...get(n), labels: [...get(n).labels, ...labels] });
    },
    removeLabel: async (_repo, n, label) => {
      calls.push(`removeLabel ${n} ${label}`);
      issues.set(n, { ...get(n), labels: get(n).labels.filter((l) => l !== label) });
    },
    updateBody: async (_repo, n, body) => {
      calls.push(`updateBody ${n}`);
      issues.set(n, { ...get(n), body });
    },
    closeIssue: async (_repo, n) => {
      calls.push(`closeIssue ${n}`);
      issues.set(n, { ...get(n), state: "closed" });
    },
    upsertComment: async (_repo, n, marker, body) => {
      calls.push(`upsertComment ${n} ${marker}`);
      comments.set(marker, body);
    },
    getRepo: async (repo): Promise<RepoRef> => ({ id: `R_${repo}`, name: repo, defaultBranch: "main", headOid: "abc" }),
    branchExists: async (repo, branch) => (opts.branches ?? []).includes(`${repo}:${branch}`),
    linkedBranches: async () => [...(opts.linked ?? [])],
    createLinkedBranch: async (_id, repo, branch) => {
      calls.push(`createLinkedBranch ${repo.name} ${branch}`);
    },
    setProjectStatus: async (project, _id, option) => {
      calls.push(`setProjectStatus ${project} ${option}`);
    },
    getPullRequest: async (repo, n) => {
      const pr = opts.prs?.[`${repo}#${n}`];
      if (!pr) throw new Error(`no PR ${repo}#${n}`);
      return pr;
    },
  };
  return { client, calls, issues, comments };
}

interface JiraOpts {
  readonly keys?: Readonly<Record<string, number>>; // key -> gh number
  readonly createThrows?: boolean;
  readonly transition?: TransitionResult;
  readonly sprint?: string | null; // undefined -> "ACME Sprint 1"
  readonly sprintThrows?: boolean;
}

interface FakeJira {
  readonly client: JiraClient;
  readonly creates: JiraCreate[];
  readonly updates: { key: string; fields: JiraFields }[];
  readonly transitions: string[];
  readonly sprinted: string[];
}

function fakeJira(opts: JiraOpts = {}): FakeJira {
  const keys = new Map(Object.entries(opts.keys ?? {}));
  const creates: JiraCreate[] = [];
  const updates: { key: string; fields: JiraFields }[] = [];
  const transitions: string[] = [];
  const sprinted: string[] = [];
  const client: JiraClient = {
    findKeyByGhNumber: async (n) => [...keys].find(([, gh]) => gh === n)?.[0] ?? null,
    ghNumberForKey: async (key) => keys.get(key) ?? null,
    create: async (fields) => {
      if (opts.createThrows) throw new Error("POST /rest/api/2/issue -> 500: boom");
      creates.push(fields);
      keys.set("ACME-100", Number(fields.labels[0]?.replace("gh-", "")));
      return "ACME-100";
    },
    update: async (key, fields) => {
      updates.push({ key, fields });
    },
    transition: async (key, name) => {
      transitions.push(`${key} ${name}`);
      return opts.transition ?? "transitioned";
    },
    addToActiveSprint: async (key) => {
      if (opts.sprintThrows) throw new Error("POST /rest/agile/1.0/sprint/9/issue -> 403: nope");
      sprinted.push(key);
      return opts.sprint === undefined ? "ACME Sprint 1" : opts.sprint;
    },
  };
  return { client, creates, updates, transitions, sprinted };
}

function deps(hub: FakeGh, bot: FakeGh | null, jira: FakeJira | null, projectNumber: number | null = 3): Deps {
  return { hub: hub.client, bot: bot?.client ?? null, jira: jira?.client ?? null, projectNumber, hubRepo: HUB };
}

const ev = (action: string, number = 7, label?: string): unknown => ({
  action,
  issue: { number },
  ...(label ? { label: { name: label } } : {}),
});

const FORM = "### Type\n\nfeat\n\n### Repos\n\napp\n\n### Priority\n\np1\n\n### Why\n\nx";

test("opened with form body adds missing labels, creates Jira with jiraLabels, writes marker, sets status:todo", async () => {
  const hub = fakeGh({ issues: [issueOf({ body: FORM, labels: ["repo:app"] })] });
  const jira = fakeJira();
  const report = await runIssueEvent(deps(hub, null, jira), ev("opened"));
  assert.deepEqual(report.errors, []);
  assert.ok(hub.calls.includes("addLabels 7 type:feat,priority:p1"), "only the missing form labels are added");
  assert.deepEqual(jira.creates[0]?.labels, ["gh-7", "repo-app"]);
  assert.equal(jira.creates[0]?.issueType, "Story");
  assert.match(hub.issues.get(7)?.body ?? "", /<!-- jira:ACME-100 -->$/);
  assert.ok(hub.calls.includes("addLabels 7 status:todo"));
  assert.deepEqual(jira.transitions, ["ACME-100 To Do"]);
  assert.equal(jira.updates.length, 0, "fresh create is not immediately updated");
});

test("a new Jira issue joins the active sprint", async () => {
  const hub = fakeGh({ issues: [issueOf({ body: FORM, labels: ["repo:app"] })] });
  const jira = fakeJira();
  const report = await runIssueEvent(deps(hub, null, jira), ev("opened"));
  assert.deepEqual(jira.sprinted, ["ACME-100"]);
  assert.ok(report.lines.includes("jira: ACME-100 added to sprint ACME Sprint 1"));
});

test("with no active sprint a new issue stays in the backlog", async () => {
  const hub = fakeGh({ issues: [issueOf({ body: FORM, labels: ["repo:app"] })] });
  const report = await runIssueEvent(deps(hub, null, fakeJira({ sprint: null })), ev("opened"));
  assert.deepEqual(report.errors, []);
  assert.ok(report.lines.includes("jira: no active sprint; left in backlog"));
});

test("a failing sprint add is a warning; the marker and status still land", async () => {
  const hub = fakeGh({ issues: [issueOf({ body: FORM, labels: ["repo:app"] })] });
  const jira = fakeJira({ sprintThrows: true });
  const report = await runIssueEvent(deps(hub, null, jira), ev("opened"));
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((w) => /^jira sprint: ACME-100 left in backlog: .*403/.test(w)));
  assert.match(hub.issues.get(7)?.body ?? "", /<!-- jira:ACME-100 -->$/);
  assert.deepEqual(jira.transitions, ["ACME-100 To Do"]);
});

test("an existing Jira issue is never re-added to a sprint", async () => {
  const hub = fakeGh({ issues: [issueOf({ body: "x\n\n<!-- jira:ACME-5 -->" })] });
  const jira = fakeJira({ keys: { "ACME-5": 7 } });
  await runIssueEvent(deps(hub, null, jira), ev("edited"));
  assert.deepEqual(jira.sprinted, []);
});

test("a foreign marker is ignored with a warning", async () => {
  const hub = fakeGh({ issues: [issueOf({ body: "x\n\n<!-- jira:ACME-9 -->" })] });
  const jira = fakeJira({ keys: { "ACME-9": 99 } });
  const report = await runIssueEvent(deps(hub, null, jira), ev("edited"));
  assert.ok(report.warnings.includes("marker ACME-9 does not belong to #7; ignored"));
  assert.equal(jira.creates.length, 1);
  assert.match(hub.issues.get(7)?.body ?? "", /<!-- jira:ACME-100 -->/);
  assert.doesNotMatch(hub.issues.get(7)?.body ?? "", /ACME-9/);
});

test("Jira create throwing still applies labels and records one error", async () => {
  const hub = fakeGh({ issues: [issueOf()] });
  const jira = fakeJira({ createThrows: true });
  const report = await runIssueEvent(deps(hub, null, jira), ev("opened"));
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0] ?? "", /^jira: .*boom/);
  assert.ok(hub.calls.includes("addLabels 7 status:todo"));
  assert.deepEqual(jira.transitions, []);
});

const ASSIGNED = issueOf({
  body: "<!-- jira:ACME-5 -->",
  labels: ["status:todo", "repo:app", "type:fix"],
  assignees: ["ana"],
  history: { ...NO_HISTORY, labelAdded: { "status:todo": 0 }, lastAssigned: 1 },
});

test("assigned with repo:app creates the linked branch and upserts one comment", async () => {
  const hub = fakeGh({ issues: [ASSIGNED] });
  const bot = fakeGh({ issues: [ASSIGNED] });
  const report = await runIssueEvent(deps(hub, bot, fakeJira({ keys: { "ACME-5": 7 } })), ev("assigned"));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(bot.calls, [
    "setProjectStatus 3 In Progress",
    "createLinkedBranch acme-app fix/ACME-5-add-cart",
  ]);
  assert.equal(hub.calls.filter((c) => c.startsWith("upsertComment")).length, 1);
  assert.ok(hub.calls.includes(`upsertComment 7 ${MARKERS.branchesComment}`));
  assert.match(hub.comments.get(MARKERS.branchesComment) ?? "", /`acme-app`: `fix\/ACME-5-add-cart` \(created\)/);
});

test("an existing linked branch is reused, not recreated", async () => {
  const hub = fakeGh({ issues: [ASSIGNED] });
  const bot = fakeGh({ issues: [ASSIGNED], linked: [{ repo: "acme-app", branch: "fix/ACME-5-old-title" }] });
  const report = await runIssueEvent(deps(hub, bot, fakeJira({ keys: { "ACME-5": 7 } })), ev("assigned"));
  assert.deepEqual(report.errors, []);
  assert.ok(!bot.calls.some((c) => c.startsWith("createLinkedBranch")));
  const comment = hub.comments.get(MARKERS.branchesComment) ?? "";
  assert.match(comment, /`fix\/ACME-5-old-title`/);
  assert.doesNotMatch(comment, /\(created\)/);
});

test("an existing branch with the computed name is reused", async () => {
  const hub = fakeGh({ issues: [ASSIGNED] });
  const bot = fakeGh({ issues: [ASSIGNED], branches: ["acme-app:fix/ACME-5-add-cart"] });
  await runIssueEvent(deps(hub, bot, fakeJira({ keys: { "ACME-5": 7 } })), ev("assigned"));
  assert.ok(!bot.calls.some((c) => c.startsWith("createLinkedBranch")));
});

test("update sends jiraLabels", async () => {
  const hub = fakeGh({ issues: [ASSIGNED] });
  const jira = fakeJira({ keys: { "ACME-5": 7 } });
  await runIssueEvent(deps(hub, null, jira), ev("edited"));
  assert.equal(jira.updates[0]?.key, "ACME-5");
  assert.deepEqual(jira.updates[0]?.fields.labels, ["gh-7", "repo-app"]);
});

test("labeled status:done closes the issue and drops the old status label", async () => {
  const done = issueOf({
    body: "<!-- jira:ACME-5 -->",
    labels: ["status:in-progress", "status:done"],
    assignees: ["ana"],
    history: { ...NO_HISTORY, labelAdded: { "status:in-progress": 1, "status:done": 3 } },
  });
  const hub = fakeGh({ issues: [done] });
  const jira = fakeJira({ keys: { "ACME-5": 7 } });
  const report = await runIssueEvent(deps(hub, null, jira), ev("labeled", 7, "status:done"));
  assert.deepEqual(report.errors, []);
  assert.ok(hub.calls.includes("closeIssue 7"));
  assert.ok(hub.calls.includes("removeLabel 7 status:in-progress"));
  assert.deepEqual(jira.transitions, ["ACME-5 Done"]);
});

test("Jira transition not-found is a warning naming the status", async () => {
  const hub = fakeGh({ issues: [ASSIGNED] });
  const report = await runIssueEvent(deps(hub, null, fakeJira({ keys: { "ACME-5": 7 }, transition: "not-found" })), ev("edited"));
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.includes('Jira has no transition to "In Progress" for ACME-5; add that status to the ACME board'));
});

test("missing bot and jira produce warnings, not errors", async () => {
  const hub = fakeGh({ issues: [ASSIGNED] });
  const report = await runIssueEvent(deps(hub, null, null), ev("assigned"));
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((w) => w.includes("Jira skipped")));
  assert.ok(report.warnings.some((w) => w.includes("board sync skipped")));
  assert.ok(report.warnings.some((w) => w.includes("branches skipped")));
  assert.ok(hub.calls.includes("addLabels 7 status:in-progress"));
});

test("missing project number warns and skips the board", async () => {
  const hub = fakeGh({ issues: [issueOf()] });
  const bot = fakeGh({ issues: [issueOf()] });
  const report = await runIssueEvent(deps(hub, bot, null, null), ev("edited"));
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((w) => w.includes("KB_PROJECT_NUMBER")));
  assert.deepEqual(bot.calls, []);
});

test("pull request issues are skipped and malformed payloads error once", async () => {
  const hub = fakeGh({ issues: [] });
  const skipped = await runIssueEvent(deps(hub, null, null), { action: "opened", issue: { number: 1, pull_request: {} } });
  assert.deepEqual(skipped.lines, ["skipped: pull request"]);
  const bad = await runIssueEvent(deps(hub, null, null), { nope: true });
  assert.equal(bad.errors.length, 1);
  const unknown = await runIssueEvent(deps(hub, null, null), ev("transferred"));
  assert.equal(unknown.warnings.length, 1);
});

function prState(over: Partial<PrState>): PrState {
  return {
    state: "closed",
    draft: false,
    merged: true,
    headRef: "feat/ACME-12-x",
    baseRef: "main",
    defaultBranch: "main",
    title: "ACME-12: x",
    htmlUrl: "https://github.com/acme/acme-app/pull/4",
    ...over,
  };
}

const prEvent = (action: string): unknown => ({ action, pull_request: { number: 4 }, repository: { name: "acme-app" } });
const PR_MARKER = "<!-- ticket-sync:pr:acme-app#4 -->";

test("PR merged into default on a single-repo ticket closes and upserts the PR marker comment", async () => {
  const hubIssue = issueOf({ labels: ["status:in-review", "repo:app"] });
  const hub = fakeGh({ issues: [hubIssue] });
  const bot = fakeGh({ issues: [hubIssue], prs: { "acme-app#4": prState({}) } });
  const report = await runPullRequestEvent(deps(hub, bot, fakeJira({ keys: { "ACME-12": 7 } })), prEvent("closed"));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(bot.calls, [`upsertComment 7 ${PR_MARKER}`, "closeIssue 7"]);
  assert.equal(bot.comments.get(PR_MARKER), `${PR_MARKER}\nMerged in https://github.com/acme/acme-app/pull/4`);
});

test("PR merged on a multi-repo ticket only comments", async () => {
  const hubIssue = issueOf({ labels: ["status:in-review", "repo:app", "repo:web"] });
  const bot = fakeGh({ issues: [hubIssue], prs: { "acme-app#4": prState({}) } });
  await runPullRequestEvent(deps(fakeGh({ issues: [hubIssue] }), bot, fakeJira({ keys: { "ACME-12": 7 } })), prEvent("closed"));
  assert.deepEqual(bot.calls, [`upsertComment 7 ${PR_MARKER}`]);
  assert.match(bot.comments.get(PR_MARKER) ?? "", /spans several repos/);
});

test("PR merged into a non-default base changes nothing", async () => {
  const hubIssue = issueOf({ labels: ["status:in-review", "repo:app"] });
  const bot = fakeGh({
    issues: [hubIssue],
    prs: { "acme-app#4": prState({ baseRef: "feat/ACME-12-part1" }) },
  });
  const report = await runPullRequestEvent(deps(fakeGh({ issues: [hubIssue] }), bot, fakeJira({ keys: { "ACME-12": 7 } })), prEvent("closed"));
  assert.deepEqual(bot.calls, []);
  assert.deepEqual(report.lines, ["merged into feat/ACME-12-part1, not the default branch; no change"]);
});

test("PR converted to draft on a [in-progress, in-review] issue adds/removes per statusLabelDiff", async () => {
  const hubIssue = issueOf({ labels: ["status:in-progress", "status:in-review"] });
  const bot = fakeGh({
    issues: [hubIssue],
    prs: { "acme-app#4": prState({ state: "open", draft: true, merged: false }) },
  });
  const report = await runPullRequestEvent(deps(fakeGh({ issues: [hubIssue] }), bot, fakeJira({ keys: { "ACME-12": 7 } })), prEvent("converted_to_draft"));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(bot.calls, ["removeLabel 7 status:in-review"]);
});

test("PR already at the target status reports already, and missing credentials error", async () => {
  const hubIssue = issueOf({ labels: ["status:in-review"] });
  const bot = fakeGh({ issues: [hubIssue], prs: { "acme-app#4": prState({ state: "open", merged: false }) } });
  const same = await runPullRequestEvent(deps(fakeGh({ issues: [hubIssue] }), bot, fakeJira({ keys: { "ACME-12": 7 } })), prEvent("opened"));
  assert.deepEqual(same.lines, ["already in-review"]);
  const none = await runPullRequestEvent(deps(fakeGh({ issues: [] }), null, null), prEvent("opened"));
  assert.deepEqual(none.errors, ["pr sync needs KB_BOT_TOKEN and Jira credentials"]);
  const ignored = await runPullRequestEvent(deps(fakeGh({ issues: [] }), null, null), prEvent("labeled"));
  assert.deepEqual(ignored.lines, ["ignored"]);
});
