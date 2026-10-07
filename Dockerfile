FROM node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS build
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
