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

SYSTEM_PROMPT = """You are an expert AI waste management advisor. Based on the waste item shown in the image (with optional context from the user), provide actionable disposal guidance.

Generate a practical action plan covering. Use the exact numbered section headings below and do not remove or rename the numbering:

##Disposal Method
- Recommended method: recycle, compost, landfill, special handling, or combination
- Use bullet points for all recommendations and explanations
- Clear, practical explanation of how to properly dispose of this specific item

##Nearby Disposal Suggestion
- If location is provided: suggest realistic nearby facility types for that region
- If no location provided: state "Location not provided - unable to suggest local facilities. Search your local municipality's website for disposal options."

##Better Alternative
- Suggest a more eco-friendly, reusable, or sustainable alternative to this item
- Keep the suggestion realistic and practical for everyday use

##Action Step
- Provide one clear, simple, immediate action the user can take today

Additional Instructions:
- Be specific to the detected waste item
- Avoid generic advice
- Keep responses brief and easy to read
- Limit each section to 2 to 4 concise bullet points"""


@app.route("/", methods=["POST", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["POST", "OPTIONS"])
def analyze(path):
    if request.method == "OPTIONS":
        return Response("", status=200)

    try:
        data = request.get_json(force=True)
        logger.info("Request received, keys: %s", list(data.keys()))
        description = data.get("description", "")
        location = data.get("location", "")
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

        prompt_text = "Analyze this waste item and provide disposal guidance."
        if description:
            prompt_text += f"\n\nWaste description: {description}"
        if location:
            prompt_text += f"\n\nUser location: {location}"
        else:
            prompt_text += "\n\nNo location provided."

        user_content.append({"type": "text", "text": prompt_text})

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
