import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike } from "./config.ts";
import { createGitHub } from "./github.ts";
import type { GitHubClient, RepoRef } from "./github.ts";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface Reply {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
}

/** `url` matches REST calls (suffix of the full URL); `query` matches GraphQL calls (substring of the query). */
interface Route {
  readonly method: string;
  readonly url?: string;
  readonly query?: string;
  readonly reply: Reply | ((call: Call) => Reply);
}

const API = "https://api.github.com";

function bodyRecord(call: Call): Record<string, unknown> {
  assert.ok(typeof call.body === "object" && call.body !== null, "body is an object");
  return call.body as Record<string, unknown>;
}

function setup(routes: readonly Route[]): { gh: GitHubClient; calls: Call[] } {
  const calls: Call[] = [];
  const fake: FetchLike = async (input, init) => {
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? "GET",
      url: input,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    };
    calls.push(call);
    const query = isQuery(call.body) ? call.body.query : null;
    const route = routes.find(
      (r) =>
        r.method === call.method &&
        (r.url === undefined || call.url === `${API}${r.url}`) &&
        (r.query === undefined || (query !== null && query.includes(r.query))),
    );
    if (route === undefined) throw new Error(`unexpected request ${call.method} ${call.url} ${query ?? ""}`);
    const reply = typeof route.reply === "function" ? route.reply(call) : route.reply;
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return new Response(text === "" ? null : text, { status: reply.status ?? 200 });
  };
  return { gh: createGitHub("tok", "acme", fake), calls };
}

function isQuery(body: unknown): body is { query: string } {
  return typeof body === "object" && body !== null && typeof (body as { query?: unknown }).query === "string";
}

function gql(data: unknown): Reply {
  return { json: { data } };
}

const ISSUE_JSON = {
  number: 7,
  node_id: "I_kwDO7",
  title: "Add cart",
  body: null,
  state: "open",
  labels: [{ name: "status:todo" }, { name: "repo:app" }, "type:fix"],
  assignees: [{ login: "ana" }],
  html_url: "https://github.com/acme/acme-kb/issues/7",
};

test("getIssue maps REST JSON and sends the pinned headers", async () => {
  const { gh, calls } = setup([
    { method: "GET", url: "/repos/acme/acme-kb/issues/7", reply: { json: ISSUE_JSON } },
    { method: "GET", url: "/repos/acme/acme-kb/issues/7/events?per_page=100&page=1", reply: { json: [] } },
  ]);
  const issue = await gh.getIssue("acme-kb", 7);
  assert.deepEqual(issue, {
    number: 7,
    nodeId: "I_kwDO7",
    title: "Add cart",
    body: "",
    state: "open",
    labels: ["status:todo", "repo:app", "type:fix"],
    assignees: ["ana"],
    htmlUrl: "https://github.com/acme/acme-kb/issues/7",
    history: { labelAdded: {}, lastAssigned: -1, lastUnassigned: -1, lastReopened: -1 },
  });
  const h = calls[0]?.headers;
  assert.equal(h?.["Authorization"], "Bearer tok");
  assert.equal(h?.["Accept"], "application/vnd.github+json");
  assert.equal(h?.["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(h?.["User-Agent"], "acme-ticket-sync");
});

test("getIssue folds paginated, unordered events into history, same-second tie counts assignment as later", async () => {
  const filler = Array.from({ length: 100 }, (_, i) => ({
    id: 1000 + i,
    event: "subscribed",
    created_at: "2026-01-01T00:00:00Z",
  }));
  const page2 = [
    // same second as the label below, lower id: tie rule still puts labeled first
    { id: 2, event: "assigned", created_at: "2026-01-02T00:00:00Z" },
    { id: 9, event: "labeled", created_at: "2026-01-02T00:00:00Z", label: { name: "status:todo" } },
    { id: 5, event: "labeled", created_at: "2026-01-03T00:00:00Z", label: { name: "status:todo" } },
    { id: 6, event: "unlabeled", created_at: "2026-01-04T00:00:00Z", label: { name: "status:todo" } },
    { id: 7, event: "unassigned", created_at: "2026-01-05T00:00:00Z" },
    { id: 8, event: "reopened", created_at: "2026-01-06T00:00:00Z" },
  ];
  const { gh, calls } = setup([
    { method: "GET", url: "/repos/acme/acme-kb/issues/7", reply: { json: ISSUE_JSON } },
    { method: "GET", url: "/repos/acme/acme-kb/issues/7/events?per_page=100&page=1", reply: { json: filler } },
    { method: "GET", url: "/repos/acme/acme-kb/issues/7/events?per_page=100&page=2", reply: { json: page2 } },
  ]);
  const { history } = await gh.getIssue("acme-kb", 7);
  // sorted: 100 fillers (0..99), labeled@2nd(100), assigned(101), labeled@3rd(102), unlabeled(103), unassigned(104), reopened(105)
  assert.equal(history.labelAdded["status:todo"], 102);
  assert.equal(history.lastAssigned, 101);
  assert.equal(history.lastUnassigned, 104);
  assert.equal(history.lastReopened, 105);
  assert.equal(calls.length, 3);
});

test("getIssue tie rule: label and assignment in the same second, assignment is later", async () => {
  const { gh } = setup([
    { method: "GET", url: "/repos/acme/acme-kb/issues/7", reply: { json: ISSUE_JSON } },
    {
      method: "GET",
      url: "/repos/acme/acme-kb/issues/7/events?per_page=100&page=1",
      reply: {
        json: [
          { id: 1, event: "assigned", created_at: "2026-01-02T00:00:00Z" },
          { id: 2, event: "labeled", created_at: "2026-01-02T00:00:00Z", label: { name: "status:todo" } },
        ],
      },
    },
  ]);
  const { history } = await gh.getIssue("acme-kb", 7);
  assert.equal(history.labelAdded["status:todo"], 0);
  assert.equal(history.lastAssigned, 1);
});

test("addLabels, updateBody, closeIssue send the pinned requests", async () => {
  const { gh, calls } = setup([
    { method: "POST", url: "/repos/acme/acme-kb/issues/7/labels", reply: { json: [] } },
    { method: "PATCH", url: "/repos/acme/acme-kb/issues/7", reply: { json: {} } },
  ]);
  await gh.addLabels("acme-kb", 7, ["status:done"]);
  await gh.updateBody("acme-kb", 7, "new body");
  await gh.closeIssue("acme-kb", 7);
  assert.deepEqual(bodyRecord(calls[0] as Call), { labels: ["status:done"] });
  assert.deepEqual(bodyRecord(calls[1] as Call), { body: "new body" });
  assert.deepEqual(bodyRecord(calls[2] as Call), { state: "closed", state_reason: "completed" });
  assert.equal((calls[1] as Call).headers["Content-Type"], "application/json");
});

test("removeLabel treats 404 as success and encodes the label", async () => {
  const { gh, calls } = setup([
    { method: "DELETE", url: "/repos/acme/acme-kb/issues/7/labels/status%3Atodo", reply: { status: 404, json: { message: "Label does not exist" } } },
  ]);
  await gh.removeLabel("acme-kb", 7, "status:todo");
  assert.equal(calls.length, 1);
});

test("other non-2xx throws with method, path, status and message", async () => {
  const { gh } = setup([
    { method: "DELETE", url: "/repos/acme/acme-kb/issues/7/labels/x", reply: { status: 403, json: { message: "Forbidden thing" } } },
  ]);
  await assert.rejects(
    gh.removeLabel("acme-kb", 7, "x"),
    new Error("DELETE /repos/acme/acme-kb/issues/7/labels/x -> 403: Forbidden thing"),
  );
});

test("branchExists: 200 -> true, 404 -> false, slashes kept in the ref path", async () => {
  const { gh, calls } = setup([
    { method: "GET", url: "/repos/acme/acme-app/git/ref/heads/fix/ACME-1-a", reply: { json: { ref: "refs/heads/fix/ACME-1-a" } } },
    { method: "GET", url: "/repos/acme/acme-app/git/ref/heads/fix/ACME-2-b", reply: { status: 404, json: { message: "Not Found" } } },
  ]);
  assert.equal(await gh.branchExists("acme-app", "fix/ACME-1-a"), true);
  assert.equal(await gh.branchExists("acme-app", "fix/ACME-2-b"), false);
  assert.equal(calls.length, 2);
});

const MARK = "<!-- ticket-sync:branches -->";

function commentsPage1(): unknown[] {
  return Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `chatter ${i}` }));
}

test("upsertComment edits a matching comment found on page 2", async () => {
  const { gh, calls } = setup([
    { method: "GET", url: "/repos/acme/acme-kb/issues/7/comments?per_page=100&page=1", reply: { json: commentsPage1() } },
    {
      method: "GET",
      url: "/repos/acme/acme-kb/issues/7/comments?per_page=100&page=2",
      reply: { json: [{ id: 555, body: `${MARK}\nold` }] },
    },
    { method: "PATCH", url: "/repos/acme/acme-kb/issues/comments/555", reply: { json: {} } },
  ]);
  await gh.upsertComment("acme-kb", 7, MARK, `${MARK}\nnew`);
  const patch = calls.at(-1) as Call;
  assert.equal(patch.method, "PATCH");
  assert.deepEqual(bodyRecord(patch), { body: `${MARK}\nnew` });
});

test("upsertComment skips an identical body", async () => {
  const { gh, calls } = setup([
    {
      method: "GET",
      url: "/repos/acme/acme-kb/issues/7/comments?per_page=100&page=1",
      reply: { json: [{ id: 5, body: `${MARK}\nsame` }] },
    },
  ]);
  await gh.upsertComment("acme-kb", 7, MARK, `${MARK}\nsame`);
  assert.equal(calls.length, 1);
});

test("upsertComment creates a comment when none matches", async () => {
  const { gh, calls } = setup([
    { method: "GET", url: "/repos/acme/acme-kb/issues/7/comments?per_page=100&page=1", reply: { json: [{ id: 1, body: "hi" }] } },
    { method: "POST", url: "/repos/acme/acme-kb/issues/7/comments", reply: { json: {} } },
  ]);
  await gh.upsertComment("acme-kb", 7, MARK, `${MARK}\nfresh`);
  const post = calls.at(-1) as Call;
  assert.equal(post.method, "POST");
  assert.deepEqual(bodyRecord(post), { body: `${MARK}\nfresh` });
});

test("GraphQL errors on HTTP 200 throw with the joined messages", async () => {
  const { gh } = setup([
    {
      method: "POST",
      url: "/graphql",
      reply: { json: { data: null, errors: [{ message: "first" }, { message: "second" }] } },
    },
  ]);
  await assert.rejects(gh.getRepo("acme-app"), new Error("POST /graphql -> 200: first; second"));
});

const REPO: RepoRef = { id: "R_1", name: "acme-app", defaultBranch: "main", headOid: "abc123" };

test("getRepo maps id, default branch and head oid", async () => {
  const { gh, calls } = setup([
    {
      method: "POST",
      url: "/graphql",
      reply: gql({ repository: { id: "R_1", defaultBranchRef: { name: "main", target: { oid: "abc123" } } } }),
    },
  ]);
  assert.deepEqual(await gh.getRepo("acme-app"), REPO);
  assert.deepEqual((bodyRecord(calls[0] as Call)["variables"]), { owner: "acme", name: "acme-app" });
});

test("linkedBranches maps nodes to repo + branch", async () => {
  const { gh } = setup([
    {
      method: "POST",
      url: "/graphql",
      reply: gql({
        node: {
          linkedBranches: {
            nodes: [{ ref: { name: "fix/ACME-1-a", repository: { name: "acme-app" } } }, { ref: null }],
          },
        },
      }),
    },
  ]);
  assert.deepEqual(await gh.linkedBranches("I_1"), [{ repo: "acme-app", branch: "fix/ACME-1-a" }]);
});

test("createLinkedBranch sends issue, repo, oid and name", async () => {
  const { gh, calls } = setup([
    { method: "POST", query: "createLinkedBranch(input", reply: gql({ createLinkedBranch: { linkedBranch: { id: "LB_1", ref: { name: "fix/ACME-1-a" } } } }) },
  ]);
  await gh.createLinkedBranch("I_1", REPO, "fix/ACME-1-a");
  assert.deepEqual(bodyRecord(calls[0] as Call)["variables"], {
    issueId: "I_1",
    repositoryId: "R_1",
    oid: "abc123",
    name: "fix/ACME-1-a",
  });
});

test("createLinkedBranch throws when linkedBranch is null", async () => {
  const { gh } = setup([
    { method: "POST", url: "/graphql", reply: gql({ createLinkedBranch: { linkedBranch: null } }) },
  ]);
  await assert.rejects(gh.createLinkedBranch("I_1", REPO, "fix/ACME-1-a"), /no linkedBranch/);
});

const PROJECT = {
  organization: {
    projectV2: {
      id: "P_1",
      field: { id: "F_1", options: [{ id: "O_todo", name: "To Do" }, { id: "O_prog", name: "In Progress" }] },
    },
  },
};

function projectRoutes(items: unknown, extra: readonly Route[] = []): Route[] {
  return [
    { method: "POST", query: "projectV2(number", reply: gql(PROJECT) },
    { method: "POST", query: "projectItems", reply: gql({ node: { projectItems: { nodes: items } } }) },
    ...extra,
  ];
}

function queriesOf(calls: readonly Call[]): string[] {
  return calls.map((c) => (isQuery(c.body) ? c.body.query : ""));
}

test("setProjectStatus adds a missing item and sends the matching option id", async () => {
  const { gh, calls } = setup(
    projectRoutes([{ id: "PVTI_other", project: { id: "P_other" } }], [
      { method: "POST", query: "addProjectV2ItemById", reply: gql({ addProjectV2ItemById: { item: { id: "PVTI_new" } } }) },
      { method: "POST", query: "updateProjectV2ItemFieldValue", reply: gql({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } } }) },
    ]),
  );
  await gh.setProjectStatus(3, "I_1", "In Progress");
  const qs = queriesOf(calls);
  assert.ok(qs.some((q) => q.includes("addProjectV2ItemById")));
  assert.deepEqual(bodyRecord(calls.at(-1) as Call)["variables"], {
    projectId: "P_1",
    itemId: "PVTI_new",
    fieldId: "F_1",
    optionId: "O_prog",
  });
  assert.deepEqual(bodyRecord(calls[0] as Call)["variables"], { owner: "acme", number: 3 });
});

test("setProjectStatus reuses an existing item without adding", async () => {
  const { gh, calls } = setup(
    projectRoutes([{ id: "PVTI_mine", project: { id: "P_1" } }], [
      { method: "POST", query: "updateProjectV2ItemFieldValue", reply: gql({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_mine" } } }) },
    ]),
  );
  await gh.setProjectStatus(3, "I_1", "To Do");
  assert.ok(!queriesOf(calls).some((q) => q.includes("addProjectV2ItemById")));
  assert.deepEqual(bodyRecord(calls.at(-1) as Call)["variables"], {
    projectId: "P_1",
    itemId: "PVTI_mine",
    fieldId: "F_1",
    optionId: "O_todo",
  });
});

test("setProjectStatus throws when the option or the field is missing", async () => {
  const { gh } = setup(projectRoutes([]));
  await assert.rejects(gh.setProjectStatus(3, "I_1", "Nope"), /option "Nope" not found/);

  const noField = setup([
    { method: "POST", query: "projectV2(number", reply: gql({ organization: { projectV2: { id: "P_1", field: null } } }) },
  ]);
  await assert.rejects(noField.gh.setProjectStatus(3, "I_1", "To Do"), /no single-select "Status" field/);
});

test("getPullRequest maps draft, merged, base and the default branch", async () => {
  const { gh } = setup([
    {
      method: "GET",
      url: "/repos/acme/acme-app/pulls/4",
      reply: {
        json: {
          state: "closed",
          draft: false,
          merged: true,
          title: "ACME-7: add cart",
          html_url: "https://github.com/acme/acme-app/pull/4",
          head: { ref: "feat/ACME-7-add-cart" },
          base: { ref: "main", repo: { default_branch: "master" } },
        },
      },
    },
  ]);
  assert.deepEqual(await gh.getPullRequest("acme-app", 4), {
    state: "closed",
    draft: false,
    merged: true,
    headRef: "feat/ACME-7-add-cart",
    baseRef: "main",
    defaultBranch: "master",
    title: "ACME-7: add cart",
    htmlUrl: "https://github.com/acme/acme-app/pull/4",
  });
});
