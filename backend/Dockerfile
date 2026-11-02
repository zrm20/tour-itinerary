FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci && npm run build && npm prune --omit=dev && \
    mkdir /runtime && cp package.json package-lock.json /runtime/ && \
    mv node_modules dist /runtime/ && npm cache clean --force

FROM node:24.22.2-bookworm-slim AS runtime
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
ENV NODE_ENV=production COMMIT_SHA=$COMMIT_SHA PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
