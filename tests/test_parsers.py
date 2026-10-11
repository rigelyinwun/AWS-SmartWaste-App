"""Unit tests for the JSON parsers in waste_details and environmental_impact."""
import importlib.util
import os

HERE = os.path.dirname(__file__)


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


waste = _load(os.path.join(HERE, "..", "lambdas", "waste_details", "app.py"), "wd_app")
env = _load(os.path.join(HERE, "..", "lambdas", "environmental_impact", "app.py"), "env_app")


# --- waste_details.parse_details_json ---
def test_parse_details_clean_json():
    raw = ('{"category":"Plastic","confidence_level":"High","description":"bottle",'
           '"estimated_weight":"50g","recyclability":"Fully Recyclable",'
           '"material_composition":"PET"}')
    out = waste.parse_details_json(raw)
    assert out["category"] == "Plastic"
    assert out["estimated_weight"] == "50g"


def test_parse_details_strips_code_fence():
    raw = '```json\n{"category":"Metal"}\n```'
    out = waste.parse_details_json(raw)
    assert out["category"] == "Metal"
    # Missing keys filled with N/A
    assert out["recyclability"] == "N/A"


def test_parse_details_garbage_returns_all_na():
    out = waste.parse_details_json("not json at all")
    assert out["category"] == "N/A"
    assert set(out.keys()) == set(waste.DETAIL_FIELDS)


def test_parse_details_extracts_embedded_object():
    raw = 'Here you go: {"category":"Glass"} thanks'
    out = waste.parse_details_json(raw)
    assert out["category"] == "Glass"


# --- environmental_impact.normalize_impact ---
def test_normalize_impact_full():
    raw = ('{"waste_identification":{"item_type":"bottle","material":"PET",'
           '"hazard_level":"Low"},"estimated_decomposition_time":"450 years",'
           '"landfill_percentage":60,"landfill_percentage_note":"n",'
           '"land_impact":{"summary":"s","details":["a","b"]}}')
    out = env.normalize_impact(raw)
    assert out["waste_identification"]["item_type"] == "bottle"
    assert out["landfill_percentage"] == 60
    assert out["land_impact"]["summary"] == "s"
    assert out["land_impact"]["details"] == ["a", "b"]
    # All impact sections present even if absent in input
    for key in env.IMPACT_SECTIONS:
        assert key in out


def test_normalize_impact_clamps_percentage():
    out = env.normalize_impact('{"landfill_percentage": 250}')
    assert out["landfill_percentage"] == 100
    out2 = env.normalize_impact('{"landfill_percentage": -5}')
    assert out2["landfill_percentage"] == 0


def test_normalize_impact_bad_percentage_is_none():
    out = env.normalize_impact('{"landfill_percentage": "lots"}')
    assert out["landfill_percentage"] is None


def test_normalize_impact_details_string_coerced_to_list():
    out = env.normalize_impact('{"water_impact":{"summary":"x","details":"single"}}')
    assert out["water_impact"]["details"] == ["single"]


def test_normalize_impact_garbage():
    out = env.normalize_impact("nonsense")
    assert out["estimated_decomposition_time"] == "N/A"
    assert out["waste_identification"]["item_type"] == "N/A"
