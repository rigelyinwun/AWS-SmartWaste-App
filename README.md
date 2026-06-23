# SmartWaste

AI-powered waste analysis and disposal guide. Upload a photo of any waste item and get instant identification, disposal instructions, environmental impact analysis, and chat-based assistance.

## Features

- **Waste Identification** — Analyzes uploaded images to identify material type, category, recyclability, and composition
- **Disposal Guidance** — Provides step-by-step disposal method flowchart, nearby facility suggestions, eco-friendly alternatives, and action steps
- **Environmental Impact** — Comprehensive analysis including decomposition time, land/water/wildlife impacts, climate data, and future projections
- **AI Chat Assistant** — Floating chatbot for follow-up questions about waste disposal, recycling guidelines, and eco-friendly practices
- **Input Validation** — Rejects inappropriate or non-waste images with a user-friendly popup

## Architecture

```
Frontend (S3 + CloudFront)
    ├── index.html / style.css / app.js
    └── Static assets (images)

Backend (AWS Lambda + Lambda Web Adapter)
    ├── waste_details        → Waste identification & validation
    ├── further_actions      → Disposal guidance & recommendations
    ├── environmental_impact → Environmental & climate analysis
    └── smartwaste_assistant → Chat assistant

Infrastructure
    ├── SAM template (infra/template.yaml)
    ├── GitHub Actions CI/CD (.github/workflows/deploy.yml)
    └── CloudFront distribution (HTTPS + caching)
```

## Tech Stack

- **Frontend**: HTML, CSS, JavaScript (vanilla)
- **Backend**: Python 3.12, Flask, AWS Lambda with Lambda Web Adapter (response streaming)
- **AI Model**: Claude Haiku 4.5 via Amazon Bedrock (global inference profile)
- **Infrastructure**: AWS SAM, S3, CloudFront, Lambda Function URLs
- **CI/CD**: GitHub Actions

## Project Structure

```
smartwaste-app/
├── .github/workflows/deploy.yml   # CI/CD pipeline
├── .gitattributes
├── .gitignore
├── README.md
├── frontend/
│   ├── index.html                  # Main page
│   ├── style.css                   # Styles
│   ├── app.js                      # Client logic (streaming, rendering)
│   └── images/
│       ├── logo.png                # App logo
│       ├── landfill.jpg            # Land impact image
│       ├── water.jpeg              # Water impact image
│       └── wildlife.jpg            # Wildlife impact image
├── infra/
│   └── template.yaml              # SAM template
└── lambdas/
    ├── waste_details/
    │   ├── app.py
    │   ├── run.sh
    │   └── requirements.txt
    ├── further_actions/
    │   ├── app.py
    │   ├── run.sh
    │   └── requirements.txt
    ├── environmental_impact/
    │   ├── app.py
    │   ├── run.sh
    │   └── requirements.txt
    └── smartwaste_assistant/
        ├── app.py
        ├── run.sh
        └── requirements.txt
```

## Deployment

### Prerequisites

1. AWS account with Bedrock model access enabled for Claude Haiku 4.5
2. AWS CLI and SAM CLI installed
3. S3 bucket for SAM deployment artifacts
4. GitHub repository with secrets configured

### GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `SAM_DEPLOY_BUCKET` | S3 bucket for SAM artifacts |

### Deploy

Push to `main` branch triggers automatic deployment:

```bash
git push origin main
```

Or trigger manually via GitHub Actions → "Run workflow".

### Manual Deploy

```bash
# Build
sam build --template infra/template.yaml

# Deploy
sam deploy --stack-name smartwaste \
  --s3-bucket YOUR_BUCKET \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --region ap-southeast-1 \
  --no-confirm-changeset

# Get outputs
aws cloudformation describe-stacks --stack-name smartwaste \
  --query "Stacks[0].Outputs" --output table
```

## How It Works

1. User uploads a photo of a waste item
2. Optionally adds a description and location
3. Clicks "Analyze Waste"
4. Frontend validates via the waste_details Lambda (rejects non-waste/inappropriate content)
5. If valid, streams results from all 3 analysis Lambdas simultaneously
6. Results render as structured UI: table, flowchart, image cards, and text sections
7. Chat assistant is available via floating button for follow-up questions

## Model & Region

- **Model**: `global.anthropic.claude-haiku-4-5-20251001-v1:0` (global cross-region inference profile)
- **Region**: `ap-southeast-1` (Singapore)
- **Streaming**: Lambda Function URLs with `RESPONSE_STREAM` invoke mode

## Live URL

- CloudFront: `https://d25ah8hrqybhsg.cloudfront.net`
