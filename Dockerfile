FROM node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /app
COPY package.json package-lock.json ./
# viem's abitype lists typescript as an optional peer, so --omit=dev alone would still install it.
RUN npm ci --omit=dev --omit=optional
COPY src/ src/
COPY tokens.json ./

# Node runs the .ts sources directly, so there is no build step.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
