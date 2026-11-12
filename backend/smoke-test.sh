#!/usr/bin/env bash
set -euo pipefail

# Optional: verify a deployment from Cloud Shell or any machine.
# Usage:
#   BACKEND_URL=https://... POLISH_TOKEN=... bash backend/smoke-test.sh

BACKEND_URL="${BACKEND_URL:?set BACKEND_URL}"
POLISH_TOKEN="${POLISH_TOKEN:?set POLISH_TOKEN}"

echo "Health:"
curl -fsS "$BACKEND_URL/health"
echo

echo "Polish request:"
curl -fsS -X POST "$BACKEND_URL/api/polish" \
  -H "Authorization: Bearer $POLISH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "systemInstruction": "You are a careful line editor. Keep facts and point of view.",
    "prompt": "【待润色正文】\n<TEXT>\n她推开木门，屋里的灯还亮着。\n</TEXT>\n\n请只输出润色后的正文。",
    "temperature": 0.7,
    "topP": 0.9,
    "maxOutputTokens": 512
  }'
echo
