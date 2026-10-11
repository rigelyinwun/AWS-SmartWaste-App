import json
import logging
import os
import re
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
    lat, lng = dec(body.get("lat")), dec(body.get("lng"))
    if lat is not None and lng is not None:
        item["lat"] = lat
        item["lng"] = lng

    if not item["area"]:
        item["area"] = "Location on request"

    if table:
        table.put_item(Item=item)

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
    if "lat" in item and "lng" in item:
        view["lat"] = item["lat"]
        view["lng"] = item["lng"]
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
    try:
        notif_table.put_item(Item={
            "userId": user_id,
            "createdAt": _now_micros(),
            "notifId": str(uuid.uuid4()),
            "type": ntype,
            "title": title,
            "body": body,
            "meta": meta or {},
            "read": False,
        })
    except Exception as e:
        logger.error("notify error: %s", str(e))

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
    """Shape a collect-request for the client, unlocking owner contact details
    to the collector only when the request is approved."""
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
    if cr.get("status") == "approved" and waste:
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
    waste = _get_waste(waste_id)
    if not waste:
        return json_response({"error": "Waste item not found"}, status=404)
    if waste.get("ownerId") == claims["sub"]:
        return json_response({"error": "You cannot collect your own item"}, status=400)
    # Only items still open can be requested (prevents racing a taken item).
    if waste.get("status") not in ("open", None):
        return json_response({"error": "This item is no longer available"}, status=409)

    now = _now_micros()
    cr = {
        "collectRequestId": str(uuid.uuid4()),
        "wasteId": waste_id,
        "ownerId": waste.get("ownerId"),
        "ownerName": waste.get("ownerName", ""),
        "collectorId": claims["sub"],
        "collectorName": _s(claims.get("name")) or _s(claims.get("email")),
        "status": "requested",
        "createdAt": now,
        "message": _s(body.get("message"))[:500],
        "wasteType": waste.get("wasteType", ""),
        "category": waste.get("category", ""),
        "weight": waste.get("weight", ""),
        "area": waste.get("area", ""),
    }
    if creq_table:
        creq_table.put_item(Item=cr)
    # Mark the waste item as having a pending request (keeps it visible).
    if table:
        table.update_item(
            Key={"requestId": waste_id},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "requested"},
        )
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

    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "approved"},
    )
    if table:
        table.update_item(
            Key={"requestId": cr["wasteId"]},
            UpdateExpression="SET #s = :s, collectorId = :c, collectorName = :cn",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":s": "collecting",
                ":c": cr["collectorId"],
                ":cn": cr.get("collectorName", ""),
            },
        )
    notify(cr["collectorId"], "approved",
           "Request approved",
           "You can now collect " + (cr.get("wasteType") or "the item") +
           ". Address and contact are unlocked.",
           {"collectRequestId": cr_id, "wasteId": cr["wasteId"]})
    cr["status"] = "approved"
    return _creq_view(cr, _get_waste(cr["wasteId"]))


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

    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "rejected"},
    )
    # If no other active request, reopen the waste item.
    if table:
        table.update_item(
            Key={"requestId": cr["wasteId"]},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "open"},
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
    # Either party in the approved request can mark it done.
    if claims["sub"] not in (cr.get("ownerId"), cr.get("collectorId")):
        return json_response({"error": "Not authorized"}, status=403)
    if cr.get("status") != "approved":
        return json_response({"error": "Request is not approved yet"}, status=400)

    creq_table.update_item(
        Key={"collectRequestId": cr_id},
        UpdateExpression="SET #s = :s, completedAt = :t",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "collected", ":t": int(time.time())},
    )
    if table:
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
        v = _creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") == "approved" else None)
        v["role"] = "owner"
        v["collectorName"] = cr.get("collectorName", "")
        incoming_views.append(v)
    outgoing_views = []
    for cr in outgoing:
        v = _creq_view(cr, _get_waste(cr["wasteId"]) if cr.get("status") == "approved" else None)
        v["role"] = "collector"
        outgoing_views.append(v)
    return {"incoming": incoming_views, "outgoing": outgoing_views}


# ------------------- Chat -------------------

def _is_member(cr, user_id):
    return user_id in (cr.get("ownerId"), cr.get("collectorId"))


def _chat_enabled(cr):
    # Chat opens once a request is approved, stays available through completion.
    return cr.get("status") in ("approved", "collected")


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
            if route.endswith("report"):
                return _unwrap(create_report(claims, body))
            if route.endswith("request"):
                return _unwrap(request_collect(claims, body))
            if route.endswith("approve"):
                return _unwrap(approve_request(claims, body))
            if route.endswith("reject"):
                return _unwrap(reject_request(claims, body))
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
        return _unwrap(list_public(claims))  # /list or root

    except Exception as e:
        logger.error("Handler error: %s", traceback.format_exc())
        return json_response({"error": str(e)}, status=500)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
