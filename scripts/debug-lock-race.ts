// DEBUG ONLY (debug/windows-lock-livelock): repeat t46's five-process audit
// race under load and keep the lock traces of every race that stalls.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, FIXTURES_DIR, seedAuditFile, seedStateFile,
} from "../tests/harness/fixtures.ts";

const races = Number(process.argv[2] ?? 40);
const loops = Number(process.argv[3] ?? 3);
const out = process.argv[4] ?? "tmp/lock-race";
mkdirSync(out, { recursive: true });
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

async function race(loop: number, r: number) {
  const proj = createTestProject();
  seedAuditFile(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
  mkdirSync(join(proj, "aidlc"), { recursive: true });
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), "cccccccccccc\n", "utf-8");
  const trace = join(out, `l${loop}-r${r}`);
  mkdirSync(trace, { recursive: true });
  const start = performance.now();
  // t46's sampler: list only the temp directory's lock names every 50 ms.
  const sampler = setInterval(() => { try { readdirSync(tmpdir()).filter((name) => name.startsWith(".aidlc-audit-")); } catch { /* best effort */ } }, 50);
  const procs = Array.from({ length: Number(process.env.DEBUG_CONTENDERS ?? 5) }, (_, n) => n + 1).map((i) => Bun.spawn({
    cmd: [process.execPath, BOLT, "start", "--name", `unit-${i}`, "--batch", "1", "--walking-skeleton", "false", "--project-dir", proj],
    stdout: "pipe", stderr: "pipe", timeout: 150_000,
    env: { ...process.env, AIDLC_LOCK_TRACE_DIR: trace, AIDLC_AUDIT_LOCK_TIMEOUT_MS: "60000" },
  }));
  const children = await Promise.all(procs.map(async (p, index) => {
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text(), new Response(p.stdout).text()]);
    return { unit: index + 1, pid: p.pid, code, signal: p.signalCode, ms: Math.round(performance.now() - start), stderr: stderr.slice(0, 2000) };
  }));
  clearInterval(sampler);
  const ms = Math.round(performance.now() - start);
  const stalled = process.env.DEBUG_KEEP === "1" || ms > 45_000 || children.some((child) => child.code !== 0);
  writeFileSync(join(trace, "race.json"), JSON.stringify({ loop, r, ms, stalled, children }, null, 1));
  if (!stalled) rmSync(trace, { recursive: true, force: true });
  cleanupTestProject(proj);
  console.log(JSON.stringify({ loop, r, ms, stalled, codes: children.map((child) => child.code) }));
  return { ms, stalled };
}

// Oversubscribe the CPU like a parallel integration tier on a 4-vCPU runner.
const burners = Array.from({ length: Number(process.env.DEBUG_BURNERS ?? 0) }, () =>
  Bun.spawn({ cmd: [process.execPath, "-e", "for(;;){}"], stdout: "ignore", stderr: "ignore" }));
const all = await Promise.all(Array.from({ length: loops }, async (_, loop) => {
  const results: Array<{ ms: number; stalled: boolean }> = [];
  for (let r = 1; r <= races; r++) results.push(await race(loop, r));
  return results;
}));
for (const burner of burners) burner.kill();
const flat = all.flat();
const summary = {
  races: flat.length, stalled: flat.filter((x) => x.stalled).length,
  maxMs: Math.max(...flat.map((x) => x.ms)), medianMs: flat.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(flat.length / 2)],
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
