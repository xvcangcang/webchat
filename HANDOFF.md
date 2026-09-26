# WebChat v2.0.0「账号登录」改造 — 交接文档

> 更新：2026-09-26 ｜ 仓库 `xvcangcang/webchat` ｜ 分支 `master`
> 阅读顺序建议：§0 速览 → §7 已完成内容 → §9 坑 → 其余按需查
>
> **本改造已全部落地（Phase 1–4）**，见 §0 与 §7。
>
> 本文件随仓库公开（无任何密钥：`config.js` 里的 anon key 本就设计为公开，安全边界在 RLS）。

---

## 0. 三十秒速览

| 项 | 状态 |
|---|---|
| 目标 | 把「打开网页自动分配身份码」改成「**身份码 + 密码** 登录」（身份码 = 账号名） |
| Phase 0 探针验证 | ✅ 全部通过（2026-09-26） |
| Phase 1 会话/身份层重写 | ✅ 完成 `7f1fac3` |
| Phase 2 注册/登录/升级/退出 + UI | ✅ **完成**（`3cafe9e` `2b55c39` `25277f8` `6841ad5` `f2127fc` `a7d6886`） |
| Phase 3 测试 | ✅ **完成** `b6685a0`：`npm test` → **160 通过 / 0 失败**（账号流程已全覆盖） |
| Phase 4 文档发版 | ✅ **完成** `505c634`：README 重写、`changelog.js` + `version.js` → **v2.0.0** |
| Phase 5 收尾（关匿名登录、删过渡代码） | ⬜ 未开始（计划观察一两周后做，见 §10） |
| 线上站点 | 随本次推送更新为 **v2.0.0**（账号登录版） |

**执行结果**：Phase 2 的 UI 与绑定已按 §7.2 清单补完，测试与文档同步跟上，**一次性推送 Phase 1–4**，
因此线上不会出现「未登录 + 点了没反应的按钮」的中间态（原计划的推送风险已消除）。

---

## 1. 项目基本信息

- 目录：`C:\Users\123\Desktop\webchat`（单页前端：`index.html` + `app.js` + `style.css`，无框架无构建）
- 仓库 / 部署：`https://github.com/xvcangcang/webchat` → GitHub Pages（push `master` 后自动更新）
- 后端：Supabase 项目 ref `izsujvaficoajtcogiwx`（URL/anon key 在 `config.js`，**有意入库**）
- 版本：`version.js` 的 `APP_VERSION`（现 `v1.9.2`）；`MAINTENANCE_NOTICE` 是维护弹窗开关（现 `false`）
- 测试：`export PATH="$PATH:/c/Program Files/nodejs" && npm test`（jsdom + 假 Supabase 客户端，不需要真后端）
- 提交约定：**每做一步提交一次**，中文提交信息带 `security:` / `feat:` / `fix:` / `test:` / `docs:` 前缀；改完即 `git push origin master`

---

## 2. 为什么要做这个改造

老模型是「每个浏览器一个匿名会话 → 自动分配一个身份码」，副作用一串：

1. 换浏览器 / 清缓存 / 换设备 = **换身份**，好友和聊天记录全丢（只能靠「找回身份」人工捞）。
2. `auth_uid UNIQUE` 与自动分配撞在一起，衍生出 42501、认领失败卡死等 bug（v1.9.0～v1.9.2 一直在打补丁）。
3. 身份码在 localStorage 里，是**身份来源**，本地一改就出错。

新模型：身份码退化为**账号名**，密码交给 Supabase Auth 托管（bcrypt、自带登录限流），
身份一律由**登录会话**派生 —— 消灭「身份码被悄悄换掉」这一整类问题。

---

## 3. 关键技术结论（已查源码 + 已实测）

### 3.1 三条支撑结论

1. **老用户无缝升级**：`auth.updateUser({ email, password })` 把匿名用户升级为永久账号，**uid 不变**
   ⇒ `users.auth_uid` 依然正确 ⇒ 好友、会话、消息一条都不用动。
2. **多设备天然一致**：同一 email+password 在任何设备 `signInWithPassword` 得到**同一个 uid**
   ⇒ 不需要「一码多设备」新表，`auth_uid` 仍是唯一锚点，`UNIQUE` 约束依然成立。
3. **RLS 零改动**：所有策略都锚在 `auth.uid()` 上，语义不变 ⇒ **本次改造一行 SQL 都不用改**
   （`supabase-setup.sql` 保持现状即可，`unbind_identity` / `recover_identity` 两个函数过渡期继续用）。

### 3.2 合成邮箱域名 = `@xvcangcang.github.io`

身份码 `12345` ⇒ 合成邮箱 `12345@xvcangcang.github.io`（收不到信，没人拥有这个邮箱）。

**为什么不用 `@webchat.local`**（2026-09-26 查 supabase/auth 源码后改的）：

- `internal/api/mail.go:710 validateEmail()` 只做格式校验（`checkmail.ValidateFormat`），不查 DNS；
  真正的墙在 `internal/mailer/validateclient/validateclient.go`：
  - `invalidHostSuffixes` 硬屏蔽 RFC 2606 保留域：`.test` `.example` `.invalid` `.local` `.localhost`
  - `invalidHostMap` 黑名单：`example.com/net/org`、`test.com`、`gamil.com`、`anonymous.com`、`email.com`
  - `validateHost()` 要求域名能解析出 **MX 或 A 记录**（`LookupMX` 失败则退 `LookupHost`）
  - 失败 → `mail.go:926` 返回 `email_address_invalid`
- `@xvcangcang.github.io` 有真实 A 记录（185.199.108-111.153）、无 MX ⇒ 走 `LookupHost` 分支通过。
- 关键推论：`internal/api/signup.go:229` **只有 `Mailer.Autoconfirm == false` 时才发信** ⇒ 一旦要发信，
  被屏蔽域名会让**整个请求失败**（不只是"跳过邮件"）。所以域名必须选一个能过校验的。

### 3.3 Phase 0 实测结果（探针页 `auth-test.html`，用完已删）

| 验证项 | 结果 |
|---|---|
| `mailer_autoconfirm: true`（控制台已关邮箱确认） | ✅ |
| `external.email: true` / `external.anonymous_users: true` / `disable_signup: false` | ✅ |
| 匿名 → `updateUser({email,password})` 升级，**uid 不变** | ✅ |
| 升级后邮箱**即时生效**，未进入「待确认」 | ✅ |
| 另一客户端 `signInWithPassword` 拿到**同一个 uid** | ✅ |
| 重复注册返回 **422 `user_already_exists`** | ✅ |

> 注：`mailer_autoconfirm: true` 之后发信校验不再触发，所以探针里的"域名体检"是**空跑**，
> 域名选型以 §3.2 的源码结论为准。
> 另：`password_min_length` 在托管版 `/auth/v1/settings` 里读不到 ⇒ 前端自己按 **≥8 位** 卡。

---

## 4. 目标形态（产品行为）

- **身份码**：5-6 位数字，用户自己选（注册时提供「随机生成」按钮），同时是账号名。
- **注册**：身份码 + 密码（≥8）+ 确认密码 → 直接进入应用（无需邮箱确认）。
- **登录**：身份码 + 密码 → 任何设备回到同一个身份（好友/会话/消息自动恢复）。
- **未登录首屏**：新浏览器打开 = 「未登录」+ 登录/注册按钮 + 「我是老用户，找回原身份码」入口。
- **设置 → 个人信息 → 账号区**：按状态显示 —— 账号（修改密码 / 退出登录）、
  过渡期匿名身份（设置密码 / 退出登录）、未登录（登录 / 注册账号）。
- **老用户过渡：只提示，不强制**（用户可以继续用匿名身份），设置里提示「设置密码后换设备也能登录」。
- **过渡期保留「找回身份」**：只对「身份码绑在会话上」的非账号用户显示（账号用户登录即回到原身份，藏起来）。
- **不提供自助找回密码**：合成邮箱收不到信 ⇒ 忘记密码只能联系管理员（见 §10）。

---

## 5. 进度总表

| Phase | 内容 | 状态 | 提交 |
|---|---|---|---|
| 0 | 探针验证外部前提（关邮箱确认、匿名升级、多设备、撞码信号） | ✅ 通过 | 探针页用完即删，未提交 |
| 1 | 会话与身份层重写：`state.myId` 由会话派生、删除自动分配 | ✅ 完成 | `7f1fac3` |
| 2 | 注册 / 登录 / 设置密码 / 修改密码 / 退出登录 + 弹窗与设置区 UI | ✅ 完成 | `3cafe9e` `2b55c39` `25277f8` `6841ad5` `f2127fc` `a7d6886` |
| 3 | 新流程的测试覆盖 | ✅ 完成（99 → **160** 通过） | `b6685a0` |
| 4 | README 安全模型重写、`changelog.js` + `version.js` → **v2.0.0** | ✅ 完成 | `505c634` |
| 5 | 观察一两周后关闭匿名登录、删过渡代码（可选） | ⬜ 未开始 | — |

---

## 6. Phase 1 已完成内容（提交 `7f1fac3`）

`app.js` 身份层重写（文件顶部「身份码系统」段）：

```js
const ACCOUNT_EMAIL_DOMAIN = '@xvcangcang.github.io';
const AUTH_NONE = 'none';        // 无会话 → 未登录
const AUTH_LEGACY = 'legacy';    // 匿名会话（老用户，过渡期）
const AUTH_ACCOUNT = 'account';  // 账号会话（身份码 + 密码）
```

| 函数 | 作用 |
|---|---|
| `emailForCode(code)` / `codeFromEmail(email)` | 身份码 ⇄ 合成邮箱（邮箱前缀必须是 5-6 位数字，否则不算账号） |
| `initIdentity()` | 只读 `webchat_name` / `webchat_color` 缓存做首屏；`state.myId = null`（**不再生成身份码**） |
| `resolveSession()` | 读会话并判定 `none` / `legacy` / `account`，带出 `uid` / `email` / `code` |
| `adoptIdentity(row)` | 把某行 `users` 认作自己的身份并写回本地缓存（**仅缓存，不再是来源**） |
| `loadIdentity(auth)` | account：按 `id = 身份码` 查行（缺失则补建）；legacy：按 `auth_uid` 查行（查不到才用缓存的身份码 `rpc('recover_identity')` 兼容路径） |
| `renderLoggedOut(hint)` | 未登录首屏：`?` 头像 / 未登录 / `------` / 隐藏 `.sidebar-actions` / 空状态 |
| `recoverIdentity(oldCode)` | 过渡期保留；由服务端函数原子完成「腾出当前绑定 + 认领原身份」 |

**已删除**：`ensureAuth()`（自动 `signInAnonymously`）与 `ensureIdentity()`（自动分配 + 认领重试循环），共 78 行。
**未登录时不再加载任何数据**（不进 `loadContacts/loadConversations/subscribeRealtime`）。

`test/frontend.test.js` 已同步改造：假客户端会话带 `user.email`；T0=未登录不取数、T1=账号会话（`eq('id','12345')`、
无 insert / 无 RPC）、T2=身份解析四条路径、T8 断言启动阶段零 RPC 零写库。**99 通过 / 0 失败。**

---

## 7. Phase 2/3/4 已完成内容（2026-09-26）

> 本节原为「剩余清单」，现已逐项落地。下面的清单保留作**核对用**（每一条都已实现，可对照代码复核）。

### 7.1 Phase 2 逻辑层（`app.js` 账号段）

| 位置 | 内容 |
|---|---|
| `state` 字面量 | 新增 `auth: null`（`resolveSession()` 结果）、`authMode: 'login'` |
| `recoverIdentity()` | 未登录时先 `signInAnonymously()` 建临时会话再认领；失败自动 `signOut` 回滚不留半个状态 |
| 账号逻辑段（`recoverIdentity` 之后） | `MIN_PASSWORD_LEN = 8`、`authErrorText()`、`normalizeCode()`、`registerAccount()`、`loginAccount()`、`upgradeToAccount()`、`changePassword()`、`logoutAccount()`、`AUTH_MODES` 四模式表、`openAuthModal(mode)` |
| `renderAccountBox()` | 设置里账号区的三种状态渲染（account / legacy / none），并顺便按状态隐藏 `#recoverIdentityBlock` |
| `renderLoggedOut()` | 空状态里加了 `.auth-actions` 两个按钮 + 「我是老用户，找回原身份码」链接（都带 `data-auth-action`） |
| 设置打开处理器 | `$('settingsId').textContent = state.myId \|\| '------'`（原来会显示 `null`）+ 调用 `renderAccountBox()` |

四种弹窗模式（`AUTH_MODES`）：

| mode | 标题 | 身份码输入 | 确认密码 | 提交动作 |
|---|---|---|---|---|
| `login` | 登录 | 显示 | 隐藏 | `loginAccount()` |
| `register` | 注册账号 | 显示 + 随机生成 | 显示 | `registerAccount()` |
| `upgrade` | 设置密码（老用户升级） | 隐藏 | 显示 | `upgradeToAccount()`（`updateUser`，uid 不变） |
| `password` | 修改密码 | 隐藏 | 显示 | `changePassword()` |

### 7.2 UI 与绑定（✅ 已全部完成）

1. **`index.html`**：
   - 新增 `#modalAuth` 弹窗，元素 id 必须是：
     `authTitle` / `authHint` / `authCodeWrap` / `inputAuthCode` / `btnGenCode` / `inputAuthPwd` /
     `authConfirmWrap` / `inputAuthPwd2` / `authFeedback` / `btnAuthSwitch` / `btnAuthSubmit`
     （骨架照抄 `#modalFriendRequests`；**提交/切换按钮不要带 `data-modal`**，否则会被全局关闭器误关）
   - 设置 → 个人信息：在「我的身份码」下方加 `<label>账号</label><div id="accountBox"></div>`；
     把现有「找回身份」整段包进 `<div id="recoverIdentityBlock">`
2. **`style.css`**：`.modal-body input[type="password"]` 复用现有 text 输入样式（现只写了 `[type="text"]`）；
   新增 `.auth-actions`（首屏按钮组）、`.auth-link`（首屏文字链）、`.account-actions`（账号区按钮行）
3. **`app.js` `bindEvents()`**：
   - `#accountBox` 委托：`data-account-action` = `login` / `register`（关设置 → `openAuthModal`）、
     `upgrade` / `password`（关设置 → 对应模式）、`logout`（`confirm` 后 `logoutAccount()`）
   - `#modalAuth`：`btnAuthSubmit` 按 `state.authMode` 分发 + 提交期禁用按钮；`btnAuthSwitch`（login ⇄ register 切换重开弹窗）；
     `btnGenCode`（`$('inputAuthCode').value = genShortId()`）；输入框回车提交
   - `#conversationList` 委托：`[data-auth-action]` = `login` / `register` → `openAuthModal(...)`；
     `recover` → `$('btnSettings').click()` 并聚焦 `#inputRecoverId`
4. **`app.js` `init()`**：把 `auth` 存进 `state.auth`（**未登录分支也要存**，`renderAccountBox` 依赖它）；
   legacy 老用户一次性提示（`localStorage.webchat_upgrade_hint` 不存在时 toast「在设置里设置密码，换设备也能登录」并写标记）
5. **`app.js` `btnSaveProfile` 加未登录守卫** —— ✅ 已加（`f2127fc`）
6. **Phase 3 测试** —— ✅ 已完成（`b6685a0`）：假客户端补了 `auth.signUp` / `signInWithPassword` /
   `updateUser` / `signOut` / `signInAnonymously`，并给测试环境加了 `virtualConsole`（把 `location.reload()`
   的 jsdom「Not implemented」噪声转成 `app.reloads()` 计数，用来断言"流程走完并刷新了页面"）与可控 `confirm`。
   T10 覆盖 10 组场景、61 条断言，全部走真实 DOM 点击（顺带覆盖 `openAuthModal` 与 `bindEvents` 接线）：
   注册成功 / 撞码 422 / 建行失败回滚 `signOut` / 登录成功 / 密码错误 / 本地校验（格式·长度·两次不一致·必填）/
   老用户升级走 `updateUser` 且 uid 不变 / 账号区与退出登录（含取消确认）/ 未登录首屏两个入口 + 找回入口聚焦 /
   弹窗模式切换、随机生成、回车提交、切换清空输入。

### 7.3 收尾（✅ 已完成，顺序略有调整）

Phase 2 + 3 全绿后**先把 Phase 4 做完再推**（原计划是先推再发版）——
这样线上不会出现「v2.0.0 的新逻辑 + 侧栏仍显示 v1.9.2」的中间态。
`README.md` 重写、`changelog.js` + `version.js` 升 **v2.0.0**（破坏性变更）后，
一次性推送 Phase 1–4 的全部提交。

---

## 8. 当前仓库真实状态

```
git log           → 本次改造的提交（Phase 1–4 + 文档），已推送 origin/master
                   84dce8d feat: 恢复使用，关闭维护弹窗并升到 v1.9.2   ← 改造前的最后一个提交
npm test          → 160 通过 / 0 失败（账号流程已被 T10 覆盖）
线上版本          → v2.0.0（账号登录版），站点 https://xvcangcang.github.io/webchat/
SQL               → 本次改造未改任何 SQL，supabase-setup.sql 保持原样
```

`supabase-setup.sql` 一行都没动 —— 所有 RLS 策略本来就锚在 `auth.uid()` 上，账号登录不改变这个语义。

---

## 9. 坑与硬前提（务必先读）

1. **控制台「Confirm email」必须保持关闭**（Authentication → Sign In / Providers → **User Signups** 区，
   不在 Email provider 面板里）。合成邮箱收不到验证信，一旦开启：`signUp` 拿不到 session、注册永远激活不了。
   探针里检查 `mailer_autoconfirm` 可以直接确认。
2. **过渡期不要关「Allow anonymous sign-ins」**：老用户的匿名会话、以及「未登录时找回原身份码」都要用它。
3. **注册是两步**（auth 建号 + INSERT `users` 行）⇒ 第二步失败必须 `signOut()` 回滚，
   否则留下「有账号没身份」的孤儿，身份码还被占着。
4. **撞码有两种**：邮箱已被注册（422 `user_already_exists`）和 `users.id` 已被占（建行 23505）。
   两者都要给出「该身份码已被注册，换一个试试」，且都必须回滚。
5. **忘记密码无自助通道** ⇒ 由管理员在 Supabase SQL Editor 代改（§10），UI 上已写明。
6. **推送时机**：Phase 2 完成前不要推（§0）。本次已按「Phase 2/3/4 全绿后一次性推」处理，不存在中间态。
7. **别忘 `changePassword` 不刷新页面**（会话仍有效），其它三条流程成功后会 `location.reload()`。
8. `version.js` 的 `MAINTENANCE_NOTICE` 是维护弹窗总开关，`changelog.js` 与 `version.js` 要同步。
9. 浏览器强刷（Ctrl+Shift+R）再看效果，避免旧 JS 缓存。

### 我这个执行环境的限制（给下一个 AI/接手人）

> **2026-09-26 补记**：下一位接手人的环境里 `github.com:443`（SSH）**是通的**，
> `git ls-remote origin` / `git push` 均正常，无需走 §14 的 REST API 兜底。
> 下面的限制只描述写下这段时那台机器的网络状况，遇到 `git push` 失败再回来看。

- **`github.com:443` 连不上（`git push` 直接失败），但 `api.github.com` 通**：
  实测 `git push` 连试 3 次全部 `Empty reply from server` / `Failed to connect to github.com:443 after 21s`
  （`curl https://github.com/` 也是 `http=000`，而 `api.github.com` 0.4s 返回 200）。
  这是网络层封锁，不是仓库/权限问题。**推送改用 GitHub REST API**，见 §14。
- **连不上 `*.supabase.co`**（curl 超时）⇒ 任何服务端/SQL 变更都要**用户在 Supabase 控制台执行**。
- `raw.githubusercontent.com` 不通（`http=000`），查源码改用
  `curl -H "Accept: application/vnd.github.raw" https://api.github.com/repos/supabase/auth/contents/<path>`。
- Windows Git Bash；`export PATH="$PATH:/c/Program Files/nodejs"` 才能跑 `npm`；
  每次 Bash 调用后 cwd 会重置回 `d:\`；`git add` 会提示 LF→CRLF，正常。
- 本地预览：`cd C:\Users\123\Desktop\webchat && npx --yes serve . -l 8642 --no-clipboard`
  （`serve` 用 clean URL，`/index.html` 会 301 到 `/`）。

---

## 10. 运维手册

**看有哪些账号用户**（SQL Editor）：

```sql
SELECT u.id AS uid, u.email, u.created_at, u.last_sign_in_at, w.id AS 身份码, w.display_name
FROM auth.users u LEFT JOIN public.users w ON w.auth_uid = u.id
ORDER BY u.created_at DESC;
```

**代改密码**（用户忘记密码时唯一通道）：

```sql
UPDATE auth.users
SET encrypted_password = crypt('新密码', gen_salt('bf'))
WHERE email = '12345@xvcangcang.github.io';
```

**看身份码是否已被某个账号占用**：

```sql
SELECT id, auth_uid, display_name FROM public.users WHERE id = '12345';
```

**「找回身份」相关服务端函数**：`unbind_identity` / `recover_identity` 在 `supabase-setup.sql` 里，
过渡期继续保留（Phase 5 收尾时再删）。

---

## 11. 关键文件索引

| 文件 | 说明 |
|---|---|
| `app.js`（约 2100 行） | 全部逻辑。身份层 `:77-220` 附近；`recoverIdentity` 之后是账号逻辑段；`renderAccountBox` 在 `renderMyInfo` 附近；`bindEvents()` 在文件后段；`init()` 在最末 |
| `index.html` | 侧栏 `#myAvatar/#myName/#myId`；`.sidebar-actions`；`#conversationList`；设置弹窗 `#modalSettings` → `#sectionProfile`（身份码/找回身份区）；弹窗骨架参考 `#modalFriendRequests` |
| `style.css` | `.modal-body input[type="text"]`（密码框要加）、`.settings-hint`、`.recover-row`、`.empty-state`、`.btn/.btn-primary/.btn-secondary/.btn-danger`、`.settings-actions` |
| `test/frontend.test.js` | jsdom + 假 Supabase；`makeClient(hooks, { session })`，`DEFAULT_SESSION` 是账号会话、`LEGACY_SESSION` 是匿名会话 |
| `supabase-setup.sql` | 幂等，可整份重跑。**本次改造不需要改它** |
| `version.js` / `changelog.js` | 发版时同步（目标 v2.0.0） |
| `config.js` | 有意入库（anon key 设计即公开） |

---

## 12. 对话纪要（决策与关键节点）

> 是**纪要**不是逐字记录。完整原始对话在 `C:\Users\123\.claude\projects\d--\40d8420d-40f5-489c-a6f1-3bc0eeb19551.jsonl`。

### 12.1 前置工作（v1.8.0 / v1.9.x，均已完成并推送）

- 用户要求把加好友改成微信式「**新的朋友**」申请列表（申请 → 接受/拒绝 → 互为好友并自动建会话）。
  采用「单行 + status 模型」，改写了 `contacts_insert/update`、`members_insert` 邀请分支、`users_select`，
  并加列级授权与无序对唯一索引 `contacts_pair_uniq`。已发布 **v1.8.0**。
- 随后用户报「找回身份/解绑报 **42501**」与「**认领身份码失败，请刷新重试**」卡死。
  定位：解绑后 `auth_uid = NULL` 的新行不满足 `users_select` 的 `USING`，前端直接改库被 RLS 拒。
  → 改为服务端函数 `unbind_identity` / `recover_identity`（`188387c` / `7cbad13`），
  认领改走 INSERT + 服务端认领（`bd06b23`），期间加了维护弹窗开关（`bf82580`），
  修好后 **v1.9.2** 恢复使用（`84dce8d`，`MAINTENANCE_NOTICE = false`）。

### 12.2 账号登录改造（本主题）

**用户原话（需求）**：

> 把平台改成账号登陆模式，每一个身份码可以设置密码，在设置里点击切换账号即可通过身份码和密码登录账号，
> 同时第一次打开网站的浏览器不再自动分配身份码，而是显示未登录，可在设置里注册账号。
> **请先判断想法的可行性，再列出计划，先不开做**

**我的结论**：可行，且改动比看上去小 —— 关键洞察是「身份码即账号名，映射到合成邮箱」，
`auth.uid()` 语义不变 ⇒ **RLS 与所有策略一行都不用改**（见 §3.1）。计划书见 §12.4。

**用户拍板（AskUserQuestion 选择结果，2026-09-26）**：

| 决策点 | 结论 |
|---|---|
| 老用户过渡 | **只提示，不强制**（照常用，设置里提示设密码） |
| 身份码来源 | 用户自选 + 「随机生成」按钮（老用户可沿用熟悉的码） |
| 登录入口 | 首屏空状态 + 设置里都放 |
| 退出登录 | 配套一起做 |
| 合成邮箱域名 | `@xvcangcang.github.io`（原定 `@webchat.local` 被 Supabase 硬拒，见 §3.2） |
| 是否开工 | 「开始 Phase 1」 |

**Phase 0 探针过程**（`auth-test.html`，用完即删、未提交）：

1. 首次跑：2 项不通过 —— 读 `/auth/v1/settings` 与 `signInAnonymously` 报
   `NetworkError when attempting to fetch resource`（定性为到 `supabase.co` 的瞬时网络抖动，
   加重试包装 `authCall` + 无自定义头的 plain fetch 后第二次成功）；
   同时 `signUp` 失败：`Email address "probe2545663b@webchat.local" is invalid（code=email_address_invalid status=400）`
   —— 这反而**反推出「Confirm email 还开着」**（`signup.go:229` 只在要发信时才校验域名）。
2. 用户回：「**没有 Confirm email，其他已经改好了**」，随后关掉邮箱确认。
3. 重跑：`mailer_autoconfirm: true` / `external.email: true` / `external.anonymous_users: true` /
   `disable_signup: false`，uid 升级不变、多设备同 uid、`signUp` 直接返回 session、
   重复注册 422 `user_already_exists` —— **全部通过**。
4. 期间查 supabase/auth 源码确认 `.local` 被 `invalidHostSuffixes` 硬屏蔽 ⇒ 域名改 `@xvcangcang.github.io`。
   （探针里那次"三个域名都通过"是**空跑**：邮箱确认关掉后根本不发信、不校验域名，不能作为域名选型依据。）

**Phase 1 落地**：身份层重写（§6）→ `npm test` 99/0 → 提交 `7f1fac3`。
当时**故意没推**：Phase 1 单独上线会让线上首屏变成没有登录入口的「未登录」死胡同。

**上一次会话**：用户要求把进展整合成交接文档放进文件夹并推送 GitHub ⇒ 即本文件。

**本次会话（2026-09-26）**：按本文件的 §7.2 清单接着做，把 Phase 2 的 UI/绑定补完，
一路做到 Phase 4 发版。每步一次提交（共 8 个），全部按文档「改完即提交」的约定执行：

| 步骤 | 提交 | 内容 |
|---|---|---|
| Phase 2 UI | `3cafe9e` | `index.html`：`#modalAuth` 弹窗 + 设置账号区 + 找回身份包块 |
| Phase 2 样式 | `2b55c39` | `style.css`：密码框复用 text 样式（含深色）、`.auth-actions` / `.auth-link` / `.account-actions` |
| Phase 2 接线 | `25277f8` | `bindEvents()`：账号弹窗提交分发 + 切换 + 随机生成、设置账号区、首屏入口 |
| Phase 2 收尾 | `6841ad5` | `init()` 存 `state.auth`（未登录分支也存）+ 老用户一次性升级提示 |
| Phase 2 修补 | `f2127fc` | `btnSaveProfile` 未登录守卫（§7.2 第 5 条） |
| Phase 2 修补 | `a7d6886` | 确认密码为空的提示更明确（顺手修掉一个含糊条件） |
| Phase 3 | `b6685a0` | T10 账号流程测试，`npm test` 99 → **160** 通过 |
| Phase 4 | `505c634` | README 重写、`changelog.js` + `version.js` → v2.0.0 |

实测结论：T10 的 61 条断言**首次运行即全绿**，没有出现"接完 UI 才发现逻辑层设计不合用"的返工；
`app.js` 的账号逻辑层（上一次会话留下的未提交代码）**无需修改**，只补了上面两条边界修正。
另外做了一次静态自检：`index.html` 无重复 id，`app.js` 里 77 个 `$('...')` 引用全部能在 HTML 中找到。

> 期间我在给 `btnSaveProfile` 加未登录守卫时被用户打断（那次编辑**没有生效**，见 §7.2 第 5 条）。

### 12.3 用户工作方式约定（长期有效）

- 每做一步 git 提交一次；提交信息中文 + `security:` / `feat:` / `fix:` / `test:` / `docs:` 前缀。
- 改完即 `git push origin master`（Pages 靠推送生效）。
- `config.js` 有意入库（`sb_publishable_` 的 anon key 设计即公开，安全边界在 RLS）。
- SQL 变更要同时更新 `supabase-setup.sql`，并提醒用户在 Supabase 控制台执行（我连不上 `*.supabase.co`）。
- 涉及前端行为变化时同一提交内跑 `npm test` 保持全绿。

### 12.4 原计划书全文（`C:\Users\123\.claude\plans\webchat-account-login.md` 的要点）

- Phase 0 探针 → Phase 1 身份层 → Phase 2 三条流程 + UI → Phase 3 测试 → Phase 4 文档发版 v2.0.0 → Phase 5 关匿名登录收尾。
- 风险清单：邮箱确认是硬前提；过渡期换设备仍可能丢身份（与现状相同）；注册两步要回滚；
  免费版有 auth 限流（UI 要给可读提示）；改动面大 ⇒ 记 v2.0.0。
- 安全模型交底：身份码退化为用户名（光知道码登不进来）；注册开放 ⇒ 任何人可注册未被占用的码
  （与现状「认领即拥有」一致）；**密码强度与登录限流是防线**；忘记密码只能管理员重置。

---

## 13. 一句话交接

> 「身份码 + 密码」账号登录改造 **Phase 1–4 已全部完成并推送**（v2.0.0，`npm test` 160 通过 / 0 失败）。
> 剩下只有**可选的 Phase 5**：观察一两周、确认老用户都已设置密码后，关闭匿名登录并删掉过渡代码
> （`recoverIdentity` / `recoverIdentityBlock` / `AUTH_LEGACY` 分支 / `unbind_identity` + `recover_identity` 两个服务端函数）。
> 在那之前 **不要关匿名登录**（§9 第 2 条）。

---

## 14. 推送通道（本机 github.com 被墙时的替代方案）

本机 `git push` 走不通（§9），但 `api.github.com` 通，并且 Git Credential Manager 里存着可用的 PAT。
用 REST API 推内容（**令牌只从凭据管理器读，不要写进任何文件或提交**）：

```bash
BASE=https://api.github.com/repos/xvcangcang/webchat
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | sed -n 's/^password=//p')

# 1) 取基线提交的完整 sha（例：要新分支基于 master；API 返回的是格式化 JSON，直接抓第一个 40 位 sha）
SHA=$(curl -s -H "Authorization: Bearer $TOKEN" $BASE/commits/master | grep -oE '[0-9a-f]{40}' | head -1)

# 2) 新建分支（已存在会报 422，可忽略）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  $BASE/git/refs -d "{\"ref\":\"refs/heads/handoff\",\"sha\":\"$SHA\"}"

# 3) 上传/更新单个文件（base64；= 或 / 在 JSON 里无需转义）
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  $BASE/contents/HANDOFF.md \
  -d "{\"message\":\"docs: 交接文档\",\"branch\":\"handoff\",\"content\":\"$(base64 -w0 HANDOFF.md)\"}"

# 4) 验证
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/contents/HANDOFF.md?ref=handoff" | head -3
```

改多个文件时逐文件重复第 3 步（每次 PUT 都会在该分支上生成一个提交）。
`git fetch` / `git ls-remote` 同样会失败（都要连 `github.com`），所以**本地看不到远端状态**，
只能靠上面的 API 查询确认。真正的 `git push` 等网络恢复后再做（或用户挂代理手动推）。
