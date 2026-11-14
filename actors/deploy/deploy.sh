#!/usr/bin/env bash
# Builds the dispatcher bundle and ships it to clevergcp (~/makeo-dev/near-agents). The env file with
# NEAR_AI_API_KEY is copied separately (mode 600) and is never part of this directory.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=$(mktemp -d)
bun build actors/src/dispatch.ts --target bun --outfile "$out/dispatch.js" >/dev/null
cp actors/deploy/Dockerfile actors/deploy/compose.yml "$out/"
ssh clevergcp 'mkdir -p ~/makeo-dev/near-agents && chmod 700 ~/makeo-dev/near-agents'
scp -q "$out/dispatch.js" "$out/Dockerfile" "$out/compose.yml" clevergcp:makeo-dev/near-agents/
ssh clevergcp 'cd ~/makeo-dev/near-agents && docker compose -p near-agents up -d --build && sleep 2 && curl -s 127.0.0.1:18790/health'
