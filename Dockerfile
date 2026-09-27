FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ src/
COPY pools.json ./

# No shell, no package manager, non-root. Node 24 runs the .ts sources as they are.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
COPY --from=build /app /app
ENTRYPOINT ["/nodejs/bin/node", "src/main.ts"]
