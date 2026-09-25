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
3. 进入 **Authentication → Sign In / Providers → Anonymous**，启用匿名登录（必须，否则无法登录）
4. 进入 **SQL Editor**，粘贴 `supabase-setup.sql` 的内容并执行（幂等，老库重复执行即完成迁移）
5. 进入 **Settings → API**，复制：
   - `Project URL` (格式: `https://xxxxx.supabase.co`)
   - `anon public` key（或新版 `publishable` key）

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
├── config.js               # Supabase 配置（需自行创建，不入库）
├── config.example.js       # 配置模板
├── supabase-setup.sql      # 数据库初始化脚本
├── test/frontend.test.js   # 前端集成测试（jsdom + 假后端）
├── package.json            # 测试依赖（npm test 运行）
└── README.md               # 本文件
```

## 🔒 安全说明（v2 安全加固版）

安全模型：

1. **匿名登录** — 每个浏览器通过 Supabase Auth 匿名登录获得 `auth.uid`，身份码（5 位数字）与 `auth.uid` 绑定，不能冒充他人
2. **RLS 按会话隔离** — 消息/会话只能被成员读取；只能以自己的身份发言；踢人/设管理员/解散等操作在数据库层校验角色，前端绕过无效
3. **防枚举** — 用户表只能看到 自己 / 好友 / 同会话成员，无法一次性拉取全站用户
4. **XSS 防护** — 头像颜色白名单（`#RRGGBB`）、消息内容输出转义、CDN 锁版本 + SRI
5. **凭据不入库** — `config.js` 已加入 `.gitignore`，从 `config.example.js` 复制填写

已知边界（如需进一步加固）：

- 匿名登录意味着任何人都可以注册（但数据互相隔离）
- 好友关系为"单向添加、双向确认"，对方加回后才互相可见
- 无端到端加密，消息在服务端明文存储（Supabase 静态加密之外）
- 升级提示：如果仓库曾公开提交过 `config.js`，旧 key 已泄露——请到控制台**轮换 key**，并确认升级前已执行新的 `supabase-setup.sql`（否则旧 key 配合旧的全开放策略仍可读写全库）

## 🧪 测试

前端集成测试基于 jsdom + 假 Supabase 后端，无需真实后端即可运行：

```bash
npm install
npm test
```

覆盖场景：初始化登录流程、身份码占用换码重试、`addContact` 错误码映射（23503/23505）、单向插入、`avatar_color` XSS 白名单拦截、通知默认不预览消息正文。

## 📝 使用说明

1. 首次打开会自动生成身份码
2. 点击左上角头像区域进入**设置**，修改昵称
3. 点击 **+** 按钮 → **添加好友**，输入对方身份码
4. 对方也需要用你的身份码添加你
5. 添加成功后在左侧列表点击好友开始聊天
6. 点击 **+** → **创建群聊**，选择好友创建群组

## 📄 License

MIT
