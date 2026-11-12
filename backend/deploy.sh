#!/usr/bin/env bash
set -euo pipefail

# Deploy the backend to Cloud Run.
# Required: PROJECT_ID, a service-account JSON already stored in Secret Manager,
# and an access token already stored in Secret Manager.
#
# Example:
#   PROJECT_ID=my-project bash backend/deploy.sh

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-st-vertex-polish}"
MODEL="${MODEL:-gemini-3.8-flash}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
RUNTIME_SA="${RUNTIME_SA:-st-vertex-polish@$PROJECT_ID.iam.gserviceaccount.com}"
SA_SECRET="${SA_SECRET:-vertex-sa-key}"
TOKEN_SECRET="${TOKEN_SECRET:-polish-access-token}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE"
echo "Model:    $MODEL"
echo "Vertex:   $VERTEX_LOCATION"
echo "Runtime:  $RUNTIME_SA"

gcloud config set project "$PROJECT_ID" >/dev/null

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com

if ! gcloud secrets describe "$SA_SECRET" >/dev/null 2>&1; then
  echo "Missing secret: $SA_SECRET" >&2
  echo "Create it first, for example:" >&2
  echo "  gcloud secrets create $SA_SECRET --replication-policy=automatic" >&2
  echo "  gcloud secrets versions add $SA_SECRET --data-file=sa.json" >&2
  exit 1
fi

if ! gcloud secrets describe "$TOKEN_SECRET" >/dev/null 2>&1; then
  echo "Missing secret: $TOKEN_SECRET" >&2
  echo "Create it first, for example:" >&2
  echo "  printf '%s' \"\$POLISH_TOKEN\" | gcloud secrets create $TOKEN_SECRET --data-file=-" >&2
  exit 1
fi

gcloud run deploy "$SERVICE" \
  --source ./backend \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --service-account "$RUNTIME_SA" \
  --max-instances 1 \
  --concurrency 1 \
  --timeout 90 \
  --memory 256Mi \
  --cpu 1 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$VERTEX_LOCATION,VERTEX_MODEL=$MODEL,VERTEX_API_VERSION=${VERTEX_API_VERSION:-v1},MAX_INPUT_CHARS=20000,MAX_OUTPUT_TOKENS=8192,DAILY_LIMIT=100,MIN_INTERVAL_MS=3000" \
  --set-secrets "/secrets/sa.json=$SA_SECRET:latest,POLISH_ACCESS_TOKEN=$TOKEN_SECRET:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Backend URL: $URL"
echo "Health check: curl -fsS \"$URL/health\""
