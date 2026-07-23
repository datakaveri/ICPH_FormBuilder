#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../central"

if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
fi

export DOCKER_DEFAULT_PLATFORM="${DOCKER_DEFAULT_PLATFORM:-linux/amd64}"

if [[ ! -f .env ]]; then
  echo "Missing central/.env. Create it from .env.template first." >&2
  exit 1
fi

if [[ ! -e server/.git ]]; then
  echo "Missing initialized Central backend submodule at central/server." >&2
  echo "Run this first:" >&2
  echo "  cd /Users/NIKITA/Desktop/IISc_CDPG/ICPH/ODK/central" >&2
  echo "  git submodule update --init --recursive" >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "Missing Docker Buildx plugin." >&2
  echo "This local Apple Silicon setup needs Buildx to build linux/amd64 Central images." >&2
  echo "Install and link it with:" >&2
  echo "  brew install docker-buildx" >&2
  echo "  mkdir -p ~/.docker/cli-plugins" >&2
  echo "  ln -sfn /opt/homebrew/opt/docker-buildx/bin/docker-buildx ~/.docker/cli-plugins/docker-buildx" >&2
  echo "  docker buildx version" >&2
  exit 1
fi

echo "Using Docker platform: $DOCKER_DEFAULT_PLATFORM"
for service in secrets postgres14 postgres service nginx enketo; do
  echo "Building service image: $service"
  docker-compose build "$service"
done
docker-compose up -d
docker-compose ps
