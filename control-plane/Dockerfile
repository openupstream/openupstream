# The control-plane image. Build from the repository root, which holds the npm
# workspaces it depends on:
#
#   docker build -f control-plane/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
COPY examples/package.json examples/
RUN npm ci --workspace sdk --workspace control-plane
COPY sdk sdk
COPY control-plane control-plane
RUN npm run build --workspace sdk && npm run build --workspace control-plane

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
COPY examples/package.json examples/
RUN npm ci --omit=dev --workspace sdk --workspace control-plane && npm cache clean --force
COPY --from=build /repo/sdk/dist sdk/dist
COPY --from=build /repo/control-plane/dist control-plane/dist
COPY --from=build /repo/control-plane/migrations control-plane/migrations
# The node user, by uid: runAsNonRoot can only check a numeric user.
USER 1000:1000
EXPOSE 8080 8081
CMD ["node", "control-plane/dist/index.js"]
