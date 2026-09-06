# WebChat — 身份码聊天平台

一个轻量级的点对点聊天应用，每个浏览器生成唯一身份码，输入身份码即可添加好友聊天。

## ✨ 功能

- 🔑 **身份码系统** — 自动生成 UUID 身份码，无需注册
- 👤 **添加好友** — 输入对方身份码即可互加好友
- 💬 **实时聊天** — 基于 Supabase 实时订阅，消息即时送达
- 👥 **群聊支持** — 创建群聊、邀请好友、退出群聊
- 📱 **响应式设计** — 微信风格 UI，适配手机和桌面
- 🚀 **纯前端** — 可部署到 GitHub Pages / PocketBase 等静态托管

## 📦 技术栈

- **前端**: 纯 HTML + CSS + JavaScript（无框架、无构建工具）
- **后端**: [Supabase](https://supabase.com)（免费版足够）
  - PostgreSQL 数据库
  - 实时消息订阅
  - Row Level Security

## 🚀 部署步骤

### 第 1 步：创建 Supabase 项目

1. 注册 [Supabase](https://supabase.com)（免费）
2. 创建新项目，记住数据库密码
3. 进入 **SQL Editor**，粘贴 `supabase-setup.sql` 的内容并执行
4. 进入 **Settings → API**，复制：
   - `Project URL` (格式: `https://xxxxx.supabase.co`)
   - `anon public` key

### 第 2 步：配置前端

1. 复制 `config.example.js` 为 `config.js`:
   ```bash
   cp config.example.js config.js
   ```
2. 填入你的 Supabase 信息：
   ```javascript
   const SUPABASE_URL = 'https://your-project-id.supabase.co';
   const SUPABASE_ANON_KEY = 'your-anon-key-here';
   ```

### 第 3 步：部署

**GitHub Pages:**
1. 创建 GitHub 仓库
2. 上传所有文件（包括 `config.js`）
3. 进入 Settings → Pages → 选择 main 分支
4. 访问 `https://your-username.github.io/repo-name/`

**PocketBase:**
1. 将项目文件夹打包
2. 在 PocketBase 控制台选择 Static 部署
3. 上传文件，获得公网 URL

**本地测试:**
```bash
# 用任意 HTTP 服务器
python -m http.server 8000
# 或
npx serve .
```

## 📁 项目结构

```
webchat/
├── index.html              # 主页面
├── style.css               # 微信风格样式
├── app.js                  # 核心应用逻辑
├── config.js               # Supabase 配置（需自行创建）
├── config.example.js       # 配置模板
├── supabase-setup.sql      # 数据库初始化脚本
└── README.md               # 本文件
```

## 🔒 安全说明

当前版本使用 Supabase 的 `anon` key 进行操作，RLS 策略设置为全开放。
这意味着任何知道 Supabase URL 的人都可以读写数据。

如果需要更高安全性，可以：
1. 启用 Supabase Auth
2. 修改 RLS 策略，限制只有会话成员才能读取消息
3. 添加消息加密（E2EE）

## 📝 使用说明

1. 首次打开会自动生成身份码
2. 点击左上角头像区域进入**设置**，修改昵称
3. 点击 **+** 按钮 → **添加好友**，输入对方身份码
4. 对方也需要用你的身份码添加你
5. 添加成功后在左侧列表点击好友开始聊天
6. 点击 **+** → **创建群聊**，选择好友创建群组

## 📄 License

MIT
