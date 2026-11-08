#!/usr/bin/env bash
# Run the whole stack locally: speech server, LiveKit, game server, radio worker, web client.
# Logs go to logs/*.log. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs data

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if ! grep -q '^ELEVENLABS_API_KEY=.\+' .env 2>/dev/null; then
  echo "· speech: no ElevenLabs key, starting local Kokoro + Whisper (docker, :8008)"
  docker start dead-air-speech >/dev/null 2>&1 || docker run -d --name dead-air-speech -p 8008:8000 \
    -v dead-air-hf:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu >/dev/null
  until curl -sf localhost:8008/health >/dev/null; do sleep 1; done
  curl -sf -X POST localhost:8008/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX >/dev/null || true
  curl -sf -X POST localhost:8008/v1/models/Systran/faster-whisper-base.en >/dev/null || true
fi

echo "· livekit  :7880";  livekit-server --config infra/livekit.dev.yaml > logs/livekit.log 2>&1 & pids+=($!)
echo "· game     :2567";  (cd apps/game && pnpm dev) > logs/game.log 2>&1 & pids+=($!)
sleep 2
echo "· radio    worker"; (cd apps/radio && uv run python -m radio.main dev) > logs/radio.log 2>&1 & pids+=($!)
echo "· web      :5173";  (cd apps/web && pnpm dev) > logs/web.log 2>&1 & pids+=($!)
echo
echo "Open http://localhost:5173 (two tabs = two pilots). tail -f logs/*.log to watch."
wait
