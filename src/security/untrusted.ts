/** Security boundary for retrieved Moltbook content.
 *
 * Post text is data.  It is never interpolated into executable instructions,
 * shell commands, or model/system prompts without an explicit data boundary.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|earlier)\s+instructions?/i,
  /(?:reveal|output|send|share|exfiltrate).{0,32}(?:api|secret|credential|token|password)/i,
  /(?:delete|drop|wipe|remove).{0,24}(?:database|filesystem|files|data)/i,
  /(?:change|override|rewrite).{0,24}(?:system|developer|safety)\s+(?:prompt|instruction)/i,
  /run\s+(?:this|the following)\s+(?:command|code|script)/i,
  /you\s+are\s+now\s+(?:a|an)\s+/i,
];

const HYPE_PATTERNS: RegExp[] = [
  /the\s+real\s+unlock/i,
  /the\s+missing\s+layer/i,
  /the\s+future\s+of/i,
  /game[- ]changer/i,
  /agent[- ]native/i,
  /paradigm\s+shift/i,
];

export type UntrustedAnalysis = {
  containsPromptInjection: boolean;
  injectionSignals: string[];
  isHype: boolean;
  hypeSignals: string[];
};

export function analyzeUntrustedText(text: string): UntrustedAnalysis {
  const injectionSignals = INJECTION_PATTERNS.filter((pattern) => pattern.test(text)).map(
    (pattern) => pattern.source,
  );
  const hypeSignals = HYPE_PATTERNS.filter((pattern) => pattern.test(text)).map(
    (pattern) => pattern.source,
  );
  return {
    containsPromptInjection: injectionSignals.length > 0,
    injectionSignals,
    isHype: hypeSignals.length > 0,
    hypeSignals,
  };
}

/** Keep the original text for attribution while making its boundary explicit. */
export function asUntrustedData(text: string): { value: string; trusted: false } {
  return { value: String(text), trusted: false };
}

export function containsPromptInjection(text: string): boolean {
  return analyzeUntrustedText(text).containsPromptInjection;
}

export function containsHypePhrase(text: string): boolean {
  return analyzeUntrustedText(text).isHype;
}

