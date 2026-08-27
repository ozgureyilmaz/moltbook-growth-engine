import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse } from "yaml";

export const PROMPT_STAGES = ["opportunity", "strategy", "generator", "evaluator", "learning"] as const;
export type PromptStage = (typeof PROMPT_STAGES)[number];

export type PromptDocument = {
  stage: PromptStage;
  version: string;
  promptVersion: string;
  promptId?: string;
  role?: string;
  outputFormat?: string;
  expectedOutputSchema: string;
  instructions: string;
  path: string;
};

export type PromptLoaderOptions = {
  rootDir?: string;
  /** Alias used by runtime configuration callers. */
  promptRoot?: string;
};

/**
 * Loads versioned prompt source as trusted instructions. Retrieved Moltbook
 * content is supplied separately to ModelTask and is never merged here.
 */
export async function loadPrompt(
  stage: PromptStage,
  version = "v1",
  options: PromptLoaderOptions = {},
): Promise<PromptDocument> {
  const path = promptPath(stage, version, options);
  return parsePrompt(stage, version, path, await readFileAsync(path, "utf8"));
}

export function loadPromptSync(
  stage: PromptStage,
  version = "v1",
  options: PromptLoaderOptions = {},
): PromptDocument {
  const path = promptPath(stage, version, options);
  return parsePrompt(stage, version, path, readFileSync(path, "utf8"));
}

export function promptVersion(stage: PromptStage, version = "v1"): string {
  return `${stage}-${version}`;
}

function promptPath(stage: PromptStage, version: string, options: PromptLoaderOptions): string {
  if (!PROMPT_STAGES.includes(stage)) throw new Error(`unsupported prompt stage: ${String(stage)}`);
  if (!/^v[0-9]+$/.test(version)) throw new Error(`invalid prompt version: ${version}`);
  const configuredRoot = options.promptRoot ?? options.rootDir ?? process.cwd();
  const promptRoot = basename(configuredRoot) === "prompts" ? configuredRoot : join(configuredRoot, "prompts");
  return resolve(promptRoot, stage, `${version}.md`);
}

function parsePrompt(stage: PromptStage, requestedVersion: string, path: string, source: string): PromptDocument {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const frontMatter = match ? parse(match[1] ?? "") as Record<string, unknown> : {};
  const instructions = (match?.[2] ?? source).trim();
  if (!instructions) throw new Error(`prompt ${path} has no instructions`);
  const version = typeof frontMatter.version === "string" ? frontMatter.version : requestedVersion;
  if (version !== requestedVersion) throw new Error(`prompt ${path} declares ${version}, expected ${requestedVersion}`);
  return {
    stage,
    version,
    promptVersion: promptVersion(stage, version),
    ...(typeof frontMatter.prompt_id === "string" ? { promptId: frontMatter.prompt_id } : {}),
    ...(typeof frontMatter.role === "string" ? { role: frontMatter.role } : {}),
    ...(typeof frontMatter.output_format === "string" ? { outputFormat: frontMatter.output_format } : {}),
    expectedOutputSchema: typeof frontMatter.output_schema === "string" ? frontMatter.output_schema : `${stage}.output`,
    instructions,
    path,
  };
}
