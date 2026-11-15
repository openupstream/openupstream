# The dashboard's image: its static files behind nginx (ARCHITECTURE.md,
# decision 121). Build from the repository root, which holds the npm
# workspaces it depends on:
#
#   docker build -f dashboard/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
COPY examples/package.json examples/
RUN npm ci --workspace sdk --workspace dashboard
COPY sdk sdk
COPY dashboard dashboard
RUN npm run build --workspace sdk && npm run build --workspace dashboard

# Runs as uid 101, listens on 8080 and writes only below /tmp.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY dashboard/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/dashboard/out /usr/share/nginx/html
USER 101:101
EXPOSE 8080
