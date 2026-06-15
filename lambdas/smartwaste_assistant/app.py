import json
import logging
import traceback
import boto3
from flask import Flask, request, Response, stream_with_context

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
bedrock = boto3.client("bedrock-runtime", region_name="ap-southeast-1")

MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

SYSTEM_PROMPT = """You are SmartWaste 2.0, a climate-aware waste intelligence assistant.

Your task is to analyse waste items using:
1. Uploaded waste image
2. Optional waste description
3. Optional user location

You must identify the waste item and provide practical disposal guidance.

Guidelines:
- Use the image as the main source of identification.
- Use the text description only to clarify uncertain items.
- If uncertain, provide the most likely identification and mention uncertainty.
- Keep responses concise, practical, and realistic.
- Avoid generic recycling advice.
- Do not invent exact recycling centres or exact emission numbers unless clearly known.
- Provide environmentally responsible recommendations."""


@app.route("/", methods=["POST", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["POST", "OPTIONS"])
def chat(path):
    if request.method == "OPTIONS":
        return Response("", status=200)

    try:
        data = request.get_json(force=True)
        logger.info("Request received, keys: %s", list(data.keys()))
        message = data.get("message", "")
        history = data.get("history", [])
        file_data = data.get("file_data")
        file_mime = data.get("file_mime")
        description = data.get("description", "")
        location = data.get("location", "")

        messages = []

        for msg in history:
            messages.append({"role": msg["role"], "content": msg["content"]})

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

        prompt_text = message
        if description:
            prompt_text += f"\n\nWaste description: {description}"
        if location:
            prompt_text += f"\n\nUser location: {location}"

        user_content.append({"type": "text", "text": prompt_text})
        messages.append({"role": "user", "content": user_content})

        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            "temperature": 0,
            "system": SYSTEM_PROMPT,
            "messages": messages,
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
