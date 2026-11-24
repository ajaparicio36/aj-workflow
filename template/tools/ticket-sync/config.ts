import { readFileSync } from "node:fs";

export const STATUSES = ["todo", "in-progress", "in-review", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface StatusMeta {
  readonly label: `status:${Status}`;
  readonly jira: string;
  readonly board: string;
}

export const STATUS_META = {
  todo: { label: "status:todo", jira: "To Do", board: "To Do" },
  "in-progress": { label: "status:in-progress", jira: "In Progress", board: "In Progress" },
  "in-review": { label: "status:in-review", jira: "In Review", board: "In Review" },
  done: { label: "status:done", jira: "Done", board: "Done" },
} as const satisfies Record<Status, StatusMeta>;

export const TICKET_TYPES = ["feat", "fix", "chore", "refactor", "docs", "design"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const JIRA_TYPE = {
  feat: "Story",
  fix: "Bug",
  chore: "Task",
  refactor: "Task",
  docs: "Task",
  design: "Task",
} as const satisfies Record<TicketType, string>;

/** A `repo:<key>` label; keys come from `repos` in workflow.config.json. */
export type RepoKey = string;

export interface TicketSyncConfig {
  readonly owner: string;
  readonly hubRepo: string;
  readonly jiraProjectKey: string;
  readonly jiraBaseUrl: string;
  readonly repos: Readonly<Record<RepoKey, string>>;
  readonly defaultType: TicketType;
  readonly slugMaxLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
  return value;
}

/** Reads the project names from the hub's workflow.config.json (written by setup-aj-workflow). */
export function parseConfig(raw: unknown, where = "workflow.config.json"): TicketSyncConfig {
  if (!isRecord(raw)) throw new Error(`${where}: expected a JSON object`);
  const jira = raw["jira"];
  const repos = raw["repos"];
  if (!isRecord(repos) || Object.keys(repos).length === 0) throw new Error(`${where}: "repos" must map label keys to repo names`);
  const repoMap: Record<RepoKey, string> = {};
  for (const key of Object.keys(repos)) repoMap[key] = text(repos, key, `${where} repos`);
  const ticketKey = text(raw, "ticketKey", where);
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(ticketKey)) throw new Error(`${where}: "ticketKey" must look like a Jira key (ABC)`);
  return {
    owner: text(raw, "owner", where),
    hubRepo: text(raw, "hub", where),
    jiraProjectKey: ticketKey,
    jiraBaseUrl: isRecord(jira) && typeof jira["baseUrl"] === "string" ? jira["baseUrl"] : "",
    repos: repoMap,
    defaultType: "chore",
    slugMaxLength: 40,
  };
}

// Tests set TICKET_SYNC_CONFIG to a fixture, so renaming the project never breaks them.
const configPath = process.env["TICKET_SYNC_CONFIG"] ?? new URL("../../workflow.config.json", import.meta.url);
export const CONFIG: TicketSyncConfig = parseConfig(JSON.parse(readFileSync(configPath, "utf8")), String(configPath));

export const MARKERS = {
  jiraPrefix: "<!-- jira:",
  branchesComment: "<!-- ticket-sync:branches -->",
} as const;

export const jiraMarker = (key: string): string => `${MARKERS.jiraPrefix}${key} -->`;
export const ghLabel = (issueNumber: number): string => `gh-${issueNumber}`;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
