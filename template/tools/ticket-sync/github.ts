import type { FetchLike } from "./config.ts";
import type { IssueHistory, LinkedBranch, LiveIssue, PrState } from "./core.ts";

export interface RepoRef {
  readonly id: string; // GraphQL node id
  readonly name: string;
  readonly defaultBranch: string;
  readonly headOid: string; // sha of default branch head
}

export interface GitHubClient {
  /** REST issue + paginated events (per_page=100) folded into IssueHistory */
  getIssue(repo: string, issueNumber: number): Promise<LiveIssue>;
  addLabels(repo: string, issueNumber: number, labels: readonly string[]): Promise<void>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>; // 404 is success
  updateBody(repo: string, issueNumber: number, body: string): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>; // state_reason "completed"
  /** paginated (per_page=100); first comment whose body includes `marker` is edited (skipped if identical), else a comment is created */
  upsertComment(repo: string, issueNumber: number, marker: string, body: string): Promise<void>;
  getRepo(repo: string): Promise<RepoRef>;
  branchExists(repo: string, branch: string): Promise<boolean>; // REST git/ref/heads/<branch>, 404 -> false
  linkedBranches(issueNodeId: string): Promise<LinkedBranch[]>; // GraphQL Issue.linkedBranches(first: 50)
  /** GraphQL createLinkedBranch; throws if data.createLinkedBranch.linkedBranch is null */
  createLinkedBranch(issueNodeId: string, repo: RepoRef, branch: string): Promise<void>;
  /** org Project v2: find or add the issue's item, set single-select "Status" to `optionName`; throws if field or option is missing */
  setProjectStatus(projectNumber: number, issueNodeId: string, optionName: string): Promise<void>;
  getPullRequest(repo: string, prNumber: number): Promise<PrState>; // defaultBranch from base.repo.default_branch
}

const API = "https://api.github.com";
const PAGE = 100;
const EXCERPT_MAX = 300;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(value: unknown, what: string): Json {
  if (!isRecord(value)) throw new Error(`unexpected response: ${what} is not an object`);
  return value;
}

function arr(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`unexpected response: ${what} is not an array`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`unexpected response: ${what} is not a string`);
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number") throw new Error(`unexpected response: ${what} is not a number`);
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new Error(`unexpected response: ${what} is not a boolean`);
  return value;
}

function openClosed(value: unknown, what: string): "open" | "closed" {
  if (value !== "open" && value !== "closed") throw new Error(`unexpected response: ${what} is not open|closed`);
  return value;
}

function messageOf(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed["message"] === "string") return parsed["message"];
  } catch {
    // not JSON: fall through to the raw excerpt
  }
  return raw.slice(0, EXCERPT_MAX);
}

/** Events with the same timestamp: label changes sort before assign/reopen events. */
function tieGroup(event: string): number {
  return event === "labeled" || event === "unlabeled" ? 0 : 1;
}

interface RawEvent {
  readonly id: number;
  readonly event: string;
  readonly at: number;
  readonly label: string | null;
}

function toEvent(value: unknown): RawEvent {
  const e = rec(value, "event");
  const at = Date.parse(text(e["created_at"], "event.created_at"));
  if (Number.isNaN(at)) throw new Error("unexpected response: event.created_at is not a date");
  const label = isRecord(e["label"]) && typeof e["label"]["name"] === "string" ? e["label"]["name"] : null;
  return { id: num(e["id"], "event.id"), event: text(e["event"], "event.event"), at, label };
}

function foldHistory(events: readonly RawEvent[]): IssueHistory {
  const sorted = [...events].sort(
    (a, b) => a.at - b.at || tieGroup(a.event) - tieGroup(b.event) || a.id - b.id,
  );
  const labelAdded: Record<string, number> = {};
  const last = { assigned: -1, unassigned: -1, reopened: -1 };
  sorted.forEach((e, i) => {
    if (e.event === "labeled" && e.label !== null) labelAdded[e.label] = i;
    else if (e.event === "assigned") last.assigned = i;
    else if (e.event === "unassigned") last.unassigned = i;
    else if (e.event === "reopened") last.reopened = i;
  });
  return { labelAdded, lastAssigned: last.assigned, lastUnassigned: last.unassigned, lastReopened: last.reopened };
}

const Q_REPO = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id defaultBranchRef{name target{oid}}}}`;
const Q_LINKED = `query($id:ID!){node(id:$id){... on Issue{linkedBranches(first:50){nodes{ref{name repository{name}}}}}}}`;
const M_LINK = `mutation($issueId:ID!,$repositoryId:ID!,$oid:GitObjectID!,$name:String!){createLinkedBranch(input:{issueId:$issueId,repositoryId:$repositoryId,oid:$oid,name:$name}){linkedBranch{id ref{name}}}}`;
const Q_PROJECT = `query($owner:String!,$number:Int!){organization(login:$owner){projectV2(number:$number){id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`;
const Q_ITEMS = `query($id:ID!){node(id:$id){... on Issue{projectItems(first:50){nodes{id project{id}}}}}}`;
const M_ADD = `mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}`;
const M_SET = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){projectV2Item{id}}}`;

export function createGitHub(
  token: string,
  owner: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): GitHubClient {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "acme-ticket-sync",
  };

  async function send(method: string, path: string, body?: unknown, allow404 = false): Promise<{ status: number; json: unknown }> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.headers = { ...headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${API}${path}`, init);
    const raw = await res.text();
    if (res.status === 404 && allow404) return { status: 404, json: null };
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${messageOf(raw)}`);
    if (raw === "") return { status: res.status, json: null };
    try {
      return { status: res.status, json: JSON.parse(raw) as unknown };
    } catch {
      throw new Error(`${method} ${path} -> ${res.status}: invalid JSON: ${raw.slice(0, EXCERPT_MAX)}`);
    }
  }

  async function graphql(query: string, variables: Json): Promise<Json> {
    const { json } = await send("POST", "/graphql", { query, variables });
    const root = rec(json, "graphql response");
    if (Array.isArray(root["errors"]) && root["errors"].length > 0) {
      const messages = root["errors"].map((e: unknown) => (isRecord(e) && typeof e["message"] === "string" ? e["message"] : "unknown error"));
      throw new Error(`POST /graphql -> 200: ${messages.join("; ")}`);
    }
    return rec(root["data"], "graphql data");
  }

  async function pages(path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; ; page++) {
      const { json } = await send("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`);
      const items = arr(json, path);
      all.push(...items);
      if (items.length < PAGE) return all;
    }
  }

  const issuePath = (repo: string, n: number): string => `/repos/${owner}/${repo}/issues/${n}`;

  function labelName(value: unknown): string | null {
    if (typeof value === "string") return value;
    return isRecord(value) && typeof value["name"] === "string" ? value["name"] : null;
  }

  return {
    async getIssue(repo: string, issueNumber: number): Promise<LiveIssue> {
      const { json } = await send("GET", issuePath(repo, issueNumber));
      const issue = rec(json, "issue");
      const events = (await pages(`${issuePath(repo, issueNumber)}/events`)).map(toEvent);
      const labels = arr(issue["labels"], "issue.labels").flatMap((l) => labelName(l) ?? []);
      const assignees = arr(issue["assignees"], "issue.assignees").flatMap((a) =>
        isRecord(a) && typeof a["login"] === "string" ? a["login"] : [],
      );
      return {
        number: num(issue["number"], "issue.number"),
        nodeId: text(issue["node_id"], "issue.node_id"),
        title: text(issue["title"], "issue.title"),
        body: typeof issue["body"] === "string" ? issue["body"] : "",
        state: openClosed(issue["state"], "issue.state"),
        labels,
        assignees,
        htmlUrl: text(issue["html_url"], "issue.html_url"),
        history: foldHistory(events),
      };
    },

    async addLabels(repo: string, issueNumber: number, labels: readonly string[]): Promise<void> {
      await send("POST", `${issuePath(repo, issueNumber)}/labels`, { labels });
    },

    async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
      await send("DELETE", `${issuePath(repo, issueNumber)}/labels/${encodeURIComponent(label)}`, undefined, true);
    },

    async updateBody(repo: string, issueNumber: number, body: string): Promise<void> {
      await send("PATCH", issuePath(repo, issueNumber), { body });
    },

    async closeIssue(repo: string, issueNumber: number): Promise<void> {
      await send("PATCH", issuePath(repo, issueNumber), { state: "closed", state_reason: "completed" });
    },

    async upsertComment(repo: string, issueNumber: number, marker: string, body: string): Promise<void> {
      const comments = await pages(`${issuePath(repo, issueNumber)}/comments`);
      for (const c of comments) {
        const comment = rec(c, "comment");
        if (typeof comment["body"] !== "string" || !comment["body"].includes(marker)) continue;
        if (comment["body"] !== body) {
          await send("PATCH", `/repos/${owner}/${repo}/issues/comments/${num(comment["id"], "comment.id")}`, { body });
        }
        return;
      }
      await send("POST", `${issuePath(repo, issueNumber)}/comments`, { body });
    },

    async getRepo(repo: string): Promise<RepoRef> {
      const data = await graphql(Q_REPO, { owner, name: repo });
      const r = rec(data["repository"], `repository ${repo}`);
      const ref = rec(r["defaultBranchRef"], `${repo} defaultBranchRef`);
      const target = rec(ref["target"], `${repo} default branch target`);
      return {
        id: text(r["id"], "repository.id"),
        name: repo,
        defaultBranch: text(ref["name"], "defaultBranchRef.name"),
        headOid: text(target["oid"], "target.oid"),
      };
    },

    async branchExists(repo: string, branch: string): Promise<boolean> {
      const ref = branch.split("/").map(encodeURIComponent).join("/");
      const { status } = await send("GET", `/repos/${owner}/${repo}/git/ref/heads/${ref}`, undefined, true);
      return status !== 404;
    },

    async linkedBranches(issueNodeId: string): Promise<LinkedBranch[]> {
      const data = await graphql(Q_LINKED, { id: issueNodeId });
      const node = rec(data["node"], "issue node");
      const nodes = arr(rec(node["linkedBranches"], "linkedBranches")["nodes"], "linkedBranches.nodes");
      return nodes.flatMap((n): LinkedBranch[] => {
        const ref = isRecord(n) ? n["ref"] : null;
        if (!isRecord(ref) || typeof ref["name"] !== "string" || !isRecord(ref["repository"])) return [];
        const repoName = ref["repository"]["name"];
        return typeof repoName === "string" ? [{ repo: repoName, branch: ref["name"] }] : [];
      });
    },

    async createLinkedBranch(issueNodeId: string, repo: RepoRef, branch: string): Promise<void> {
      const data = await graphql(M_LINK, { issueId: issueNodeId, repositoryId: repo.id, oid: repo.headOid, name: branch });
      const payload = rec(data["createLinkedBranch"], "createLinkedBranch");
      if (!isRecord(payload["linkedBranch"])) {
        throw new Error(`createLinkedBranch returned no linkedBranch for ${repo.name}:${branch}`);
      }
    },

    async setProjectStatus(projectNumber: number, issueNodeId: string, optionName: string): Promise<void> {
      const data = await graphql(Q_PROJECT, { owner, number: projectNumber });
      const org = rec(data["organization"], `organization ${owner}`);
      const project = org["projectV2"];
      if (!isRecord(project)) throw new Error(`project #${projectNumber} not found in ${owner}`);
      const projectId = text(project["id"], "project.id");
      const field = project["field"];
      if (!isRecord(field) || typeof field["id"] !== "string") {
        throw new Error(`project #${projectNumber} has no single-select "Status" field`);
      }
      const option = arr(field["options"], "Status options")
        .filter(isRecord)
        .find((o) => o["name"] === optionName);
      if (option === undefined) throw new Error(`Status option "${optionName}" not found on project #${projectNumber}`);

      const items = await graphql(Q_ITEMS, { id: issueNodeId });
      const nodes = arr(rec(rec(items["node"], "issue node")["projectItems"], "projectItems")["nodes"], "projectItems.nodes");
      const existing = nodes.filter(isRecord).find((n) => isRecord(n["project"]) && n["project"]["id"] === projectId);
      const added = existing === undefined ? await graphql(M_ADD, { projectId, contentId: issueNodeId }) : null;
      const itemId =
        added === null
          ? text(existing?.["id"], "item.id")
          : text(rec(rec(added["addProjectV2ItemById"], "addProjectV2ItemById")["item"], "item")["id"], "item.id");
      await graphql(M_SET, { projectId, itemId, fieldId: field["id"], optionId: text(option["id"], "option.id") });
    },

    async getPullRequest(repo: string, prNumber: number): Promise<PrState> {
      const { json } = await send("GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
      const pr = rec(json, "pull request");
      return {
        state: openClosed(pr["state"], "pr.state"),
        draft: pr["draft"] === true,
        merged: bool(pr["merged"], "pr.merged"),
        headRef: text(rec(pr["head"], "pr.head")["ref"], "pr.head.ref"),
        baseRef: text(rec(pr["base"], "pr.base")["ref"], "pr.base.ref"),
        defaultBranch: text(rec(rec(pr["base"], "pr.base")["repo"], "pr.base.repo")["default_branch"], "default_branch"),
        title: text(pr["title"], "pr.title"),
        htmlUrl: text(pr["html_url"], "pr.html_url"),
      };
    },
  };
}
