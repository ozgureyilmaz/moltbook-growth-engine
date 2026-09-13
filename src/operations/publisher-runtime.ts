import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfig } from "../config";

export function publisherRuntime(options: Record<string, string | boolean> = {}, env = process.env) {
  const home = env.HERMES_HOME ?? join(homedir(), ".hermes");
  return {
    python: typeof options["publisher-python"] === "string" ? options["publisher-python"] : env.MOLTBOOK_PUBLISHER_PYTHON ?? "python3",
    script: typeof options["publisher-script"] === "string" ? options["publisher-script"] : env.MOLTBOOK_PUBLISHER_SCRIPT ?? join(home, "skills/automation/moltbook-deterministic-publisher/scripts/publish_moltbook_action.py"),
    config: typeof options["publisher-config"] === "string" ? options["publisher-config"] : env.MOLTBOOK_PUBLISHER_CONFIG ?? join(home, "data/moltbook-publisher.json"),
  };
}

/** Inspect configuration only: the external validate-only script can quarantine pending files. */
export async function checkPublisherFiles(runtime: ReturnType<typeof publisherRuntime>, config: RuntimeConfig, project = process.cwd()): Promise<void> {
  try { await access(runtime.script, constants.R_OK); } catch { throw new Error("Publisher script is missing or unreadable. See npm run setup:hermes and README.md."); }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(runtime.config, "utf8")) as unknown; } catch { throw new Error("Publisher config is missing, unreadable, or invalid JSON. Run npm run setup:hermes."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Publisher config must be an object");
  const value = raw as Record<string, unknown>;
  for (const key of ["account", "credential_service", "credential_account", "contract_keychain_service", "contract_keychain_account", "contract_key_id"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Publisher config is missing ${key}`);
  }
  for (const [key, expected] of [
    ["project_dir", project],
    ["pending_dir", config.publishing?.outbox?.pending_path ?? "outbox/pending"],
    ["handoff_dir", config.publisher_bridge?.handoff_path ?? "outbox/handoff"],
  ]) {
    if (typeof value[key!] !== "string" || resolve(project, value[key!] as string) !== resolve(project, expected!)) {
      throw new Error(`Publisher ${key} does not match this engine. Regenerate the local publisher configuration.`);
    }
  }
  if (!Array.isArray(value.allowed_domains) || value.allowed_domains.length !== 1 || value.allowed_domains[0] !== "www.moltbook.com") throw new Error("Publisher allowed_domains must contain only www.moltbook.com");
  if (value.contract_key_id !== (config.publisher_bridge?.contract_key_id ?? "contract-v1")) throw new Error("Publisher contract key ID does not match the engine");
  for (const [key, expected] of [
    ["contract_keychain_service", config.publisher_bridge?.contract_keychain_service ?? "marx-moltbook-growth-engine"],
    ["contract_keychain_account", config.publisher_bridge?.contract_keychain_account ?? "publisher-contract"],
  ]) {
    if (value[key!] !== expected) throw new Error(`Publisher ${key} does not match the engine`);
  }
}
