# Bailongma 部署指南

本指南介绍如何在 Linux 服务器上使用 Docker 部署 Bailongma。

## 前置要求

- Docker 20.10+ 或更高版本
- Docker Compose 2.0+ 或更高版本
- 至少 2GB 可用内存
- 至少 10GB 可用磁盘空间

## 快速开始

### 方法一：一键部署脚本（推荐）

```bash
# 克隆项目
git clone <your-repo-url>
cd bailongma

# 运行部署脚本
chmod +x docker-deploy.sh
./docker-deploy.sh
```

### 方法二：手动部署

```bash
# 克隆项目
git clone <your-repo-url>
cd bailongma

# 创建并编辑环境变量文件
cp .env.example .env  # 如果有 .env.example 的话，或者手动创建

# 使用 Docker Compose 构建并启动
docker-compose up -d --build

# 查看日志
docker-compose logs -f
```

## 访问应用

部署成功后，可通过以下地址访问：

- 本地访问：http://localhost:3721
- 局域网访问：http://<服务器IP>:3721

首次访问时，请打开 `/activation` 页面配置 API 密钥。

## 环境变量配置

可以通过修改 `.env` 文件或 `docker-compose.yml` 中的环境变量来配置应用：

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| NODE_ENV | production | Node.js 运行环境 |
| BAILONGMA_PORT | 3721 | 服务端口 |
| BAILONGMA_HOST | 0.0.0.0 | 监听地址 |
| BAILONGMA_ALLOW_LAN | true | 是否允许局域网访问 |
| BAILONGMA_API_TOKEN | - | API 访问令牌（可选，用于增强安全性） |

## 数据持久化

Docker 容器使用以下卷进行数据持久化：

- `bailongma_data`: 存储数据库和配置文件
- `bailongma_sandbox`: 存储沙箱文件

数据卷会在容器删除后保留，除非手动删除。

## 常用命令

### 基本操作

```bash
# 启动服务
docker-compose up -d

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看日志
docker-compose logs -f

# 查看服务状态
docker-compose ps
```

### 更新版本

```bash
# 拉取最新代码
git pull

# 重新构建并启动
docker-compose up -d --build
```

### 备份数据

```bash
# 备份数据卷
docker run --rm -v bailongma_data:/data -v $(pwd):/backup alpine tar czf /backup/bailongma_data_backup_$(date +%Y%m%d).tar.gz -C /data .

# 备份沙箱文件
docker run --rm -v bailongma_sandbox:/sandbox -v $(pwd):/backup alpine tar czf /backup/bailongma_sandbox_backup_$(date +%Y%m%d).tar.gz -C /sandbox .
```

### 恢复数据

```bash
# 恢复数据卷
docker run --rm -v bailongma_data:/data -v $(pwd):/backup alpine tar xzf /backup/bailongma_data_backup_20240101.tar.gz -C /data

# 恢复沙箱文件
docker run --rm -v bailongma_sandbox:/sandbox -v $(pwd):/backup alpine tar xzf /backup/bailongma_sandbox_backup_20240101.tar.gz -C /sandbox
```

## 安全建议

1. **设置访问令牌**：在生产环境中，建议设置 `BAILONGMA_API_TOKEN` 环境变量来保护 API 接口
2. **使用反向代理**：建议使用 Nginx 或 Caddy 作为反向代理，配置 HTTPS
3. **防火墙配置**：仅开放必要的端口（3721），限制访问来源
4. **定期备份**：建议配置定期备份策略

## 故障排查

### 容器无法启动

```bash
# 查看容器日志
docker-compose logs bailongma

# 检查端口占用
sudo netstat -tuln | grep 3721
```

### 健康检查失败

```bash
# 检查容器状态
docker-compose ps

# 进入容器调试
docker-compose exec bailongma bash
```

### 数据丢失

检查数据卷是否正确挂载：

```bash
docker volume ls | grep bailongma
```

## 技术支持

如有问题，请查看项目 README 或提交 Issue。
