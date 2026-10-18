FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run pack:release

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /build/release/look2-web-*.tgz /tmp/web.tgz
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund /tmp/web.tgz \
    && rm /tmp/web.tgz \
    && mkdir -p /data && chown node:node /data
USER node
ENV QXQY_WORKSPACE=/data
EXPOSE 4174
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4174/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/look2-web/dist/server.js", "--host", "0.0.0.0", "--port", "4174"]
