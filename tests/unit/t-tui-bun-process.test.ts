// Portable identity and Windows API-model controls. Real process fixtures are
// independently selectable in t-tui-bun-process-{linux,darwin}.test.ts.
import { describe, expect, test } from "bun:test";
import {
  darwinContainment, type DarwinProcessCalls,
  isDarwinDescendant, parseDarwinProcArgs, sameDarwinProcess,
  isLinuxDescendant, type LinuxProcessIdentity, parseLinuxProcStat, sameLinuxProcess,
  terminateWindowsJobMember, type WindowsJobTerminationApi,
  type WindowsJobTerminationObservation, windowsJobLimits,
} from "../harness/tui-bun-process.ts";
import type { DarwinProcessIdentity } from "../harness/tui-process-identity.ts";

function identity(pid: number, ppid: number, ticks: bigint): LinuxProcessIdentity {
  return { pid, ppid, startTicks: ticks, state: "S" };
}

describe("native supervisor identity checks", () => {
  test("proc stat parses comm containing parentheses/newlines and preserves 64-bit ticks", () => {
    const fields = ["S", "10", ...Array(17).fill("0"), "9007199254740993", "0"];
    expect(parseLinuxProcStat(`42 (a ) process\n(with spaces)) ${fields.join(" ")}\n`)).toEqual(
      identity(42, 10, 9007199254740993n),
    );
    for (const invalid of ["", "42 broken", "42 (comm) S 10", "0 (comm) S 10"]) {
      expect(() => parseLinuxProcStat(invalid)).toThrow("stat identity");
    }
  });

  test("PID equality alone does not establish process identity", () => {
    expect(sameLinuxProcess(identity(42, 1, 10n), identity(42, 2, 10n))).toBe(true);
    expect(sameLinuxProcess(identity(42, 1, 10n), identity(42, 1, 11n))).toBe(false);
  });

  test("owns descendants and reparented orphans, excludes unrelated processes and self", () => {
    const owner = identity(10, 1, 10n);
    const child = identity(20, 10, 20n);
    const detached = identity(30, 20, 30n);
    const orphan = identity(40, 10, 40n);
    const unrelated = identity(50, 1, 50n);
    const snapshot = new Map([owner, child, detached, orphan, unrelated].map((p) => [p.pid, p]));
    for (const owned of [child, detached, orphan]) {
      expect(isLinuxDescendant(owned, owner, snapshot)).toBe(true);
    }
    expect(isLinuxDescendant(owner, owner, snapshot)).toBe(false);
    expect(isLinuxDescendant(unrelated, owner, snapshot)).toBe(false);
  });

  test("refuses incomplete, cyclic and reused ancestry", () => {
    const owner = identity(10, 1, 10n);
    const child = identity(20, 10, 20n);
    const leaf = identity(30, 20, 30n);
    expect(isLinuxDescendant(leaf, owner, new Map([[10, owner], [30, leaf]]))).toBe(false);
    expect(isLinuxDescendant(leaf, owner, new Map([
      [10, owner], [20, identity(20, 10, 31n)], [30, leaf],
    ]))).toBe(false);
    expect(isLinuxDescendant(child, owner, new Map([
      [10, identity(10, 1, 11n)], [20, child],
    ]))).toBe(false);
    expect(isLinuxDescendant(leaf, owner, new Map([
      [10, owner], [20, identity(20, 30, 30n)], [30, leaf],
    ]))).toBe(false);
  });

  test("Win64 extended job limit buffer matches the Windows ABI, without breakaway flags", () => {
    const bytes = windowsJobLimits();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.byteLength).toBe(64 + 48 + 4 * 8);
    expect(view.getUint32(16, true)).toBe(0x2000);
    expect(view.getBigUint64(24, true)).toBe(0n); // SIZE_T MinimumWorkingSetSize, after padding
    expect(view.getUint32(40, true)).toBe(0); // ActiveProcessLimit
    expect(view.getBigUint64(112, true)).toBe(0n); // ProcessMemoryLimit
    expect([...bytes].filter((byte) => byte !== 0)).toEqual([0x20]);
  });
});

describe("Darwin supervisor ownership checks", () => {
  function darwin(pid: number, ppid: number, startUsec: bigint, env: string[] = []): DarwinProcessIdentity {
    return { pid, ppid, uid: 501, status: 2, startSec: 1_700_000_000n, startUsec, env };
  }

  function procargs(argv: string[], env: string[]): Buffer {
    const argc = Buffer.alloc(4);
    argc.writeUInt32LE(argv.length);
    return Buffer.concat([argc, Buffer.from(`/opt/bun\0\0\0${[...argv, ...env].join("\0")}\0`)]);
  }

  test("process arguments distinguish argv from environment and reject truncated strings", () => {
    const marker = "AIDLC_TUI_CONTAINMENT=private-token";
    const bytes = procargs(["bun", "", "fixture.ts"], ["PATH=/bin", marker, "EMPTY="]);
    expect(parseDarwinProcArgs(bytes).env).toEqual(["PATH=/bin", marker, "EMPTY="]);
    expect(parseDarwinProcArgs(procargs(["bun", marker], ["PATH=/bin"])).env).toEqual(["PATH=/bin"]);
    expect(parseDarwinProcArgs(procargs(["bun"], [])).env).toEqual([]);
    for (const truncated of [bytes.subarray(0, 3), bytes.subarray(0, 8), bytes.subarray(0, -1)]) {
      expect(() => parseDarwinProcArgs(truncated)).toThrow("truncated Darwin process arguments");
    }
    const badArgc = Buffer.from(bytes);
    badArgc.writeUInt32LE(bytes.length);
    expect(() => parseDarwinProcArgs(badArgc)).toThrow("Darwin process arguments");
  });

  test("an inherited token owns a detached orphan but never a different uid or the supervisor", () => {
    const owner = darwin(10, 1, 10n);
    const orphan = darwin(30, 1, 30n, ["AIDLC_TUI_CONTAINMENT=ours"]);
    const other = darwin(40, 1, 40n, ["AIDLC_TUI_CONTAINMENT=other"]);
    const snapshot = new Map([owner, orphan, other].map((identity) => [identity.pid, identity]));
    expect(isDarwinDescendant(orphan, owner, snapshot, "ours")).toBe(true);
    expect(isDarwinDescendant(other, owner, snapshot, "ours")).toBe(false);
    expect(isDarwinDescendant({ ...orphan, uid: 502 }, owner, snapshot, "ours")).toBe(false);
    expect(isDarwinDescendant({ ...owner, env: orphan.env }, owner, snapshot, "ours")).toBe(false);
  });

  test("verified ancestry owns descendants without tokens but rejects incomplete and reused ancestors", () => {
    const owner = darwin(10, 1, 10n);
    const child = darwin(20, 10, 20n);
    const leaf = darwin(30, 20, 30n);
    const snapshot = new Map([owner, child, leaf].map((identity) => [identity.pid, identity]));
    expect(isDarwinDescendant(leaf, owner, snapshot, "ours")).toBe(true);
    snapshot.delete(child.pid);
    expect(isDarwinDescendant(leaf, owner, snapshot, "ours")).toBe(false);
    snapshot.set(child.pid, { ...child, startUsec: 31n });
    expect(isDarwinDescendant(leaf, owner, snapshot, "ours")).toBe(false);
    snapshot.set(child.pid, child);
    snapshot.set(owner.pid, { ...owner, startUsec: 11n });
    expect(isDarwinDescendant(leaf, owner, snapshot, "ours")).toBe(false);
    snapshot.set(owner.pid, owner);
    snapshot.set(child.pid, { ...child, ppid: leaf.pid, startUsec: leaf.startUsec });
    expect(isDarwinDescendant(leaf, owner, snapshot, "ours")).toBe(false);
  });

  test("start seconds and microseconds reject PID reuse even with a stale ownership token", () => {
    const owner = darwin(10, 1, 10n);
    const stale = darwin(20, 1, 20n, ["AIDLC_TUI_CONTAINMENT=ours"]);
    const reused = { ...stale, startUsec: 21n, env: [] };
    expect(sameDarwinProcess(stale, { ...stale, ppid: 100 })).toBe(true);
    expect(sameDarwinProcess(stale, reused)).toBe(false);
    expect(sameDarwinProcess(stale, { ...stale, startSec: stale.startSec + 1n })).toBe(false);
    expect(isDarwinDescendant(stale, owner, new Map([[owner.pid, owner], [reused.pid, reused]]), "ours"))
      .toBe(false);
  });
});

/** KERN_PROCARGS2 bytes: argc, executable path, padding, argv, then environ. */
function procArgs(env: string[]): Uint8Array {
  const argc = Buffer.alloc(4);
  argc.writeUInt32LE(1, 0);
  return Buffer.concat([argc, Buffer.from(`/bin/sleep\0\0\0sleep\0${env.map((value) => `${value}\0`).join("")}\0`)]);
}

/** Synthetic PIDs that never collide with this process or its parent. */
function fixturePids(count: number): number[] {
  const pids: number[] = [];
  for (let pid = 5001; pids.length < count; pid++) {
    if (pid !== process.pid && pid !== process.ppid) pids.push(pid);
  }
  return pids;
}

/** A fake libSystem over a process table; the supervisor is this process. */
function darwinTable(options: {
  unreadableOnArgs?: boolean; detachedTokenBearer?: boolean; unrelatedMalformed?: boolean;
} = {}) {
  type Row = { ppid: number; uid: number; start: bigint; state: "readable" | "unreadable" | "gone" };
  const [child, detached, unrelated] = fixturePids(3);
  const rows = new Map<number, Row>([
    [process.ppid, { ppid: 1, uid: 501, start: 1000n, state: "readable" }],
    [process.pid, { ppid: process.ppid, uid: 501, start: 2000n, state: "readable" }],
    [child, { ppid: process.pid, uid: 501, start: 3000n, state: "readable" }],
  ]);
  // A double-forked descendant under launchd, owned only through the token.
  if (options.detachedTokenBearer) rows.set(detached, { ppid: 1, uid: 501, start: 4000n, state: "readable" });
  // Another same-user process under launchd with no token and no ancestry.
  if (options.unrelatedMalformed) rows.set(unrelated, { ppid: 1, uid: 501, start: 5000n, state: "readable" });
  let malformedOnce = options.unrelatedMalformed === true;
  const signaled: number[] = [];
  const api: DarwinProcessCalls = {
    tui_listpids(buffer) {
      const pids = [...rows].filter(([, row]) => row.state !== "gone").map(([pid]) => pid);
      buffer.set(pids);
      return pids.length * 4;
    },
    tui_pidinfo(pid, buffer) {
      const row = rows.get(pid);
      if (!row || row.state === "gone") return -3; // ESRCH
      if (row.state === "unreadable") return -1; // EPERM
      buffer.fill(0);
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      view.setUint32(4, 2, true); // SRUN
      view.setUint32(12, pid, true);
      view.setUint32(16, row.ppid, true);
      view.setUint32(20, row.uid, true);
      view.setBigUint64(120, row.start, true);
      return 136;
    },
    tui_argmax: () => 4096,
    tui_procargs(pid, buffer) {
      // Arguments are hidden, so ownership comes from ancestry. Optionally the
      // descendant turns unreadable between the scan and its recheck.
      if (options.unreadableOnArgs && pid === child) rows.get(child)!.state = "unreadable";
      if (options.detachedTokenBearer && pid === detached && rows.get(detached)!.state === "readable") {
        // Its token-bearing arguments read, then it turns unreadable (setuid exec).
        const args = procArgs([`AIDLC_TUI_CONTAINMENT=${containment.env!.AIDLC_TUI_CONTAINMENT}`]);
        buffer.set(args);
        rows.get(detached)!.state = "unreadable";
        return args.length;
      }
      if (malformedOnce && pid === unrelated) {
        // Positive but malformed arguments, then EPERM on the recheck.
        malformedOnce = false;
        buffer.set([0xff, 0xff, 0xff]);
        rows.get(unrelated)!.state = "unreadable";
        return 3;
      }
      return -1;
    },
    tui_kill(pid) { signaled.push(pid); return 0; },
    tui_waitid: () => -10, // ECHILD: the survivor is not the supervisor's child.
  };
  const containment = darwinContainment(process.ppid, api, null);
  if (options.detachedTokenBearer || options.unrelatedMalformed) rows.get(child)!.state = "gone";
  return { rows, signaled, containment, child, detached, unrelated };
}

describe("Darwin containment rechecks", () => {
  // Full Suite 36341941597 (t29, macOS): a scanned descendant that becomes
  // EPERM-unreadable (a setuid exec such as /bin/ps, or a reused PID) proves
  // neither exit nor replacement, so it must neither fail nor finish cleanup,
  // and an unverified process must never be signaled.
  const deadline = () => Date.now() + 60_000;

  test("an owned process that stays unreadable keeps cleanup unconfirmed until it is gone", () => {
    const { rows, signaled, containment, child } = darwinTable();
    expect(containment.sweep(false, undefined, deadline())).toBe(false);
    expect(signaled).toEqual([child]);
    rows.get(child)!.state = "unreadable";
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    expect(signaled).toEqual([child]);
    rows.get(child)!.state = "gone";
    expect(containment.sweep(true, undefined, deadline())).toBe(true);
  });

  test("a detached token-bearing process that turns unreadable after its arguments are read stays unresolved", () => {
    const { rows, signaled, containment, detached } = darwinTable({ detachedTokenBearer: true });
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    expect(signaled).toEqual([]);
    rows.get(detached)!.state = "gone";
    expect(containment.sweep(true, undefined, deadline())).toBe(true);
  });

  test("an unrelated process with malformed arguments blocks completion while unreadable but is never signaled", () => {
    const { rows, signaled, containment, unrelated } = darwinTable({ unrelatedMalformed: true });
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    rows.get(unrelated)!.state = "readable"; // Readable again, with neither token nor ancestry.
    expect(containment.sweep(true, undefined, deadline())).toBe(true);
    expect(containment.sweep(true, undefined, deadline())).toBe(true);
    expect(signaled).toEqual([]);
  });

  test("a process that turns unreadable before its signal is kept unsignaled without failing the sweep", () => {
    const { rows, signaled, containment, child } = darwinTable({ unreadableOnArgs: true });
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    expect(signaled).toEqual([]);
    expect(containment.sweep(true, undefined, deadline())).toBe(false);
    rows.get(child)!.state = "gone";
    expect(containment.sweep(true, undefined, deadline())).toBe(true);
  });
});

describe("Windows job member termination races", () => {
  const processHandle = { kind: "process" };
  const jobHandle = { kind: "job" };
  function apiFor(waits: number[], terminateError = 5, membership = 1) {
    const calls: Array<{ method: string; handle: object; value?: number }> = [];
    let error = terminateError;
    const api: WindowsJobTerminationApi<object> = {
      IsProcessInJob(handle, job, member) {
        expect(job).toBe(jobHandle);
        calls.push({ method: "membership", handle });
        member[0] = membership;
        return 1;
      },
      TerminateProcess(handle, code) {
        calls.push({ method: "terminate", handle, value: code });
        error = terminateError;
        return terminateError === 0 ? 1 : 0;
      },
      WaitForSingleObject(handle, milliseconds) {
        calls.push({ method: "wait", handle, value: milliseconds });
        if (!waits.length) throw new Error("unexpected extra wait");
        const state = waits.shift()!;
        if (state === 0xffffffff) error = 6;
        return state;
      },
      GetLastError() { return error; },
    };
    return { api, calls };
  }

  test("access denied during concurrent termination waits on the same handle within the remaining budget", () => {
    const { api, calls } = apiFor([258, 258, 0]);
    const observations: WindowsJobTerminationObservation[] = [];
    let clock = 1000;
    terminateWindowsJobMember(api, processHandle, jobHandle, 42, 1500,
      () => { const now = clock; clock += 75; return now; }, (event) => observations.push(event));
    expect(calls.map(({ method, value }) => [method, value])).toEqual([
      ["membership", undefined], ["wait", 0], ["terminate", 1], ["wait", 0], ["wait", 425],
    ]);
    expect(calls.every((call) => call.handle === processHandle)).toBe(true);
    expect(observations).toEqual([{
      pid: 42, terminateError: 5, initialWait: 258, waitBudgetMs: 425, finalWait: 0, waitError: undefined,
    }]);
  });

  test("an already signaled member needs no termination, and an accepted termination needs no error retry", () => {
    const gone = apiFor([0]);
    terminateWindowsJobMember(gone.api, processHandle, jobHandle, 42, 1000, () => 0);
    expect(gone.calls.some((call) => call.method === "terminate")).toBe(false);
    const accepted = apiFor([258], 0);
    terminateWindowsJobMember(accepted.api, processHandle, jobHandle, 42, 1000, () => 0);
    expect(accepted.calls.filter((call) => call.method === "wait")).toHaveLength(1);
  });

  test("a process signaled immediately after access denied does not spend the cleanup budget", () => {
    const { api, calls } = apiFor([258, 0]);
    terminateWindowsJobMember(api, processHandle, jobHandle, 42, 1000, () => 0);
    expect(calls.filter((call) => call.method === "wait").map((call) => call.value)).toEqual([0, 0]);
  });

  test("persistent denial remains an error after one finite wait, with PID and wait evidence", () => {
    const { api, calls } = apiFor([258, 258, 258]);
    const observations: WindowsJobTerminationObservation[] = [];
    expect(() => terminateWindowsJobMember(api, processHandle, jobHandle, 42, 400,
      () => 100, (event) => observations.push(event))).toThrow(
      "TerminateProcess(job member 42) failed: Windows error 5; initial wait=258; final wait=258; waited at most 300ms",
    );
    expect(calls.filter((call) => call.method === "wait").map((call) => call.value)).toEqual([0, 0, 300]);
    expect(observations[0].finalWait).toBe(258);
  });

  test("a wait failure and an unexpected termination error cannot become successful cleanup", () => {
    const failedWait = apiFor([258, 258, 0xffffffff]);
    expect(() => terminateWindowsJobMember(failedWait.api, processHandle, jobHandle, 42, 500, () => 0))
      .toThrow("wait error=6");
    const unexpected = apiFor([258, 258], 87);
    expect(() => terminateWindowsJobMember(unexpected.api, processHandle, jobHandle, 42, 500, () => 0))
      .toThrow("Windows error 87");
    expect(unexpected.calls.filter((call) => call.method === "wait").every((call) => call.value === 0)).toBe(true);
  });

  test("ownership changes and expired deadlines refuse termination", () => {
    const otherJob = apiFor([], 5, 0);
    expect(() => terminateWindowsJobMember(otherJob.api, processHandle, jobHandle, 42, 500, () => 0))
      .toThrow("ownership changed");
    expect(otherJob.calls.map((call) => call.method)).toEqual(["membership"]);
    const expired = apiFor([]);
    expect(() => terminateWindowsJobMember(expired.api, processHandle, jobHandle, 42, 500, () => 500))
      .toThrow("deadline");
    expect(expired.calls).toEqual([]);
  });

  test("a deadline consumed by earlier operations cannot be restarted after access denied", () => {
    const { api, calls } = apiFor([258, 258]);
    let read = 0;
    expect(() => terminateWindowsJobMember(api, processHandle, jobHandle, 42, 500,
      () => read++ === 0 ? 0 : 500)).toThrow("waited at most 0ms");
    expect(calls.filter((call) => call.method === "wait").map((call) => call.value)).toEqual([0, 0]);
  });
});
