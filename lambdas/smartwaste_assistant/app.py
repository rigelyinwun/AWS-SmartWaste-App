import json
import boto3
from flask import Flask, request, Response, stream_with_context

app = Flask(__name__)
bedrock = boto3.client("bedrock-runtime", region_name="ap-southeast-1")

MODEL_ID = "global.anthropic.claude-sonnet-4-6-20260217-v1:0"

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
- Avoid overly long explanations.
- Do not invent exact recycling centres or exact emission numbers unless clearly known.
- Provide environmentally responsible recommendations.

If a location is provided:
- Suggest realistic nearby disposal options or facility types.

If location is not provided:
- Give general disposal guidance only.

Always generate output using this structure:

# Waste Identification
- Name:
- Category:
- Confidence Level:

# Recyclability Level
- Level:
- Explanation:

# Estimated Weight
- Approximate Weight:

# Disposal Method
- Recommended Method:
- Why:

# Nearby Disposal Suggestion
- Suggestion:

# Environmental Impact
- Land Impact:
- Water Impact:
- Wildlife Impact:

# Climate Impact
- Emissions:
- Impact Rating:
- Explanation:

# Better Alternative
- Suggested Alternative:

# Action Step
- Immediate Action:

# Future Impact Insight
- Long-Term Effect:

Example references:
- Plastic bottle -> Recycling bin
- Food scraps -> Compost
- Battery -> E-waste collection
- Styrofoam -> Usually landfill"""


def build_cors_headers():
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
    }


@app.route("/", methods=["OPTIONS"])
def options():
    return Response("", status=200, headers=build_cors_headers())


@app.route("/", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    message = data.get("message", "")
    history = data.get("history", [])
    file_data = data.get("file_data")
    file_mime = data.get("file_mime")
    description = data.get("description", "")
    location = data.get("location", "")

    messages = []

    # Add conversation history
    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    # Build new user message content
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
        else:
            user_content.append({
                "type": "document",
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

    def generate():
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

    headers = build_cors_headers()
    headers["Content-Type"] = "text/plain; charset=utf-8"
    return Response(stream_with_context(generate()), headers=headers)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
