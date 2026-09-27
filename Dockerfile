FROM node:26-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY src/ src/
COPY pools.json ./

# No shell, no package manager, non-root. Node runs the .ts sources as they are.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:afc6657a4b662f9cb69ca892b0596e55d6ef81a10e83ee8887b13f602877df89
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
