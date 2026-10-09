# Stripe history backfill: gate (2026-10-09)

Plan: `docs/superpowers/plans/2026-10-09-readaloud-admin-dashboard-phase2-plan.md`, Task 6.

## Check

A read-only check of billing rows was run against the production database to see whether any metered history exists before the ledger start.

## Decision

A backfill from Stripe meter event summaries is not built (YAGNI) until there is history to import.

## Revisit when

Paid usage ever predates the usage ledger start date shown on the dashboard. Then:

1. From the backend machine, with the Stripe SDK, list the character meter and read `listEventSummaries(meterId, { customer, start_time, end_time, value_grouping_window: 'day' })` for that one customer. Record whether each summary row carries `start_time`, `end_time` and `aggregated_value`.
2. If it does, write a follow-up plan that stores billed units per day in a NEW table. Do not mix them into `realtimetts_usage_daily`: meter units are character-equivalents across engines and STT, not raw characters.
