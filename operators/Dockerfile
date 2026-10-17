# The operators image. Build from the repository root, which holds the npm
# workspaces it depends on:
#
#   docker build -f operators/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace sdk --workspace operators
COPY sdk sdk
COPY operators operators
RUN npm run build --workspace sdk && npm run build --workspace operators

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
RUN npm ci --omit=dev --workspace sdk --workspace operators && npm cache clean --force
COPY --from=build /repo/sdk/dist sdk/dist
COPY --from=build /repo/operators/dist operators/dist
USER node
CMD ["node", "operators/dist/main.js"]
