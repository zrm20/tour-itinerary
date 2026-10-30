FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.2-bookworm-slim AS runtime
ARG COMMIT_SHA
LABEL org.opencontainers.image.revision=$COMMIT_SHA
ENV NODE_ENV=production COMMIT_SHA=$COMMIT_SHA PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
