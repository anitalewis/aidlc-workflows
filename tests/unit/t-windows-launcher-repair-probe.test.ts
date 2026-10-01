// Temporary native Windows diagnostic; copied fixture keeps the original assertions.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activate, previousWindowsShimHelpers } from "../../core/tools/aidlc-lifecycle.ts";
import { commandPath, machineTransactionRoot } from "../../core/tools/aidlc-install-paths.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import { NATIVE_COMPILE_TIMEOUT_MS, NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
const REPO_ROOT = join(import.meta.dir, "../..");
const [major, minor, patch] = AIDLC_VERSION.split(".").map(Number);
const NEXT_VERSION = `${major}.${minor}.${patch + 1}`;
const temporary: string[] = [];
function temp(prefix: string): string { const root = mkdtempSync(join(realpathSync(tmpdir()), prefix)); temporary.push(root); return root; }
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
  test.skipIf(process.platform !== "win32").each([
    AIDLC_VERSION, `${NEXT_VERSION}-preview.20260930.1`,
  ])(
    "a fixed Windows binary replaces the previous launcher helper an update left (%s)",
    (fixtureVersion) => {
      const machine = temp("aidlc-t244-windows-helper-");
      const root = join(machine, "versions", fixtureVersion);
      const executable = join(root, "aidlc.exe");
      mkdirSync(root, { recursive: true });
      const runtime = join(root, "runtime", "claude");
      cpSync(join(REPO_ROOT, "dist-release", "claude"), runtime, { recursive: true });
      const stampPath = join(runtime, ".claude", "tools", "data", "aidlc-stamp.json");
      const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as {
        frameworkVersion: string;
      };
      writeFileSync(
        stampPath,
        `${JSON.stringify({ ...stamp, frameworkVersion: fixtureVersion }, null, 2)}\n`,
      );
      // Compile the same fixture version recorded by its runtime and manifest.
      // The shared dist-release may have been packaged for a preview release.
      writeFileSync(
        join(runtime, ".claude", "tools", "aidlc-version.ts"),
        `export const AIDLC_VERSION = ${JSON.stringify(fixtureVersion)};\n`,
      );
      const tracePath = join(machine, "repair-trace.jsonl");
      const tracePrelude = `import { appendFileSync as appendRepairTrace } from "node:fs";
function traceRepair(value: unknown): void { appendRepairTrace(${JSON.stringify(tracePath)}, JSON.stringify(value) + "\\n"); }
`;
      const lifecyclePath = join(runtime, ".claude", "tools", "aidlc-lifecycle.ts");
      let lifecycleSource = readFileSync(lifecyclePath, "utf-8").replace(/^#!.*\n/, "");
      const functionStart = lifecycleSource.indexOf("export function replacePreviousWindowsShimHelper(): void {");
      const functionEnd = lifecycleSource.indexOf("\nasync function installVersion", functionStart);
      let repairSource = lifecycleSource.slice(functionStart, functionEnd);
      repairSource = repairSource.replace("  try {", `  traceRepair({ phase: "repair entry", execPath: process.execPath });\n  try {`);
      repairSource = repairSource.replace('    if (\n      !previousWindowsShimHelpers().includes(helper)', `    traceRepair({ phase: "ownership", helperKnown: previousWindowsShimHelpers().includes(helper), commandMatches: readFileSync(commandPath(), "utf-8") === windowsShim() });\n    if (\n      !previousWindowsShimHelpers().includes(helper)`);
      repairSource = repairSource.replace("    if (\n      !version", `    traceRepair({ phase: "identity", version, active, expected: version ? resolve(installedExecutablePath(version)) : null, running: canonicalPolicyPath(process.execPath), scope: process.env.AIDLC_ROUTE_MUTATION_SCOPE });\n    if (\n      !version`);
      repairSource = repairSource.replace("    executePlan({", `    traceRepair({ phase: "transaction", root });\n    executePlan({`);
      repairSource = repairSource.replace("  } catch {", `    traceRepair({ phase: "updated" });\n  } catch (error) {\n    traceRepair({ phase: "repair error", error: String(error), stack: error instanceof Error ? error.stack : null, cause: error instanceof Error ? String(error.cause) : null });`);
      lifecycleSource = tracePrelude + lifecycleSource.slice(0, functionStart) + repairSource + lifecycleSource.slice(functionEnd);
      writeFileSync(lifecyclePath, lifecycleSource);
      const dispatcherPath = join(runtime, ".claude", "tools", "aidlc.ts");
      let dispatcherSource = readFileSync(dispatcherPath, "utf-8").replace(/^#!.*\n/, "");
      dispatcherSource = dispatcherSource.replace('      const helper = join(dirname(dirname(dirname(process.execPath))), "aidlc-shim.ps1");', `      const helper = join(dirname(dirname(dirname(process.execPath))), "aidlc-shim.ps1");\n      traceRepair({ phase: "dispatcher", execPath: process.execPath, helper, content: readFileSync(helper, "utf-8").includes("& $executable @args") });`);
      dispatcherSource = dispatcherSource.replace("      // A binary run from outside an install has no helper to replace.", '      traceRepair({ phase: "dispatcher repair skipped" });');
      writeFileSync(dispatcherPath, tracePrelude + dispatcherSource);
      // The dispatcher build-binaries.ts ships, because the replacement runs
      // in its main before any route.
      const dispatcher = spawnSync(
        process.execPath,
        [
          "build",
          "--compile",
          join(runtime, ".claude", "tools", "aidlc.ts"),
          "--outfile",
          executable,
        ],
        { cwd: REPO_ROOT, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) },
      );
      expect(dispatcher.status, `${dispatcher.stdout}\n${dispatcher.stderr}`).toBe(0);
      const source = join(machine, "probe-fixture.ts");
      const probe = join(machine, "probe-fixture.exe");
      writeFileSync(
        source,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");\n',
      );
      const build = spawnSync(
        process.execPath,
        ["build", "--compile", source, "--outfile", probe],
        { encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_COMPILE_TIMEOUT_MS) },
      );
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      writeFileSync(
        join(root, "version.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          version: fixtureVersion,
          date: "2026-09-28",
          distributions: [{ name: "claude", productName: "Claude Code" }],
          assets: [{
            name: "aidlc-windows-x64.exe",
            sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
            bytes: statSync(executable).size,
            kind: "binary",
            target: "windows-x64",
          }],
        }, null, 2)}\n`,
      );

      const saved = {
        root: process.env.AIDLC_INSTALL_ROOT,
        bin: process.env.AIDLC_BIN_DIR,
      };
      process.env.AIDLC_INSTALL_ROOT = machine;
      process.env.AIDLC_BIN_DIR = join(machine, "bin");
      const launch = (...args: string[]) => {
        const result = Bun.spawnSync(
          [commandPath(), ...args],
          {
            cwd: machine,
            // Bun.spawnSync does not pass later process.env changes on its own,
            // and the replacement finds the install through AIDLC_INSTALL_ROOT.
            env: { ...process.env },
            timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return {
          exitCode: result.exitCode,
          stdout: Buffer.from(result.stdout).toString("utf-8").trim(),
          stderr: Buffer.from(result.stderr).toString("utf-8").trim(),
        };
      };
      const helperPath = join(machine, "aidlc-shim.ps1");
      const versionLine = `aidlc ${fixtureVersion} (runtime ${fixtureVersion})`;
      try {
        activate(fixtureVersion);
        const current = readFileSync(helperPath, "utf-8");
        const shim = readFileSync(commandPath(), "utf-8");
        // What `aidlc update` from a release without the reasoned helper leaves.
        const [previous] = previousWindowsShimHelpers();
        expect(previous).not.toBe(current);
        writeFileSync(helperPath, previous);

        // A launcher or helper the installer did not write is left alone.
        writeFileSync(commandPath(), `${shim}rem local change\r\n`);
        expect(launch("version").stdout).toBe(versionLine);
        expect(readFileSync(helperPath, "utf-8")).toBe(previous);
        writeFileSync(commandPath(), shim);
        writeFileSync(helperPath, `${previous}# local change\r\n`);
        expect(launch("version").stdout).toBe(versionLine);
        expect(readFileSync(helperPath, "utf-8")).toBe(`${previous}# local change\r\n`);
        writeFileSync(helperPath, previous);

        // While another mutation holds the machine lock, as the update does
        // during its version probe, the command runs without waiting and
        // leaves the helper for the next command.
        const lock = join(machineTransactionRoot(), ".aidlc-transaction.lock");
        writeFileSync(lock, `${JSON.stringify({ pid: process.pid, staging: ".aidlc-txn-held" })}\n`);
        const held = launch("version");
        expect(held.exitCode, held.stderr).toBe(0);
        expect(held.stdout).toBe(versionLine);
        expect(readFileSync(helperPath, "utf-8")).toBe(previous);
        rmSync(lock);

        const replaced = launch("version");
        expect(replaced.exitCode, replaced.stderr).toBe(0);
        expect(replaced.stdout).toBe(versionLine);
        expect(replaced.stderr).toBe("");
        expect(readFileSync(helperPath, "utf-8"), existsSync(tracePath) ? readFileSync(tracePath, "utf-8") : "No repair trace").toBe(current);
        expect(existsSync(lock)).toBe(false);

        // The replaced helper forwards the engine's intent create command whole.
        cpSync(probe, executable);
        const intent = [
          "engine",
          "intent",
          "create",
          "--scope",
          "express",
          "--arguments=build a simple to-do list web app",
          "--label",
          "todo-app",
        ];
        const created = launch(...intent);
        expect(created.exitCode, created.stderr).toBe(0);
        expect(JSON.parse(created.stdout)).toEqual(intent);
      } finally {
        if (saved.root === undefined) delete process.env.AIDLC_INSTALL_ROOT;
        else process.env.AIDLC_INSTALL_ROOT = saved.root;
        if (saved.bin === undefined) delete process.env.AIDLC_BIN_DIR;
        else process.env.AIDLC_BIN_DIR = saved.bin;
      }
    },
    NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  );
