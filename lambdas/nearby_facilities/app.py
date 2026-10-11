import json
import logging
import math
import os
import traceback
import urllib.parse
import boto3
from flask import Flask, request, Response

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)

REGION = "ap-southeast-1"
# The standalone geo-places API is not offered in every region (notably not in
# ap-southeast-1). Call it in a supported region — the place database is global,
# so Malaysian results are identical. Override with GEO_PLACES_REGION if needed.
GEO_PLACES_REGION = os.environ.get("GEO_PLACES_REGION", "us-east-1")

bedrock = boto3.client("bedrock-runtime", region_name=REGION)
# New standalone Amazon Location Places API (managed provider, no place index).
geo_places = boto3.client("geo-places", region_name=GEO_PLACES_REGION)

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

# Default map center + common Malaysian recycling centers used when the user
# gives no location, geocoding fails, or no POIs are found nearby.
DEFAULT_CENTER = {"lat": 3.139, "lng": 101.6869, "label": "Kuala Lumpur, Malaysia"}

# Fallback stations use publicly listed general enquiry lines (not facility-
# specific direct numbers), flagged with general_line so the UI can note it.
MALAYSIA_FALLBACK = [
    {"name": "Alam Flora Recycling Center (Kuala Lumpur)", "address": "Kuala Lumpur",
     "lat": 3.1570, "lng": 101.7120, "email": "customercare@alamflora.com.my",
     "phone": "+1800883728", "general_line": True, "facilityType": "recycling_center"},
    {"name": "KLCC Recycling Collection Point", "address": "Jalan Ampang, Kuala Lumpur",
     "lat": 3.1578, "lng": 101.7118, "email": "", "phone": "+60321622723",
     "general_line": True, "facilityType": "recycling_center"},
    {"name": "Petaling Jaya Community Recycling Center", "address": "Petaling Jaya, Selangor",
     "lat": 3.1073, "lng": 101.6067, "email": "", "phone": "+60379565000",
     "general_line": True, "facilityType": "recycling_center"},
    {"name": "SWM Environment Collection (Shah Alam)", "address": "Shah Alam, Selangor",
     "lat": 3.0733, "lng": 101.5185, "email": "", "phone": "+60355225888",
     "general_line": True, "facilityType": "collect_company"},
    {"name": "Cheras Waste Transfer Station", "address": "Cheras, Kuala Lumpur",
     "lat": 3.0890, "lng": 101.7470, "email": "", "phone": "",
     "general_line": False, "facilityType": "disposal_station"},
]

# POI search queries, each tagged with the facility type it tends to surface.
POI_QUERIES = [
    ("recycling center", "recycling_center"),
    ("recycling collection point", "recycling_center"),
    ("waste disposal facility", "disposal_station"),
    ("waste transfer station", "disposal_station"),
    ("waste collection company", "collect_company"),
    ("scrap metal dealer", "collect_company"),
]

# Keyword hints to refine the facility type from the place name.
TYPE_KEYWORDS = [
    ("collect_company", ["sdn bhd", "company", "enterprise", "scrap", "trading", "dealer", "logistics"]),
    ("disposal_station", ["transfer station", "disposal", "landfill", "dump", "incinerat"]),
    ("recycling_center", ["recycle", "recycling", "collection point", "buy back", "buyback", "tzu chi"]),
]


def classify_facility(name, query_type):
    """Pick a facility type from name keywords, falling back to the query type."""
    low = (name or "").lower()
    for ftype, words in TYPE_KEYWORDS:
        for w in words:
            if w in low:
                return ftype
    return query_type


def haversine_km(lat1, lng1, lat2, lng2):
    """Great-circle distance between two points in kilometers."""
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def format_distance(km):
    if km is None:
        return "Unavailable"
    if km < 1:
        return str(int(round(km * 1000))) + " m"
    return "{:.1f} km".format(km)


def _item_position(item):
    """Extract [lng, lat] from a geo-places ResultItem, trying common fields."""
    pos = item.get("Position")
    if (not pos) and isinstance(item.get("Place"), dict):
        pos = item["Place"].get("Position")
    if pos and len(pos) >= 2:
        return pos[0], pos[1]  # lng, lat
    return None


def _item_label(item):
    addr = item.get("Address")
    if isinstance(addr, dict) and addr.get("Label"):
        return addr["Label"].strip()
    return (item.get("Title") or "").strip()


def _item_contacts(item):
    """Pull a phone and email from a geo-places item's Contacts block, if any.
    Contacts.Phones / Contacts.Emails are lists of {Value: ...}. Returns
    (email, phone) with empty strings when not present."""
    contacts = item.get("Contacts")
    email, phone = "", ""
    if isinstance(contacts, dict):
        phones = contacts.get("Phones")
        if isinstance(phones, list) and phones:
            phone = str(phones[0].get("Value") or "").strip()
        emails = contacts.get("Emails")
        if isinstance(emails, list) and emails:
            email = str(emails[0].get("Value") or "").strip()
    return email, phone


def _geocode_once(query):
    """One geocode attempt. Returns (lat,lng,label) or None."""
    try:
        resp = geo_places.geocode(
            QueryText=query,
            MaxResults=1,
            Filter={"IncludeCountries": ["MYS"]},
        )
        logger.info("geocode raw response for %r: %s", query, json.dumps(resp, default=str)[:2000])
        items = resp.get("ResultItems", [])
        if items:
            pos = _item_position(items[0])
            if pos:
                lng, lat = pos
                return (lat, lng, _item_label(items[0]) or query)
    except Exception as e:
        logger.error("Geocode error for %r: %s", query, str(e))
    return None


def _search_text_once(query):
    """Fuzzy place/POI lookup fallback. Returns (lat,lng,label) or None."""
    try:
        resp = geo_places.search_text(
            QueryText=query,
            MaxResults=1,
            Filter={"IncludeCountries": ["MYS"]},
        )
        logger.info("search_text(geocode) raw response for %r: %s", query, json.dumps(resp, default=str)[:2000])
        items = resp.get("ResultItems", [])
        if items:
            pos = _item_position(items[0])
            if pos:
                lng, lat = pos
                return (lat, lng, _item_label(items[0]) or query)
    except Exception as e:
        logger.error("search_text geocode error for %r: %s", query, str(e))
    return None


def geocode(location_text):
    """Resolve free-form location text to coordinates + a readable label.
    Tries, in order: geocode as-is, geocode with ', Malaysia' appended, then
    a fuzzy search_text lookup (better for neighborhood/POI names like
    'Desa Park City'). Biased to Malaysia. Returns (lat, lng, label) or None."""
    candidates = [location_text]
    if "malaysia" not in location_text.lower():
        candidates.append(location_text + ", Malaysia")

    for q in candidates:
        hit = _geocode_once(q)
        if hit:
            return hit

    # Fuzzy fallback — resolves place/POI names that strict geocoding misses.
    for q in candidates:
        hit = _search_text_once(q)
        if hit:
            return hit

    return None


def search_pois(lat, lng):
    """Search for waste/recycling POIs biased to the given coordinates.
    Returns a list of raw facility dicts (name/address/lat/lng), de-duplicated."""
    found = {}
    for query, query_type in POI_QUERIES:
        try:
            resp = geo_places.search_text(
                QueryText=query,
                BiasPosition=[lng, lat],  # [lng, lat]
                MaxResults=4,
                AdditionalFeatures=["Contact"],
                Filter={"IncludeCountries": ["MYS"]},
            )
            logger.info("search_text raw response for %r: %s", query, json.dumps(resp, default=str)[:2000])
        except Exception as e:
            logger.error("POI search error for '%s': %s", query, str(e))
            continue

        for item in resp.get("ResultItems", []):
            pos = _item_position(item)
            if not pos:
                continue
            p_lng, p_lat = pos
            name = (item.get("Title") or "").strip() or "Facility"
            # Dedupe by rounded coordinate.
            key = (round(p_lat, 5), round(p_lng, 5))
            if key in found:
                continue
            email, phone = _item_contacts(item)
            found[key] = {
                "name": name,
                "address": _item_label(item),
                "lat": p_lat,
                "lng": p_lng,
                "email": email,
                "phone": phone,
                "facilityType": classify_facility(name, query_type),
            }

    facilities = list(found.values())
    # Sort by distance to the search center and keep the closest 6.
    for f in facilities:
        f["_dist_km"] = haversine_km(lat, lng, f["lat"], f["lng"])
    facilities.sort(key=lambda f: f["_dist_km"])
    return facilities[:6]


def enrich_waste_types(item_description, facility_names):
    """Ask Bedrock which waste categories each named facility likely accepts,
    tailored to the analyzed item. Returns {facility_name: [types]}."""
    if not facility_names:
        return {}

    system = (
        "You assign likely accepted waste categories to recycling/disposal "
        "facilities. Respond with ONLY a JSON object mapping each facility name "
        "to an array of 1-4 waste category strings (e.g. Plastic, Paper, Metal, "
        "Glass, E-waste, Organic, Hazardous). No markdown, no commentary."
    )
    user = (
        "Analyzed waste item: " + (item_description or "general household waste") +
        "\n\nFacilities:\n" + "\n".join("- " + n for n in facility_names) +
        "\n\nReturn JSON like {\"Facility Name\": [\"Plastic\", \"Metal\"]}."
    )
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "temperature": 0,
        "system": system,
        "messages": [{"role": "user", "content": [{"type": "text", "text": user}]}],
    }
    try:
        resp = bedrock.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        result = json.loads(resp["body"].read())
        text = result.get("content", [{}])[0].get("text", "").strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1:
            mapping = json.loads(text[start:end + 1])
            if isinstance(mapping, dict):
                clean = {}
                for k, v in mapping.items():
                    if isinstance(v, list):
                        clean[k] = [str(x).strip() for x in v if str(x).strip()]
                return clean
    except Exception as e:
        logger.error("Waste-type enrichment error: %s", str(e))
    return {}


# Curated allowlist of real platforms with search-URL templates ({q} = url-encoded
# query). Building search URLs (not deep links) guarantees every link resolves to
# live listings on a real domain — "Google-search valid".
TRADING_PLATFORMS = {
    "carousell": {"name": "Carousell", "type": "Marketplace",
                  "tmpl": "https://www.carousell.com.my/search/{q}"},
    "facebook": {"name": "Facebook Marketplace", "type": "Social Media",
                 "tmpl": "https://www.facebook.com/marketplace/search/?query={q}"},
    "mudah": {"name": "Mudah.my", "type": "Marketplace",
              "tmpl": "https://www.mudah.my/malaysia/all?q={q}"},
    "shopee": {"name": "Shopee", "type": "Marketplace",
               "tmpl": "https://shopee.com.my/search?keyword={q}"},
    "lazada": {"name": "Lazada", "type": "Marketplace",
               "tmpl": "https://www.lazada.com.my/catalog/?q={q}"},
    "ebay": {"name": "eBay", "type": "Marketplace",
             "tmpl": "https://www.ebay.com/sch/i.html?_nkw={q}"},
    "lelong": {"name": "Lelong.my", "type": "Marketplace",
               "tmpl": "https://www.lelong.com.my/catalog/all/list?TheKeyword={q}"},
    "freecycle": {"name": "Freecycle", "type": "Donation",
                  "tmpl": "https://www.freecycle.org/search?query={q}"},
    "reddit": {"name": "Reddit (r/malaysia, hobby subs)", "type": "Social Media",
               "tmpl": "https://www.reddit.com/search/?q={q}"},
    "google_shopping": {"name": "Google (shopping & local)", "type": "Specialist",
                        "tmpl": "https://www.google.com/search?q={q}"},
}

DEFAULT_PLATFORM_KEYS = ["carousell", "facebook", "mudah", "shopee", "ebay"]


def _pick_platforms_and_terms(item_description):
    """Ask Bedrock which allowlisted platforms fit the item and for multilingual
    search terms (English, Chinese, Malay). Returns (platform_keys, terms_dict)."""
    keys = list(TRADING_PLATFORMS.keys())
    system = (
        "You help resell/donate/trade a second-hand item online in Malaysia. "
        "Respond with ONLY a JSON object (no markdown): "
        '{"platforms": [keys...], "terms": {"en": "...", "zh": "...", "ms": "..."}}. '
        "Choose 3-5 platform keys ONLY from this exact list: " + ", ".join(keys) + ". "
        "Pick the ones most suitable for this item (specialist/hobby items favor "
        "Facebook, eBay, Reddit; common goods favor Carousell, Mudah, Shopee). "
        "'terms' are concise search phrases for the item in English (en), "
        "Simplified Chinese (zh), and Malay (ms) — e.g. for vinyl records: "
        '"vinyl records", "黑胶唱片", "rekod vinil".'
    )
    user = "Item: " + (item_description or "general reusable household item")
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 512,
        "temperature": 0.2,
        "system": system,
        "messages": [{"role": "user", "content": [{"type": "text", "text": user}]}],
    }
    try:
        resp = bedrock.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        result = json.loads(resp["body"].read())
        text = result.get("content", [{}])[0].get("text", "").strip()
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1:
            obj = json.loads(text[start:end + 1])
            chosen = [k for k in (obj.get("platforms") or []) if k in TRADING_PLATFORMS]
            terms = obj.get("terms") or {}
            terms = {
                "en": str(terms.get("en") or "").strip(),
                "zh": str(terms.get("zh") or "").strip(),
                "ms": str(terms.get("ms") or "").strip(),
            }
            if chosen and (terms["en"] or terms["zh"] or terms["ms"]):
                return chosen[:5], terms
    except Exception as e:
        logger.error("Platform/terms selection error: %s", str(e))
    # Fallback: default platforms, English term from the description.
    return DEFAULT_PLATFORM_KEYS, {"en": (item_description or "").strip(), "zh": "", "ms": ""}


def generate_trading_platforms(item_description):
    """Build reliable second-hand trading links: real platforms (allowlist) with
    multilingual search URLs. Returns [{name, type, queries:[{lang,term,url}]}]."""
    keys, terms = _pick_platforms_and_terms(item_description)
    lang_labels = {"en": "EN", "zh": "中文", "ms": "BM"}
    # Keep languages that produced a term; always ensure at least English.
    active_terms = [(lang, terms[lang]) for lang in ("en", "zh", "ms") if terms.get(lang)]
    if not active_terms:
        active_terms = [("en", (item_description or "second hand item").strip())]

    out = []
    for key in keys:
        p = TRADING_PLATFORMS.get(key)
        if not p:
            continue
        queries = []
        for lang, term in active_terms:
            url = p["tmpl"].replace("{q}", urllib.parse.quote(term))
            queries.append({"lang": lang_labels.get(lang, lang), "term": term, "url": url})
        out.append({"name": p["name"], "type": p["type"], "queries": queries})
    return out


def build_fallback(item_description, reason="no_location", center=None):
    """Common Malaysian recycling centers used when we can't locate the user.
    'reason' explains why the fallback was used so the UI can message correctly:
      - 'no_location'   : the user did not provide a location
      - 'geocode_failed': a location was given but could not be geocoded
      - 'no_results'    : location geocoded, but no nearby facilities were found
    """
    names = [f["name"] for f in MALAYSIA_FALLBACK]
    type_map = enrich_waste_types(item_description, names)
    facilities = []
    for f in MALAYSIA_FALLBACK:
        facilities.append({
            "name": f["name"],
            "waste_types": type_map.get(f["name"]) or ["Plastic", "Paper", "Metal"],
            "distance": "Unavailable",
            "address": f["address"],
            "lat": f["lat"],
            "lng": f["lng"],
            "email": f.get("email", ""),
            "phone": f.get("phone", ""),
            "general_line": bool(f.get("general_line") and f.get("phone")),
            "facilityType": f.get("facilityType", "recycling_center"),
        })
    return {
        "center": center or DEFAULT_CENTER,
        "location_provided": False,
        "fallback_reason": reason,
        "facilities": facilities,
        "trading_platforms": generate_trading_platforms(item_description),
    }


@app.route("/", methods=["POST", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["POST", "OPTIONS"])
def analyze(path):
    if request.method == "OPTIONS":
        return Response("", status=200)

    try:
        data = request.get_json(force=True)
        logger.info("Request received, keys: %s", list(data.keys()))
        description = (data.get("description") or "").strip()
        location_text = (data.get("location") or "").strip()

        # No location -> Malaysia fallback.
        if not location_text:
            payload = build_fallback(description, reason="no_location")
            return Response(json.dumps(payload), content_type="application/json; charset=utf-8")

        # Geocode the user's location.
        geo = geocode(location_text)
        if not geo:
            logger.info("Geocoding failed for '%s'; using fallback", location_text)
            payload = build_fallback(description, reason="geocode_failed")
            return Response(json.dumps(payload), content_type="application/json; charset=utf-8")

        lat, lng, label = geo

        # Search for real POIs near the user.
        pois = search_pois(lat, lng)
        if not pois:
            logger.info("No POIs found near '%s'; using fallback", location_text)
            # We DID locate the user — center the fallback map on them.
            payload = build_fallback(
                description, reason="no_results",
                center={"lat": lat, "lng": lng, "label": label},
            )
            return Response(json.dumps(payload), content_type="application/json; charset=utf-8")

        # Enrich with accepted waste types via Bedrock.
        type_map = enrich_waste_types(description, [p["name"] for p in pois])

        facilities = []
        for p in pois:
            facilities.append({
                "name": p["name"],
                "waste_types": type_map.get(p["name"]) or ["General"],
                "distance": format_distance(p.get("_dist_km")),
                "address": p["address"],
                "lat": p["lat"],
                "lng": p["lng"],
                "email": p.get("email", ""),
                "phone": p.get("phone", ""),
                "general_line": False,
                "facilityType": p.get("facilityType", "recycling_center"),
            })

        payload = {
            "center": {"lat": lat, "lng": lng, "label": label},
            "location_provided": True,
            "facilities": facilities,
            "trading_platforms": generate_trading_platforms(description),
        }
        return Response(json.dumps(payload), content_type="application/json; charset=utf-8")

    except Exception as e:
        logger.error("Error in analyze: %s", traceback.format_exc())
        return Response(f"Error: {str(e)}", status=500, content_type="text/plain")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
