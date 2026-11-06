FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# viem's abitype lists typescript as an optional peer, so --omit=dev alone would still install it.
RUN npm ci --omit=dev --omit=optional
COPY src/ src/
COPY tokens.json ./

# Node runs the .ts sources directly, so there is no build step.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
