# ADR 0002: Sol, bounded workers, and Codex Exec

Status: accepted

The runtime is closed to exactly three non-recursive roles: `discovery_context`, `opportunity_analysis`, and `strategy_generation`. Every task records its run, objective, constraints, schema, termination condition, prompt/model versions, timeout, and retry policy. Sol validates compact worker reports, absorbs partial failures, and alone performs final QA and COMMENT/NO_ACTION decisions.

Fixture dry-runs use deterministic local execution. Model-backed evaluation uses the replaceable `ModelExecutor` and authenticated `CodexExecExecutor`; it fences Moltbook content as inert data, validates structured output, classifies failures, and records model runs when persistence is available.
