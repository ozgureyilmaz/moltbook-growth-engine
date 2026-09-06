import { hostname } from "node:os";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SupervisorLeaseSchema = z.object({
  schemaVersion: z.literal("1.0"),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  acquiredAt: z.string().datetime({ offset: true }),
  heartbeatAt: z.string().datetime({ offset: true }),
  mode: z.string().min(1),
}).strict();

export const RuntimeHeartbeatSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED", "STOPPED"]),
  pid: z.number().int().positive(),
  mode: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true }),
  runId: z.string().min(1).optional(),
  message: z.string().optional(),
}).strict();

export type SupervisorLease = z.infer<typeof SupervisorLeaseSchema>;
export type RuntimeHeartbeat = z.infer<typeof RuntimeHeartbeatSchema>;

export type LocalSupervisorOptions = {
  lockPath?: string;
  heartbeatPath?: string;
  mode: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  heartbeatStaleAfterMs?: number;
};

export class LocalSupervisor {
  private readonly lockPath: string;
  private readonly heartbeatPath: string;
  private readonly now: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly heartbeatStaleAfterMs: number;
  private acquired = false;

  public constructor(private readonly options: LocalSupervisorOptions) {
    this.lockPath = options.lockPath ?? "data/runtime/supervisor.lock.json";
    this.heartbeatPath = options.heartbeatPath ?? "data/runtime/heartbeat.json";
    this.now = options.now ?? (() => new Date());
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.heartbeatStaleAfterMs = Math.max(1, options.heartbeatStaleAfterMs ?? 900_000);
  }

  public async acquire(): Promise<SupervisorLease> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    const existing = await this.readLease();
    if (existing && this.isProcessAlive(existing.pid)) {
      const ageMs = this.now().getTime() - Date.parse(existing.heartbeatAt);
      if (ageMs > this.heartbeatStaleAfterMs) throw new Error(`Supervisor heartbeat is stale for live pid ${existing.pid}; operator intervention is required`);
      throw new Error(`Supervisor is already running with pid ${existing.pid}`);
    }
    await this.quarantineLeaseIfPresent();
    const timestamp = this.now().toISOString();
    const lease = SupervisorLeaseSchema.parse({ schemaVersion: "1.0", pid: process.pid, host: hostname(), acquiredAt: timestamp, heartbeatAt: timestamp, mode: this.options.mode });
    const handle = await open(this.lockPath, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
    this.acquired = true;
    await this.heartbeat("STARTING");
    return lease;
  }

  public async heartbeat(status: RuntimeHeartbeat["status"], details: { runId?: string; message?: string } = {}): Promise<RuntimeHeartbeat> {
    if (!this.acquired && status !== "STOPPED") throw new Error("Supervisor lease has not been acquired");
    const value = RuntimeHeartbeatSchema.parse({ schemaVersion: "1.0", status, pid: process.pid, mode: this.options.mode, updatedAt: this.now().toISOString(), ...details });
    await atomicWrite(this.heartbeatPath, value);
    if (this.acquired) {
      const lease = await this.readLease();
      if (!lease || lease.pid !== process.pid) throw new Error("Supervisor lease ownership was lost");
      await atomicWrite(this.lockPath, { ...lease, heartbeatAt: value.updatedAt });
    }
    return value;
  }

  public async release(message = "Supervisor stopped"): Promise<void> {
    if (!this.acquired) return;
    const heartbeat = await this.readHeartbeat();
    if (heartbeat?.status !== "FAILED") await this.heartbeat("STOPPED", { message });
    const lease = await this.readLease();
    if (lease?.pid === process.pid) await unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    this.acquired = false;
  }

  private async readLease(): Promise<SupervisorLease | undefined> {
    try { return SupervisorLeaseSchema.parse(JSON.parse(await readFile(this.lockPath, "utf8")) as unknown); } catch { return undefined; }
  }

  private async readHeartbeat(): Promise<RuntimeHeartbeat | undefined> {
    try { return RuntimeHeartbeatSchema.parse(JSON.parse(await readFile(this.heartbeatPath, "utf8")) as unknown); } catch { return undefined; }
  }

  private async quarantineLeaseIfPresent(): Promise<void> {
    const stalePath = `${this.lockPath}.stale-${this.now().toISOString().replace(/[:.]/gu, "-")}`;
    await rename(this.lockPath, stalePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function installTerminationHandlers(controller: AbortController): () => void {
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
