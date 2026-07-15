FROM node:22-bookworm-slim

# 固定中国时区：券的「过期」判断依赖本地日期，容器默认 UTC 会偏 8 小时
ENV TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先用 package*.json 利用层缓存，再装依赖（sql.js / tesseract.js 均为纯 JS，无需原生编译）
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# 拷贝源码
COPY . .

# 确保数据与上传目录存在
RUN mkdir -p /app/data/uploads

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
