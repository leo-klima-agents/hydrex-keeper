FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# typescript is also an optional peer of viem's abitype, so --omit=dev alone keeps it.
RUN npm ci --omit=dev --omit=optional
COPY src/ src/
COPY tokens.json ./

# No shell, no package manager, non-root. Node runs the .ts sources directly.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:2ee7b2c54a3e37dfc248af81c9f6bcdcaa50abe4af44aa47a3388431031b9283
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
