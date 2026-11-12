#!/usr/bin/env bash
set -euo pipefail

# One-command bootstrap for a fresh Google Cloud project.
#
# Usage (from the repository root, or anywhere):
#   PROJECT_ID=your-project-id bash backend/setup.sh
#
# Optional:
#   SA_FILE=sa.json          use an existing service-account JSON
#   POLISH_TOKEN=...         use an existing access token
#   REGION=us-central1       Cloud Run region and default Vertex location
#   MODEL=gemini-3.5-flash   Vertex model
#
# The script creates/uses a service account, grants the two required roles,
# stores the JSON and token in Secret Manager, then deploys Cloud Run.

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your Google Cloud project id}"
REGION="${REGION:-us-central1}"
MODEL="${MODEL:-gemini-3.5-flash}"
SERVICE="${SERVICE:-st-vertex-polish}"
SA_NAME="${SA_NAME:-st-vertex-polish}"
SA_EMAIL="${SA_EMAIL:-$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com}"
SA_FILE="${SA_FILE:-sa.json}"
SA_SECRET="${SA_SECRET:-vertex-sa-key}"
TOKEN_SECRET="${TOKEN_SECRET:-polish-access-token}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Common Cloud Shell flow: the JSON was uploaded to the home directory before
# unzipping the repository, so it sits one level above the repo.
if [[ ! -f "$SA_FILE" && -f "../$SA_FILE" ]]; then
  SA_FILE="../$SA_FILE"
fi

echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo "Model:   $MODEL"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "Enabling APIs..."
gcloud services enable \
  aiplatform.googleapis.com \
  secretmanager.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  echo "Creating service account $SA_EMAIL ..."
  gcloud iam service-accounts create "$SA_NAME" --display-name="ST Vertex Polish"
fi

echo "Granting roles..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/aiplatform.user" >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

if [[ ! -f "$SA_FILE" ]]; then
  echo "No $SA_FILE found; creating a new key for $SA_EMAIL ..."
  if ! gcloud iam service-accounts keys create "$SA_FILE" --iam-account="$SA_EMAIL"; then
    echo "Could not create a service-account key." >&2
    echo "If your organization blocks key creation, upload an existing JSON key as $SA_FILE and rerun." >&2
    exit 1
  fi
  chmod 600 "$SA_FILE" 2>/dev/null || true
fi

echo "Validating $SA_FILE ..."
python3 - "$SA_FILE" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
if data.get("type") != "service_account":
    raise SystemExit("The JSON file must have type=service_account")
if not data.get("client_email") or not data.get("private_key"):
    raise SystemExit("The JSON file is missing client_email or private_key")
print("OK:", data["client_email"])
PY

if ! gcloud secrets describe "$SA_SECRET" >/dev/null 2>&1; then
  gcloud secrets create "$SA_SECRET" --replication-policy=automatic
fi
gcloud secrets versions add "$SA_SECRET" --data-file="$SA_FILE" >/dev/null

if [[ -z "${POLISH_TOKEN:-}" ]]; then
  POLISH_TOKEN="$(openssl rand -base64 48)"
fi
if (( ${#POLISH_TOKEN} < 16 )); then
  echo "POLISH_TOKEN must be at least 16 characters." >&2
  exit 1
fi
if ! gcloud secrets describe "$TOKEN_SECRET" >/dev/null 2>&1; then
  gcloud secrets create "$TOKEN_SECRET" --replication-policy=automatic
fi
printf '%s' "$POLISH_TOKEN" | gcloud secrets versions add "$TOKEN_SECRET" --data-file=- >/dev/null

echo "Deploying Cloud Run..."
PROJECT_ID="$PROJECT_ID" \
REGION="$REGION" \
MODEL="$MODEL" \
SERVICE="$SERVICE" \
RUNTIME_SA="$SA_EMAIL" \
SA_SECRET="$SA_SECRET" \
TOKEN_SECRET="$TOKEN_SECRET" \
bash "$SCRIPT_DIR/deploy.sh"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

echo
echo "============================================================"
echo "Backend URL: $URL"
echo "Access token: $POLISH_TOKEN"
echo "============================================================"
echo "Save both values in a password manager."
echo "The service-account JSON remains in $SA_FILE (gitignored); delete it after setup."
