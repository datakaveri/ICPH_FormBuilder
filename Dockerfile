FROM node:24-bookworm-slim AS python-deps

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip libmagic1 openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

COPY ODK/tools/requirements-xlsform.txt /tmp/requirements-xlsform.txt
COPY agentic-entity-mapper/requirements.txt /tmp/requirements-mapper.txt

RUN python3 -m venv /app/ODK/.venv-xlsform \
    && /app/ODK/.venv-xlsform/bin/python -m pip install --upgrade pip \
    && /app/ODK/.venv-xlsform/bin/python -m pip install -r /tmp/requirements-xlsform.txt \
    && python3 -m venv /app/agentic-entity-mapper/.venv \
    && /app/agentic-entity-mapper/.venv/bin/python -m pip install --upgrade pip \
    && /app/agentic-entity-mapper/.venv/bin/python -m pip install -r /tmp/requirements-mapper.txt

FROM node:24-bookworm-slim AS web-build

WORKDIR /app/form-builder

COPY form-builder/package*.json ./
RUN npm ci

COPY form-builder/ ./
ARG VITE_FORM_BUILDER_API=""
RUN VITE_FORM_BUILDER_API="${VITE_FORM_BUILDER_API}" npm run build

FROM python-deps AS runtime

ENV NODE_ENV=production \
    ICPH_FORM_BUILDER_API_PORT=8787 \
    HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY --chown=node:node agentic-entity-mapper/ ./agentic-entity-mapper/
COPY --from=web-build --chown=node:node /app/form-builder/node_modules ./form-builder/node_modules
COPY --from=web-build --chown=node:node /app/form-builder/dist ./form-builder/dist
COPY --chown=node:node form-builder/package.json ./form-builder/package.json
COPY --chown=node:node form-builder/server/ ./form-builder/server/
COPY --chown=node:node form-builder/scripts/ ./form-builder/scripts/

RUN mkdir -p /app/output /app/agentic-entity-mapper/SchemaTerminologies \
    && chown node:node /app/output

USER node
WORKDIR /app/form-builder

EXPOSE 5173 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "Promise.all([fetch('http://127.0.0.1:5173/'), fetch('http://127.0.0.1:8787/api/health')]).then(([web, api]) => process.exit(web.ok && api.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start"]
