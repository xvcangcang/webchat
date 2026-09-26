# WebChat — 身份码聊天平台

一个轻量级的点对点聊天应用。注册一个 5-6 位数字身份码当作账号名，在任意设备用它加密码登录，好友与聊天记录都在。

## ✨ 功能

- 🔑 **身份码即账号** — 注册时自选 5-6 位数字身份码 + 密码（至少 8 位），换浏览器、换设备登录即回到同一个身份
- 🧭 **未登录首屏** — 新浏览器首次打开是「未登录」，注册或登录后开始聊天（不再静默分配身份码）
- 🔐 **账号管理** — 设置 → 个人信息 → 账号：设置/修改密码、退出登录
- 🔄 **找回身份（过渡期）** — 换浏览器/清数据导致身份码变了？输入原身份码即可恢复原好友与聊天记录
- 👤 **添加好友** — 输入身份码发送申请，对方在「新的朋友」中接受后成为好友
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
3. 进入 **Authentication → Sign In / Providers**，按下表配置：

   | 项 | 设置 | 为什么 |
   |---|---|---|
   | **Email** provider | 启用 | 账号登录依赖它（身份码映射为合成邮箱） |
   | **Confirm email** | **必须关闭** | 合成邮箱收不到确认信，开启后注册永远激活不了 |
   | **Allow anonymous sign-ins** | 过渡期保持开启 | 老用户的匿名会话与「找回原身份码」依赖它 |

4. 进入 **SQL Editor**，粘贴 `supabase-setup.sql` 的内容并执行（幂等，老库重复执行即完成迁移）
5. 进入 **Settings → API**，复制：
   - `Project URL` (格式: `https://xxxxx.supabase.co`)
   - `anon public` key（或新版 `publishable` key）

> **自建部署注意**：身份码会拼成合成邮箱 `<身份码>@<域名>`，域名写在 `app.js` 顶部的 `ACCOUNT_EMAIL_DOMAIN`。
> 改成你自己的域名时必须满足两点，否则注册会被 Supabase 拒掉：
> ① 域名能解析出 **A 或 MX 记录**；② 不能用 `.local` / `.test` / `.example` / `.invalid` 等保留域（Supabase 硬屏蔽）。
> 默认值 `@xvcangcang.github.io` 就是按这个标准选的（有 A 记录、无 MX）。

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
├── version.js              # 版本号与维护弹窗开关
├── changelog.js            # 更新日志（设置 → 更新日志显示）
├── config.js               # Supabase 配置（有意入库：publishable key 本就公开）
├── config.example.js       # 配置模板
├── supabase-setup.sql      # 数据库初始化脚本
├── test/frontend.test.js   # 前端集成测试（jsdom + 假后端）
├── package.json            # 测试依赖（npm test 运行）
└── README.md               # 本文件
```

## 🔒 安全说明（v2.0.0 账号登录版）

安全模型：

1. **身份码 = 账号名，密码才是凭据** — 身份码（5-6 位数字）映射到合成邮箱 `<身份码>@xvcangcang.github.io`，
   密码由 Supabase Auth 托管（bcrypt 存储、自带登录限流），本项目不存任何密码。
   **光知道身份码登不进任何账号** —— 这是相对旧版最大的区别（旧版身份码存在 localStorage 里，是身份来源，本地一改就出错）。
2. **身份一律由登录会话派生** — 账号用户取邮箱前缀，过渡期匿名用户取 `auth_uid` 绑定的那一行。
   localStorage 里的身份码只是首屏缓存，改它不会改变你是谁。
3. **RLS 按会话隔离** — 所有策略锚在 `auth.uid()` 上（本次改造一行 SQL 都没改）：消息/会话只能被成员读取，
   只能以自己的身份发言，踢人/设管理员/解散在数据库层校验角色，前端绕过无效。
4. **防枚举** — 用户表只能看到 自己 / 好友 / 好友申请人 / 同会话成员，无法一次性拉取全站用户。
5. **XSS 防护** — 头像颜色白名单（`#RRGGBB`）、消息内容输出转义、CDN 锁版本 + SRI。
6. **凭据公开是有意的** — `config.js` 有意入库：`sb_publishable_...` 按 Supabase 设计本就随前端公开，
   安全边界在 RLS，不靠隐藏 key。若仓库历史上曾提交过 *私有* key，请先去控制台**轮换**。

已知边界（务必知悉）：

- **注册开放** — 任何人可以注册一个尚未被占用的身份码（与旧版「认领即拥有」一致）。
  防线是密码强度（前端强制 ≥8 位）与 Supabase 的登录/注册限流。
- **忘记密码无自助通道** — 合成邮箱收不到信，只能联系管理员代改（见下）。
- **过渡期匿名登录未关闭** — 老用户的匿名会话仍可照常用，但换设备仍可能丢身份；
  在 **设置 → 账号 → 设置密码** 后即升级为账号，该问题消失（uid 不变，好友与聊天记录一条都不用动）。
- **好友关系为申请-接受制** — 仅接收方可把申请置为 accepted（数据库列级授权封死身份列改写），
  拒绝/取消都是删除申请行，不会留下半确认状态。
- 无端到端加密，消息在服务端明文存储（Supabase 静态加密之外）。

### 管理员秘籍（用户忘记密码 / 排查账号）

在 Supabase **SQL Editor** 执行。**代改密码**是忘记密码的唯一通道：

```sql
UPDATE auth.users
SET encrypted_password = crypt('新密码', gen_salt('bf'))
WHERE email = '12345@xvcangcang.github.io';   -- 换成对方的身份码
```

看有哪些账号用户 / 某个身份码是否已被占用：

```sql
SELECT u.id AS uid, u.email, u.created_at, u.last_sign_in_at, w.id AS 身份码, w.display_name
FROM auth.users u LEFT JOIN public.users w ON w.auth_uid = u.id
ORDER BY u.created_at DESC;

SELECT id, auth_uid, display_name FROM public.users WHERE id = '12345';
```

## 🧪 测试

前端集成测试基于 jsdom + 假 Supabase 后端，无需真实后端即可运行：

```bash
npm install
npm test
```

覆盖场景：未登录首屏（不自动分配身份码、不加载任何数据）、账号会话的身份派生、匿名会话按绑定行解析、找回身份（服务端解绑+认领、失败回滚）、
**账号流程**（注册映射合成邮箱、撞码 422、第二步建行失败 `signOut` 回滚、登录成功/密码错误、老用户设置密码升级走 `updateUser` 且 uid 不变、退出登录清缓存与取消确认、弹窗模式切换/随机生成/回车提交/本地校验）、
`addContact` 错误码映射（23503/23505/42501）、发送申请不自动建会话、接受申请（置 accepted + 自动建会话 + 成员写入顺序）、申请列表渲染与徽标、轮询变更检测、`avatar_color` XSS 白名单拦截、通知默认不预览消息正文。

## 📝 使用说明

1. 首次打开是**未登录**状态，点 **注册账号**：自选 5-6 位数字身份码（可点「随机生成」）+ 密码（至少 8 位）
2. 换浏览器/换设备时点 **登录**，输入身份码与密码即回到同一个身份，好友、会话、消息都在
3. 点击左上角头像区域进入**设置 → 个人信息**：修改昵称；**账号**区可设置/修改密码、退出登录
4. 点击 **+** 按钮 → **添加好友**，输入对方身份码发送申请
5. 对方点击 **+** → **新的朋友**（有红点徽标），**接受**后双方自动出现私聊会话，也可**拒绝**；你发错人可在「已发送」里**取消**
6. 在左侧列表点击好友开始聊天
7. 点击 **+** → **创建群聊**，选择好友创建群组
8. 身份码变了（换浏览器/清除网站数据）导致好友和记录不见？进 **设置 → 找回身份**，输入原身份码即可找回
   （已经设置过密码的账号用户不需要它 —— 直接登录就回到原身份）

> 过渡期老用户：你现在这个身份码仍然照常可用，只是它只绑在这台浏览器上。
> 进 **设置 → 账号 → 设置密码** 即可升级成账号，uid 不变，好友与聊天记录一条都不会动。

## 📄 License

MIT
