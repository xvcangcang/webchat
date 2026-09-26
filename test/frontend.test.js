// WebChat 前端集成测试（jsdom + 假 Supabase 后端）
// 运行：npm install && npm test（无需真实后端、无需起 HTTP 服务）
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAKE_UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ACCOUNT_CODE = '12345';
const DEFAULT_SESSION = { user: { id: FAKE_UID, email: `${ACCOUNT_CODE}@xvcangcang.github.io` } };
const LEGACY_SESSION = { user: { id: FAKE_UID } };   // 匿名会话（老用户）
const DEFAULT_USER_ROW = { id: ACCOUNT_CODE, display_name: '用户', avatar_color: '#4A90D9' };

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace(/<script src="https:\/\/cdn\.jsdelivr[^>]+><\/script>/, '');
// config.js 已入库；缺失时（如尚未创建）回退到模板（测试用假客户端，配置值无实际影响）
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

// 默认会话 = 账号会话（身份码 12345 来自邮箱前缀）；opts.session 传 null 模拟新浏览器
// opts.auth 覆盖各 auth 方法的行为（例：{ signUp: () => ({ error: { code: 'user_already_exists' } }) }）
function makeClient(hooks, opts = {}) {
  const session = opts.session === undefined ? DEFAULT_SESSION : opts.session;
  const calls = [];
  const authHooks = opts.auth || {};
  const callAuth = (name, args) => {
    calls.push({ method: 'auth', table: 'auth', auth: name, args });
    if (authHooks[name]) return authHooks[name](args);
    return { data: {}, error: null };
  };
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signUp: async (a) => callAuth('signUp', a),
      signInWithPassword: async (a) => callAuth('signInWithPassword', a),
      signInAnonymously: async () => callAuth('signInAnonymously'),
      updateUser: async (a) => callAuth('updateUser', a),
      signOut: async () => callAuth('signOut'),
    },
    from(table) { return makeBuilder(table, hooks, calls); },
    rpc(name, args) {
      const ops = { method: 'rpc', table: 'rpc', rpc: name, args };
      return {
        then(onFulfilled, onRejected) {
          calls.push(ops);
          let result;
          try { result = hooks(ops.table, ops); }
          catch (e) { result = Promise.reject(e); }
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
    },
    removeChannel() {},
    _calls: calls,
  };
  return client;
}

function defaultResult(table, ops) {
  if (table === 'users' && (ops.method === 'insert' || ops.method === 'upsert')) return { error: null };
  return { data: [], error: null };
}

function createApp(overrides = {}) {
  const hooks = (table, ops) => {
    if (overrides.hooks) {
      const r = overrides.hooks(table, ops);
      if (r !== undefined) return r;
    }
    // users 的查询（按身份码 / 按 auth_uid 取自己的那行）返回单行；userRow: null 表示没有绑定行
    if (table === 'users' && ops.method === 'select') {
      if (overrides.userRowError) return { data: null, error: overrides.userRowError };
      return { data: overrides.userRow === undefined ? DEFAULT_USER_ROW : overrides.userRow, error: null };
    }
    return defaultResult(table, ops);
  };
  // location.reload() 在 jsdom 里必然报「Not implemented: navigation」——不当错误，
  // 反而记下来当"流程走完了并刷新页面"的证据（reloads()）
  const reloads = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    const msg = String((e && e.message) || e);
    if (/Not implemented/i.test(msg)) { reloads.push(msg); return; }
    console.error(msg);
  });
  ['error', 'warn', 'info', 'log', 'dir', 'debug'].forEach(m => {
    vc.on(m, (...args) => console[m](...args));   // 与默认虚拟控制台一致：页面日志照常打印
  });

  const dom = new JSDOM(html, {
    url: 'https://local.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: false,
    virtualConsole: vc,
  });
  const w = dom.window;
  w.requestAnimationFrame = cb => w.setTimeout(cb, 0);
  // jsdom 的 confirm() 恒为 undefined（只报 Not implemented）→ 默认放行，需要拒绝时用 overrides.confirm
  w.confirm = overrides.confirm === undefined ? () => true : overrides.confirm;
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
  w.supabase = {
    createClient: () => (client = makeClient(hooks, { session: overrides.session, auth: overrides.auth })),
  };

  if (overrides.localStorage) {
    for (const [k, v] of Object.entries(overrides.localStorage)) w.localStorage.setItem(k, v);
  }

  w.eval(sources);
  return {
    w, dom,
    client: () => client,
    unhandled,
    reloads: () => reloads.length,   // 页面刷新次数（注册/登录/升级成功后应为 1）
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
async function test0_loggedOut() {
  console.log('\n[T0] 新浏览器（无会话）→ 未登录，不自动分配身份码');
  const app = createApp({ session: null });
  const done = await app.waitInit();
  assert(!!done, '初始化流程结束（loading 隐藏）');
  const d = app.w.document;
  assert(d.getElementById('conversationList').textContent.includes('未登录'), '会话列表显示未登录空状态');
  assert(d.getElementById('myName').textContent === '未登录', '侧栏昵称显示未登录');
  assert(d.getElementById('myId').textContent === '------', '身份码占位为 ------');
  assert(!app.w.localStorage.getItem('webchat_id'), '未登录时不写入任何身份码');
  assert(app.client()._calls.length === 0,
    `未登录时不发起任何数据请求（实际 ${app.client()._calls.length} 次）`);
  const claimed = app.client()._calls.find(c => c.table === 'users' && c.method === 'insert');
  assert(!claimed, '未登录时不插入身份码行');
  assert(!d.getElementById('toastContainer').textContent.includes('连接成功'), '未登录时不提示连接成功');
  app.cleanup();
}

async function test1_initSuccess() {
  console.log('\n[T1] 账号会话初始化（身份码由邮箱派生 → 渲染）');
  const app = createApp();
  const done = await app.waitInit();
  assert(!!done, '初始化在超时前完成');
  const d = app.w.document;
  assert(d.getElementById('conversationList').textContent.includes('还没有会话'), '会话列表渲染空状态');
  const myId = d.getElementById('myId').textContent;
  assert(myId === ACCOUNT_CODE, `身份码来自账号邮箱前缀（实际: ${myId}）`);
  assert(d.getElementById('toastContainer').textContent.includes('连接成功'), '显示"连接成功"');

  const sel = app.client()._calls.find(c => c.table === 'users' && c.method === 'select');
  assert(!!sel, '按身份码读取自己的资料行');
  assert(sel && sel.filters.some(f => f[0] === 'eq' && f[1] === 'id' && f[2] === ACCOUNT_CODE),
    '查询条件为 id = 身份码');
  assert(!app.client()._calls.find(c => c.table === 'users' && c.method === 'insert'),
    '不再自动插入/认领身份码行');
  assert(app.client()._calls.filter(c => c.method === 'rpc').length === 0,
    '账号会话启动时不调用任何 RPC（无需解绑/认领）');
  assert(app.w.localStorage.getItem('webchat_id') === ACCOUNT_CODE, '身份码写回本地缓存供首屏');
  assert(app.w.localStorage.getItem('webchat_name') === '用户', '昵称取自资料行');
  assert(app.unhandled.length === 0, `无未捕获异常（${app.unhandled.length}）`);
  app.cleanup();
}

async function test2_identityResolution() {
  console.log('\n[T2] 身份码解析：账号走邮箱 / 匿名会话查绑定行 / 认领本机遗留码');

  // 2a: 匿名会话 + 已绑定行 → 直接用该行，不做任何认领
  const app = createApp({
    session: LEGACY_SESSION,
    userRow: { id: '54321', display_name: '老王', avatar_color: '#5B8C5A' },
  });
  const done = await app.waitInit();
  assert(!!done, '初始化完成');
  const sel = app.client()._calls.find(c => c.table === 'users' && c.method === 'select');
  assert(sel && sel.filters.some(f => f[0] === 'eq' && f[1] === 'auth_uid' && f[2] === FAKE_UID),
    '匿名会话按 auth_uid 查绑定行');
  assert(app.w.document.getElementById('myId').textContent === '54321', '身份码取自绑定行（不再是本机随机码）');
  assert(app.w.localStorage.getItem('webchat_name') === '老王', '昵称取自绑定行');
  assert(app.client()._calls.filter(c => c.method === 'rpc').length === 0, '有绑定行时不调用认领函数');
  app.cleanup();

  // 2b: 匿名会话 + 无绑定行 + 本机还留着身份码 → 服务端认领回来（v1.9.0 兼容路径）
  const claims = [];
  const app2 = createApp({
    session: LEGACY_SESSION,
    userRow: null,
    hooks: (table, ops) => {
      if (ops.method === 'rpc' && ops.rpc === 'recover_identity') {
        claims.push(ops.args);
        return { data: { id: '11111', display_name: '我', avatar_color: '#4A90D9' }, error: null };
      }
      return undefined;
    },
    localStorage: { webchat_id: '11111' },
  });
  const done2 = await app2.waitInit();
  assert(!!done2, '初始化完成');
  assert(claims.length === 1 && claims[0].p_code === '11111',
    `本机遗留身份码交给服务端认领（实际 ${claims.length} 次）`);
  assert(app2.w.document.getElementById('myId').textContent === '11111', '认领成功 → 原身份码保住');
  assert(app2.w.localStorage.getItem('webchat_id') === '11111', '本地缓存同步为原码');
  assert(app2.client()._calls.filter(c => c.table === 'users' && c.method === 'insert').length === 0,
    '不再自动插入新身份码行');
  app2.cleanup();

  // 2c: 匿名会话 + 无绑定行 + 本机没有身份码 → 未登录（不静默换码）
  const app3 = createApp({ session: LEGACY_SESSION, userRow: null });
  const done3 = await app3.waitInit();
  assert(!!done3, '初始化完成');
  assert(app3.w.document.getElementById('conversationList').textContent.includes('未登录'), '显示未登录空状态');
  assert(!app3.w.localStorage.getItem('webchat_id'), '未登录时不凭空生成身份码');
  assert(app3.client()._calls.filter(c => c.method === 'rpc').length === 0, '没有可认领的码时不调用 RPC');
  app3.cleanup();

  // 2d: 服务端函数缺失（还没执行新版 SQL）→ 明确提示，不静默失败
  const app4 = createApp({
    session: LEGACY_SESSION,
    userRow: null,
    hooks: (table, ops) => {
      if (ops.method === 'rpc' && ops.rpc === 'recover_identity') {
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.recover_identity(p_code)' } };
      }
      return undefined;
    },
    localStorage: { webchat_id: '11111' },
  });
  const done4 = await app4.waitInit();
  assert(!!done4, '初始化结束（loading 隐藏）');
  const banner = app4.w.document.getElementById('conversationList').textContent;
  assert(banner.includes('supabase-setup.sql'), `提示需先执行 SQL（实际: "${banner.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);
  app4.cleanup();
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
  console.log('\n[T8] recoverIdentity：找回原身份（服务端解绑+认领 → 切换刷新）');

  // 8a: 格式/同码校验在本地拦截，不触碰数据库
  const app = createApp();
  await app.waitInit();
  const rpcCalls = () => app.client()._calls.filter(c => c.method === 'rpc').length;
  const n0 = rpcCalls();
  let res = await app.w.recoverIdentity('abc');
  assert(res && res.error === '身份码格式不正确', '非数字身份码被本地拦截');
  const curId = app.w.localStorage.getItem('webchat_id');
  res = await app.w.recoverIdentity(curId);
  assert(res && res.error === '当前身份码就是它，无需找回', '输入当前码提示无需找回');
  assert(rpcCalls() === n0, '校验失败时未调用服务端函数');
  app.cleanup();

  // 8b: 成功路径 — 一次 RPC 完成解绑+认领，返回原资料后切换刷新
  const rpcArgs = [];
  const app2 = createApp({
    hooks: (table, ops) => {
      if (ops.method === 'rpc' && ops.rpc === 'recover_identity') {
        rpcArgs.push(ops.args);
        return { data: { id: '88888', display_name: '老昵称', avatar_color: '#5B8C5A' }, error: null };
      }
      return undefined;
    },
  });
  await app2.waitInit();
  const beforeId = app2.w.localStorage.getItem('webchat_id');
  assert(beforeId !== '88888', '初始化身份不是原码（模拟已被换码）');
  res = await app2.w.recoverIdentity('88888');
  assert(res && res.success === true, '找回成功');
  assert(rpcArgs.length === 1 && rpcArgs[0].p_code === '88888',
    `调用 recover_identity 且只传原码（实际 ${rpcArgs.length} 次）`);
  assert(app2.w.localStorage.getItem('webchat_id') === '88888', 'localStorage 身份码切换为原码');
  assert(app2.w.localStorage.getItem('webchat_name') === '老昵称', '恢复原身份昵称');
  assert(app2.w.localStorage.getItem('webchat_color') === '#5B8C5A', '恢复原头像颜色');
  assert(app2.client()._calls.filter(c => c.table === 'users' && c.method === 'update').length === 0,
    '不再从前端直接改 users（解绑/认领只在服务端函数内做）');
  app2.cleanup();

  // 8c: 失败路径 — 原码不可用（仍被占用/不存在）→ 服务端事务整体回滚，本地身份码不变
  const app3 = createApp({
    hooks: (table, ops) => {
      if (ops.method === 'rpc' && ops.rpc === 'recover_identity') {
        return { data: null, error: { code: 'P0001', message: 'code_unavailable', details: null, hint: null } };
      }
      return undefined;
    },
  });
  await app3.waitInit();
  const id3 = app3.w.localStorage.getItem('webchat_id');
  res = await app3.w.recoverIdentity('88888');
  assert(res && res.error === '该身份码不存在或仍被占用，请确认后重试', '原码不可用返回明确错误');
  assert(app3.w.localStorage.getItem('webchat_id') === id3,
    '失败时身份码保持不变（服务端已回滚，不在前端补写）');
  app3.cleanup();

  // 8d: 其它服务端错误（如函数未创建）→ 透出错误码与 message/details/hint
  const app4 = createApp({
    hooks: (table, ops) => {
      if (ops.method === 'rpc' && ops.rpc === 'recover_identity') {
        return {
          data: null,
          error: {
            code: '42883',
            message: 'function public.recover_identity(text) does not exist',
            details: null,
            hint: 'run supabase-setup.sql',
          },
        };
      }
      return undefined;
    },
  });
  await app4.waitInit();
  const r4 = await app4.w.recoverIdentity('88888');
  assert(r4 && r4.error && r4.error.startsWith('找回失败（42883）'),
    '未知错误：错误信息开头带服务端错误码');
  assert(r4.error.includes('does not exist') && r4.error.includes('run supabase-setup.sql'),
    '未知错误：透出 message 与 hint');
  app4.cleanup();

  // 8e: 启动阶段不再做任何解绑/认领（账号身份码由邮箱派生，无需腾挪）
  const app5 = createApp();
  await app5.waitInit();
  assert(app5.client()._calls.filter(c => c.method === 'rpc').length === 0,
    '账号会话启动时不调用任何 RPC');
  assert(app5.client()._calls.filter(c => c.table === 'users' && c.method === 'update').length === 0,
    '启动阶段不直接 update users');
  app5.cleanup();
}

async function test9_maintenanceNotice() {
  console.log('\n[T9] 维护通知弹窗：MAINTENANCE_NOTICE 为 false 时不打扰用户');
  const app = createApp();
  const doc = app.w.document;
  const modal = doc.getElementById('modalMaintenance');
  assert(!!modal, '维护通知弹窗仍保留在页面（下次维护可直接开关）');
  const flag = /const MAINTENANCE_NOTICE = (true|false)/.exec(sources);
  assert(flag && flag[1] === 'false', '维护开关在 version.js 中已关闭');
  assert(modal.style.display !== 'flex', '恢复正常使用后不再弹出维护通知');
  const btn = doc.getElementById('btnMaintenanceClose');
  assert(!!btn, '关闭按钮存在');
  btn.click();
  await app.waitInit();
  assert(modal.style.display === 'none', '初始化后弹窗保持关闭');
  app.cleanup();
}

// ---- T10 辅助：走真实 DOM，覆盖 openAuthModal / bindEvents 的接线 ----
function fillAuthForm(w, { code, pwd, pwd2 } = {}) {
  const d = w.document;
  if (code !== undefined) d.getElementById('inputAuthCode').value = code;
  if (pwd !== undefined) d.getElementById('inputAuthPwd').value = pwd;
  if (pwd2 !== undefined) d.getElementById('inputAuthPwd2').value = pwd2;
  d.getElementById('btnAuthSubmit').click();
}

// 每次提交前清空提示，便于等待"这一次"的结果
async function submitAndRead(w, vals, timeout = 3000) {
  w.document.getElementById('authFeedback').textContent = '';
  fillAuthForm(w, vals);
  return waitFor(() => {
    const t = w.document.getElementById('authFeedback').textContent;
    return t ? t : null;
  }, timeout);
}

async function test10_accountAuth() {
  console.log('\n[T10] 账号：注册 / 登录 / 设置密码 / 退出登录 + 未登录入口');

  // 10a: 注册成功 — 身份码映射合成邮箱 → auth.signUp → INSERT users 行 → 刷新
  const signUps = [];
  const insertedRows = [];
  const app = createApp({
    session: null,
    auth: {
      signUp: (a) => {
        signUps.push(a);
        return { data: { user: { id: 'uid-new', email: a.email }, session: { user: { id: 'uid-new' } } }, error: null };
      },
    },
    hooks: (table, ops) => {
      if (table === 'users' && ops.method === 'insert') { insertedRows.push(ops.payload); return { error: null }; }
      return undefined;
    },
  });
  await app.waitInit();
  const d = app.w.document;
  d.querySelector('#conversationList [data-auth-action="register"]').click();
  assert(d.getElementById('modalAuth').style.display === 'flex', '未登录点「注册账号」打开账号弹窗');
  assert(d.getElementById('authTitle').textContent === '注册账号', '进入注册模式');
  assert(d.getElementById('authConfirmWrap').style.display === 'block', '注册模式显示确认密码');
  assert(d.getElementById('authCodeWrap').style.display === 'block', '注册模式需要身份码');

  const fb = await submitAndRead(app.w, { code: '24680', pwd: 'password1', pwd2: 'password1' });
  assert(!!fb && fb.includes('成功'), `注册成功给出提示（实际: "${fb}"）`);
  assert(signUps.length === 1 && signUps[0].email === '24680@xvcangcang.github.io',
    `身份码映射为合成邮箱（实际: ${signUps[0] && signUps[0].email}）`);
  assert(signUps[0] && signUps[0].password === 'password1', '密码交给 Supabase Auth（前端不落库）');
  assert(insertedRows.length === 1 && insertedRows[0].id === '24680', 'users 行以身份码为主键');
  assert(insertedRows[0] && insertedRows[0].auth_uid === 'uid-new', '身份行绑定到新账号 uid');
  assert(app.reloads() === 1, `注册成功后刷新页面（实际 ${app.reloads()} 次）`);
  app.cleanup();

  // 10b: 撞码（邮箱已注册 422）→ 可读提示，不写库不刷新
  const app2 = createApp({
    session: null,
    auth: {
      signUp: () => ({
        data: { user: null, session: null },
        error: { code: 'user_already_exists', status: 422, message: 'User already registered' },
      }),
    },
  });
  await app2.waitInit();
  app2.w.openAuthModal('register');
  const fb2 = await submitAndRead(app2.w, { code: '12345', pwd: 'password1', pwd2: 'password1' });
  assert(fb2 === '该身份码已被注册，换一个试试', `撞码提示可读（实际: "${fb2}"）`);
  assert(app2.client()._calls.filter(c => c.table === 'users' && c.method === 'insert').length === 0,
    '撞码时不写身份行');
  assert(app2.reloads() === 0, '撞码时不刷新页面');
  app2.cleanup();

  // 10c: 第二步建行失败 → 必须 signOut 回滚，不留"有账号没身份"的孤儿
  let signOuts = 0;
  const app3 = createApp({
    session: null,
    auth: {
      signUp: (a) => ({ data: { user: { id: 'uid-new', email: a.email }, session: { user: { id: 'uid-new' } } }, error: null }),
      signOut: () => { signOuts++; return { error: null }; },
    },
    hooks: (table, ops) => {
      if (table === 'users' && ops.method === 'insert') {
        return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      return undefined;
    },
  });
  await app3.waitInit();
  app3.w.openAuthModal('register');
  const fb3 = await submitAndRead(app3.w, { code: '24680', pwd: 'password1', pwd2: 'password1' });
  assert(fb3 === '该身份码已被注册，换一个试试', `建行撞码提示可读（实际: "${fb3}"）`);
  assert(signOuts === 1, `建行失败回滚会话（实际 signOut ${signOuts} 次）`);
  assert(app3.reloads() === 0, '注册失败不刷新页面');
  app3.cleanup();

  // 10d: 登录成功 — 任何设备用身份码+密码回到同一 uid
  const logins = [];
  const app4 = createApp({
    session: null,
    auth: { signInWithPassword: (a) => { logins.push(a); return { data: { user: { id: ACCOUNT_CODE } }, error: null }; } },
  });
  await app4.waitInit();
  const d4 = app4.w.document;
  d4.querySelector('#conversationList [data-auth-action="login"]').click();
  assert(d4.getElementById('authTitle').textContent === '登录', '未登录点「登录」进入登录模式');
  assert(d4.getElementById('authConfirmWrap').style.display === 'none', '登录不显示确认密码');
  const fb4 = await submitAndRead(app4.w, { code: '54321', pwd: 'password1' });
  assert(!!fb4 && fb4.includes('成功'), `登录成功给出提示（实际: "${fb4}"）`);
  assert(logins.length === 1 && logins[0].email === '54321@xvcangcang.github.io',
    `登录用合成邮箱（实际: ${logins[0] && logins[0].email}）`);
  assert(app4.reloads() === 1, '登录成功后刷新页面');
  app4.cleanup();

  // 10e: 密码错误 → 不泄露"账号是否存在"，也不刷新
  const app5 = createApp({
    session: null,
    auth: {
      signInWithPassword: () => ({
        error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      }),
    },
  });
  await app5.waitInit();
  app5.w.openAuthModal('login');
  const fb5 = await submitAndRead(app5.w, { code: '54321', pwd: 'wrongpass' });
  assert(fb5 === '身份码或密码不正确', `密码错误提示可读（实际: "${fb5}"）`);
  assert(app5.reloads() === 0, '登录失败不刷新页面');
  app5.cleanup();

  // 10f: 本地校验先于网络请求（格式 / 长度 / 两次不一致 / 必填）
  let signUpCalls = 0;
  const app6 = createApp({
    session: null,
    auth: { signUp: () => { signUpCalls++; return { data: { user: { id: 'u' }, session: { user: { id: 'u' } } }, error: null }; } },
  });
  await app6.waitInit();
  app6.w.openAuthModal('register');
  const bad1 = await submitAndRead(app6.w, { code: '1234', pwd: 'password1', pwd2: 'password1' });
  assert(bad1 === '身份码必须是 5-6 位数字', `身份码格式本地拦截（实际: "${bad1}"）`);
  const bad2 = await submitAndRead(app6.w, { code: '24680', pwd: 'short12', pwd2: 'short12' });
  assert(bad2 === '密码至少 8 位', `密码长度本地拦截（实际: "${bad2}"）`);
  const bad3 = await submitAndRead(app6.w, { code: '24680', pwd: 'password1', pwd2: 'password2' });
  assert(bad3 === '两次输入的密码不一致', `两次不一致本地拦截（实际: "${bad3}"）`);
  const bad4 = await submitAndRead(app6.w, { code: '', pwd: 'password1', pwd2: 'password1' });
  assert(bad4 === '请输入身份码', `空身份码本地拦截（实际: "${bad4}"）`);
  assert(signUpCalls === 0, '全部本地拦截，未发起注册请求');
  assert(app6.reloads() === 0, '校验失败不刷新页面');
  app6.cleanup();

  // 10g: 老用户升级 — 设置里的入口 → updateUser（uid 不变，好友与记录不用动）
  const updates = [];
  const app7 = createApp({
    session: LEGACY_SESSION,
    userRow: { id: '54321', display_name: '老王', avatar_color: '#5B8C5A' },
    auth: { updateUser: (a) => { updates.push(a); return { data: { user: { id: FAKE_UID, email: a.email } }, error: null }; } },
  });
  await app7.waitInit();
  const d7 = app7.w.document;
  d7.getElementById('btnSettings').click();
  const box7 = d7.getElementById('accountBox');
  assert(box7.textContent.includes('54321'), '过渡期老用户在账号区看到自己的身份码');
  const upgradeBtn = box7.querySelector('[data-account-action="upgrade"]');
  assert(!!upgradeBtn, '过渡期老用户看到「设置密码」入口');
  assert(d7.getElementById('recoverIdentityBlock').style.display === 'block', '老用户仍能看到「找回身份」');
  upgradeBtn.click();
  assert(d7.getElementById('modalSettings').style.display === 'none', '点设置密码后关闭设置弹窗');
  assert(d7.getElementById('modalAuth').style.display === 'flex', '并打开账号弹窗');
  assert(d7.getElementById('authTitle').textContent === '设置密码', '进入设置密码模式');
  assert(d7.getElementById('authCodeWrap').style.display === 'none', '设置密码不需要输身份码（沿用现有身份）');

  const fb7 = await submitAndRead(app7.w, { pwd: 'password1', pwd2: 'password1' });
  assert(!!fb7 && fb7.includes('成功'), `设置密码成功给出提示（实际: "${fb7}"）`);
  assert(updates.length === 1, `调用 updateUser 升级当前会话（实际 ${updates.length} 次）`);
  assert(updates[0] && updates[0].email === '54321@xvcangcang.github.io',
    `邮箱由现有身份码派生（实际: ${updates[0] && updates[0].email}）`);
  assert(app7.client()._calls.filter(c => c.method === 'auth' && c.auth === 'signUp').length === 0,
    '升级走 updateUser（uid 不变），不新建账号');
  assert(app7.reloads() === 1, '升级成功后刷新页面');
  app7.cleanup();

  // 10h: 账号用户账号区 + 退出登录（清本机身份码缓存）
  const app8 = createApp();
  await app8.waitInit();
  const d8 = app8.w.document;
  d8.getElementById('btnSettings').click();
  const box8 = d8.getElementById('accountBox');
  assert(box8.textContent.includes('12345'), '账号用户在账号区看到自己的身份码');
  assert(!!box8.querySelector('[data-account-action="password"]'), '账号用户可修改密码');
  assert(!!box8.querySelector('[data-account-action="logout"]'), '账号用户可退出登录');
  assert(d8.getElementById('recoverIdentityBlock').style.display === 'none',
    '账号用户隐藏「找回身份」（登录即回到原身份）');

  d8.querySelector('#accountBox [data-account-action="logout"]').click();
  const cleared = await waitFor(() => !app8.w.localStorage.getItem('webchat_id'));
  assert(!!cleared, '退出登录后清除本机身份码缓存');
  assert(app8.client()._calls.filter(c => c.method === 'auth' && c.auth === 'signOut').length === 1,
    '退出登录调用 signOut');
  assert(app8.reloads() === 1, '退出登录后刷新页面');
  app8.cleanup();

  // 10h-2: 取消确认则不退出（避免误点丢身份）
  const app8b = createApp({ confirm: () => false });
  await app8b.waitInit();
  app8b.w.document.getElementById('btnSettings').click();
  app8b.w.document.querySelector('#accountBox [data-account-action="logout"]').click();
  await sleep(50);
  assert(app8b.w.localStorage.getItem('webchat_id') === ACCOUNT_CODE, '取消确认时保留本机身份码');
  assert(app8b.client()._calls.filter(c => c.method === 'auth' && c.auth === 'signOut').length === 0,
    '取消确认时不调用 signOut');
  app8b.cleanup();

  // 10i: 未登录首屏的找回入口 → 打开设置并聚焦原身份码输入框
  const app9 = createApp({ session: null });
  await app9.waitInit();
  const d9 = app9.w.document;
  assert(!!d9.querySelector('#conversationList [data-auth-action="recover"]'), '未登录首屏有「找回原身份码」入口');
  d9.querySelector('#conversationList [data-auth-action="recover"]').click();
  assert(d9.getElementById('modalSettings').style.display === 'flex', '点找回打开设置弹窗');
  const focused = await waitFor(() => d9.activeElement && d9.activeElement.id === 'inputRecoverId', 1500);
  assert(!!focused, '并聚焦到原身份码输入框');
  app9.cleanup();

  // 10j: 弹窗模式切换 + 随机生成 + 回车提交
  const app10 = createApp({ session: null });
  await app10.waitInit();
  const d10 = app10.w.document;
  app10.w.openAuthModal('login');
  assert(d10.getElementById('btnAuthSwitch').textContent === '还没有账号？去注册', '登录模式显示切换文案');
  assert(d10.getElementById('btnGenCode').style.display === 'none', '登录模式不显示随机生成');
  d10.getElementById('btnAuthSwitch').click();
  assert(d10.getElementById('authTitle').textContent === '注册账号', '点切换进入注册模式');
  assert(d10.getElementById('btnGenCode').style.display !== 'none', '注册模式显示随机生成按钮');
  d10.getElementById('btnGenCode').click();
  const gen = d10.getElementById('inputAuthCode').value;
  assert(/^\d{5,6}$/.test(gen), `随机生成 5-6 位数字身份码（实际: "${gen}"）`);

  d10.getElementById('inputAuthCode').value = '24680';
  d10.getElementById('inputAuthPwd').value = 'password1';
  d10.getElementById('inputAuthPwd2').value = 'password2';
  d10.getElementById('inputAuthPwd2')
    .dispatchEvent(new app10.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert(d10.getElementById('authFeedback').textContent === '两次输入的密码不一致', '输入框回车即提交');

  d10.getElementById('btnAuthSwitch').click();
  assert(d10.getElementById('authTitle').textContent === '登录', '再切换回到登录模式');
  assert(d10.getElementById('inputAuthCode').value === '' && d10.getElementById('inputAuthPwd').value === '',
    '切换模式时清空上次输入（不残留密码）');
  app10.cleanup();
}

(async () => {
  try {
    await test0_loggedOut();
    await test1_initSuccess();
    await test2_identityResolution();
    await test3_addContact();
    await test4_xssAvatarColor();
    await test5_notifyPreview();
    await test6_acceptRequest();
    await test7_pollContactsSync();
    await test8_recoverIdentity();
    await test9_maintenanceNotice();
    await test10_accountAuth();
  } catch (e) {
    failed++;
    console.log('\n💥 测试套件异常:', e.stack || e);
  }
  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  if (failures.length) failures.forEach(f => console.log('  失败: ' + f));
  process.exit(failed ? 1 : 0);
})();
