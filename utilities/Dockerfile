FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && cp -r src/migrations dist/src/migrations

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY packs ./packs
USER node
EXPOSE 8080
COPY scripts/start.sh ./start.sh
CMD ["sh", "./start.sh"]
