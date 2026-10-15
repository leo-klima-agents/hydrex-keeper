FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# typescript is also an optional peer of viem's abitype, so --omit=dev alone keeps it.
RUN npm ci --omit=dev --omit=optional
COPY src/ src/
COPY tokens.json ./

# No shell, no package manager, non-root. Node runs the .ts sources directly.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:044d090d0c3ccfd30722126ebe46704885698970c8a303419dc0d704d628f0da
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
