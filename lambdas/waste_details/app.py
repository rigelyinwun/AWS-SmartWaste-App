import json
import boto3
from flask import Flask, request, Response, stream_with_context

app = Flask(__name__)
bedrock = boto3.client("bedrock-runtime", region_name="ap-southeast-1")

MODEL_ID = "global.anthropic.claude-sonnet-4-6-20260217-v1:0"

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


@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        return Response("", status=200)


@app.route("/", methods=["POST", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["POST", "OPTIONS"])
def analyze(path):
    data = request.get_json(force=True)
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
        else:
            user_content.append({
                "type": "document",
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

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 4096,
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_content}],
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

    return Response(stream_with_context(generate()), content_type="text/plain; charset=utf-8")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
