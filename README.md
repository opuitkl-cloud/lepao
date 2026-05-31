# WHUT绘跑

> GPS 轨迹绘制 + 武汉理工大学智慧体育自动提交工具

在地图上用鼠标设置打卡点，绘制跑步轨迹,一键提交到 WHUT 智慧体育系统.支持桌面和移动端。

---

## 功能

- **轨迹绘制** — 上传校园地图图片，用鼠标/触屏绘制跑步路线
- **打卡点管理** — 在地图上标记打卡点，自动匹配 WHUT 打卡点（14~18号）
- **一键提交** — 通过智慧体育登录 → beforeRun → OSS 上传 → stopRun 全自动
- **移动端适配** — 双页面布局

## 目录结构

```
huipao/
├── server.js          # HTTP 服务器 + WHUT API（AES-128-CBC/MD5 签名）
├── index.html         # 前端页面（双页面 SPA）
├── package.json       # 依赖：crypto-js
├── css/
│   └── style.css      # 暗色主题样式
├── js/
│   └── app.js         # 前端逻辑（绘制/GPS转换/WHUT客户端）
└── data/
    ├── .png       # 地图文件
    ├── settings.json  # 配置持久化
    └── whut_history.json  # 跑步历史记录
```

## 快速开始

### 前提

- Node.js ≥ 18（需要 `fetch` 原生支持）

### 安装 & 运行

```bash
cd huipao
npm install
node server.js
```

打开浏览器访问 **http://localhost:6660**

### 使用说明

1. **登录** — 打开"智慧体育"→ 我的 → 右上角 → 复制链接，粘贴到登录页
2. **选择地图** — 选择校园地图图片
3. **设置打卡点** — 自由选择打卡点
4. **画轨迹** — 在地图上绘制跑步路线
5. **提交** — 点击确认，自动完成提交

### 默认参数

| 参数 | 默认值 |
|------|--------|
| 运动总时间 | 666 秒 |
| 采样间隔 | 6 |
| 跑步模式 | 计分跑 |

## 技术栈

**后端：** 纯 Node.js 内置 `http` 模块（无 Express 依赖）
- AES-128-CBC 加密（crypto-js）
- MD5 参数签名
- OSS 阿里云 STS 上传

**前端：** 纯 HTML/CSS/JS SPA（无框架）
- Canvas 绘图
- GPS ↔ 像素坐标双向转换
- Haversine 距离计算

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/whut/login` | POST | 登录，返回 auth |
| `/api/whut/submit` | POST | 创建跑步任务，返回 jobId |
| `/api/whut/job/:id` | GET | 轮询任务状态 |
| `/api/whut/history` | GET | 历史记录 |
| `/api/settings` | GET/POST | 配置持久化 |

## 许可
本项目仅供学习和个人使用。
