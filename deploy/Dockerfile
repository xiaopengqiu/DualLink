FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci
COPY apps apps
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.167.0
ARG CLAUDE_VERSION=2.1.319
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data CLI_MODE=native
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/server/src/index.mjs"]
