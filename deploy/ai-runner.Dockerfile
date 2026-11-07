FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.167.0
ARG CLAUDE_VERSION=2.1.319
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force
COPY deploy/runner-entrypoint.sh /usr/local/bin/dual-link-runner
RUN chmod 755 /usr/local/bin/dual-link-runner
ENV HOME=/home/ai
USER 1000:1000
WORKDIR /job
ENTRYPOINT ["/usr/local/bin/dual-link-runner"]
