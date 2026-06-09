import json
import boto3
from flask import Flask, request, Response, stream_with_context

app = Flask(__name__)
bedrock = boto3.client("bedrock-runtime", region_name="ap-southeast-1")

MODEL_ID = "global.anthropic.claude-sonnet-4-6-20260217-v1:0"

SYSTEM_PROMPT = """You are an environmental scientist specializing in waste impact analysis, lifecycle assessment (LCA), and climate sustainability. Analyze the waste item shown in the image with optional supporting context from the user description.

Your task is to identify the waste item as accurately as possible and generate a scientifically grounded environmental and climate impact assessment tailored specifically to that item.

The output must be practical, data-informed, and easy for non-experts to understand.

Required Analysis Structure:

Waste Item Identification
* Identify the object/material in the image
* Estimated material composition (plastic type, metal, glass, paper, organic, e-waste, textile, etc.)
* Estimated decomposition time
* Hazard classification:
  * Non-hazardous
  * Potentially hazardous
  * Hazardous waste

Material & Lifecycle Overview
Explain:
* How this item is typically manufactured
* Main raw materials used
* Energy/resource intensity of production
* Whether it is recyclable, compostable, reusable, or landfill-bound
* Common disposal pathways in real-world waste systems

Include estimated:
* Carbon footprint of production (if known)
* Water usage or resource extraction impacts

Environmental Impact
Provide item-specific impacts if improperly disposed of.
Include:
* What happens if this item is littered, burned, dumped, or landfilled
* Short-term vs long-term environmental damage
* Persistence in the environment

Specific Effects:
Land Impact
* Soil contamination
* Microplastic release
* Toxic leaching
* Habitat degradation
* Fire risks (if applicable)

Water Impact
* River/ocean pollution
* Chemical contamination
* Drain blockage/flooding risks
* Marine ecosystem disruption
* Groundwater contamination

Wildlife Impact
* Ingestion risks
* Entanglement risks
* Toxic bioaccumulation
* Food-chain disruption
* Reproductive or behavioral effects on animals

Add:
* Estimated decomposition duration
* Whether the item fragments into microplastics or toxic residues
* Real-world examples or known environmental incidents related to this waste type

Climate Impact
Greenhouse Gas Emissions
Explain emissions associated with:
* Production/manufacturing
* Transportation
* Incineration/open burning
* Landfill decomposition
* Recycling vs non-recycling outcomes

Mention relevant gases such as:
* CO2
* Methane (CH4)
* Nitrous oxide (N2O)
* Black carbon (if burned)

Climate Impact Rating
Classify:
* Low
* Medium
* High

Include:
* Estimated CO2-equivalent impact where possible
* Why this waste item contributes at that level
* Comparison to relatable activities when relevant

Future Impact Insight
Provide a cumulative long-term projection if disposal behavior repeats.
Include:
* Monthly and yearly accumulation examples
* Potential waste volume generated
* Long-term pollution persistence
* Ecosystem burden over time
* Climate consequences over years

Human Health Impact
Analyze potential impacts on people:
* Toxic exposure risks
* Air pollution from burning
* Contaminated food/water pathways
* Respiratory or neurological risks
* Indirect public health consequences

Waste Management Recommendation
Provide realistic disposal guidance specific to the item:
* Recycle / reuse / compost / hazardous disposal
* Correct disposal bin/category
* Whether cleaning/separation is needed before recycling
* Safer alternatives if applicable

Include:
* Most sustainable disposal method
* Circular economy opportunities
* Reusability potential

Educational Insight
Provide 2-3 concise educational facts related specifically to this waste item.

Output Style Requirements:
* Use bullet points
* Be scientifically accurate but understandable to the public
* Avoid generic sustainability advice
* Tailor every explanation specifically to the identified item
* Use concise but information-rich explanations
* Include approximate quantitative estimates where possible
* If uncertain about the object, state confidence level and possible alternatives"""


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
