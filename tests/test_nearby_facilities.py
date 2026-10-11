"""Unit tests for pure logic in lambdas/nearby_facilities/app.py."""
import importlib.util
import os

HERE = os.path.dirname(__file__)
NEARBY = os.path.join(HERE, "..", "lambdas", "nearby_facilities", "app.py")


def _load():
    spec = importlib.util.spec_from_file_location("nearby_app", NEARBY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


app = _load()


# --- classify_facility ---
def test_classify_by_name_keyword_company():
    assert app.classify_facility("Metal Collect Sdn Bhd", "recycling_center") == "collect_company"


def test_classify_by_name_keyword_disposal():
    assert app.classify_facility("Cheras Waste Transfer Station", "recycling_center") == "disposal_station"


def test_classify_falls_back_to_query_type():
    assert app.classify_facility("Green Point", "recycling_center") == "recycling_center"


# --- _item_position ---
def test_item_position_top_level():
    assert app._item_position({"Position": [101.6, 3.1]}) == (101.6, 3.1)


def test_item_position_nested_place():
    assert app._item_position({"Place": {"Position": [10.0, 20.0]}}) == (10.0, 20.0)


def test_item_position_missing():
    assert app._item_position({}) is None


# --- _item_label ---
def test_item_label_prefers_address():
    item = {"Address": {"Label": "123 Road, KL"}, "Title": "Shop"}
    assert app._item_label(item) == "123 Road, KL"


def test_item_label_falls_back_to_title():
    assert app._item_label({"Title": "Shop"}) == "Shop"


# --- format_distance ---
def test_format_distance():
    assert app.format_distance(None) == "Unavailable"
    assert app.format_distance(2.0) == "2.0 km"


# --- _google_url encodes once ---
def test_google_url_encodes_spaces():
    url = app._google_url("used clothes")
    assert url.startswith("https://www.google.com/search?q=")
    assert "used%20clothes" in url or "used+clothes" in url
