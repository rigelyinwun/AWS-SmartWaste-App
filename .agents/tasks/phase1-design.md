# Phase 1 Design — Type B Marketplace Monetization Layer

> Revision 3. The revision-2 rewrite cleared the earlier review; this revision resolves
> every finding in the latest `.agents/tasks/design-review.md` / `design-review.json`
> (verdict CHANGES_REQUESTED, **0 HIGH / 3 MEDIUM / 4 NIT**). Each finding's resolution is
> recorded in the **Review responses (revision 3)** section at the end; the body below is
> already corrected to be internally consistent. (The revision-2 responses are retained
> below revision 3 for history.)

## Overview

SmartWaste today runs a free peer-to-peer (P2P) collection flow: an owner analyzes a
waste photo, lists it ("Allow Public Collect"), any logged-in user requests to collect
it, the owner approves one request, and on approval the owner's `fullAddress`/`phone`
unlock and chat opens. This phase layers a **Type B marketplace** on top of that flow —
**the user who posts the item pays a verified collector business to remove/dispose of
it** — while introducing the structural property the business model depends on:
**disintermediation protection**, i.e. the two parties cannot see each other's contact
details or chat until the owner has explicitly committed to a specific collector's
quote. Commission on the payment is the eventual revenue, but **no real money moves in
Phase 1**; everything money-related is a commented placeholder for a Phase 2 Stripe
integration.

The work spans five parts: (A) priced listings and multi-quote collection requests,
(B) an explicit collect-request state machine that gates contact/chat behind a
`confirmed` state, (C) verified collector-business accounts backed by a new `collectors`
table, (D) a Cognito `admins` group and an admin verification queue, and (E) the vanilla
frontend wiring for all of the above. The existing "Future Actions" tab is **not**
touched — the user explicitly declined any reorder/restructure of it.

A deliberate Phase-1 limitation, called out here so no one mistakes it: because payment
is deferred, **`confirm_deal` has no payment precondition** — either party can reach
`confirmed` (and thus unlock contact + chat) with zero payment friction. In Phase 1 the
disintermediation gate is therefore gated on **owner intent**, not on money. The Stripe
authorization that will gate `accepted → confirmed` is stubbed (see Phase 2 stubs).

### Technology stack (locked once approved)

No new frameworks or build steps. Backend stays **Python 3.12 Flask on the AWS Lambda
Web Adapter** (`lambdas/collect/app.py`, `lambdas/profile/app.py`), JWT verified against
Cognito JWKS exactly as `verify_token` does today. Data stays **DynamoDB** (PAY_PER_REQUEST,
GSIs), auth stays **Cognito User Pool + app client**, real-time chat stays **AppSync
Events**, Web Push stays **pywebpush**. Infra stays **AWS SAM** (`infra/template.yaml`).
Frontend stays **vanilla ES5-style JS SPA** with the hash router, `collectFetch`/
`profileFetch` bearer-token helpers, and the notification feed. Money (Phase 2) will be
**Stripe**, stubbed here only.

### Shared module constants (single source of truth)

Two module-level tuples in `lambdas/collect/app.py` are the authoritative definition of
when contact/chat open. **Every** reader references these — no function inlines its own
status list:

```python
# The ONLY collect-request statuses at which a collect-request exposes contact
# details / opens chat. A collect-request only ever reaches confirmed/collected/
# disputed (disputed is reachable only from confirmed+ — see raise_dispute guard),
# so nothing unlocks before confirmed. These two sets are intentionally identical.
UNLOCK_STATUSES = ("confirmed", "collected", "disputed")
CHAT_STATUSES   = UNLOCK_STATUSES
# Live (not terminal) collect-request statuses, used for duplicate-quote and auto-close.
LIVE_QUOTE_STATUSES = ("requested", "accepted", "confirmed")
```

These tuples are the **collect-request-facing** unlock/live sets and contain **only**
statuses a collect-request can actually hold. `collecting` is deliberately **absent** from
both: it is a **waste-item-only** status (see Part B) — a collect-request goes
`confirmed → collected` and is never set to `collecting`. Keeping `collecting` out of these
security-critical tuples makes the invariant exactly provable (the unlock set is minimal
and every member is a reachable collect-request status) and prevents a future reader from
wiring a `collecting` transition onto a collect-request on the mistaken assumption it is
supported here. The one place a collect-request status could be mis-set — `confirm_deal`
(sets `confirmed`) and `mark_done` (sets `collected`) — carries an inline comment that
`collecting` belongs to the waste item, never the collect-request.

### Decisions summary (rationale in the relevant parts)

- **(a) Account type:** derive from the new `collectors` table, **not** a Cognito
  `custom:account_type` attribute. (Part C.)
- **(b) Verification documents:** **private S3 bucket with presigned PUT/GET**, not a
  reference-string stub. (Part C.)
- **(c) Route placement:** collector + admin routes live in the **collect Lambda**
  (`lambdas/collect/app.py`), reusing its `verify_token`, `notify`, `push_send`,
  `_s`, `json_response`, and DynamoDB resources, with a **prefix-based dispatcher** added
  in front of the existing `endswith` chain. (Part C/D and the Dispatcher section.)

### Timestamp convention

All **new** timestamps are epoch **seconds** via `int(time.time())`, matching the
existing `completedAt`: `confirmedAt`, `disputedAt`, `cancelledAt` on collect-requests,
and `verifiedAt`, `createdAt`, `updatedAt` on `collectors`. (The collect-request
`createdAt` and message `createdAt` remain microseconds via `_now_micros()` as today —
those are sort keys and are not touched.) `_item_epoch_seconds` is unchanged and still
only normalizes `completedAt`/`createdAt` for analytics, which is fine because none of the
new second-based fields feed analytics.

**Frontend render safety (which fields may go through `fmtTime`).** `fmtTime(ts)` in
`frontend/app.js` does `new Date(ts * 1000)`, i.e. it expects epoch **seconds**. Only the
new epoch-seconds fields (`confirmedAt`, `disputedAt`, `cancelledAt`, `verifiedAt`,
collectors `createdAt`/`updatedAt`) may be passed to `fmtTime` directly. The pre-existing
collect-request/message `createdAt` is **microseconds** and must **not** be passed to
`fmtTime` without first dividing by `1e6` (it would otherwise render as a far-future date).
Phase-1 UI renders only the new seconds fields and the already-correctly-handled waste
`createdAt` (seconds), so no new code passes a microsecond value to `fmtTime`; this note
exists so any future card that surfaces `confirmedAt`/`cancelledAt` next to a collect-
request `createdAt` divides the latter by `1e6` first.

---

## PART A — Type B pricing and quotes

### Listing price fields (`waste_requests`, written by `create_report`)

Three new **optional, backward-compatible** fields are added to the item written in
`create_report` (collect `app.py`):

- `priceType` — string, default `"user_pays"`. The only value in Phase 1; reserved so a
  future free/`company_pays` mode is additive.
- `maxPrice` — `Decimal` or absent. The owner's ceiling; collectors cannot quote above it.
- `currency` — string, default `"MYR"`.

`create_report` reads these from the request body:

```python
price_type = _s(body.get("priceType")) or "user_pays"
currency = (_s(body.get("currency")) or "MYR")[:3].upper()
max_price = _dec_price(body.get("maxPrice"))   # Decimal or None; see validation below
item["priceType"] = price_type
item["currency"] = currency
if max_price is not None:
    item["maxPrice"] = max_price
```

A new money helper lives next to the existing `dec()` closure pattern:

```python
def _dec_price(v):
    """Parse a money value to a non-negative Decimal, or None if blank/invalid.
    Rounds to 2 dp. Used for maxPrice and quoteAmount."""
    s = _s(v)
    if not s:
        return None
    try:
        d = Decimal(s).quantize(Decimal("0.01"))
    except Exception:
        return None
    return d if d >= 0 else None
```

Existing listings created before this change simply have no `priceType`/`maxPrice`/
`currency`; readers treat a missing `priceType` as `"user_pays"` and a missing `maxPrice`
as "no ceiling". That is the backward-compatibility contract.

### Quotes (`request_collect` becomes a quote submission)

A collect-request now carries a quote. `request_collect` runs its checks in this **exact,
authoritative order** (this is the single source of truth for ordering; Part C's
enforcement snippet is a fragment of step 6, not a separate "first" check):

1. **Missing waste id** (`requestId`/`wasteId` both blank) → `400`.
2. **Service unavailable** (no `creq_table`/`table`) → `503`.
3. **Waste not found** (`_get_waste` returns `None`) → `404`.
4. **Self-collect guard** (`waste["ownerId"] == claims["sub"]`) → `400 {"error":"You cannot
   collect your own item"}`. **Existing guard, unchanged, and intentionally ordered before
   the collector gate** so an owner who happens to also be a collector and quotes on their
   own paid listing gets the clearer "cannot collect your own item" message rather than an
   opaque `403`.
5. **Item still open** (`waste.get("status") not in ("open", None)`) → `409` (existing
   precondition, kept — see "Multiple quotes" for why it no longer blocks a 2nd quote).
6. **Collector verification** (Part C): if `(waste.get("priceType") or "user_pays") ==
   "user_pays"` and the caller is not an approved collector (`_is_approved_collector`) →
   `403`. (Needs the waste item's `priceType`, hence it runs here, after the waste load —
   not literally first.)
7. Read `quoteAmount` via `_dec_price` and optional `message`, then **validate** via the
   pure helper `_validate_quote(amount, max_price)` (below) before any write: `quoteAmount`
   present and `> 0` → else `400 {"error":"A quote amount greater than 0 is required"}`; if
   the listing has a `maxPrice`, `quoteAmount <= maxPrice` → else `400 {"error":"Quote
   exceeds the owner's maximum price"}`. `max_price` is read live from the waste item
   (`_dec_price(waste.get("maxPrice"))`).
8. **Reject duplicate live quotes** by the same collector (see below) → `409`.
9. Persist the collect-request with `status="requested"`, snapshotting `quoteAmount`
   (Decimal), `currency` (copied from the waste item, default `MYR`), and **`maxPrice`
   copied from the waste item** (see "maxPrice provenance" below), plus `message`.

Pure, unit-testable validator:

```python
def _validate_quote(amount, max_price):
    """(ok, error) — amount is the parsed Decimal quote; max_price is Decimal or None."""
    if amount is None or amount <= 0:
        return False, "A quote amount greater than 0 is required"
    if max_price is not None and amount > max_price:
        return False, "Quote exceeds the owner's maximum price"
    return True, None
```

#### maxPrice provenance (resolves ambiguity)

The ceiling used for **validation** is read live from the waste item in `request_collect`
(`_dec_price(waste.get("maxPrice"))`). The ceiling shown in the **collector-facing view**
is **snapshotted onto the collect-request at creation** (`cr["maxPrice"] = <waste maxPrice>`),
so `_creq_view` never needs to re-load the waste item just to show a ceiling. Single rule
on edits: **owner edits of `maxPrice` do not retro-invalidate existing live quotes** — a
quote validated against the ceiling at submission time stays valid; a later lowering of
`maxPrice` only affects *new* quotes. (Phase 1 has no listing-edit UI, so this is a
forward-stated rule, not a code path yet.)

#### Multiple quotes per listing (the single-quote flip is removed)

The current code makes a listing single-quote by two mechanisms that are **both removed**:

- **(a)** `request_collect` runs an `update_item` that sets the waste item
  `status = "requested"`. **Delete this `update_item` entirely.** The waste item stays
  `"open"` so it remains listable and can accept further quotes.
- **(b)** The precondition `waste.get("status") not in ("open", None)` → `409
  {"error":"This item is no longer available"}` is **kept** (so you cannot quote a
  `collecting`/`collected`/closed item), but because of (a) the item never leaves `open`
  while quotes accumulate, so this no longer blocks a second quote.

A listing therefore holds **many** `collect_requests` in `requested` state at once.

#### Duplicate-quote prevention (per collector)

Before insert, query the existing `wasteIndex` GSI (HASH `wasteId`, RANGE `createdAt`,
projection ALL — confirmed present) for **all** rows of this `wasteId` (no `Limit`;
paginate via `LastEvaluatedKey` until exhausted), then **in Lambda** filter to rows where
`collectorId == claims["sub"]` and `status in LIVE_QUOTE_STATUSES`. If any match, reject
with `409 {"error":"You already have a live quote on this item"}`. Collector-identity and
live-status filtering are done in code (the GSI is keyed by `wasteId`, not collector), and
pagination guarantees an older live quote is not missed.

#### Approving one auto-closes the rest

When the owner **confirms** a deal (Part B `confirm_deal`), every *other* `collect_request`
for that `wasteId` with `status in ("requested", "accepted")` is moved to `"closed"` with a
notification to each losing collector ("Another collector was selected"). Implemented by a
paginated `wasteIndex` query + per-row guarded `update_item`. (Auto-close happens at
`confirm`, not at `accept`, so the owner can still back out of an `accepted` quote before
committing.)

### View exposure (`_creq_view`, `public_view`, `list_*`)

- `public_view` (listing cards): add `priceType`, `maxPrice`, `currency`. These are **not**
  sensitive, so they appear for owner and non-owner alike. No address/phone change here.
- `_creq_view` (collect-request): **always** expose `quoteAmount`, `currency`, `message`,
  `maxPrice` (the snapshot), and `paymentStatus`. Contact unlock is governed strictly by
  `UNLOCK_STATUSES` (Part B), never by price.
  - **Owner-facing** (`list_requests` incoming): owner sees each incoming quote's
    `quoteAmount`/`collectorName`/`message` to compare — their own inbound offers, not
    sensitive.
  - **Collector-facing** (`list_requests` outgoing): collector sees their own
    `quoteAmount` and the snapshotted listing `maxPrice`.

---

## PART B — Disintermediation state machine (the critical property)

### The invariant

> **No code path exposes `fullAddress`, `phone`, or enables chat before the collect-request
> reaches a status in `UNLOCK_STATUSES` (`confirmed`, and the post-confirm states
> `collected`/`disputed`). The earliest unlocking status is `confirmed`.**

Today `_creq_view` unlocks on `status == "approved"` and `_chat_enabled` returns true for
`approved`/`collected`. That is exactly the disintermediation hole: the moment the owner
"approves" (which under the free model is also the commitment moment), contact leaks. We
split "approve a quote" (now `accepted`, leaks nothing) from "commit to the deal" (new
`confirm_deal` → `confirmed`, the first unlocking state).

### Full status set (`collect_requests.status`)

```
requested ──accept──▶ accepted ──confirm──▶ confirmed ──mark_done──▶ collected
   │                     │                      │
 reject                cancel                 cancel / dispute
   ▼                     ▼                      ▼
rejected              cancelled           cancelled / disputed
   (other quotes when one is confirmed ──▶ closed)
```

- `requested` — a quote exists; owner has not acted. No unlock, no chat.
- `accepted` — owner picked this quote (`approve_request`). **Still no unlock, no chat.**
  Signals intent only; is where Phase 2 will insert the Stripe authorization step.
- `confirmed` — owner ran **`confirm_deal`** (the deliberate commit). Records
  `paymentStatus="not_required"` (Phase 2 placeholder). **First state in `UNLOCK_STATUSES`;
  unlocks `fullAddress`/`phone` and opens chat.**
- `collected` — `mark_done` completed the job. In `UNLOCK_STATUSES`; chat stays open.
- `rejected` — owner declined a `requested` quote.
- `closed` — a non-selected quote auto-closed when another was confirmed.
- `cancelled` — a soft cancel (never deleted). See cancel rules.
- `disputed` — a dispute was raised (records + notifies only in Phase 1). Reachable only
  from `confirmed`/`collected`, so it never leaks pre-confirm.

**`collecting` is a waste-item-only status**, not a collect-request status. The collect-
request itself goes `confirmed → collected`. The waste item (`waste_requests.status`)
mapping: stays `open` while quotes accumulate; → `collecting` when a quote is `confirmed`;
→ `collected` on `mark_done`; back to `open` if the one confirmed deal is cancelled and no
other confirmed deal exists.

### Every guard to change

1. **`approve_request`** — rename the *effect*, not the route. Guard: caller is owner,
   current status `requested`. Sets status `accepted` (was `approved`). **Remove** the
   waste-item flip to `collecting` and the "address unlocked" notification. New
   notification to the collector: "Your quote was accepted — awaiting the owner's
   confirmation." Does **not** auto-close other quotes (owner may still back out). Return
   `_creq_view(cr)` **with no waste object** (nothing unlocks at `accepted`).
2. **`confirm_deal`** (NEW route, dispatched for a `/confirm` suffix). Guard: caller is
   owner; current status `accepted`. Effects:
   - set collect-request `status="confirmed"`, `confirmedAt=int(time.time())`,
     `paymentStatus="not_required"`  `# Phase 2: Stripe PaymentIntent authorization goes here`;
   - set waste item `status="collecting"`, `collectorId`, `collectorName`;
   - **auto-close** every other `collect_request` for this `wasteId` in `requested`/
     `accepted` → `closed`, notifying each losing collector (paginated `wasteIndex` query);
   - notify the chosen collector: "Deal confirmed — address and contact unlocked, chat is
     open." (`approved` push type reused so it pushes to the device.)
   - return `_creq_view(cr, _get_waste(cr["wasteId"]))` — now it unlocks.
3. **`_creq_view`** — change the unlock condition from `status == "approved"` to
   `status in UNLOCK_STATUSES` **and** `waste` present. Only then copy
   `fullAddress`/`ownerPhone`/`pickupTime`/`notes` and set `unlocked=True`. Always expose
   `quoteAmount`/`currency`/`maxPrice`/`paymentStatus`/`message`.
4. **`_chat_enabled`** — change from `("approved", "collected")` to return
   `cr.get("status") in CHAT_STATUSES`.
5. **`get_messages`** — logic unchanged; inherits the stricter `_chat_enabled`; returns
   `400 {"error":"Chat not available yet"}` before `confirmed`.
6. **`send_message`** — same: `_is_member` AND `_chat_enabled` (now `confirmed`+).
7. **`list_conversations`** — iterates and skips `not _chat_enabled(cr)`; inherits the
   stricter rule, so accepted-but-unconfirmed deals do not appear as chats.
8. **`mark_done`** — guard changes from `status != "approved"` to
   `status not in ("confirmed",)` (the collect-request is `confirmed` right up to
   completion; `collecting` lives on the waste item, not here). On success sets
   collect-request `collected` (+ `completedAt`) and waste item `collected`.
9. **`list_requests` call-sites (CRITICAL — the gate feeds `_creq_view`).** Today both the
   incoming and outgoing loops do
   `_creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") == "approved" else None)`.
   Because the unlock set moved to `UNLOCK_STATUSES`, these must load the waste item
   whenever `cr["status"] in UNLOCK_STATUSES`, else confirmed deals would be passed
   `waste=None` and **silently never unlock**. Change both loops to:
   ```python
   v = _creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") in UNLOCK_STATUSES else None)
   ```
   `approve_request` conversely must **stop** passing a waste object (it no longer unlocks).

Because the unlock point moved to `confirmed` and chat follows the same `CHAT_STATUSES`
set, there is a single source of truth for the invariant: the status check in `_creq_view`
and `_chat_enabled`, both reading the module constants. Every reader (`list_requests`,
`list_conversations`, `get_messages`, `send_message`, notification detail) funnels through
those two functions, so no reader can leak independently — **provided** the `list_requests`
call-sites load the waste item on the full `UNLOCK_STATUSES` set (item 9 above).

### Soft status, never delete — cancel and dispute

Neither cancel nor dispute deletes a row (soft status only, matching the user's "never
delete, cancel = status change" instruction).

**`reject` vs `cancel` — who uses which (resolves the overlap).** They are **not**
interchangeable:

- **`reject_request`** (existing route, kept) is the **owner's** action on a single
  **`requested`** quote they do not want. Status → `rejected`. **Change:** it must **no
  longer** unconditionally flip the waste item to `open`. Under multi-quote, rejecting one
  quote must not disturb a listing that may hold other live quotes. New rule: `reject_request`
  touches **only** the one collect-request row; the waste item is left as-is (it is still
  `open` anyway, because quoting no longer flips it — Part A). Guard unchanged (`requested`
  only).
- **`cancel_request`** (NEW route, `/cancel` suffix) is a **withdrawal/back-out**, usable
  by either party, at more states than reject:
  - **Pre-confirm** (`requested` or `accepted`): the **collector** may withdraw their own
    quote, or the **owner** may drop this specific quote. Status → `cancelled`,
    `cancelledAt`. No contact was ever exposed, nothing to revoke. Waste item untouched
    (stays `open`).
  - **Post-confirm** (`confirmed`): either party may cancel the active job. Status →
    `cancelled`, `cancelledAt`; waste item reverts to `open` (re-listable) **only if** no
    other confirmed deal exists for it. `paymentStatus` left as-is behind
    `# Phase 2: trigger Stripe refund/void here`. Both parties notified.
  - `collected`/`rejected`/`closed`/`disputed`/`cancelled` cannot be cancelled → `409`.

So: owner-decline-a-pending-offer = `reject`; anyone-backs-out (including after
commitment) = `cancel`. The frontend wires the buttons accordingly (Part E).

**`raise_dispute`** (NEW route, `/dispute` suffix). Guard: caller is a member
(`_is_member`) of a request whose status is in `("confirmed", "collected")`
(i.e. a committed job; `disputed` itself is excluded so a dispute can't be re-raised); any
other status → `409`. Effect: set `status="disputed"`, record
`disputeReason` (`_s(...)[:1000]`), `disputedAt=int(time.time())`, `disputedBy`. Notify
the other party; Phase 1 only records it (`# Phase 2: refund/arbitration hooks attach here`).
Because `disputed` is reachable only from committed (already-unlocked) states and is in
`UNLOCK_STATUSES`/`CHAT_STATUSES`, a disputed job keeps its unlocked contact and keeps chat
open so the parties can resolve — and nothing unlocks pre-`confirmed`.

---

## PART C — Collector business accounts + verification

### Decision (a): derive account type from `collectors`, not a Cognito custom attribute

Adding a `custom:account_type` attribute to the **existing** User Pool is risky: Cognito
custom attributes are **immutable schema** — adding one to a pool in place via
CloudFormation forces a replacing update of the `AWS::Cognito::UserPool`, which would
destroy existing users. We therefore **do not** add a custom attribute. Account type is
**derived**: a user is a collector business **iff** a `collectors` record exists for their
`userId` (Cognito `sub`), and the record's `status` tells us whether they are
`draft`/`pending`/`approved`/`rejected`/`suspended`. "Individual" is the absence of such a
record. This keeps the pool untouched and makes verification state the single source of
truth. (Admin privilege is separate — a Cognito **group**, Part D, which *can* be added
without replacing the pool.)

### New table: `collectors`

```
PK: userId (S)   # Cognito sub
Attributes:
  businessName (S), registrationNumber (S), wasteCarrierLicense (S),
  serviceAreas (list<S>), wasteCategories (list<S>),
  contactPhone (S), contactEmail (S),
  status (S: draft|pending|approved|rejected|suspended),
  verifiedAt (N, epoch seconds), verifiedBy (S), rejectionReason (S),
  rating (N, default 0), completedJobs (N, default 0),
  docKeys (map: docType -> S3 key),
  createdAt (N, epoch seconds), updatedAt (N, epoch seconds)
GSI statusIndex: HASH status (S), RANGE createdAt (N), ProjectionType ALL
```

`statusIndex` powers the admin queue query (`status == "pending"`). It mirrors the existing
`statusIndex` on `waste_requests` exactly (same key shape, same projection). All timestamps
here are epoch seconds via `int(time.time())`.

### Decision (b): private S3 bucket with presigned URLs for documents

A reference-string stub ("user typed a license number") cannot be verified by an admin and
leaves no audit trail; unsafe for a trust-granting workflow. We use a **dedicated private
S3 bucket** (`CollectorDocsBucket`) — **not** the public `FrontendBucket` — with
`PublicAccessBlockConfiguration` all-true and no public bucket policy. Documents are keyed
`collectors/{userId}/{docType}` where `docType` is a whitelisted enum (`registration`,
`license`, `insurance`). The collect Lambda issues short-lived (`ExpiresIn=300`) presigned
**PUT** URLs for upload and presigned **GET** URLs for admin review. The browser uploads
directly to S3, so document bytes never pass through Lambda. Tradeoff: a bit more infra
(bucket + S3 IAM + CORS) versus a stub, but it is the only option giving verifiable
evidence while keeping documents out of public reach.

### Decision (c): collector + admin routes live in the collect Lambda

The collector/admin flows need `notify`, `push_send`, DynamoDB access, and the same
`verify_token`/`cognito:groups` claims — all already in `lambdas/collect/app.py`. Putting
them there avoids a third Lambda, a second JWKS client, and duplicated plumbing. The
profile Lambda stays minimal; the collector concept is tightly coupled to the collection
lifecycle. We add `COLLECTORS_TABLE` and `COLLECTOR_DOCS_BUCKET` env vars and S3/Dynamo IAM
to the collect function.

### Collector module (new in collect `app.py`)

```python
COLLECTORS_TABLE = os.environ.get("COLLECTORS_TABLE", "")
COLLECTOR_DOCS_BUCKET = os.environ.get("COLLECTOR_DOCS_BUCKET", "")
collectors_table = dynamodb.Table(COLLECTORS_TABLE) if COLLECTORS_TABLE else None
s3 = boto3.client("s3", region_name=REGION)
DOC_TYPES = {"registration", "license", "insurance"}

def _get_collector(user_id):
    if not collectors_table:
        return None
    try:
        return collectors_table.get_item(Key={"userId": user_id}).get("Item")
    except Exception as e:
        logger.error("get collector error: %s", str(e))
        return None

def _is_approved_collector(user_id):
    c = _get_collector(user_id)
    return bool(c) and c.get("status") == "approved"
```

Routes (dispatched by the new `/collector/` prefix — see Dispatcher section):

- **`POST /collector/apply`** — upsert a `draft` record (`status="draft"`, `createdAt`/
  `updatedAt`). Idempotent: re-apply keeps existing data.
- **`POST /collector/submit`** — `draft` → `pending`. Validates required fields non-empty
  (`businessName`, `registrationNumber`, `wasteCarrierLicense`, `serviceAreas` non-empty,
  `wasteCategories` non-empty, `contactPhone`, `contactEmail`) → `400` naming the first
  missing field. Rejects submit if already `approved`/`pending` (`409`). Sets `updatedAt`.
  Notifies the applicant ("Application submitted for review").
- **`GET /collector/me`** — returns the caller's collector record (or `{"status":"none"}`
  if absent). Drives the Profile status display and the quote-UI gate.
- **`POST /collector/upload-url`** — body `{docType}`; validate `docType in DOC_TYPES`
  (`400` otherwise); return `{url, key}` from
  `s3.generate_presigned_url("put_object", Params={Bucket, Key, ContentType}, ExpiresIn=300)`.
  **The `ContentType` baked into the presign must equal the `Content-Type` the browser will
  send on the PUT**, or S3 rejects the signature; the frontend therefore passes the file's
  MIME type to this route and uses the same value on the PUT. Record the key in
  `docKeys[docType]`.

### Enforcement: only approved collectors may quote on a Type B listing

This is **step 6** of the `request_collect` order pinned in Part A — it runs **after** the
waste load (steps 3–5), not literally first, because it needs the waste item's `priceType`
(and so a not-found waste correctly returns `404`, and an owner quoting their own listing
correctly gets the `400` self-collect message at step 4 before this `403`):

```python
if (waste.get("priceType") or "user_pays") == "user_pays":
    if not _is_approved_collector(claims["sub"]):
        return json_response(
            {"error": "Only verified collector businesses can quote on paid pickups"},
            status=403)
```

Single enforcement point; fails closed (no record ⇒ not approved ⇒ 403).

---

## PART D — Admins group + verification queue

### Cognito group + admin check

Add an `AWS::Cognito::UserPoolGroup` named `admins` to the template (safe to add to an
existing pool — groups are not schema). The admin check reads the **`cognito:groups`**
claim from the verified ID token (server-trusted, never client input):

```python
def _is_admin(claims):
    groups = claims.get("cognito:groups") or []
    return "admins" in groups
```

Every admin route calls `_is_admin(claims)` first → `403` if false. The claim comes from
the Cognito-signed token verified by `verify_token`, so a client cannot forge it.

### Admin routes (collect Lambda, dispatched by the `/admin/` prefix)

- **`GET /admin/collectors?status=pending`** — `_is_admin` gate; query
  `collectors.statusIndex` for the given status (default `pending`, validated against the
  allowed set → `400`), newest first. For each `docKeys` entry, attach a presigned **GET**
  URL (`ExpiresIn=300`) so the admin can view documents; a missing object is tolerated
  (link shows "document unavailable").
- **`POST /admin/collectors/{id}/approve`** — `pending` → `approved`; set
  `verifiedAt=int(time.time())`, `verifiedBy=claims["sub"]`, `updatedAt`. Notify the
  collector ("You're verified — you can now quote on paid pickups"). `409` if not
  `pending`; `404` if the collector row is missing.
- **`POST /admin/collectors/{id}/reject`** — body `{reason}`; `pending` → `rejected`; store
  `rejectionReason` (`_s(...)[:1000]`). Notify with the reason. `409`/`404` as above.
- **`POST /admin/collectors/{id}/suspend`** — `approved` → `suspended`. Notify. `409` if
  not `approved`. A suspended collector fails `_is_approved_collector`, so they can no
  longer quote.

`{id}` is the collector `userId`; the admin dispatcher splits it and the action out of the
path (see below). All four reuse `notify()`/`push_send()`.

---

## Backend dispatcher (resolves the admin/approve collision)

The existing handler dispatches POSTs purely by suffix in order, so a naive
`POST /admin/collectors/<id>/approve` would be captured by `route.endswith("approve")` →
`approve_request` **before** any admin branch, and `/reject` likewise. We therefore add
**prefix-based dispatch in front of the existing `endswith` chain** for both POST and GET.
The existing suffix chain is left otherwise unchanged.

```python
if request.method == "POST":
    body = request.get_json(force=True, silent=True) or {}
    if route.startswith("/admin/"):
        return _unwrap(dispatch_admin(claims, route, body))        # parses id + action
    if route.startswith("/collector/"):
        return _unwrap(dispatch_collector(claims, route, body))    # apply/submit/upload-url
    if route.endswith("report"):   return _unwrap(create_report(claims, body))
    if route.endswith("request"):  return _unwrap(request_collect(claims, body))
    if route.endswith("confirm"):  return _unwrap(confirm_deal(claims, body))
    if route.endswith("approve"):  return _unwrap(approve_request(claims, body))
    if route.endswith("reject"):   return _unwrap(reject_request(claims, body))
    if route.endswith("cancel"):   return _unwrap(cancel_request(claims, body))
    if route.endswith("dispute"):  return _unwrap(raise_dispute(claims, body))
    if route.endswith("done"):     return _unwrap(mark_done(claims, body))
    # ... existing message/subscribe/unsubscribe/read branches unchanged ...

# GET
if route.startswith("/collector/"):   # /collector/me
    return _unwrap(dispatch_collector_get(claims, route))
if route.startswith("/admin/"):        # /admin/collectors
    return _unwrap(dispatch_admin_get(claims, route))
# ... existing mine/requests/notifications/conversations/messages/analytics unchanged ...
```

`dispatch_admin(claims, route, body)` splits `route` on `/`
(`["", "admin", "collectors", "<id>", "<action>"]`), validates `action in {approve, reject,
suspend}` (`400` otherwise), checks `_is_admin` first (`403`), and calls the matching
function with the parsed `id`. The non-admin suffixes `confirm`/`cancel`/`dispute`/
`request`/`done` do **not** collide, but adding `confirm`/`cancel`/`dispute` to the chain
is required because they are new. `GET /collector/me` ends in `me` and GET `/admin/...` are
also routed by prefix so they never fall through to `list_public`.

---

## PART E — Frontend wiring (vanilla, no framework/build)

All additions follow existing patterns: `collectFetch(method, body, pathSuffix)`,
`profileFetch`, the hash-router `ROUTES` map, `escapeHtml`, `statusBadge`, event
delegation, overlays toggled with `.show`/`hidden`.

### Listing form (`index.html` `reportForm` + `app.js` submit)

- Add two fields to `reportForm` after `rfArea`: `rfMaxPrice` (number, step 0.01, min 0,
  "Maximum price you'll pay (optional)") and `rfCurrency` (select, default `MYR`; MYR/SGD/
  USD). Area/pickup/notes unchanged.
- In the report submit handler add `priceType: "user_pays"`, `currency`, and `maxPrice`
  (sent only if non-empty) to the POST body. Client-side: if `maxPrice` present it must
  parse to a number `> 0`, else show the existing `reportError`.

### Collector submits a quote

- On a portal listing card, the primary action for a Type B listing becomes **"Submit
  Quote"**, opening a small overlay with an amount input (hint "Owner's max: {maxPrice}
  {currency}" when set) and an optional message, then
  `collectFetch('POST', {wasteId, quoteAmount, message}, 'request')`. `403` → "You need to
  be a verified collector to quote — apply from your Profile." `400`/`409` → surface the
  server error text.
- Gate the quote UI with `GET /collector/me`: non-approved users see the apply CTA instead
  of the amount form.

### Owner reviews quotes, confirms, and the unlock point

This is the central new owner UX, and it has a concrete home in the existing frontend. The
existing code already routes an owner from their posted-listing card into the notifications
page via `onPortalCardClick` → (owner branch) `navigate('notifications')` +
`openRequestInNotifications(r.requestId)`, and `openRequestInNotifications(wasteId)` already
scans `lifecycleRequests.incoming.concat(outgoing)` for rows matching that `wasteId`. Today
it picks **one** matching row and calls `showNotifDetailForCollectRequest`. We change it to
render **all** matching quotes and add the `accepted`/confirm branch. Three concrete,
named edits:

**(1) New `renderIncomingQuotesForWaste(wasteId)` — the multi-quote comparison view.**
Filters `lifecycleRequests.incoming` to rows with `cr.wasteId === wasteId && cr.role ===
'owner'`, sorts by `quoteAmount` ascending, and renders **one card per quote** into the
existing notification-detail container `notifDetailEl` (`#notifDetail`). Each card shows
`collectorName`, `quoteAmount` + `currency`, `maxPrice` (the snapshot), and `message`
(`escapeHtml` throughout), plus a status badge via `statusBadge(cr.status)`. Per-card
actions by status:
  - `requested` → **Accept** button `data-approve="<collectRequestId>"` (reuses the
    existing `approve` wiring).
  - `accepted` → **Confirm deal** `data-confirm="<id>"` + **Cancel** `data-cancel="<id>"`.
  - `confirmed`/`collected`/`disputed` (`cr.unlocked === true`) → a **View details**
    `data-open="<id>"` that opens the single-request unlock card (edit 2) with the
    address/phone + Open Chat.
  - terminal (`rejected`/`closed`/`cancelled`) → status row only, no actions.
The container id (`notifDetailEl`) and the overlay it lives in are unchanged; only the
inner HTML is a quote **list** instead of a single summary. After building the HTML, call
`wireNotifDetailActions()` (extended in edit 3) once — delegation handles every card.

**(2) `showNotifDetailForCollectRequest(cr, typeLabel)` — add the `accepted` owner branch
and re-key the unlock branch.** The function currently has exactly two action branches:
`cr.role === 'owner' && cr.status === 'requested'` (Approve/Reject) and `cr.status ===
'approved'` (unlock card). Change:
  - Add, between them, `else if (cr && cr.role === 'owner' && cr.status === 'accepted')` →
    render a **Confirm deal** button (`data-confirm="<id>"`) and a **Cancel** button
    (`data-cancel="<id>"`), with copy "You picked this quote. Confirm to share your address
    and open chat." **No** address/phone is shown in this branch (the response for an
    `accepted` request carries no contact fields — Part B `_creq_view`).
  - Change the unlock branch condition from `cr.status === 'approved'` to
    `cr && cr.unlocked === true` (equivalently
    `['confirmed','collected','disputed'].indexOf(cr.status) !== -1`). Its body (address/
    phone/pickup/notes + **Open Chat** + **Mark as Collected**) is otherwise unchanged, and
    for a `confirmed`/`collected` owner-or-collector it also offers **Report a problem**
    (`data-dispute`) and, for the owner on a `confirmed` job, **Cancel job**
    (`data-cancel`). This single-request panel is reached either from a notification
    (`showNotifDetail`) or from the quote-list "View details" (`data-open`), so the branch
    is identical regardless of entry point.

**(3) `openRequestInNotifications(wasteId)` + `wireNotifDetailActions()` — wire the new
routes.** `openRequestInNotifications` changes from "find one matching row and show it" to
"once `lifecycleRequests` is populated, call `renderIncomingQuotesForWaste(wasteId)`"
(keeping its existing retry/`setTimeout` loop that waits for `loadLifecycleRequests()`).
`wireNotifDetailActions` gains three handlers alongside the existing
`approve`/`reject`/`done`/`chat` ones, all reusing the existing `act(suffix, id, btn)`
helper (which already does `collectFetch('POST', {collectRequestId: id}, suffix)` then
refreshes notifications + `loadLifecycleRequests()` + badge):
  - `[data-confirm]` → `act('confirm', id, btn)`.
  - `[data-cancel]`  → `act('cancel', id, btn)`.
  - `[data-dispute]` → opens the small reason box (Cancel/dispute subsection) then
    `collectFetch('POST', {collectRequestId: id, reason}, 'dispute')`.
  - `[data-open]`    → `showNotifDetailForCollectRequest(findCollectRequest(id))` (swaps the
    quote list for the single-request unlock panel).

**The unlock point stays strictly server-driven.** The owner clicking **Accept** sets
`accepted` and the response/`lifecycleRequests` refresh shows **no** address/phone (edit 2
`accepted` branch). Only after **Confirm deal** does the refreshed row carry
`unlocked === true` and the unlock card render. The frontend never infers unlock from
anything but the server's `cr.unlocked`/status — defense-in-depth over the backend gate,
never a substitute for it.

### `statusBadge` — exact new labels

Extend the `statusBadge` label map (currently `open:'Pending', requested:'Requested',
collecting:'Collecting', rejected:'Rejected', collected:'Collected', done:'Collected'`)
with:

```js
accepted:  'Accepted',
confirmed: 'Confirmed',
cancelled: 'Cancelled',
closed:    'Not selected',
disputed:  'Disputed'
```

`statusBadge` emits `status-<name>` classes. Add matching `.status-accepted`,
`.status-confirmed`, `.status-cancelled`, `.status-closed`, `.status-disputed` rules to
`style.css` (color-coded like the existing badges: confirmed/collected green-ish,
cancelled/closed grey, disputed/rejected red). These CSS rules did not exist and must be
added.

### Cancel, dispute, statuses in History/Notifications

- **Cancel pre-confirm:** a "Cancel" / "Withdraw quote" button on the request card for
  `requested`/`accepted` → `collectFetch('POST', {collectRequestId}, 'cancel')`.
- **Cancel post-confirm:** a "Cancel job" button on the active job (History, for a
  `confirmed` job) → same `cancel` route.
- **Dispute:** a "Report a problem" button on a committed job (`confirmed`/`collected`)
  opens a small reason box → `collectFetch('POST', {collectRequestId, reason}, 'dispute')`.
- Reflect the new statuses in portal History and the notification feed;
  cancelled/closed/rejected render as terminal cards (no further actions). Reuses the
  existing `lifecycleRequests` incoming/outgoing structures and
  `showNotifDetailForCollectRequest`, extended for the new statuses.

### "Become a collector" on Profile

- A Profile section "Collector account": a **Become a collector** button when
  `GET /collector/me` returns `status: "none"`, otherwise a status display
  (draft/pending/approved/rejected/suspended + rejection reason if any).
- The apply/submit form (business name, registration number, waste-carrier license,
  service areas, waste categories, contact phone/email) plus a document-upload row per
  `docType`. Upload: `POST /collector/upload-url` (passing the file's MIME as `contentType`)
  → presigned PUT, then `fetch(url, {method:'PUT', headers:{'Content-Type':file.type},
  body:file})` directly to S3 (no bearer header — the presigned URL authorizes it; the
  `Content-Type` must match the presign). Submit → `POST /collector/submit`.

### Admin route `#/admin/collectors` (admins only)

- New `ROUTES` entry `'admin': { view:'adminOverlay', gated:true, enter:onEnterAdmin }`.
  An **"Admin" nav entry** and the route are shown only when the ID token's `cognito:groups`
  contains `"admins"`.
- **`Auth.profile()` must expose `groups` on BOTH return paths** (it currently returns
  `{email,name,sub}` from the live-session branch *and* the localStorage-fallback branch —
  if only one is patched the Admin nav flickers depending on which path runs). Change both:
  live-session branch returns
  `{ email: payload.email, name: payload.name, sub: payload.sub, groups: payload['cognito:groups'] || [] }`;
  localStorage branch returns
  `{ email: claims.email, name: claims.name, sub: claims.sub, groups: claims['cognito:groups'] || [] }`.
  The UI checks `(Auth.profile().groups || []).indexOf('admins') !== -1`. This is a
  convenience gate only — the server re-verifies via `_is_admin`, so forcing the hash still
  returns `403`.
- `onEnterAdmin` calls `GET /admin/collectors?status=pending`, renders queue cards
  (business name, numbers, service areas, document **View** links using the returned
  presigned GET URLs) with **Approve** / **Reject (reason)** / **Suspend** buttons wired to
  the admin POST routes, then refreshes.

### Explicitly unchanged

The **Future Actions** tab and its rendering (`renderFurtherActions`, the flowchart/cards)
are **not** reordered or restructured — the user explicitly declined that in message 9.
The waste-details, environmental-impact, and assistant flows are untouched.

---

## Infra additions (`infra/template.yaml`)

Following existing patterns exactly:

1. **`CollectorsTable`** (`AWS::DynamoDB::Table`, PAY_PER_REQUEST): PK `userId` (S); GSI
   `statusIndex` HASH `status` (S) + RANGE `createdAt` (N), ProjectionType ALL. Attribute
   definitions for `userId`, `status`, `createdAt`. Mirrors `WasteRequestsTable`'s
   `statusIndex`.
2. **`CollectorDocsBucket`** (`AWS::S3::Bucket`): `PublicAccessBlockConfiguration` all
   `true`, **no** public bucket policy (contrast with `FrontendBucket`, which has a public
   `GetObject` policy). CORS config for the browser presigned upload/download:
   ```yaml
   CorsConfiguration:
     CorsRules:
       - AllowedOrigins: ["*"]        # Phase 1: wildcard. The site is served from the
                                      # S3 website endpoint (FrontendBucket.WebsiteURL,
                                      # an http://...s3-website-... origin). Tighten to
                                      # that exact origin (and any future custom domain)
                                      # when the domain is finalized.
         AllowedMethods: ["PUT", "GET"]
         AllowedHeaders: ["*"]
         MaxAge: 3000
   ```
   Rationale for `"*"` in Phase 1: the website origin is an `http://` S3-website URL that
   is awkward to reference as a literal and easy to mismatch (website URL vs REST URL),
   which fails silently with an opaque browser CORS error; a wildcard avoids that during
   development and is tightened before any real documents are stored. No `ExposeHeaders`
   is needed (the browser only needs the PUT to succeed and the GET body to render; `ETag`
   is not consumed). The presigned PUT is generated with the browser's `Content-Type` (see
   Part C `upload-url`).
3. **`AdminsGroup`** (`AWS::Cognito::UserPoolGroup`): `GroupName: admins`,
   `UserPoolId: !Ref UserPool`, a `Description`. No pool replacement — groups are additive.
4. **IAM** on the shared role (`AppBedrockRole` / `CollectDataPolicy`): extend the Dynamo
   resource list with `!GetAtt CollectorsTable.Arn` and
   `!Sub "${CollectorsTable.Arn}/index/*"`; add a new `CollectorDocsPolicy` granting
   `s3:PutObject`/`s3:GetObject` on `!Sub "${CollectorDocsBucket.Arn}/*"`.

   **`AppBedrockRole` is shared by BOTH `ProfileFunction` and `CollectFunction`** (both set
   `Role: !GetAtt AppBedrockRole.Arn`). There is **no per-function role to attach to** —
   `CollectorDocsPolicy` and the `CollectorsTable` grant are both added as inline policies
   **on `AppBedrockRole`**. `ProfileFunction` therefore inherits unused `s3:PutObject`/
   `s3:GetObject` on the docs bucket and read/write on `CollectorsTable`; this is harmless
   because the profile Lambda never touches S3 or the collectors table (no code path, no
   env var). Do **not** create a new role for the collector/admin routes. Only collect uses
   the new env vars (`COLLECTORS_TABLE`, `COLLECTOR_DOCS_BUCKET`), which is fine.

   **Presign region.** The S3 client is `boto3.client("s3", region_name=REGION)`; SigV4
   presigned-URL signatures are region-sensitive, so the bucket **must** live in the same
   `REGION` the client uses. `CollectorDocsBucket` is created in this template's stack
   region (the same `REGION` the Lambda runs in and the client is configured with), so the
   presign host/region match and the browser PUT/GET succeed. (If the bucket were ever moved
   to another region the presign would need an explicit `region_name` + `endpoint_url`.)
5. **Env vars** on `CollectFunction`: `COLLECTORS_TABLE: !Ref CollectorsTable`,
   `COLLECTOR_DOCS_BUCKET: !Ref CollectorDocsBucket`. Profile function unchanged.
6. **Outputs:** add `CollectorDocsBucketName: !Ref CollectorDocsBucket` (mirrors
   `BucketName`).

No custom Cognito attribute is added (Decision a), so the `UserPool` resource is **not**
modified and existing users are preserved.

---

## Error handling and validation (per operation)

- **`create_report` price fields:** `maxPrice` parsed by `_dec_price`; malformed → `None`
  (treated as "no ceiling"), not an error (optional, non-critical). `currency` clamped to 3
  chars uppercased. No new fatal path; not logged beyond existing handler logging.
- **`request_collect` quote:** checks run in the pinned Part A order — missing id `400` →
  service `503` → waste not found `404` → self-collect `400` → item not `open` `409` →
  non-approved collector on a Type B listing `403` → missing/`<=0` `quoteAmount` `400` /
  `> maxPrice` `400` → duplicate live quote by the same collector `409` → persist. All return `{"error": ...}`; validation failures not logged (expected client
  errors); unexpected DynamoDB errors bubble to the handler `500` (logged there).
- **`approve_request`/`confirm_deal`/`cancel_request`/`raise_dispute`/`mark_done`:** each
  validates ownership/membership (`403`), current status (`409`/`400` with a specific
  message), missing id (`400`). Transitions are guarded so a double-click or stale UI
  cannot skip a state (e.g. `confirm_deal` requires `accepted`). DynamoDB write failures
  propagate to the handler `500` (logged). Notifications are best-effort (`notify`/
  `push_send` swallow their own errors) and never fail the request.
- **`confirm_deal` auto-close:** the paginated `wasteIndex` query and each per-loser
  `update_item` are wrapped so a failure to close one losing quote is logged but does not
  fail the confirm (the chosen deal is already committed; a stray `requested` quote is
  harmless once the waste item is `collecting`).
- **Collector `submit`:** each required field validated; first missing → `400` naming it.
  Wrong current status → `409`. S3 presign errors → `500` (logged).
- **`upload-url`:** `docType` not in `DOC_TYPES` → `400`. Presign failure → `500` (logged).
- **Admin routes:** `_is_admin` false → `403` (not logged). Unknown action → `400`. Target
  collector not found → `404`. Wrong status for the action → `409`. `status` query param
  validated → `400` if invalid.
- **S3 presigned uploads (browser):** a failed PUT surfaces as an upload error; `docKeys`
  is written only after `upload-url` succeeds; the admin GET presign tolerates a missing
  object (shows "document unavailable").

### External-input validation rules

| Input | Required | Type | Limits | On failure |
|---|---|---|---|---|
| `maxPrice` | optional | Decimal(2dp) | `>= 0`; malformed→ignored | treated as no ceiling |
| `currency` | optional | string | 3 chars, uppercased | defaults `MYR` |
| `priceType` | optional | enum | `user_pays` only | defaults `user_pays` |
| `quoteAmount` | **required** (quote) | Decimal(2dp) | `> 0`, `<= maxPrice` if set | `400` |
| quote `message` | optional | string | `[:500]` | truncated |
| `docType` | **required** (upload) | enum | `registration/license/insurance` | `400` |
| `contentType` (upload) | **required** (upload) | string | must match the PUT's Content-Type | signed as-is |
| collector required fields | **required** (submit) | string/list | non-empty | `400` naming field |
| reject `reason` | optional | string | `[:1000]` | stored as-is |
| dispute `reason` | optional | string | `[:1000]` | stored as-is |
| admin `status` query | optional | enum | pending/approved/rejected/suspended | `400` |

### Invariant ownership

- **Disintermediation invariant** (no contact/chat before `confirmed`): owned by the
  **backend view layer** — `_creq_view` (reads `UNLOCK_STATUSES`) and `_chat_enabled`
  (reads `CHAT_STATUSES`), **plus** the `list_requests` call-site rule that loads the waste
  item exactly on `UNLOCK_STATUSES` (without which confirmed deals would never unlock). All
  readers funnel through these; the frontend's "reveal only after confirm" is
  defense-in-depth, not the enforcement point.
- **Collector-verification invariant** (only approved collectors quote on Type B): owned by
  `request_collect` via `_is_approved_collector` — a single server-side gate that fails
  closed.
- **Admin-privilege invariant:** owned by `_is_admin(claims)` reading the Cognito-signed
  `cognito:groups` claim; never trusts client input.
- **Price-ceiling invariant** (`quoteAmount <= maxPrice`): owned by `request_collect` /
  `_validate_quote` at write time, against the live waste-item ceiling.

---

## Testability

The existing suite (`tests/test_collect.py`) exercises **pure** functions by importing
`lambdas/collect/app.py` under the `conftest.py` boto3/flask/jwt stubs. The new logic keeps
the decisions pure and unit-testable without AWS:

- **Unit-testable (pure, no AWS):**
  - `_dec_price` — parsing/rounding/negatives/blank.
  - `_validate_quote(amount, max_price)` — `None`/`<=0`/`>max`/ok cases.
  - `_creq_view` — assert **no** `fullAddress`/`ownerPhone`/`unlocked` for `requested` and
    `accepted`; assert they **appear** for each status in `UNLOCK_STATUSES`
    (`confirmed`/`collected`/`disputed`) when a waste object is passed, and
    assert they stay absent for those statuses when `waste=None` (documents the
    call-site contract from Part B item 9). Extends the existing
    `test_creq_view_locked_when_requested` / `test_creq_view_unlocks_when_approved` tests
    (the latter renamed to reflect `confirmed`).
  - `_chat_enabled` — false for `requested`/`accepted`/`rejected`/`cancelled`/`closed`;
    true for every status in `CHAT_STATUSES`.
  - `_is_admin` — true only when `cognito:groups` contains `admins`.
  - `public_view` — `priceType`/`maxPrice`/`currency` present; address still masked for
    non-owner (existing tests still pass).
- **Integration-tested (needs DynamoDB/S3/Cognito — out of scope for the unit stubs):**
  the full `confirm_deal` auto-close of losing quotes, the duplicate-quote pagination,
  presigned URL generation, the admin `statusIndex` query, and end-to-end transitions.
  Described here, validated manually / in a later integration pass, consistent with the
  repo testing only pure logic today.

Because the invariant is centralized in two pure functions reading two module constants —
and the one call-site that could defeat it (`list_requests` loading the waste item) is
explicitly tested via the `waste=None` assertions above — the highest-risk property
(contact never leaking pre-`confirmed`) is covered by fast unit tests.

---

## Phase 2 stubs (payments) — exactly what is deferred

Phase 1 moves **no money**. The following are structural placeholders only, each marked
with a `# Phase 2:` comment in code: a `paymentStatus` field on each confirmed
collect-request defaulting to `"not_required"` (set in `confirm_deal`, comment "Phase 2:
Stripe PaymentIntent authorization goes here"). **`confirm_deal` has no payment
precondition in Phase 1** — the Stripe authorization that will gate `accepted → confirmed`
is deferred, so contact unlock in Phase 1 is gated on the owner's **intent** (clicking
Confirm), not on payment; the disintermediation protection is structural-only until Phase 2
wires payment before `confirmed`. Cancellation on a confirmed job leaves `paymentStatus`
untouched behind "Phase 2: trigger Stripe refund/void here", and `raise_dispute` records
the dispute behind "Phase 2: refund/arbitration hooks attach here". Commission accounting,
Stripe Connect onboarding for collector payouts, the actual charge/capture at `confirmed`,
refund execution on cancel/dispute, and webhook handling are all **out of scope for Phase
1** and will layer onto these fields and comments without changing the state machine.

---

## Review responses (revision 3)

Each finding from the latest `.agents/tasks/design-review.json` (0 HIGH / 3 MEDIUM / 4 NIT,
CHANGES_REQUESTED) and its resolution. All seven are **addressed in place**; none backlogged
or ignored — each aligns directly with the original Type-B, user-pays, no-real-money,
soft-status, admin-group requirements.

1. **MEDIUM (#1) — owner multi-quote comparison UI had no home in the real frontend.
   ADDRESSED.** Part E "Owner reviews quotes" now specifies the concrete entry point and
   functions grounded in the existing code: the owner's posted-listing card already routes
   via `onPortalCardClick` → `openRequestInNotifications(wasteId)`, which is changed to call
   a new **`renderIncomingQuotesForWaste(wasteId)`**. That function filters
   `lifecycleRequests.incoming` by `wasteId` (role `owner`), sorts by `quoteAmount`, and
   renders one card per quote (`collectorName`, `quoteAmount`+`currency`, `maxPrice`,
   `message`, `statusBadge`) into the existing `notifDetailEl` container, each with an
   **Accept** (`data-approve`) action for `requested` quotes — then calls the existing
   `wireNotifDetailActions()`. Named: render function, DOM container (`#notifDetail`), entry
   point (owner Track on the posted card), and the wiring function.
2. **MEDIUM (#2) — no owner `accepted`-state Confirm branch.** **ADDRESSED.** Part E edit 2
   adds the explicit branch `else if (cr && cr.role === 'owner' && cr.status === 'accepted')`
   to `showNotifDetailForCollectRequest`, rendering **Confirm deal** (`data-confirm`) +
   **Cancel** (`data-cancel`) with **no** contact shown, and changes the unlock branch
   condition from `cr.status === 'approved'` to `cr.unlocked === true`
   (`['confirmed','collected','disputed']`). `wireNotifDetailActions` gains `[data-confirm]`
   → `act('confirm',...)` and `[data-cancel]` → `act('cancel',...)`, reusing the existing
   `act(suffix,id,btn)` helper. The branch is identical whether reached from a notification
   or from the finding-#1 quote list (`data-open` swaps to the single-request panel).
3. **MEDIUM (#3) — shared-role S3 policy / presign region not reconciled.** **ADDRESSED.**
   Infra #4 now states `CollectorDocsPolicy` and the `CollectorsTable` grant are inline
   policies on the **shared `AppBedrockRole`** (there is no per-function role);
   `ProfileFunction` inherits unused S3/collectors permissions harmlessly, and the
   implementer is told explicitly not to create a per-function role. It also pins that
   `CollectorDocsBucket` lives in the same `REGION` the boto3 S3 client uses so the SigV4
   presign host/region match.
4. **NIT (#4) — `collecting` in the unlock/live tuples though never set on a collect-
   request.** **ADDRESSED (removed).** "Shared module constants" now defines
   `UNLOCK_STATUSES = CHAT_STATUSES = ("confirmed","collected","disputed")` and
   `LIVE_QUOTE_STATUSES = ("requested","accepted","confirmed")` — `collecting` is dropped
   from both, with a comment that it is waste-item-only and an inline note in
   `confirm_deal`/`mark_done` that `collecting` is never a collect-request target. All
   downstream references (the invariant statement, Part B dispute guard, the `_creq_view`
   test list, the frontend unlock condition) are updated to the 3-element set.
5. **NIT (#5) — `fmtTime` seconds vs microsecond `createdAt`.** **ADDRESSED.** "Timestamp
   convention" gains a "Frontend render safety" note: only the new epoch-seconds fields
   (`confirmedAt`/`disputedAt`/`cancelledAt`/`verifiedAt`/collectors `createdAt`/`updatedAt`)
   may be passed to `fmtTime`; collect-request/message `createdAt` is microseconds and must
   be divided by `1e6` first. Phase-1 UI renders only the safe seconds fields.
6. **NIT (#6) — conflicting enforcement order (Part A "first" vs Part C "after loading").**
   **ADDRESSED.** Part A now pins the single authoritative 9-step order: (1) missing id 400,
   (2) service 503, (3) waste 404, (4) self-collect 400, (5) item open 409, (6) collector
   approved 403, (7) validate_quote 400, (8) duplicate live quote 409, (9) persist. Part C's
   enforcement snippet is relabeled as "step 6 … after the waste load, not literally first,"
   removing the contradiction.
7. **NIT (#7) — self-collect guard retention/ordering vs the collector gate.** **ADDRESSED.**
   Step 4 of the pinned order states the existing "you cannot collect your own item" `400`
   is unchanged and **intentionally precedes** the collector `403` (step 6) so an owner
   quoting their own paid listing gets the clearer message.

---

## Review responses (revision 2, historical)

Each finding from the revision-1 `design-review.json` and its resolution:

1. **HIGH — `list_requests` call-site gates waste lookup on `approved` → confirmed deals
   never unlock. ADDRESSED.** Added module constant `UNLOCK_STATUSES` and Part B item 9:
   both `list_requests` loops now load the waste item when
   `cr["status"] in UNLOCK_STATUSES`; `approve_request` no longer passes a waste object.
   The call-site rule is also listed under Invariant ownership and covered by a new
   `_creq_view` `waste=None` unit test.
2. **HIGH — admin `/approve` `/reject` collide with `route.endswith`. ADDRESSED.** New
   "Backend dispatcher" section: `/admin/` and `/collector/` are matched by **prefix before**
   the `endswith` chain (both POST and GET); `dispatch_admin` parses id+action and validates
   the action set. The suffix chain is otherwise unchanged.
3. **HIGH — `collecting` collect-request status has no producer. ADDRESSED.** `collecting`
   is now explicitly a **waste-item-only** status; the collect-request goes
   `confirmed → collected`. `mark_done`'s guard is retargeted to `status not in ("confirmed",)`.
   `collecting` remains in `UNLOCK_STATUSES` only as defensive forward-compat, documented as
   never set on a collect-request.
4. **HIGH — conflicting unlock-set definitions. ADDRESSED.** One authoritative pair
   `UNLOCK_STATUSES = CHAT_STATUSES = ("confirmed","collecting","collected","disputed")` is
   defined once in "Shared module constants" and referenced everywhere; the old item-3
   three-element wording is gone and the dispute section now references the same set.
5. **MEDIUM — `maxPrice` provenance ambiguous. ADDRESSED.** New "maxPrice provenance"
   subsection: validation reads the live waste item; the view uses a snapshot copied onto
   the collect-request at creation; owner edits do not retro-invalidate existing live
   quotes.
6. **MEDIUM — owner cancel vs reject overlap. ADDRESSED.** New "reject vs cancel" rules:
   `reject` is owner-declines-a-`requested`-quote (one row only); `cancel` is a
   withdrawal/back-out usable by either party pre- and post-confirm. The frontend wires each
   button to the right route.
7. **MEDIUM — unnamed edits removing the single-quote flip. ADDRESSED.** Part A "Multiple
   quotes" now names the two concrete edits: (a) delete the `update_item` setting the waste
   item to `requested`; (b) keep the "must be `open`" precondition. `reject_request` is also
   changed to stop reopening the waste item (finding 6).
8. **MEDIUM — `CollectorDocsBucket` CORS origin unspecified. ADDRESSED.** Infra #2 pins a
   concrete `CorsConfiguration` (`AllowedOrigins: ["*"]` for Phase 1 with a note to tighten
   to the `FrontendBucket.WebsiteURL` origin, `AllowedMethods: [PUT, GET]`,
   `AllowedHeaders: ["*"]`) and states the presign `Content-Type` must match the browser PUT.
9. **MEDIUM — Phase-1 free path to `confirmed`. ADDRESSED.** The Overview and the Phase 2
   stubs section now state explicitly that `confirm_deal` has no payment precondition in
   Phase 1, so unlock is gated on owner intent, not payment.
10. **NIT — `statusBadge` labels for new statuses. ADDRESSED.** Part E enumerates the exact
    labels (`accepted:'Accepted'`, `confirmed:'Confirmed'`, `cancelled:'Cancelled'`,
    `closed:'Not selected'`, `disputed:'Disputed'`) and requires matching `.status-*` CSS to
    be added.
11. **NIT — `Auth.profile()` two return paths. ADDRESSED.** Part E spells out adding
    `groups` to **both** the live-session and localStorage-fallback return objects.
12. **NIT — timestamp units. ADDRESSED.** New "Timestamp convention" section fixes all new
    timestamps (`confirmedAt`, `disputedAt`, `cancelledAt`, `verifiedAt`, collectors
    `createdAt`/`updatedAt`) at epoch **seconds** via `int(time.time())`.
13. **NIT — duplicate-quote query filtering/pagination. ADDRESSED.** Part A
    "Duplicate-quote prevention" states the `wasteIndex` query reads all rows for the
    `wasteId` (no `Limit`, paginate via `LastEvaluatedKey`) and filters by `collectorId` +
    `LIVE_QUOTE_STATUSES` in code.
