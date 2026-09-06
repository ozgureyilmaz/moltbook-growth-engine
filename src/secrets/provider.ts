import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SecretReference = {
  name: string;
  environmentVariable?: string;
  keychainService?: string;
  keychainAccount?: string;
};

export interface SecretProvider {
  readonly kind: string;
  getSecret(reference: SecretReference): Promise<string | undefined>;
}

export class SecretNotFoundError extends Error {
  public constructor(public readonly referenceName: string) {
    super(`Required secret is not available: ${referenceName}`);
    this.name = "SecretNotFoundError";
  }
}

export class EnvironmentSecretProvider implements SecretProvider {
  public readonly kind = "environment";

  public constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  public async getSecret(reference: SecretReference): Promise<string | undefined> {
    const variable = reference.environmentVariable;
    if (!variable || !/^[A-Z][A-Z0-9_]*$/u.test(variable)) return undefined;
    const value = this.environment[variable]?.trim();
    return value || undefined;
  }
}

export type KeychainCommandRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;

const defaultKeychainRunner: KeychainCommandRunner = async (command, args) => {
  const result = await execFileAsync(command, [...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  return { stdout: result.stdout };
};

/** Reads a generic password from macOS Keychain without placing it in argv or logs. */
export class MacOsKeychainSecretProvider implements SecretProvider {
  public readonly kind = "macos-keychain";

  public constructor(private readonly run: KeychainCommandRunner = defaultKeychainRunner) {}

  public async getSecret(reference: SecretReference): Promise<string | undefined> {
    const service = safeKeychainField("service", reference.keychainService);
    const account = safeKeychainField("account", reference.keychainAccount);
    if (!service || !account) return undefined;
    try {
      const { stdout } = await this.run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      const value = stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }
}

export class ChainedSecretProvider implements SecretProvider {
  public readonly kind: string;

  public constructor(private readonly providers: readonly SecretProvider[]) {
    this.kind = providers.map((provider) => provider.kind).join("+") || "empty";
  }

  public async getSecret(reference: SecretReference): Promise<string | undefined> {
    for (const provider of this.providers) {
      const value = await provider.getSecret(reference);
      if (value) return value;
    }
    return undefined;
  }
}

export async function requireSecret(provider: SecretProvider, reference: SecretReference): Promise<string> {
  const value = await provider.getSecret(reference);
  if (!value) throw new SecretNotFoundError(reference.name);
  return value;
}

function safeKeychainField(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0") || /[\r\n]/u.test(normalized)) throw new Error(`Keychain ${label} is invalid`);
  return normalized;
}
