# AutoOS fork follow-ups (branch autoos/*)

Deferred review findings (2026-10-16 seats on the quota / clamp / reasoning patches):

1. **Quota null → 0 in consumers.** `src/lib/usage/apiKeyUsageLimits.ts` (`toNumber(null)` = 0 reads as "used 100%")
   and `src/lib/db/quotaSnapshots.ts` (AVG drops unknowns, then `?? 0` shows an all-unknown window as 0%) still
   turn an unknown remaining percentage into 0. Not a regression (the value used to be stored as 0); mirror the
   null skip from `src/lib/db/quotaResetEvents.ts`.
2. **Hydrate drops `fractionReported`.** `hydrateQuotaCacheFromSnapshots` never restores `fractionReported`
   (pre-existing upstream behaviour); thread it through the snapshot rows.
3. **Tautological assertions.** `combo.ts` log text for the `max_tokens` adjustment and
   `tests/unit/combo-routing-engine.test.ts` ~3404 (8192 → 4096) assert what the code trivially does.
4. **Unreachable `?? 0`** at `src/sse/services/auth.ts` (`usedPercentage ?? 0` after `reachedThreshold`).
5. **DeepSeek placeholder scope.** The Responses translator re-emits the placeholder reasoning item for every
   `deepseek*` / `mimo*` model with tool calls; it has no reasoner/thinking gate. Add one if a non-thinking model
   ever rejects the extra item.
6. **ACP executor** lives on `autoos/acp-executor` (base v3.8.52); rebase onto the newest upstream in P5.
