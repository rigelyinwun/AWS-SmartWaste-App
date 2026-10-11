# Phase 1 Implementation Plan — Type B Marketplace Monetization Layer

Authoritative design: `.agents/tasks/phase1-design.md` (Revision 3). Final review:
`.agents/tasks/design-review.md` (0 HIGH / 2 MEDIUM / 5 NIT, all folded in below).

All paths are ABSOLUTE under the worktree
`c:\programming\kiroaws\smartwaste-app\.worktrees\phase1-marketplace`.
Git ops use `git -C c:\programming\kiroaws\smartwaste-app\.worktrees\phase1-marketplace ...`.

Build/test commands (discovered): from the worktree root,
`pip install -r requirements-dev.txt` then `pytest` (config in `pytest.ini`:
`testpaths = tests`, `addopts = -q`). Tests import `lambdas/collect/app.py` under the
boto3/flask/jwt stubs in `tests/conftest.py`, so only PURE logic is unit-tested.

> CAUTION: the design's historical "Review responses (revision 2)" block prints an OLD
> 4-element `UNLOCK_STATUSES` including `collecting`. IGNORE it. The authoritative
> Revision-3 constant is the 3-element set `("confirmed","collected","disputed")`.
> `collecting` is a WASTE-ITEM status only, never a collect-request unlock status.

---

## THE DISINTERMEDIATION INVARIANT (reviewer re-checks this)

> No code path exposes `fullAddress`, `phone`, or enables chat before the collect-request
> status is in `UNLOCK_STATUSES = ("confirmed","collected","disputed")`. The earliest
> unlocking status is `confirmed`. `approve_request` sets only `accepted` and unlocks
> NOTHING. Enforcement is owned by two pure functions reading two module constants —
> `_creq_view` (contact unlock) and `_chat_enabled` (chat) — PLUS the `list_requests`
> call-site rule that loads the waste item exactly on `UNLOCK_STATUSES` (item 7 below),
> without which confirmed deals would be passed `waste=None` and silently never unlock.
> The frontend "reveal only after confirm" is defense-in-depth, never the enforcement point.

---

## PART 0 — Infra (`infra/template.yaml`)

- [ ] 1. Add the `CollectorsTable` DynamoDB table (PAY_PER_REQUEST), the private
      `CollectorDocsBucket` S3 bucket, the `AdminsGroup` Cognito user-pool group, the
      shared-role IAM grants, the `CollectFunction` env vars, and the docs-bucket output.
      File: `c:\programming\kiroaws\smartwaste-app\.worktrees\phase1-marketplace\infra\template.yaml`
      Details:
      - `CollectorsTable` (`AWS::DynamoDB::Table`, `BillingMode: PAY_PER_REQUEST`,
        `TableName: !Sub "smartwaste-collectors-${AWS::StackName}"`): PK `userId` (S);
        `AttributeDefinitions` for `userId` (S), `status` (S), `createdAt` (N); GSI
        `statusIndex` HASH `status` + RANGE `createdAt`, `ProjectionType: ALL`. Mirror the
        existing `WasteRequestsTable.statusIndex` shape exactly.
      - `CollectorDocsBucket` (`AWS::S3::Bucket`): `PublicAccessBlockConfiguration` with all
        four flags `true`; NO bucket policy (contrast `FrontendBucket`, which has a public
        `s3:GetObject` policy). Add `CorsConfiguration` with one `CorsRule`:
        `AllowedOrigins: ["*"]` (Phase-1 wildcard — comment it is tightened to the website
        origin later), `AllowedMethods: ["PUT","GET"]`, `AllowedHeaders: ["*"]`,
        `MaxAge: 3000`. No `ExposeHeaders`.
      - `AdminsGroup` (`AWS::Cognito::UserPoolGroup`): `GroupName: admins`,
        `UserPoolId: !Ref UserPool`, a `Description`. (Groups are additive — no pool
        replacement; the `UserPool` resource is NOT modified. No Cognito custom attribute.)
      - IAM on the SHARED `AppBedrockRole`: in `CollectDataPolicy` extend the Dynamo
        `Resource` list with `!GetAtt CollectorsTable.Arn` and
        `!Sub "${CollectorsTable.Arn}/index/*"`. Add a NEW inline policy
        `CollectorDocsPolicy` granting `s3:PutObject` + `s3:GetObject` on
        `!Sub "${CollectorDocsBucket.Arn}/*"`. Do NOT create a per-function role — this
        role is shared by `ProfileFunction` and `CollectFunction`; profile inheriting the
        unused S3/collectors perms is harmless.
      - `CollectFunction` env vars: `COLLECTORS_TABLE: !Ref CollectorsTable`,
        `COLLECTOR_DOCS_BUCKET: !Ref CollectorDocsBucket`. Profile function unchanged.
      - `Outputs`: add `CollectorDocsBucketName: !Ref CollectorDocsBucket` (mirror
        `BucketName`).
      - Note (operational): `CollectorDocsBucket` lives in the stack `REGION`, which is the
        same region the boto3 S3 client uses, so SigV4 presign host/region match.
      Verify: `sam validate --template infra/template.yaml --region ap-southeast-1` passes
      (if the SAM CLI is unavailable in the environment, YAML-parse the file with a Python
      one-liner — `python -c "import yaml,sys; yaml.safe_load(open(r'infra/template.yaml'))"`
      will fail on CFN intrinsics, so instead confirm the four resources + env vars + output
      are present and well-formed by re-reading the edited sections). The whole-suite
      `pytest` must still pass (infra edits do not affect it).

---

## PART A — Type B pricing + multi-quote (`lambdas/collect/app.py`)

All edits in
`c:\programming\kiroaws\smartwaste-app\.worktrees\phase1-marketplace\lambdas\collect\app.py`.

- [ ] 2. Add module constants and money/quote helpers near the top of the lifecycle section.
      File: `...\lambdas\collect\app.py`
      - Add the three module-level tuples (single source of truth):
        ```python
        # Collect-request statuses at which contact unlocks / chat opens. collecting is
        # a WASTE-ITEM status only and is deliberately absent here.
        UNLOCK_STATUSES = ("confirmed", "collected", "disputed")
        CHAT_STATUSES   = UNLOCK_STATUSES
        LIVE_QUOTE_STATUSES = ("requested", "accepted", "confirmed")
        ```
      - Add `_dec_price(v)` — parse to non-negative `Decimal` quantized to 2dp, else `None`
        (blank/invalid/negative → `None`). Used for `maxPrice` and `quoteAmount`.
      - Add `_validate_quote(amount, max_price)` — returns `(ok, error)`:
        `None`/`<=0` → `(False, "A quote amount greater than 0 is required")`;
        `max_price is not None and amount > max_price` →
        `(False, "Quote exceeds the owner's maximum price")`; else `(True, None)`.
      - Add the collector module scaffolding (used by Part C but declared here so imports
        resolve): `COLLECTORS_TABLE`/`COLLECTOR_DOCS_BUCKET` env reads,
        `collectors_table = dynamodb.Table(...) if ... else None`,
        `s3 = boto3.client("s3", region_name=REGION)`,
        `DOC_TYPES = {"registration","license","insurance"}`.
      Verify: `pytest tests/test_collect.py -q` — module still imports under stubs; existing
      tests pass (new pure helpers added in step 11's tests).

- [ ] 3. Add the three optional price fields to `create_report`.
      File: `...\lambdas\collect\app.py` (`create_report`)
      Read `priceType` (default `"user_pays"`), `currency` (`[:3].upper()`, default `MYR`),
      `maxPrice` via `_dec_price`. Always set `item["priceType"]` and `item["currency"]`;
      set `item["maxPrice"]` only when `_dec_price` returned non-`None`. Backward-compatible:
      old items without these fields read as `user_pays` / no ceiling.
      Verify: `pytest -q` passes.

- [ ] 4. Expose price fields in `public_view`.
      File: `...\lambdas\collect\app.py` (`public_view`)
      Add `priceType` (default `"user_pays"`), `maxPrice` (if present), `currency` (default
      `MYR`) to the view for BOTH owner and non-owner (not sensitive). Do not change the
      address-masking logic.
      Verify: `pytest -q` — existing `test_public_view_*` still pass (they only assert
      address masking); new assertions added in step 11.

- [ ] 5. Turn `request_collect` into a quote submission with the pinned 9-step order and
      remove the single-quote waste-item flip.
      File: `...\lambdas\collect\app.py` (`request_collect`)
      Enforce EXACTLY this order (authoritative, from Part A of the design):
      1. missing `requestId`/`wasteId` → `400`.
      2. no `creq_table`/`table` → `503`.
      3. `_get_waste` None → `404 {"error":"Waste item not found"}`.
      4. self-collect (`waste["ownerId"] == claims["sub"]`) →
         `400 {"error":"You cannot collect your own item"}` (EXISTING guard, kept, and
         intentionally BEFORE the collector gate so an owner quoting their own paid listing
         gets this clearer message, not a 403).
      5. item still open (`waste.get("status") not in ("open", None)`) →
         `409 {"error":"This item is no longer available"}` (EXISTING precondition, KEPT).
      6. collector gate (Part C): if `(waste.get("priceType") or "user_pays") == "user_pays"`
         and `not _is_approved_collector(claims["sub"])` →
         `403 {"error":"Only verified collector businesses can quote on paid pickups"}`.
      7. read `quoteAmount` via `_dec_price` + optional `message` (`[:500]`), then
         `_validate_quote(amount, _dec_price(waste.get("maxPrice")))`; on not-ok → `400`
         with the returned error.
      8. duplicate-live-quote: paginated `wasteIndex` query (HASH `wasteId`, NO `Limit`,
         loop `LastEvaluatedKey` until exhausted) → filter in Lambda to
         `collectorId == claims["sub"] and status in LIVE_QUOTE_STATUSES`; any match →
         `409 {"error":"You already have a live quote on this item"}`.
      9. persist the collect-request with `status="requested"`, snapshot `quoteAmount`
         (Decimal), `currency` (copied from waste, default `MYR`), `maxPrice` (copied from
         waste if present), `message`, and `paymentStatus` left unset until confirm.
      REMOVE ENTIRELY the existing `table.update_item(... status="requested" ...)` block
      (the single-quote flip). The waste item stays `"open"` so multiple quotes coexist.
      Keep the owner `notify(... "request" ...)` call. Return `_creq_view(cr)` (no waste).
      Verify: `pytest -q` passes; the paginated query + persist are integration-tested
      manually (noted in Testability).

- [ ] 6. Rewrite `_creq_view` to use `UNLOCK_STATUSES` and always expose price fields.
      File: `...\lambdas\collect\app.py` (`_creq_view`)
      Always add to the base view (NOT gated by unlock): `quoteAmount`, `currency`,
      `maxPrice`, `paymentStatus`, and keep existing `message`. Change the unlock condition
      from `cr.get("status") == "approved"` to
      `cr.get("status") in UNLOCK_STATUSES and waste` — only then set `unlocked=True` and
      copy `fullAddress`/`ownerPhone`/`pickupTime`/`notes`.
      Verify: `pytest -q` — step 11 adds the NIT#6 assertions (price fields present but
      contact absent for `requested`/`accepted`; present for each `UNLOCK_STATUSES` status
      when `waste` passed; absent when `waste=None`).

---

## PART B — Disintermediation state machine + MEDIUM fixes

- [ ] 7. Update every guard/call-site to the new state machine (the CRITICAL correctness
      block). File: `...\lambdas\collect\app.py`
      - `approve_request`: guard unchanged (owner, status `requested`); set status to
        `"accepted"` (was `"approved"`). REMOVE the waste-item flip to `collecting` and the
        "address unlocked" notification. New collector notification: "Your quote was
        accepted — awaiting the owner's confirmation." Return `_creq_view(cr)` with NO waste
        object (nothing unlocks at `accepted`). Does NOT auto-close other quotes.
      - `reject_request`: guard unchanged (owner, status `requested`); set `"rejected"`.
        REMOVE the unconditional `table.update_item(... status="open" ...)` — rejecting one
        quote must not disturb a listing holding other live quotes; touch ONLY the
        collect-request row. (The item is already `open` since quoting no longer flips it.)
      - `mark_done`: change guard from `status != "approved"` to
        `status not in ("confirmed",)` → else `400`. On success set collect-request
        `"collected"` (+`completedAt=int(time.time())`) and waste item `"collected"`.
        NIT#3: add a one-line comment that the waste-item write is an UNCONDITIONAL set to
        `collected` regardless of its prior status.
      - `_chat_enabled`: return `cr.get("status") in CHAT_STATUSES` (was
        `("approved","collected")`).
      - `get_messages` / `send_message` / `list_conversations`: logic unchanged; they
        inherit the stricter `_chat_enabled` (now `confirmed`+). No separate status list.
      - `list_requests` BOTH loops (incoming AND outgoing): change the waste-load gate from
        `if cr.get("status") == "approved"` to `if cr.get("status") in UNLOCK_STATUSES`:
        ```python
        v = _creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") in UNLOCK_STATUSES else None)
        ```
        (CRITICAL — without this, confirmed deals get `waste=None` and never unlock.)
      Verify: `pytest -q` — `_chat_enabled` and `_creq_view` unit tests (step 11) pass;
      transitions integration-tested manually.

- [ ] 8. Add `confirm_deal` (NEW) with MEDIUM-1 one-confirmed-deal enforcement + write order.
      File: `...\lambdas\collect\app.py` (new function, dispatched for `/confirm`)
      Guard: caller is owner; current collect-request status `accepted` (else `409`).
      MEDIUM-1: at the TOP, re-load the waste item (`_get_waste(cr["wasteId"])`) and if
      `waste.get("status") == "collecting"` AND `waste.get("collectorId")` is set AND it
      differs from this request's `collectorId` → return
      `409 {"error":"This item already has a confirmed collector"}`.
      WRITE ORDER (strict, MEDIUM-1):
      1. set collect-request `status="confirmed"`, `confirmedAt=int(time.time())`,
         `paymentStatus="not_required"`  `# Phase 2: Stripe PaymentIntent authorization goes here`.
      2. set waste item `status="collecting"` (+ `collectorId`, `collectorName`); if THIS
         write fails, return `500` WITHOUT returning the unlocked `_creq_view` (perform the
         waste-item write BEFORE building/returning the unlocked view).
      3. BEST-EFFORT auto-close (MUST NOT fail the confirm): paginated `wasteIndex` query,
         move every OTHER collect-request for this `wasteId` with status in
         `("requested","accepted")` to `"closed"`, notifying each losing collector ("Another
         collector was selected"). Wrap in try/except; log failures; never raise.
      Add an inline comment at the `confirmed`/waste-`collecting` sites that `collecting` is
      a waste-item status, never a collect-request status.
      Notify the chosen collector ("Deal confirmed — address and contact unlocked, chat is
      open."), reusing the `"approved"` push type.
      Return `_creq_view(cr, _get_waste(cr["wasteId"]))` (now unlocks).
      Verify: `pytest -q` passes (confirm_deal auto-close is integration-tested manually).

- [ ] 9. Add `cancel_request` (NEW) with MEDIUM-2 revert semantics, and `raise_dispute`
      (NEW). File: `...\lambdas\collect\app.py` (dispatched for `/cancel` and `/dispute`)
      `cancel_request` (withdraw/back-out, either party; NEVER deletes):
      - Pre-confirm (`requested` or `accepted`): either member sets status `"cancelled"`,
        `cancelledAt`. Waste item untouched (stays `open`). Nothing to revoke.
      - Post-confirm (`confirmed`): either member sets `"cancelled"`, `cancelledAt`. Then
        MEDIUM-2: run a PAGINATED `wasteIndex` query (NO `Limit`, loop `LastEvaluatedKey`),
        filter collect-request `status == "confirmed"` EXCLUDING the row being cancelled;
        revert the waste item to `"open"` ONLY IF that query finds zero other confirmed
        deals. Put a one-line comment at the cancel site: "Auto-closed losing quotes are NOT
        restored on cancel; owner re-lists and collectors re-quote." Leave `paymentStatus`
        as-is behind `# Phase 2: trigger Stripe refund/void here`. Notify both parties.
      - `collected`/`rejected`/`closed`/`disputed`/`cancelled` → `409` (not cancellable).
      `raise_dispute` (NEW): guard caller is `_is_member` and status in
      `("confirmed","collected")` (else `409`; `disputed` excluded so it can't be re-raised).
      Set `status="disputed"`, `disputeReason=_s(body.get("reason"))[:1000]`,
      `disputedAt=int(time.time())`, `disputedBy=claims["sub"]`. Notify the other party.
      `# Phase 2: refund/arbitration hooks attach here`. Records+notifies only — no refund.
      Verify: `pytest -q` passes.

---

## PART C — Collector business accounts + verification (`lambdas/collect/app.py`)

- [ ] 10. Add the collector helpers, routes, and the `_is_approved_collector` gate used by
      step 5. File: `...\lambdas\collect\app.py`
      Helpers: `_get_collector(user_id)` (get_item on `collectors_table`, None on error),
      `_is_approved_collector(user_id)` (`True` only if a record exists and
      `status == "approved"` — fails closed).
      Routes (handlers; wired via the dispatcher in step 13):
      - `POST /collector/apply` — upsert a `draft` record (`status="draft"`, `createdAt`,
        `updatedAt`); idempotent (re-apply keeps data).
      - `POST /collector/submit` — `draft` → `pending`. Validate non-empty required fields
        in order (`businessName`, `registrationNumber`, `wasteCarrierLicense`,
        `serviceAreas` non-empty list, `wasteCategories` non-empty list, `contactPhone`,
        `contactEmail`) → `400` naming the first missing. Reject if already
        `approved`/`pending` → `409`. Set `updatedAt`. Notify applicant.
      - `GET /collector/me` — the caller's record, or `{"status":"none"}` if absent.
      - `POST /collector/upload-url` — body `{docType, contentType}`; validate
        `docType in DOC_TYPES` → `400`; NIT#5: validate `contentType` against the allow-list
        `{"image/png","image/jpeg","application/pdf"}` → `400` otherwise; key is
        `collectors/{userId}/{docType}`; return `{url, key}` from
        `s3.generate_presigned_url("put_object", Params={Bucket, Key, ContentType},
        ExpiresIn=300)` (the signed `ContentType` MUST equal the browser PUT's
        `Content-Type`); record the key in `docKeys[docType]`.
      All timestamps epoch seconds (`int(time.time())`). Reuse `notify`/`json_response`/`_s`.
      Verify: `pytest -q` passes (`_is_approved_collector` with a stubbed `_get_collector`
      is unit-testable; the quote gate behavior is covered via `request_collect` reasoning).

---

## PART D — Admins group + verification queue (`lambdas/collect/app.py`)

- [ ] 11. Add the admin check and the four admin collector-management routes.
      File: `...\lambdas\collect\app.py`
      - `_is_admin(claims)`: `return "admins" in (claims.get("cognito:groups") or [])`.
        NIT#7: add a one-line comment near the check that `cognito:groups` is token-scoped,
        so a newly-added admin must re-login / wait for token refresh before admin routes
        work.
      - `GET /admin/collectors?status=pending` — `_is_admin` gate (`403`); validate `status`
        against `{pending,approved,rejected,suspended}` (default `pending`) → `400`; query
        `collectors.statusIndex`, newest first; for each `docKeys` entry attach a presigned
        GET URL (`ExpiresIn=300`), tolerating a missing object.
      - `POST /admin/collectors/{id}/approve` — `pending` → `approved`; set
        `verifiedAt=int(time.time())`, `verifiedBy=claims["sub"]`, `updatedAt`; notify.
        `409` if not `pending`, `404` if missing.
      - `POST /admin/collectors/{id}/reject` — body `{reason}`; `pending` → `rejected`;
        store `rejectionReason=_s(...)[:1000]`; notify with reason. `409`/`404` as above.
      - `POST /admin/collectors/{id}/suspend` — `approved` → `suspended`; notify. `409` if
        not `approved`.
      `{id}` is the collector `userId`, parsed by the dispatcher (step 13).
      Verify: `pytest -q` — `_is_admin` unit test (step 12) passes.

---

## PART — Backend dispatcher (resolves the /admin/approve collision)

- [ ] 12. Add PREFIX-based dispatch in front of the existing `endswith` chain for POST and
      GET, and add the new `endswith` suffixes. File: `...\lambdas\collect\app.py` (`handler`)
      In the POST branch, BEFORE the existing `endswith` chain, add:
      ```python
      if route.startswith("/admin/"):     return _unwrap(dispatch_admin(claims, route, body))
      if route.startswith("/collector/"): return _unwrap(dispatch_collector(claims, route, body))
      ```
      Add to the `endswith` chain (new suffixes): `confirm` → `confirm_deal`,
      `cancel` → `cancel_request`, `dispute` → `raise_dispute`. Keep the existing `report`,
      `request`, `approve`, `reject`, `done`, `message`, `subscribe`/`unsubscribe`, `read`.
      In the GET branch, BEFORE the existing suffix chain, add:
      ```python
      if route.startswith("/collector/"): return _unwrap(dispatch_collector_get(claims, route))
      if route.startswith("/admin/"):     return _unwrap(dispatch_admin_get(claims, route))
      ```
      `dispatch_admin(claims, route, body)` splits `route` on `/`
      (`["","admin","collectors","<id>","<action>"]`), validates
      `action in {approve,reject,suspend}` → `400`, checks `_is_admin` FIRST → `403`, calls
      the matching function with the parsed `id`. `dispatch_collector` routes
      `apply`/`submit`/`upload-url`. `dispatch_collector_get` routes `/collector/me`;
      `dispatch_admin_get` routes `GET /admin/collectors`.
      RATIONALE: a naive `/admin/collectors/{id}/approve` would be captured by
      `route.endswith("approve")` → `approve_request` before any admin branch (verified real
      collision), hence prefix-first dispatch.
      Verify: `pytest -q` passes (routing is integration-tested manually; module imports
      cleanly under stubs).

---

## PART — Unit tests (`tests/test_collect.py`)

- [ ] 13. Add unit tests for every new pure function per the design Testability list.
      File: `c:\programming\kiroaws\smartwaste-app\.worktrees\phase1-marketplace\tests\test_collect.py`
      Add tests covering:
      - `_dec_price` — `"5"`→Decimal 5, `"1.555"`→2dp rounding, `""`/junk→None, negative→None.
      - `_validate_quote(amount, max_price)` — `None`→(False,msg); `<=0`→(False,msg);
        `> max`→(False, "Quote exceeds the owner's maximum price"); within/no-max→(True,None).
      - `_creq_view`:
        - `requested` and `accepted`: assert `fullAddress`/`ownerPhone`/`unlocked` ABSENT
          even when a waste object is passed; NIT#6 — assert `quoteAmount`, `currency`,
          `maxPrice`, `paymentStatus` PRESENT (never gated by unlock).
        - each status in `UNLOCK_STATUSES` (`confirmed`/`collected`/`disputed`) WITH a waste
          object: assert `unlocked is True` and `fullAddress`/`ownerPhone` present.
        - each `UNLOCK_STATUSES` status WITH `waste=None`: assert contact ABSENT (documents
          the Part B item-7 call-site contract). Rename
          `test_creq_view_unlocks_when_approved` → reflects `confirmed`.
      - `_chat_enabled` — False for `requested`/`accepted`/`rejected`/`cancelled`/`closed`;
        True for every status in `CHAT_STATUSES`.
      - `_is_admin` — True only when `cognito:groups` contains `"admins"`; False for empty
        list, missing claim, other groups.
      - `public_view` — `priceType`/`maxPrice`/`currency` present; non-owner still masked
        (existing assertions preserved).
      Verify: from the worktree root, `pip install -r requirements-dev.txt` then `pytest -q`
      — ALL tests pass (existing + new).

---

## PART E — Frontend SPA wiring (vanilla; no framework/build)

Files: `...\frontend\index.html`, `...\frontend\app.js`, `...\frontend\style.css`.
Do NOT touch the Future Actions tab (`renderFurtherActions`, flowchart/cards).

- [ ] 14. Listing form: max-price + currency.
      Files: `...\frontend\index.html` (`reportForm`), `...\frontend\app.js` (report submit)
      Add after `rfArea`: `rfMaxPrice` (number, step 0.01, min 0, "Maximum price you'll pay
      (optional)") and `rfCurrency` (select, default `MYR`; MYR/SGD/USD). In the submit
      handler add `priceType: "user_pays"`, `currency`, and `maxPrice` (only if non-empty)
      to the POST body; if `maxPrice` present it must parse to a number `> 0` else show the
      existing `reportError`.
      Verify: load the SPA (or lint the JS: `node --check frontend/app.js`); the form shows
      the two new fields and a priced listing POSTs the new body. (No JS test harness exists;
      verification is `node --check` + manual.)

- [ ] 15. Collector quote submission, gated by `/collector/me`.
      Files: `...\frontend\index.html`, `...\frontend\app.js`
      On a Type B portal listing card, primary action becomes "Submit Quote" → overlay with
      an amount input (hint "Owner's max: {maxPrice} {currency}" when set) + optional message
      → `collectFetch('POST', {wasteId, quoteAmount, message}, 'request')`. `403` → "You need
      to be a verified collector to quote — apply from your Profile."; `400`/`409` → surface
      the server `error` text verbatim (incl. the "no longer available" 409). Gate the quote
      UI with `GET /collector/me`: non-approved users see the apply CTA instead of the amount
      form.
      Verify: `node --check frontend/app.js`; manual — approved vs non-approved paths.

- [ ] 16. Owner multi-quote review + confirm, with the unlock point strictly server-driven.
      File: `...\frontend\app.js`
      - NEW `renderIncomingQuotesForWaste(wasteId)`: filter `lifecycleRequests.incoming` to
        `cr.wasteId === wasteId && cr.role === 'owner'`, sort by `quoteAmount` asc, render
        one card per quote into `#notifDetail` (`notifDetailEl`) with `collectorName`,
        `quoteAmount`+`currency`, `maxPrice`, `message` (all `escapeHtml`), `statusBadge`.
        Per-card actions: `requested`→Accept `data-approve`; `accepted`→Confirm deal
        `data-confirm` + Cancel `data-cancel`; `cr.unlocked===true`→View details `data-open`;
        terminal (`rejected`/`closed`/`cancelled`)→status only. Then call
        `wireNotifDetailActions()` once.
      - `openRequestInNotifications(wasteId)`: change from "find one row and show it" to
        "once `lifecycleRequests` is populated, call `renderIncomingQuotesForWaste(wasteId)`"
        (keep the existing retry/`setTimeout` loop).
      - `showNotifDetailForCollectRequest(cr, typeLabel)`: add branch
        `else if (cr && cr.role === 'owner' && cr.status === 'accepted')` → Confirm deal
        (`data-confirm`) + Cancel (`data-cancel`), copy "You picked this quote. Confirm to
        share your address and open chat." — NO address/phone shown. Change the unlock
        branch condition from `cr.status === 'approved'` to `cr && cr.unlocked === true`
        (`['confirmed','collected','disputed'].indexOf(cr.status) !== -1`); body unchanged
        (address/phone/pickup/notes + Open Chat + Mark as Collected) plus Report a problem
        (`data-dispute`) for `confirmed`/`collected` and Cancel job (`data-cancel`) for the
        owner on a `confirmed` job.
      - `wireNotifDetailActions`: add `[data-confirm]`→`act('confirm',id,btn)`,
        `[data-cancel]`→`act('cancel',id,btn)`, `[data-dispute]`→reason box then
        `collectFetch('POST', {collectRequestId:id, reason}, 'dispute')`,
        `[data-open]`→`showNotifDetailForCollectRequest(findCollectRequest(id))`.
      The frontend never infers unlock from anything but the server's `cr.unlocked`/status.
      Verify: `node --check frontend/app.js`; manual — Accept shows NO contact; only Confirm
      yields `unlocked===true` and the unlock card.

- [ ] 17. `statusBadge` labels + CSS; cancel/dispute placement by stage; fmtTime guard.
      Files: `...\frontend\app.js` (`statusBadge`), `...\frontend\style.css`
      Extend the `statusBadge` label map with `accepted:'Accepted'`,
      `confirmed:'Confirmed'`, `cancelled:'Cancelled'`, `closed:'Not selected'`,
      `disputed:'Disputed'`. Add `.status-accepted`/`.status-confirmed`/`.status-cancelled`/
      `.status-closed`/`.status-disputed` CSS (confirmed/collected green-ish; cancelled/
      closed grey; disputed/rejected red). Place actions by stage: Cancel/Withdraw on the
      request card for `requested`/`accepted`; Cancel job on the active `confirmed` job in
      History; Report a problem on `confirmed`/`collected` jobs — NEVER delete client-side.
      Reflect new statuses as terminal cards in History/Notifications. `fmtTime` guard: only
      the new epoch-seconds fields may be passed to `fmtTime`; any collect-request/message
      `createdAt` (microseconds) must be divided by `1e6` first (Phase-1 UI renders only safe
      seconds fields — keep it that way).
      Verify: `node --check frontend/app.js`; manual — new badges render with color.

- [ ] 18. "Become a collector" on Profile + document upload.
      Files: `...\frontend\index.html` (Profile section), `...\frontend\app.js`
      Profile "Collector account" section: a "Become a collector" button when
      `GET /collector/me` returns `status:"none"`, else a status display (draft/pending/
      approved/rejected/suspended + rejection reason). Apply/submit form: business name,
      registration number, waste-carrier license, service areas, waste categories, contact
      phone/email, plus a document-upload row per `docType`. Upload flow:
      `POST /collector/upload-url` passing the file MIME as `contentType` → presigned PUT →
      `fetch(url, {method:'PUT', headers:{'Content-Type':file.type}, body:file})` directly
      to S3 (NO bearer header; `Content-Type` must match the presign). Then
      `POST /collector/apply` → `POST /collector/submit`; show returned status.
      Verify: `node --check frontend/app.js`; manual — apply→submit shows `pending`.

- [ ] 19. Admin route `#/admin/collectors` (admins only) + `Auth.profile()` groups.
      File: `...\frontend\app.js`
      Patch BOTH return paths of `Auth.profile()` to add `groups`: live-session branch
      `groups: payload['cognito:groups'] || []`; localStorage branch
      `groups: claims['cognito:groups'] || []`. Add a `ROUTES` entry
      `'admin': { view:'adminOverlay', gated:true, enter:onEnterAdmin }` and an "Admin" nav
      entry shown only when `(Auth.profile().groups || []).indexOf('admins') !== -1`.
      `onEnterAdmin` calls `GET /admin/collectors?status=pending`, renders queue cards
      (business name, numbers, service areas, document View links using the returned
      presigned GET URLs) with Approve / Reject (reason) / Suspend buttons wired to the admin
      POST routes, then refreshes. This gate is convenience only — the server re-verifies via
      `_is_admin`, so forcing the hash still returns `403`.
      Add the `adminOverlay` section to `index.html`.
      Verify: `node --check frontend/app.js`; manual — Admin nav visible only with the group
      claim; approve/reject/suspend hit the backend.

---

## Final verification

- [ ] 20. Full build/test gate from the worktree root.
      Run: `pip install -r requirements-dev.txt` then `pytest -q` — ALL unit tests pass.
      Run `node --check frontend/app.js` — no JS syntax errors.
      Validate `infra/template.yaml` (SAM `sam validate` if available, else confirm the new
      resources parse). Confirm the disintermediation invariant by re-reading `_creq_view`,
      `_chat_enabled`, and BOTH `list_requests` call-sites: no contact/chat reachable before
      status `confirmed`; `approve_request` passes no waste and unlocks nothing.

## Gaps / assumptions
- No JS unit-test harness exists; frontend verification is `node --check` + manual, matching
  the repo's "pure logic only" automated-test scope.
- DynamoDB/S3/Cognito paths (confirm_deal auto-close, pagination, presign, admin query,
  end-to-end transitions) are integration-tested manually, consistent with existing practice.
- `collectFetch(method, body, pathSuffix)` is assumed to join `STREAM_URLS.collect + suffix`
  such that `/collector/apply`, `/admin/collectors`, `/admin/collectors/{id}/approve`, and
  `?status=pending` resolve correctly; the implementer confirms the suffix concatenation.
