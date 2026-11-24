// node --test tests/setup.test.mjs   (scaffolds hubs from this repo's template and checks them)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { rename, setup } from "../skills/setup-aj-workflow/scripts/setup.mjs";

const TEMPLATE = path.resolve(import.meta.dirname, "..", "template");
const ORCHESTRATED = {
  name: "Zeta",
  owner: "zeta-labs",
  hub: "zeta-hub",
  ticketKey: "ZT",
  repos: { api: "zeta-api", mobile: "zeta-mobile" },
  jira: { baseUrl: "https://zeta.atlassian.net" },
  agents: ["claude", "codex", "opencode"],
  mode: "orchestrated",
  models: { codex: { worker: "gpt-worker-x" }, opencode: { redteam: "prov/red-y" } },
};

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", ".git", "tools"].includes(e.name)) files(p, out); } else out.push(p);
  }
  return out;
}

const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

describe("setup", () => {
  it("renames every sample name outside tools/", () => {
    const c = { ...ORCHESTRATED };
    assert.equal(rename("acme/acme-kb ACME-1 Acme acme.atlassian.net", c), "zeta-labs/zeta-hub ZT-1 Zeta zeta.atlassian.net");
  });

  it("scaffolds an orchestrated hub for three agents", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ajw-"));
    const { dest } = await quiet(() => setup(ORCHESTRATED, ws, TEMPLATE));
    for (const f of files(dest)) assert.doesNotMatch(read(f), /acme|zeta-labs-(app|web)/i, `sample name left in ${path.relative(dest, f)}`);

    const cfg = JSON.parse(read(dest, "workflow.config.json"));
    assert.deepEqual(cfg.repos, { api: "zeta-api", mobile: "zeta-mobile", kb: "zeta-hub" });
    assert.equal(cfg.models.claude.worker, "sonnet");
    assert.match(read(dest, ".github", "ISSUE_TEMPLATE", "task.yml"), /options: \[api, mobile, kb\]/);
    assert.match(read(dest, "AGENTS.md"), /Mode: \*\*orchestrated\*\*/);
    assert.match(read(dest, "AGENTS.md"), /`zeta-api`/);
    assert.match(read(dest, "kit", "github", "ticket-status.yml"), /uses: zeta-labs\/zeta-hub\/\.github/);

    assert.match(read(ws, ".codex", "agents", "orchestrator-worker.toml"), /model = "gpt-worker-x"/);
    assert.match(read(ws, ".codex", "agents", "orchestrator-redteam.toml"), /sandbox_mode = "read-only"/);
    assert.match(read(ws, ".opencode", "agents", "orchestrator-redteam.md"), /model: prov\/red-y/);
    assert.match(read(ws, ".opencode", "agents", "orchestrator-worker.md"), /git worktree add/);
    assert.match(read(ws, ".claude", "agents", "orchestrator-researcher.md"), /model: haiku/);
    assert.ok(fs.existsSync(path.join(ws, ".claude", "skills", "dev", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(ws, ".agents", "skills", "orchestrator", "SKILL.md")));
    assert.match(read(ws, ".claude", "settings.json"), /"baseRef": "head"/);
    assert.match(read(ws, "AGENTS.md"), /zeta-hub/);
  });

  it("ticket-sync reads the real config, and install.mjs re-runs and flips mode", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ajw-"));
    const { dest } = await quiet(() => setup({ ...ORCHESTRATED, agents: ["claude"] }, ws, TEMPLATE));
    const env = { ...process.env };
    delete env.TICKET_SYNC_CONFIG;
    const url = pathToFileURL(path.join(dest, "tools", "ticket-sync", "config.ts")).href;
    const out = execFileSync(process.execPath, ["-e", `import(${JSON.stringify(url)}).then((m) => console.log(JSON.stringify(m.CONFIG)))`], { env, encoding: "utf8" });
    const cfg = JSON.parse(out);
    assert.equal(cfg.owner, "zeta-labs");
    assert.equal(cfg.hubRepo, "zeta-hub");
    assert.equal(cfg.jiraProjectKey, "ZT");
    assert.equal(cfg.repos.api, "zeta-api");

    const { install } = await import(pathToFileURL(path.join(dest, "kit", "install.mjs")).href);
    await quiet(() => install(ws));
    assert.ok(fs.existsSync(path.join(ws, ".claude", "skills", "orchestrator", "SKILL.md")));
    assert.match(read(ws, ".claude", "agents", "orchestrator-worker.md"), /^---\nname: orchestrator-worker\n/);
    const configFile = path.join(dest, "workflow.config.json");
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(read(configFile)), mode: "solo" }));
    await quiet(() => install(ws));
    assert.ok(!fs.existsSync(path.join(ws, ".claude", "skills", "orchestrator")));
    assert.match(read(dest, "AGENTS.md"), /Mode: \*\*solo\*\*/);
    if (process.platform !== "win32") assert.ok(fs.statSync(path.join(dest, ".githooks", "pre-commit")).mode & 0o100);
  });

  it("solo mode skips role files and the orchestrator skill, and refuses a non-empty hub", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ajw-"));
    const solo = { ...ORCHESTRATED, agents: ["codex"], mode: "solo", jira: undefined, models: { codex: { lead: "m1" } } };
    const { dest } = await quiet(() => setup(solo, ws, TEMPLATE));
    assert.match(read(dest, "AGENTS.md"), /Mode: \*\*solo\*\*[\s\S]*codex `m1`/);
    assert.ok(!fs.existsSync(path.join(ws, ".codex", "agents")));
    assert.ok(!fs.existsSync(path.join(ws, ".agents", "skills", "orchestrator")));
    assert.ok(fs.existsSync(path.join(ws, ".agents", "skills", "ticket", "SKILL.md")));
    assert.ok(!fs.existsSync(path.join(ws, "CLAUDE.md")));
    await assert.rejects(quiet(() => setup(solo, ws, TEMPLATE)), /not empty/);
  });
});
