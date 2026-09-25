// WebChat 前端集成测试（jsdom + 假 Supabase 后端）
// 运行：npm install && npm test（无需真实后端、无需起 HTTP 服务）
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAKE_UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn\.jsdelivr[^>]+><\/script>/, '');
// config.js 被 .gitignore 忽略，新克隆仓库时回退到模板（测试用假客户端，配置值无实际影响）
const configSrc = fs.existsSync(path.join(ROOT, 'config.js')) ? 'config.js' : 'config.example.js';
const sources = [configSrc, 'version.js', 'changelog.js', 'app.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { passed++; console.log('   ✅ ' + msg); }
  else { failed++; failures.push(msg); console.log('   ❌ ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const v = fn(); if (v) return v; } catch (e) {}
    await sleep(20);
  }
  return null;
}

// ---- 假 supabase 客户端 ----
function makeBuilder(table, hooks, calls) {
  const ops = { table, method: null, payload: null, filters: [], columns: null, single: false };
  const b = {
    select(c) { if (!ops.method) ops.method = 'select'; if (c) ops.columns = c; return b; },
    insert(v) { ops.method = 'insert'; ops.payload = v; return b; },
    upsert(v, o) { ops.method = 'upsert'; ops.payload = v; ops.opts = o; return b; },
    update(v) { ops.method = 'update'; ops.payload = v; return b; },
    delete() { ops.method = 'delete'; return b; },
    eq(c, v) { ops.filters.push(['eq', c, v]); return b; },
    neq(c, v) { ops.filters.push(['neq', c, v]); return b; },
    in(c, v) { ops.filters.push(['in', c, v]); return b; },
    gt(c, v) { ops.filters.push(['gt', c, v]); return b; },
    or(c) { ops.filters.push(['or', c]); return b; },
    order() { return b; }, limit() { return b; },
    single() { ops.single = true; return b; },
    maybeSingle() { ops.single = true; return b; },
    then(onFulfilled, onRejected) {
      calls.push(ops);
      let result;
      try { result = hooks(table, ops); }
      catch (e) { result = Promise.reject(e); }
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return b;
}

function makeClient(hooks, signInError) {
  let session = null;
  const calls = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInAnonymously: async () => {
        if (signInError) return { data: { session: null }, error: signInError };
        session = { user: { id: FAKE_UID } };
        return { data: { session }, error: null };
      },
    },
    from(table) { return makeBuilder(table, hooks, calls); },
    removeChannel() {},
    _calls: calls,
  };
  return client;
}

function defaultResult(table, ops) {
  if (table === 'users' && ops.method === 'upsert') return { error: null };
  return { data: [], error: null };
}

function createApp(overrides = {}) {
  const hooks = (table, ops) => {
    if (overrides.hooks) {
      const r = overrides.hooks(table, ops);
      if (r !== undefined) return r;
    }
    return defaultResult(table, ops);
  };
  const dom = new JSDOM(html, {
    url: 'https://local.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: false,
  });
  const w = dom.window;
  w.requestAnimationFrame = cb => w.setTimeout(cb, 0);
  const unhandled = [];
  w.addEventListener('error', e => unhandled.push(e.message));

  w.Notification = class FakeNotification {
    static permission = 'granted';
    static last = null;
    constructor(title, opts) {
      FakeNotification.last = { title, body: opts && opts.body };
    }
    close() {}
  };

  let client = null;
  w.supabase = { createClient: () => (client = makeClient(hooks, overrides.signInError)) };

  if (overrides.localStorage) {
    for (const [k, v] of Object.entries(overrides.localStorage)) w.localStorage.setItem(k, v);
  }

  w.eval(sources);
  return {
    w, dom,
    client: () => client,
    unhandled,
    async waitInit() {
      return waitFor(() => {
        const ls = w.document.getElementById('loadingScreen');
        return !ls || ls.classList.contains('hidden');
      });
    },
    cleanup() { try { dom.window.close(); } catch (e) {} },
  };
}

// ---- 测试 ----
async function test0_initFailurePath() {
  console.log('\n[T0] 匿名登录失败时的错误提示（模拟未开启 Anonymous 登录）');
  const app = createApp({ signInError: { message: 'anonymous sign-ins are disabled' } });
  const done = await app.waitInit();
  assert(!!done, '初始化流程结束（loading 隐藏）');
  const list = app.w.document.getElementById('conversationList');
  assert(list.textContent.includes('匿名登录失败'), `显示"匿名登录失败"提示（实际: "${list.textContent.replace(/\s+/g, ' ').slice(0, 60)}"）`);
  const upsert = app.client()._calls.find(c => c.table === 'users' && c.method === 'upsert');
  assert(!upsert, '登录失败后未执行身份码认领');
  app.cleanup();
}

async function test1_initSuccess() {
  console.log('\n[T1] 完整初始化（登录 → 认领身份码 → 渲染）');
  const app = createApp();
  const done = await app.waitInit();
  assert(!!done, '初始化在超时前完成');
  const d = app.w.document;
  assert(d.getElementById('conversationList').textContent.includes('还没有会话'), '会话列表渲染空状态');
  const myId = d.getElementById('myId').textContent;
  assert(/^\d{5}$/.test(myId), `身份码为 5 位数字（实际: ${myId}）`);
  assert(d.getElementById('toastContainer').textContent.includes('连接成功'), '显示"连接成功"');
  const upsert = app.client()._calls.find(c => c.table === 'users' && c.method === 'upsert');
  assert(!!upsert, '执行了 users upsert');
  assert(upsert && upsert.payload.auth_uid === FAKE_UID, 'upsert 绑定了 auth_uid');
  assert(upsert && upsert.payload.id === app.w.localStorage.getItem('webchat_id'), '身份码写入 localStorage 且与渲染一致');
  assert(app.unhandled.length === 0, `无未捕获异常（${app.unhandled.length}）`);
  app.cleanup();
}

async function test2_codeCollisionRetry() {
  console.log('\n[T2] 身份码被占用 → 自动换码重试');
  let upsertCount = 0;
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'users' && ops.method === 'upsert') {
        upsertCount++;
        if (upsertCount === 1) return { error: { code: '42501', message: 'row-level security' } };
        return { error: null };
      }
      return undefined;
    },
    localStorage: { webchat_id: '11111' },
  });
  const done = await app.waitInit();
  assert(!!done, '初始化完成');
  assert(upsertCount === 2, `第一次 42501 后重试（实际 ${upsertCount} 次 upsert）`);
  const newId = app.w.localStorage.getItem('webchat_id');
  assert(newId !== '11111' && /^\d{5}$/.test(newId), `已换新码（${newId}）`);
  assert(app.w.document.getElementById('myId').textContent === newId, '界面同步显示新码');
  app.cleanup();
}

async function test3_addContact() {
  console.log('\n[T3] addContact：错误码映射 + 发送申请（不建会话）');
  // 3a: 23503 用户不存在 / 23505 重复或反向申请 / 42501 RLS 拒绝 / 格式校验
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'contacts' && ops.method === 'insert') {
        const code = ops.payload.contact_id === '77777' ? '23505'
          : ops.payload.contact_id === '66666' ? '42501' : '23503';
        return { error: { code } };
      }
      return undefined;
    },
  });
  await app.waitInit();
  let res = await app.w.addContact('88888');
  assert(res && res.error === '用户不存在，请检查身份码', '23503 → "用户不存在，请检查身份码"');
  res = await app.w.addContact('77777');
  assert(res && res.error === '对方已发出申请或已是好友，请到「新的朋友」查看', '23505 → "对方已发出申请或已是好友"');
  res = await app.w.addContact('66666');
  assert(res && res.error === '请求被拒绝，请刷新页面后重试', '42501 → "请求被拒绝，请刷新页面后重试"');
  res = await app.w.addContact('abc');
  assert(res && res.error === '身份码格式不正确', '非数字身份码被本地拦截');
  app.cleanup();

  // 3b: 成功路径 — 单对象插入 pending 申请，不自动创建会话
  // 状态化假数据：插入前列表为空（否则触发"已经是好友"前置检查），插入后可查到
  let contactInsertPayload = null;
  let contactInsertCount = 0;
  let convInserts = 0;
  let memberInserts = 0;
  let inserted = false;
  const app2 = createApp({
    hooks: (table, ops) => {
      if (table === 'contacts' && ops.method === 'insert') {
        contactInsertPayload = ops.payload;
        contactInsertCount++;
        inserted = true;
        return { error: null };
      }
      if (table === 'contacts' && ops.method === 'select') {
        if (!inserted) return { data: [], error: null };
        // 申请发出后：自己为行主、status=pending → 应落入 friendRequests.outgoing
        return { data: [{ id: 'c1', user_id: contactInsertPayload.user_id, contact_id: contactInsertPayload.contact_id, status: 'pending', remark: null, owner: null, target: { display_name: '对方', avatar_color: '#4A90D9' } }], error: null };
      }
      if (table === 'conversations' && ops.method === 'insert') { convInserts++; return undefined; }
      if (table === 'conversation_members' && ops.method === 'insert') { memberInserts++; return { error: null }; }
      return undefined;
    },
  });
  await app2.waitInit();
  res = await app2.w.addContact('88888');
  assert(res && res.success === true, '发送申请成功');
  assert(res && res.message === '已发送好友申请，等待对方验证', `返回提示（实际: ${res && res.message}）`);
  assert(contactInsertCount === 1, 'contacts 只执行一次插入');
  assert(contactInsertPayload && !Array.isArray(contactInsertPayload), 'contacts 为单对象插入（非双向数组）');
  assert(contactInsertPayload && contactInsertPayload.user_id === app2.w.localStorage.getItem('webchat_id'), '只插入自己这行（user_id = 自己）');
  assert(contactInsertPayload && contactInsertPayload.status === 'pending', '插入行 status = pending');
  assert(convInserts === 0, '不自动创建会话');
  assert(memberInserts === 0, '不自动写入会话成员');
  // 行为验证 outgoing 拆分：再次发送同一码应被本地预检拦截，不再落库
  res = await app2.w.addContact('88888');
  assert(res && res.error === '已发送过申请，等待对方验证', '重复发送被 outgoing 预检拦截');
  assert(contactInsertCount === 1, '预检拦截后仍只有 1 次插入');
  app2.cleanup();
}

async function test6_acceptRequest() {
  console.log('\n[T6] 接受好友申请：置 accepted + 自动建会话');
  let updatePayload = null;
  let updateFilters = null;
  let convInserts = 0;
  let memberInserts = 0;
  const memberPayloads = [];
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'contacts' && ops.method === 'select') {
        // init 时即存在一条发给我的 pending 申请
        return {
          data: [{
            id: 'req-1', user_id: '88888', contact_id: '00000', status: 'pending', remark: null,
            owner: { display_name: '申请人', avatar_color: '#4A90D9' }, target: null,
          }], error: null,
        };
      }
      if (table === 'contacts' && ops.method === 'update') {
        updatePayload = ops.payload;
        updateFilters = ops.filters;
        return { data: [{ id: 'req-1' }], error: null };
      }
      if (table === 'conversations' && ops.method === 'insert') {
        convInserts++;
        return { data: { id: 'conv-t1', type: 'direct', name: null, avatar_color: '#5B8C5A', created_by: ops.payload.created_by }, error: null };
      }
      if (table === 'conversation_members' && ops.method === 'insert') {
        memberInserts++;
        memberPayloads.push(ops.payload);
        return { error: null };
      }
      return undefined;
    },
  });
  const done = await app.waitInit();
  assert(!!done, '初始化完成');

  // 徽标与列表渲染（Step 4）
  const badge = app.w.document.getElementById('friendReqBadge');
  assert(badge && badge.textContent === '1' && badge.style.display !== 'none', '徽标显示 1 条未读申请');
  app.w.renderFriendRequests();
  const inHtml = app.w.document.getElementById('incomingReqList').innerHTML;
  assert(inHtml.includes('申请人'), '申请列表渲染申请人昵称');
  assert(inHtml.includes('data-action="accept"') && inHtml.includes('data-action="decline"'), '渲染接受/拒绝按钮');
  const outHtml = app.w.document.getElementById('outgoingReqList').innerHTML;
  assert(outHtml.includes('暂无已发送的申请'), '已发送区为空状态');

  // 不存在的 id → 本地查找即失败，不触碰 DB
  const bad = await app.w.acceptFriendRequest('nope');
  assert(bad && bad.error === '该申请已失效', '不存在的申请 id 直接返回失效');

  const res = await app.w.acceptFriendRequest('req-1');
  assert(res && res.success === true, '接受成功（证明申请已落入 incoming）');
  assert(res && res.name === '申请人', `返回申请人昵称（实际: ${res && res.name}）`);
  assert(updatePayload && Object.keys(updatePayload).length === 1 && updatePayload.status === 'accepted', 'update 仅提交 {status:"accepted"}');
  assert(updateFilters && updateFilters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'pending'), 'update 带 status=pending 条件（防取消竞态）');
  assert(convInserts === 1, '自动创建 1 个私聊会话');
  const myId = app.w.localStorage.getItem('webchat_id');
  assert(memberInserts === 2, `写入 2 行会话成员（实际 ${memberInserts}）`);
  assert(memberPayloads[0] && memberPayloads[0].user_id === myId && memberPayloads[0].role === 'owner', '自己先以 owner 入会');
  assert(memberPayloads[1] && memberPayloads[1].user_id === '88888' && memberPayloads[1].role === 'member', '对方后以 member 入会');
  app.cleanup();
}

async function test7_pollContactsSync() {
  console.log('\n[T7] pollContacts：变更检测 + 徽标/提示（无会话时也同步，H8）');
  let phase = 'none';  // none → outgoing → accepted
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'contacts' && ops.method === 'select') {
        const myId = app.w.localStorage.getItem('webchat_id');
        const row = {
          id: 'out-1', user_id: myId, contact_id: '88888', remark: null,
          owner: { display_name: '我', avatar_color: '#4A90D9' },
          target: { display_name: '对方', avatar_color: '#5B8C5A' },
        };
        if (phase === 'outgoing') return { data: [{ ...row, status: 'pending' }], error: null };
        if (phase === 'accepted') return { data: [{ ...row, status: 'accepted' }], error: null };
        return { data: [], error: null };
      }
      return undefined;
    },
  });
  const done = await app.waitInit();
  assert(!!done, '初始化完成');
  const d = app.w.document;

  // H8：无任何会话（conversations 为空）时，pollMessages 的 early-return 之前仍要同步 contacts
  phase = 'outgoing';
  await app.w.pollMessages();
  assert(d.getElementById('friendReqBadge').style.display === 'none', 'outgoing 不点亮徽标');
  app.w.renderFriendRequests();
  assert(d.getElementById('outgoingReqList').innerHTML.includes('已发送申请'), 'H8: 无会话时轮询仍刷新申请状态');

  // 对方接受 → 我方收到提示
  phase = 'accepted';
  await app.w.pollContacts();
  assert(d.getElementById('toastContainer').textContent.includes('通过了你的好友申请'), '申请被接受后收到提示');

  // 签名未变 → 不重复提示
  const before = d.getElementById('toastContainer').textContent;
  await app.w.pollContacts();
  assert(d.getElementById('toastContainer').textContent === before, '签名未变时不重复提示');
  app.cleanup();
}

async function test4_xssAvatarColor() {
  console.log('\n[T4] 恶意 avatar_color 注入被白名单拦截');
  const evil = 'red" onmouseover="alert(1)" x="';
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'conversation_members' && ops.method === 'select') {
        return {
          data: [{
            conversation_id: 'conv-x', user_id: '99999', role: 'member',
            users: { display_name: '恶人', avatar_color: evil },
          }], error: null,
        };
      }
      if (table === 'conversations' && ops.method === 'select') {
        return {
          data: [{ id: 'conv-x', type: 'group', name: '测试群', avatar_color: evil, created_by: '99999' }], error: null,
        };
      }
      if (table === 'conversation_last_message') return { data: [], error: null };
      return undefined;
    },
  });
  const done = await app.waitInit();
  assert(!!done, '初始化完成');
  const htmlOut = app.w.document.getElementById('conversationList').innerHTML;
  assert(!htmlOut.includes('onmouseover'), '渲染输出不含 onmouseover 注入');
  assert(!htmlOut.includes('alert(1)'), '渲染输出不含 alert 载荷');
  assert(htmlOut.includes('background:#999'), '非法颜色回退为默认色 #999');
  assert(app.w.document.getElementById('conversationList').textContent.includes('测试群'), '群名正常渲染');
  app.cleanup();
}

async function test5_notifyPreview() {
  console.log('\n[T5] 通知默认不预览消息正文（3s 轮询触发）');
  let msgSeq = 0;
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'conversation_members' && ops.method === 'select') {
        return { data: [{ conversation_id: 'conv-n', user_id: '99999', role: 'member', users: { display_name: '小明', avatar_color: '#4A90D9' } }], error: null };
      }
      if (table === 'conversations' && ops.method === 'select') {
        return { data: [{ id: 'conv-n', type: 'direct', name: null, avatar_color: '#5B8C5A', created_by: '99999' }], error: null };
      }
      if (table === 'conversation_last_message') return { data: [], error: null };
      if (table === 'messages' && ops.method === 'select') {
        msgSeq++;
        return {
          data: [{
            id: 'm' + msgSeq, conversation_id: 'conv-n', sender_id: '99999',
            content: `机密内容-${msgSeq}`, msg_type: 'text', created_at: new Date().toISOString(),
          }], error: null,
        };
      }
      return undefined;
    },
  });
  const done = await app.waitInit();
  assert(!!done, '初始化完成');
  // 页面切到后台（否则 notify.send 前台直接跳过）
  Object.defineProperty(app.w.document, 'visibilityState', { configurable: true, get: () => 'hidden' });

  // 第一次轮询（3s 周期）：默认关闭预览
  const got1 = await waitFor(() => app.w.Notification.last !== null, 5000);
  assert(!!got1, '轮询触发了通知');
  const last1 = app.w.Notification.last;
  assert(last1 && last1.body === '收到新消息', `默认通知不显示内容（实际: "${last1 && last1.body}"）`);

  // 开启预览，等第二次轮询
  app.w.localStorage.setItem('webchat_notify_preview', 'on');
  app.w.Notification.last = null;
  const got2 = await waitFor(() => app.w.Notification.last !== null, 5000);
  assert(!!got2, '开启预览后再次触发通知');
  const last2 = app.w.Notification.last;
  assert(last2 && last2.body.includes('机密内容-2'), `预览开启后显示内容（实际: "${last2 && last2.body}"）`);
  app.cleanup();
}

async function test8_recoverIdentity() {
  console.log('\n[T8] recoverIdentity：找回原身份（解绑当前 → 认领原码 → 切换刷新）');

  // 8a: 格式/同码校验在本地拦截，不触碰数据库
  const app = createApp();
  await app.waitInit();
  const userUpdates = () => app.client()._calls.filter(c => c.table === 'users' && c.method === 'update').length;
  const n0 = userUpdates();
  let res = await app.w.recoverIdentity('abc');
  assert(res && res.error === '身份码格式不正确', '非数字身份码被本地拦截');
  const curId = app.w.localStorage.getItem('webchat_id');
  res = await app.w.recoverIdentity(curId);
  assert(res && res.error === '当前身份码就是它，无需找回', '输入当前码提示无需找回');
  assert(userUpdates() === n0, '校验失败时未执行任何数据库更新');
  app.cleanup();

  // 8b: 成功路径 — 解绑当前身份 → 认领原码（未被占用）→ 恢复原资料并切换
  const updates = [];
  const app2 = createApp({
    hooks: (table, ops) => {
      if (table === 'users' && ops.method === 'update') {
        updates.push({ payload: ops.payload, filters: ops.filters });
        if (ops.filters.some(f => f[0] === 'eq' && f[1] === 'id' && f[2] === '88888')) {
          return { data: [{ id: '88888', display_name: '老昵称', avatar_color: '#5B8C5A' }], error: null };
        }
        return { data: [], error: null };
      }
      return undefined;
    },
  });
  await app2.waitInit();
  const beforeId = app2.w.localStorage.getItem('webchat_id');
  assert(beforeId !== '88888', '初始化身份不是原码（模拟已被换码）');
  const m0 = updates.length;
  res = await app2.w.recoverIdentity('88888');
  assert(res && res.success === true, '找回成功');
  const rec = updates.slice(m0);
  assert(rec.length === 2, `两次更新：解绑当前 + 认领原码（实际 ${rec.length} 次）`);
  assert(rec[0] && rec[0].payload.auth_uid === null &&
    rec[0].filters.some(f => f[1] === 'id' && f[2] === beforeId) &&
    rec[0].filters.some(f => f[1] === 'auth_uid' && f[2] === FAKE_UID),
    '第一步：解绑当前身份（auth_uid 置空，限自己绑定的行）');
  assert(rec[1] && rec[1].payload.auth_uid === FAKE_UID &&
    rec[1].filters.some(f => f[1] === 'id' && f[2] === '88888') &&
    rec[1].filters.some(f => f[1] === 'auth_uid' && f[2] === null),
    '第二步：认领原码（要求该行未被占用）');
  assert(rec[1].payload.display_name === undefined, '认领不覆写原身份的昵称列');
  assert(app2.w.localStorage.getItem('webchat_id') === '88888', 'localStorage 身份码切换为原码');
  assert(app2.w.localStorage.getItem('webchat_name') === '老昵称', '恢复原身份昵称');
  assert(app2.w.localStorage.getItem('webchat_color') === '#5B8C5A', '恢复原头像颜色');
  app2.cleanup();

  // 8c: 失败路径 — 原码不可用（未解绑/不存在）→ 回滚当前身份，localStorage 不变
  const updates3 = [];
  const app3 = createApp({
    hooks: (table, ops) => {
      if (table === 'users' && ops.method === 'update') {
        updates3.push({ payload: ops.payload, filters: ops.filters });
        if (ops.filters.some(f => f[0] === 'eq' && f[1] === 'id' && f[2] === '88888')) {
          return { data: [], error: null }; // 认领匹配 0 行：原码仍被占用或不存在
        }
        return { data: [], error: null };
      }
      return undefined;
    },
  });
  await app3.waitInit();
  const id3 = app3.w.localStorage.getItem('webchat_id');
  const m3 = updates3.length;
  res = await app3.w.recoverIdentity('88888');
  assert(res && res.error === '该身份码不存在或仍被占用，请确认后重试', '认领失败返回明确错误');
  assert(app3.w.localStorage.getItem('webchat_id') === id3, '失败时身份码保持不变（不触发换码）');
  const rec3 = updates3.slice(m3);
  assert(rec3.length === 3, `三次更新：解绑 + 尝试认领 + 回滚（实际 ${rec3.length} 次）`);
  assert(rec3[2] && rec3[2].payload.auth_uid === FAKE_UID &&
    rec3[2].filters.some(f => f[1] === 'id' && f[2] === id3) &&
    rec3[2].filters.some(f => f[1] === 'auth_uid' && f[2] === null),
    '回滚：重新绑定当前身份');
  app3.cleanup();
}

async function test9_maintenanceNotice() {
  console.log('\n[T9] 维护通知弹窗：打开网站即显示，可点击关闭');
  const app = createApp();
  const doc = app.w.document;
  const modal = doc.getElementById('modalMaintenance');
  assert(!!modal, '维护通知弹窗存在于页面');
  assert(modal.style.display === 'flex', '初始化时弹窗已显示（先于 init 打开）');
  const btn = doc.getElementById('btnMaintenanceClose');
  assert(!!btn, '关闭按钮存在');
  btn.click();
  assert(modal.style.display === 'none', '点击「我知道了」后弹窗关闭');
  await app.waitInit();
  assert(modal.style.display === 'none', '初始化完成后弹窗不会重新弹出');
  app.cleanup();
}

(async () => {
  try {
    await test0_initFailurePath();
    await test1_initSuccess();
    await test2_codeCollisionRetry();
    await test3_addContact();
    await test4_xssAvatarColor();
    await test5_notifyPreview();
    await test6_acceptRequest();
    await test7_pollContactsSync();
    await test8_recoverIdentity();
    await test9_maintenanceNotice();
  } catch (e) {
    failed++;
    console.log('\n💥 测试套件异常:', e.stack || e);
  }
  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  if (failures.length) failures.forEach(f => console.log('  失败: ' + f));
  process.exit(failed ? 1 : 0);
})();
