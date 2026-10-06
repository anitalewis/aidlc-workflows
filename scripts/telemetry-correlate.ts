#!/usr/bin/env bun
// Reference consumer of the public audit telemetry contract. A collector
// normalizes native usage into this input; this script has no harness readers.
// Usage: bun scripts/telemetry-correlate.ts <audit-otlp.json> <usage.json>
import { readFileSync } from "node:fs";
import {
  parseAuditTelemetry,
  type AuditTelemetryEvent,
} from "../core/tools/aidlc-telemetry.ts";

export interface NativeUsageRecord {
  id: string;
  harness: string;
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  temporality: "delta" | "cumulative";
  quantities: Array<{ name: string; value: number | null; unit: string }>;
  model?: string;
  effort?: string;
  auditEventId?: string;
}

export interface UsageCorrelation {
  usage: NativeUsageRecord;
  match: "event-id" | "stage-window" | "unattributed";
  reason?: string;
  auditEventId?: string;
  intentId?: string;
  stage?: string;
  unit?: string;
  configuredModel?: string;
  configuredEffort?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

// Read only this producer's versioned metadata from an OTLP/HTTP logs export.
export function auditEventsFromOtlp(value: unknown): AuditTelemetryEvent[] {
  if (!record(value) || !Array.isArray(value.resourceLogs)) throw new Error("Expected an OTLP logs export.");
  const events: AuditTelemetryEvent[] = [];
  const seen = new Map<string, string>();
  for (const resource of value.resourceLogs) {
    if (!record(resource) || !Array.isArray(resource.scopeLogs) ||
      !record(resource.resource) || !Array.isArray(resource.resource.attributes) ||
      !resource.resource.attributes.some((item) => record(item) && item.key === "service.name" &&
        record(item.value) && item.value.stringValue === "aidlc")) continue;
    for (const scope of resource.scopeLogs) {
      if (!record(scope) || !record(scope.scope) || scope.scope.name !== "aidlc.audit" ||
        scope.scope.version !== "1" || !Array.isArray(scope.logRecords)) continue;
      for (const log of scope.logRecords) {
        if (!record(log) || !record(log.body) || typeof log.body.stringValue !== "string" ||
          !/^[A-Z][A-Z0-9_]{0,95}$/.test(log.body.stringValue) || !Array.isArray(log.attributes)) continue;
        const attributes: Record<string, string> = {};
        for (const item of log.attributes) {
          if (record(item) && typeof item.key === "string" && record(item.value) &&
            typeof item.value.stringValue === "string") {
            if (Object.hasOwn(attributes, item.key)) throw new Error("Duplicate OTLP log attributes.");
            attributes[item.key] = item.value.stringValue;
          }
        }
        if (attributes["aidlc.telemetry.schema.version"] !== "1" ||
          !timestamp(attributes["aidlc.audit.timestamp"])) continue;
        const context = parseAuditTelemetry(JSON.stringify({
          schemaVersion: 1,
          eventId: attributes["aidlc.audit.event.id"],
          timeUnixNano: log.timeUnixNano,
          attributes,
        }));
        if (!context) continue;
        const event = {
          eventType: log.body.stringValue,
          timestamp: attributes["aidlc.audit.timestamp"],
          context,
        };
        const fingerprint = JSON.stringify(event);
        if (seen.has(context.eventId)) {
          if (seen.get(context.eventId) !== fingerprint) throw new Error("Conflicting audit event IDs.");
          continue;
        }
        seen.set(context.eventId, fingerprint);
        events.push(event);
      }
    }
  }
  return events;
}

export function readNativeUsage(value: unknown): NativeUsageRecord[] {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) {
    throw new Error("Expected usage schemaVersion 1 and a records array.");
  }
  const records: NativeUsageRecord[] = [];
  const seen = new Map<string, string>();
  for (const [index, item] of value.records.entries()) {
    if (!record(item) || typeof item.id !== "string" || !item.id ||
      typeof item.harness !== "string" || !item.harness ||
      !(item.sessionId === null || (typeof item.sessionId === "string" && item.sessionId)) ||
      !["delta", "cumulative"].includes(String(item.temporality)) ||
      ![item.startedAt, item.endedAt].every((time) => time === null || timestamp(time)) ||
      !["model", "effort", "auditEventId"].every((key) => item[key] === undefined || typeof item[key] === "string") ||
      !Array.isArray(item.quantities) ||
      !item.quantities.every((quantity) => record(quantity) &&
        typeof quantity.name === "string" && quantity.name &&
        typeof quantity.unit === "string" && quantity.unit &&
        (quantity.value === null || (typeof quantity.value === "number" &&
          Number.isFinite(quantity.value) && quantity.value >= 0 &&
          (quantity.unit !== "token" || Number.isSafeInteger(quantity.value)))))) {
      throw new Error(`Invalid normalized usage record at index ${index}.`);
    }
    // Canonicalize known fields; raw collector extras must not leak into a
    // report, or make two otherwise identical source records appear different.
    const validated = item as unknown as NativeUsageRecord;
    const usage: NativeUsageRecord = {
      id: validated.id,
      harness: validated.harness,
      sessionId: validated.sessionId,
      startedAt: validated.startedAt,
      endedAt: validated.endedAt,
      temporality: validated.temporality,
      quantities: validated.quantities.map(({ name, value, unit }) => ({ name, value, unit })),
      ...(validated.model !== undefined ? { model: validated.model } : {}),
      ...(validated.effort !== undefined ? { effort: validated.effort } : {}),
      ...(validated.auditEventId !== undefined ? { auditEventId: validated.auditEventId } : {}),
    };
    if (usage.startedAt && usage.endedAt && Date.parse(usage.startedAt) > Date.parse(usage.endedAt)) {
      throw new Error(`Usage interval runs backwards at index ${index}.`);
    }
    const key = JSON.stringify([usage.harness, usage.id]);
    const fingerprint = JSON.stringify({
      ...usage,
      quantities: [...usage.quantities].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))),
    });
    if (seen.has(key)) {
      if (seen.get(key) !== fingerprint) throw new Error("Conflicting usage records share an ID.");
      continue;
    }
    seen.set(key, fingerprint);
    records.push(usage);
  }
  return records;
}

function sessionKey(event: AuditTelemetryEvent): string | null {
  const a = event.context.attributes;
  return a["gen_ai.conversation.id"] && a["aidlc.harness.name"]
    ? JSON.stringify([a["aidlc.harness.name"], a["gen_ai.conversation.id"]])
    : null;
}

interface StageWindow {
  start: AuditTelemetryEvent;
  end: bigint | null;
  ambiguous: boolean;
}

function stageWindows(events: readonly AuditTelemetryEvent[]): StageWindow[] {
  const groups = new Map<string, AuditTelemetryEvent[]>();
  for (const event of events) {
    if (!["STAGE_STARTED", "STAGE_COMPLETED"].includes(event.eventType)) continue;
    const a = event.context.attributes;
    if (!sessionKey(event) || !a["aidlc.stage.name"] || !a["aidlc.intent.id"]) continue;
    const key = JSON.stringify([
      sessionKey(event), a["aidlc.intent.id"], a["aidlc.stage.name"],
      a["aidlc.unit.name"] ?? null, a["aidlc.workflow.kind"] ?? null, a["aidlc.attempt.generation"] ?? null,
    ]);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const windows: StageWindow[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const left = BigInt(a.context.timeUnixNano);
      const right = BigInt(b.context.timeUnixNano);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    let open: AuditTelemetryEvent[] = [];
    for (let i = 0; i < group.length;) {
      const time = group[i].context.timeUnixNano;
      const tied: AuditTelemetryEvent[] = [];
      while (i < group.length && group[i].context.timeUnixNano === time) tied.push(group[i++]);
      const starts = tied.filter((event) => event.eventType === "STAGE_STARTED");
      const ends = tied.filter((event) => event.eventType === "STAGE_COMPLETED");
      if (ends.length) {
        for (const start of open) windows.push({
          start, end: BigInt(time), ambiguous: open.length !== 1 || ends.length !== 1 || starts.length > 0,
        });
        open = [];
      }
      open.push(...starts);
    }
    // An open stage is not a candidate, but must prevent another concurrent
    // stage from claiming its usage just because that stage has a completion.
    for (const start of open) windows.push({ start, end: null, ambiguous: true });
  }
  return windows;
}

function matched(usage: NativeUsageRecord, event: AuditTelemetryEvent, match: "event-id" | "stage-window"): UsageCorrelation {
  const a = event.context.attributes;
  return {
    usage,
    match,
    auditEventId: event.context.eventId,
    ...(a["aidlc.intent.id"] ? { intentId: a["aidlc.intent.id"] } : {}),
    ...(a["aidlc.stage.name"] ? { stage: a["aidlc.stage.name"] } : {}),
    ...(a["aidlc.unit.name"] ? { unit: a["aidlc.unit.name"] } : {}),
    ...(a["aidlc.model.configured"] ? { configuredModel: a["aidlc.model.configured"] } : {}),
    ...(a["aidlc.effort.configured"] ? { configuredEffort: a["aidlc.effort.configured"] } : {}),
  };
}

export function correlateAuditUsage(
  events: readonly AuditTelemetryEvent[],
  records: readonly NativeUsageRecord[],
): UsageCorrelation[] {
  const byId = new Map(events.map((event) => [event.context.eventId, event]));
  const windows = stageWindows(events);
  return records.map((usage) => {
    const missing = (reason: string): UsageCorrelation => ({ usage, match: "unattributed", reason });
    if (usage.temporality !== "delta") return missing("cumulative-usage");
    if (usage.auditEventId) {
      const event = byId.get(usage.auditEventId);
      if (!event) return missing("unknown-event-id");
      if (event.context.attributes["aidlc.harness.name"] !== usage.harness ||
        (usage.sessionId !== null && event.context.attributes["gen_ai.conversation.id"] !== usage.sessionId)) {
        return missing("event-context-mismatch");
      }
      return matched(usage, event, "event-id");
    }
    if (!usage.sessionId) return missing("missing-session");
    if (!usage.startedAt || !usage.endedAt) return missing("missing-interval");
    const start = BigInt(Date.parse(usage.startedAt)) * 1_000_000n;
    const end = BigInt(Date.parse(usage.endedAt)) * 1_000_000n;
    const session = JSON.stringify([usage.harness, usage.sessionId]);
    const overlapping = windows.filter((window) =>
      sessionKey(window.start) === session && end >= BigInt(window.start.context.timeUnixNano) &&
      (window.end === null || start <= window.end),
    );
    if (overlapping.length > 1) return missing("ambiguous-stage-window");
    const candidate = overlapping[0];
    if (!candidate || candidate.end === null) return missing("no-bounded-stage-window");
    if (candidate.ambiguous) return missing("ambiguous-stage-window");
    if (start <= BigInt(candidate.start.context.timeUnixNano) || end >= candidate.end) {
      return missing("crosses-stage-boundary");
    }
    return matched(usage, candidate.start, "stage-window");
  });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) throw new Error("Expected an audit OTLP JSON file and a normalized usage JSON file.");
    const events = auditEventsFromOtlp(JSON.parse(readFileSync(args[0], "utf8")));
    const records = readNativeUsage(JSON.parse(readFileSync(args[1], "utf8")));
    console.log(JSON.stringify({ schemaVersion: 1, records: correlateAuditUsage(events, records) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
