# 使用官方 Node.js 镜像作为基础
FROM node:20-slim

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制项目文件
COPY . .

# 设置环境变量
ENV NODE_ENV=production
ENV BAILONGMA_PORT=3721
ENV BAILONGMA_HOST=0.0.0.0
ENV BAILONGMA_ALLOW_LAN=true
ENV BAILONGMA_USER_DIR=/app/data

# 暴露端口
EXPOSE 3721

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:'+process.env.BAILONGMA_PORT+'/status', (r)=>process.exit(r.statusCode==200?0:1)).on('error',()=>process.exit(1))"

# 启动命令
CMD ["node", "--env-file=.env", "src/index.js"]
