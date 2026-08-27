# ADR 0004: Outbox state and outcome attribution

Status: accepted

The file outbox is the authoritative publisher transport. Payload creation is atomic and non-overwriting; state records include idempotency, run, source, experiment, content hash, retry count, timestamps, and failure details. Acknowledged and failed actions cannot re-enter pending without an explicit bounded retry. SQLite `actions`, `publications`, and `outcomes` are internal evidence records rather than a second publisher queue.

Attribution follows run → source post → opportunity → candidate → action → experiment → publication/outcome. Learning treats replies as diagnostics, while Marx investigation, interaction, and usage are north-star progress signals. Production source of truth and attribution window remain unknown until the authorized publisher and Marx telemetry are connected.
