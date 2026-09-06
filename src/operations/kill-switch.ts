import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import { stableStringify } from "../domain/identifiers";

export const KillSwitchClearanceSchema = z.object({
  authorizationId: z.string().trim().min(1),
  actor: z.string().trim().min(1),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1),
  signatureKeyId: z.string().trim().min(1).optional(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

export const KillSwitchStateSchema = z.object({
  schemaVersion: z.literal("1.0"),
  status: z.enum(["ENGAGED", "CLEARED"]),
  updatedAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1),
  actor: z.string().trim().min(1),
  authorizationId: z.string().trim().min(1).optional(),
  clearanceExpiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type KillSwitchClearance = z.infer<typeof KillSwitchClearanceSchema>;
export type KillSwitchState = z.infer<typeof KillSwitchStateSchema>;

export type KillSwitchClearanceVerification = {
  contractSecret?: string;
  expectedKeyId?: string;
  requireSignature?: boolean;
};

export function signKillSwitchClearance(clearance: KillSwitchClearance, keyId: string, secret: string): KillSwitchClearance {
  const unsigned = unsignedClearance(clearance);
  return KillSwitchClearanceSchema.parse({ ...unsigned, signatureKeyId: keyId, signature: signValue(unsigned, secret) });
}

/** Missing, malformed, or expired state is always treated as ENGAGED. */
export class EmergencyKillSwitch {
  public constructor(
    private readonly path = "data/runtime/kill-switch.json",
    private readonly now: () => Date = () => new Date(),
    private readonly auditPath = `${path}.audit.jsonl`,
  ) {}

  public async status(): Promise<KillSwitchState> {
    try {
      const state = KillSwitchStateSchema.parse(JSON.parse(await readFile(this.path, "utf8")) as unknown);
      if (state.status === "CLEARED" && (!state.clearanceExpiresAt || Date.parse(state.clearanceExpiresAt) <= this.now().getTime())) {
        return this.failClosed("CLEARANCE_EXPIRED");
      }
      return state;
    } catch {
      return this.failClosed("STATE_MISSING_OR_INVALID");
    }
  }

  public async engage(reason: string, actor: string): Promise<KillSwitchState> {
    const state = KillSwitchStateSchema.parse({
      schemaVersion: "1.0",
      status: "ENGAGED",
      updatedAt: this.now().toISOString(),
      reason,
      actor,
    });
    await this.write(state);
    await this.audit(state);
    return state;
  }

  public async clear(clearance: KillSwitchClearance, verification: KillSwitchClearanceVerification = {}): Promise<KillSwitchState> {
    const parsed = KillSwitchClearanceSchema.parse(clearance);
    verifyClearanceSignature(parsed, verification);
    const now = this.now().getTime();
    if (Date.parse(parsed.issuedAt) > now || Date.parse(parsed.expiresAt) <= now) throw new Error("Kill-switch clearance is not currently valid");
    const state = KillSwitchStateSchema.parse({
      schemaVersion: "1.0",
      status: "CLEARED",
      updatedAt: this.now().toISOString(),
      reason: parsed.reason,
      actor: parsed.actor,
      authorizationId: parsed.authorizationId,
      clearanceExpiresAt: parsed.expiresAt,
    });
    await this.write(state);
    await this.audit(state);
    return state;
  }

  public async assertAutonomousAllowed(): Promise<KillSwitchState> {
    const state = await this.status();
    if (state.status !== "CLEARED") throw new Error(`Emergency kill switch is engaged: ${state.reason}`);
    return state;
  }

  private failClosed(reason: string): KillSwitchState {
    return { schemaVersion: "1.0", status: "ENGAGED", updatedAt: this.now().toISOString(), reason, actor: "system" };
  }

  private async write(state: KillSwitchState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, this.path);
  }

  private async audit(state: KillSwitchState): Promise<void> {
    await mkdir(dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function unsignedClearance(value: KillSwitchClearance): Record<string, unknown> {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signatureKeyId;
  delete unsigned.signature;
  return unsigned;
}

function signValue(value: unknown, secret: string): string {
  if (!secret) throw new Error("kill-switch contract secret is required");
  return createHmac("sha256", secret).update(stableStringify(value), "utf8").digest("hex");
}

function verifyClearanceSignature(clearance: KillSwitchClearance, verification: KillSwitchClearanceVerification): void {
  if (!clearance.signature || !clearance.signatureKeyId) {
    if (verification.requireSignature === true) throw new Error("kill-switch clearance contract signature is required");
    return;
  }
  if (!verification.contractSecret) throw new Error("kill-switch clearance contract secret is required");
  if (verification.expectedKeyId && clearance.signatureKeyId !== verification.expectedKeyId) throw new Error("kill-switch clearance signature key ID is not approved");
  const expected = signValue(unsignedClearance(clearance), verification.contractSecret);
  const actualBuffer = Buffer.from(clearance.signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error("kill-switch clearance contract signature is invalid");
}
