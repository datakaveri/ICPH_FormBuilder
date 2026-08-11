FROM node:22-bookworm

WORKDIR /app

ENV NODE_ENV=development \
    ICPH_FORM_BUILDER_API_PORT=8787

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY form-builder/package*.json ./form-builder/
RUN cd form-builder && npm ci

COPY ODK/tools/requirements-xlsform.txt ./ODK/tools/requirements-xlsform.txt
RUN python3 -m venv ODK/.venv-xlsform \
    && ODK/.venv-xlsform/bin/python -m pip install --upgrade pip \
    && ODK/.venv-xlsform/bin/python -m pip install -r ODK/tools/requirements-xlsform.txt

COPY agentic-entity-mapper/requirements.txt ./agentic-entity-mapper/requirements.txt
RUN python3 -m venv agentic-entity-mapper/.venv \
    && agentic-entity-mapper/.venv/bin/python -m pip install --upgrade pip \
    && agentic-entity-mapper/.venv/bin/python -m pip install -r agentic-entity-mapper/requirements.txt

COPY . .

EXPOSE 5173 8787

WORKDIR /app/form-builder
CMD ["npm", "run", "dev"]
