import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmergencyKillSwitch, signKillSwitchClearance } from "../../src/operations/kill-switch";
import { runHealthChecks, writableDirectoryCheck } from "../../src/operations/health";
import { LocalSupervisor } from "../../src/operations/supervisor";

const temporaryPaths: string[] = [];
afterEach(async () => Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("autonomous operations control plane", () => {
  it("fails closed when kill-switch state is missing, and supports a bounded clearance", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    const now = new Date("2026-08-27T12:00:00.000Z");
    const killSwitch = new EmergencyKillSwitch(join(root, "kill-switch.json"), () => now);
    await expect(killSwitch.assertAutonomousAllowed()).rejects.toThrow(/engaged/u);
    await killSwitch.clear({
      authorizationId: "clearance-1",
      actor: "operator",
      issuedAt: "2026-08-27T11:00:00.000Z",
      expiresAt: "2026-08-27T13:00:00.000Z",
      reason: "bounded test pilot",
    });
    await expect(killSwitch.assertAutonomousAllowed()).resolves.toMatchObject({ status: "CLEARED" });
    await killSwitch.engage("emergency test", "operator");
    await expect(killSwitch.assertAutonomousAllowed()).rejects.toThrow(/emergency test/u);
  });

  it("requires and verifies a contract signature for production clearance", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    const now = new Date("2026-08-27T12:00:00.000Z");
    const killSwitch = new EmergencyKillSwitch(join(root, "kill-switch.json"), () => now);
    const clearance = {
      authorizationId: "clearance-signed-1",
      actor: "operator",
      issuedAt: "2026-08-27T11:00:00.000Z",
      expiresAt: "2026-08-27T13:00:00.000Z",
      reason: "signed test pilot",
    };
    await expect(killSwitch.clear(clearance, { contractSecret: "contract-secret", expectedKeyId: "contract-v1", requireSignature: true })).rejects.toThrow(/signature is required/u);
    const signed = signKillSwitchClearance(clearance, "contract-v1", "contract-secret");
    await expect(killSwitch.clear(signed, { contractSecret: "contract-secret", expectedKeyId: "contract-v1", requireSignature: true })).resolves.toMatchObject({ status: "CLEARED" });
    await expect(killSwitch.clear({ ...signed, signature: "0".repeat(64) }, { contractSecret: "contract-secret", expectedKeyId: "contract-v1", requireSignature: true })).rejects.toThrow(/signature is invalid/u);
  });

  it("acquires a singleton lease, writes heartbeats, and releases recoverably", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    const options = { lockPath: join(root, "supervisor.lock.json"), heartbeatPath: join(root, "heartbeat.json"), mode: "FIXTURE_DRY_RUN" as const, isProcessAlive: (pid: number) => pid === process.pid };
    const first = new LocalSupervisor(options);
    await first.acquire();
    await expect(new LocalSupervisor(options).acquire()).rejects.toThrow(/already running/u);
    await first.heartbeat("RUNNING", { runId: "run-1" });
    expect(JSON.parse(await readFile(options.heartbeatPath, "utf8"))).toMatchObject({ status: "RUNNING", runId: "run-1" });
    await first.release();
    await expect(new LocalSupervisor(options).acquire()).resolves.toMatchObject({ pid: process.pid });
  });

  it("fails closed when a live supervisor heartbeat is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    let now = new Date("2026-08-27T12:00:00.000Z");
    const options = {
      lockPath: join(root, "supervisor.lock.json"),
      heartbeatPath: join(root, "heartbeat.json"),
      mode: "AUTHORIZED_AUTONOMOUS",
      isProcessAlive: (pid: number) => pid === process.pid,
      now: () => now,
      heartbeatStaleAfterMs: 1_000,
    };
    const first = new LocalSupervisor(options);
    await first.acquire();
    now = new Date("2026-08-27T12:00:02.000Z");
    await expect(new LocalSupervisor(options).acquire()).rejects.toThrow(/heartbeat is stale.*operator intervention/u);
    await first.release();
  });

  it("quarantines a malformed lease so a crashed run can recover", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    const options = { lockPath: join(root, "supervisor.lock.json"), heartbeatPath: join(root, "heartbeat.json"), mode: "FIXTURE_DRY_RUN" as const, isProcessAlive: () => false };
    await writeFile(options.lockPath, "not-json", "utf8");
    await expect(new LocalSupervisor(options).acquire()).resolves.toMatchObject({ pid: process.pid });
    await expect(readFile(options.lockPath, "utf8")).resolves.toContain("schemaVersion");
  });

  it("preserves a failed heartbeat when releasing the supervisor", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    const options = { lockPath: join(root, "supervisor.lock.json"), heartbeatPath: join(root, "heartbeat.json"), mode: "AUTHORIZED_AUTONOMOUS" as const };
    const supervisor = new LocalSupervisor(options);
    await supervisor.acquire();
    await supervisor.heartbeat("FAILED", { message: "cycle failed" });
    await supervisor.release();
    expect(JSON.parse(await readFile(options.heartbeatPath, "utf8"))).toMatchObject({ status: "FAILED", message: "cycle failed" });
  });

  it("reports readiness as degraded for warnings and not-ready for failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "moltbook-ops-"));
    temporaryPaths.push(root);
    const report = await runHealthChecks([
      () => writableDirectoryCheck(root),
      () => ({ name: "expected-warning", status: "WARN" as const, message: "pilot not enabled", checkedAt: new Date().toISOString() }),
    ]);
    expect(report.status).toBe("DEGRADED");
    const failed = await runHealthChecks([() => ({ name: "failed", status: "FAIL" as const, message: "no secret", checkedAt: new Date().toISOString() })]);
    expect(failed.status).toBe("NOT_READY");
  });
});
