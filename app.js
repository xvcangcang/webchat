// ============================================
// WebChat — 主应用逻辑  v1.1
// ============================================

// ---------- 全局状态 ----------
const state = {
  supabase: null,
  myId: null,
  myName: '',
  myColor: '',
  contacts: [],
  friendRequests: { incoming: [], outgoing: [] },  // 好友申请（新的朋友）
  conversations: [],
  currentConvId: null,
  messages: {},           // convId -> [msg]
  unreadCounts: {},       // convId -> 未读消息数
  channels: {},           // convId -> broadcast channel
};

// ---------- 工具函数 ----------
function genShortId() {
  // 生成 5 位随机数字 (10000-99999)
  return String(Math.floor(10000 + Math.random() * 90000));
}

function randomColor() {
  const colors = ['#4A90D9','#5B8C5A','#D94A6B','#D9A04A','#8C5BD9','#4AD9C4','#D96B4A','#6B8CD9','#D94A9E','#4AD97A'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// 颜色白名单：只放行 #RRGGBB，防止拼进 style 属性的 XSS 注入
function safeColor(c, fallback = '#999') {
  return /^#[0-9A-Fa-f]{6}$/.test(c || '') ? c : fallback;
}

function getInitial(name) {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// #8 fix: 复用同一个 DOM 元素，不再每次创建
const _escEl = document.createElement('div');
function escapeHtml(s) {
  if (!s) return '';
  _escEl.textContent = s;
  return _escEl.innerHTML;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
}

function $(id) { return document.getElementById(id); }

function unreadBadgeHtml(convId) {
  const count = state.unreadCounts[convId] || 0;
  if (count === 0) return '';
  const display = count > 99 ? '99+' : String(count);
  return `<span class="unread-badge">${display}</span>`;
}

// ---------- 身份码系统 ----------
async function initIdentity() {
  let id = localStorage.getItem('webchat_id');
  let name = localStorage.getItem('webchat_name');
  let color = localStorage.getItem('webchat_color');

  // 身份码只接受 5/6 位数字，格式异常（含旧 UUID）则重新生成
  if (id && !/^\d{5,6}$/.test(id)) { id = null; localStorage.removeItem('webchat_id'); }
  // 头像颜色只接受 #RRGGBB，防止本地篡改注入到 style 属性
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) { color = null; localStorage.removeItem('webchat_color'); }

  if (!name) { name = '用户'; localStorage.setItem('webchat_name', name); }
  if (!color) { color = randomColor(); localStorage.setItem('webchat_color', color); }

  state.myName = name;
  state.myColor = color;

  // 生成 5 位身份码（占用冲突由 ensureIdentity 换码重试兜底）
  if (!id) {
    id = genShortId();
    localStorage.setItem('webchat_id', id);
  }
  state.myId = id;

  applyTheme();
}

// ---------- 主题系统 ----------
// ---------- 消息通知 ----------
const notify = {
  enabled() {
    return localStorage.getItem('webchat_notify') !== 'off';
  },

  async requestPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  },

  send(title, body, convId) {
    if (!this.enabled()) return;
    if (Notification.permission !== 'granted') return;
    // 页面在前台时不通知（已经有 toast）
    if (document.visibilityState === 'visible') return;

    // 默认不预览消息正文，防止锁屏泄露聊天内容（可在设置中开启）
    const previewOn = localStorage.getItem('webchat_notify_preview') === 'on';

    const n = new Notification(title, {
      body: previewOn ? body.slice(0, 100) : '收到新消息',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%2307c160" width="100" height="100" rx="20"/><text x="50" y="68" text-anchor="middle" fill="white" font-size="50" font-family="sans-serif">W</text></svg>',
      tag: 'webchat-' + convId,  // 同一会话合并通知
    });

    n.onclick = () => {
      window.focus();
      if (convId) openConversation(convId);
      n.close();
    };
  }
};

function applyTheme() {
  const theme = localStorage.getItem('webchat_theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

// ---------- Supabase 初始化：匿名登录 + 身份码认领 ----------
async function ensureAuth() {
  // 已有会话则复用（保证 auth.uid 稳定，身份码绑定不失效）
  const { data: { session } } = await state.supabase.auth.getSession();
  if (session) return session;

  const { data, error } = await state.supabase.auth.signInAnonymously();
  if (error) {
    console.error('Anonymous sign-in error:', error);
    throw new Error('匿名登录失败，请在 Supabase 控制台开启 Anonymous 登录');
  }
  return data.session;
}

async function ensureIdentity() {
  const { data: { session } } = await state.supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) throw new Error('未获得登录会话');

  // 解绑本浏览器历史身份残留的 auth_uid（换码后旧码归还未认领）
  await state.supabase
    .from('users')
    .update({ auth_uid: null })
    .neq('id', state.myId)
    .eq('auth_uid', uid);

  // upsert 认领身份码；码被他人占用则换一个重试
  for (let i = 0; i < 20; i++) {
    const { error } = await state.supabase
      .from('users')
      .upsert({
        id: state.myId,
        display_name: state.myName,
        avatar_color: state.myColor,
        last_seen: new Date().toISOString(),
        auth_uid: uid,
      }, { onConflict: 'id' });

    if (!error) return;

    // 42501 = RLS 拒绝（该码已被他人绑定）；23505 = 主键/唯一冲突
    if (error.code === '42501' || error.code === '23505') {
      state.myId = genShortId();
      localStorage.setItem('webchat_id', state.myId);
      renderMyInfo();
      continue;
    }
    console.error('Claim identity error:', error);
    throw new Error('认领身份码失败，请刷新重试');
  }
  throw new Error('无法分配身份码，请刷新重试');
}

function startHeartbeat() {
  setInterval(async () => {
    await state.supabase
      .from('users')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', state.myId);
  }, 60000);
}

// ---------- 加载数据 ----------
// 单行模型签名（id:status 排序串），供轮询做变更检测
let _contactsSig = '';

function renderFriendRequestBadge() {
  const el = $('friendReqBadge');
  if (!el) return;  // UI 未就绪（步骤 4 前）
  const n = state.friendRequests.incoming.length;
  el.textContent = n > 99 ? '99+' : String(n);
  el.style.display = n > 0 ? '' : 'none';
}

async function loadContacts() {
  // 双向查询：单行模型下行方向在发起方，接收方需靠 contact_id = 我 查到
  const { data, error } = await state.supabase
    .from('contacts')
    .select(`id, user_id, contact_id, status, remark,
      owner:users!contacts_user_id_fkey(display_name, avatar_color),
      target:users!contacts_contact_id_fkey(display_name, avatar_color)`)
    .or(`user_id.eq.${state.myId},contact_id.eq.${state.myId}`);

  if (error) { console.error('Load contacts error:', error); return; }

  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const r of (data || [])) {
    const iAmOwner = r.user_id === state.myId;
    const other = iAmOwner ? r.contact_id : r.user_id;
    const u = iAmOwner ? r.target : r.owner;   // 对侧资料（users_select 反向子句保证可见）
    const row = {
      id: r.id,
      contact_id: other,
      remark: r.remark,
      display_name: u?.display_name || '未知用户',
      avatar_color: safeColor(u?.avatar_color, '#999'),
    };
    if (r.status === 'accepted') {
      // 保持旧 shape：state.contacts 的 5 个读取方无需改动
      friends.push({ contact_id: row.contact_id, remark: row.remark, display_name: row.display_name, avatar_color: row.avatar_color });
    } else if (iAmOwner) {
      outgoing.push(row);
    } else {
      incoming.push(row);
    }
  }
  state.contacts = friends;
  state.friendRequests.incoming = incoming;
  state.friendRequests.outgoing = outgoing;
  _contactsSig = (data || []).map(r => `${r.id}:${r.status}`).sort().join('|');
  renderFriendRequestBadge();
}

async function loadConversations() {
  // 1. 获取我参与的会话 ID
  const { data: memberships, error: e1 } = await state.supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', state.myId);

  if (e1) { console.error('Load conv memberships error:', e1); return; }

  const convIds = (memberships || []).map(m => m.conversation_id);
  if (convIds.length === 0) { state.conversations = []; return; }

  // #10 fix: 用 Promise.all 并行查询，而非串行等待
  const [convsRes, membersRes, lastMsgRes] = await Promise.all([
    state.supabase.from('conversations').select('*').in('id', convIds),
    state.supabase.from('conversation_members')
      .select('conversation_id, user_id, role, users(display_name, avatar_color)')
      .in('conversation_id', convIds),
    // #1 fix: 用视图只取每条会话的最后一条消息，不查全部
    state.supabase.from('conversation_last_message')
      .select('conversation_id, content, sender_id, created_at')
      .in('conversation_id', convIds),
  ]);

  if (convsRes.error) { console.error('Load conversations error:', convsRes.error); return; }

  const lastMsgMap = {};
  for (const msg of (lastMsgRes.data || [])) {
    lastMsgMap[msg.conversation_id] = msg;
  }

  state.conversations = (convsRes.data || []).map(conv => {
    const members = (membersRes.data || [])
      .filter(m => m.conversation_id === conv.id)
      .map(m => ({
        user_id: m.user_id,
        role: m.role || 'member',
        display_name: m.users?.display_name || '未知',
        avatar_color: safeColor(m.users?.avatar_color, '#999'),
      }));

    const lastMsg = lastMsgMap[conv.id];
    let displayName = conv.name;
    let avatarColor = conv.avatar_color;

    if (conv.type === 'direct') {
      const other = members.find(m => m.user_id !== state.myId);
      if (other) {
        const contact = state.contacts.find(c => c.contact_id === other.user_id);
        displayName = contact?.remark || other.display_name;
        avatarColor = other.avatar_color;
      }
    }

    return {
      id: conv.id,
      type: conv.type,
      name: displayName || '未命名会话',
      avatar_color: safeColor(avatarColor, '#999'),
      members,
      lastMsg: lastMsg ? { content: lastMsg.content, sender_id: lastMsg.sender_id, time: lastMsg.created_at } : null,
    };
  });

  state.conversations.sort((a, b) => {
    const ta = a.lastMsg?.time || '0';
    const tb = b.lastMsg?.time || '0';
    return tb.localeCompare(ta);
  });

  // 会话变化后刷新实时订阅（由调用方显式触发，不在这里自动调）
}

async function loadMessages(convId) {
  // #6 fix: 每次打开会话都刷新消息（实时订阅可能漏掉加入前的消息）
  const { data, error } = await state.supabase
    .from('messages')
    .select('id, sender_id, content, msg_type, created_at')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) { console.error('Load messages error:', error); return state.messages[convId] || []; }

  state.messages[convId] = data || [];
  return state.messages[convId];
}

// ---------- 好友操作 ----------
async function addContact(contactId) {
  if (contactId === state.myId) return { error: '不能添加自己' };
  if (!/^\d{5,6}$/.test(contactId)) return { error: '身份码格式不正确' };

  // 预检本地状态（DB 的 contacts_pair_uniq 是最终兜底）
  if (state.contacts.find(c => c.contact_id === contactId)) return { error: '该用户已经是好友了' };
  if (state.friendRequests.outgoing.find(c => c.contact_id === contactId)) return { error: '已发送过申请，等待对方验证' };
  if (state.friendRequests.incoming.find(c => c.contact_id === contactId)) return { error: '对方也向你发出了申请，请到「新的朋友」接受' };

  // 发起申请：单行模型只允许以自己名义插入 pending 行，不自动建会话
  const { error } = await state.supabase
    .from('contacts')
    .insert({ user_id: state.myId, contact_id: contactId, status: 'pending' });

  if (error) {
    // 23503 = 外键不存在（目标未注册）；23505 = 重复/反向申请被 contacts_pair_uniq 拦下
    if (error.code === '23503') return { error: '用户不存在，请检查身份码' };
    if (error.code === '23505') return { error: '对方已发出申请或已是好友，请到「新的朋友」查看' };
    if (error.code === '42501') return { error: '请求被拒绝，请刷新页面后重试' };
    console.error('Add contact error:', error);
    return { error: '添加失败，请重试' };
  }

  await loadContacts();
  return { success: true, message: '已发送好友申请，等待对方验证' };
}

// ---------- 好友申请：接受 / 拒绝 / 取消 ----------
async function acceptFriendRequest(reqId) {
  const req = state.friendRequests.incoming.find(r => r.id === reqId);
  if (!req) return { error: '该申请已失效' };

  // 仅接收方可置 accepted（RLS）；status 条件防"发送方已取消"竞态与双击
  const { data, error } = await state.supabase
    .from('contacts')
    .update({ status: 'accepted' })
    .eq('id', reqId)
    .eq('contact_id', state.myId)
    .eq('status', 'pending')
    .select('id');
  if (error) { console.error('Accept request error:', error); return { error: '接受失败，请重试' }; }
  if (!data || data.length === 0) return { error: '该申请已失效' };

  // 好友关系生效 → 自动创建私聊会话（members_insert 双向 + accepted 策略已放行）
  await getOrCreateDirectConversation(req.contact_id);

  await loadContacts();
  await loadConversations();
  renderConversationList();
  return { success: true, name: req.display_name };
}

async function declineFriendRequest(reqId) {  // 接收方拒绝
  return removeFriendRequest(reqId);
}

async function cancelFriendRequest(reqId) {   // 发送方取消
  return removeFriendRequest(reqId);
}

async function removeFriendRequest(reqId) {
  const { error } = await state.supabase.from('contacts').delete().eq('id', reqId);
  if (error) { console.error('Remove request error:', error); return { error: '操作失败，请重试' }; }
  await loadContacts();
  return { success: true };
}

// ---------- 会话操作 ----------
async function getOrCreateDirectConversation(contactId) {
  const existing = state.conversations.find(conv => {
    if (conv.type !== 'direct') return false;
    return conv.members.some(m => m.user_id === contactId);
  });
  if (existing) return existing.id;

  const { data: conv, error: e1 } = await state.supabase
    .from('conversations')
    .insert({ type: 'direct', created_by: state.myId })
    .select()
    .single();

  if (e1) { console.error('Create conv error:', e1); return null; }

  // 先插入自己（RLS 要求创建者先成为成员），再插入对方
  const { error: e2 } = await state.supabase
    .from('conversation_members')
    .insert({ conversation_id: conv.id, user_id: state.myId, role: 'owner' });

  if (e2) { console.error('Add member error:', e2); return null; }

  const { error: e3 } = await state.supabase
    .from('conversation_members')
    .insert({ conversation_id: conv.id, user_id: contactId, role: 'member' });

  if (e3) { console.error('Add other member error:', e3); return null; }

  await loadConversations();
  refreshSubscription();
  renderConversationList();
  return conv.id;
}

async function createGroupConversation(name, memberIds) {
  const { data: conv, error: e1 } = await state.supabase
    .from('conversations')
    .insert({ type: 'group', name, avatar_color: randomColor(), created_by: state.myId })
    .select()
    .single();

  if (e1) { console.error('Create group error:', e1); return null; }

  // 先插入自己（创建者必须先成为成员），再批量插入受邀好友
  const { error: e2 } = await state.supabase
    .from('conversation_members')
    .insert({ conversation_id: conv.id, user_id: state.myId, role: 'owner' });
  if (e2) { console.error('Add owner error:', e2); return null; }

  const members = memberIds.map(uid => ({
    conversation_id: conv.id,
    user_id: uid,
    role: 'member',
  }));

  const { error: e3 } = await state.supabase.from('conversation_members').insert(members);
  if (e3) { console.error('Add group members error:', e3); return null; }

  await state.supabase.from('messages').insert({
    conversation_id: conv.id, sender_id: state.myId,
    content: `${state.myName} 创建了群聊`, msg_type: 'system',
  });

  await loadConversations();
  refreshSubscription();
  renderConversationList();
  return conv.id;
}

async function addMemberToGroup(convId, userId) {
  // #4 fix: 检查是否已在群中
  const conv = state.conversations.find(c => c.id === convId);
  if (conv?.members.some(m => m.user_id === userId)) return true; // 已在群中，跳过

  const { error } = await state.supabase
    .from('conversation_members')
    .insert({ conversation_id: convId, user_id: userId });

  if (error) { console.error('Add member error:', error); return false; }

  const user = state.contacts.find(c => c.contact_id === userId);
  const name = user?.remark || user?.display_name || '新成员';
  await state.supabase.from('messages').insert({
    conversation_id: convId, sender_id: state.myId,
    content: `${state.myName} 邀请 ${name} 加入了群聊`, msg_type: 'system',
  });

  return true;
}

async function leaveGroup(convId) {
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return false;

  const myRole = conv.members.find(m => m.user_id === state.myId)?.role;

  // 群主退群：先转让给发言最多的成员
  if (myRole === 'owner') {
    const others = conv.members.filter(m => m.user_id !== state.myId);
    if (others.length > 0) {
      // 查发言最多的成员
      const { data: msgStats } = await state.supabase
        .from('messages')
        .select('sender_id')
        .eq('conversation_id', convId)
        .neq('sender_id', state.myId);

      const countMap = {};
      (msgStats || []).forEach(m => { countMap[m.sender_id] = (countMap[m.sender_id] || 0) + 1; });

      // 按消息数排序，取最多的人
      const sorted = others.sort((a, b) => (countMap[b.user_id] || 0) - (countMap[a.user_id] || 0));
      const newOwnerId = sorted[0].user_id;

      await state.supabase.from('conversation_members')
        .update({ role: 'owner' })
        .eq('conversation_id', convId)
        .eq('user_id', newOwnerId);

      await state.supabase.from('messages').insert({
        conversation_id: convId, sender_id: state.myId,
        content: `${state.myName} 已退出群聊，群主已转让给 ${sorted[0].display_name}`, msg_type: 'system',
      });
    } else {
      // 没有其他成员，解散群聊
      await dissolveGroup(convId);
      return true;
    }
  } else {
    await state.supabase.from('messages').insert({
      conversation_id: convId, sender_id: state.myId,
      content: `${state.myName} 已退出群聊`, msg_type: 'system',
    });
  }

  const { error } = await state.supabase
    .from('conversation_members')
    .delete()
    .eq('conversation_id', convId)
    .eq('user_id', state.myId);

  if (error) { console.error('Leave group error:', error); return false; }

  delete state.messages[convId];
  state.currentConvId = null;
  await loadConversations();
  refreshSubscription();
  renderConversationList();
  renderChatEmpty();
  return true;
}

async function dissolveGroup(convId) {
  // 按顺序删除：消息 → 其他成员行 → 会话
  // 保留自己的成员行直到最后一步，确保全程满足 RLS 权限校验
  await state.supabase.from('messages').delete().eq('conversation_id', convId);
  await state.supabase.from('conversation_members').delete()
    .eq('conversation_id', convId).neq('user_id', state.myId);
  await state.supabase.from('conversations').delete().eq('id', convId);

  delete state.messages[convId];
  state.currentConvId = null;
  await loadConversations();
  refreshSubscription();
  renderConversationList();
  renderChatEmpty();
  toast('群聊已解散');
  return true;
}

async function kickMember(convId, userId) {
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return false;

  const target = conv.members.find(m => m.user_id === userId);
  if (!target) return false;

  const myRole = conv.members.find(m => m.user_id === state.myId)?.role;

  // 权限检查
  if (target.role === 'owner') { toast('不能踢出群主', 'error'); return false; }
  if (myRole === 'admin' && target.role === 'admin') { toast('管理员不能踢出其他管理员', 'error'); return false; }

  await state.supabase.from('conversation_members')
    .delete()
    .eq('conversation_id', convId)
    .eq('user_id', userId);

  await state.supabase.from('messages').insert({
    conversation_id: convId, sender_id: state.myId,
    content: `${target.display_name} 已被移出群聊`, msg_type: 'system',
  });

  // 刷新
  await loadConversations();
  refreshSubscription();
  if (state.currentConvId === convId) await openConversation(convId);
  toast(`已将 ${target.display_name} 移出群聊`);
  return true;
}

async function toggleAdmin(convId, userId, promote) {
  const newRole = promote ? 'admin' : 'member';
  await state.supabase.from('conversation_members')
    .update({ role: newRole })
    .eq('conversation_id', convId)
    .eq('user_id', userId);

  const conv = state.conversations.find(c => c.id === convId);
  const target = conv?.members.find(m => m.user_id === userId);
  const name = target?.display_name || '成员';

  await state.supabase.from('messages').insert({
    conversation_id: convId, sender_id: state.myId,
    content: promote ? `${name} 已被设为管理员` : `${name} 已被取消管理员`, msg_type: 'system',
  });

  await loadConversations();
  refreshSubscription();
  if (state.currentConvId === convId) await openConversation(convId);
  toast(promote ? `${name} 已设为管理员` : `${name} 已取消管理员`);
  return true;
}

async function clearChatHistory() {
  const convId = state.currentConvId;
  if (!convId) return;

  const { error } = await state.supabase
    .from('messages')
    .delete()
    .eq('conversation_id', convId);

  if (error) { console.error('Clear chat error:', error); toast('清空失败', 'error'); return; }

  state.messages[convId] = [];
  renderMessages(convId);
  toast('聊天记录已清空');
}

async function deleteFriend() {
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  if (!conv) return;

  const other = conv.members.find(m => m.user_id !== state.myId);
  if (!other) return;

  // 1. 删除好友关系（双向，参数化查询替代字符串拼接）
  await state.supabase.from('contacts').delete()
    .eq('user_id', state.myId).eq('contact_id', other.user_id);
  await state.supabase.from('contacts').delete()
    .eq('user_id', other.user_id).eq('contact_id', state.myId);

  // 2. 按顺序删除：消息 → 对方成员行 → 会话（自己最后随级联清理）
  // 必须保持自己是成员直到会话删除，否则 RLS 会拒绝删除会话
  await state.supabase.from('messages').delete().eq('conversation_id', conv.id);
  await state.supabase.from('conversation_members').delete()
    .eq('conversation_id', conv.id).neq('user_id', state.myId);
  await state.supabase.from('conversations').delete().eq('id', conv.id);

  // 3. 更新本地状态
  delete state.messages[conv.id];
  state.currentConvId = null;
  await loadContacts();
  await loadConversations();
  refreshSubscription();
  renderConversationList();
  renderChatEmpty();
  toast('已删除好友');
}

async function blockUser() {
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  if (!conv) return;

  const other = conv.members.find(m => m.user_id !== state.myId);
  if (!other) return;

  // 1. 先删除好友关系（双向，参数化查询）
  await state.supabase.from('contacts').delete()
    .eq('user_id', state.myId).eq('contact_id', other.user_id);
  await state.supabase.from('contacts').delete()
    .eq('user_id', other.user_id).eq('contact_id', state.myId);

  // 2. 按顺序删除：消息 → 对方成员行 → 会话（保持自己是成员直到会话删除）
  await state.supabase.from('messages').delete().eq('conversation_id', conv.id);
  await state.supabase.from('conversation_members').delete()
    .eq('conversation_id', conv.id).neq('user_id', state.myId);
  await state.supabase.from('conversations').delete().eq('id', conv.id);

  // 3. 记录拉黑（存 localStorage，因为没有 blocks 表）
  const blocked = JSON.parse(localStorage.getItem('webchat_blocked') || '[]');
  if (!blocked.includes(other.user_id)) blocked.push(other.user_id);
  localStorage.setItem('webchat_blocked', JSON.stringify(blocked));

  // 4. 更新本地状态
  delete state.messages[conv.id];
  state.currentConvId = null;
  await loadContacts();
  await loadConversations();
  refreshSubscription();
  renderConversationList();
  renderChatEmpty();
  toast('已拉黑用户');
}

// ---------- 发送消息 ----------
async function sendMessage(content) {
  if (!content.trim() || !state.currentConvId) return;

  const trimmed = content.trim();
  const convId = state.currentConvId;

  const { data, error } = await state.supabase
    .from('messages')
    .insert({ conversation_id: convId, sender_id: state.myId, content: trimmed, msg_type: 'text' })
    .select()
    .single();

  // #3 fix: 发送失败时不清空输入框
  if (error) {
    console.error('Send error:', error);
    toast('发送失败', 'error');
    return false;
  }

  if (!state.messages[convId]) state.messages[convId] = [];
  state.messages[convId].push(data);
  renderMessages(convId);
  scrollMessagesToBottom();

  // 广播给同频道的其他用户
  broadcastMessage(data);

  await loadConversations();
  renderConversationList();
  return true;
}

// ---------- 实时消息（轮询方案）----------
let _pollTimer = null;
let _lastPollTime = null;

function subscribeRealtime() {
  // 先清理旧的 Broadcast 频道
  if (state.channels) {
    Object.values(state.channels).forEach(ch => state.supabase.removeChannel(ch));
  }
  state.channels = {};

  // 启动轮询
  _lastPollTime = new Date().toISOString();
  clearInterval(_pollTimer);
  _pollTimer = setInterval(pollMessages, 3000);
}

function refreshSubscription() {
  // 更新轮询时间基准（会话变化后重新开始）
  _lastPollTime = new Date().toISOString();
}

async function pollMessages() {
  if (!state.supabase || state.conversations.length === 0) return;

  const convIds = state.conversations.map(c => c.id);

  const { data, error } = await state.supabase
    .from('messages')
    .select('id, conversation_id, sender_id, content, msg_type, created_at')
    .in('conversation_id', convIds)
    .gt('created_at', _lastPollTime)
    .neq('sender_id', state.myId)
    .order('created_at', { ascending: true });

  if (error || !data || data.length === 0) return;

  // 更新时间基准
  _lastPollTime = data[data.length - 1].created_at;

  // 按会话分组处理
  const byConv = {};
  data.forEach(msg => {
    if (!byConv[msg.conversation_id]) byConv[msg.conversation_id] = [];
    byConv[msg.conversation_id].push(msg);
  });

  Object.entries(byConv).forEach(([convId, msgs]) => {
    if (!state.messages[convId]) state.messages[convId] = [];
    state.messages[convId].push(...msgs);

    const conv = state.conversations.find(c => c.id === convId);

    if (state.currentConvId === convId) {
      renderMessages(convId);
      scrollMessagesToBottom();
    } else {
      // 累加未读消息数
      if (!state.unreadCounts[convId]) state.unreadCounts[convId] = 0;
      state.unreadCounts[convId] += msgs.length;
      const lastMsg = msgs[msgs.length - 1];
      toast(`新消息: ${lastMsg.content.slice(0, 30)}`);
      const sender = conv?.members.find(m => m.user_id === lastMsg.sender_id);
      notify.send(sender?.display_name || '新消息', lastMsg.content, convId);
    }
  });

  loadConversations();
}

// 已废弃，保留空函数避免报错
function broadcastMessage() {}

// ---------- UI 渲染 ----------
function renderMyInfo() {
  $('myAvatar').textContent = getInitial(state.myName);
  $('myAvatar').style.background = state.myColor;
  $('myName').textContent = state.myName;
  $('myId').textContent = state.myId;
  $('myId').title = '点击复制: ' + state.myId;
  // 显示版本号
  if (typeof APP_VERSION !== 'undefined') {
    $('appVersion').textContent = 'WebChat ' + APP_VERSION;
  }
}

function renderConversationList() {
  const list = $('conversationList');
  const filter = $('searchInput').value.toLowerCase();

  const filtered = state.conversations.filter(c => c.name.toLowerCase().includes(filter));

  if (filtered.length === 0) {
    list.innerHTML = '';
    list.appendChild($('emptyConvList') || createEmptyConvList());
    return;
  }

  list.innerHTML = filtered.map(conv => {
    const isActive = conv.id === state.currentConvId;
    const lastMsgText = conv.lastMsg?.content || '';
    const lastMsgTime = formatTime(conv.lastMsg?.time);
    const isGroup = conv.type === 'group';

    let avatarHtml;
    if (isGroup && conv.members.length >= 2) {
      avatarHtml = `<div class="conv-avatar-wrap"><div class="conv-avatar group-avatar" style="background:${conv.avatar_color}">
        ${conv.members.slice(0, 4).map(m =>
          `<span style="background:${m.avatar_color}">${getInitial(m.display_name)}</span>`
        ).join('')}
      </div>${unreadBadgeHtml(conv.id)}</div>`;
    } else {
      avatarHtml = `<div class="conv-avatar-wrap"><div class="conv-avatar" style="background:${conv.avatar_color}">${getInitial(conv.name)}</div>${unreadBadgeHtml(conv.id)}</div>`;
    }

    return `<div class="conv-item ${isActive ? 'active' : ''}" data-conv-id="${conv.id}">
      ${avatarHtml}
      <div class="conv-body">
        <div class="conv-top">
          <span class="conv-name">${escapeHtml(conv.name)}</span>
          <span class="conv-time">${lastMsgTime}</span>
        </div>
        <div class="conv-last-msg">${escapeHtml(lastMsgText)}</div>
      </div>
    </div>`;
  }).join('');

  // 事件委托替代逐个绑定 (#9 fix 的一部分)
  list.onclick = (e) => {
    const item = e.target.closest('.conv-item');
    if (item) openConversation(item.dataset.convId);
  };
}

function createEmptyConvList() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.id = 'emptyConvList';
  div.innerHTML = `
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--muted-foreground)" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
    <p>还没有会话</p>
    <p class="hint">点击右上角 + 添加好友</p>`;
  return div;
}

function renderChatEmpty() {
  $('chatEmpty').style.display = 'flex';
  $('chatHeader').style.display = 'none';
  $('messageList').style.display = 'none';
  $('chatInputArea').style.display = 'none';
}

async function openConversation(convId) {
  state.currentConvId = convId;
  // 清零未读计数
  state.unreadCounts[convId] = 0;
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return;

  $('sidebar').classList.add('hidden');
  $('chatEmpty').style.display = 'none';
  $('chatHeader').style.display = 'flex';
  $('messageList').style.display = 'flex';
  $('chatInputArea').style.display = 'flex';

  $('chatHeaderAvatar').textContent = getInitial(conv.name);
  $('chatHeaderAvatar').style.background = conv.avatar_color;
  $('chatHeaderName').textContent = conv.name;

  // #6 fix: 每次打开都重新加载消息
  await loadMessages(convId);
  renderMessages(convId);
  scrollMessagesToBottom();
  renderConversationList();
  $('messageInput').focus();
}

function renderMessages(convId) {
  if (state.currentConvId !== convId) return;

  const msgs = state.messages[convId] || [];
  const conv = state.conversations.find(c => c.id === convId);
  const list = $('messageList');

  // #9 fix: 只追加新消息，不全量重渲染
  const existingCount = list.children.length;
  if (existingCount > 0 && existingCount <= msgs.length) {
    // 检查是否只是多了新消息
    let isAppendOnly = true;
    for (let i = 0; i < existingCount; i++) {
      const existingId = list.children[i]?.dataset?.msgId;
      const newId = msgs[i]?.id;
      if (existingId && existingId !== newId) { isAppendOnly = false; break; }
    }

    if (isAppendOnly && msgs.length > existingCount) {
      // 只追加新消息
      for (let i = existingCount; i < msgs.length; i++) {
        list.insertAdjacentHTML('beforeend', renderSingleMessage(msgs[i], conv));
      }
      return;
    }
  }

  // 首次或不一致时全量渲染
  list.innerHTML = msgs.map(msg => renderSingleMessage(msg, conv)).join('');
}

function renderSingleMessage(msg, conv) {
  if (msg.msg_type === 'system') {
    return `<div class="msg-system" data-msg-id="${msg.id}">${escapeHtml(msg.content)}</div>`;
  }

  const isSelf = msg.sender_id === state.myId;
  const member = conv?.members.find(m => m.user_id === msg.sender_id);
  const senderName = isSelf ? '' : (member?.display_name || '未知');
  const senderColor = isSelf ? state.myColor : (member?.avatar_color || '#999');

  return `<div class="msg-group ${isSelf ? 'self' : ''}" data-msg-id="${msg.id}">
    <div class="msg-avatar" style="background:${senderColor}">
      ${isSelf ? getInitial(state.myName) : getInitial(senderName)}
    </div>
    <div class="msg-content">
      ${!isSelf ? `<div class="msg-sender">${escapeHtml(senderName)}</div>` : ''}
      <div class="msg-bubble">${escapeHtml(msg.content)}</div>
      <div class="msg-time">${formatTime(msg.created_at)}</div>
    </div>
  </div>`;
}

function scrollMessagesToBottom() {
  const list = $('messageList');
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

// ---------- 模态框 ----------
function openModal(id) { $(id).style.display = 'flex'; }
function closeModal(id) { $(id).style.display = 'none'; }

// ---------- 右键菜单 ----------
let _ctxMsgId = null;
let _ctxConvId = null;

function showContextMenu(x, y, msgId, convId, isSelf) {
  _ctxMsgId = msgId;
  _ctxConvId = convId;

  const menu = $('contextMenu');
  // 只有自己发的消息才能撤回
  $('ctxRecall').style.display = isSelf ? 'flex' : 'none';

  // 定位，防止超出屏幕
  menu.style.display = 'block';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const finalX = Math.min(x, window.innerWidth - mw - 8);
  const finalY = Math.min(y, window.innerHeight - mh - 8);
  menu.style.left = finalX + 'px';
  menu.style.top = finalY + 'px';
}

function hideContextMenu() {
  $('contextMenu').style.display = 'none';
  _ctxMsgId = null;
  _ctxConvId = null;
}

async function recallMessage() {
  if (!_ctxMsgId || !_ctxConvId) return;

  const { error } = await state.supabase
    .from('messages')
    .delete()
    .eq('id', _ctxMsgId)
    .eq('sender_id', state.myId); // 只能撤回自己的

  if (error) { console.error('Recall error:', error); toast('撤回失败', 'error'); hideContextMenu(); return; }

  // 从本地缓存移除
  const msgs = state.messages[_ctxConvId];
  if (msgs) {
    const idx = msgs.findIndex(m => m.id === _ctxMsgId);
    if (idx !== -1) msgs.splice(idx, 1);
  }

  // 插入系统消息
  const { data: sysMsg } = await state.supabase
    .from('messages')
    .insert({ conversation_id: _ctxConvId, sender_id: state.myId, content: '你撤回了一条消息', msg_type: 'system' })
    .select()
    .single();

  if (sysMsg) {
    if (!state.messages[_ctxConvId]) state.messages[_ctxConvId] = [];
    state.messages[_ctxConvId].push(sysMsg);
  }

  renderMessages(_ctxConvId);
  hideContextMenu();
  toast('已撤回');
}

function renderGroupMemberSelect() {
  const container = $('groupMemberSelect');
  if (state.contacts.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无好友，请先添加好友</div>';
    return;
  }
  container.innerHTML = state.contacts.map(c => `
    <label class="group-member-option">
      <input type="checkbox" value="${c.contact_id}">
      <div class="member-avatar" style="background:${c.avatar_color}">${getInitial(c.display_name)}</div>
      <span class="member-name">${escapeHtml(c.remark || c.display_name)}</span>
    </label>
  `).join('');
}

function renderInviteMemberSelect() {
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  if (!conv) return;
  const existingIds = conv.members.map(m => m.user_id);
  const available = state.contacts.filter(c => !existingIds.includes(c.contact_id));

  const container = $('inviteMemberSelect');
  if (available.length === 0) {
    container.innerHTML = '<div class="empty-hint">所有好友都已在群中</div>';
    return;
  }
  container.innerHTML = available.map(c => `
    <label class="group-member-option">
      <input type="checkbox" value="${c.contact_id}">
      <div class="member-avatar" style="background:${c.avatar_color}">${getInitial(c.display_name)}</div>
      <span class="member-name">${escapeHtml(c.remark || c.display_name)}</span>
    </label>
  `).join('');
}

function renderChatInfo() {
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  if (!conv) return;

  const isGroup = conv.type === 'group';
  $('chatInfoTitle').textContent = isGroup ? '群聊信息' : '好友信息';

  const myRole = conv.members.find(m => m.user_id === state.myId)?.role;
  const isOwner = myRole === 'owner';
  const isAdmin = myRole === 'admin';

  // 成员列表（带角色标签）
  $('chatInfoMembers').innerHTML = conv.members.map(m => {
    let roleTag = '';
    if (m.role === 'owner') roleTag = '<span class="role-tag owner">群主</span>';
    else if (m.role === 'admin') roleTag = '<span class="role-tag admin">管理员</span>';

    // 管理按钮（根据权限显示）
    let actions = '';
    if (m.user_id !== state.myId) {
      if (isOwner) {
        // 群主可以：踢任何人、设/撤管理员
        actions = `<div class="member-actions">`;
        if (m.role === 'member') actions += `<button class="link-btn" data-action="promote" data-uid="${m.user_id}">设为管理</button>`;
        if (m.role === 'admin') actions += `<button class="link-btn" data-action="demote" data-uid="${m.user_id}">取消管理</button>`;
        actions += `<button class="link-btn danger" data-action="kick" data-uid="${m.user_id}">移出</button></div>`;
      } else if (isAdmin && m.role === 'member') {
        // 管理员只能踢普通成员
        actions = `<div class="member-actions"><button class="link-btn danger" data-action="kick" data-uid="${m.user_id}">移出</button></div>`;
      }
    }

    return `<div class="chat-info-member" style="width:auto">
      <div class="member-avatar" style="background:${m.avatar_color}">${getInitial(m.display_name)}</div>
      <div class="member-name">${escapeHtml(m.display_name)}${roleTag}</div>
      ${actions}
    </div>`;
  }).join('');

  // 底部操作按钮
  let actionsHtml = '';
  if (isGroup) {
    actionsHtml = `<button class="btn btn-secondary" id="btnAddGroupMember">+ 邀请好友入群</button>`;
    if (isOwner) {
      actionsHtml += `<button class="btn btn-danger" id="btnDissolveGroup">解散群聊</button>`;
    } else {
      actionsHtml += `<button class="btn btn-danger" id="btnLeaveGroup">退出群聊</button>`;
    }
  }
  $('chatInfoActions').innerHTML = actionsHtml;

  // 事件委托
  $('chatInfoActions').onclick = async (e) => {
    if (e.target.id === 'btnAddGroupMember') {
      closeModal('modalChatInfo');
      renderInviteMemberSelect();
      openModal('modalInviteMember');
    }
    if (e.target.id === 'btnLeaveGroup') {
      if (confirm('确定退出群聊？')) {
        const ok = await leaveGroup(state.currentConvId);
        closeModal('modalChatInfo');
        toast(ok ? '已退出群聊' : '退出失败', ok ? '' : 'error');
      }
    }
    if (e.target.id === 'btnDissolveGroup') {
      if (confirm('确定解散群聊？所有消息将被删除，不可恢复。')) {
        await dissolveGroup(state.currentConvId);
        closeModal('modalChatInfo');
      }
    }
  };

  // 成员操作事件委托
  $('chatInfoMembers').onclick = async (e) => {
    const action = e.target.dataset.action;
    const uid = e.target.dataset.uid;
    if (!action || !uid) return;

    if (action === 'kick') {
      const target = conv.members.find(m => m.user_id === uid);
      if (confirm(`确定将 ${target?.display_name || '该成员'} 移出群聊？`)) {
        await kickMember(state.currentConvId, uid);
        closeModal('modalChatInfo');
      }
    }
    if (action === 'promote') {
      await toggleAdmin(state.currentConvId, uid, true);
      renderChatInfo();
    }
    if (action === 'demote') {
      await toggleAdmin(state.currentConvId, uid, false);
      renderChatInfo();
    }
  };
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 复制身份码
  $('myId').addEventListener('click', () => {
    navigator.clipboard.writeText(state.myId).then(() => toast('身份码已复制', 'success'));
  });

  // 设置
  $('btnSettings').addEventListener('click', () => {
    $('inputMyName').value = state.myName;
    $('settingsId').textContent = state.myId;

    // 同步头像颜色选中态
    document.querySelectorAll('#avatarColorPicker .color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === state.myColor);
    });

    // 同步主题切换
    const currentTheme = localStorage.getItem('webchat_theme') || 'light';
    document.querySelectorAll('.theme-toggle[data-theme]').forEach(t => {
      t.classList.toggle('active', t.dataset.theme === currentTheme);
    });

    // 同步通知开关
    const currentNotify = localStorage.getItem('webchat_notify') || 'on';
    document.querySelectorAll('.theme-toggle[data-notify]').forEach(t => {
      t.classList.toggle('active', t.dataset.notify === currentNotify);
    });

    // 同步通知预览开关
    const currentPreview = localStorage.getItem('webchat_notify_preview') || 'off';
    document.querySelectorAll('.theme-toggle[data-preview]').forEach(t => {
      t.classList.toggle('active', t.dataset.preview === currentPreview);
    });

    // 重置到第一个分类
    document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.settings-nav-item[data-section="profile"]').classList.add('active');
    document.querySelectorAll('.settings-section').forEach(s => s.style.display = 'none');
    $('sectionProfile').style.display = 'block';

    // 设置关于页版本号
    if (typeof APP_VERSION !== 'undefined') {
      $('aboutVersion').textContent = APP_VERSION;
    }

    // 渲染更新日志
    if (typeof CHANGELOG !== 'undefined') {
      $('changelogList').innerHTML = CHANGELOG.map(entry => `
        <div class="changelog-entry">
          <div class="changelog-version">
            <span class="changelog-version-tag">${entry.version}</span>
            <span class="changelog-version-date">${entry.date}</span>
          </div>
          <ul class="changelog-changes">
            ${entry.changes.map(c => `<li>${c}</li>`).join('')}
          </ul>
        </div>
      `).join('');
    }

    openModal('modalSettings');
  });

  // 设置分类导航 — 事件委托
  document.addEventListener('click', (e) => {
    const navItem = e.target.closest('.settings-nav-item');
    if (!navItem || !navItem.closest('#modalSettings')) return;

    document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
    navItem.classList.add('active');
    const section = navItem.dataset.section;
    document.querySelectorAll('.settings-section').forEach(s => s.style.display = 'none');

    const sectionMap = { profile: 'sectionProfile', appearance: 'sectionAppearance', about: 'sectionAbout', changelog: 'sectionChangelog' };
    const target = $(sectionMap[section]);
    if (target) target.style.display = 'block';
  });

  // 头像颜色选择 — 事件委托
  $('avatarColorPicker').addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (!swatch) return;
    document.querySelectorAll('#avatarColorPicker .color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
  });

  // 主题切换 — 点击即生效
  document.querySelectorAll('.theme-toggle[data-theme]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      document.querySelectorAll('.theme-toggle[data-theme]').forEach(t => t.classList.remove('active'));
      toggle.classList.add('active');
      const theme = toggle.dataset.theme;
      localStorage.setItem('webchat_theme', theme);
      document.documentElement.setAttribute('data-theme', theme);
      toast(theme === 'dark' ? '已切换深色模式' : '已切换浅色模式', 'success');
    });
  });

  // 通知开关
  document.querySelectorAll('.theme-toggle[data-notify]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      document.querySelectorAll('.theme-toggle[data-notify]').forEach(t => t.classList.remove('active'));
      toggle.classList.add('active');
      const val = toggle.dataset.notify;
      localStorage.setItem('webchat_notify', val);
      if (val === 'on') {
        notify.requestPermission().then(ok => {
          toast(ok ? '通知已开启' : '浏览器拒绝了通知权限', ok ? 'success' : 'error');
        });
      } else {
        toast('通知已关闭');
      }
    });
  });

  // 通知预览开关（默认关闭：通知不显示消息正文）
  document.querySelectorAll('.theme-toggle[data-preview]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      document.querySelectorAll('.theme-toggle[data-preview]').forEach(t => t.classList.remove('active'));
      toggle.classList.add('active');
      const on = toggle.dataset.preview === 'on';
      localStorage.setItem('webchat_notify_preview', toggle.dataset.preview);
      toast(on ? '通知将显示消息内容' : '通知不再显示消息内容', 'success');
    });
  });

  // 保存个人信息
  $('btnSaveProfile').addEventListener('click', async () => {
    const newName = $('inputMyName').value.trim();
    if (!newName) { toast('昵称不能为空', 'error'); return; }

    state.myName = newName;
    localStorage.setItem('webchat_name', newName);

    const newColor = document.querySelector('#avatarColorPicker .color-swatch.active')?.dataset.color;
    if (newColor && newColor !== state.myColor) {
      state.myColor = newColor;
      localStorage.setItem('webchat_color', newColor);
    }

    await state.supabase.from('users').update({ display_name: newName, avatar_color: state.myColor }).eq('id', state.myId);

    renderMyInfo();
    await loadConversations();
    renderConversationList();
    closeModal('modalSettings');
    toast('设置已保存', 'success');
  });

  $('btnCopyId').addEventListener('click', () => {
    navigator.clipboard.writeText(state.myId).then(() => toast('身份码已复制', 'success'));
  });

  // 右键菜单 — 消息右键
  $('messageList').addEventListener('contextmenu', (e) => {
    const msgGroup = e.target.closest('.msg-group');
    if (!msgGroup) return;
    e.preventDefault();

    const msgId = msgGroup.dataset.msgId;
    const convId = state.currentConvId;
    const isSelf = msgGroup.classList.contains('self');
    showContextMenu(e.clientX, e.clientY, msgId, convId, isSelf);
  });

  // 撤回按钮
  $('ctxRecall').addEventListener('click', () => recallMessage());

  // 点击其他地方关闭菜单
  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.msg-group')) hideContextMenu();
  });

  // 新建菜单
  $('btnAddMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('addMenu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => { $('addMenu').style.display = 'none'; });

  $('menuAddContact').addEventListener('click', () => {
    $('inputContactId').value = '';
    $('addContactFeedback').textContent = '';
    openModal('modalAddContact');
  });

  $('menuCreateGroup').addEventListener('click', () => {
    renderGroupMemberSelect();
    $('inputGroupName').value = '';
    $('createGroupFeedback').textContent = '';
    openModal('modalCreateGroup');
  });

  // 添加好友
  $('btnConfirmAdd').addEventListener('click', async () => {
    const id = $('inputContactId').value.trim();
    if (!id) { $('addContactFeedback').textContent = '请输入身份码'; $('addContactFeedback').className = 'modal-feedback error'; return; }

    $('btnConfirmAdd').disabled = true;
    $('btnConfirmAdd').textContent = '添加中...';

    const result = await addContact(id);
    $('btnConfirmAdd').disabled = false;
    $('btnConfirmAdd').textContent = '添加';

    if (result.error) {
      $('addContactFeedback').textContent = result.error;
      $('addContactFeedback').className = 'modal-feedback error';
    } else {
      $('addContactFeedback').textContent = result.message;
      $('addContactFeedback').className = 'modal-feedback success';
      setTimeout(() => closeModal('modalAddContact'), 1000);
    }
  });

  // 创建群聊
  $('btnConfirmCreateGroup').addEventListener('click', async () => {
    const name = $('inputGroupName').value.trim();
    if (!name) { $('createGroupFeedback').textContent = '请输入群名称'; $('createGroupFeedback').className = 'modal-feedback error'; return; }

    const selected = Array.from($('groupMemberSelect').querySelectorAll('input:checked')).map(el => el.value);
    if (selected.length === 0) { $('createGroupFeedback').textContent = '请至少选择一个好友'; $('createGroupFeedback').className = 'modal-feedback error'; return; }

    $('btnConfirmCreateGroup').disabled = true;
    const convId = await createGroupConversation(name, selected);
    $('btnConfirmCreateGroup').disabled = false;

    if (convId) {
      closeModal('modalCreateGroup');
      openConversation(convId);
      toast('群聊创建成功', 'success');
    } else {
      $('createGroupFeedback').textContent = '创建失败，请重试';
      $('createGroupFeedback').className = 'modal-feedback error';
    }
  });

  // 邀请入群
  $('btnConfirmInvite').addEventListener('click', async () => {
    const selected = Array.from($('inviteMemberSelect').querySelectorAll('input:checked')).map(el => el.value);
    if (selected.length === 0) {
      $('inviteMemberFeedback').textContent = '请选择要邀请的好友';
      $('inviteMemberFeedback').className = 'modal-feedback error';
      return;
    }

    $('btnConfirmInvite').disabled = true;
    let ok = true;
    for (const uid of selected) {
      if (!(await addMemberToGroup(state.currentConvId, uid))) ok = false;
    }
    $('btnConfirmInvite').disabled = false;

    if (ok) {
      closeModal('modalInviteMember');
      await loadConversations();
      refreshSubscription();
      await openConversation(state.currentConvId);
      toast('邀请成功', 'success');
    } else {
      $('inviteMemberFeedback').textContent = '部分邀请失败，请重试';
      $('inviteMemberFeedback').className = 'modal-feedback error';
    }
  });

  // 搜索
  $('searchInput').addEventListener('input', () => renderConversationList());

  // 发送消息
  // 发送消息 — 先清空输入框防止刷屏
  let _sending = false;

  async function handleSend() {
    const input = $('messageInput');
    const text = input.value.trim();
    if (!text || _sending) return;

    // 立即清空输入框
    input.value = '';
    input.style.height = 'auto';
    _sending = true;

    const ok = await sendMessage(text);
    _sending = false;

    // 发送失败时恢复内容
    if (ok === false) {
      input.value = text;
      input.style.height = 'auto';
    }
  }

  $('btnSend').addEventListener('click', handleSend);

  $('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  $('messageInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // 返回 (mobile)
  $('btnBack').addEventListener('click', () => {
    $('sidebar').classList.remove('hidden');
    state.currentConvId = null;
    renderChatEmpty();
    renderConversationList();
  });

  // 聊天菜单
  $('btnChatMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('chatMenu');
    // 根据会话类型显示/隐藏选项
    const conv = state.conversations.find(c => c.id === state.currentConvId);
    const isGroup = conv?.type === 'group';
    $('menuDeleteFriend').style.display = isGroup ? 'none' : 'flex';
    $('menuBlockUser').style.display = isGroup ? 'none' : 'flex';
    $('menuChatInfo').style.display = isGroup ? 'flex' : 'none';
    $('menuInviteMember').style.display = isGroup ? 'flex' : 'none';
    $('menuLeaveGroup').style.display = isGroup ? 'flex' : 'none';
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  // 清空聊天记录
  $('menuClearChat').addEventListener('click', async () => {
    $('chatMenu').style.display = 'none';
    if (!confirm('确定清空所有聊天记录？此操作不可撤销。')) return;
    await clearChatHistory();
  });

  // 会话信息
  $('menuChatInfo').addEventListener('click', () => {
    $('chatMenu').style.display = 'none';
    renderChatInfo();
    openModal('modalChatInfo');
  });

  // 邀请入群
  $('menuInviteMember').addEventListener('click', () => {
    $('chatMenu').style.display = 'none';
    renderInviteMemberSelect();
    openModal('modalInviteMember');
  });

  // 删除好友
  $('menuDeleteFriend').addEventListener('click', async () => {
    $('chatMenu').style.display = 'none';
    if (!confirm('确定删除该好友？聊天记录将被清除。')) return;
    await deleteFriend();
  });

  // 拉黑用户
  $('menuBlockUser').addEventListener('click', async () => {
    $('chatMenu').style.display = 'none';
    if (!confirm('确定拉黑该用户？将自动删除好友并清除聊天记录。')) return;
    await blockUser();
  });

  // 退出群聊
  $('menuLeaveGroup').addEventListener('click', async () => {
    $('chatMenu').style.display = 'none';
    if (!confirm('确定退出群聊？')) return;
    const ok = await leaveGroup(state.currentConvId);
    toast(ok ? '已退出群聊' : '退出失败', ok ? '' : 'error');
  });

  // 模态框关闭 — 事件委托
  document.addEventListener('click', (e) => {
    // 关闭按钮 / data-modal 元素
    const closer = e.target.closest('.modal-close, [data-modal]');
    if (closer) {
      const modalId = closer.dataset.modal || closer.closest('.modal-overlay')?.id;
      if (modalId) closeModal(modalId);
      return;
    }
    // 点击 overlay 背景关闭
    if (e.target.classList.contains('modal-overlay')) {
      e.target.style.display = 'none';
    }
  });
}

// ---------- 初始化 ----------
async function init() {
  if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
    toast('请先配置 config.js！参考 config.example.js', 'error');
    $('conversationList').innerHTML = '<div class="empty-state"><p style="color:#fa5151">⚠️ 请先配置 config.js</p></div>';
    $('loadingScreen').classList.add('hidden');
    return;
  }

  state.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  await initIdentity();
  renderMyInfo();

  try {
    await ensureAuth();
    await ensureIdentity();
    startHeartbeat();
  } catch (e) {
    console.error(e);
    $('conversationList').innerHTML = `<div class="empty-state">
      <p style="color:#fa5151">⚠️ ${escapeHtml(e.message) || '连接失败'}</p>
      <p class="hint">请检查 config.js 与控制台登录配置</p>
    </div>`;
    $('loadingScreen').classList.add('hidden');
    return;
  }

  await loadContacts();
  await loadConversations();
  renderConversationList();
  subscribeRealtime();
  bindEvents();

  // 隐藏加载动画
  $('loadingScreen').classList.add('hidden');
  setTimeout(() => $('loadingScreen').remove(), 500);

  toast('连接成功');

  // 请求通知权限
  notify.requestPermission();
}

init();
