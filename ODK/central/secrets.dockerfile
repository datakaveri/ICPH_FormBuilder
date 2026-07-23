FROM --platform=linux/amd64 node:24.16.0-slim

COPY files/enketo/generate-secrets.sh ./
