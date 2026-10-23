FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    FILE_SERVER_PORT=8790

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/

USER node

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8790/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
