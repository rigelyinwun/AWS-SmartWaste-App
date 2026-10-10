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

SYSTEM_PROMPT = """You are an expert AI waste analyst. Analyze the image provided, using the optional user description as context.

Respond with ONLY a single valid JSON object and nothing else — no markdown, no code fences, no commentary before or after. The JSON object must have EXACTLY these keys:

{
  "category": "The waste category, e.g. Plastic, Organic, Metal, Paper, E-waste, Glass, Textile, Hazardous, or Mixed",
  "confidence_level": "High, Medium, or Low — followed by a brief reason in parentheses",
  "description": "A concise identification of the item (what it is)",
  "estimated_weight": "A realistic rough estimate with units, e.g. 50g or 1kg",
  "recyclability": "Fully Recyclable, Partially Recyclable, or Not Recyclable",
  "material_composition": "A brief explanation of what materials the item is likely made of"
}

Rules:
- Every value must be a plain string.
- Be specific. If the image is unclear, reflect that in the confidence_level and description.
- Do not add, rename, or omit any keys.
- Output must be parseable by json.loads with no surrounding text."""

REJECTION_MESSAGE = "⚠️ The uploaded image or description is not suitable for waste analysis. Please upload a clear photo of a waste item (e.g., plastic bottle, food packaging, electronics) and avoid inappropriate content. Try again with a relevant image."

# Fixed set of fields returned to the frontend, in display order.
DETAIL_FIELDS = [
    "category",
    "confidence_level",
    "description",
    "estimated_weight",
    "recyclability",
    "material_composition",
]


def parse_details_json(raw_text):
    """Extract a JSON object from the model output and normalize it to the
    fixed DETAIL_FIELDS schema. Always returns a dict with every expected key."""
    parsed = {}
    text = raw_text.strip()

    # Strip markdown code fences if the model wrapped the JSON.
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()

    # Try direct parse first, then fall back to the first {...} block.
    try:
        parsed = json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                parsed = json.loads(text[start:end + 1])
            except Exception:
                logger.warning("Could not parse details JSON from model output")
                parsed = {}

    if not isinstance(parsed, dict):
        parsed = {}

    # Normalize to the fixed schema; coerce every value to a trimmed string.
    normalized = {}
    for key in DETAIL_FIELDS:
        value = parsed.get(key, "")
        if value is None:
            value = ""
        normalized[key] = str(value).strip() or "N/A"

    return normalized


def validate_input(user_content):
    """Check if the image/description is appropriate for waste analysis."""
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
        # If validation fails, allow through (fail open)
        return True


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
            logger.info("File received: mime=%s, data_length=%d", file_mime, len(file_data))
            if file_mime.startswith("image/"):
                user_content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": file_mime,
                        "data": file_data,
                    },
                })

        prompt_text = "Analyze this waste item."
        if description:
            prompt_text += f"\n\nAdditional description: {description}"

        user_content.append({"type": "text", "text": prompt_text})

        # Validate input
        if not validate_input(user_content):
            return Response(REJECTION_MESSAGE, content_type="text/plain; charset=utf-8")

        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
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

        details = parse_details_json(raw_text)
        return Response(
            json.dumps(details),
            content_type="application/json; charset=utf-8",
        )

    except Exception as e:
        logger.error("Error in analyze: %s", traceback.format_exc())
        return Response(f"Error: {str(e)}", status=500, content_type="text/plain")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
