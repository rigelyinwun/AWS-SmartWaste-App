import json
import logging
import traceback
import boto3
from flask import Flask, request, Response, stream_with_context

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

SYSTEM_PROMPT = """You are an expert AI waste analyst. Your job is to analyze the image provided. Using the optional context from the user description, output a professional waste analysis in the following format:

##Waste Identification
Item Name: Precise identification of the object.
Category: (e.g., Plastic, Organic, Metal, Paper, E-waste, Glass, Textile, Hazardous, or Mixed).
Confidence Level: High, Medium, or Low (with a brief reason).
Recyclability: State if it is Fully, Partially, or Not Recyclable.

##Technical Specs
Estimated Weight: A realistic rough estimate (e.g., 50g, 1kg) based on the item type.
Material Composition: Briefly explain what materials this item is likely made of.

Please be highly specific. If the image is unclear, acknowledge the uncertainty."""

REJECTION_MESSAGE = "⚠️ The uploaded image or description is not suitable for waste analysis. Please upload a clear photo of a waste item (e.g., plastic bottle, food packaging, electronics) and avoid inappropriate content. Try again with a relevant image."


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

        def generate():
            try:
                response = bedrock.invoke_model_with_response_stream(
                    modelId=MODEL_ID,
                    contentType="application/json",
                    accept="application/json",
                    body=json.dumps(body),
                )
                for event in response["body"]:
                    chunk = json.loads(event["chunk"]["bytes"])
                    if chunk.get("type") == "content_block_delta":
                        delta = chunk.get("delta", {})
                        if delta.get("type") == "text_delta":
                            yield delta["text"]
            except Exception as e:
                logger.error("Error in generate: %s", traceback.format_exc())
                yield f"\n\nERROR: {str(e)}"

        return Response(stream_with_context(generate()), content_type="text/plain; charset=utf-8")

    except Exception as e:
        logger.error("Error in analyze: %s", traceback.format_exc())
        return Response(f"Error: {str(e)}", status=500, content_type="text/plain")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
