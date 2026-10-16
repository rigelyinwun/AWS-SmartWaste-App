import base64
import json
import logging
import os
import re
import secrets
import time
import traceback
import urllib.request
import uuid
from decimal import Decimal

import boto3
import jwt
from jwt import PyJWKClient
from boto3.dynamodb.conditions import Key
from flask import Flask, request, Response

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)

REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
REQUESTS_TABLE = os.environ.get("WASTE_REQUESTS_TABLE", "")
COLLECT_REQUESTS_TABLE = os.environ.get("COLLECT_REQUESTS_TABLE", "")
NOTIFICATIONS_TABLE = os.environ.get("NOTIFICATIONS_TABLE", "")
USERS_TABLE = os.environ.get("USERS_TABLE", "")
USER_POOL_ID = os.environ.get("USER_POOL_ID", "")
APP_CLIENT_ID = os.environ.get("APP_CLIENT_ID", "")

MESSAGES_TABLE = os.environ.get("MESSAGES_TABLE", "")
APPSYNC_HTTP_DNS = os.environ.get("APPSYNC_HTTP_DNS", "")
APPSYNC_API_KEY = os.environ.get("APPSYNC_API_KEY", "")
PUSH_SUBS_TABLE = os.environ.get("PUSH_SUBS_TABLE", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@smartwaste.example")

dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(REQUESTS_TABLE) if REQUESTS_TABLE else None
creq_table = dynamodb.Table(COLLECT_REQUESTS_TABLE) if COLLECT_REQUESTS_TABLE else None
notif_table = dynamodb.Table(NOTIFICATIONS_TABLE) if NOTIFICATIONS_TABLE else None
users_table = dynamodb.Table(USERS_TABLE) if USERS_TABLE else None
msg_table = dynamodb.Table(MESSAGES_TABLE) if MESSAGES_TABLE else None
push_table = dynamodb.Table(PUSH_SUBS_TABLE) if PUSH_SUBS_TABLE else None

# Bedrock is used to re-validate the uploaded image server-side before an item
# is listed publicly (so a client bypassing the browser can't post junk).
bedrock = boto3.client("bedrock-runtime", region_name=REGION)
VALIDATION_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
VALIDATION_PROMPT = """You are a strict content validator for a waste disposal app. Look at this image and the description text carefully.

Reply with ONLY the word "VALID" or "INVALID":

Reply "VALID" ONLY if ALL of these are true:
1. The image shows a REAL PHYSICAL object that exists in the real world (not a digital image, screenshot, icon, logo, meme, drawing, or digital graphic)
2. The object could reasonably be disposed of as waste or recycled
3. The description (if provided) is not offensive, hateful, violent, or inappropriate

Reply "INVALID" if ANY of these are true:
1. The image is a screenshot, digital graphic, icon, logo, meme, cartoon, or drawing
2. The image shows people (selfies, portraits), violence, sexual content, or offensive material
3. The image is completely unrelated to physical waste items
4. The description contains offensive, hateful, violent, inappropriate, or vulgar language
5. The image is of a landscape, building, or scene with no identifiable waste item

You MUST reply with ONLY one word: VALID or INVALID. No explanation."""


def validate_image(file_data, file_mime, description):
    """Server-side re-validation of the uploaded image before listing.
    Returns True only if the model clearly says VALID. Fails closed on error."""
    if not file_data or not file_mime or not str(file_mime).startswith("image/"):
        # No usable image to validate — reject (listing requires a valid item).
        return False
    content = [{
        "type": "image",
        "source": {"type": "base64", "media_type": file_mime, "data": file_data},
    }]
    if description:
        content.append({"type": "text", "text": "Description: " + str(description)[:500]})
    content.append({"type": "text", "text": VALIDATION_PROMPT})
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 10,
        "temperature": 0,
        "messages": [{"role": "user", "content": content}],
    }
    try:
        resp = bedrock.invoke_model(
            modelId=VALIDATION_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        result = json.loads(resp["body"].read())
        reply = result.get("content", [{}])[0].get("text", "").strip().upper()
        logger.info("Report image validation: %s", reply)
        return "VALID" in reply and "INVALID" not in reply
    except Exception as e:
        logger.error("Report image validation error: %s", str(e))
        return False  # fail closed

ISSUER = "https://cognito-idp.{}.amazonaws.com/{}".format(REGION, USER_POOL_ID)
JWKS_URL = ISSUER + "/.well-known/jwks.json"

_jwk_client = None


def jwk_client():
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(JWKS_URL)
    return _jwk_client


class AuthError(Exception):
    pass


def verify_token(req):
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise AuthError("Missing bearer token")
    token = header[len("Bearer "):].strip()
    if not token:
        raise AuthError("Empty token")
    try:
        signing_key = jwk_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=APP_CLIENT_ID,
            issuer=ISSUER,
            options={"require": ["exp", "iss", "sub"]},
        )
    except Exception as e:
        logger.warning("Token verification failed: %s", str(e))
        raise AuthError("Invalid token")
    if claims.get("token_use") != "id":
        raise AuthError("Not an ID token")
    return claims


def json_response(payload, status=200):
    return Response(json.dumps(payload, default=_json_default), status=status,
                    content_type="application/json; charset=utf-8")


def _json_default(o):
    if isinstance(o, Decimal):
        # Return int when whole, else float.
        return int(o) if o % 1 == 0 else float(o)
    raise TypeError


def _s(v):
    return str(v).strip() if v is not None else ""


# ------------------- Marketplace status constants (single source of truth) ---
# Contact (fullAddress/phone) unlock and chat are gated on these collect-request
# statuses — the disintermediation invariant lives here. 'confirmed' is the
# earliest unlocking status; 'collected'/'disputed' are post-confirm states.
# NOTE: 'collecting' is a WASTE-ITEM status only — it must NEVER appear in these
# tuples (ignore any historical revision-2 block that showed a 4-element tuple).
UNLOCK_STATUSES = ("confirmed", "collected", "disputed")
CHAT_STATUSES = UNLOCK_STATUSES
# A collector's quote counts as "live" (blocks a duplicate quote) in these.
LIVE_QUOTE_STATUSES = ("requested", "accepted", "confirmed")


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


def _validate_quote(amount, max_price):
    """(ok, error) — amount is the parsed Decimal quote; max_price is Decimal or None."""
    if amount is None or amount <= 0:
        return False, "A quote amount greater than 0 is required"
    if max_price is not None and amount > max_price:
        return False, "Quote exceeds the owner's maximum price"
    return True, None


# ------------------- Collector module scaffolding (Part C) -------------------
# FEAT-003 fills in the collector/admin routes; these two helpers are needed by
# request_collect here. The code imports fine without the env vars (defaults '').
COLLECTORS_TABLE = os.environ.get("COLLECTORS_TABLE", "")
COLLECTOR_DOCS_BUCKET = os.environ.get("COLLECTOR_DOCS_BUCKET", "")
collectors_table = dynamodb.Table(COLLECTORS_TABLE) if COLLECTORS_TABLE else None
s3 = boto3.client("s3", region_name=REGION)
DOC_TYPES = {"registration", "license", "insurance"}

# ------------------- Waste-item photos (public-listing images) --------------
# The uploaded waste image is validated by Bedrock (validate_image) before a
# listing is created; when it passes we also persist the bytes to the private
# CollectorDocsBucket under a "waste/<requestId>" key and serve it back only via
# short-lived presigned GET URLs minted inside these JWT-verified routes. We keep
# a dedicated content-type allow-list (no PDF, unlike collector docs) so widening
# UPLOAD_CONTENT_TYPES can never silently widen what waste photos accept.
WASTE_IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg"}
WASTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024  # ~5 MB cap; dependency-free byte check.
WASTE_IMAGE_URL_EXPIRY = 3600  # presigned GET lifetime (seconds).


def _store_waste_image(request_id, file_data, file_mime):
    """Best-effort store of a validated waste photo in S3; return the object key
    ("waste/<requestId>") on success or None on any skip/failure.

    Never raises: the caller creates the listing regardless. Skips (returns None)
    when the bucket is unconfigured, the mime is outside the allow-list, the body
    is empty/undecodable, or it exceeds WASTE_IMAGE_MAX_BYTES. Only call this
    AFTER validate_image has passed."""
    if not COLLECTOR_DOCS_BUCKET:
        return None
    mime = _s(file_mime)
    if mime not in WASTE_IMAGE_CONTENT_TYPES:
        return None
    if not file_data:
        return None
    try:
        raw = base64.b64decode(file_data, validate=False)
    except Exception as e:
        logger.warning("waste image decode error: %s", str(e))
        return None
    if not raw or len(raw) > WASTE_IMAGE_MAX_BYTES:
        if raw:
            logger.warning("waste image over size cap (%d bytes), skipping store", len(raw))
        return None
    key = "waste/{}".format(request_id)
    try:
        s3.put_object(Bucket=COLLECTOR_DOCS_BUCKET, Key=key, Body=raw, ContentType=mime)
    except Exception as e:
        logger.error("waste image put_object error: %s", str(e))
        return None
    return key


def _get_collector(user_id):
    if not collectors_table:
        return None
    try:
        return collectors_table.get_item(Key={"userId": user_id}).get("Item")
    except Exception as e:
        logger.error("get collector error: %s", str(e))
        return None


def _is_approved_collector(user_id):
    # Fails closed: no record (or any non-approved status) ⇒ not approved.
    c = _get_collector(user_id)
    return bool(c) and c.get("status") == "approved"


# ------------------- Analytics (manual deterministic calc) -------------------
# Static per-waste-type impact factors. Numbers are reasonable, citable
# real-world approximations (not exact for any one jurisdiction):
#   landfill_divert: 0-1 fraction of this material's mass considered diverted
#                    from landfill when collected/recycled.
#   co2e_per_kg:     kg CO2e avoided per kg diverted vs landfilling.
# Sources (approx): US EPA WARM model (recycling vs landfill emission factors)
# and WRAP textile estimates. Values are intentionally conservative blends.
IMPACT_FACTORS = {
    # key:        (landfill_divert, co2e_per_kg)
    "plastic":    (0.90, 1.5),   # EPA WARM: mixed plastics ~1-2 kg CO2e/kg avoided.
    "paper":      (0.85, 0.9),   # EPA WARM: paper/cardboard ~0.8-1.0 kg CO2e/kg.
    "glass":      (0.95, 0.3),   # EPA WARM: glass ~0.3 kg CO2e/kg; inert, divertible.
    "metal":      (0.95, 4.0),   # EPA WARM: aluminium/steel ~4-9 kg CO2e/kg; blended 4.0.
    "organic":    (0.80, 0.5),   # EPA WARM: composting avoids ~0.5 kg CO2e/kg methane.
    "ewaste":     (0.70, 2.0),   # EPA/industry: e-waste recovery ~2 kg CO2e/kg.
    "textile":    (0.75, 3.0),   # WRAP: textile reuse/recycling ~3 kg CO2e/kg.
    "general":    (0.50, 0.6),   # Fallback for mixed/unmatched waste.
}

# Approximate average landfill emission for mixed MSW, used only to normalize
# the climate-saved percentage into a sensible 0-100 band (brief source: EPA
# estimates landfilled mixed waste emits on the order of ~1 kg CO2e/kg over time).
LANDFILL_BASELINE_CO2E_PER_KG = 1.0

# Synonyms -> canonical key. Checked as case-insensitive substring matches.
# Order matters: more specific materials are checked before "plastic" so a
# "glass bottle" / "tin can" resolves to its real material, not plastic.
_CATEGORY_SYNONYMS = [
    (("glass", "jar"), "glass"),
    (("aluminium", "aluminum", "steel", "tin", "can", "metal"), "metal"),
    (("plastic", "pet", "hdpe"), "plastic"),
    (("cardboard", "carton", "paper"), "paper"),
    (("food", "compost", "garden", "organic"), "organic"),
    (("electronic", "electronics", "e-waste", "ewaste", "battery", "device"), "ewaste"),
    (("cloth", "clothing", "fabric", "textile"), "textile"),
]

# Warm-Lambda cache for AI-estimated factors of unknown types (keyed by the
# lowercased raw type string). Pure helpers never populate this.
_ai_factor_cache = {}


def parse_weight_kg(text):
    """Best-effort kilograms from a free-text weight string.

    "2kg"->2.0, "500 g"->0.5, "approx 2 kg"->2.0, ""/junk->1.0 default.
    Pure function (no AWS); robust against missing/absurd values.
    """
    s = _s(text).lower()
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    if not m:
        return 1.0
    try:
        value = float(m.group(0))
    except ValueError:
        return 1.0
    # Determine unit from the text after the matched number.
    tail = s[m.end():]
    if "kg" in tail:
        pass  # already kilograms
    elif re.search(r"\bg\b|gram", tail):
        value = value / 1000.0  # grams -> kg
    # else: no recognizable unit -> assume kilograms.
    if value <= 0:
        return 1.0
    return value


def normalize_category(category, waste_type=""):
    """Map a free-text category (then wasteType) to a canonical IMPACT_FACTORS
    key via case-insensitive substring synonyms. Unmatched -> 'general'. Pure."""
    hay = (_s(category) + " " + _s(waste_type)).lower()
    if not hay.strip():
        return "general"
    for needles, key in _CATEGORY_SYNONYMS:
        for n in needles:
            if n in hay:
                return key
    return "general"


def factor_for(category, waste_type=""):
    """Return (landfill_divert, co2e_per_kg) for an item.

    Known types resolve from the static table synchronously. Only a non-empty
    type that normalizes to 'general' may consult Bedrock as a FALLBACK to
    estimate factors; the result is cached in-process. Any error, unparseable
    reply, or out-of-range value fails CLOSED to the 'general' default. This
    never raises and never runs for known types.
    """
    key = normalize_category(category, waste_type)
    if key != "general":
        return IMPACT_FACTORS[key]

    raw = (_s(category) or _s(waste_type)).lower()
    if not raw:
        return IMPACT_FACTORS["general"]
    if raw in _ai_factor_cache:
        return _ai_factor_cache[raw]

    default = IMPACT_FACTORS["general"]
    try:
        prompt = (
            "You estimate waste recycling impact factors. For the waste type "
            "below, reply with ONLY strict JSON of the form "
            '{"landfill_divert": <0-1>, "co2e_per_kg": <number>} where '
            "landfill_divert is the fraction (0-1) of mass diverted from landfill "
            "when recycled and co2e_per_kg is kg CO2e avoided per kg. No prose.\n"
            "Waste type: " + raw[:80]
        )
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 60,
            "temperature": 0,
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        }
        resp = bedrock.invoke_model(
            modelId=VALIDATION_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        result = json.loads(resp["body"].read())
        reply = result.get("content", [{}])[0].get("text", "")
        match = re.search(r"\{.*\}", reply, re.DOTALL)
        data = json.loads(match.group(0)) if match else {}
        divert = float(data["landfill_divert"])
        co2e = float(data["co2e_per_kg"])
        if not (0.0 <= divert <= 1.0) or co2e < 0:
            raise ValueError("factor out of range")
        parsed = (divert, co2e)
        _ai_factor_cache[raw] = parsed
        return parsed
    except Exception as e:  # fail closed to the general/other default.
        logger.warning("factor_for AI fallback failed for %r: %s", raw, str(e))
        return default


def _item_epoch_seconds(item):
    """Normalize a timestamp to epoch SECONDS. completedAt is seconds; createdAt
    on collect-requests is microseconds (_now_micros). Treat values > 10^12 as
    microseconds."""
    ts = item.get("completedAt")
    if ts is None:
        ts = item.get("createdAt")
    try:
        ts = int(ts)
    except (TypeError, ValueError):
        return None
    if ts > 1_000_000_000_000:  # microseconds -> seconds
        ts = ts // 1_000_000
    return ts


def bucket_timeseries(items):
    """Group items into chronological {label,count,weightKg} points.

    Default monthly (YYYY-MM) buckets; switch to yearly (YYYY) when the span
    exceeds ~18 months. Pure function (uses only item timestamps + weight)."""
    buckets_month = {}
    for it in items:
        ts = _item_epoch_seconds(it)
        if ts is None:
            continue
        tm = time.gmtime(ts)
        label = "%04d-%02d" % (tm.tm_year, tm.tm_mon)
        b = buckets_month.setdefault(label, {"count": 0, "weightKg": 0.0})
        b["count"] += 1
        b["weightKg"] += parse_weight_kg(it.get("weight"))

    if not buckets_month:
        return {"granularity": "month", "points": []}

    labels = sorted(buckets_month.keys())
    # Span in months between earliest and latest bucket.
    def _ym(lbl):
        y, m = lbl.split("-")
        return int(y) * 12 + int(m)
    span_months = _ym(labels[-1]) - _ym(labels[0])

    if span_months > 18:
        buckets_year = {}
        for lbl, b in buckets_month.items():
            yr = lbl.split("-")[0]
            yb = buckets_year.setdefault(yr, {"count": 0, "weightKg": 0.0})
            yb["count"] += b["count"]
            yb["weightKg"] += b["weightKg"]
        points = [
            {"label": yr, "count": buckets_year[yr]["count"],
             "weightKg": round(buckets_year[yr]["weightKg"], 2)}
            for yr in sorted(buckets_year.keys())
        ]
        return {"granularity": "year", "points": points}

    points = [
        {"label": lbl, "count": buckets_month[lbl]["count"],
         "weightKg": round(buckets_month[lbl]["weightKg"], 2)}
        for lbl in labels
    ]
    return {"granularity": "month", "points": points}


def _empty_analytics():
    return {
        "totalCollected": 0,
        "totalWeightKg": 0.0,
        "timeSeries": {"granularity": "month", "points": []},
        "byType": [],
        "landfillSavedPct": 0.0,
        "climateSavedPct": 0.0,
        "co2eSavedKg": 0.0,
        "landfillDivertedKg": 0.0,
    }


def get_analytics(claims):
    """Summarize the current user's COLLECTED outgoing collect-requests.

    Reuses the list_requests collector-index query (read only). Returns the
    all-zero shape on any DynamoDB error rather than a 500 (defensive style)."""
    if not creq_table:
        return _empty_analytics()
    me = claims["sub"]
    try:
        resp = creq_table.query(
            IndexName="collectorIndex",
            KeyConditionExpression=Key("collectorId").eq(me),
            Limit=1000,
        )
        rows = resp.get("Items", [])
    except Exception as e:
        logger.error("get_analytics query error: %s", str(e))
        return _empty_analytics()

    collected = [r for r in rows if r.get("status") == "collected"]
    if not collected:
        return _empty_analytics()

    total_weight = 0.0
    diverted = 0.0        # Σ weight * landfill_divert
    co2e_saved = 0.0      # Σ weight * co2e_per_kg
    by_type = {}          # display label -> {count, weightKg}

    for it in collected:
        w = parse_weight_kg(it.get("weight"))
        divert, co2e = factor_for(it.get("category"), it.get("wasteType"))
        total_weight += w
        diverted += w * divert
        co2e_saved += w * co2e
        # Human-facing label uses the item's category (fallback wasteType).
        label = _s(it.get("category")) or _s(it.get("wasteType")) or "Other"
        bt = by_type.setdefault(label, {"count": 0, "weightKg": 0.0})
        bt["count"] += 1
        bt["weightKg"] += w

    # landfillSavedPct = weighted share of collected mass kept out of landfill.
    #   100 * diverted / total_weight ; 0 when no weight. Clamp 0-100.
    if total_weight > 0:
        landfill_pct = 100.0 * diverted / total_weight
    else:
        landfill_pct = 0.0
    landfill_pct = min(100.0, max(0.0, landfill_pct))

    # climateSavedPct = avoided emissions as a share of (avoided + would-be
    #   landfill emissions): 100 * co2e_saved / (co2e_saved + baseline), where
    #   baseline = total_weight * LANDFILL_BASELINE_CO2E_PER_KG. 0 when no
    #   weight; never divides by zero. Clamp 0-100.
    baseline = total_weight * LANDFILL_BASELINE_CO2E_PER_KG
    denom = co2e_saved + baseline
    if denom > 0:
        climate_pct = 100.0 * co2e_saved / denom
    else:
        climate_pct = 0.0
    climate_pct = min(100.0, max(0.0, climate_pct))

    by_type_list = sorted(
        ({"type": k, "count": v["count"], "weightKg": round(v["weightKg"], 2)}
         for k, v in by_type.items()),
        key=lambda x: x["count"], reverse=True,
    )

    return {
        "totalCollected": len(collected),
        "totalWeightKg": round(total_weight, 2),
        "timeSeries": bucket_timeseries(collected),
        "byType": by_type_list,
        "landfillSavedPct": round(landfill_pct, 1),
        "climateSavedPct": round(climate_pct, 1),
        "co2eSavedKg": round(co2e_saved, 2),
        "landfillDivertedKg": round(diverted, 2),
    }


REPORT_REJECTION = ("This item could not be verified as valid waste and was not "
                    "listed. Please analyze a clear photo of a real waste item.")


def create_report(claims, body):
    if not table:
        return json_response({"error": "Service unavailable"}, status=503)
    # Required contact fields (defense in depth; the UI also validates).
    if not _s(body.get("contactName")) or not _s(body.get("phone")) or not _s(body.get("fullAddress")):
        return json_response({"error": "Name, phone, and address are required"}, status=400)

    # Server-side re-validation of the image so a client bypassing the browser
    # cannot list non-waste / inappropriate content.
    if not validate_image(body.get("file_data"), body.get("file_mime"), body.get("description")):
        return json_response({"error": REPORT_REJECTION}, status=400)

    user_id = claims["sub"]
    now = int(time.time())
    request_id = str(uuid.uuid4())

    # lat/lng stored as Decimal for DynamoDB.
    def dec(v):
        try:
            return Decimal(str(float(v)))
        except (TypeError, ValueError):
            return None

    item = {
        "requestId": request_id,
        "ownerId": user_id,
        "ownerName": _s(body.get("contactName")) or _s(claims.get("name")),
        "ownerEmail": _s(claims.get("email")),
        "status": "open",
        "createdAt": now,
        # Waste info (carried from the AI analysis)
        "wasteType": _s(body.get("wasteType")) or "Waste item",
        "category": _s(body.get("category")),
        "description": _s(body.get("description"))[:1000],
        "weight": _s(body.get("weight")),
        # Contact / pickup — fullAddress is private until a request is approved
        "fullAddress": _s(body.get("fullAddress"))[:300],
        "area": _s(body.get("area"))[:160],
        "contactName": _s(body.get("contactName")),
        "phone": _s(body.get("phone")),
        "pickupTime": _s(body.get("pickupTime")),
        "notes": _s(body.get("notes"))[:500],
    }
    # Pricing (optional, backward-compatible). Readers treat a missing
    # priceType as "user_pays" and a missing maxPrice as "no ceiling".
    # priceType is whitelisted to {'free','user_pays'}; anything unknown falls
    # back to 'user_pays' so a bogus value fails safe toward the paid, business-
    # gated lane (it must never accidentally open the free collect lane).
    price_type = _s(body.get("priceType"))
    item["priceType"] = price_type if price_type in ("free", "user_pays") else "user_pays"
    item["currency"] = (_s(body.get("currency")) or "MYR")[:3].upper()
    # A free giveaway has no price ceiling — do not record maxPrice for it.
    if item["priceType"] != "free":
        max_price = _dec_price(body.get("maxPrice"))
        if max_price is not None:
            item["maxPrice"] = max_price
    lat, lng = dec(body.get("lat")), dec(body.get("lng"))
    if lat is not None and lng is not None:
        item["lat"] = lat
        item["lng"] = lng

    if not item["area"]:
        item["area"] = "Location on request"

    # Persist the validated photo (best-effort). On any failure the listing is
    # still created without an imageKey, so the frontend shows a placeholder.
    image_key = _store_waste_image(request_id, body.get("file_data"), body.get("file_mime"))
    if image_key:
        item["imageKey"] = image_key

    if table:
        table.put_item(Item=item)

    return public_view(item, owner=True)


def edit_report(claims, body):
    """Owner-only edit of a posted waste listing.

    Editable-status rule: an item may be edited ONLY while its status is 'open'.
    'open' is the sole state where no deal is committed (request_collect leaves
    the item 'open' while quotes accumulate; confirm_deal flips it to
    'collecting'). Default: NOT editable once a collection is in progress, because
    a confirmed collector may already be acting on the current details. Any
    non-open status (collecting/collected/closed/disputed/unknown) returns 409.

    Partial update: only fields actually present in the body are written, so an
    edit that omits a field leaves the stored value untouched. ownerId/requestId/
    createdAt/status are never changed. The image is re-validated only when a new
    one is supplied; otherwise the stored image/validation state is preserved."""
    if not table:
        return json_response({"error": "Service unavailable"}, status=503)

    waste_id = _s(body.get("requestId")) or _s(body.get("wasteId"))
    if not waste_id:
        return json_response({"error": "Missing waste item id"}, status=400)

    item = _get_waste(waste_id)
    if not item:
        return json_response({"error": "Waste item not found"}, status=404)
    if claims["sub"] != item.get("ownerId"):
        return json_response({"error": "Not authorized"}, status=403)
    if item.get("status") not in ("open",):
        return json_response(
            {"error": "This item can no longer be edited because a collection is in progress."},
            status=409,
        )

    # Re-validate only when a NEW image is actually supplied in the edit body.
    # No image in the body => leave the stored image/validation state untouched.
    new_image_supplied = bool(_s(body.get("file_data")) and _s(body.get("file_mime")))
    if new_image_supplied:
        if not validate_image(body.get("file_data"), body.get("file_mime"), body.get("description")):
            return json_response({"error": REPORT_REJECTION}, status=400)

    def dec(v):
        try:
            return Decimal(str(float(v)))
        except (TypeError, ValueError):
            return None

    # Build a partial update from ONLY the allowed keys present in the body.
    # Same _s() trimming + length caps as create_report. Omitted keys are left
    # alone (never wiped). ownerId/requestId/createdAt/status are not touched.
    set_parts = []
    remove_parts = []
    names = {}
    values = {}

    def _set(attr, value):
        ph = "#%s" % attr
        vph = ":%s" % attr
        names[ph] = attr
        values[vph] = value
        set_parts.append("%s = %s" % (ph, vph))

    capped = {
        "description": 1000,
        "fullAddress": 300,
        "area": 160,
        "notes": 500,
    }
    simple_fields = ("pickupTime", "phone", "contactName", "fullAddress",
                     "area", "notes", "weight", "description")
    for key in simple_fields:
        if key in body:
            val = _s(body.get(key))
            if key in capped:
                val = val[:capped[key]]
            _set(key, val)

    # Pricing settings (only if present). Same whitelist / normalization as
    # create_report. A 'free' giveaway has no ceiling, so REMOVE any stored
    # maxPrice; a paid listing records maxPrice when a valid value is supplied.
    if "priceType" in body:
        price_type = _s(body.get("priceType"))
        _set("priceType", price_type if price_type in ("free", "user_pays") else "user_pays")
    if "currency" in body:
        _set("currency", (_s(body.get("currency")) or "MYR")[:3].upper())
    if "priceType" in body and _s(body.get("priceType")) == "free":
        remove_parts.append("maxPrice")
    elif "maxPrice" in body:
        max_price = _dec_price(body.get("maxPrice"))
        if max_price is not None:
            _set("maxPrice", max_price)

    # lat/lng only when BOTH provided (mirror create_report).
    if "lat" in body and "lng" in body:
        lat, lng = dec(body.get("lat")), dec(body.get("lng"))
        if lat is not None and lng is not None:
            _set("lat", lat)
            _set("lng", lng)

    # Store a replacement photo only when a new valid image was supplied above
    # (overwrites the same waste/<waste_id> key). Best-effort: a failed store
    # leaves the existing image untouched. No new image => imageKey not touched.
    if new_image_supplied:
        image_key = _store_waste_image(waste_id, body.get("file_data"), body.get("file_mime"))
        if image_key:
            _set("imageKey", image_key)

    if not set_parts and not remove_parts:
        # Nothing to change — return the current item as-is.
        return public_view(item, owner=True)

    expr = ""
    if set_parts:
        expr += "SET " + ", ".join(set_parts)
    if remove_parts:
        expr += (" " if expr else "") + "REMOVE " + ", ".join(remove_parts)

    kwargs = {
        "Key": {"requestId": waste_id},
        "UpdateExpression": expr,
    }
    if names:
        kwargs["ExpressionAttributeNames"] = names
    if values:
        kwargs["ExpressionAttributeValues"] = values
    table.update_item(**kwargs)

    # Reflect the change locally for the return view (avoids a second read).
    for vph, val in values.items():
        item[vph[1:]] = val
    for attr in remove_parts:
        item.pop(attr, None)

    return public_view(item, owner=True)


def public_view(item, owner=False):
    """Shape a request for the client. Hides fullAddress/phone unless the
    viewer is the owner (full unlock-on-approval comes in a later stage)."""
    view = {
        "requestId": item.get("requestId"),
        "ownerId": item.get("ownerId"),
        "ownerName": item.get("ownerName", ""),
        "status": item.get("status", "open"),
        "createdAt": item.get("createdAt"),
        "wasteType": item.get("wasteType", ""),
        "category": item.get("category", ""),
        "description": item.get("description", ""),
        "weight": item.get("weight", ""),
        "area": item.get("area", ""),
        "pickupTime": item.get("pickupTime", ""),
        "notes": item.get("notes", ""),
    }
    # Pricing fields are not sensitive — shown to owner and non-owner alike.
    view["priceType"] = item.get("priceType", "user_pays")
    view["currency"] = item.get("currency", "MYR")
    if "maxPrice" in item:
        view["maxPrice"] = item.get("maxPrice")
    if "lat" in item and "lng" in item:
        view["lat"] = item["lat"]
        view["lng"] = item["lng"]
    # Waste photo: present only when the item has a stored key AND the presign
    # succeeds. Shown to owner and non-owner alike (by design); never exposes
    # contact info. Legacy items have no imageKey -> no imageUrl -> placeholder.
    image_key = item.get("imageKey")
    if image_key and COLLECTOR_DOCS_BUCKET:
        try:
            view["imageUrl"] = s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": COLLECTOR_DOCS_BUCKET, "Key": image_key},
                ExpiresIn=WASTE_IMAGE_URL_EXPIRY,
            )
        except Exception as e:
            logger.warning("presign waste image error for %s: %s", image_key, str(e))
    if owner:
        view["fullAddress"] = item.get("fullAddress", "")
        view["contactName"] = item.get("contactName", "")
        view["phone"] = item.get("phone", "")
    else:
        view["addressMasked"] = True
    return view


def list_public(claims):
    if not table:
        return {"requests": []}
    items = []
    try:
        resp = table.query(
            IndexName="statusIndex",
            KeyConditionExpression=Key("status").eq("open"),
            ScanIndexForward=False,  # newest first
            Limit=50,
        )
        items = resp.get("Items", [])
    except Exception as e:
        logger.error("list_public query error: %s", str(e))
    my_id = claims["sub"]
    out = [public_view(it, owner=(it.get("ownerId") == my_id)) for it in items]
    return {"requests": out}


def list_mine(claims):
    if not table:
        return {"requests": []}
    items = []
    try:
        resp = table.query(
            IndexName="ownerIndex",
            KeyConditionExpression=Key("ownerId").eq(claims["sub"]),
            ScanIndexForward=False,
            Limit=100,
        )
        items = resp.get("Items", [])
    except Exception as e:
        logger.error("list_mine query error: %s", str(e))
    return {"requests": [public_view(it, owner=True) for it in items]}


# ------------------- Web Push -------------------

# Notification types that also trigger an OS/device push (kept to high-value
# events so pushes don't feel spammy).
PUSH_TYPES = {"request", "approved", "message"}


def save_subscription(claims, body):
    sub = body.get("subscription") or {}
    endpoint = _s(sub.get("endpoint"))
    if not endpoint:
        return json_response({"error": "Missing subscription endpoint"}, status=400)
    if not push_table:
        return json_response({"error": "Service unavailable"}, status=503)
    try:
        push_table.put_item(Item={
            "userId": claims["sub"],
            "endpoint": endpoint,
            "keys": sub.get("keys", {}) or {},
            "createdAt": int(time.time()),
        })
    except Exception as e:
        logger.error("save_subscription error: %s", str(e))
        return json_response({"error": "Could not save subscription"}, status=500)
    return {"ok": True}


def remove_subscription(claims, body):
    endpoint = _s(body.get("endpoint"))
    if endpoint and push_table:
        try:
            push_table.delete_item(Key={"userId": claims["sub"], "endpoint": endpoint})
        except Exception as e:
            logger.error("remove_subscription error: %s", str(e))
    return {"ok": True}


def push_send(user_id, title, body_text, url="/"):
    """Send a Web Push to all of a user's subscribed devices. Prunes dead
    subscriptions (410 Gone / 404). Best-effort — never raises to the caller."""
    if not push_table or not user_id or not VAPID_PRIVATE_KEY:
        return
    try:
        from pywebpush import webpush, WebPushException
    except Exception:
        logger.warning("pywebpush unavailable; skipping push")
        return
    try:
        resp = push_table.query(KeyConditionExpression=Key("userId").eq(user_id))
        subs = resp.get("Items", [])
    except Exception as e:
        logger.error("push_send query error: %s", str(e))
        return

    payload = json.dumps({"title": title, "body": body_text, "url": url})
    for s in subs:
        subscription_info = {
            "endpoint": s.get("endpoint"),
            "keys": s.get("keys", {}),
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
                timeout=5,
            )
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):
                # Subscription expired/unsubscribed — remove it.
                try:
                    push_table.delete_item(Key={"userId": user_id, "endpoint": s.get("endpoint")})
                except Exception:
                    pass
            else:
                logger.warning("webpush failed (%s): %s", status, str(e))
        except Exception as e:
            logger.warning("webpush error: %s", str(e))


# ------------------- Notifications -------------------
def notify(user_id, ntype, title, body, meta=None):
    """Append a notification to a user's feed, and push to their device for
    high-value event types."""
    if not notif_table or not user_id:
        return
    # Build the row once so the realtime payload matches the stored item exactly.
    row = {
        "userId": user_id,
        "createdAt": _now_micros(),
        "notifId": str(uuid.uuid4()),
        "type": ntype,
        "title": title,
        "body": body,
        "meta": meta or {},
        "read": False,
    }
    try:
        notif_table.put_item(Item=row)
    except Exception as e:
        logger.error("notify error: %s", str(e))

    # Realtime: push the new notification to the user's private channel so the
    # header badge + an open Notifications page update without a manual refresh.
    # Every notification type is realtime (unlike device push, below). Wrapped so
    # a publish failure never breaks notification creation.
    try:
        token = get_or_create_notify_channel(user_id)
        if token:
            _publish_to_appsync(notif_channel_name(token), row)
    except Exception as e:
        logger.error("notify realtime publish error: %s", str(e))

    # Device push for the important events.
    if ntype in PUSH_TYPES:
        url = "/#/notifications"
        if ntype == "message":
            url = "/#/chat"
        push_send(user_id, title, body, url)


def _now_micros():
    # Microsecond timestamp keeps the sort key unique per user.
    return int(time.time() * 1_000_000)


def list_notifications(claims):
    if not notif_table:
        return {"notifications": []}
    items = []
    try:
        resp = notif_table.query(
            KeyConditionExpression=Key("userId").eq(claims["sub"]),
            ScanIndexForward=False,
            Limit=50,
        )
        items = resp.get("Items", [])
    except Exception as e:
        logger.error("list_notifications error: %s", str(e))
    unread = sum(1 for n in items if not n.get("read"))
    return {"notifications": items, "unread": unread}


def mark_notifications_read(claims):
    if not notif_table:
        return {"ok": True}
    try:
        resp = notif_table.query(
            KeyConditionExpression=Key("userId").eq(claims["sub"]),
            ScanIndexForward=False, Limit=50,
        )
        for n in resp.get("Items", []):
            if not n.get("read"):
                notif_table.update_item(
                    Key={"userId": n["userId"], "createdAt": n["createdAt"]},
                    UpdateExpression="SET #r = :t",
                    ExpressionAttributeNames={"#r": "read"},
                    ExpressionAttributeValues={":t": True},
                )
    except Exception as e:
        logger.error("mark_read error: %s", str(e))
    return {"ok": True}


# ------------------- Request lifecycle -------------------

def _get_waste(waste_id):
    if not table:
        return None
    try:
        return table.get_item(Key={"requestId": waste_id}).get("Item")
    except Exception as e:
        logger.error("get waste error: %s", str(e))
        return None


def _creq_view(cr, waste=None):
    """Shape a collect-request for the client. Owner contact details unlock only
    when the request reaches a status in UNLOCK_STATUSES (earliest 'confirmed')
    and a waste object is supplied — never gated by price."""
    view = {
        "collectRequestId": cr.get("collectRequestId"),
        "wasteId": cr.get("wasteId"),
        "ownerId": cr.get("ownerId"),
        "ownerName": cr.get("ownerName", ""),
        "collectorId": cr.get("collectorId"),
        "collectorName": cr.get("collectorName", ""),
        "status": cr.get("status", "requested"),
        "createdAt": cr.get("createdAt"),
        "message": cr.get("message", ""),
        "wasteType": cr.get("wasteType", ""),
        "category": cr.get("category", ""),
        "weight": cr.get("weight", ""),
        "area": cr.get("area", ""),
    }
    # Quote fields are always exposed (not sensitive, never unlock-gated).
    view["quoteAmount"] = cr.get("quoteAmount")
    view["currency"] = cr.get("currency", "MYR")
    view["maxPrice"] = cr.get("maxPrice")
    view["paymentStatus"] = cr.get("paymentStatus")
    if cr.get("status") in UNLOCK_STATUSES and waste:
        view["unlocked"] = True
        view["fullAddress"] = waste.get("fullAddress", "")
        view["ownerPhone"] = waste.get("phone", "")
        view["pickupTime"] = waste.get("pickupTime", "")
        view["notes"] = waste.get("notes", "")
    return view


def request_collect(claims, body):
    waste_id = _s(body.get("requestId")) or _s(body.get("wasteId"))
    if not waste_id:
        return json_response({"error": "Missing waste item id"}, status=400)
    if not creq_table or not table:
        return json_response({"error": "Service unavailable"}, status=503)
    # (3) waste must exist.
    waste = _get_waste(waste_id)
    if not waste:
        return json_response({"error": "Waste item not found"}, status=404)
    # (4) self-collect guard — kept, intentionally BEFORE the collector gate so an
    #     owner who is also a collector gets this clear message, not an opaque 403.
    if waste.get("ownerId") == claims["sub"]:
        return json_response({"error": "You cannot collect your own item"}, status=400)
    # (5) item must still be open (prevents quoting a collecting/collected/closed
    #     item). Under multi-quote the item stays 'open' while quotes accumulate.
    if waste.get("status") not in ("open", None):
        return json_response({"error": "This item is no longer available"}, status=409)
    # A free giveaway ('free') is collectable by ANY logged-in user — the paid
    # lane ('user_pays', incl. a missing/legacy value) stays business-gated and
    # quote-validated below. This flag forks ONLY steps (6)+(7); the rest of the
    # lifecycle is identical for free and paid.
    is_free = (waste.get("priceType") or "user_pays") == "free"
    # (6) collector verification: only approved collectors may quote on a Type B
    #     ("user_pays") listing. Single enforcement point; fails closed. Free
    #     items skip this gate so any logged-in user can collect them.
    if not is_free:
        if not _is_approved_collector(claims["sub"]):
            return json_response(
                {"error": "Only verified collector businesses can quote on paid pickups"},
                status=403)
    # (7) parse + validate the quote. A free collect needs no amount — accept a
    #     missing/blank/zero amount cleanly and store None. The paid path keeps
    #     the full positive-amount + maxPrice-ceiling validation unchanged.
    amount = _dec_price(body.get("quoteAmount"))
    message = _s(body.get("message"))[:500]
    if is_free:
        amount = None
    else:
        ok, err = _validate_quote(amount, _dec_price(waste.get("maxPrice")))
        if not ok:
            return json_response({"error": err}, status=400)
    # (8) reject a duplicate live quote by the same collector on this item. The
    #     wasteIndex GSI is keyed by wasteId (not collector), so paginate the full
    #     result set and filter collector-identity + live-status in Lambda.
    me = claims["sub"]
    if creq_table:
        last_key = None
        while True:
            q = {
                "IndexName": "wasteIndex",
                "KeyConditionExpression": Key("wasteId").eq(waste_id),
            }
            if last_key:
                q["ExclusiveStartKey"] = last_key
            try:
                resp = creq_table.query(**q)
            except Exception as e:
                logger.error("duplicate-quote query error: %s", str(e))
                break
            for row in resp.get("Items", []):
                if row.get("collectorId") == me and row.get("status") in LIVE_QUOTE_STATUSES:
                    return json_response(
                        {"error": "You already have a live quote on this item"},
                        status=409)
            last_key = resp.get("LastEvaluatedKey")
            if not last_key:
                break

    # (9) persist the quote. Snapshot the quote amount, currency and maxPrice from
    #     the waste item so _creq_view never re-loads it just to show a ceiling.
    now = _now_micros()
    cr = {
        "collectRequestId": str(uuid.uuid4()),
        "wasteId": waste_id,
        "ownerId": waste.get("ownerId"),
        "ownerName": waste.get("ownerName", ""),
        "collectorId": me,
        "collectorName": _s(claims.get("name")) or _s(claims.get("email")),
        "status": "requested",
        "createdAt": now,
        "message": message,
        "quoteAmount": amount,
        "currency": waste.get("currency", "MYR"),
        "wasteType": waste.get("wasteType", ""),
        "category": waste.get("category", ""),
        "weight": waste.get("weight", ""),
        "area": waste.get("area", ""),
    }
    waste_max = _dec_price(waste.get("maxPrice"))
    if waste_max is not None:
        cr["maxPrice"] = waste_max
    if creq_table:
        creq_table.put_item(Item=cr)
    # The waste item is intentionally left 'open' (no status flip) so it stays
    # listable and can accept further quotes — the single-quote flip is removed.
    notify(waste.get("ownerId"), "request",
           "New collection request",
           cr["collectorName"] + " wants to collect your " + (waste.get("wasteType") or "item") + ".",
           {"collectRequestId": cr["collectRequestId"], "wasteId": waste_id})
    return _creq_view(cr)


def _get_creq(collect_request_id):
    if not creq_table:
        return None
    try:
        return creq_table.get_item(Key={"collectRequestId": collect_request_id}).get("Item")
    except Exception as e:
        logger.error("get creq error: %s", str(e))
        return None


def approve_request(claims, body):
    cr_id = _s(body.get("collectRequestId"))
    if not cr_id:
        return json_response({"error": "Missing request id"}, status=400)
    if not creq_table:
        return json_response({"error": "Service unavailable"}, status=503)
    cr = _get_creq(cr_id)
    if not cr:
        return json_response({"error": "Request not found"}, status=404)
    if cr.get("ownerId") != claims["sub"]:
        return json_response({"error": "Not authorized"}, status=403)
    if cr.get("status") != "requested":
        return json_response({"error": "This request can no longer be approved"}, status=409)

    # Accepting a quote signals intent only — it unlocks NOTHING and does not
    # auto-close other quotes (the owner may still back out before confirming).
    # The waste item is NOT flipped here; commitment happens in confirm_deal.
    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "accepted"},
    )
    notify(cr["collectorId"], "request",
           "Quote accepted",
           "Your quote was accepted — awaiting the owner's confirmation.",
           {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    cr["status"] = "accepted"
    # No waste object passed: nothing unlocks at 'accepted'.
    return _creq_view(cr)


def reject_request(claims, body):
    cr_id = _s(body.get("collectRequestId"))
    if not cr_id:
        return json_response({"error": "Missing request id"}, status=400)
    if not creq_table:
        return json_response({"error": "Service unavailable"}, status=503)
    cr = _get_creq(cr_id)
    if not cr:
        return json_response({"error": "Request not found"}, status=404)
    if cr.get("ownerId") != claims["sub"]:
        return json_response({"error": "Not authorized"}, status=403)
    if cr.get("status") != "requested":
        return json_response({"error": "This request can no longer be rejected"}, status=409)

    # Rejecting one quote touches ONLY this collect-request row. Under multi-quote
    # the waste item stays 'open' (quoting never flipped it), so a listing that may
    # hold other live quotes must not be disturbed — no waste-item write here.
    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "rejected"},
    )
    notify(cr["collectorId"], "rejected",
           "Request declined",
           "Your request to collect " + (cr.get("wasteType") or "the item") + " was declined.",
           {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    cr["status"] = "rejected"
    return _creq_view(cr)


def mark_done(claims, body):
    cr_id = _s(body.get("collectRequestId"))
    if not cr_id:
        return json_response({"error": "Missing request id"}, status=400)
    if not creq_table:
        return json_response({"error": "Service unavailable"}, status=503)
    cr = _get_creq(cr_id)
    if not cr:
        return json_response({"error": "Request not found"}, status=404)
    # Either party in the confirmed deal can mark it done. The collect-request is
    # 'confirmed' right up to completion ('collecting' lives on the waste item).
    if claims["sub"] not in (cr.get("ownerId"), cr.get("collectorId")):
        return json_response({"error": "Not authorized"}, status=403)
    status = cr.get("status")
    if status == "collected":
        # Idempotent: desired end state already reached. No-op: do not re-write
        # the collect-request or waste item, and do not re-notify (no duplicate
        # "Collection completed"). Return the current view as success.
        return _creq_view(cr)
    if status != "confirmed":
        return json_response({"error": "Request is not confirmed yet"}, status=400)

    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s, completedAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "collected", ":t": int(time.time())},
    )
    if table:
        # NIT#3: this is an UNCONDITIONAL set of the waste item to 'collected'
        # regardless of its prior status.
        table.update_item(
            Key={"requestId": cr["wasteId"]},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "collected"},
        )
    for uid in (cr.get("ownerId"), cr.get("collectorId")):
        notify(uid, "done", "Collection completed",
               (cr.get("wasteType") or "The item") + " has been marked as collected.",
               {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    cr["status"] = "collected"
    return _creq_view(cr)


def confirm_deal(claims, body):
    """Owner's deliberate commit on an accepted quote. First unlocking state:
    sets the collect-request to 'confirmed', the waste item to 'collecting', and
    auto-closes the other live quotes (best-effort)."""
    cr_id = _s(body.get("collectRequestId"))
    if not cr_id:
        return json_response({"error": "Missing request id"}, status=400)
    if not creq_table:
        return json_response({"error": "Service unavailable"}, status=503)
    cr = _get_creq(cr_id)
    if not cr:
        return json_response({"error": "Request not found"}, status=404)
    if cr.get("ownerId") != claims["sub"]:
        return json_response({"error": "Not authorized"}, status=403)
    if cr.get("status") != "accepted":
        return json_response({"error": "This request can no longer be confirmed"}, status=409)

    # MEDIUM-1: one confirmed deal per item. Re-load the waste item and refuse if
    # it is already 'collecting' for a DIFFERENT collector. ('collecting' is a
    # waste-item status only — never a collect-request status.)
    waste = _get_waste(cr["wasteId"])
    if (waste and waste.get("status") == "collecting"
            and waste.get("collectorId")
            and waste.get("collectorId") != cr.get("collectorId")):
        return json_response({"error": "This item already has a confirmed collector"}, status=409)

    # WRITE ORDER (1): commit the collect-request first.
    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s, confirmedAt = :t, paymentStatus = :p",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": "confirmed",
            ":t": int(time.time()),
            # Phase 2: Stripe PaymentIntent authorization goes here.
            ":p": "not_required",
        },
    )
    cr["status"] = "confirmed"
    cr["paymentStatus"] = "not_required"

    # WRITE ORDER (2): flip the waste item to 'collecting' (waste-item-only
    # status) BEFORE building the unlocked view. If this write fails, return 500
    # WITHOUT unlocking contact.
    if table:
        try:
            table.update_item(
                Key={"requestId": cr["wasteId"]},
                UpdateExpression="SET #s = :s, collectorId = :c, collectorName = :cn",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "collecting",  # waste-item status only
                    ":c": cr["collectorId"],
                    ":cn": cr.get("collectorName", ""),
                },
            )
        except Exception as e:
            logger.error("confirm_deal waste write failed: %s", str(e))
            return json_response({"error": "Could not confirm the deal"}, status=500)

    # WRITE ORDER (3): best-effort auto-close of the other live quotes. This MUST
    # NOT fail the confirm — any error is logged and swallowed.
    try:
        last_key = None
        while True:
            q = {
                "IndexName": "wasteIndex",
                "KeyConditionExpression": Key("wasteId").eq(cr["wasteId"]),
            }
            if last_key:
                q["ExclusiveStartKey"] = last_key
            resp = creq_table.query(**q)
            for row in resp.get("Items", []):
                if row.get("collectRequestId") == cr_id:
                    continue
                if row.get("status") in ("requested", "accepted"):
                    try:
                        creq_table.update_item(
                            Key={"collectRequestId": row["collectRequestId"]},
                            UpdateExpression="SET #s = :s",
                            ExpressionAttributeNames={"#s": "status"},
                            ExpressionAttributeValues={":s": "closed"},
                        )
                        notify(row.get("collectorId"), "rejected",
                               "Quote closed",
                               "Another collector was selected for " +
                               (row.get("wasteType") or "the item") + ".",
                               {"collectRequestId": row["collectRequestId"],
                                "wasteId": cr["wasteId"]})
                    except Exception as e:
                        logger.error("auto-close row error: %s", str(e))
            last_key = resp.get("LastEvaluatedKey")
            if not last_key:
                break
    except Exception as e:
        logger.error("confirm_deal auto-close error: %s", str(e))

    notify(cr["collectorId"], "approved",
           "Deal confirmed",
           "Deal confirmed — address and contact unlocked, chat is open.",
           {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    return _creq_view(cr, _get_waste(cr["wasteId"]))


def cancel_request(claims, body):
    """Soft back-out usable by either party — NEVER deletes the row. Pre-confirm
    cancels leave the waste item untouched; a post-confirm cancel reverts the
    waste item to 'open' only when no OTHER confirmed deal remains for it."""
    cr_id = _s(body.get("collectRequestId"))
    if not cr_id:
        return json_response({"error": "Missing request id"}, status=400)
    if not creq_table:
        return json_response({"error": "Service unavailable"}, status=503)
    cr = _get_creq(cr_id)
    if not cr:
        return json_response({"error": "Request not found"}, status=404)
    if not _is_member(cr, claims["sub"]):
        return json_response({"error": "Not authorized"}, status=403)
    status = cr.get("status")
    if status not in ("requested", "accepted", "confirmed"):
        # collected/rejected/closed/disputed/cancelled cannot be cancelled.
        return json_response({"error": "This request can no longer be cancelled"}, status=409)

    was_confirmed = status == "confirmed"
    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s, cancelledAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "cancelled", ":t": int(time.time())},
    )
    # Phase 2: trigger Stripe refund/void here (paymentStatus left as-is).

    if was_confirmed and table:
        # MEDIUM-2: revert the waste item to 'open' ONLY IF no OTHER confirmed deal
        # exists. Paginate the full wasteIndex result set, excluding the row being
        # cancelled. Auto-closed losing quotes are NOT restored on cancel; the
        # owner re-lists and collectors re-quote.
        other_confirmed = False
        try:
            last_key = None
            while True:
                q = {
                    "IndexName": "wasteIndex",
                    "KeyConditionExpression": Key("wasteId").eq(cr["wasteId"]),
                }
                if last_key:
                    q["ExclusiveStartKey"] = last_key
                resp = creq_table.query(**q)
                for row in resp.get("Items", []):
                    if row.get("collectRequestId") == cr_id:
                        continue
                    if row.get("status") == "confirmed":
                        other_confirmed = True
                        break
                last_key = resp.get("LastEvaluatedKey")
                if other_confirmed or not last_key:
                    break
        except Exception as e:
            logger.error("cancel_request confirmed-scan error: %s", str(e))
            # Fail safe: if we cannot prove the item is free, do not reopen it.
            other_confirmed = True
        if not other_confirmed:
            try:
                table.update_item(
                    Key={"requestId": cr["wasteId"]},
                    UpdateExpression="SET #s = :s",
                    ExpressionAttributeNames={"#s": "status"},
                    ExpressionAttributeValues={":s": "open"},
                )
            except Exception as e:
                logger.error("cancel_request reopen error: %s", str(e))

    for uid in (cr.get("ownerId"), cr.get("collectorId")):
        notify(uid, "rejected", "Collection cancelled",
               (cr.get("wasteType") or "The collection") + " was cancelled.",
               {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    cr["status"] = "cancelled"
    return _creq_view(cr)


def raise_dispute(claims, body):
    """Records a dispute on a committed job (confirmed/collected) and notifies the
    other party. Phase 1 only records it — no refund, no delete."""
    cr_id = _s(body.get("collectRequestId"))
    if not cr_id:
        return json_response({"error": "Missing request id"}, status=400)
    if not creq_table:
        return json_response({"error": "Service unavailable"}, status=503)
    cr = _get_creq(cr_id)
    if not cr:
        return json_response({"error": "Request not found"}, status=404)
    if not _is_member(cr, claims["sub"]):
        return json_response({"error": "Not authorized"}, status=403)
    # 'disputed' excluded so a dispute can't be re-raised.
    if cr.get("status") not in ("confirmed", "collected"):
        return json_response({"error": "This request cannot be disputed"}, status=409)

    sub = claims["sub"]
    reason = _s(body.get("reason"))[:1000]
    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s, disputeReason = :r, disputedAt = :t, disputedBy = :b",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": "disputed",
            ":r": reason,
            ":t": int(time.time()),
            ":b": sub,
        },
    )
    # Phase 2: refund/arbitration hooks attach here.
    other = cr.get("collectorId") if sub == cr.get("ownerId") else cr.get("ownerId")
    notify(other, "rejected", "Dispute raised",
           "A dispute was raised on " + (cr.get("wasteType") or "the collection") + ".",
           {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    cr["status"] = "disputed"
    cr["disputeReason"] = reason
    cr["disputedBy"] = sub
    return _creq_view(cr, _get_waste(cr["wasteId"]))


# ------------------- Collector business accounts (Part C) -------------------
# A collector record lives in collectors_table keyed by userId. Lifecycle:
#   none -> draft (apply) -> pending (submit) -> approved | rejected (admin)
#   approved -> suspended (admin). Verification documents are uploaded straight
# to S3 via presigned PUT; only the object key is stored on the record.

_COLLECTOR_REQUIRED_FIELDS = (
    "businessName", "registrationNumber", "wasteCarrierLicense",
    "contactPhone", "contactEmail",
)


def _collector_view(c):
    """Shape a collector record for its owner. Returns {'status':'none'} shape
    when there is no record."""
    if not c:
        return {"status": "none"}
    return {
        "status": c.get("status", "none"),
        "businessName": c.get("businessName", ""),
        "registrationNumber": c.get("registrationNumber", ""),
        "wasteCarrierLicense": c.get("wasteCarrierLicense", ""),
        "serviceAreas": c.get("serviceAreas", []) or [],
        "wasteCategories": c.get("wasteCategories", []) or [],
        "contactPhone": c.get("contactPhone", ""),
        "contactEmail": c.get("contactEmail", ""),
        "docKeys": c.get("docKeys", {}) or {},
        "rejectionReason": c.get("rejectionReason", ""),
        "createdAt": c.get("createdAt"),
        "updatedAt": c.get("updatedAt"),
        "verifiedAt": c.get("verifiedAt"),
    }


def collector_apply(claims, body):
    """Upsert a 'draft' record (idempotent). Re-applying keeps prior data and
    only updates the supplied fields — it never regresses an approved/pending
    account back to draft."""
    if not collectors_table:
        return json_response({"error": "Service unavailable"}, status=503)
    user_id = claims["sub"]
    now = int(time.time())
    existing = _get_collector(user_id) or {}
    rec = dict(existing)
    rec["userId"] = user_id
    # Keep an existing lifecycle status; only a brand-new record starts 'draft'.
    rec["status"] = existing.get("status") or "draft"
    rec.setdefault("createdAt", now)
    rec.setdefault("docKeys", existing.get("docKeys", {}) or {})
    # Apply the editable profile fields when present (idempotent upsert).
    rec["businessName"] = _s(body.get("businessName")) or existing.get("businessName", "")
    rec["registrationNumber"] = _s(body.get("registrationNumber")) or existing.get("registrationNumber", "")
    rec["wasteCarrierLicense"] = _s(body.get("wasteCarrierLicense")) or existing.get("wasteCarrierLicense", "")
    rec["contactPhone"] = _s(body.get("contactPhone")) or existing.get("contactPhone", "")
    rec["contactEmail"] = _s(body.get("contactEmail")) or existing.get("contactEmail", "")
    if isinstance(body.get("serviceAreas"), list):
        rec["serviceAreas"] = [_s(x) for x in body.get("serviceAreas") if _s(x)]
    else:
        rec["serviceAreas"] = existing.get("serviceAreas", []) or []
    if isinstance(body.get("wasteCategories"), list):
        rec["wasteCategories"] = [_s(x) for x in body.get("wasteCategories") if _s(x)]
    else:
        rec["wasteCategories"] = existing.get("wasteCategories", []) or []
    rec["updatedAt"] = now
    collectors_table.put_item(Item=rec)
    return _collector_view(rec)


def collector_submit(claims, body):
    """Move a 'draft' record to 'pending' after validating required fields."""
    if not collectors_table:
        return json_response({"error": "Service unavailable"}, status=503)
    user_id = claims["sub"]
    c = _get_collector(user_id)
    if not c:
        return json_response({"error": "Apply before submitting for verification"}, status=404)
    if c.get("status") in ("approved", "pending"):
        return json_response({"error": "Your application is already submitted"}, status=409)
    # Validate scalar required fields in order, naming the first missing one.
    for field in _COLLECTOR_REQUIRED_FIELDS:
        if not _s(c.get(field)):
            return json_response({"error": field + " is required"}, status=400)
    # serviceAreas / wasteCategories must each be a non-empty list.
    if not (isinstance(c.get("serviceAreas"), list) and c.get("serviceAreas")):
        return json_response({"error": "serviceAreas is required"}, status=400)
    if not (isinstance(c.get("wasteCategories"), list) and c.get("wasteCategories")):
        return json_response({"error": "wasteCategories is required"}, status=400)

    now = int(time.time())
    collectors_table.update_item(
        Key={"userId": user_id},
        UpdateExpression="SET #s = :s, updatedAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "pending", ":t": now},
    )
    c["status"] = "pending"
    c["updatedAt"] = now
    notify(user_id, "request", "Verification submitted",
           "Your collector application is now pending review.",
           {"collector": True})
    return _collector_view(c)


def collector_me(claims):
    """Return the caller's collector record (or {'status':'none'})."""
    return _collector_view(_get_collector(claims["sub"]))


# NIT#5: only these content types may be presigned for a verification upload.
UPLOAD_CONTENT_TYPES = {"image/png", "image/jpeg", "application/pdf"}


def collector_upload_url(claims, body):
    """Presign a PUT so the browser can upload a verification document straight
    to S3. The signed ContentType MUST equal the Content-Type the browser sends
    on the PUT, so we echo the validated contentType back to the caller."""
    if not collectors_table or not COLLECTOR_DOCS_BUCKET:
        return json_response({"error": "Service unavailable"}, status=503)
    user_id = claims["sub"]
    doc_type = _s(body.get("docType"))
    content_type = _s(body.get("contentType"))
    if doc_type not in DOC_TYPES:
        return json_response({"error": "Unsupported document type"}, status=400)
    # NIT#5: reject anything outside the allow-list.
    if content_type not in UPLOAD_CONTENT_TYPES:
        return json_response({"error": "Unsupported content type"}, status=400)
    key = "collectors/{}/{}".format(user_id, doc_type)
    try:
        url = s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": COLLECTOR_DOCS_BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=300,
        )
    except Exception as e:
        logger.error("presign upload error: %s", str(e))
        return json_response({"error": "Could not create upload URL"}, status=500)
    # Record the key on the collector record so the admin queue can find it.
    try:
        collectors_table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET docKeys.#d = :k, updatedAt = :t",
            ExpressionAttributeNames={"#d": doc_type},
            ExpressionAttributeValues={":k": key, ":t": int(time.time())},
        )
    except Exception as e:
        # The record may not have a docKeys map yet — set the whole map then.
        logger.warning("docKeys update fallback: %s", str(e))
        try:
            collectors_table.update_item(
                Key={"userId": user_id},
                UpdateExpression="SET docKeys = :m, updatedAt = :t",
                ExpressionAttributeValues={":m": {doc_type: key}, ":t": int(time.time())},
            )
        except Exception as e2:
            logger.error("docKeys set error: %s", str(e2))
    return {"url": url, "key": key}


# ------------------- Admin verification queue (Part D) ----------------------

_COLLECTOR_STATUSES = {"pending", "approved", "rejected", "suspended"}


def _is_admin(claims):
    # cognito:groups is TOKEN-SCOPED: a newly-added admin must re-login (or wait
    # for their ID token to refresh) before this returns True.
    return "admins" in (claims.get("cognito:groups") or [])


def admin_list_collectors(claims, status):
    """List collector records in a given lifecycle status, newest-first, with a
    short-lived presigned GET URL per uploaded document."""
    if not _is_admin(claims):
        return json_response({"error": "Not authorized"}, status=403)
    if not collectors_table:
        return json_response({"error": "Service unavailable"}, status=503)
    status = _s(status) or "pending"
    if status not in _COLLECTOR_STATUSES:
        return json_response({"error": "Invalid status filter"}, status=400)
    items = []
    try:
        resp = collectors_table.query(
            IndexName="statusIndex",
            KeyConditionExpression=Key("status").eq(status),
            ScanIndexForward=False,  # newest first
            Limit=100,
        )
        items = resp.get("Items", [])
    except Exception as e:
        logger.error("admin_list_collectors query error: %s", str(e))
    out = []
    for c in items:
        v = _collector_view(c)
        v["userId"] = c.get("userId")
        # Attach a short-lived presigned GET per document, tolerating a missing
        # object (presign never checks existence, so this only fails on a client
        # error — logged, not fatal).
        doc_urls = {}
        for dt, key in (c.get("docKeys") or {}).items():
            if not key:
                continue
            try:
                doc_urls[dt] = s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": COLLECTOR_DOCS_BUCKET, "Key": key},
                    ExpiresIn=300,
                )
            except Exception as e:
                logger.warning("presign get error for %s: %s", key, str(e))
        v["docUrls"] = doc_urls
        out.append(v)
    return {"collectors": out}


def admin_approve_collector(claims, collector_id):
    if not _is_admin(claims):
        return json_response({"error": "Not authorized"}, status=403)
    if not collectors_table:
        return json_response({"error": "Service unavailable"}, status=503)
    c = _get_collector(collector_id)
    if not c:
        return json_response({"error": "Collector not found"}, status=404)
    if c.get("status") != "pending":
        return json_response({"error": "Only a pending application can be approved"}, status=409)
    now = int(time.time())
    collectors_table.update_item(
        Key={"userId": collector_id},
        UpdateExpression="SET #s = :s, verifiedAt = :v, verifiedBy = :b, updatedAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":s": "approved", ":v": now, ":b": claims["sub"], ":t": now},
    )
    notify(collector_id, "approved", "Collector verified",
           "Your collector business account has been approved. You can now quote on paid pickups.",
           {"collector": True})
    c["status"] = "approved"
    c["verifiedAt"] = now
    c["updatedAt"] = now
    return _collector_view(c)


def admin_reject_collector(claims, collector_id, body):
    if not _is_admin(claims):
        return json_response({"error": "Not authorized"}, status=403)
    if not collectors_table:
        return json_response({"error": "Service unavailable"}, status=503)
    c = _get_collector(collector_id)
    if not c:
        return json_response({"error": "Collector not found"}, status=404)
    if c.get("status") != "pending":
        return json_response({"error": "Only a pending application can be rejected"}, status=409)
    reason = _s((body or {}).get("reason"))[:1000]
    now = int(time.time())
    collectors_table.update_item(
        Key={"userId": collector_id},
        UpdateExpression="SET #s = :s, rejectionReason = :r, updatedAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "rejected", ":r": reason, ":t": now},
    )
    notify(collector_id, "rejected", "Verification declined",
           ("Your collector application was declined. " + reason).strip(),
           {"collector": True})
    c["status"] = "rejected"
    c["rejectionReason"] = reason
    c["updatedAt"] = now
    return _collector_view(c)


def admin_suspend_collector(claims, collector_id):
    if not _is_admin(claims):
        return json_response({"error": "Not authorized"}, status=403)
    if not collectors_table:
        return json_response({"error": "Service unavailable"}, status=503)
    c = _get_collector(collector_id)
    if not c:
        return json_response({"error": "Collector not found"}, status=404)
    if c.get("status") != "approved":
        return json_response({"error": "Only an approved collector can be suspended"}, status=409)
    now = int(time.time())
    collectors_table.update_item(
        Key={"userId": collector_id},
        UpdateExpression="SET #s = :s, updatedAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "suspended", ":t": now},
    )
    notify(collector_id, "rejected", "Collector suspended",
           "Your collector business account has been suspended.",
           {"collector": True})
    c["status"] = "suspended"
    c["updatedAt"] = now
    return _collector_view(c)


# ------------------- Prefix dispatchers (/collector/ and /admin/) -----------
# These MUST run IN FRONT of the handler()'s endswith chain: a route such as
# /admin/collectors/{id}/approve would otherwise be captured by
# route.endswith('approve') and mis-routed to approve_request.

def dispatch_collector(claims, route, body):
    if route.endswith("/collector/apply"):
        return collector_apply(claims, body)
    if route.endswith("/collector/submit"):
        return collector_submit(claims, body)
    if route.endswith("/collector/upload-url"):
        return collector_upload_url(claims, body)
    return json_response({"error": "Unsupported route"}, status=400)


def dispatch_collector_get(claims, route):
    if route.endswith("/collector/me"):
        return collector_me(claims)
    return json_response({"error": "Unsupported route"}, status=400)


def dispatch_admin(claims, route, body):
    """POST /admin/collectors/{id}/{action}. Parse the id + action out of the
    path, validate the action, check _is_admin FIRST, then dispatch."""
    parts = route.split("/")  # ['', 'admin', 'collectors', '<id>', '<action>']
    if len(parts) >= 5 and parts[-4] == "admin" and parts[-3] == "collectors":
        collector_id = parts[-2]
        action = parts[-1]
        if action not in ("approve", "reject", "suspend"):
            return json_response({"error": "Unsupported admin action"}, status=400)
        if not _is_admin(claims):
            return json_response({"error": "Not authorized"}, status=403)
        if action == "approve":
            return admin_approve_collector(claims, collector_id)
        if action == "reject":
            return admin_reject_collector(claims, collector_id, body)
        if action == "suspend":
            return admin_suspend_collector(claims, collector_id)
    return json_response({"error": "Unsupported route"}, status=400)


def dispatch_admin_get(claims, route):
    if route.endswith("/admin/collectors"):
        status = request.args.get("status", "pending")
        return admin_list_collectors(claims, status)
    return json_response({"error": "Unsupported route"}, status=400)


def list_requests(claims):
    """Incoming (requests on my items) + outgoing (my own requests)."""
    me = claims["sub"]
    incoming, outgoing = [], []
    if creq_table:
        try:
            r1 = creq_table.query(
                IndexName="ownerIndex",
                KeyConditionExpression=Key("ownerId").eq(me),
                ScanIndexForward=False, Limit=100,
            )
            incoming = r1.get("Items", [])
        except Exception as e:
            logger.error("incoming query error: %s", str(e))
        try:
            r2 = creq_table.query(
                IndexName="collectorIndex",
                KeyConditionExpression=Key("collectorId").eq(me),
                ScanIndexForward=False, Limit=100,
            )
            outgoing = r2.get("Items", [])
        except Exception as e:
            logger.error("outgoing query error: %s", str(e))

    # Owner sees incoming without unlock (they own the data anyway); collector
    # sees outgoing with unlock when approved.
    incoming_views = []
    for cr in incoming:
        v = _creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") in UNLOCK_STATUSES else None)
        v["role"] = "owner"
        v["collectorName"] = cr.get("collectorName", "")
        incoming_views.append(v)
    outgoing_views = []
    for cr in outgoing:
        v = _creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") in UNLOCK_STATUSES else None)
        v["role"] = "collector"
        outgoing_views.append(v)
    return {"incoming": incoming_views, "outgoing": outgoing_views}


# ------------------- Chat -------------------

def _is_member(cr, user_id):
    return user_id in (cr.get("ownerId"), cr.get("collectorId"))


def _chat_enabled(cr):
    # Chat opens once a deal is confirmed and stays available through completion/
    # dispute. Single source of truth is CHAT_STATUSES (== UNLOCK_STATUSES).
    return cr.get("status") in CHAT_STATUSES


def list_conversations(claims):
    """Approved/collected collect-requests the user is part of = their chats."""
    me = claims["sub"]
    convos = {}
    if creq_table:
        for index, key in (("ownerIndex", "ownerId"), ("collectorIndex", "collectorId")):
            try:
                resp = creq_table.query(
                    IndexName=index,
                    KeyConditionExpression=Key(key).eq(me),
                    ScanIndexForward=False, Limit=100,
                )
                for cr in resp.get("Items", []):
                    if not _chat_enabled(cr):
                        continue
                    cid = cr.get("collectRequestId")
                    is_owner = cr.get("ownerId") == me
                    convos[cid] = {
                        "conversationId": cid,
                        "wasteId": cr.get("wasteId"),
                        "wasteType": cr.get("wasteType", ""),
                        "status": cr.get("status"),
                        "otherName": cr.get("collectorName", "") if is_owner else cr.get("ownerName", ""),
                        "role": "owner" if is_owner else "collector",
                        "createdAt": cr.get("createdAt"),
                    }
            except Exception as e:
                logger.error("list_conversations %s error: %s", index, str(e))
    out = sorted(convos.values(), key=lambda c: c.get("createdAt") or 0, reverse=True)
    return {"conversations": out}


def get_messages(claims, cr_id):
    cr = _get_creq(cr_id)
    if not cr or not _is_member(cr, claims["sub"]):
        return json_response({"error": "Not authorized"}, status=403)
    if not _chat_enabled(cr):
        return json_response({"error": "Chat not available yet"}, status=400)
    items = []
    if msg_table:
        try:
            resp = msg_table.query(
                KeyConditionExpression=Key("conversationId").eq(cr_id),
                ScanIndexForward=True, Limit=200,
            )
            items = resp.get("Items", [])
        except Exception as e:
            logger.error("get_messages error: %s", str(e))
    return {"messages": items}


def notif_channel_name(token):
    """Build the per-user realtime notifications channel from its token."""
    return "notifications/" + token


def get_or_create_notify_channel(user_id):
    """Return the user's private realtime notification token, creating it lazily.

    The token is a random, unguessable value (NOT the Cognito sub) persisted on
    the user's UsersTable row under `notifyChannel`. Because the browser subscribes
    with the shared AppSync api key, the channel must not be predictable: a random
    token means a client can only subscribe to its own channel because it can only
    learn its own token behind JWT auth (same de-facto protection chat uses with
    the unguessable collectRequestId). Returns None on any failure so callers fall
    back to pull-only behaviour.
    """
    if not users_table or not user_id:
        return None
    try:
        resp = users_table.get_item(Key={"userId": user_id})
        item = resp.get("Item") or {}
        token = item.get("notifyChannel")
        if token:
            return token
        token = secrets.token_urlsafe(24)
        # update_item with SET creates the row if absent without clobbering an
        # existing profile row's other attributes.
        users_table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET notifyChannel = :t",
            ExpressionAttributeValues={":t": token},
        )
        return token
    except Exception as e:
        logger.error("get_or_create_notify_channel error: %s", str(e))
        return None


def get_notify_channel(claims):
    """Authenticated route handler: return ONLY the caller's own channel token.
    Scoped to claims['sub'] so a client can never learn another user's token."""
    token = get_or_create_notify_channel(claims["sub"])
    return {"channel": token or ""}


def _publish_to_appsync(channel, payload):
    """Publish one event to the AppSync Events HTTP endpoint using the API key."""
    if not APPSYNC_HTTP_DNS or not APPSYNC_API_KEY:
        return
    url = "https://" + APPSYNC_HTTP_DNS + "/event"
    body = json.dumps({
        "channel": channel,
        "events": [json.dumps(payload)],
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", APPSYNC_API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception as e:
        logger.error("AppSync publish error: %s", str(e))


def send_message(claims, body):
    cr_id = _s(body.get("collectRequestId")) or _s(body.get("conversationId"))
    cr = _get_creq(cr_id)
    if not cr or not _is_member(cr, claims["sub"]):
        return json_response({"error": "Not authorized"}, status=403)
    if not _chat_enabled(cr):
        return json_response({"error": "Chat not available yet"}, status=400)

    text = _s(body.get("text"))[:2000]
    if not text:
        return json_response({"error": "Empty message"}, status=400)

    msg = {
        "conversationId": cr_id,
        "createdAt": _now_micros(),
        "messageId": str(uuid.uuid4()),
        "senderId": claims["sub"],
        "senderName": _s(claims.get("name")) or _s(claims.get("email")),
        "text": text,
    }
    if msg_table:
        msg_table.put_item(Item=msg)

    _publish_to_appsync("chat/" + cr_id, msg)

    # Notify the other party of a new message.
    other = cr.get("collectorId") if claims["sub"] == cr.get("ownerId") else cr.get("ownerId")
    notify(other, "message", "New message",
           msg["senderName"] + ": " + (text[:60]),
           {"collectRequestId": cr_id})

    return msg


def _unwrap(result):
    """Routes may return either a plain dict (wrap it) or a Response (pass through)."""
    if isinstance(result, Response):
        return result
    return json_response(result)


@app.route("/", methods=["GET", "POST", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["GET", "POST", "OPTIONS"])
def handler(path):
    if request.method == "OPTIONS":
        return Response("", status=200)

    try:
        claims = verify_token(request)
    except AuthError as e:
        return json_response({"error": str(e)}, status=401)

    try:
        route = "/" + path.strip("/")

        if request.method == "POST":
            body = request.get_json(force=True, silent=True) or {}
            # Prefix dispatch MUST precede the endswith chain so that
            # /admin/collectors/{id}/approve is not captured by endswith('approve').
            if route.startswith("/admin/"):
                return _unwrap(dispatch_admin(claims, route, body))
            if route.startswith("/collector/"):
                return _unwrap(dispatch_collector(claims, route, body))
            if route.endswith("report"):
                return _unwrap(create_report(claims, body))
            if route.endswith("edit"):
                return _unwrap(edit_report(claims, body))
            if route.endswith("request"):
                return _unwrap(request_collect(claims, body))
            if route.endswith("approve"):
                return _unwrap(approve_request(claims, body))
            if route.endswith("reject"):
                return _unwrap(reject_request(claims, body))
            if route.endswith("confirm"):
                return _unwrap(confirm_deal(claims, body))
            if route.endswith("cancel"):
                return _unwrap(cancel_request(claims, body))
            if route.endswith("dispute"):
                return _unwrap(raise_dispute(claims, body))
            if route.endswith("done"):
                return _unwrap(mark_done(claims, body))
            if route.endswith("message"):
                return _unwrap(send_message(claims, body))
            if route.endswith("unsubscribe"):
                return _unwrap(remove_subscription(claims, body))
            if route.endswith("subscribe"):
                return _unwrap(save_subscription(claims, body))
            if route.endswith("notifications/read") or route.endswith("read"):
                return _unwrap(mark_notifications_read(claims))
            return json_response({"error": "Unsupported route"}, status=400)

        # GET
        # Prefix dispatch MUST precede the endswith chain (same collision reason).
        if route.startswith("/collector/"):
            return _unwrap(dispatch_collector_get(claims, route))
        if route.startswith("/admin/"):
            return _unwrap(dispatch_admin_get(claims, route))
        if route.endswith("mine"):
            return _unwrap(list_mine(claims))
        if route.endswith("requests"):
            return _unwrap(list_requests(claims))
        if route.endswith("notifications"):
            return _unwrap(list_notifications(claims))
        if route.endswith("conversations"):
            return _unwrap(list_conversations(claims))
        if route.endswith("messages"):
            cr_id = request.args.get("cr", "")
            return _unwrap(get_messages(claims, cr_id))
        if route.endswith("analytics"):
            return _unwrap(get_analytics(claims))
        if route.endswith("notify-channel"):
            return _unwrap(get_notify_channel(claims))
        return _unwrap(list_public(claims))  # /list or root

    except Exception as e:
        logger.error("Handler error: %s", traceback.format_exc())
        return json_response({"error": str(e)}, status=500)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
