# DocForge · 本地/Docker 运行（生产模式：Node 服务 + 内置前端）
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8788 DATA_DIR=/data
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
VOLUME ["/data"]
EXPOSE 8788
CMD ["node", "dist-server/index.node.js"]
