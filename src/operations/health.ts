import { mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const HealthCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["PASS", "WARN", "FAIL"]),
  message: z.string().min(1),
  checkedAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const HealthReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: z.enum(["READY", "DEGRADED", "NOT_READY"]),
  checkedAt: z.string().datetime({ offset: true }),
  checks: z.array(HealthCheckSchema),
}).strict();

export type HealthCheck = z.infer<typeof HealthCheckSchema>;
export type HealthReport = z.infer<typeof HealthReportSchema>;
export type HealthCheckRunner = () => Promise<HealthCheck> | HealthCheck;

export async function runHealthChecks(runners: readonly HealthCheckRunner[], now = new Date()): Promise<HealthReport> {
  const checks: HealthCheck[] = [];
  for (const runner of runners) {
    try {
      checks.push(HealthCheckSchema.parse(await runner()));
    } catch (error) {
      checks.push({
        name: `check-${checks.length + 1}`,
        status: "FAIL",
        message: error instanceof Error ? error.message : String(error),
        checkedAt: now.toISOString(),
      });
    }
  }
  const status = checks.some((check) => check.status === "FAIL") ? "NOT_READY" : checks.some((check) => check.status === "WARN") ? "DEGRADED" : "READY";
  return HealthReportSchema.parse({ schemaVersion: "1.0", status, checkedAt: now.toISOString(), checks });
}

export async function writableDirectoryCheck(path: string, now = new Date()): Promise<HealthCheck> {
  await mkdir(path, { recursive: true });
  const probe = `${path}/.health-${process.pid}-${randomUUID()}`;
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  await unlink(probe);
  return { name: "runtime-directory", status: "PASS", message: "Runtime directory is writable", checkedAt: now.toISOString(), metadata: { path } };
}

export async function commandHealthCheck(name: string, command: string, args: string[], now = new Date()): Promise<HealthCheck> {
  if (!command.trim() || /[\r\n\0]/u.test(command)) throw new Error(`${name} command is invalid`);
  try {
    await execFileAsync(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 });
    return { name, status: "PASS", message: `${name} command responded`, checkedAt: now.toISOString(), metadata: { command } };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "unavailable";
    return { name, status: "FAIL", message: `${name} command failed (${code})`, checkedAt: now.toISOString(), metadata: { command } };
  }
}
