FROM node:22-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace --prod
COPY src ./src
EXPOSE 4350
CMD ["node", "src/server.mjs"]
