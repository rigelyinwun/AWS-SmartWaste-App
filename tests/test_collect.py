"""Unit tests for pure logic in lambdas/collect/app.py."""
import importlib.util
import os
import sys

HERE = os.path.dirname(__file__)
COLLECT = os.path.join(HERE, "..", "lambdas", "collect", "app.py")


def _load():
    spec = importlib.util.spec_from_file_location("collect_app", COLLECT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


app = _load()


# --- _s (string coercion) ---
def test_s_trims_and_handles_none():
    assert app._s("  hi ") == "hi"
    assert app._s(None) == ""
    assert app._s(123) == "123"


# --- public_view: address masking ---
def test_public_view_masks_for_non_owner():
    item = {
        "requestId": "r1", "ownerId": "u1", "status": "open",
        "wasteType": "Bottles", "fullAddress": "123 Secret St",
        "phone": "+60123", "area": "Cyberjaya",
    }
    v = app.public_view(item, owner=False)
    assert v.get("addressMasked") is True
    assert "fullAddress" not in v
    assert "phone" not in v
    assert v["area"] == "Cyberjaya"


def test_public_view_exposes_price_fields_to_non_owner():
    # Pricing fields are not sensitive: priceType/currency (and maxPrice when
    # set) are shown to a non-owner while the address stays masked.
    item = {
        "requestId": "r1", "ownerId": "u1", "status": "open",
        "wasteType": "Bottles", "fullAddress": "123 Secret St",
        "phone": "+60123", "area": "Cyberjaya",
        "priceType": "user_pays", "currency": "MYR", "maxPrice": "25.00",
    }
    v = app.public_view(item, owner=False)
    assert v["priceType"] == "user_pays"
    assert v["currency"] == "MYR"
    assert v["maxPrice"] == "25.00"
    # Masking preserved.
    assert v.get("addressMasked") is True
    assert "fullAddress" not in v
    assert "phone" not in v


def test_public_view_reveals_for_owner():
    item = {
        "requestId": "r1", "ownerId": "u1", "status": "open",
        "wasteType": "Bottles", "fullAddress": "123 Secret St",
        "phone": "+60123", "contactName": "Jane",
    }
    v = app.public_view(item, owner=True)
    assert v["fullAddress"] == "123 Secret St"
    assert v["phone"] == "+60123"
    assert v.get("addressMasked") is None or "addressMasked" not in v


# --- _creq_view: unlock only when approved ---
def test_creq_view_locked_when_requested():
    cr = {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "o",
          "collectorId": "k", "status": "requested"}
    v = app._creq_view(cr, {"fullAddress": "X", "phone": "Y"})
    assert "fullAddress" not in v
    assert not v.get("unlocked")


def test_creq_view_unlocks_when_confirmed():
    # Unlock point moved from 'approved' to 'confirmed' (first UNLOCK_STATUSES
    # state) by the Phase 1 disintermediation state machine.
    cr = {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "o",
          "collectorId": "k", "status": "confirmed"}
    waste = {"fullAddress": "123 St", "phone": "+60", "pickupTime": "9am", "notes": "lobby"}
    v = app._creq_view(cr, waste)
    assert v["unlocked"] is True
    assert v["fullAddress"] == "123 St"
    assert v["ownerPhone"] == "+60"


# --- notif_channel_name: build the realtime channel from a token ---
def test_notif_channel_name():
    assert app.notif_channel_name("abc") == "notifications/abc"


# --- _dec_price: parse money to non-negative 2dp Decimal, else None ---
def test_dec_price_parses_and_rounds():
    from decimal import Decimal
    assert app._dec_price("5") == Decimal("5.00")
    assert app._dec_price("5") == 5
    # Rounds to 2 decimal places (half-even quantize).
    assert app._dec_price("1.555") == Decimal("1.56")
    assert app._dec_price("10.004") == Decimal("10.00")


def test_dec_price_blank_and_junk_return_none():
    assert app._dec_price("") is None
    assert app._dec_price(None) is None
    assert app._dec_price("abc") is None
    assert app._dec_price("1.2.3") is None


def test_dec_price_negative_returns_none():
    assert app._dec_price("-1") is None
    assert app._dec_price("-0.01") is None


# --- _validate_quote: amount vs owner maxPrice ---
def test_validate_quote_requires_positive_amount():
    from decimal import Decimal
    ok, err = app._validate_quote(None, None)
    assert ok is False and err == "A quote amount greater than 0 is required"
    ok, err = app._validate_quote(Decimal("0"), None)
    assert ok is False and err == "A quote amount greater than 0 is required"
    ok, err = app._validate_quote(Decimal("-5"), None)
    assert ok is False and err == "A quote amount greater than 0 is required"


def test_validate_quote_rejects_above_max_price():
    from decimal import Decimal
    ok, err = app._validate_quote(Decimal("50.00"), Decimal("40.00"))
    assert ok is False
    assert err == "Quote exceeds the owner's maximum price"


def test_validate_quote_accepts_within_max_and_no_max():
    from decimal import Decimal
    ok, err = app._validate_quote(Decimal("40.00"), Decimal("40.00"))
    assert ok is True and err is None
    ok, err = app._validate_quote(Decimal("10.00"), None)
    assert ok is True and err is None


# --- _creq_view: price fields always present (NIT#6) ---
def test_creq_view_price_fields_present_pre_confirm():
    # For pre-confirm statuses, contact fields are ABSENT but price fields are
    # ALWAYS present (never gated by unlock) — NIT#6.
    waste = {"fullAddress": "123 St", "phone": "+60"}
    for status in ("requested", "accepted"):
        cr = {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "o",
              "collectorId": "k", "status": status,
              "quoteAmount": None, "currency": "MYR",
              "maxPrice": None, "paymentStatus": "unpaid"}
        v = app._creq_view(cr, waste)
        # Contact absent pre-confirm.
        assert "fullAddress" not in v
        assert "ownerPhone" not in v
        assert not v.get("unlocked")
        # Price fields always present.
        assert "quoteAmount" in v
        assert "currency" in v
        assert "maxPrice" in v
        assert "paymentStatus" in v


def test_creq_view_unlocks_for_each_unlock_status_with_waste():
    waste = {"fullAddress": "123 St", "phone": "+60", "pickupTime": "9am", "notes": "n"}
    for status in app.UNLOCK_STATUSES:
        cr = {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "o",
              "collectorId": "k", "status": status}
        v = app._creq_view(cr, waste)
        assert v["unlocked"] is True
        assert v["fullAddress"] == "123 St"
        assert v["ownerPhone"] == "+60"
        # Price fields still present alongside the unlock.
        assert "quoteAmount" in v and "maxPrice" in v


def test_creq_view_contact_absent_when_waste_none():
    # Documents the list_requests call-site contract: even in an UNLOCK status,
    # contact fields stay absent when no waste object is supplied.
    for status in app.UNLOCK_STATUSES:
        cr = {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "o",
              "collectorId": "k", "status": status}
        v = app._creq_view(cr, None)
        assert "fullAddress" not in v
        assert "ownerPhone" not in v
        assert not v.get("unlocked")
        # Price fields remain present regardless.
        assert "quoteAmount" in v and "maxPrice" in v


# --- _chat_enabled: open only in CHAT_STATUSES ---
def test_chat_enabled_false_pre_and_post_terminal():
    for status in ("requested", "accepted", "rejected", "cancelled", "closed"):
        cr = {"status": status}
        assert app._chat_enabled(cr) is False


def test_chat_enabled_true_in_chat_statuses():
    for status in app.CHAT_STATUSES:
        cr = {"status": status}
        assert app._chat_enabled(cr) is True


# --- _is_admin: only when 'admins' in cognito:groups ---
def test_is_admin_true_only_when_in_admins_group():
    assert app._is_admin({"cognito:groups": ["admins"]}) is True
    assert app._is_admin({"cognito:groups": ["users", "admins"]}) is True


def test_is_admin_false_for_empty_missing_or_unrelated_group():
    assert app._is_admin({"cognito:groups": []}) is False
    assert app._is_admin({}) is False
    assert app._is_admin({"cognito:groups": ["collectors"]}) is False


# --- _json_default (Decimal serialization) ---
def test_json_default_decimal():
    from decimal import Decimal
    assert app._json_default(Decimal("5")) == 5
    assert app._json_default(Decimal("1.5")) == 1.5


# --- Analytics: weight parser (pure, no AWS) ---
def test_parse_weight_kg():
    assert app.parse_weight_kg("2kg") == 2.0
    assert app.parse_weight_kg("500 g") == 0.5
    assert app.parse_weight_kg("approx 2 kg") == 2.0
    assert app.parse_weight_kg("") == 1.0
    assert app.parse_weight_kg("heavy") == 1.0  # junk -> default
    assert app.parse_weight_kg("-3 kg") == 1.0  # absurd -> default
    assert app.parse_weight_kg("1.5") == 1.5    # no unit -> assume kg


# --- Analytics: category normalization + static factors (no AI) ---
def test_normalize_category_synonyms():
    assert app.normalize_category("Plastic bottles") == "plastic"
    assert app.normalize_category("Cardboard box") == "paper"
    assert app.normalize_category("Aluminium cans") == "metal"
    assert app.normalize_category("Food scraps") == "organic"
    assert app.normalize_category("Old laptop", "electronics") == "ewaste"
    assert app.normalize_category("", "glass jar") == "glass"
    assert app.normalize_category("mystery goo") == "general"
    assert app.normalize_category("", "") == "general"


def test_factor_for_known_types_no_ai():
    # Known types resolve from the static table synchronously (no AWS call).
    assert app.factor_for("Plastic") == app.IMPACT_FACTORS["plastic"]
    assert app.factor_for("", "metal") == app.IMPACT_FACTORS["metal"]
    # Empty type returns the general default without consulting Bedrock.
    assert app.factor_for("") == app.IMPACT_FACTORS["general"]


# --- Analytics: time-series bucketing (pure) ---
def test_bucket_timeseries_monthly_chronological():
    # completedAt is epoch seconds. Two in May, one in April 2024.
    items = [
        {"completedAt": 1714000000, "weight": "2kg"},   # 2024-04
        {"completedAt": 1715000000, "weight": "1kg"},   # 2024-05
        {"completedAt": 1715500000, "weight": "500 g"},  # 2024-05
    ]
    ts = app.bucket_timeseries(items)
    assert ts["granularity"] == "month"
    labels = [p["label"] for p in ts["points"]]
    assert labels == sorted(labels)  # chronological
    assert labels[0] == "2024-04"
    # The May bucket aggregates two items.
    may = [p for p in ts["points"] if p["label"] == "2024-05"][0]
    assert may["count"] == 2


def test_bucket_timeseries_year_granularity_when_span_large():
    # Span > 18 months -> switch to yearly granularity.
    items = [
        {"completedAt": 1577880000, "weight": "1kg"},   # 2020-01
        {"completedAt": 1704110400, "weight": "1kg"},   # 2024-01
    ]
    ts = app.bucket_timeseries(items)
    assert ts["granularity"] == "year"
    labels = [p["label"] for p in ts["points"]]
    assert labels == sorted(labels)
    assert "2020" in labels and "2024" in labels


# ===================== Free-giveaway lane (request_collect) =====================
# These tests drive request_collect with lightweight fakes for the module-level
# AWS handles so the pure routing/gate logic runs without hitting AWS. The
# collect-request table captures put_item so we can assert what was persisted.

class _CaptureTable:
    """Captures put_item and returns no live quotes from the duplicate scan."""
    def __init__(self):
        self.put_items = []

    def put_item(self, Item=None, **k):
        self.put_items.append(Item)

    def query(self, **k):
        # No existing quotes -> never a duplicate-live-quote conflict.
        return {"Items": []}


def _status_of(resp):
    """request_collect returns a flask _Response stub (error) or a dict
    (_creq_view success). Normalize to an HTTP-ish status for assertions."""
    return getattr(resp, "status", 200)


def _setup_request_collect(monkeypatch, waste, approved=False):
    """Wire request_collect's module globals to fakes. `approved` controls
    whether the calling user is an approved collector."""
    cap = _CaptureTable()
    monkeypatch.setattr(app, "creq_table", cap)
    # `table` just needs to be truthy for the service-available guard; _get_waste
    # is patched to return our waste object directly.
    monkeypatch.setattr(app, "table", object())
    monkeypatch.setattr(app, "_get_waste", lambda wid: waste)
    monkeypatch.setattr(app, "_is_approved_collector", lambda uid: approved)
    monkeypatch.setattr(app, "notify", lambda *a, **k: None)
    monkeypatch.setattr(app, "_now_micros", lambda: 1)
    return cap


def _open_waste(price_type, owner="owner-1", max_price=None):
    w = {"requestId": "w1", "ownerId": owner, "status": "open",
         "wasteType": "Bottles", "priceType": price_type, "currency": "MYR"}
    if max_price is not None:
        w["maxPrice"] = max_price
    return w


# (a) free listing lets a NON-approved-collector user pass the gate (no 403).
def test_request_collect_free_allows_non_collector(monkeypatch):
    cap = _setup_request_collect(monkeypatch, _open_waste("free"), approved=False)
    resp = app.request_collect({"sub": "user-2", "name": "Ann"},
                               {"wasteId": "w1"})
    # Success path returns a _creq_view dict, not a 403 Response.
    assert isinstance(resp, dict)
    assert _status_of(resp) == 200
    assert len(cap.put_items) == 1
    # No quote amount recorded for a free collect.
    assert cap.put_items[0]["quoteAmount"] is None


# (b) a free collect with no quoteAmount is accepted (no 400).
def test_request_collect_free_no_amount_no_400(monkeypatch):
    _setup_request_collect(monkeypatch, _open_waste("free"), approved=False)
    # Body omits quoteAmount entirely.
    resp = app.request_collect({"sub": "user-2"}, {"wasteId": "w1"})
    assert isinstance(resp, dict)
    assert _status_of(resp) == 200


# (c) paid listing STILL 403s a non-approved collector (regression).
def test_request_collect_paid_still_403s_non_collector(monkeypatch):
    _setup_request_collect(monkeypatch, _open_waste("user_pays"), approved=False)
    resp = app.request_collect({"sub": "user-2"},
                               {"wasteId": "w1", "quoteAmount": "10.00"})
    assert _status_of(resp) == 403


# (c) paid listing STILL 400s an over-ceiling / invalid quote (regression).
def test_request_collect_paid_still_400s_over_ceiling(monkeypatch):
    _setup_request_collect(monkeypatch,
                           _open_waste("user_pays", max_price="20.00"),
                           approved=True)
    # Over the owner's ceiling -> 400.
    resp = app.request_collect({"sub": "user-2"},
                               {"wasteId": "w1", "quoteAmount": "50.00"})
    assert _status_of(resp) == 400
    # Missing amount on a paid item -> 400 (positive amount required).
    resp2 = app.request_collect({"sub": "user-2"},
                                {"wasteId": "w1"})
    assert _status_of(resp2) == 400


# (c) paid listing accepts a valid within-ceiling quote from an approved collector.
def test_request_collect_paid_accepts_valid_quote(monkeypatch):
    cap = _setup_request_collect(monkeypatch,
                                 _open_waste("user_pays", max_price="20.00"),
                                 approved=True)
    resp = app.request_collect({"sub": "user-2"},
                               {"wasteId": "w1", "quoteAmount": "15.00"})
    assert isinstance(resp, dict)
    from decimal import Decimal
    assert cap.put_items[0]["quoteAmount"] == Decimal("15.00")


# (d) unknown/bogus priceType falls back to paid (user_pays) so the free lane
#     cannot be opened by a bad value — a non-collector still gets 403.
def test_request_collect_bogus_pricetype_is_business_gated(monkeypatch):
    # NOTE: request_collect itself only treats EXACTLY 'free' as free; any other
    # value (incl. junk) stays on the business-gated paid path.
    _setup_request_collect(monkeypatch, _open_waste("totally-bogus"),
                           approved=False)
    resp = app.request_collect({"sub": "user-2"},
                               {"wasteId": "w1", "quoteAmount": "10.00"})
    assert _status_of(resp) == 403


# Guards that MUST still apply to free items.
def test_request_collect_free_self_collect_still_400(monkeypatch):
    _setup_request_collect(monkeypatch, _open_waste("free", owner="user-2"),
                           approved=False)
    resp = app.request_collect({"sub": "user-2"}, {"wasteId": "w1"})
    assert _status_of(resp) == 400  # self-collect guard


def test_request_collect_free_closed_item_still_409(monkeypatch):
    waste = _open_waste("free")
    waste["status"] = "collected"
    _setup_request_collect(monkeypatch, waste, approved=False)
    resp = app.request_collect({"sub": "user-2"}, {"wasteId": "w1"})
    assert _status_of(resp) == 409  # item no longer available


def test_request_collect_free_duplicate_live_quote_still_409(monkeypatch):
    cap = _setup_request_collect(monkeypatch, _open_waste("free"), approved=False)

    # Make the duplicate-scan return a live quote by the same collector.
    def _query(**k):
        return {"Items": [{"collectorId": "user-2", "status": "requested"}]}
    cap.query = _query
    resp = app.request_collect({"sub": "user-2"}, {"wasteId": "w1"})
    assert _status_of(resp) == 409  # duplicate live quote


# (e) disintermediation invariant for a FREE item: a freshly-created free quote
#     is 'requested' -> contact/chat MUST stay locked (nothing unlocks before
#     'confirmed'). The lifecycle is shared, so _creq_view enforces this.
def test_free_item_quote_locked_until_confirmed(monkeypatch):
    cap = _setup_request_collect(monkeypatch, _open_waste("free"), approved=False)
    resp = app.request_collect({"sub": "user-2"}, {"wasteId": "w1"})
    assert resp["status"] == "requested"
    assert not resp.get("unlocked")
    assert "fullAddress" not in resp
    assert "ownerPhone" not in resp
    assert app._chat_enabled({"status": "requested"}) is False
    # The persisted record is a normal collect-request that flows through the
    # same accept -> confirm machine; it only unlocks at a confirmed status.
    stored = cap.put_items[0]
    assert stored["status"] == "requested"
    waste = _open_waste("free")
    assert app._creq_view(stored, waste).get("unlocked") is not True


# ===================== create_report priceType whitelist =====================

def _setup_create_report(monkeypatch):
    """Fake the image validator + waste table so create_report runs offline and
    we can inspect the persisted item."""
    cap = _CaptureTable()
    monkeypatch.setattr(app, "table", cap)
    monkeypatch.setattr(app, "validate_image", lambda *a, **k: True)
    return cap


def _report_body(**over):
    body = {
        "contactName": "Jane", "phone": "+60123456789", "fullAddress": "123 St",
        "wasteType": "Bottles", "category": "plastic", "weight": "2kg",
        "file_data": "x", "file_mime": "image/png",
    }
    body.update(over)
    return body


def test_create_report_free_records_free_and_no_max_price(monkeypatch):
    cap = _setup_create_report(monkeypatch)
    app.create_report({"sub": "u1", "name": "Jane", "email": "j@x.com"},
                      _report_body(priceType="free", maxPrice="20.00"))
    item = cap.put_items[0]
    assert item["priceType"] == "free"
    # A free listing records NO maxPrice even if one is sent.
    assert "maxPrice" not in item


def test_create_report_user_pays_keeps_max_price(monkeypatch):
    cap = _setup_create_report(monkeypatch)
    app.create_report({"sub": "u1"},
                      _report_body(priceType="user_pays", maxPrice="20.00"))
    item = cap.put_items[0]
    assert item["priceType"] == "user_pays"
    from decimal import Decimal
    assert item["maxPrice"] == Decimal("20.00")


def test_create_report_unknown_pricetype_falls_back_to_user_pays(monkeypatch):
    # A bogus priceType must fail safe toward the paid, business-gated lane so a
    # bad value can never open the free collect lane.
    cap = _setup_create_report(monkeypatch)
    app.create_report({"sub": "u1"}, _report_body(priceType="totally-bogus"))
    assert cap.put_items[0]["priceType"] == "user_pays"


def test_create_report_missing_pricetype_defaults_to_user_pays(monkeypatch):
    cap = _setup_create_report(monkeypatch)
    body = _report_body()
    body.pop("priceType", None)
    app.create_report({"sub": "u1"}, body)
    assert cap.put_items[0]["priceType"] == "user_pays"


# ===================== edit_report owner/status guard + partial update ========

class _UpdateTable:
    """Captures update_item so we can assert the partial UpdateExpression."""
    def __init__(self):
        self.updates = []

    def update_item(self, **k):
        self.updates.append(k)


def _editable_waste(status="open", owner="owner-1", price_type="user_pays"):
    return {"requestId": "w1", "ownerId": owner, "status": status,
            "wasteType": "Bottles", "priceType": price_type, "currency": "MYR",
            "description": "old desc", "notes": "old notes", "phone": "111"}


def _setup_edit_report(monkeypatch, waste):
    cap = _UpdateTable()
    monkeypatch.setattr(app, "table", cap)
    monkeypatch.setattr(app, "_get_waste", lambda wid: waste)
    # Guard against accidental image re-validation: blow up if called.
    monkeypatch.setattr(app, "validate_image",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("validate_image called")))
    return cap


# (a) a non-owner cannot edit -> 403.
def test_edit_report_non_owner_403(monkeypatch):
    _setup_edit_report(monkeypatch, _editable_waste())
    resp = app.edit_report({"sub": "someone-else"},
                           {"requestId": "w1", "notes": "hacked"})
    assert _status_of(resp) == 403


# (b) owner + open status succeeds, writes only the provided field, and leaves an
#     omitted field out of the UpdateExpression values (partial update).
def test_edit_report_owner_open_partial_update(monkeypatch):
    cap = _setup_edit_report(monkeypatch, _editable_waste())
    resp = app.edit_report({"sub": "owner-1"},
                           {"requestId": "w1", "notes": "new notes"})
    assert isinstance(resp, dict)
    assert _status_of(resp) == 200
    assert len(cap.updates) == 1
    vals = cap.updates[0]["ExpressionAttributeValues"]
    # Only the submitted field is written; omitted 'description' is untouched.
    assert vals[":notes"] == "new notes"
    assert ":description" not in vals
    # The returned owner view reflects the change.
    assert resp["notes"] == "new notes"


# (c) owner but item no longer open -> 409.
def test_edit_report_non_open_409(monkeypatch):
    for status in ("collecting", "collected", "closed", "disputed"):
        cap = _setup_edit_report(monkeypatch, _editable_waste(status=status))
        resp = app.edit_report({"sub": "owner-1"},
                               {"requestId": "w1", "notes": "x"})
        assert _status_of(resp) == 409
        assert cap.updates == []  # nothing written on a blocked edit


# (d) switching to free drops maxPrice via a REMOVE clause (no :maxPrice set).
def test_edit_report_free_removes_max_price(monkeypatch):
    cap = _setup_edit_report(monkeypatch, _editable_waste())
    resp = app.edit_report({"sub": "owner-1"},
                           {"requestId": "w1", "priceType": "free",
                            "maxPrice": "20.00"})
    assert isinstance(resp, dict)
    expr = cap.updates[0]["UpdateExpression"]
    assert "REMOVE maxPrice" in expr
    assert ":maxPrice" not in cap.updates[0].get("ExpressionAttributeValues", {})


# (e) an edit WITHOUT a new image never calls validate_image (setup would raise).
def test_edit_report_no_image_skips_validation(monkeypatch):
    cap = _setup_edit_report(monkeypatch, _editable_waste())
    resp = app.edit_report({"sub": "owner-1"},
                           {"requestId": "w1", "weight": "3kg"})
    assert isinstance(resp, dict)
    assert cap.updates[0]["ExpressionAttributeValues"][":weight"] == "3kg"


# ===================== Admin prefix dispatch (invariant e) =====================
# These harden the routing collision guard: /admin/collectors/{id}/approve MUST
# be captured by the prefix dispatcher and reach the admin handler, NOT the
# endswith('approve') -> approve_request branch. They also pin the admins-group
# gate ahead of any state change. All run offline (admin_* functions patched).

def _patch_admin_calls(monkeypatch):
    """Record which admin handler fired, without touching AWS."""
    calls = []
    monkeypatch.setattr(app, "admin_approve_collector",
                        lambda claims, cid: calls.append(("approve", cid)) or {"ok": True})
    monkeypatch.setattr(app, "admin_reject_collector",
                        lambda claims, cid, body: calls.append(("reject", cid, body)) or {"ok": True})
    monkeypatch.setattr(app, "admin_suspend_collector",
                        lambda claims, cid: calls.append(("suspend", cid)) or {"ok": True})
    return calls


def test_dispatch_admin_routes_approve_to_admin_handler(monkeypatch):
    # The id contains the literal word 'approve'-adjacent path; the dispatcher
    # must parse the trailing action and call admin_approve_collector.
    calls = _patch_admin_calls(monkeypatch)
    admin_claims = {"sub": "a1", "cognito:groups": ["admins"]}
    resp = app.dispatch_admin(admin_claims, "/admin/collectors/COL-123/approve", {})
    assert resp == {"ok": True}
    assert calls == [("approve", "COL-123")]


def test_dispatch_admin_reject_and_suspend(monkeypatch):
    calls = _patch_admin_calls(monkeypatch)
    admin_claims = {"sub": "a1", "cognito:groups": ["admins"]}
    app.dispatch_admin(admin_claims, "/admin/collectors/C9/reject", {"reason": "bad"})
    app.dispatch_admin(admin_claims, "/admin/collectors/C9/suspend", {})
    assert calls[0] == ("reject", "C9", {"reason": "bad"})
    assert calls[1] == ("suspend", "C9")


def test_dispatch_admin_requires_admins_group(monkeypatch):
    # A non-admin must get 403 and NO admin handler may fire (gate before action).
    calls = _patch_admin_calls(monkeypatch)
    resp = app.dispatch_admin({"sub": "u1", "cognito:groups": ["collectors"]},
                              "/admin/collectors/C1/approve", {})
    assert _status_of(resp) == 403
    assert calls == []


def test_dispatch_admin_unknown_action_is_400_before_group_check(monkeypatch):
    # An unsupported trailing action is rejected 400 and never reaches a handler.
    calls = _patch_admin_calls(monkeypatch)
    resp = app.dispatch_admin({"sub": "a1", "cognito:groups": ["admins"]},
                              "/admin/collectors/C1/delete", {})
    assert _status_of(resp) == 400
    assert calls == []


def test_dispatch_admin_malformed_path_is_400(monkeypatch):
    # Too few path segments -> unsupported route, no crash.
    _patch_admin_calls(monkeypatch)
    resp = app.dispatch_admin({"sub": "a1", "cognito:groups": ["admins"]},
                              "/admin/collectors", {})
    assert _status_of(resp) == 400


# ===================== Collector upload-url content-type gate (NIT#5) ========

def test_upload_url_rejects_bad_doc_type(monkeypatch):
    monkeypatch.setattr(app, "collectors_table", object())
    monkeypatch.setattr(app, "COLLECTOR_DOCS_BUCKET", "bucket")
    resp = app.collector_upload_url({"sub": "u1"},
                                    {"docType": "passport", "contentType": "image/png"})
    assert _status_of(resp) == 400


def test_upload_url_rejects_content_type_outside_allowlist(monkeypatch):
    monkeypatch.setattr(app, "collectors_table", object())
    monkeypatch.setattr(app, "COLLECTOR_DOCS_BUCKET", "bucket")
    for bad in ("image/gif", "application/zip", "text/html", ""):
        resp = app.collector_upload_url({"sub": "u1"},
                                        {"docType": "license", "contentType": bad})
        assert _status_of(resp) == 400


def test_upload_url_allowlist_matches_expected_set():
    # Lock the exact allow-list so a future edit can't silently widen it.
    assert app.UPLOAD_CONTENT_TYPES == {"image/png", "image/jpeg", "application/pdf"}


def test_upload_url_service_unavailable_without_bucket(monkeypatch):
    # Missing bucket env var -> 503, never a crash on first use.
    monkeypatch.setattr(app, "collectors_table", object())
    monkeypatch.setattr(app, "COLLECTOR_DOCS_BUCKET", "")
    resp = app.collector_upload_url({"sub": "u1"},
                                    {"docType": "license", "contentType": "application/pdf"})
    assert _status_of(resp) == 503


# ===================== Duplicate-quote scan (request_collect step 8) =========

def test_request_collect_duplicate_live_quote_paid_409(monkeypatch):
    # A second live quote by the SAME collector on a paid item is a 409, even
    # for an approved collector with a valid amount.
    cap = _setup_request_collect(monkeypatch,
                                 _open_waste("user_pays", max_price="50.00"),
                                 approved=True)

    def _query(**k):
        return {"Items": [{"collectorId": "col-9", "status": "accepted"}]}
    cap.query = _query
    resp = app.request_collect({"sub": "col-9"},
                               {"wasteId": "w1", "quoteAmount": "10.00"})
    assert _status_of(resp) == 409


def test_request_collect_other_collectors_quote_not_a_duplicate(monkeypatch):
    # A live quote by a DIFFERENT collector must NOT block this collector.
    cap = _setup_request_collect(monkeypatch,
                                 _open_waste("user_pays", max_price="50.00"),
                                 approved=True)

    def _query(**k):
        return {"Items": [{"collectorId": "someone-else", "status": "requested"}]}
    cap.query = _query
    resp = app.request_collect({"sub": "col-9"},
                               {"wasteId": "w1", "quoteAmount": "10.00"})
    assert isinstance(resp, dict)
    assert _status_of(resp) == 200


def test_request_collect_terminal_quote_not_a_duplicate(monkeypatch):
    # A prior quote by the same collector that is NOT in LIVE_QUOTE_STATUSES
    # (e.g. 'rejected'/'cancelled') must not block a fresh quote.
    cap = _setup_request_collect(monkeypatch,
                                 _open_waste("user_pays", max_price="50.00"),
                                 approved=True)

    def _query(**k):
        return {"Items": [{"collectorId": "col-9", "status": "rejected"}]}
    cap.query = _query
    resp = app.request_collect({"sub": "col-9"},
                               {"wasteId": "w1", "quoteAmount": "10.00"})
    assert isinstance(resp, dict)
    assert _status_of(resp) == 200


# ===================== Unlock-status single source of truth ==================

def test_unlock_and_chat_statuses_are_identical_and_exclude_collecting():
    # Invariant (a): no contact/chat before 'confirmed'. 'collecting' is a
    # WASTE-ITEM status and must never appear in the unlock/chat tuples.
    assert app.UNLOCK_STATUSES == app.CHAT_STATUSES
    assert app.UNLOCK_STATUSES == ("confirmed", "collected", "disputed")
    assert "collecting" not in app.UNLOCK_STATUSES
    assert "requested" not in app.UNLOCK_STATUSES
    assert "accepted" not in app.UNLOCK_STATUSES


# ===================== mark_done idempotency / guard (point 2) ================
# mark_done touches creq_table/table (DynamoDB) and notify. We fake those module
# globals so the pure guard + transition logic runs offline, and count how many
# update_item / notify calls happen for each starting status.

class _RecordTable:
    """Records update_item calls so a transition can be asserted/counted."""
    def __init__(self):
        self.updates = []

    def update_item(self, **k):
        self.updates.append(k)


def _setup_mark_done(monkeypatch, cr):
    """Wire mark_done's module globals to fakes around a crafted collect-request.
    Returns (creq_fake, waste_fake, notify_calls)."""
    creq = _RecordTable()
    waste = _RecordTable()
    notify_calls = []
    monkeypatch.setattr(app, "creq_table", creq)
    monkeypatch.setattr(app, "table", waste)
    monkeypatch.setattr(app, "_get_creq", lambda cid: cr)
    monkeypatch.setattr(app, "notify",
                        lambda *a, **k: notify_calls.append(a))
    monkeypatch.setattr(app, "time",
                        types_simplenamespace_time())
    return creq, waste, notify_calls


def types_simplenamespace_time():
    import types as _t
    return _t.SimpleNamespace(time=lambda: 1700000000)


def _confirmed_cr():
    return {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "owner-1",
            "collectorId": "col-1", "status": "confirmed", "wasteType": "Bottles"}


def test_mark_done_confirmed_transitions_and_notifies(monkeypatch):
    cr = _confirmed_cr()
    creq, waste, notify_calls = _setup_mark_done(monkeypatch, cr)
    resp = app.mark_done({"sub": "owner-1"}, {"collectRequestId": "c1"})
    # Success returns a _creq_view dict (not a Response), now 'collected'.
    assert isinstance(resp, dict)
    assert resp["status"] == "collected"
    # Collect-request + waste item were each updated once.
    assert len(creq.updates) == 1
    assert len(waste.updates) == 1
    # notify fired for BOTH owner and collector.
    assert len(notify_calls) == 2


def test_mark_done_already_collected_is_idempotent_noop(monkeypatch):
    cr = _confirmed_cr()
    cr["status"] = "collected"
    creq, waste, notify_calls = _setup_mark_done(monkeypatch, cr)
    resp = app.mark_done({"sub": "col-1"}, {"collectRequestId": "c1"})
    # Returns the current view as success (NOT a 400 Response).
    assert isinstance(resp, dict)
    assert resp["status"] == "collected"
    # No re-write and no duplicate "Collection completed" notification.
    assert creq.updates == []
    assert waste.updates == []
    assert notify_calls == []


def test_mark_done_wrong_state_is_400(monkeypatch):
    for bad in ("requested", "accepted", "cancelled", "rejected", "closed"):
        cr = _confirmed_cr()
        cr["status"] = bad
        creq, waste, notify_calls = _setup_mark_done(monkeypatch, cr)
        resp = app.mark_done({"sub": "owner-1"}, {"collectRequestId": "c1"})
        assert _status_of(resp) == 400
        # No state change on a wrong-state call.
        assert creq.updates == []
        assert waste.updates == []
        assert notify_calls == []


def test_mark_done_disputed_is_400_not_noop(monkeypatch):
    # 'disputed' is terminal-but-not-collected: it must still 400, never silently
    # succeed, and never transition or notify.
    cr = _confirmed_cr()
    cr["status"] = "disputed"
    creq, waste, notify_calls = _setup_mark_done(monkeypatch, cr)
    resp = app.mark_done({"sub": "owner-1"}, {"collectRequestId": "c1"})
    assert _status_of(resp) == 400
    assert creq.updates == [] and waste.updates == [] and notify_calls == []


def test_mark_done_rejects_non_party_403(monkeypatch):
    # Authorization UNCHANGED: only owner or collector may mark done.
    cr = _confirmed_cr()
    creq, waste, notify_calls = _setup_mark_done(monkeypatch, cr)
    resp = app.mark_done({"sub": "stranger"}, {"collectRequestId": "c1"})
    assert _status_of(resp) == 403
    assert creq.updates == [] and waste.updates == [] and notify_calls == []
