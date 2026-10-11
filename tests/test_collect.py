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


def test_creq_view_unlocks_when_approved():
    cr = {"collectRequestId": "c1", "wasteId": "w1", "ownerId": "o",
          "collectorId": "k", "status": "approved"}
    waste = {"fullAddress": "123 St", "phone": "+60", "pickupTime": "9am", "notes": "lobby"}
    v = app._creq_view(cr, waste)
    assert v["unlocked"] is True
    assert v["fullAddress"] == "123 St"
    assert v["ownerPhone"] == "+60"


# --- _json_default (Decimal serialization) ---
def test_json_default_decimal():
    from decimal import Decimal
    assert app._json_default(Decimal("5")) == 5
    assert app._json_default(Decimal("1.5")) == 1.5
