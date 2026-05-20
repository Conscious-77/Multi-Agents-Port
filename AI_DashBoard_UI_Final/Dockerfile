FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
RUN npm install --include=dev --include=optional --no-package-lock

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/dist ./dist

EXPOSE 11004
CMD ["npm", "run", "start"]
