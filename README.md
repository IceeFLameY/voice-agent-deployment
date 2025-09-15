# Voice Agent 部署项目

这是一个 Voice Agent 应用的部署项目，用于部署到服务器 81.70.241.6，映射到域名 taichujiyuan.online。

## 项目结构

- `voice_agent/` - 主要的 Voice Agent 应用代码
- `deploy.sh` - 服务器部署脚本
- `docker-compose.yml` - Docker 容器编排配置
- `nginx.conf` - Nginx 反向代理配置
- `.env.production` - 生产环境配置文件

## 部署说明

### 服务器信息
- 服务器IP: 81.70.241.6
- 域名: taichujiyuan.online
- 端口: 8787

### 快速部署

1. 克隆仓库到服务器:
```bash
git clone https://github.com/IceeFLameY/voice-agent-deployment.git
cd voice-agent-deployment
```

2. 运行部署脚本:
```bash
chmod +x deploy.sh
./deploy.sh
```

### Docker 部署

```bash
docker-compose up -d
```

### 环境配置

复制 `.env.production` 文件并根据实际情况修改配置:
```bash
cp .env.production voice_agent/.env
```

## 功能特性

- 基于 Vue 3 + Vite 构建
- 支持实时语音交互
- 集成支付功能（微信支付、支付宝）
- 邮件和短信通知
- JWT 身份验证
- Nginx 反向代理
- Docker 容器化部署

## 访问地址

部署完成后，可通过以下地址访问:
- 主域名: http://taichujiyuan.online
- 直接端口: http://81.70.241.6:8787

## 技术栈

- 前端: Vue 3, Vite, Element Plus
- 后端: Node.js, Express
- 部署: Docker, Nginx, systemd
- 数据库: 可选 PostgreSQL/Redis

## 许可证

MIT License
