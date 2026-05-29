#!/bin/bash

# Bailongma Docker 部署脚本
# 用于 Linux 服务器一键部署

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 颜色输出函数
print_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 Docker 是否安装
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_error "Docker 未安装，请先安装 Docker"
        exit 1
    fi
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        print_error "Docker Compose 未安装，请先安装 Docker Compose"
        exit 1
    fi
    print_success "Docker 和 Docker Compose 已安装"
}

# 检查端口是否被占用
check_port() {
    local port=${1:-3721}
    if command -v netstat &> /dev/null; then
        if netstat -tuln | grep -q ":$port "; then
            print_error "端口 $port 已被占用，请先释放该端口或修改端口配置"
            exit 1
        fi
    elif command -v ss &> /dev/null; then
        if ss -tuln | grep -q ":$port "; then
            print_error "端口 $port 已被占用，请先释放该端口或修改端口配置"
            exit 1
        fi
    fi
    print_success "端口 $port 可用"
}

# 创建环境变量文件
create_env_file() {
    if [ ! -f .env ]; then
        print_info "创建 .env 文件..."
        cat > .env << 'EOF'
# Bailongma 环境配置
NODE_ENV=production
BAILONGMA_PORT=3721
BAILONGMA_HOST=0.0.0.0
BAILONGMA_ALLOW_LAN=true
EOF
        print_success ".env 文件创建成功"
    else
        print_info ".env 文件已存在，跳过创建"
    fi
}

# 构建和启动容器
start_service() {
    print_info "构建并启动服务..."
    if docker-compose version &> /dev/null; then
        docker-compose up -d --build
    else
        docker compose up -d --build
    fi
    print_success "服务已启动"
}

# 显示访问信息
show_access_info() {
    local port=${BAILONGMA_PORT:-3721}
    echo ""
    print_success "=========================================="
    print_success "  Bailongma 部署成功！"
    print_success "=========================================="
    echo ""
    echo "访问地址："
    echo "  本地访问: http://localhost:$port"
    echo "  局域网访问: http://$(hostname -I | awk '{print $1}'):$port"
    echo ""
    echo "常用命令："
    echo "  查看日志: docker-compose logs -f"
    echo "  停止服务: docker-compose down"
    echo "  启动服务: docker-compose up -d"
    echo "  重启服务: docker-compose restart"
    echo ""
}

# 主函数
main() {
    print_info "开始部署 Bailongma..."
    
    check_docker
    check_port
    create_env_file
    start_service
    
    # 等待服务启动
    print_info "等待服务启动..."
    sleep 5
    
    show_access_info
}

main
