# syntax=docker/dockerfile:1
#
# Self-host the KernelCMS example (authors, posts, media, settings) in one command.
# Build:  docker build -t kernelcms .
# Run:    docker run -p 3000:3000 -e KERNEL_SECRET=your-secret -v kernel-data:/app/data kernelcms
# Then open http://localhost:3000/admin

FROM node:24-slim AS base
RUN corepack enable
WORKDIR /app

# --- Build: install dependencies and embed the admin bundle ---
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @kernel/admin-app build \
  && node packages/server/scripts/embed-admin.mjs

# --- Runtime ---
FROM base AS runtime
ENV NODE_ENV=production
# Persist the SQLite database on a mounted volume.
ENV KERNEL_DB_URL=file:/app/data/content.db
ENV PORT=3000
COPY --from=build /app /app
EXPOSE 3000
VOLUME ["/app/data"]

# Apply migrations, then serve. Provide KERNEL_SECRET at runtime (see .env.example).
CMD ["sh", "-c", "mkdir -p /app/data && pnpm kernel migrate --config examples/blog/kernel.config.ts && pnpm kernel start --config examples/blog/kernel.config.ts --port 3000"]
