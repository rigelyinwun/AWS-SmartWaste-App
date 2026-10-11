# SmartWaste

AI-powered waste analysis, disposal guidance, and a verified-collector waste marketplace. Upload a photo of any waste item to get instant identification, disposal steps, nearby recycling facilities on a map, environmental impact flash cards, and an AI chat assistant — then either **give the item away free** for any user to collect, or list it as a **paid pickup** that a **verified collector business** quotes on and removes. Coordinate pickup via real-time chat and track everything from a personal portal.

**Live:** https://d3f173je1qvblr.cloudfront.net

---

## Features

### Waste analysis (no login required)
- **Waste Details** — identifies category, confidence, description, estimated weight, recyclability, and material composition (fixed JSON → styled table).
- **Future Actions** — disposal-method flowchart + advice, a **map of nearby recycling centers / disposal stations / collection companies** (Amazon Location + MapLibre), and **Online Trading Platforms** with multilingual (EN / 中文 / BM) Google search links to resell, donate, or trade the item.
- **Environmental Impacts** — identification + decomposition time + a landfill-percentage gauge, plus a 3×3 grid of **flip cards** (land, water, wildlife, climate, health, circular value, future impact, best practices, edu insights) with images on the back.
- **AI Chat Assistant** — floating chatbot for follow-up disposal questions (streamed responses).
- **Content validation** — non-waste / inappropriate images are rejected (fails closed), both at analysis time and again server-side before an item can be listed.

### Waste collection marketplace (requires login)
- **Accounts** — real sign-up / email-verification / login via Amazon Cognito.
- **Profile page** — view/edit name, phone, address, settings; rate & feedback; privacy & terms; logout; delete account (with confirmation); **Become a collector** (apply for verified-business status).
- **Two listing lanes** on *Allow Public Collect*:
  - **Free giveaway** (`priceType: free`) — any logged-in user can collect it, no payment, no business verification.
  - **Paid pickup** (`priceType: user_pays`, the default) — the owner sets an optional **max price** they'll pay for removal; only a **verified collector business** can quote on it.
  - Any unrecognized price type falls back to the paid, business-gated lane (fail-safe — a bad value never accidentally opens the free lane).
- **Quotes & selection** — on a paid listing, verified collectors submit a **quote** (amount ≤ the owner's max). A listing can hold **multiple competing quotes**; the owner compares them and accepts one. Accepting one auto-closes the losing quotes.
- **Collector verification** — a business applies (name, registration number, waste-carrier license, service areas, waste categories, contact), uploads verification documents to a **private S3 bucket** (presigned upload), and submits for review. Status lifecycle: `draft → pending → approved → rejected / suspended`. Only an **approved** collector may quote on paid pickups.
- **Admin verification queue** — an admin-only page (`#/admin/collectors`, gated by a Cognito `admins` group) lists pending collectors with their documents and **approves / rejects / suspends** them.
- **Address stays private until the deal is confirmed** — see *Collection lifecycle & the "confirm" gate* below.
- **Demo payment screen** — a paid pickup shows a mock "Pay" dialog at the confirm step. It is a **placeholder only — it moves no money and uses no payment processor** (the slot where the Phase 2 Stripe integration will go).
- **Waste Collect Portal** — browse all open public listings with search + filters (type, date, distance), and a **History** tab split into *Posted* (your listings) and *Collected* (items you collected from others).
- **Real-time chat** — owner/collector pairs chat via AWS AppSync Events (WebSocket), with an automatic polling fallback. Chat opens only after the deal is confirmed.
- **Device push notifications** — opt-in **Web Push** (via a service worker + VAPID) delivers OS-level notifications for new collect requests, approvals, and chat messages **even when the tab or browser is closed** (like YouTube's web notifications).

The app is a single-page app with hash-based routing (`#/profile`, `#/portal`, `#/chat`, `#/notifications`, `#/admin/collectors`) so pages are bookmarkable and refresh-safe on a static host.

### Collection lifecycle & the "confirm" gate

The owner's contact details (full address, phone) and the chat channel unlock **only after the deal is confirmed** — never at mere request or acceptance. This "disintermediation gate" is what keeps the transaction on-platform.

```
list (owner)                 waste item: open
  → quote (collector)        collect-request: requested      (paid: approved collectors only; free: any user)
  → accept (owner)           collect-request: accepted       (owner picked one quote — NOTHING unlocks yet)
  → confirm (owner)          collect-request: confirmed      ← FIRST unlock: address + phone + chat open;
                             waste item:      collecting        paid lane shows the demo pay screen here;
                                                                 other quotes auto-close
  → mark done (either)       collect-request: collected
                             waste item:      collected
```

Also: `rejected` / `cancelled` / `closed` / `disputed` are all **soft status changes — records are never deleted**. `cancel` and `dispute` keep the full history for audit. Unlock/chat are driven strictly server-side (`UNLOCK_STATUSES == CHAT_STATUSES == {confirmed, collected, disputed}`); the client never infers unlock on its own.

---

## AWS services & architecture

```
                         ┌─────────────────────────────────────────────┐
   Browser (SPA)         │  Amazon CloudFront  →  Amazon S3 (static site)│
   index.html/app.js/css └─────────────────────────────────────────────┘
        │
        │  • Cognito SDK (login/signup)         • MapLibre GL JS (map tiles)
        │  • AppSync Events WS (chat realtime)  • fetch() to Lambda URLs
        │  • Service worker (sw.js) + Web Push  → OS notifications (closed-tab)
        ▼
 ┌───────────────────────── Lambda Function URLs (Lambda Web Adapter + Flask) ─────────────────────────┐
 │  waste_details         environmental_impact      smartwaste_assistant   (streamed, public)           │
 │  further_actions       nearby_facilities         profile  collect       (JSON; JWT-protected ones)   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
        │                         │                        │                         │
        ▼                         ▼                        ▼                         ▼
  Amazon Bedrock          Amazon Location          Amazon Cognito           Amazon DynamoDB
  (Claude Haiku 4.5)      (geo-places search,      (User Pool: accounts,    (users, feedback,
   image + text           map tiles via            email verification,      waste_requests,
   analysis, chat,        browser API key)         JWT tokens; 'admins'     collect_requests,
   content validation)                             group for verification;  notifications, messages,
                                                   collectors derive type)  push_subscriptions,
                                                                            collectors)

          Amazon S3 (private CollectorDocsBucket — collector verification documents, presigned PUT/GET)

          AWS AppSync Events (real-time chat pub/sub, API-key auth)   •   Web Push (VAPID → browser push services)
```

### Service-by-service

| AWS service | Used for |
|---|---|
| **Amazon Bedrock** (Claude Haiku 4.5, global inference profile) | Image + text waste analysis across all analysis Lambdas; chat assistant; content validation; waste-type enrichment; multilingual trading-search terms |
| **AWS Lambda** (+ Lambda Web Adapter, Flask, Python 3.12) | All 7 backend functions, exposed via **Function URLs** (streamed for analysis/chat, buffered JSON for profile/collect/facilities) |
| **Amazon Cognito** (User Pool + public app client + `admins` group) | User accounts, real email-verification sign-up, login, and the JWTs that authorize the profile/collect APIs; the **`admins`** group gates the collector-verification admin routes (checked via the `cognito:groups` claim on the verified ID token — a newly-added admin must re-login for the claim to appear) |
| **Amazon DynamoDB** (8 tables, PAY_PER_REQUEST) | `users`, `feedback`, `waste_requests` (+GSIs), `collect_requests` (+GSIs), `notifications`, `messages`, `push_subscriptions`, `collectors` (+`statusIndex` GSI — verified-business records; a user's account type is **derived** from this table rather than a Cognito custom attribute, to avoid a user-pool replacement) |
| **Amazon Location Service** (geo-places + maps) | Server-side geocoding & POI search for nearby facilities (Lambda IAM role); browser map tiles via a scoped API key (MapLibre) |
| **AWS AppSync Events** (+ ChannelNamespace + API key) | Real-time chat push between confirmed pairs (publish is JWT-authorized server-side; browser subscribes with the API key) |
| **Web Push** (W3C Push API + VAPID, `pywebpush`) | OS-level device notifications for new requests, approvals, and chat messages while the tab/browser is closed; a service worker (`sw.js`) receives pushes, the `collect` Lambda signs them with the VAPID keypair and sends to each browser's push service |
| **Amazon S3** | Static website hosting (frontend); a separate **private `CollectorDocsBucket`** (all public access blocked) holds collector verification documents, written/read via short-lived presigned URLs |
| **Amazon CloudFront** | HTTPS + CDN caching in front of S3 |
| **AWS IAM** | One shared Lambda execution role (Bedrock, geo-places, DynamoDB incl. `collectors`, Cognito admin, AppSync publish, presigned access to the private docs bucket); a role for AppSync→CloudWatch logs |
| **Amazon CloudWatch** | Lambda logs + AppSync Events request logging |
| **AWS SAM / CloudFormation** | Infrastructure as code (`infra/template.yaml`) |
| **GitHub Actions** | CI/CD: SAM build/deploy, CORS config, URL/key injection, S3 sync, CloudFront invalidation |

### Auth model (how security works)
- The browser only talks to **Lambda Function URLs** and sends the Cognito **ID token** as `Authorization: Bearer`.
- The `profile` and `collect` Lambdas **verify the JWT themselves** (signature against the pool's JWKS, issuer, audience, expiry) and enforce per-user ownership / membership on every mutating route.
- Addresses & phone numbers in listings stay **masked** in the public list and unlock to the collector only **after the deal is confirmed** (not at request or acceptance) — the on-platform "disintermediation gate." Chat opens at the same point.
- **Admin routes** (`/admin/collectors/...`) require the `admins` group claim and are matched by a **prefix dispatcher that runs before** the suffix-matched route chain, so e.g. `/admin/collectors/{id}/approve` is never mis-routed to the request-approval handler.
- **Collector verification documents** live in a private bucket and are only ever reachable through short-lived presigned URLs (uploads are constrained to an image/PDF content-type allow-list).
- The map tile key is a browser-scoped Amazon Location key (tiles only); all Places search and chat publishing happen server-side via the Lambda role.

---

## Tech stack

- **Frontend:** vanilla HTML / CSS / JavaScript (SPA, hash router), MapLibre GL JS, `amazon-cognito-identity-js`, a service worker + Web Push (VAPID)
- **Backend:** Python 3.12, Flask, AWS Lambda Web Adapter; `boto3`, `PyJWT` + `cryptography` (JWT verification), `pywebpush` (Web Push)
- **AI model:** Claude Haiku 4.5 via Amazon Bedrock (`global.anthropic.claude-haiku-4-5-20251001-v1:0`)
- **IaC / CI-CD:** AWS SAM, GitHub Actions
- **Region:** `ap-southeast-1` (Bedrock, DynamoDB, Cognito, AppSync); `geo-places` is called in `us-east-1` (not offered in ap-southeast-1 — the place database is global)

---

## Project structure

```
smartwaste-app/
├── .github/workflows/deploy.yml   # CI/CD pipeline
├── .gitignore
├── README.md
├── pytest.ini                     # test config
├── requirements-dev.txt           # pytest (dev)
├── frontend/
│   ├── index.html                 # SPA shell (header, tabs, pages, modals, injected config)
│   ├── style.css                  # all styles (responsive)
│   ├── app.js                     # client logic: analysis, auth, router, portal, chat, notifications, push
│   ├── sw.js                      # service worker (receives Web Push, handles notification clicks)
│   └── images/                    # logo + env-impact card images
├── infra/
│   └── template.yaml              # SAM template (all AWS resources)
├── lambdas/
│   ├── waste_details/             # identification + content validation
│   ├── further_actions/           # disposal guidance (streamed)
│   ├── environmental_impact/      # impact flash-card JSON
│   ├── nearby_facilities/         # Amazon Location search + trading platforms
│   ├── smartwaste_assistant/      # AI chat assistant (streamed)
│   ├── profile/                   # JWT-verified profile CRUD + feedback + delete account
│   └── collect/                   # JWT-verified listings + quotes + lifecycle + chat
│       │                          #   + collector verification + admin queue:
│       │                          #   report/quote, approve/confirm/cancel/done/dispute,
│       │                          #   /collector/apply|submit|upload-url|me,
│       │                          #   /admin/collectors (list/approve/reject/suspend)
│       └── (each: app.py, run.sh, requirements.txt)
└── tests/
    ├── conftest.py                # stubs boto3/flask/jwt for pure-logic tests
    ├── test_collect.py
    ├── test_nearby_facilities.py
    └── test_parsers.py
```

---

## Deployment

### Prerequisites
1. AWS account with **Bedrock model access** enabled for Claude Haiku 4.5.
2. An **Amazon Location map API key** created in the console (Maps `GetTile` action), stored as a GitHub secret.
2a. A **VAPID keypair** for Web Push (see *Web Push setup* below), stored as GitHub secrets.
3. AWS CLI + SAM CLI installed; an S3 bucket for SAM artifacts.
4. A deploy IAM user whose permissions cover all resource types created (CloudFormation, Lambda, S3, API Gateway, **Cognito, DynamoDB, AppSync, Location, IAM roles**).

### GitHub secrets

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | Deploy IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | Deploy IAM user secret key |
| `SAM_DEPLOY_BUCKET` | S3 bucket for SAM build artifacts |
| `MAP_API_KEY` | Amazon Location browser map key (Maps GetTile) |
| `VAPID_PUBLIC_KEY` | Web Push VAPID public key (also injected into the frontend) |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key (passed to the `collect` Lambda; `NoEcho`) |
| `VAPID_SUBJECT` | VAPID contact (`mailto:you@example.com` or an `https://` URL) |

### Deploy
Push to `main` triggers the GitHub Actions pipeline (SAM build + deploy, CORS config on each Function URL, injection of all URLs/IDs/keys into `index.html`, S3 sync, CloudFront invalidation):

```bash
git push origin main
```

Or run it manually from the GitHub Actions tab.

### Manual deploy

```bash
sam build --template infra/template.yaml
sam deploy --stack-name smartwaste \
  --s3-bucket YOUR_BUCKET \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --region ap-southeast-1 --no-confirm-changeset
```

After deploy, the pipeline injects the stack outputs (Function URLs, Cognito IDs, AppSync endpoints) and the map key into the frontend before syncing to S3.

---

## Web Push setup

Device notifications use the standard **Web Push** protocol: the browser registers a service worker (`frontend/sw.js`), subscribes to its browser's push service, and stores the subscription in the `push_subscriptions` DynamoDB table (keyed by `userId` + endpoint). When a collect **request**, **approval**, or **chat message** fires, the `collect` Lambda signs a payload with the VAPID keys (via `pywebpush`) and hands it to each subscriber's push service, which wakes the service worker and shows an OS notification — no open tab required.

### 1. Generate a VAPID keypair (one time)

With Node:

```bash
npx web-push generate-vapid-keys
```

Or with Python:

```bash
pip install py-vapid
vapid --gen            # writes private_key.pem / public_key.pem
vapid --applicationServerKey   # prints the base64url public key for the browser
```

### 2. Add three GitHub secrets

- `VAPID_PUBLIC_KEY` — the base64url public key
- `VAPID_PRIVATE_KEY` — the private key
- `VAPID_SUBJECT` — `mailto:you@example.com` (or an `https://` contact URL)

The pipeline passes these to CloudFormation via `--parameter-overrides` (the private key is a `NoEcho` parameter) and injects the public key into `index.html`.

### 3. Opt in (per user, per device)

Web Push is opt-in. While **logged in**, open **Profile → Settings** and click **Enable notifications**, then accept the browser permission prompt. After that the device receives pushes even when the site is closed.

**Notes**
- Requires HTTPS (CloudFront provides it) and a browser that supports the Push API.
- **iOS/iPadOS**: Web Push works only when the site is **added to the Home Screen** (installed as a PWA); Safari tabs alone won't receive pushes.
- `pywebpush` is lazy-imported in the Lambda, so the push path has no effect until the VAPID keys are configured.

---

## Running tests

Unit tests cover the pure logic (JSON parsers, address masking, request-view unlocking, facility classification, distance/URL helpers) **plus the marketplace invariants** — quote validation and the max-price ceiling, the free-vs-paid lane rules, the `priceType` fail-safe default, the confirm-gate unlock statuses, the admin prefix-dispatch gate, and the upload content-type allow-list — all with AWS dependencies stubbed, so no credentials or network are needed.

```bash
pip install -r requirements-dev.txt
pytest
```

> Scope: these are unit tests for pure functions and the marketplace guard logic. Live AWS integration paths (DynamoDB, JWT verification against the pool, Bedrock, presigned-URL round-trips), the full end-to-end lifecycle, and the frontend JS are not yet covered by automated tests.

---

## Collection lifecycle

See **[Collection lifecycle & the "confirm" gate](#collection-lifecycle--the-confirm-gate)** near the top for the full state machine. In short:

```
list (owner)                     waste: open
  → quote (collector)            collect-request: requested   → owner notified
                                 (paid lane: approved collectors only; free lane: any user, no amount)
  → accept (owner)               collect-request: accepted    → NOTHING unlocks yet
  → confirm (owner)              collect-request: confirmed   → address/phone unlock, chat opens,
                                 waste: collecting               losing quotes auto-close
                                                                 (paid lane shows the demo pay screen)
  → either marks done            collect-request: collected   → both notified; moves to History
```

`reject` / `cancel` / `dispute` are **soft status changes — records are never deleted** (full history kept for audit).

## Payments (Phase 2 — not yet live)

Real money movement is **not implemented**. The paid lane carries a `paymentStatus` placeholder (`not_required`) and the confirm step shows a **demo mock payment screen** that charges nothing and calls no payment processor. That screen is the exact slot where an **Amazon-/Stripe-style payment authorization** will later go: authorize on confirm, capture on completion, platform commission as an application fee. Enabling it is gated on local legal review (collecting waste for payment and handling funds can be regulated) and real demand validation — the structure is in place so it becomes a configuration + integration step, not a rebuild.
