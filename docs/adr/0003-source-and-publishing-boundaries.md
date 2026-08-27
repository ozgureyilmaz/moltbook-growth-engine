# ADR 0003: Source and publishing boundaries

Status: accepted

Fixture, disabled, and authorized Moltbook sources remain distinct adapters. The authorized adapter requires explicit authorization and an allow-list; no login, bypass, scraping evasion, proxy rotation, or direct posting belongs here. Live pagination and provider-specific rate-limit behavior remain the responsibility of a future documented authorized client.

Production handoff requires `publishing.enabled: true`, an explicitly authorized source mode, deterministic QA, evaluator/policy pass, URL allow-list validation, and a valid action. The engine writes only to the local outbox. The downstream publisher owns authentication and publication.
