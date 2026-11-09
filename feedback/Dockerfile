# The feedback endpoint. Build from the repository
# root: `docker build -f feedback/Dockerfile .`. No dependencies and no build step: Node 22 strips the types as it
# loads the files. The base image is the same pin as the site image's build stage. The image job and the pin of the
# result are not written here.
#
# Runs as a non-root user and writes only to /data/inbox (a volume), so the root filesystem can be read-only.
# Port 8080 is the public listener (`POST /feedback`, `GET /healthz`); port 8081 is the internal pull route, which
# no ingress may reach. Configuration is in the environment, see feedback/config.ts.

FROM docker.io/library/node:22-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a
WORKDIR /app
# The files run as written, so the validator is the page's: src/feedback/schema.ts, byte for byte.
COPY src/feedback/schema.ts ./src/feedback/schema.ts
COPY feedback/ ./feedback/
# Tests, their harness and the opener are not part of the endpoint: it holds no private key and cannot open a record.
RUN echo '{"type":"module"}' > package.json \
 && rm -f feedback/*.test.ts feedback/harness.ts feedback/open.ts feedback/Dockerfile \
 && mkdir -p /data/inbox && chown -R node:node /data \
 && chmod -R a+rX /app
USER node
ENV NODE_ENV=production
EXPOSE 8080 8081
VOLUME /data/inbox
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "feedback/main.ts"]
