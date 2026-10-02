# poxy — VLESS/Trojan over WS 代理节点（混淆产物入库）
# 部署流：GitHub Actions 构建镜像 → 目标云平台 run → Cloudflare 反代
# 混淆入口 index.js 由 npm run obfuscate 从 src/index.plain.js 生成（src/ 不入库），诱饵页 index.html 同层

FROM node:20-alpine AS deps
WORKDIR /app
# package.json / package-lock.json 已同步，仅运行时依赖 ws（无 dev deps）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY index.js index.html ./

ENV PORT=3000
EXPOSE 3000/tcp

# UUID / SUB_PATH / SUB_TOKEN / DOMAIN / NAME 由部署平台 env 注入，缺失则 index.js 启动即 exit(1)
CMD ["node", "index.js"]