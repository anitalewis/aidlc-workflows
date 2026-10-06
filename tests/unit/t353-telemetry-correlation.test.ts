// covers: function:correlateAuditUsage, function:auditEventsFromOtlp, function:readNativeUsage
import { describe, expect, test } from "bun:test";
import {
  auditEventsFromOtlp,
  correlateAuditUsage,
  readNativeUsage,
  type NativeUsageRecord,
} from "../../scripts/telemetry-correlate.ts";
import { buildAuditOtlpExport, type AuditTelemetryEvent } from "../../core/tools/aidlc-telemetry.ts";

const BASE = Date.parse("2026-10-06T12:00:00Z");
function time(seconds: number): string {
  return new Date(BASE + seconds * 1_000).toISOString();
}

function event(type: string, seconds: number, extra: Record<string, string> = {}): AuditTelemetryEvent {
  return {
    eventType: type,
    timestamp: time(seconds),
    context: {
      schemaVersion: 1,
      eventId: `00000000-0000-4000-8000-${String(seconds).padStart(12, "0")}`,
      timeUnixNano: (BigInt(BASE + seconds * 1_000) * 1_000_000n).toString(),
      attributes: {
        "aidlc.harness.name": "codex",
        "gen_ai.conversation.id": "chat-a",
        "aidlc.intent.id": "00000000-0000-7000-8000-000000000001",
        "aidlc.stage.name": "code-generation",
        "aidlc.model.configured": "configured-model",
        "aidlc.effort.configured": "high",
        ...extra,
      },
    },
  };
}

const started = event("STAGE_STARTED", 0);
const completed = event("STAGE_COMPLETED", 10);
function usage(extra: Partial<NativeUsageRecord> = {}): NativeUsageRecord {
  return {
    id: "usage-1",
    harness: "codex",
    sessionId: "chat-a",
    startedAt: time(2),
    endedAt: time(3),
    temporality: "delta",
    model: "reported-model",
    effort: "medium",
    quantities: [
      { name: "input", value: 100, unit: "token" },
      { name: "output", value: 50, unit: "token" },
      { name: "cache_read", value: null, unit: "token" },
      { name: "billable", value: 0.25, unit: "credit" },
    ],
    ...extra,
  };
}

describe("reference telemetry correlation", () => {
  test("round-trips exported audit and links a delta without changing reported quantities/model/effort", () => {
    const audit = auditEventsFromOtlp(buildAuditOtlpExport([started, completed]));
    const native = readNativeUsage({ schemaVersion: 1, records: [usage()] });
    const [result] = correlateAuditUsage(audit, native);
    expect(result).toMatchObject({
      match: "stage-window",
      auditEventId: started.context.eventId,
      stage: "code-generation",
      configuredModel: "configured-model",
      configuredEffort: "high",
    });
    expect(result.usage).toEqual(usage());
    expect(result.usage.model).toBe("reported-model");
    expect(result.usage.effort).toBe("medium");
    expect(result.usage.quantities[2].value).toBeNull();
  });

  test("deduplicates replayed audit and source records; conflicts require correction", () => {
    expect(auditEventsFromOtlp(buildAuditOtlpExport([started, started]))).toHaveLength(1);
    expect(readNativeUsage({ schemaVersion: 1, records: [usage(), usage()] })).toHaveLength(1);
    expect(readNativeUsage({
      schemaVersion: 1,
      records: [usage(), { ...usage({ quantities: [...usage().quantities].reverse() }), prompt: "private" }],
    })).toHaveLength(1);
    expect(() => readNativeUsage({
      schemaVersion: 1, records: [usage(), usage({ model: "different-model" })],
    })).toThrow("Conflicting usage");
    expect(() => auditEventsFromOtlp(buildAuditOtlpExport([
      started, { ...started, eventType: "STAGE_COMPLETED" },
    ]))).toThrow("Conflicting audit");
  });

  test("exact event references check harness and session; stale references do not fall back to time", () => {
    const [exact] = correlateAuditUsage([started], [usage({ auditEventId: started.context.eventId })]);
    expect(exact.match).toBe("event-id");
    expect(correlateAuditUsage([started, completed], [
      usage({ auditEventId: started.context.eventId, sessionId: "other-chat" }),
      usage({ auditEventId: started.context.eventId, harness: "kiro" }),
      usage({ auditEventId: "unknown" }),
    ]).map((result) => result.reason)).toEqual([
      "event-context-mismatch", "event-context-mismatch", "unknown-event-id",
    ]);
  });

  test("overlapping stages, including a partially overlapping or unfinished stage, remain ambiguous", () => {
    for (const competing of [
      [event("STAGE_STARTED", 1, { "aidlc.unit.name": "other" }), event("STAGE_COMPLETED", 9, { "aidlc.unit.name": "other" })],
      [event("STAGE_STARTED", 2, { "aidlc.unit.name": "other" }), event("STAGE_COMPLETED", 9, { "aidlc.unit.name": "other" })],
      [event("STAGE_STARTED", 1, { "aidlc.unit.name": "other" })],
      [event("STAGE_STARTED", 1)],
    ]) {
      expect(correlateAuditUsage([started, completed, ...competing], [usage()])[0]).toMatchObject({
        match: "unattributed", reason: "ambiguous-stage-window",
      });
    }
  });

  test("missing sessions, wrapper IDs, cumulative credits, and cross-boundary aggregates are not guessed", () => {
    const results = correlateAuditUsage([started, completed], [
      usage({ sessionId: null }),
      usage({ sessionId: "synthetic-wrapper-id" }),
      usage({ harness: "kiro" }),
      usage({ temporality: "cumulative" }),
      usage({ startedAt: null }),
      usage({ startedAt: time(0) }),
      usage({ endedAt: time(12) }),
    ]);
    expect(results.every((result) => result.match === "unattributed")).toBe(true);
    expect(results.map((result) => result.reason)).toEqual([
      "missing-session", "no-bounded-stage-window", "no-bounded-stage-window",
      "cumulative-usage", "missing-interval", "crosses-stage-boundary", "crosses-stage-boundary",
    ]);
    expect(correlateAuditUsage([started], [usage()])[0].match).toBe("unattributed");
  });

  test("equal boundary timestamps and mismatched attempt generations do not create a window", () => {
    expect(correlateAuditUsage([started, event("STAGE_COMPLETED", 0)], [usage()])[0].match).toBe("unattributed");
    expect(correlateAuditUsage([
      { ...started, context: { ...started.context, attributes: { ...started.context.attributes, "aidlc.attempt.generation": "1" } } },
      event("STAGE_COMPLETED", 10, { "aidlc.attempt.generation": "2" }),
    ], [usage()])[0].match).toBe("unattributed");
  });

  test("invalid measurements and backward intervals are refused; unknown values stay null", () => {
    for (const bad of [
      usage({ quantities: [{ name: "input", value: -1, unit: "token" }] }),
      usage({ quantities: [{ name: "input", value: 1.5, unit: "token" }] }),
      usage({ startedAt: time(4), endedAt: time(3) }),
      usage({ startedAt: "2026-10-06 12:00:00" }),
    ]) {
      expect(() => readNativeUsage({ schemaVersion: 1, records: [bad] })).toThrow();
    }
    expect(readNativeUsage({ schemaVersion: 1, records: [usage()] })[0].quantities[2].value).toBeNull();
    expect(readNativeUsage({
      schemaVersion: 1, records: [{ ...usage(), prompt: "private" }],
    })[0]).not.toHaveProperty("prompt");
  });
});
