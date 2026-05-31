# Multi-stage build for Phone Order Taker.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/phone-order-taker ./apps/phone-order-taker
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/phone-order-taker
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/phone-order-taker/package.json ./apps/phone-order-taker/package.json
COPY --from=builder /work/apps/phone-order-taker/node_modules ./apps/phone-order-taker/node_modules
COPY --from=builder /work/apps/phone-order-taker/dist ./apps/phone-order-taker/dist
COPY apps/phone-order-taker/server.js ./apps/phone-order-taker/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/phone-order-taker
CMD ["node", "server.js"]
