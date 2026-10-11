import json
import logging
import traceback
import boto3
from flask import Flask, request, Response

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
bedrock = boto3.client("bedrock-runtime", region_name="ap-southeast-1")

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

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

SYSTEM_PROMPT = """You are an environmental scientist specializing in waste impact analysis and lifecycle assessment. Analyze the waste item in the image (with optional user description) and produce a concise, data-informed impact assessment for a general audience.

Respond with ONLY a single valid JSON object and nothing else — no markdown, no code fences, no commentary. Use EXACTLY this shape and these keys:

{
  "waste_identification": {
    "item_type": "<what the item is, brief>",
    "material": "<primary material(s), brief>",
    "hazard_level": "<Low, Moderate, or High — with 2-5 word reason>"
  },
  "estimated_decomposition_time": "<e.g. '1-5 years', '450 years', 'Non-biodegradable'>",
  "landfill_percentage": <integer 0-100: rough % of this waste type that ends up in landfill>,
  "landfill_percentage_note": "<one short sentence of context for that number>",
  "land_impact":        { "summary": "<=12 words", "details": ["<short stat/fact>", "..."] },
  "water_impact":       { "summary": "<=12 words", "details": ["...", "..."] },
  "wildlife_impact":    { "summary": "<=12 words", "details": ["...", "..."] },
  "climate_impact":     { "summary": "<=12 words", "details": ["...", "..."] },
  "health_impact":      { "summary": "<=12 words", "details": ["...", "..."] },
  "recycle_value":      { "summary": "<=12 words", "details": ["...", "..."] },
  "future_impact":      { "summary": "<=12 words", "details": ["...", "..."] },
  "best_practices":     { "summary": "<=12 words", "details": ["...", "..."] },
  "educational_insights":{ "summary": "<=12 words", "details": ["...", "..."] }
}

Rules:
- Keep it SHORT. Each "summary" is a single phrase (<=12 words). Each "details" array has 2-4 bullet strings, each a brief fact — prefer concrete numbers/statistics where realistic (liters, kg CO2, %, years).
- "recycle_value" = circular-economy / recycling value of the item.
- "future_impact" = cumulative long-term projection if disposed improperly.
- "best_practices" = how to dispose/reduce properly.
- "educational_insights" = 2-3 surprising, memorable facts.
- Tailor everything to the specific detected item. Be scientifically plausible.
- landfill_percentage must be a JSON number (integer), not a string.
- Output must be parseable by json.loads with no surrounding text."""

REJECTION_MESSAGE = "⚠️ The uploaded image or description is not suitable for waste analysis. Please upload a clear photo of a waste item (e.g., plastic bottle, food packaging, electronics) and avoid inappropriate content. Try again with a relevant image."

# Impact sections rendered as flip cards (order matters for the UI grid).
IMPACT_SECTIONS = [
    "land_impact", "water_impact", "wildlife_impact",
    "climate_impact", "health_impact", "recycle_value",
    "future_impact", "best_practices", "educational_insights",
]


def normalize_impact(raw_text):
    """Parse the model output into the fixed environmental-impact schema.
    Always returns a dict with every expected key populated."""
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    parsed = {}
    try:
        parsed = json.loads(text)
    except Exception:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
            except Exception:
                logger.warning("Could not parse environmental impact JSON")
                parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}

    # Waste identification
    wi = parsed.get("waste_identification")
    if not isinstance(wi, dict):
        wi = {}
    waste_identification = {
        "item_type": str(wi.get("item_type") or "N/A").strip(),
        "material": str(wi.get("material") or "N/A").strip(),
        "hazard_level": str(wi.get("hazard_level") or "N/A").strip(),
    }

    # Landfill percentage -> clamped int or None
    landfill = parsed.get("landfill_percentage")
    try:
        landfill = int(round(float(landfill)))
        landfill = max(0, min(100, landfill))
    except (TypeError, ValueError):
        landfill = None

    def section(key):
        s = parsed.get(key)
        if not isinstance(s, dict):
            s = {}
        summary = str(s.get("summary") or "").strip()
        details = s.get("details")
        if isinstance(details, str):
            details = [details]
        if not isinstance(details, list):
            details = []
        details = [str(d).strip() for d in details if str(d).strip()]
        return {"summary": summary, "details": details}

    result = {
        "waste_identification": waste_identification,
        "estimated_decomposition_time": str(parsed.get("estimated_decomposition_time") or "N/A").strip(),
        "landfill_percentage": landfill,
        "landfill_percentage_note": str(parsed.get("landfill_percentage_note") or "").strip(),
    }
    for key in IMPACT_SECTIONS:
        result[key] = section(key)
    return result


def validate_input(user_content):
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 10,
        "temperature": 0,
        "messages": [{"role": "user", "content": user_content + [{"type": "text", "text": VALIDATION_PROMPT}]}],
    }
    try:
        response = bedrock.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        result = json.loads(response["body"].read())
        reply = result.get("content", [{}])[0].get("text", "").strip().upper()
        logger.info("Validation result: %s", reply)
        return "VALID" in reply
    except Exception as e:
        logger.error("Validation error: %s", str(e))
        # Fail closed: reject when validation cannot be completed.
        return False


@app.route("/", methods=["POST", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["POST", "OPTIONS"])
def analyze(path):
    if request.method == "OPTIONS":
        return Response("", status=200)

    try:
        data = request.get_json(force=True)
        logger.info("Request received, keys: %s", list(data.keys()))
        description = data.get("description", "")
        file_data = data.get("file_data")
        file_mime = data.get("file_mime")

        user_content = []

        if file_data and file_mime:
            if file_mime.startswith("image/"):
                user_content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": file_mime,
                        "data": file_data,
                    },
                })

        prompt_text = "Analyze this waste item and provide a comprehensive environmental impact assessment."
        if description:
            prompt_text += f"\n\nAdditional description: {description}"

        user_content.append({"type": "text", "text": prompt_text})

        # Validate input
        if not validate_input(user_content):
            return Response(REJECTION_MESSAGE, content_type="text/plain; charset=utf-8")

        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 8192,
            "temperature": 0,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_content}],
        }

        logger.info("Calling Bedrock model: %s", MODEL_ID)

        response = bedrock.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        result = json.loads(response["body"].read())
        raw_text = result.get("content", [{}])[0].get("text", "").strip()

        payload = normalize_impact(raw_text)
        return Response(
            json.dumps(payload),
            content_type="application/json; charset=utf-8",
        )

    except Exception as e:
        logger.error("Error in analyze: %s", traceback.format_exc())
        return Response(f"Error: {str(e)}", status=500, content_type="text/plain")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
