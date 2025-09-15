#!/bin/bash

# Voice Agent 服务器部署脚本
# 目标服务器: 81.70.241.6
# 域名映射: taichujiyuan.online
# 端口: 8787

set -e

echo "=== Voice Agent 服务器部署开始 ==="

# 配置变量
SERVER_IP="81.70.241.6"
DOMAIN="taichujiyuan.online"
APP_PORT="8787"
REPO_URL="https://github.com/IceeFLameY/voice-agent-deployment.git"
APP_DIR="/opt/voice-agent"
SERVICE_NAME="voice-agent"

# 检查是否为root用户
if [ "$EUID" -ne 0 ]; then
    echo "请使用root权限运行此脚本"
    exit 1
fi

echo "1. 更新系统包..."
apt update && apt upgrade -y

echo "2. 安装必要的系统依赖..."
apt install -y curl wget git nginx ufw fail2ban htop

echo "3. 安装 Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

echo "4. 安装 Docker 和 Docker Compose..."
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
systemctl enable docker
systemctl start docker

# 安装 Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

echo "5. 克隆项目代码..."
if [ -d "$APP_DIR" ]; then
    echo "目录已存在，更新代码..."
    cd $APP_DIR
    git pull origin main
else
    echo "克隆新代码..."
    git clone $REPO_URL $APP_DIR
    cd $APP_DIR
fi

echo "6. 配置环境变量..."
cp .env.production .env

# 更新环境变量中的服务器信息
sed -i "s/SERVER_HOST=.*/SERVER_HOST=$SERVER_IP/g" .env
sed -i "s/DOMAIN_NAME=.*/DOMAIN_NAME=$DOMAIN/g" .env
sed -i "s/AUTH_SERVER_PORT=.*/AUTH_SERVER_PORT=$APP_PORT/g" .env

echo "7. 安装项目依赖..."
cd voice_agent
npm install --production

echo "8. 构建前端应用..."
npm run build:prod

echo "9. 配置 Nginx..."
cp ../nginx.conf /etc/nginx/nginx.conf

# 测试 Nginx 配置
nginx -t
if [ $? -eq 0 ]; then
    echo "Nginx 配置验证成功"
else
    echo "Nginx 配置验证失败，请检查配置文件"
    exit 1
fi

echo "10. 配置防火墙..."
ufw --force enable
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow $APP_PORT/tcp

echo "11. 创建 systemd 服务..."
cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=Voice Agent Application
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=$APP_DIR/voice_agent
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

echo "12. 设置文件权限..."
chown -R www-data:www-data $APP_DIR
chmod +x $APP_DIR/deploy.sh

echo "13. 启动服务..."
systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl start $SERVICE_NAME
systemctl restart nginx

echo "14. 检查服务状态..."
sleep 5
if systemctl is-active --quiet $SERVICE_NAME; then
    echo "✅ Voice Agent 服务启动成功"
else
    echo "❌ Voice Agent 服务启动失败"
    systemctl status $SERVICE_NAME
    exit 1
fi

if systemctl is-active --quiet nginx; then
    echo "✅ Nginx 服务运行正常"
else
    echo "❌ Nginx 服务异常"
    systemctl status nginx
    exit 1
fi

echo "15. 配置域名解析提示..."
echo ""
echo "=== 部署完成 ==="
echo "服务器IP: $SERVER_IP"
echo "应用端口: $APP_PORT"
echo "域名: $DOMAIN"
echo ""
echo "请确保域名 $DOMAIN 的 A 记录指向 $SERVER_IP"
echo ""
echo "访问地址:"
echo "- 直接访问: http://$SERVER_IP:$APP_PORT"
echo "- 域名访问: http://$DOMAIN (需要DNS解析生效)"
echo ""
echo "服务管理命令:"
echo "- 查看状态: systemctl status $SERVICE_NAME"
echo "- 重启服务: systemctl restart $SERVICE_NAME"
echo "- 查看日志: journalctl -u $SERVICE_NAME -f"
echo ""
echo "Nginx 管理:"
echo "- 重启: systemctl restart nginx"
echo "- 状态: systemctl status nginx"
echo "- 配置测试: nginx -t"
echo ""
echo "🎉 Voice Agent 部署完成！"