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
