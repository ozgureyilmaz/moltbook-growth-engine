# ADR 0001: Canonical contracts and external transport

Status: accepted

Runtime modules retain camelCase TypeScript contracts for compatibility. Every SQLite write crosses the validated adapters in `src/persistence/adapters.ts` and every persisted JSON value is parsed by its Zod schema. The downstream action transport is separately canonical: `src/outbox/transport.ts` serializes schema version 1.0 with snake_case fields and deserializes both that format and legacy camelCase files.

This avoids silently conflating internal types, persisted records, and the publisher interface. Schema changes require a migration, adapter update, round-trip test, and an action-schema version decision.
