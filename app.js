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
  conversations: [],
  currentConvId: null,
  messages: {},           // convId -> [msg]
  subscription: null,
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

// ---------- 身份码系统 ----------
async function initIdentity() {
  let id = localStorage.getItem('webchat_id');
  let name = localStorage.getItem('webchat_name');
  let color = localStorage.getItem('webchat_color');

  // 如果旧 ID 是 UUID 格式（含 -），清除让它重新生成
  if (id && id.includes('-')) { id = null; localStorage.removeItem('webchat_id'); }

  if (!name) { name = '用户'; localStorage.setItem('webchat_name', name); }
  if (!color) { color = randomColor(); localStorage.setItem('webchat_color', color); }

  state.myName = name;
  state.myColor = color;

  // 生成唯一 5 位身份码
  if (!id) {
    id = await generateUniqueId();
    localStorage.setItem('webchat_id', id);
  }
  state.myId = id;

  applyTheme();
}

async function generateUniqueId() {
  for (let i = 0; i < 20; i++) {
    const candidate = genShortId();
    const { data } = await state.supabase
      .from('users')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  // 极端情况：20 次都撞，用 6 位
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---------- 主题系统 ----------
function applyTheme() {
  const theme = localStorage.getItem('webchat_theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
}

// ---------- Supabase 初始化 ----------
async function initSupabase() {
  // 注册/更新用户
  const { error } = await state.supabase
    .from('users')
    .upsert({
      id: state.myId,
      display_name: state.myName,
      avatar_color: state.myColor,
      last_seen: new Date().toISOString(),
    }, { onConflict: 'id' });

  if (error) {
    console.error('User upsert error:', error);
    toast('连接服务器失败', 'error');
  }

  // 心跳
  setInterval(async () => {
    await state.supabase
      .from('users')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', state.myId);
  }, 60000);
}

// ---------- 加载数据 ----------
async function loadContacts() {
  const { data, error } = await state.supabase
    .from('contacts')
    .select('contact_id, remark, users!contacts_contact_id_fkey(display_name, avatar_color)')
    .eq('user_id', state.myId);

  if (error) { console.error('Load contacts error:', error); return; }

  state.contacts = (data || []).map(c => ({
    contact_id: c.contact_id,
    remark: c.remark,
    display_name: c.users?.display_name || '未知用户',
    avatar_color: c.users?.avatar_color || '#999',
  }));
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
      .select('conversation_id, user_id, users(display_name, avatar_color)')
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
        display_name: m.users?.display_name || '未知',
        avatar_color: m.users?.avatar_color || '#999',
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
      avatar_color: avatarColor || '#999',
      members,
      lastMsg: lastMsg ? { content: lastMsg.content, sender_id: lastMsg.sender_id, time: lastMsg.created_at } : null,
    };
  });

  state.conversations.sort((a, b) => {
    const ta = a.lastMsg?.time || '0';
    const tb = b.lastMsg?.time || '0';
    return tb.localeCompare(ta);
  });
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

  const { data: user, error: e1 } = await state.supabase
    .from('users')
    .select('id, display_name')
    .eq('id', contactId)
    .single();

  if (e1 || !user) return { error: '用户不存在，请检查身份码' };

  const exists = state.contacts.find(c => c.contact_id === contactId);
  if (exists) return { error: '该用户已经是好友了' };

  // 双向添加好友
  const { error: e2 } = await state.supabase
    .from('contacts')
    .insert([
      { user_id: state.myId, contact_id: contactId },
      { user_id: contactId, contact_id: state.myId },
    ]);

  if (e2) { console.error('Add contact error:', e2); return { error: '添加失败，请重试' }; }

  await loadContacts();

  // #2 fix: 添加好友后自动创建私聊会话
  await getOrCreateDirectConversation(contactId);

  return { success: true, name: user.display_name };
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

  const { error: e2 } = await state.supabase
    .from('conversation_members')
    .insert([
      { conversation_id: conv.id, user_id: state.myId, role: 'owner' },
      { conversation_id: conv.id, user_id: contactId, role: 'member' },
    ]);

  if (e2) { console.error('Add members error:', e2); return null; }

  await loadConversations();
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

  const allMembers = [state.myId, ...memberIds];
  const members = allMembers.map(uid => ({
    conversation_id: conv.id,
    user_id: uid,
    role: uid === state.myId ? 'owner' : 'member',
  }));

  const { error: e2 } = await state.supabase.from('conversation_members').insert(members);
  if (e2) { console.error('Add group members error:', e2); return null; }

  await state.supabase.from('messages').insert({
    conversation_id: conv.id, sender_id: state.myId,
    content: `${state.myName} 创建了群聊`, msg_type: 'system',
  });

  await loadConversations();
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
  // #7 fix: 先发请求，成功后再修改本地状态
  const { error } = await state.supabase
    .from('conversation_members')
    .delete()
    .eq('conversation_id', convId)
    .eq('user_id', state.myId);

  if (error) { console.error('Leave group error:', error); return false; }

  delete state.messages[convId];
  state.currentConvId = null;
  await loadConversations();
  renderConversationList();
  renderChatEmpty();
  return true;
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

  await loadConversations();
  renderConversationList();
  return true;
}

// ---------- 实时订阅 ----------
function subscribeRealtime() {
  // 构建用户参与的会话 ID 集合，实时过滤
  function myConvIds() {
    return new Set(state.conversations.map(c => c.id));
  }

  state.subscription = state.supabase
    .channel('messages-realtime')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
    }, (payload) => {
      const msg = payload.new;
      // 忽略自己发的（本地已处理）
      if (msg.sender_id === state.myId) return;
      // 只处理自己参与的会话的消息
      if (!myConvIds().has(msg.conversation_id)) return;

      if (!state.messages[msg.conversation_id]) state.messages[msg.conversation_id] = [];
      state.messages[msg.conversation_id].push(msg);

      if (state.currentConvId === msg.conversation_id) {
        renderMessages(msg.conversation_id);
        scrollMessagesToBottom();
      } else {
        toast(`新消息: ${msg.content.slice(0, 30)}`);
      }

      loadConversations().then(() => renderConversationList());
    })
    .subscribe();
}

// ---------- UI 渲染 ----------
function renderMyInfo() {
  $('myAvatar').textContent = getInitial(state.myName);
  $('myAvatar').style.background = state.myColor;
  $('myName').textContent = state.myName;
  $('myId').textContent = state.myId;
  $('myId').title = '点击复制: ' + state.myId;
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
      avatarHtml = `<div class="conv-avatar group-avatar" style="background:${conv.avatar_color}">
        ${conv.members.slice(0, 4).map(m =>
          `<span style="background:${m.avatar_color}">${getInitial(m.display_name)}</span>`
        ).join('')}
      </div>`;
    } else {
      avatarHtml = `<div class="conv-avatar" style="background:${conv.avatar_color}">${getInitial(conv.name)}</div>`;
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

  $('chatInfoTitle').textContent = conv.type === 'group' ? '群聊信息' : '好友信息';

  $('chatInfoMembers').innerHTML = conv.members.map(m => `
    <div class="chat-info-member">
      <div class="member-avatar" style="background:${m.avatar_color}">${getInitial(m.display_name)}</div>
      <div class="member-name">${escapeHtml(m.display_name)}</div>
    </div>
  `).join('');

  let actionsHtml = '';
  if (conv.type === 'group') {
    actionsHtml = `
      <button class="btn btn-secondary" id="btnAddGroupMember">+ 邀请好友入群</button>
      <button class="btn btn-danger" id="btnLeaveGroup">退出群聊</button>`;
  }
  $('chatInfoActions').innerHTML = actionsHtml;

  // #5 fix: 用事件委托 + once 防止重复绑定
  $('chatInfoActions').onclick = async (e) => {
    if (e.target.id === 'btnAddGroupMember') {
      closeModal('modalChatInfo');
      renderInviteMemberSelect();
      openModal('modalInviteMember');
    }
    if (e.target.id === 'btnLeaveGroup') {
      if (confirm('确定要退出群聊吗？')) {
        const ok = await leaveGroup(state.currentConvId);
        closeModal('modalChatInfo');
        toast(ok ? '已退出群聊' : '退出失败', ok ? '' : 'error');
      }
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
    document.querySelectorAll('.theme-toggle').forEach(t => {
      t.classList.toggle('active', t.dataset.theme === currentTheme);
    });

    // 重置到第一个分类
    document.querySelectorAll('.settings-nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.settings-nav-item[data-section="profile"]').classList.add('active');
    document.querySelectorAll('.settings-section').forEach(s => s.style.display = 'none');
    $('sectionProfile').style.display = 'block';

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

    const sectionMap = { profile: 'sectionProfile', appearance: 'sectionAppearance', about: 'sectionAbout' };
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
  document.querySelectorAll('.theme-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      document.querySelectorAll('.theme-toggle').forEach(t => t.classList.remove('active'));
      toggle.classList.add('active');
      const theme = toggle.dataset.theme;
      localStorage.setItem('webchat_theme', theme);
      document.documentElement.setAttribute('data-theme', theme);
      toast(theme === 'dark' ? '已切换深色模式' : '已切换浅色模式', 'success');
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
      $('addContactFeedback').textContent = `已添加 ${result.name}`;
      $('addContactFeedback').className = 'modal-feedback success';
      renderConversationList();
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
  $('btnSend').addEventListener('click', async () => {
    const input = $('messageInput');
    const ok = await sendMessage(input.value);
    if (ok !== false) { input.value = ''; input.style.height = 'auto'; }
  });

  $('messageInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = $('messageInput');
      const ok = await sendMessage(input.value);
      if (ok !== false) { input.value = ''; input.style.height = 'auto'; }
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

  // 会话信息
  $('btnChatInfo').addEventListener('click', () => {
    renderChatInfo();
    openModal('modalChatInfo');
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
    return;
  }

  state.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  await initIdentity();
  renderMyInfo();

  try {
    await initSupabase();
  } catch (e) {
    $('conversationList').innerHTML = `<div class="empty-state">
      <p style="color:#fa5151">⚠️ 连接失败</p>
      <p class="hint">请检查 config.js 配置</p>
    </div>`;
    return;
  }

  await loadContacts();
  await loadConversations();
  renderConversationList();
  subscribeRealtime();
  bindEvents();

  toast('连接成功');
}

init();
