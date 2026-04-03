FROM mcr.microsoft.com/playwright:v1.57.0-noble AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json tsup.config.ts ./
RUN pnpm install --frozen-lockfile \
  && pnpm rebuild better-sqlite3 esbuild

COPY src ./src
COPY sources ./sources
COPY README.md ./

RUN pnpm build && pnpm prune --prod

FROM mcr.microsoft.com/playwright:v1.57.0-noble

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/sources ./sources

ENTRYPOINT ["node", "./dist/cli.js"]
CMD ["daemon"]
