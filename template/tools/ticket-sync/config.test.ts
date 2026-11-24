import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig } from "./config.ts";

const VALID = { owner: "o", hub: "o-kb", ticketKey: "OK", repos: { api: "o-api", kb: "o-kb" }, jira: { baseUrl: "https://o.atlassian.net" } };

describe("parseConfig", () => {
  it("maps workflow.config.json onto the ticket-sync config", () => {
    const c = parseConfig(VALID);
    assert.equal(c.hubRepo, "o-kb");
    assert.equal(c.jiraProjectKey, "OK");
    assert.deepEqual(c.repos, { api: "o-api", kb: "o-kb" });
    assert.equal(c.jiraBaseUrl, "https://o.atlassian.net");
  });

  it("rejects missing names, empty repos and a bad ticket key", () => {
    assert.throws(() => parseConfig({ ...VALID, owner: "" }), /owner/);
    assert.throws(() => parseConfig({ ...VALID, repos: {} }), /repos/);
    assert.throws(() => parseConfig({ ...VALID, ticketKey: "ok-1" }), /ticketKey/);
    assert.throws(() => parseConfig([]), /JSON object/);
  });

  it("treats Jira as optional config", () => {
    const { jira: _jira, ...noJira } = VALID;
    assert.equal(parseConfig(noJira).jiraBaseUrl, "");
  });
});
