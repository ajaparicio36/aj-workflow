import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike } from "./config.ts";
import { createJira } from "./jira.ts";
import type { JiraClient } from "./jira.ts";

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

const BASE = "https://example.atlassian.net";

function setup(replies: readonly Reply[]): { jira: JiraClient; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fake: FetchLike = async (input, init) => {
    const raw = init?.body;
    calls.push({
      method: init?.method ?? "GET",
      url: input,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request ${input}`);
    const text = next.text ?? (next.json === undefined ? "" : JSON.stringify(next.json));
    return new Response(text === "" ? null : text, { status: next.status ?? 200 });
  };
  const jira = createJira(
    { baseUrl: `${BASE}/`, email: "bot@acme.test", apiToken: "tok", projectKey: "ACME" },
    fake,
  );
  return { jira, calls };
}

function callAt(calls: readonly Call[], i: number): Call {
  const c = calls[i];
  assert.ok(c, `call ${i} missing`);
  return c;
}

test("sends Basic auth, Accept, and Content-Type only on bodies; tolerates trailing slash", async () => {
  const { jira, calls } = setup([{ json: { key: "ACME-1" } }, { status: 204 }]);
  await jira.create({ summary: "s", description: "d", labels: [], issueType: "Task" });
  await jira.update("ACME-1", { summary: "s", description: "d", labels: [] });
  const expected = `Basic ${Buffer.from("bot@acme.test:tok").toString("base64")}`;
  for (const c of calls) {
    assert.equal(c.headers["Authorization"], expected);
    assert.equal(c.headers["Accept"], "application/json");
    assert.equal(c.headers["Content-Type"], "application/json");
  }
  assert.equal(callAt(calls, 0).url, `${BASE}/rest/api/2/issue`);
});

test("GET requests carry no Content-Type", async () => {
  const { jira, calls } = setup([{ json: { issues: [] } }]);
  await jira.findKeyByGhNumber(5);
  assert.equal(callAt(calls, 0).headers["Content-Type"], undefined);
});

test("findKeyByGhNumber: search/jql path, jql and fields=key", async () => {
  const { jira, calls } = setup([{ json: { issues: [{ id: "10001", key: "ACME-12" }] } }]);
  assert.equal(await jira.findKeyByGhNumber(7), "ACME-12");
  const c = callAt(calls, 0);
  assert.equal(c.method, "GET");
  const jql = encodeURIComponent('project = "ACME" AND labels = "gh-7"');
  assert.equal(c.url, `${BASE}/rest/api/3/search/jql?jql=${jql}&fields=key&maxResults=1`);
});

test("findKeyByGhNumber: id-only result falls back to the issue GET", async () => {
  const { jira, calls } = setup([{ json: { issues: [{ id: "10001" }] } }, { json: { key: "ACME-3" } }]);
  assert.equal(await jira.findKeyByGhNumber(3), "ACME-3");
  assert.equal(callAt(calls, 1).method, "GET");
  assert.equal(callAt(calls, 1).url, `${BASE}/rest/api/2/issue/10001?fields=labels`);
});

test("findKeyByGhNumber: no issues -> null", async () => {
  const { jira } = setup([{ json: { issues: [] } }]);
  assert.equal(await jira.findKeyByGhNumber(1), null);
});

test("ghNumberForKey: gh-17 -> 17", async () => {
  const { jira, calls } = setup([{ json: { fields: { labels: ["repo-app", "gh-17"] } } }]);
  assert.equal(await jira.ghNumberForKey("ACME-9"), 17);
  assert.equal(callAt(calls, 0).url, `${BASE}/rest/api/2/issue/ACME-9?fields=labels`);
});

test("ghNumberForKey: no gh label -> null; 404 -> null", async () => {
  const none = setup([{ json: { fields: { labels: ["gh-x", "repo-app"] } } }]);
  assert.equal(await none.jira.ghNumberForKey("ACME-9"), null);
  const missing = setup([{ status: 404, text: "not found" }]);
  assert.equal(await missing.jira.ghNumberForKey("ACME-404"), null);
});

test("create: POST /rest/api/2/issue with pinned body, returns key", async () => {
  const { jira, calls } = setup([{ status: 201, json: { id: "1", key: "ACME-20" } }]);
  const key = await jira.create({ summary: "Sum", description: "Desc", labels: ["gh-4", "repo-app"], issueType: "Bug" });
  assert.equal(key, "ACME-20");
  const c = callAt(calls, 0);
  assert.equal(c.method, "POST");
  assert.deepEqual(c.body, {
    fields: {
      project: { key: "ACME" },
      summary: "Sum",
      description: "Desc",
      issuetype: { name: "Bug" },
      labels: ["gh-4", "repo-app"],
    },
  });
});

test("update: PUT /rest/api/2/issue/{key} replaces summary, description, labels", async () => {
  const { jira, calls } = setup([{ status: 204 }]);
  await jira.update("ACME-5", { summary: "S", description: "D", labels: ["gh-5"] });
  const c = callAt(calls, 0);
  assert.equal(c.method, "PUT");
  assert.equal(c.url, `${BASE}/rest/api/2/issue/ACME-5`);
  assert.deepEqual(c.body, { fields: { summary: "S", description: "D", labels: ["gh-5"] } });
});

test("transition: already (case-insensitive) makes no further calls", async () => {
  const { jira, calls } = setup([{ json: { fields: { status: { name: "in progress" } } } }]);
  assert.equal(await jira.transition("ACME-1", "In Progress"), "already");
  assert.equal(calls.length, 1);
  assert.equal(callAt(calls, 0).url, `${BASE}/rest/api/2/issue/ACME-1?fields=status`);
});

test("transition: not-found when no transition reaches the target", async () => {
  const { jira, calls } = setup([
    { json: { fields: { status: { name: "To Do" } } } },
    { json: { transitions: [{ id: "11", to: { name: "Done" } }] } },
  ]);
  assert.equal(await jira.transition("ACME-1", "In Review"), "not-found");
  assert.equal(calls.length, 2);
  assert.equal(callAt(calls, 1).url, `${BASE}/rest/api/2/issue/ACME-1/transitions`);
});

test("transition: transitioned posts the matching transition id", async () => {
  const { jira, calls } = setup([
    { json: { fields: { status: { name: "To Do" } } } },
    { json: { transitions: [{ id: "11", to: { name: "Done" } }, { id: "21", to: { name: "in review" } }] } },
    { status: 204 },
  ]);
  assert.equal(await jira.transition("ACME-1", "In Review"), "transitioned");
  const c = callAt(calls, 2);
  assert.equal(c.method, "POST");
  assert.equal(c.url, `${BASE}/rest/api/2/issue/ACME-1/transitions`);
  assert.deepEqual(c.body, { transition: { id: "21" } });
});

test("non-2xx throws METHOD path -> status: excerpt", async () => {
  const { jira } = setup([{ status: 403, text: "forbidden by policy" }]);
  await assert.rejects(
    jira.update("ACME-1", { summary: "s", description: "d", labels: [] }),
    { message: "PUT /rest/api/2/issue/ACME-1 -> 403: forbidden by policy" },
  );
});

test("non-404 error on ghNumberForKey still throws", async () => {
  const { jira } = setup([{ status: 500, text: "boom" }]);
  await assert.rejects(jira.ghNumberForKey("ACME-1"), /-> 500: boom/);
});

test("addToActiveSprint: finds the scrum board's active sprint and posts the issue", async () => {
  const { jira, calls } = setup([
    { json: { values: [{ id: 3 }, { id: 4 }] } },
    { json: { values: [] } },
    { json: { values: [{ id: 9, name: "ACME Sprint 1", state: "active" }] } },
    { status: 204 },
  ]);
  assert.equal(await jira.addToActiveSprint("ACME-7"), "ACME Sprint 1");
  assert.equal(callAt(calls, 0).url, `${BASE}/rest/agile/1.0/board?projectKeyOrId=ACME&type=scrum`);
  assert.equal(callAt(calls, 1).url, `${BASE}/rest/agile/1.0/board/3/sprint?state=active`);
  assert.equal(callAt(calls, 2).url, `${BASE}/rest/agile/1.0/board/4/sprint?state=active`);
  const post = callAt(calls, 3);
  assert.equal(post.method, "POST");
  assert.equal(post.url, `${BASE}/rest/agile/1.0/sprint/9/issue`);
  assert.deepEqual(post.body, { issues: ["ACME-7"] });
});

test("addToActiveSprint: null with no scrum board or no active sprint", async () => {
  const none = setup([{ json: { values: [] } }]);
  assert.equal(await none.jira.addToActiveSprint("ACME-7"), null);
  const idle = setup([{ json: { values: [{ id: 3 }] } }, { json: { values: [] } }]);
  assert.equal(await idle.jira.addToActiveSprint("ACME-7"), null);
  assert.equal(idle.calls.length, 2);
});
