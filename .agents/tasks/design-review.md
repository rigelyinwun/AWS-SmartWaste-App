# Phase 1 Marketplace Design Review

Reviewer: design-review subagent (fresh read, no authoring context)
Target: `.agents/tasks/phase1-design.md` (Revision 3)
Code verified against: `lambdas/collect/app.py`, `lambdas/profile/app.py`,
`infra/template.yaml`, `frontend/app.js`, `frontend/index.html`, `tests/test_collect.py`
(all in the `phase1-marketplace` worktree).

## Summary verdict

The design is unusually complete and internally consistent. Revision 3 resolved the prior
review's findings, and I was able to verify the design's claims about the existing code
line-by-line — nearly all are accurate. The disintermediation state machine is specified
with a single source of truth (`UNLOCK_STATUSES`/`CHAT_STATUSES` read by `_creq_view` and
`_chat_enabled`), every named guard is addressed, and no real-payment code is introduced.

I found a small number of genuine gaps that should be closed before implementation. None
are catastrophic, but two are MEDIUM because they are reachable code paths that are either
unspecified or that contradict a stated invariant. The rest are NITs.

Count: **0 HIGH / 2 MEDIUM / 5 NIT** → **CHANGES_REQUESTED**.

---

## Findings

### 1. MEDIUM — `confirm_deal` auto-close + waste-item flip is not transactional, and the "revert to open" rule on cancel can race the auto-close

Location: Part B `confirm_deal` (effects 2–3) and "Soft status — cancel" (post-confirm cancel).

`confirm_deal` performs three independent DynamoDB writes with no ordering guarantee or
compensation specified beyond "best-effort, logged": (a) set the collect-request
`confirmed`, (b) set the waste item `collecting`+`collectorId`, (c) paginate `wasteIndex`
and move every other `requested`/`accepted` quote to `closed`. The error-handling section
says a failure to close a losing quote is "logged but does not fail the confirm." That is
defensible, but it leaves a **concrete inconsistent state unaddressed**: if (a) succeeds
and (b) fails, the collect-request is `confirmed` (contact unlocked) while the waste item
is still `open` and still accepting new quotes — two collectors can now be told different
things, and a second owner-confirm on another quote is possible (nothing re-checks the
waste item is still `open` inside `confirm_deal`). The guard in `confirm_deal` is only
"current collect-request status is `accepted`"; it does **not** assert the waste item is
not already `collecting` for a different confirmed deal.

Concrete fix: add an explicit guard at the top of `confirm_deal` that re-loads the waste
item and rejects (`409 {"error":"This item already has a confirmed collector"}`) if
`waste.status == "collecting"` and `waste.collectorId` is set and differs. State the write
order (collect-request `confirmed` first, then waste item, then auto-close) and specify
that if the waste-item update fails the confirm returns `500` **without** having unlocked
to the client (i.e. perform the waste-item write before returning the unlocked
`_creq_view`). This makes "one confirmed deal per item" an enforced invariant rather than a
best-effort hope.

### 2. MEDIUM — post-confirm cancel "revert to open only if no other confirmed deal exists" has no specified query, and no rule for restoring the losing (auto-closed) quotes

Location: Part B "Soft status — cancel", post-confirm branch.

The rule reads: on cancelling a `confirmed` job the waste item "reverts to `open`
(re-listable) **only if** no other confirmed deal exists for it." Two gaps:

- The check "no other confirmed deal exists" is asserted but never given a mechanism. There
  is no index keyed to answer it directly; it requires a paginated `wasteIndex` query
  filtering `status == "confirmed"` and excluding the row being cancelled. This should be
  specified the same way the duplicate-quote and auto-close queries are (no `Limit`,
  paginate `LastEvaluatedKey`), or the implementer will guess.
- When the item reverts to `open`, the quotes that were auto-`closed` at confirm time stay
  `closed`. So a cancelled deal re-opens an item that now has **zero live quotes even
  though other collectors had quoted** — they were closed and are not restored. The design
  does not say whether that is intended (it is a reasonable Phase-1 choice) or whether
  losing quotes should be reopened. Pick one and state it.

Concrete fix: specify the "other confirmed deal" check as a paginated `wasteIndex` query,
and add one sentence: "Auto-closed quotes are **not** restored when a confirmed deal is
cancelled; the owner re-lists and collectors re-quote." (Or the opposite, if intended.)

### 3. NIT — `mark_done` guard wording vs. the item-9 call-site contract leaves `collecting` ambiguity in exactly one spot

Location: Part B item 8 (`mark_done`) and the waste-item status mapping.

`mark_done`'s new guard is `status not in ("confirmed",)` on the **collect-request**, which
is correct and clearly stated. But the waste-item mapping says the item is `collecting`
while the collect-request is `confirmed`, and `mark_done` sets the waste item to
`collected`. The design never says `mark_done` must also tolerate a waste item that is
`open` (which can happen in the inconsistent state from finding #1, or if a prior cancel
reverted it). Low impact given findings #1/#2 fixes, but worth a sentence: `mark_done`
keys only off the collect-request status and overwrites the waste item to `collected`
regardless of its current value.

Concrete fix: add "the waste-item write in `mark_done` is an unconditional set to
`collected`; it does not guard on the item's prior status."

### 4. NIT — `request_collect` step 5 (`item still open`) will reject a legitimate second quote in one edge case

Location: Part A order step 5 + "Multiple quotes" (a)/(b).

The design removes the `update_item` that flips the waste item to `requested` (edit a), so
the item stays `open` while quotes accumulate — good. But step 5 keeps
`waste.get("status") not in ("open", None)` → `409`. Once an owner **confirms** a deal the
item becomes `collecting`; from that point step 5 correctly blocks new quotes. That is the
intended behavior. However, the design should state explicitly that this `409`'s client
message (`"This item is no longer available"`) is the one a collector sees after another
collector's deal was confirmed, so the frontend copy matches. Currently Part E's quote
overlay only maps `403`/`400`/`409` generically; confirm the `409` text surfaces verbatim.

Concrete fix: note that step-5 `409` fires for `collecting`/`collected` items and that the
quote overlay surfaces the server `error` string verbatim (already stated for 400/409, just
make it explicit this is the "someone else was confirmed" path).

### 5. NIT — presigned PUT `ContentType` validation is unspecified server-side

Location: Part C `upload-url`, and the validation table row `contentType ... signed as-is`.

The design correctly requires the presign `ContentType` to equal the browser PUT
`Content-Type`, but it signs whatever the client sends ("signed as-is") with no allow-list.
A client can request a presign for `text/html` (or any type) and upload a non-document.
Since the bucket is private and only admins fetch via presigned GET, blast radius is low,
but a trust-granting document workflow should constrain it.

Concrete fix: validate `contentType` against a small allow-list
(`{"image/png","image/jpeg","application/pdf"}`) in `upload-url` → `400` otherwise, and
state it in the validation table.

### 6. NIT — `_creq_view` always-exposed fields are added, but `list_requests`/`public_view` field additions are not reflected in the existing unit tests' expectations

Location: Testability section + View exposure (`_creq_view`, `public_view`).

The design says `public_view` gains `priceType`/`maxPrice`/`currency` and the existing
`test_public_view_*` tests "still pass." I verified those tests only assert presence/absence
of `addressMasked`/`fullAddress`, so they will indeed still pass — the claim is accurate.
But `_creq_view` now **always** exposes `quoteAmount`/`currency`/`maxPrice`/`paymentStatus`,
and the existing `test_creq_view_locked_when_requested` asserts only that `fullAddress` is
absent and `unlocked` is falsy. The design should add an explicit assertion that the new
always-exposed fields are present even in the locked (`requested`/`accepted`) view, so a
future refactor that gates them behind unlock (leaking the inverse — hiding price) is
caught. Minor, but the Testability section claims coverage of the invariant and should name
this case.

Concrete fix: add to the `_creq_view` test list: "assert `quoteAmount`/`currency`/
`maxPrice`/`paymentStatus` are present for `requested` and `accepted` (never gated by
unlock), while `fullAddress`/`ownerPhone`/`unlocked` are absent."

### 7. NIT — Admin nav gating reads `cognito:groups` from the ID token, but the design does not confirm the group claim is actually in the ID token (vs. access token)

Location: Part D `_is_admin` + Part E Admin nav.

`verify_token` decodes the **ID token** (`token_use == "id"`, verified). Cognito includes
`cognito:groups` in both ID and access tokens when the user is in a group, so this works.
The design asserts it ("the Cognito-signed ID token") but does not note the one operational
caveat: a user **added to the `admins` group after** their current token was issued will
not have the claim until the token refreshes. For Phase 1 that is acceptable, but the admin
onboarding step should say "newly-added admins must re-login (or wait for token refresh)
before the Admin nav/API works."

Concrete fix: add a one-line operational note under Part D that group membership is
token-scoped and requires a token refresh after an admin is added.

---

## Verified Assumptions (design claim → confirmed against code)

1. `_creq_view` currently unlocks only on `status == "approved"` with a `waste` object, and
   copies `fullAddress`/`ownerPhone`/`pickupTime`/`notes` + `unlocked=True`. **Confirmed**
   (`lambdas/collect/app.py`).
2. `_chat_enabled` currently returns `status in ("approved", "collected")`. **Confirmed.**
3. `get_messages`/`send_message`/`list_conversations` all funnel through `_chat_enabled`
   (+`_is_member`), so tightening `_chat_enabled` tightens all three. **Confirmed.**
4. `request_collect` currently flips the waste item to `"requested"` via `update_item`
   (the single-quote mechanism the design deletes), and keeps the
   `status not in ("open", None)` → `409` precondition. **Confirmed.**
5. `approve_request` currently sets the collect-request to `approved`, flips the waste item
   to `collecting`+collectorId, and sends the "address unlocked" notification — exactly the
   disintermediation hole the design splits into `accepted`/`confirmed`. **Confirmed.**
6. `reject_request` currently reopens the waste item to `open` unconditionally. **Confirmed**
   — the design's change to stop that is necessary for multi-quote.
7. `mark_done` currently guards on `status != "approved"`. **Confirmed** (design retargets to
   `confirmed`).
8. `list_requests` both loops currently gate the waste lookup on `status == "approved"`.
   **Confirmed** — the design's item-9 change to `in UNLOCK_STATUSES` is required or
   confirmed deals would silently never unlock.
9. The POST handler dispatches purely by `route.endswith(...)` in order, so
   `/admin/collectors/{id}/approve` would be captured by `endswith("approve")`. **Confirmed**
   — the prefix-first dispatcher is genuinely required.
10. `wasteIndex` GSI exists on `CollectRequestsTable` with HASH `wasteId` / RANGE `createdAt`
    / ProjectionType ALL. **Confirmed** (`infra/template.yaml`) — supports the paginated
    duplicate-quote and auto-close queries.
11. `WasteRequestsTable.statusIndex` is HASH `status` / RANGE `createdAt` / ProjectionType
    ALL. **Confirmed** — the `collectors.statusIndex` "mirror" claim is accurate.
12. `AppBedrockRole` is shared by `ProfileFunction` and `CollectFunction` (both
    `Role: !GetAtt AppBedrockRole.Arn`), and there is no per-function role. **Confirmed** —
    the design's "add inline policies to the shared role" decision is correct.
13. `FrontendBucket` has a public `s3:GetObject` bucket policy, confirming the contrast with
    the new private `CollectorDocsBucket`. **Confirmed.**
14. Outputs `BucketName` and `WebsiteUrl` (`FrontendBucket.WebsiteURL`) exist. **Confirmed.**
15. `Auth.profile()` has two return paths (live-session and localStorage-fallback), both
    returning `{email, name, sub}` with **no** `groups`. **Confirmed** — the design's "patch
    BOTH paths" instruction is correct and necessary.
16. `statusBadge` label map is exactly `{open, requested, collecting, rejected, collected,
    done}` and emits `status-<name>` classes. **Confirmed** — the new labels/CSS are indeed
    additions.
17. `fmtTime(ts)` does `new Date(ts * 1000)` (expects seconds). **Confirmed** — the
    microsecond-`createdAt` caution is valid.
18. `showNotifDetailForCollectRequest` has exactly two action branches (`owner`+`requested`
    → Approve/Reject; `status === 'approved'` → unlock card). **Confirmed** — the design's
    edit (2) accurately targets them.
19. `openRequestInNotifications(wasteId)` picks one matching row via a retry/`setTimeout`
    loop waiting for `loadLifecycleRequests()`, and `onPortalCardClick` routes the owner to
    it. **Confirmed** — the multi-quote render change has a real home.
20. The `act(suffix, id, btn)` helper sends `collectFetch('POST', {collectRequestId: id},
    suffix)` then refreshes notifications + lifecycle + badge. **Confirmed** — reusable for
    `confirm`/`cancel` as the design states.
21. `profile/app.py` is a thin profile Lambda with no S3/collectors access and no new env
    vars needed. **Confirmed** — inheriting unused permissions on the shared role is
    harmless as the design claims.
22. Existing pure tests `test_creq_view_locked_when_requested` /
    `test_creq_view_unlocks_when_approved` and `public_view` tests exist and import under the
    boto3/flask/jwt stubs. **Confirmed** (`tests/test_collect.py`).
23. **No real-payment code is introduced.** `paymentStatus="not_required"` plus `# Phase 2:`
    comment placeholders only; `confirm_deal` has no payment precondition. **Confirmed** by
    reading the design in full — nothing calls Stripe or moves money.
24. The Future Actions tab (`renderFurtherActions`, flowchart/cards) is explicitly left
    untouched. **Confirmed** — the design's "Explicitly unchanged" section states this and no
    edit targets it.
25. Cognito custom-attribute risk is explicitly addressed with a decision: account type is
    **derived** from the `collectors` table, no `custom:account_type` added, pool not
    replaced. **Confirmed** (Decision a) — and consistent with the template (UserPool is not
    modified).

## Unverified / Wrong Assumptions

1. **Unverified (out of my scope to run): the paginated `wasteIndex` queries actually return
   all rows under load.** The design states "no `Limit`, paginate `LastEvaluatedKey` until
   exhausted" for duplicate-quote detection and auto-close. The code for these does not exist
   yet (new), so correctness depends on the implementer following the spec. The spec itself
   is sound; I could not verify an implementation.
2. **Unverified: `cognito:groups` is present in the ID token at runtime.** Cognito includes
   it in ID tokens for group members, but I cannot verify the pool's token configuration from
   the template alone (no explicit claim-customization resource). See finding #7 — functionally
   expected to work, with the token-refresh caveat.
3. **Unverified: `collectFetch(method, body, pathSuffix)` builds the URL by appending
   `pathSuffix` such that `/collector/apply`, `/admin/collectors`, `/admin/collectors/{id}/
   approve` resolve to the intended paths.** I confirmed `collectFetch` exists and that
   `profileFetch` follows the same `STREAM_URLS.x + pathSuffix` pattern, but the design's new
   path suffixes (with embedded `{id}` and query strings like `?status=pending`) were not
   traced through the exact URL-join logic. The implementer should confirm the suffix
   concatenation produces the paths the backend dispatcher splits on.
4. **Not wrong, but worth flagging: the historical "Review responses (revision 2)" block
   still prints the OLD 4-element `UNLOCK_STATUSES = ("confirmed","collecting","collected",
   "disputed")`.** The live Revision-3 "Shared module constants" section correctly uses the
   3-element set (no `collecting`). This is clearly labeled historical and does not conflict
   with the authoritative body, so it is not a finding — but an implementer skimming the
   bottom of the document could copy the wrong tuple. Consider trimming or clearly fencing the
   historical blocks.

---

## Verdict basis

2 MEDIUM findings (#1, #2) → **CHANGES_REQUESTED**. Both are reachable backend code paths in
the disintermediation/lifecycle core (confirm atomicity + cancel revert semantics) that are
currently under-specified enough that two implementers would build them differently. The
five NITs are polish and test-coverage items. No HIGH findings: the invariant architecture
is sound and every named guard is specified and verified against the real code.
