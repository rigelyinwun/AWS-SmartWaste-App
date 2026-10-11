# Implementation Plan — Analytics Dashboard (SmartWaste)

Add a manual-calculation analytics dashboard below the History section of the Waste Collect Portal, summarizing the logged-in user's COLLECTED items (their outgoing collect-requests that reached status `collected`). Backend adds a `get_analytics` route to `lambdas/collect/app.py`; frontend adds markup/JS/CSS in `frontend/index.html`, `frontend/app.js`, `frontend/style.css`.

## Design decisions (made during exploration, grounded in the codebase)

### Data source
The collected items are the current user's OUTGOING collect-requests with `status == "collected"`. This matches `loadPortalHistory` in `app.js`, which filters `collectFetch('GET', null, 'requests').outgoing` to `status === 'collected'`. In the Lambda, `list_requests` already queries these via `creq_table.query(IndexName="collectorIndex", KeyConditionExpression=Key("collectorId").eq(me))`. `get_analytics` reuses that exact query and filters to `cr.get("status") == "collected"`. Each collect-request carries `wasteType`, `category`, `weight` (copied from the waste item in `request_collect`) and `completedAt` (set in `mark_done`; `createdAt` as fallback). Rationale: no new table, no new GSI, read-only — the existing `CollectFunction` already has the needed access.

### Manual vs AI
All numbers are computed deterministically in Python. AI (Bedrock) is used ONLY to estimate an impact factor for a waste type NOT in the static table, cached in a module-level dict for the warm Lambda, and failing closed to the `general/other` default. This is the user-approved approach — do not change it.

### Impact-factor table (STATIC) — `IMPACT_FACTORS`
Module-level dict keyed by canonical category. Each entry: `landfill_divert` (0–1 weighting = fraction of this material's mass considered diverted from landfill when collected/recycled) and `co2e_per_kg` (kg CO2e avoided per kg diverted vs landfilling). Values are reasonable, citable real-world approximations; include a brief source comment in code.

| Canonical key | landfill_divert | co2e_per_kg (kg CO2e saved/kg) | One-line source rationale |
|---|---|---|---|
| `plastic` | 0.90 | 1.5 | EPA WARM: recycling mixed plastics avoids ~1–2 kg CO2e/kg vs landfill; most plastic is divertible. |
| `paper` | 0.85 | 0.9 | EPA WARM: recycling paper/cardboard avoids ~0.8–1.0 kg CO2e/kg (avoided virgin pulp + landfill methane). |
| `glass` | 0.95 | 0.3 | EPA WARM: glass recycling avoids ~0.3 kg CO2e/kg; inert, almost fully divertible. |
| `metal` | 0.95 | 4.0 | EPA WARM: aluminium/steel recycling avoids ~4–9 kg CO2e/kg (huge smelting-energy savings); use a conservative blended 4.0. |
| `organic` | 0.80 | 0.5 | EPA WARM: composting food/organics avoids ~0.5 kg CO2e/kg by preventing landfill methane. |
| `ewaste` | 0.70 | 2.0 | EPA/industry: e-waste recovery avoids ~2 kg CO2e/kg (metal/component recovery); lower divert due to mixed materials. |
| `textile` | 0.75 | 3.0 | Textile reuse/recycling avoids ~3 kg CO2e/kg (offsets virgin fibre/production); WRAP estimates. |
| `general` | 0.50 | 0.6 | Fallback for unmatched/mixed waste: modest divert and a conservative blended CO2e factor. |

Synonym normalization (case-insensitive, substring/`in` match on the lowercased `category` then `wasteType`): `cardboard`,`carton`→`paper`; `aluminium`,`aluminum`,`steel`,`tin`,`can`→`metal`; `food`,`compost`,`garden`,`organic`→`organic`; `electronic`,`electronics`,`e-waste`,`ewaste`,`battery`,`device`→`ewaste`; `cloth`,`clothing`,`fabric`,`textile`→`textile`; `plastic`,`pet`,`hdpe`,`bottle`→`plastic`; `glass`,`jar`→`glass`; anything else → `general`. Default/unmatched → `general`.

### AI fallback (unknown type only)
A category string that normalizes to `general` but is non-empty and not already cached MAY be sent to Bedrock (reuse `bedrock` client + `VALIDATION_MODEL_ID`) with a tightly-scoped prompt asking for a strict JSON `{"landfill_divert": <0-1>, "co2e_per_kg": <number>}`. Parse strictly; on any error / unparseable reply / out-of-range, use the `general` default. Cache the parsed result in a module-level `_ai_factor_cache` dict keyed by the lowercased raw type. The AI path must be guarded so it never runs for known types and never raises into aggregation (wrap in try/except, fail closed). Keep `max_tokens` small (e.g. 60), `temperature` 0. Because the loop test harness stubs boto3 (any AWS call raises), the AI branch must be reached only at request time and must degrade silently — pure helpers (parser, normalizer, bucketing, aggregation on supplied data) must not trigger it.

### Weight parser — `parse_weight_kg(text)`
Best-effort kg float from free-text (`"approx 2 kg"`, `"2kg"`, `"500 g"`, `""`, junk). Behavior:
- Lowercase; regex-extract the first number (`\d+(?:\.\d+)?`).
- If no number → return default `1.0`.
- Determine unit from the substring following the number: contains `kg` → kilograms; else contains standalone `g`/`gram` → grams (divide by 1000); else assume kg.
- Guard against absurd/negative values: clamp to `>= 0`; if `<= 0` after parse, return default `1.0`.
- Returns a float. Pure function, no AWS — unit-testable.

### Percentage formulas (both clamped 0–100, documented in code)
Let, over all collected items: `total_weight = Σ weight_kg(item)`; `diverted = Σ weight_kg(item) * landfill_divert(type)`; `co2e_saved = Σ weight_kg(item) * co2e_per_kg(type)`.
- **landfillSavedPct** = `100 * diverted / total_weight` when `total_weight > 0`, else `0`. Interpretation: weighted share of the user's collected mass kept out of landfill. Naturally 0–100 because each `landfill_divert ∈ [0,1]`; still `min(100, max(0, …))` as a guard.
- **climateSavedPct** = `100 * co2e_saved / (co2e_saved + baseline_landfill_emissions)` where `baseline_landfill_emissions = total_weight * LANDFILL_BASELINE_CO2E_PER_KG` with `LANDFILL_BASELINE_CO2E_PER_KG = 1.0` kg CO2e/kg (approximate average landfill emission for mixed MSW; brief source comment). Interpretation: avoided emissions as a fraction of (avoided + would-be-landfill) emissions — always lands in a sensible 0–100 band even for tiny datasets, never divides by zero (returns 0 when `total_weight == 0`). Clamp `min(100, max(0, …))`.
- Both return `0.0` for all percentages when there are no collected items or `total_weight == 0`. Also expose raw `co2eSavedKg` and `landfillDivertedKg` for display/debug.

### Time bucketing — `bucket_timeseries(items)`
Use `completedAt` (fallback `createdAt`) epoch seconds per item. Group into `YYYY-MM` buckets by default. If the span between earliest and latest bucket exceeds ~18 months, switch granularity to `year` (`YYYY`). Each point: `{label, count, weightKg}`; sorted chronologically. Pure function.

### get_analytics JSON shape (returned to frontend)
```json
{
  "totalCollected": 0,
  "totalWeightKg": 0.0,
  "timeSeries": { "granularity": "month", "points": [ { "label": "2024-05", "count": 2, "weightKg": 3.5 } ] },
  "byType": [ { "type": "Plastic", "count": 3, "weightKg": 4.2 } ],
  "landfillSavedPct": 0.0,
  "climateSavedPct": 0.0,
  "co2eSavedKg": 0.0,
  "landfillDivertedKg": 0.0
}
```
`byType` sorted descending by `count`. Floats rounded to 1–2 dp. On DynamoDB error, return the all-zero/empty version (match the defensive style of `list_requests`, which returns empty lists on query error) rather than a 500.

### infra/template.yaml — NO CHANGE NEEDED
Confirmed: `CollectRequestsTable` already defines the `collectorIndex` GSI (template.yaml ~line 266) and `CollectFunction` already queries it in `list_requests`. The new `analytics` route runs on the existing `CollectFunction`, reads only `creq_table` via the existing GSI, and adds no new resource, env var, or permission. No template edit.

---

## Plan

- [ ] 1. Add pure helper functions and the static impact-factor table to `lambdas/collect/app.py`.
      Add module-level `IMPACT_FACTORS` dict (8 canonical keys per the table above, each with `landfill_divert` + `co2e_per_kg` and a brief source comment), `LANDFILL_BASELINE_CO2E_PER_KG = 1.0`, `_ai_factor_cache = {}`, and pure functions `parse_weight_kg(text)`, `normalize_category(category, waste_type="")` (returns a canonical key via the synonym rules), and `bucket_timeseries(items)`. Place them near the other helpers (e.g. after `_s`/`_now_micros`), importable without AWS. Do NOT call Bedrock from these pure functions.
      Files: lambdas/collect/app.py
      Verify: `python -m py_compile lambdas/collect/app.py` exits 0, and `python -m pytest -q` stays green (25 existing tests pass).

- [ ] 2. Add the AI-fallback factor lookup `factor_for(category, waste_type)` in `lambdas/collect/app.py`.
      Returns `(landfill_divert, co2e_per_kg)`. First `normalize_category`; if it resolves to a known key, return the static tuple. If it resolves to `general` AND the raw type string is non-empty, check `_ai_factor_cache`; on miss, call Bedrock (reuse `bedrock`, `VALIDATION_MODEL_ID`) with a tightly-scoped prompt returning strict JSON, parse+range-check, cache, and return it; on ANY error/unparseable/out-of-range, return the `general` default. Wrap the whole AI branch in try/except (fail closed). Must never raise and never run for known types.
      Files: lambdas/collect/app.py
      Verify: `python -m py_compile lambdas/collect/app.py` exits 0; `python -m pytest -q` green (test harness stubs boto3 — confirm importing the module and calling `factor_for("Plastic")` / `factor_for("")` returns static values without triggering an AWS call).

- [ ] 3. Implement `get_analytics(claims)` and wire its GET route in `lambdas/collect/app.py`.
      `get_analytics` queries `creq_table` with `IndexName="collectorIndex", KeyConditionExpression=Key("collectorId").eq(claims["sub"])` inside try/except (log + return the all-zero shape on error, mirroring `list_requests`), filters to `status == "collected"`, then computes totals, `bucket_timeseries`, `byType` (grouped by display category/wasteType, sorted desc by count), and both clamped percentages per the formulas above, returning the JSON shape documented in the design section. In `handler`, under the GET branches, add `if route.endswith("analytics"): return _unwrap(get_analytics(claims))` placed BEFORE the final `return _unwrap(list_public(claims))` fallback and not colliding with existing `endswith` checks (`mine`/`requests`/`notifications`/`conversations`/`messages`).
      Files: lambdas/collect/app.py
      Verify: `python -m py_compile lambdas/collect/app.py` exits 0; `python -m pytest -q` green; confirm no existing route string is a suffix of `analytics` and vice-versa (it is not).

- [ ] 4. Add 2–4 focused pure-logic unit tests in `tests/test_collect.py`.
      Following the existing `_load()` pattern (imports with boto3/flask/jwt stubbed via `tests/conftest.py`), cover: `parse_weight_kg` ("2kg"→2.0, "500 g"→0.5, ""→1.0, "approx 2 kg"→2.0, junk→1.0); `normalize_category` (synonyms map correctly, unknown→`general`); `bucket_timeseries` (monthly grouping + chronological order, and year granularity when span >18 months). No network/AWS — do not exercise `get_analytics` or the Bedrock branch.
      Files: tests/test_collect.py
      Verify: `python -m pytest -q tests/test_collect.py` passes all tests (existing + new); full `python -m pytest -q` stays green.

- [ ] 5. Add Chart.js CDN and the analytics dashboard markup to `frontend/index.html`.
      In `<head>`, after the existing CDN scripts (maplibre-gl / amazon-cognito-identity pattern), add the pinned Chart.js: `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>`. Inside `<div class="portal-panel" id="portalHistoryPanel" hidden>`, BELOW the `#historyCollectedCards` block, add `<section class="analytics-dash" id="analyticsDash" hidden> … </section>` containing: a heading; a totals row with two stat cards (`#statTotalCollected`, `#statTotalWeight`); a line-chart container holding `<canvas id="collectionLineChart">`; a pie-chart container holding `<canvas id="wasteTypePie">`; two circular-bar widgets `#landfillSavedWidget` and `#climateSavedWidget` (each a conic-gradient ring with a centered percent span, e.g. `#landfillSavedPct`/`#climateSavedPct`); and an empty-state element `#analyticsEmpty` (`hidden` by default) with a friendly no-data message. Give charts fixed-height containers so Chart.js can't grow unbounded.
      Files: frontend/index.html
      Verify: open the page / load the Portal → History tab in a browser; the new section renders without console errors and the History cards still load. (No automated HTML test exists; manual DOM/console check.)

- [ ] 6. Append analytics styles to `frontend/style.css`, keeping braces balanced.
      Append rules for `.analytics-dash` (section spacing, matches design tokens), the two stat cards (reuse `--card-bg`, `--radius`, `--shadow`, `--grad-primary` accents, Space Grotesk for the big number), `.analytics-chart-wrap` with a fixed container height (e.g. `height: 260px; position: relative;`) so the canvases are constrained, and the conic-gradient circular widgets (a ring div using `background: conic-gradient(var(--primary) calc(var(--pct) * 1%), var(--border) 0)`, an inner mask circle, and a centered percent label). Make the layout responsive (stacks to one column on mobile via the existing breakpoint style). Keep total braces balanced — baseline is 487 open / 487 close; the final count must stay equal (open == close).
      Files: frontend/style.css
      Verify: run the brace-balance check — open-brace count equals close-brace count (e.g. PowerShell: `$c=Get-Content -Raw frontend/style.css; ($c.ToCharArray()|?{$_ -eq '{'}).Count; ($c.ToCharArray()|?{$_ -eq '}'}).Count` → both numbers equal); visually confirm widgets match the green/gradient theme.

- [ ] 7. Wire `loadAnalytics()` into `frontend/app.js` and render the widgets.
      Add module-level refs `var lineChartInstance = null, pieChartInstance = null;`. Add `function loadAnalytics()` that calls `collectFetch('GET', null, 'analytics')`; on success populate the two stat cards, build/destroy-and-recreate the Chart.js line + pie charts (call `.destroy()` on existing instances before `new Chart(...)` so repeated History tab switches don't leak/double-render), set each circular widget's `--pct` CSS custom property and center text from `landfillSavedPct`/`climateSavedPct`, and toggle `#analyticsDash` vs `#analyticsEmpty` based on `totalCollected > 0`. On fetch error, show a non-fatal inline message (match the `showMsg`/placeholder/`error-message` pattern) and leave History working. Call `loadAnalytics()` at the END of `loadPortalHistory()` (after the two existing `collectFetch` calls that populate posted/collected cards), so analytics loads whenever the History panel shows. Guard against Chart being undefined (CDN not loaded / local preview) by checking `typeof Chart !== 'undefined'` before creating charts.
      Files: frontend/app.js
      Verify: in a browser, open Portal → History: stat cards, line chart, pie chart, and both rings render; switch to List and back to History repeatedly and confirm charts re-render without duplication or console errors; simulate zero data (new/empty account) and confirm the empty-state shows and History still works.

## Six verification steps (summary — run in order)
1. `python -m py_compile lambdas/collect/app.py` → exit 0.
2. `python -m pytest -q` → all tests pass (25 existing + 2–4 new).
3. CSS brace balance: open-brace count == close-brace count in `frontend/style.css`.
4. Browser: Portal → History renders the dashboard (2 stat cards, line chart, pie chart, 2 conic rings) with no console errors.
5. Browser: switch List ↔ History several times → charts re-render cleanly (no leak/duplication), confirming `.destroy()` guarding.
6. Browser: empty/zero-data account → `#analyticsEmpty` message shows, charts hidden, and the existing History Posted/Collected cards still load (analytics failure is non-fatal).

## Implementation record (first iteration)

Implemented per plan. What was built:
- `lambdas/collect/app.py`: added `IMPACT_FACTORS` (8 canonical keys w/ source comments), `LANDFILL_BASELINE_CO2E_PER_KG = 1.0`, `_ai_factor_cache`, pure helpers `parse_weight_kg`, `normalize_category`, `bucket_timeseries`, `_item_epoch_seconds`, the AI-fallback `factor_for` (reuses `bedrock`/`VALIDATION_MODEL_ID`, caches, fails closed), `_empty_analytics`, and `get_analytics(claims)`. Wired `route.endswith("analytics")` into the GET branch of `handler` before the `list_public` fallback. `import re` added to the stdlib import block.
- `tests/test_collect.py`: added 5 pure-logic tests (weight parser incl. negative/junk, synonym normalization, known-type factor lookup w/o AWS, monthly bucketing + chronology, year granularity when span >18mo).
- `frontend/index.html`: pinned Chart.js CDN in `<head>`; added `<section id="analyticsDash">` below `#historyCollectedCards` with two stat cards, line + pie canvases, two conic rings, and an `#analyticsEmpty` state.
- `frontend/style.css`: appended `.analytics-*` rules (stat cards, fixed-height chart wrap, conic-gradient rings) + mobile stacking. Brace count 487→506 open and close (stayed balanced).
- `frontend/app.js`: module-level `lineChartInstance`/`pieChartInstance`; `loadAnalytics()` (fetch, empty/zero + non-fatal error handling), `setRing`, `destroyAnalyticsCharts`, `renderAnalyticsCharts` (destroy-before-create, `typeof Chart` guard). Called at the end of `loadPortalHistory()`.
- `infra/template.yaml`: NO CHANGE. `collectorIndex` GSI + `${CollectRequestsTable.Arn}/index/*` IAM already present; `CollectFunction` already uses `AppBedrockRole` granting `bedrock:InvokeModel` for the claude-haiku model.

Verification results (all six):
1. `python -m py_compile lambdas/collect/app.py` → exit 0.
2. `python -m pytest -q` → 30 passed (25 existing + 5 new).
3. `node --check frontend/app.js` → exit 0.
4. SAM template parses (YAML load OK); no change needed — justified above.
5. CSS brace balance: open == close == 506.
6. End-to-end trace confirmed: `collectFetch('GET',null,'analytics')` → `handler` GET `endswith('analytics')` → `get_analytics` → JSON shape → `loadAnalytics` renders stat cards/charts/rings; empty path (`totalCollected<=0` / `_empty_analytics`) hides the dash and shows `#analyticsEmpty`.

## Notes / assumptions
- `completedAt` is epoch SECONDS (set via `int(time.time())` in `mark_done`); `createdAt` on collect-requests is MICROSECONDS (`_now_micros()`). The bucketer must normalize: treat values `> 10^12` as microseconds and divide by 1_000_000 before converting to a date. Flag this in code with a comment.
- Display category for `byType` uses the item's human `category` (fallback `wasteType`, fallback "Other"); canonicalization is only for factor lookup, not for the user-facing label.
- Reuse the existing `error-message` CSS class and `showMsg` helper for the non-fatal error path rather than adding new error styling.
