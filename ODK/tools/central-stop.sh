#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../central"
if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi
docker-compose down
