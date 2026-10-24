FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS build
WORKDIR /app
COPY package.json package-lock.json ./
# viem's abitype lists typescript as an optional peer, so --omit=dev alone would still install it.
RUN npm ci --omit=dev --omit=optional
COPY src/ src/
COPY tokens.json ./

# Node runs the .ts sources directly, so there is no build step.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:044d090d0c3ccfd30722126ebe46704885698970c8a303419dc0d704d628f0da
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
