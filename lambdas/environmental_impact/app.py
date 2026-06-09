import json
import logging
import traceback
import boto3
from flask import Flask, request, Response, stream_with_context

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
bedrock = boto3.client("bedrock-runtime", region_name="ap-southeast-1")

MODEL_ID = "global.anthropic.claude-sonnet-4-6"

SYSTEM_PROMPT = """You are an environmental scientist specializing in waste impact analysis, lifecycle assessment (LCA), and climate sustainability. Analyze the waste item shown in the image with optional supporting context from the user description.

Your task is to identify the waste item as accurately as possible and generate a scientifically grounded environmental and climate impact assessment tailored specifically to that item.

The output must be practical, data-informed, and easy for non-experts to understand.

Provide analysis covering:
- Waste Item Identification (material, decomposition time, hazard level)
- Material & Lifecycle Overview (manufacturing, raw materials, recyclability)
- Environmental Impact (land, water, wildlife effects if improperly disposed)
- Climate Impact (greenhouse gas emissions, climate impact rating)
- Future Impact Insight (cumulative long-term projections)
- Human Health Impact (toxic exposure, air pollution risks)
- Waste Management Recommendation (proper disposal, alternatives)
- Educational Insight (2-3 concise facts)

Use bullet points. Be scientifically accurate but understandable to the public."""


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

        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 8192,
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
