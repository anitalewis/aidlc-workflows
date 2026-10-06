// covers: function:captureAuditTelemetry, function:auditTelemetryEnabled, function:parseAuditTelemetry
// covers: function:auditTelemetryEvents, function:buildAuditOtlpExport, function:emitAuditTelemetry
// covers: function:sendAuditTelemetryFromStdin, subcommand:aidlc-audit:export
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendAuditEntries,
  appendAuditEntry,
  appendAuditEntryAtPathUnlocked,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditFilePath,
  parseAuditShardEvents,
  readActiveAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  auditTelemetryEvents,
  buildAuditOtlpExport,
  captureAuditTelemetry,
  parseAuditTelemetry,
  type AuditOtlpExport,
} from "../../dist/claude/.claude/tools/aidlc-telemetry.ts";
import { projectSettingsPath } from "../../dist/claude/.claude/tools/aidlc-settings.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  DEFAULT_INTENT_UUID,
  seedStateFile,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import {
  NATIVE_COMPILE_TIMEOUT_MS,
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const ENV_KEYS = [
  "AIDLC_AUDIT_TELEMETRY", "AIDLC_OTEL_ENDPOINT", "AIDLC_OTEL_HEADERS",
  "AIDLC_METRICS_ENDPOINT", "AIDLC_COMPILED_EXECUTABLE", "AIDLC_HARNESS_NAME",
  "AIDLC_HARNESS_DIR", "AIDLC_RUNTIME_HARNESS_ROOT", "AIDLC_SESSION_OVERRIDE",
  "AIDLC_SESSION_OVERRIDE_SOURCE", "CODEX_THREAD_ID", "AIDLC_TIER_CAP",
  "AIDLC_OFFLINE",
] as const;
const saved = new Map<string, string | undefined>();
const projects: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AIDLC_OFFLINE = "0";
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const project of projects.splice(0)) cleanupTestProject(project);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function project(): string {
  const pd = createTestProject();
  projects.push(pd);
  seedStateFile(pd, "state-mid-ideation.md");
  return pd;
}

function snapshots(pd: string) {
  return auditTelemetryEvents(readActiveAuditShardEvents(pd));
}

function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        files[`${name}/`] = "";
        walk(join(dir, entry.name), `${name}/`);
      } else files[name] = readFileSync(join(dir, entry.name)).toString("base64");
    }
  };
  walk(root, "");
  return files;
}

function attributes(payload: AuditOtlpExport) {
  return payload.resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) =>
    scope.logRecords.map((record) =>
      Object.fromEntries(record.attributes.map(({ key, value }) => [key, value.stringValue])),
    ),
  ));
}

function collector(status = 200) {
  const captures: Array<{ body: AuditOtlpExport; headers: Headers; path: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      captures.push({ body: await request.json() as AuditOtlpExport, headers: request.headers, path: new URL(request.url).pathname });
      return new Response("{}", { status });
    },
  });
  servers.push(server);
  return { captures, endpoint: `http://127.0.0.1:${server.port}/v1/logs` };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS)!;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}

describe("audit telemetry snapshots", () => {
  test("the default emits no metadata and leaves the original fields untouched", () => {
    const pd = project();
    const fields = { Stage: "requirements-analysis", Details: "keep local" };
    appendAuditEntry("STAGE_STARTED", fields, pd);
    const text = readFileSync(auditFilePath(pd), "utf8");
    expect(text).not.toContain("**Telemetry**:");
    expect(text).toContain("**Details**: keep local");
    expect(snapshots(pd)).toEqual([]);
    expect(fields).toEqual({ Stage: "requirements-analysis", Details: "keep local" });
  });

  test("single and batch writes persist unique IDs, exact replay context, and no content", () => {
    const pd = project();
    process.env.AIDLC_AUDIT_TELEMETRY = "1";
    process.env.AIDLC_SESSION_OVERRIDE = "chat-a";
    process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
    const fields = {
      Stage: "code-generation", Unit: "billing", "Attempt Generation": "2",
      "User Input": "SECRET PROMPT", Details: "SECRET DETAILS", Artifact: "/private/code.ts",
      "Tokens In": "500", "Cost USD": "1.25",
    };
    appendAuditEntry("STAGE_STARTED", fields, pd);
    appendAuditEntries([
      { eventType: "STAGE_COMPLETED", fields: { Stage: "code-generation", Session: "chat-b" } },
      { eventType: "STAGE_STARTED", fields: { Stage: "build-and-test", Session: "chat-b" } },
    ], pd);
    const events = snapshots(pd);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.context.eventId)).size).toBe(3);
    expect(events.map((event) => event.context.attributes["gen_ai.conversation.id"])).toEqual(["chat-a", "chat-b", "chat-b"]);
    expect(events[0].context.attributes).toMatchObject({
      "aidlc.intent.id": DEFAULT_INTENT_UUID,
      "aidlc.record.kind": "intent",
      "aidlc.unit.name": "billing",
      "aidlc.attempt.generation": "2",
      "aidlc.session.source": "invoking-session",
    });
    const payload = JSON.stringify(buildAuditOtlpExport(events));
    for (const value of ["SECRET", "/private/code.ts", "Tokens In", "Cost USD", pd]) {
      expect(payload).not.toContain(value);
    }
    process.env.AIDLC_SESSION_OVERRIDE = "later-chat";
    process.env.AIDLC_HARNESS_NAME = "codex";
    expect(JSON.stringify(buildAuditOtlpExport(snapshots(pd)))).toBe(payload);
    expect(fields).not.toHaveProperty("Telemetry");
  });

  test("an explicit space shard never inherits the active intent", () => {
    const pd = project();
    process.env.AIDLC_AUDIT_TELEMETRY = "1";
    const shard = join(pd, "aidlc", "spaces", "default", "audit", "space.md");
    appendAuditEntryAtPathUnlocked("SESSION_STARTED", { Session: "space-chat" }, pd, shard);
    const events = auditTelemetryEvents(parseAuditShardEvents(readFileSync(shard, "utf8"), shard, 0));
    expect(events[0].context.attributes).toMatchObject({
      "aidlc.record.kind": "space",
      "aidlc.record.path": "aidlc/spaces/default",
      "gen_ai.conversation.id": "space-chat",
    });
    expect(events[0].context.attributes).not.toHaveProperty("aidlc.intent.id");
  });

  test("never uses another chat's last-active session or an invalid explicit session", () => {
    const pd = project();
    process.env.AIDLC_AUDIT_TELEMETRY = "1";
    mkdirSync(join(pd, "aidlc", ".aidlc-sessions"), { recursive: true });
    writeFileSync(join(pd, "aidlc", ".aidlc-sessions", ".current-session"), "other-chat");
    const absent = captureAuditTelemetry({}, pd, auditFilePath(pd))!;
    expect(absent.attributes["gen_ai.conversation.id"]).toBeUndefined();
    process.env.AIDLC_SESSION_OVERRIDE = "valid-invoker";
    const invalid = captureAuditTelemetry({ Session: "../bad-session" }, pd, auditFilePath(pd))!;
    expect(invalid.attributes["gen_ai.conversation.id"]).toBeUndefined();
    expect(invalid.attributes["aidlc.session.source"]).toBe("unavailable");
  });

  test("records configured effort separately from runtime-reported model and effort", () => {
    const pd = project();
    process.env.AIDLC_AUDIT_TELEMETRY = "1";
    process.env.AIDLC_HARNESS_NAME = "codex";
    cpSync(join(AIDLC_SRC, "tools", "data"), join(pd, ".claude", "tools", "data"), { recursive: true });
    writeFileSync(projectSettingsPath(pd), JSON.stringify({
      schemaVersion: 1,
      models: { schemaVersion: 1, agents: { developer: { model: { codex: "test-model" }, effort: "max" } } },
    }));
    const context = captureAuditTelemetry({ Agent: "aidlc-developer-agent" }, pd, auditFilePath(pd))!;
    expect(context.attributes).toMatchObject({
      "aidlc.model.configured": "test-model",
      "aidlc.effort.configured": "xhigh",
      "aidlc.model.policy.layer": "agent-exception",
    });
    expect(context.attributes).not.toHaveProperty("gen_ai.request.model");
    expect(context.attributes).not.toHaveProperty("gen_ai.request.reasoning_effort");
    process.env.AIDLC_HARNESS_NAME = "kiro-ide";
    const inherited = captureAuditTelemetry({ Agent: "aidlc-developer-agent" }, pd, auditFilePath(pd))!;
    expect(inherited.attributes).not.toHaveProperty("aidlc.model.configured");
    expect(inherited.attributes).not.toHaveProperty("aidlc.effort.configured");
  });

  test("replay drops malformed, future-schema, and legacy records, and deduplicates copies", () => {
    const pd = project();
    process.env.AIDLC_AUDIT_TELEMETRY = "1";
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation" }, pd);
    const rows = readActiveAuditShardEvents(pd);
    expect(auditTelemetryEvents([...rows, ...rows])).toHaveLength(1);
    const context = snapshots(pd)[0].context;
    expect(parseAuditTelemetry(JSON.stringify({ ...context, schemaVersion: 2 }))).toBeNull();
    expect(parseAuditTelemetry("{invalid")).toBeNull();
    expect(parseAuditTelemetry(null)).toBeNull();
    expect(parseAuditTelemetry(JSON.stringify({ ...context, timeUnixNano: "18446744073709551616" }))).toBeNull();
    expect(parseAuditTelemetry(JSON.stringify({
      ...context,
      attributes: { ...context.attributes, "user.prompt": "private", "aidlc.stage.name": "not an identifier" },
    }))!.attributes).not.toHaveProperty("user.prompt");
    const conflicting = { ...rows[0], block: rows[0].block.replace("code-generation", "build-and-test") };
    // Alter the persisted snapshot, not only the human-readable field.
    conflicting.block = conflicting.block.replace("code-generation", "build-and-test");
    expect(() => auditTelemetryEvents([...rows, conflicting])).toThrow("Conflicting telemetry snapshots");
  });

  test("export is a read-only OTLP payload and never uses current capture settings", () => {
    const pd = project();
    process.env.AIDLC_AUDIT_TELEMETRY = "1";
    appendAuditEntry("STAGE_STARTED", { Stage: "requirements-analysis", Session: "original-chat" }, pd);
    const before = snapshotTree(pd);
    delete process.env.AIDLC_AUDIT_TELEMETRY;
    process.env.AIDLC_OTEL_ENDPOINT = "http://127.0.0.1:1/v1/logs";
    for (const mode of [[], ["--json"], ["--human"]]) {
      const result = Bun.spawnSync([
        process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"),
        "engine", "audit", "export", ...mode, "--project-dir", pd,
      ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString())).toEqual(buildAuditOtlpExport(snapshots(pd)));
      expect(snapshotTree(pd)).toEqual(before);
    }
  });

  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name} projects the same producer without a native usage adapter`, () => {
      const pd = project();
      const result = Bun.spawnSync([
        process.execPath, join(harness.engineRoot, "tools", "aidlc-audit.ts"),
        "append", "ERROR_LOGGED", "--field", "Session=shared-session", "--field", "Details=local only",
        "--project-dir", pd,
      ], {
        env: {
          ...process.env,
          AIDLC_AUDIT_TELEMETRY: "1",
        },
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(snapshots(pd)[0].context.attributes).toMatchObject({
        "aidlc.harness.name": harness.name,
        "gen_ai.conversation.id": "shared-session",
      });
    });
  }
});

describe("audit OTLP transport", () => {
  test("committed batches arrive in one request, with persisted IDs and OTLP headers", async () => {
    const pd = project();
    const endpoint = collector();
    process.env.AIDLC_OTEL_ENDPOINT = endpoint.endpoint;
    process.env.AIDLC_OTEL_HEADERS = "Authorization: Bearer test-secret\nX-Probe: fixture";
    appendAuditEntries([
      { eventType: "STAGE_STARTED", fields: { Stage: "code-generation", Session: "chat" } },
      { eventType: "STAGE_COMPLETED", fields: { Stage: "code-generation", Session: "chat" } },
    ], pd);
    await waitFor(() => endpoint.captures.length === 1);
    const capture = endpoint.captures[0];
    expect(capture.path).toBe("/v1/logs");
    expect(capture.headers.get("content-type")).toBe("application/json");
    expect(capture.headers.get("authorization")).toBe("Bearer test-secret");
    expect(capture.body).toEqual(buildAuditOtlpExport(snapshots(pd)));
    expect(attributes(capture.body)).toHaveLength(2);
  });

  test("invalid batches and failed disk writes never start a sender", () => {
    const pd = project();
    process.env.AIDLC_OTEL_ENDPOINT = "http://127.0.0.1:1/v1/logs";
    const spawn = spyOn(Bun, "spawn");
    try {
      expect(() => appendAuditEntries([
        { eventType: "STAGE_STARTED", fields: { Stage: "code-generation" } },
        { eventType: "NOT_AN_EVENT", fields: {} },
      ], pd)).toThrow("Invalid event type");
      expect(snapshots(pd)).toEqual([]);
      expect(() => appendAuditEntry("ERROR_LOGGED", { Telemetry: "{}" }, pd)).toThrow("Reserved field key");
      mkdirSync(auditFilePath(pd), { recursive: true });
      expect(() => appendAuditEntry("STAGE_STARTED", {}, pd)).toThrow();
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });

  test("offline captures locally and never starts a network worker", () => {
    const pd = project();
    process.env.AIDLC_OTEL_ENDPOINT = "http://127.0.0.1:1/v1/logs";
    process.env.AIDLC_OFFLINE = "1";
    const spawn = spyOn(Bun, "spawn");
    try {
      appendAuditEntry("STAGE_STARTED", { Session: "offline-chat" }, pd);
      expect(snapshots(pd)).toHaveLength(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });

  test("a collector rejection does not roll back audit; replay keeps the original ID", async () => {
    const pd = project();
    const endpoint = collector(503);
    process.env.AIDLC_OTEL_ENDPOINT = endpoint.endpoint;
    expect(appendAuditEntry("STAGE_STARTED", { Session: "chat" }, pd).appended).toBe(true);
    await waitFor(() => endpoint.captures.length === 1);
    expect(buildAuditOtlpExport(snapshots(pd))).toEqual(endpoint.captures[0].body);
  });

  test("the caller exits before a slow collector returns", async () => {
    const pd = project();
    const response = Promise.withResolvers<Response>();
    let received = false;
    const slow = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        await request.text();
        received = true;
        return response.promise;
      },
    });
    servers.push(slow);
    const child = Bun.spawn([
      process.execPath, join(AIDLC_SRC, "tools", "aidlc-audit.ts"),
      "append", "ERROR_LOGGED", "--field", "Session=slow-chat", "--project-dir", pd,
    ], {
      env: { ...process.env, AIDLC_OTEL_ENDPOINT: `http://127.0.0.1:${slow.port}/v1/logs` },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      await waitFor(() => child.exitCode !== null && received);
      expect(child.exitCode).toBe(0);
    } finally {
      response.resolve(new Response("{}"));
      if (child.exitCode === null) child.kill();
    }
  });

  test("the sender never forwards credentials through an HTTP redirect", async () => {
    const redirected = collector();
    let received = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        received++;
        return new Response(null, { status: 307, headers: { Location: redirected.endpoint } });
      },
    });
    servers.push(server);
    const child = Bun.spawn([
      process.execPath, join(AIDLC_SRC, "tools", "aidlc-telemetry.ts"), "--internal-audit-telemetry-send",
    ], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    child.stdin.write(JSON.stringify({
      endpoint: `http://127.0.0.1:${server.port}/v1/logs`,
      body: "{}",
      headers: ["Authorization: Bearer test-only"],
    }));
    child.stdin.end();
    try {
      await waitFor(() => child.exitCode !== null);
      expect(child.exitCode).toBe(0);
      expect(received).toBe(1);
      expect(redirected.captures).toHaveLength(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  test("worker argv and environment exclude endpoint and custom-header credentials", async () => {
    const pd = project();
    const source = join(pd, "capture-worker.ts");
    const captureFile = join(pd, "worker.json");
    const executable = join(pd, process.platform === "win32" ? "capture.exe" : "capture");
    writeFileSync(source, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({`,
      "args: process.argv.slice(2),",
      "env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^AIDLC_(?:OTEL_|METRICS_(?:HEADERS|ENDPOINT)$)/i.test(key))),",
      "envelope: JSON.parse(await Bun.stdin.text())",
      "}));",
    ].join("\n"));
    const built = Bun.spawnSync([
      process.execPath, "build", "--compile", source, "--outfile", executable,
    ], { timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) });
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    process.env.AIDLC_COMPILED_EXECUTABLE = executable;
    process.env.AIDLC_OTEL_ENDPOINT = "http://127.0.0.1:4318/v1/logs?secret=test-endpoint";
    process.env.AIDLC_OTEL_HEADERS = "Authorization: Bearer test-header";
    appendAuditEntry("STAGE_STARTED", { Session: "header-chat" }, pd);
    let capture: { args: string[]; env: Record<string, string>; envelope: { endpoint: string; headers: string[] } } | undefined;
    await waitFor(() => {
      try { capture = JSON.parse(readFileSync(captureFile, "utf8")); return true; } catch { return false; }
    });
    expect(capture!.args).toEqual(["--internal-audit-telemetry-send"]);
    expect(capture!.env).toEqual({});
    expect(capture!.envelope.endpoint).toBe(process.env.AIDLC_OTEL_ENDPOINT);
    expect(capture!.envelope.headers).toEqual(["Authorization: Bearer test-header"]);
  }, NATIVE_COMPILE_TIMEOUT_MS);

  test("the compiled dispatcher delivers through the same private OTLP worker route", async () => {
    const pd = project();
    const executable = join(pd, process.platform === "win32" ? "aidlc.exe" : "aidlc-bin");
    const built = Bun.spawnSync([
      process.execPath, "build", "--compile", join(AIDLC_SRC, "tools", "aidlc.ts"), "--outfile", executable,
    ], { timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) });
    expect(built.exitCode, built.stderr.toString()).toBe(0);
    const endpoint = collector();
    process.env.AIDLC_OTEL_ENDPOINT = endpoint.endpoint;
    process.env.AIDLC_COMPILED_EXECUTABLE = executable;
    appendAuditEntry("STAGE_STARTED", { Session: "compiled-chat" }, pd);
    await waitFor(() => endpoint.captures.length === 1);
    expect(attributes(endpoint.captures[0].body)[0]["gen_ai.conversation.id"]).toBe("compiled-chat");
  }, NATIVE_COMPILE_TIMEOUT_MS);
});
