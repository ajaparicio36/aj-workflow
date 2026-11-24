import type { FetchLike } from "./config.ts";

export interface JiraFields {
  readonly summary: string;
  readonly description: string;
  readonly labels: readonly string[];
}

export interface JiraCreate extends JiraFields {
  readonly issueType: string; // "Story" | "Bug" | "Task"
}

export type TransitionResult = "transitioned" | "already" | "not-found";

export interface JiraClient {
  findKeyByGhNumber(issueNumber: number): Promise<string | null>;
  ghNumberForKey(key: string): Promise<number | null>; // 404 -> null
  create(fields: JiraCreate): Promise<string>; // returns key
  update(key: string, fields: JiraFields): Promise<void>;
  transition(key: string, targetStatusName: string): Promise<TransitionResult>;
  /** Adds the issue to the project's active sprint; returns the sprint name, or null when none is active. */
  addToActiveSprint(key: string): Promise<string | null>;
}

export interface JiraEnv {
  readonly baseUrl: string; // trailing slash tolerated
  readonly email: string;
  readonly apiToken: string;
  readonly projectKey: string;
}

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

const EXCERPT_MAX = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function labelsOf(json: unknown): string[] {
  if (!isRecord(json) || !isRecord(json["fields"])) return [];
  const labels = json["fields"]["labels"];
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string") : [];
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function createJira(env: JiraEnv, fetchImpl: FetchLike = (input, init) => fetch(input, init)): JiraClient {
  const base = env.baseUrl.replace(/\/+$/, "");
  const auth = `Basic ${Buffer.from(`${env.email}:${env.apiToken}`).toString("base64")}`;

  async function send(method: string, path: string, body?: unknown, allow404 = false): Promise<Reply> {
    const headers: Record<string, string> = { Authorization: auth, Accept: "application/json" };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, init);
    const text = await res.text();
    if (res.status === 404 && allow404) return { status: 404, json: null };
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, EXCERPT_MAX)}`);
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path} -> ${res.status}: invalid JSON: ${text.slice(0, EXCERPT_MAX)}`);
      }
    }
    return { status: res.status, json };
  }

  const issuePath = (key: string): string => `/rest/api/2/issue/${encodeURIComponent(key)}`;

  return {
    async findKeyByGhNumber(issueNumber: number): Promise<string | null> {
      const jql = `project = "${env.projectKey}" AND labels = "gh-${issueNumber}"`;
      const { json } = await send(
        "GET",
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=1`,
      );
      const first = isRecord(json) && Array.isArray(json["issues"]) ? json["issues"][0] : undefined;
      if (!isRecord(first)) return null;
      const key = str(first["key"]);
      if (key !== null) return key;
      const id = str(first["id"]);
      if (id === null) return null;
      const issue = await send("GET", `${issuePath(id)}?fields=labels`);
      return isRecord(issue.json) ? str(issue.json["key"]) : null;
    },

    async ghNumberForKey(key: string): Promise<number | null> {
      const { status, json } = await send("GET", `${issuePath(key)}?fields=labels`, undefined, true);
      if (status === 404) return null;
      for (const label of labelsOf(json)) {
        const m = /^gh-(\d+)$/.exec(label);
        if (m?.[1] !== undefined) return Number(m[1]);
      }
      return null;
    },

    async create(fields: JiraCreate): Promise<string> {
      const { json } = await send("POST", "/rest/api/2/issue", {
        fields: {
          project: { key: env.projectKey },
          summary: fields.summary,
          description: fields.description,
          issuetype: { name: fields.issueType },
          labels: fields.labels,
        },
      });
      const key = isRecord(json) ? str(json["key"]) : null;
      if (key === null) throw new Error("POST /rest/api/2/issue -> response has no key");
      return key;
    },

    async update(key: string, fields: JiraFields): Promise<void> {
      await send("PUT", issuePath(key), {
        fields: { summary: fields.summary, description: fields.description, labels: fields.labels },
      });
    },

    async transition(key: string, targetStatusName: string): Promise<TransitionResult> {
      const current = await send("GET", `${issuePath(key)}?fields=status`);
      const fieldsJson = isRecord(current.json) ? current.json["fields"] : null;
      const status = isRecord(fieldsJson) ? fieldsJson["status"] : null;
      const currentName = isRecord(status) ? str(status["name"]) : null;
      if (currentName !== null && sameName(currentName, targetStatusName)) return "already";

      const list = await send("GET", `${issuePath(key)}/transitions`);
      const transitions = isRecord(list.json) && Array.isArray(list.json["transitions"]) ? list.json["transitions"] : [];
      for (const t of transitions) {
        if (!isRecord(t) || !isRecord(t["to"])) continue;
        const toName = str(t["to"]["name"]);
        const id = str(t["id"]);
        if (toName === null || id === null || !sameName(toName, targetStatusName)) continue;
        await send("POST", `${issuePath(key)}/transitions`, { transition: { id } });
        return "transitioned";
      }
      return "not-found";
    },

    async addToActiveSprint(key: string): Promise<string | null> {
      const boards = await send(
        "GET",
        `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(env.projectKey)}&type=scrum`,
      );
      for (const board of valuesOf(boards.json)) {
        const boardId = isRecord(board) ? board["id"] : null;
        if (typeof boardId !== "number") continue;
        const sprints = await send("GET", `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
        const sprint = valuesOf(sprints.json)[0];
        const sprintId = isRecord(sprint) ? sprint["id"] : null;
        if (typeof sprintId !== "number" || !isRecord(sprint)) continue;
        await send("POST", `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: [key] });
        return str(sprint["name"]) ?? String(sprintId);
      }
      return null;
    },
  };
}

function valuesOf(json: unknown): unknown[] {
  return isRecord(json) && Array.isArray(json["values"]) ? json["values"] : [];
}
