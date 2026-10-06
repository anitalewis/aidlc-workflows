// The harness-neutral audit side of consumption telemetry. Native telemetry
// owns measured usage; this module supplies workflow correlation metadata.
// No transcripts, credit counters, prompts, or provider rate tables are read.
import { randomUUID } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditBlockField,
  intentUuidForSelection,
  resolveInvokingSessionId,
  validSessionId,
  type AuditShardEvent,
} from "./aidlc-lib.ts";
import {
  isModelHarness,
  modelAgentName,
  readAgentTiers,
  resolveModelPolicy,
} from "./aidlc-model-policy.ts";
import { resolvedReleaseSettings } from "./aidlc-machine-config.ts";
import {
  compiledExecutable,
  resolveHarnessRoot,
  runtimeHarnessName,
} from "./aidlc-runtime-paths.ts";
import { modelPolicyForHarness, resolveAidlcSettings } from "./aidlc-settings.ts";
import { resolveTierCap } from "./aidlc-tiers.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

export const AUDIT_TELEMETRY_FIELD = "Telemetry";
const WORKER_ARG = "--internal-audit-telemetry-send";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const ATTRIBUTE_KEYS = new Set([
  "aidlc.version",
  "aidlc.harness.name",
  "aidlc.record.path",
  "aidlc.record.kind",
  "aidlc.space.name",
  "aidlc.intent.id",
  "aidlc.session.source",
  "gen_ai.conversation.id",
  "aidlc.stage.name",
  "aidlc.phase.name",
  "aidlc.unit.name",
  "aidlc.agent.name",
  "aidlc.scope.name",
  "aidlc.workflow.kind",
  "aidlc.attempt.generation",
  "aidlc.model.configured",
  "aidlc.effort.configured",
  "aidlc.model.policy.layer",
  "aidlc.model.policy.status",
]);
const AUDIT_ATTRIBUTES: Record<string, string> = {
  Stage: "aidlc.stage.name",
  Phase: "aidlc.phase.name",
  Unit: "aidlc.unit.name",
  Agent: "aidlc.agent.name",
  Scope: "aidlc.scope.name",
  Workflow: "aidlc.workflow.kind",
  "Attempt Generation": "aidlc.attempt.generation",
};

export interface AuditTelemetryContext {
  schemaVersion: 1;
  eventId: string;
  // OTLP uint64 values are decimal strings. The clock has millisecond
  // resolution; this does not claim nanosecond precision or causal ordering.
  timeUnixNano: string;
  attributes: Record<string, string>;
}

export interface AuditTelemetryEvent {
  eventType: string;
  timestamp: string;
  context: AuditTelemetryContext;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

export interface AuditOtlpExport {
  resourceLogs: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeLogs: Array<{
      scope: { name: string; version: string };
      logRecords: Array<{
        timeUnixNano: string;
        severityNumber: number;
        severityText: string;
        body: { stringValue: string };
        attributes: OtlpAttribute[];
      }>;
    }>;
  }>;
}

export function auditTelemetryEnabled(): boolean {
  return process.env.AIDLC_AUDIT_TELEMETRY === "1" ||
    Boolean(process.env.AIDLC_OTEL_ENDPOINT?.trim());
}

function identifier(value: string | undefined): string | undefined {
  return value && IDENTIFIER.test(value) ? value : undefined;
}

function recordAttributes(projectDir: string, shardPath: string): Record<string, string> {
  // The actual committed shard owns selection, including explicit space-level
  // DocumentKB writes. Never borrow an active cursor or another chat's intent.
  const path = relative(resolve(projectDir), resolve(shardPath)).split(sep).join("/");
  const match = /^aidlc\/spaces\/([^/]+)\/(?:(?:intents\/([^/]+))\/)?audit\/[^/]+\.md$/.exec(path);
  if (!match || !identifier(match[1]) || (match[2] && !identifier(match[2]))) {
    return { "aidlc.record.kind": "unknown" };
  }
  const space = match[1];
  const intent = match[2] ?? null;
  const attributes: Record<string, string> = {
    "aidlc.record.kind": intent === null ? "space" : "intent",
    "aidlc.record.path": intent === null
      ? `aidlc/spaces/${space}`
      : `aidlc/spaces/${space}/intents/${intent}`,
    "aidlc.space.name": space,
  };
  try {
    const uuid = intentUuidForSelection(projectDir, { space, intent, sessionId: null, binding: null });
    if (uuid && UUID.test(uuid)) attributes["aidlc.intent.id"] = uuid;
  } catch { /* pre-init or an unavailable registry: the path is still known */ }
  return attributes;
}

function configuredModelAttributes(
  fields: Record<string, string>,
  projectDir: string,
  harness: string,
): Record<string, string> {
  if (!fields.Agent) return { "aidlc.model.policy.status": "no-agent" };
  if (!isModelHarness(harness)) return { "aidlc.model.policy.status": "unavailable" };
  try {
    const agent = modelAgentName(fields.Agent);
    const tiers = readAgentTiers(resolveHarnessRoot({ projectDir }));
    if (!tiers[agent]) return { "aidlc.model.policy.status": "unavailable" };
    const settings = resolveAidlcSettings(projectDir);
    const policy = resolveModelPolicy(
      modelPolicyForHarness(settings.models, harness),
      agent,
      tiers[agent],
      harness,
      resolveTierCap(join(projectDir, "aidlc", "spaces", "default", "memory")),
    );
    return {
      "aidlc.model.policy.status": policy.model || policy.effort ? "configured" : "session-inherit",
      "aidlc.model.policy.layer": policy.layer,
      ...(identifier(policy.model) ? { "aidlc.model.configured": policy.model! } : {}),
      ...(policy.effort ? { "aidlc.effort.configured": policy.effort } : {}),
    };
  } catch {
    return { "aidlc.model.policy.status": "unavailable" };
  }
}

// Snapshot once, before rendering, and persist with the event. Replays must not
// resolve today's session, model settings, version, or cursor for yesterday's row.
export function captureAuditTelemetry(
  fields: Record<string, string>,
  projectDir: string,
  shardPath: string,
): AuditTelemetryContext | null {
  if (!auditTelemetryEnabled()) return null;
  const timeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
  const harness = identifier(runtimeHarnessName(projectDir)) ?? "unknown";
  const attributes: Record<string, string> = {
    "aidlc.version": AIDLC_VERSION,
    "aidlc.harness.name": harness,
    ...recordAttributes(projectDir, shardPath),
    "aidlc.session.source": "unavailable",
  };
  try {
    const session = fields.Session === undefined
      ? resolveInvokingSessionId(projectDir)
      : validSessionId(fields.Session);
    if (session && identifier(session)) {
      attributes["gen_ai.conversation.id"] = session;
      attributes["aidlc.session.source"] = fields.Session === undefined ? "invoking-session" : "event";
    }
  } catch { /* conflicting session evidence must remain unattributed */ }
  for (const [field, key] of Object.entries(AUDIT_ATTRIBUTES)) {
    const value = identifier(fields[field]);
    if (value) attributes[key] = value;
  }
  Object.assign(attributes, configuredModelAttributes(fields, projectDir, harness));
  // Apply the same bounds and allowlist on live delivery and replay.
  return parseAuditTelemetry(JSON.stringify({
    schemaVersion: 1, eventId: randomUUID(), timeUnixNano, attributes,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Audit files can be edited or come from another version. Keep unknown fields
// local, reject unsupported schemas, and never forward a raw block to a collector.
export function parseAuditTelemetry(value: string | null): AuditTelemetryContext | null {
  if (!value || value.length > 16_384) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 ||
      typeof parsed.eventId !== "string" || !UUID.test(parsed.eventId) ||
      typeof parsed.timeUnixNano !== "string" || !/^[1-9][0-9]{0,19}$/.test(parsed.timeUnixNano) ||
      BigInt(parsed.timeUnixNano) > 18_446_744_073_709_551_615n ||
      !isRecord(parsed.attributes)) return null;
    const attributes: Record<string, string> = {};
    for (const key of ATTRIBUTE_KEYS) {
      const value = parsed.attributes[key];
      if (typeof value === "string" && identifier(value)) {
        attributes[key] = value;
      }
    }
    return {
      schemaVersion: 1,
      eventId: parsed.eventId,
      timeUnixNano: parsed.timeUnixNano,
      attributes,
    };
  } catch {
    return null;
  }
}

// Read-only replay. Old rows without a snapshot stay old rows: no invented
// sessions, event IDs, or model history. A fork/merge copy retains its event ID.
export function auditTelemetryEvents(rows: readonly AuditShardEvent[]): AuditTelemetryEvent[] {
  const seen = new Map<string, string>();
  const events: AuditTelemetryEvent[] = [];
  for (const row of rows) {
    const context = parseAuditTelemetry(auditBlockField(row.block, AUDIT_TELEMETRY_FIELD));
    if (!context || !/^[A-Z][A-Z0-9_]{0,95}$/.test(row.event) ||
      !Number.isFinite(Date.parse(row.timestamp))) continue;
    const event = { eventType: row.event, timestamp: row.timestamp, context };
    const fingerprint = JSON.stringify(event);
    const previous = seen.get(context.eventId);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error("Conflicting telemetry snapshots share an event ID.");
      continue;
    }
    seen.set(context.eventId, fingerprint);
    events.push(event);
  }
  return events;
}

function otlpAttributes(values: Record<string, string>): OtlpAttribute[] {
  return Object.entries(values).map(([key, stringValue]) => ({ key, value: { stringValue } }));
}

export function buildAuditOtlpExport(events: readonly AuditTelemetryEvent[]): AuditOtlpExport {
  return {
    resourceLogs: events.length === 0 ? [] : [{
      resource: { attributes: otlpAttributes({ "service.name": "aidlc" }) },
      scopeLogs: [{
        scope: { name: "aidlc.audit", version: "1" },
        logRecords: events.map(({ eventType, timestamp, context }) => ({
          timeUnixNano: context.timeUnixNano,
          severityNumber: 9,
          severityText: "INFO",
          body: { stringValue: eventType },
          attributes: otlpAttributes({
            "aidlc.telemetry.schema.version": "1",
            "aidlc.audit.event.id": context.eventId,
            "aidlc.audit.timestamp": timestamp,
            ...context.attributes,
          }),
        })),
      }],
    }],
  };
}

interface DispatchEnvelope {
  endpoint: string;
  body: string;
  headers: string[];
}

function httpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

// The worker owns the network wait. It runs in source projections and in the
// compiled executable, with credentials on stdin rather than argv/environment.
export async function sendAuditTelemetryFromStdin(): Promise<void> {
  try {
    const envelope: unknown = JSON.parse(await Bun.stdin.text());
    if (!isRecord(envelope) || typeof envelope.endpoint !== "string" ||
      !httpEndpoint(envelope.endpoint) || typeof envelope.body !== "string" ||
      !Array.isArray(envelope.headers) || !envelope.headers.every((line) => typeof line === "string")) return;
    const headers = new Headers();
    for (const line of envelope.headers as string[]) {
      const colon = line.indexOf(":");
      if (colon <= 0) return;
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    headers.set("Content-Type", "application/json");
    const response = await fetch(envelope.endpoint, {
      method: "POST",
      headers,
      body: envelope.body,
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
  } catch {
    // Best effort: audit replay is the recovery path, never a workflow failure.
  }
}

// Called only AFTER the corresponding structured audit append succeeded.
export function emitAuditTelemetry(events: readonly AuditTelemetryEvent[]): void {
  const endpoint = process.env.AIDLC_OTEL_ENDPOINT?.trim();
  if (!endpoint || !httpEndpoint(endpoint) || events.length === 0) return;
  try {
    if (resolvedReleaseSettings().offline) return;
    const envelope: DispatchEnvelope = {
      endpoint,
      body: JSON.stringify(buildAuditOtlpExport(events)),
      headers: (process.env.AIDLC_OTEL_HEADERS ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
    };
    const executable = compiledExecutable();
    const command = executable
      ? [executable, WORKER_ARG]
      : [process.execPath, fileURLToPath(import.meta.url), WORKER_ARG];
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^AIDLC_(?:OTEL_|AUDIT_TELEMETRY$|METRICS_(?:HEADERS|ENDPOINT)$)/i.test(key)) delete env[key];
    }
    const child = Bun.spawn(command, { env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
    child.unref();
  } catch { /* a failed spawn must not affect an already-committed audit write */ }
}

if (import.meta.main && process.argv[2] === WORKER_ARG) {
  // Keep this module synchronously require-able by the opt-in audit tap.
  const keepAlive = setInterval(() => {}, 1_000);
  void sendAuditTelemetryFromStdin().finally(() => clearInterval(keepAlive));
}
