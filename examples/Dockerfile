# The demo apps' images, one per app (ARCHITECTURE.md, decision 30). Build
# from the repository root, which holds the npm workspaces:
#
#   docker build -f examples/Dockerfile --build-arg APP=notes .
#
# APP is the folder of the app's server: notes, spa-api or worker.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
COPY examples/package.json examples/
RUN npm ci --workspace examples
COPY examples examples
RUN npm run build --workspace examples

FROM node:22-alpine
ARG APP
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY control-plane/package.json control-plane/
COPY operators/package.json operators/
COPY cli/package.json cli/
COPY dashboard/package.json dashboard/
COPY examples/package.json examples/
RUN npm ci --omit=dev --workspace examples && npm cache clean --force
COPY --from=build /repo/examples/dist examples/dist
ENV APP=${APP}
USER 1000:1000
EXPOSE 8080
CMD ["sh", "-c", "exec node examples/dist/$APP/server.js"]
