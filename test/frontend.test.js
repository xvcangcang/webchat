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
  console.log('\n[T3] addContact：错误码映射 + 单向插入');
  // 3a: 23503 用户不存在 / 23505 已是好友 / 格式校验
  const app = createApp({
    hooks: (table, ops) => {
      if (table === 'contacts' && ops.method === 'insert') {
        return { error: { code: ops.payload.contact_id === '77777' ? '23505' : '23503' } };
      }
      return undefined;
    },
  });
  await app.waitInit();
  let res = await app.w.addContact('88888');
  assert(res && res.error === '用户不存在，请检查身份码', '23503 → "用户不存在，请检查身份码"');
  res = await app.w.addContact('77777');
  assert(res && res.error === '该用户已经是好友了', '23505 → "该用户已经是好友了"');
  res = await app.w.addContact('abc');
  assert(res && res.error === '身份码格式不正确', '非数字身份码被本地拦截');
  app.cleanup();

  // 3b: 成功路径 — 单对象插入 + 创建私聊会话
  // 状态化假数据：插入前好友列表为空（否则触发"已经是好友"前置检查），插入后可查到
  let contactInsertPayload = null;
  let contactInsertCount = 0;
  let convInserts = 0;
  let convPayload = null;
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
        return { data: [{ contact_id: '88888', remark: null, users: { display_name: '测试好友', avatar_color: '#4A90D9' } }], error: null };
      }
      if (table === 'conversations' && ops.method === 'insert') {
        convInserts++;
        convPayload = ops.payload;
        return { data: { id: 'conv-test-1', type: 'direct', name: null, avatar_color: '#5B8C5A', created_by: ops.payload.created_by }, error: null };
      }
      if (table === 'conversation_members' && ops.method === 'insert') return { error: null };
      return undefined;
    },
  });
  await app2.waitInit();
  res = await app2.w.addContact('88888');
  assert(res && res.success === true, '添加好友成功');
  assert(res && res.name === '测试好友', `返回好友昵称（实际: ${res && res.name}）`);
  assert(contactInsertCount === 1, 'contacts 只执行一次插入');
  assert(contactInsertPayload && !Array.isArray(contactInsertPayload), 'contacts 为单对象插入（非双向数组）');
  assert(contactInsertPayload && contactInsertPayload.user_id === app2.w.localStorage.getItem('webchat_id'), '只插入自己这行（user_id = 自己）');
  assert(convInserts === 1, '自动创建私聊会话');
  assert(convPayload && convPayload.created_by === app2.w.localStorage.getItem('webchat_id'), '会话 created_by = 自己');
  app2.cleanup();
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

(async () => {
  try {
    await test0_initFailurePath();
    await test1_initSuccess();
    await test2_codeCollisionRetry();
    await test3_addContact();
    await test4_xssAvatarColor();
    await test5_notifyPreview();
  } catch (e) {
    failed++;
    console.log('\n💥 测试套件异常:', e.stack || e);
  }
  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  if (failures.length) failures.forEach(f => console.log('  失败: ' + f));
  process.exit(failed ? 1 : 0);
})();
