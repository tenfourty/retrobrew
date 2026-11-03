# The static site image. Base images are pinned by digest. Permissions are set explicitly
# so the image never depends on the builder's umask: nginx runs as UID 101 and must read
# every file. The chmod happens in the build stage because some builders use the legacy
# builder, which has no COPY --chmod.

FROM docker.io/library/node:22-alpine3.23@sha256:baf676f7d0e552f3231945c2f979055ca121bce128c152f7a34e6bd1728b1c5a AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The footer of the public pages names the commit; vite.config.ts reads it from REVISION.
ARG REVISION=unknown
RUN npm test && npm run build && npm run check:assets && chmod -R a+rX dist deploy

FROM docker.io/nginxinc/nginx-unprivileged:1.30.4-alpine@sha256:442753882674b49ae2c1de83ed67896131c0777f56df5005e356e62bc3f7e7ce
COPY --from=build /src/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/deploy/security-headers.conf /etc/nginx/retrobrew/security-headers.conf
COPY --from=build /src/dist/ /usr/share/nginx/html/
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/tenfourty/retrobrew" \
      org.opencontainers.image.revision="${REVISION}"
EXPOSE 8080
