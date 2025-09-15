#!/bin/bash

# 部署脚本 - Voice Agent 应用
# 服务器: 81.70.241.6
# 域名: taichujiyuan.online
# 端口: 8787

set -e

echo "开始部署 Voice Agent 应用..."

# 检查 Node.js 版本
if ! command -v node &> /dev/null; then
    echo "安装 Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "Node.js 版本: $(node --version)"
echo "npm 版本: $(npm --version)"

# 创建应用目录
APP_DIR="/opt/voice_agent"
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

# 进入应用目录
cd $APP_DIR

# 如果是 Git 仓库，拉取最新代码
if [ -d ".git" ]; then
    echo "拉取最新代码..."
    git pull origin main
else
    echo "请确保代码已上传到此目录"
fi

# 安装依赖
echo "安装依赖..."
npm install

# 构建生产版本
echo "构建应用..."
npm run build:prod

# 创建 systemd 服务文件
echo "创建 systemd 服务..."
sudo tee /etc/systemd/system/voice-agent.service > /dev/null <<EOF
[Unit]
Description=Voice Agent Application
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=8787
Environment=AUTH_SERVER_PORT=8787

[Install]
WantedBy=multi-user.target
EOF

# 重新加载 systemd 并启动服务
echo "启动服务..."
sudo systemctl daemon-reload
sudo systemctl enable voice-agent
sudo systemctl restart voice-agent

# 检查服务状态
echo "检查服务状态..."
sudo systemctl status voice-agent --no-pager

# 配置 Nginx 反向代理
echo "配置 Nginx..."
sudo tee /etc/nginx/sites-available/voice-agent > /dev/null <<EOF
server {
    listen 80;
    server_name taichujiyuan.online www.taichujiyuan.online;
    
    location / {
        proxy_pass http://localhost:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        # WebSocket 支持
        proxy_set_header Sec-WebSocket-Extensions \$http_sec_websocket_extensions;
        proxy_set_header Sec-WebSocket-Key \$http_sec_websocket_key;
        proxy_set_header Sec-WebSocket-Version \$http_sec_websocket_version;
    }
    
    # 静态文件缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)\$ {
        proxy_pass http://localhost:8787;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

# 启用站点
sudo ln -sf /etc/nginx/sites-available/voice-agent /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# 测试 Nginx 配置
echo "测试 Nginx 配置..."
sudo nginx -t

# 重启 Nginx
echo "重启 Nginx..."
sudo systemctl restart nginx
sudo systemctl enable nginx

# 配置防火墙
echo "配置防火墙..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8787/tcp
sudo ufw --force enable

echo "部署完成！"
echo "应用运行在: http://taichujiyuan.online"
echo "本地端口: http://localhost:8787"
echo "服务状态: sudo systemctl status voice-agent"
echo "查看日志: sudo journalctl -u voice-agent -f"
