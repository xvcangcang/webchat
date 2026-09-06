// ============================================
// WebChat — 主应用逻辑
// ============================================

// ---------- 全局状态 ----------
const state = {
  supabase: null,
  myId: null,
  myName: '',
  myColor: '',
  contacts: [],           // { contact_id, remark, display_name, avatar_color }
  conversations: [],      // { id, type, name, avatar_color, members[], lastMsg }
  currentConvId: null,
  messages: {},           // convId -> [msg]
  subscription: null,
};

// ---------- 工具函数 ----------
function genUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
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
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  const el = document.createElement('div');
  el.textContent = s;
  return el.innerHTML;
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
function initIdentity() {
  let id = localStorage.getItem('webchat_id');
  let name = localStorage.getItem('webchat_name');
  let color = localStorage.getItem('webchat_color');

  if (!id) {
    id = genUUID();
    localStorage.setItem('webchat_id', id);
  }
  if (!name) {
    name = '用户' + id.slice(0, 4);
    localStorage.setItem('webchat_name', name);
  }
  if (!color) {
    color = randomColor();
    localStorage.setItem('webchat_color', color);
  }

  state.myId = id;
  state.myName = name;
  state.myColor = color;
}

// ---------- Supabase 初始化 ----------
async function initSupabase() {
  // 从 config.js 读取 (SUPABASE_URL, SUPABASE_ANON_KEY 在全局)
  if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
    toast('请先配置 config.js！参考 config.example.js', 'error');
    throw new Error('Missing config.js');
  }

  state.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

  // 启动心跳
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
  // 获取我参与的会话
  const { data: memberships, error: e1 } = await state.supabase
    .from('conversation_members')
    .select('conversation_id, role')
    .eq('user_id', state.myId);

  if (e1) { console.error('Load conv memberships error:', e1); return; }

  const convIds = (memberships || []).map(m => m.conversation_id);
  if (convIds.length === 0) { state.conversations = []; return; }

  // 获取会话详情
  const { data: convs, error: e2 } = await state.supabase
    .from('conversations')
    .select('*')
    .in('id', convIds);

  if (e2) { console.error('Load conversations error:', e2); return; }

  // 获取每个会话的成员
  const { data: allMembers, error: e3 } = await state.supabase
    .from('conversation_members')
    .select('conversation_id, user_id, users(display_name, avatar_color)')
    .in('conversation_id', convIds);

  if (e3) { console.error('Load members error:', e3); return; }

  // 获取每个会话的最后一条消息
  const { data: lastMsgs, error: e4 } = await state.supabase
    .from('messages')
    .select('conversation_id, content, sender_id, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false });

  const lastMsgMap = {};
  for (const msg of (lastMsgs || [])) {
    if (!lastMsgMap[msg.conversation_id]) {
      lastMsgMap[msg.conversation_id] = msg;
    }
  }

  state.conversations = (convs || []).map(conv => {
    const members = (allMembers || [])
      .filter(m => m.conversation_id === conv.id)
      .map(m => ({
        user_id: m.user_id,
        display_name: m.users?.display_name || '未知',
        avatar_color: m.users?.avatar_color || '#999',
      }));

    const lastMsg = lastMsgMap[conv.id];
    let displayName = conv.name;
    let avatarColor = conv.avatar_color;

    // 私聊：显示对方名字
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
      lastMsg: lastMsg ? {
        content: lastMsg.content,
        sender_id: lastMsg.sender_id,
        time: lastMsg.created_at,
      } : null,
    };
  });

  // 按最后消息时间排序
  state.conversations.sort((a, b) => {
    const ta = a.lastMsg?.time || '0';
    const tb = b.lastMsg?.time || '0';
    return tb.localeCompare(ta);
  });
}

async function loadMessages(convId) {
  if (state.messages[convId]) return state.messages[convId];

  const { data, error } = await state.supabase
    .from('messages')
    .select('id, sender_id, content, msg_type, created_at')
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) { console.error('Load messages error:', error); return []; }

  state.messages[convId] = data || [];
  return state.messages[convId];
}

// ---------- 好友操作 ----------
async function addContact(contactId) {
  if (contactId === state.myId) return { error: '不能添加自己' };

  // 检查用户是否存在
  const { data: user, error: e1 } = await state.supabase
    .from('users')
    .select('id, display_name')
    .eq('id', contactId)
    .single();

  if (e1 || !user) return { error: '用户不存在，请检查身份码' };

  // 检查是否已是好友
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
  return { success: true, name: user.display_name };
}

// ---------- 会话操作 ----------
async function getOrCreateDirectConversation(contactId) {
  // 查找已有私聊
  const existing = state.conversations.find(conv => {
    if (conv.type !== 'direct') return false;
    return conv.members.some(m => m.user_id === contactId);
  });

  if (existing) return existing.id;

  // 创建新会话
  const { data: conv, error: e1 } = await state.supabase
    .from('conversations')
    .insert({ type: 'direct', created_by: state.myId })
    .select()
    .single();

  if (e1) { console.error('Create conv error:', e1); return null; }

  // 添加成员
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
    .insert({
      type: 'group',
      name: name,
      avatar_color: randomColor(),
      created_by: state.myId,
    })
    .select()
    .single();

  if (e1) { console.error('Create group error:', e1); return null; }

  const allMembers = [state.myId, ...memberIds];
  const members = allMembers.map(uid => ({
    conversation_id: conv.id,
    user_id: uid,
    role: uid === state.myId ? 'owner' : 'member',
  }));

  const { error: e2 } = await state.supabase
    .from('conversation_members')
    .insert(members);

  if (e2) { console.error('Add group members error:', e2); return null; }

  // 发送系统消息
  await state.supabase
    .from('messages')
    .insert({
      conversation_id: conv.id,
      sender_id: state.myId,
      content: `${state.myName} 创建了群聊`,
      msg_type: 'system',
    });

  await loadConversations();
  renderConversationList();
  return conv.id;
}

async function addMemberToGroup(convId, userId) {
  const { error } = await state.supabase
    .from('conversation_members')
    .insert({ conversation_id: convId, user_id: userId });

  if (error) { console.error('Add member error:', error); return false; }

  const user = state.contacts.find(c => c.contact_id === userId);
  const name = user?.remark || user?.display_name || '新成员';
  await state.supabase
    .from('messages')
    .insert({
      conversation_id: convId,
      sender_id: state.myId,
      content: `${state.myName} 邀请 ${name} 加入了群聊`,
      msg_type: 'system',
    });

  return true;
}

async function leaveGroup(convId) {
  await state.supabase
    .from('conversation_members')
    .delete()
    .eq('conversation_id', convId)
    .eq('user_id', state.myId);

  delete state.messages[convId];
  state.currentConvId = null;
  await loadConversations();
  renderConversationList();
  renderChatEmpty();
}

// ---------- 发送消息 ----------
async function sendMessage(content) {
  if (!content.trim() || !state.currentConvId) return;

  const msg = {
    conversation_id: state.currentConvId,
    sender_id: state.myId,
    content: content.trim(),
    msg_type: 'text',
  };

  const { data, error } = await state.supabase
    .from('messages')
    .insert(msg)
    .select()
    .single();

  if (error) { console.error('Send error:', error); toast('发送失败', 'error'); return; }

  // 本地立即显示
  if (!state.messages[state.currentConvId]) state.messages[state.currentConvId] = [];
  state.messages[state.currentConvId].push(data);
  renderMessages(state.currentConvId);
  scrollMessagesToBottom();

  // 更新会话列表排序
  await loadConversations();
  renderConversationList();
}

// ---------- 实时订阅 ----------
function subscribeRealtime() {
  state.subscription = state.supabase
    .channel('messages-realtime')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'messages',
    }, (payload) => {
      const msg = payload.new;
      // 忽略自己发的（已经本地处理）
      if (msg.sender_id === state.myId) return;

      // 存入本地
      if (!state.messages[msg.conversation_id]) state.messages[msg.conversation_id] = [];
      state.messages[msg.conversation_id].push(msg);

      // 如果当前正在看这个会话，立即渲染
      if (state.currentConvId === msg.conversation_id) {
        renderMessages(msg.conversation_id);
        scrollMessagesToBottom();
      } else {
        // 否则显示未读提示
        toast(`新消息: ${msg.content.slice(0, 30)}`);
      }

      // 刷新会话列表
      loadConversations().then(() => renderConversationList());
    })
    .subscribe();
}

// ---------- UI 渲染 ----------
function renderMyInfo() {
  $('myAvatar').textContent = getInitial(state.myName);
  $('myAvatar').style.background = state.myColor;
  $('myName').textContent = state.myName;
  $('myId').textContent = state.myId.slice(0, 8) + '...';
  $('myId').title = '点击复制: ' + state.myId;
}

function renderConversationList() {
  const list = $('conversationList');
  const filter = $('searchInput').value.toLowerCase();

  const filtered = state.conversations.filter(c =>
    c.name.toLowerCase().includes(filter)
  );

  if (filtered.length === 0) {
    list.innerHTML = '';
    list.appendChild($('emptyConvList') || createEmptyConvList());
    return;
  }

  list.innerHTML = filtered.map(conv => {
    const isActive = conv.id === state.currentConvId;
    const lastMsgText = conv.lastMsg?.content || '';
    const lastMsgTime = conv.lastMsg?.time ? formatTime(conv.lastMsg.time) : '';
    const isGroup = conv.type === 'group';

    let avatarHtml;
    if (isGroup && conv.members.length >= 2) {
      const colors = conv.members.slice(0, 4).map(m => m.avatar_color);
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

  // 绑定点击
  list.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', () => openConversation(el.dataset.convId));
  });
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

  // Mobile: hide sidebar
  $('sidebar').classList.add('hidden');

  // Show chat UI
  $('chatEmpty').style.display = 'none';
  $('chatHeader').style.display = 'flex';
  $('messageList').style.display = 'flex';
  $('chatInputArea').style.display = 'flex';

  // Header
  $('chatHeaderAvatar').textContent = getInitial(conv.name);
  $('chatHeaderAvatar').style.background = conv.avatar_color;
  $('chatHeaderName').textContent = conv.name;

  // Load & render messages
  await loadMessages(convId);
  renderMessages(convId);
  scrollMessagesToBottom();
  renderConversationList();

  // Focus input
  $('messageInput').focus();
}

function renderMessages(convId) {
  if (state.currentConvId !== convId) return;

  const msgs = state.messages[convId] || [];
  const conv = state.conversations.find(c => c.id === convId);
  const list = $('messageList');

  list.innerHTML = msgs.map(msg => {
    if (msg.msg_type === 'system') {
      return `<div class="msg-system">${escapeHtml(msg.content)}</div>`;
    }

    const isSelf = msg.sender_id === state.myId;
    const member = conv?.members.find(m => m.user_id === msg.sender_id);
    const senderName = isSelf ? '' : (member?.display_name || '未知');
    const senderColor = member?.avatar_color || '#999';

    return `<div class="msg-group ${isSelf ? 'self' : ''}">
      <div class="msg-avatar" style="background:${isSelf ? state.myColor : senderColor}">
        ${isSelf ? getInitial(state.myName) : getInitial(senderName)}
      </div>
      <div class="msg-content">
        ${!isSelf ? `<div class="msg-sender">${escapeHtml(senderName)}</div>` : ''}
        <div class="msg-bubble">${escapeHtml(msg.content)}</div>
        <div class="msg-time">${formatTime(msg.created_at)}</div>
      </div>
    </div>`;
  }).join('');
}

function scrollMessagesToBottom() {
  const list = $('messageList');
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

// ---------- 模态框 ----------
function openModal(id) { $(id).style.display = 'flex'; }
function closeModal(id) { $(id).style.display = 'none'; }

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

  // 绑定事件
  const addBtn = $('btnAddGroupMember');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      closeModal('modalChatInfo');
      renderInviteMemberSelect();
      openModal('modalInviteMember');
    });
  }

  const leaveBtn = $('btnLeaveGroup');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', async () => {
      if (confirm('确定要退出群聊吗？')) {
        await leaveGroup(state.currentConvId);
        closeModal('modalChatInfo');
        toast('已退出群聊');
      }
    });
  }
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
    openModal('modalSettings');
  });

  $('btnSaveSettings').addEventListener('click', async () => {
    const newName = $('inputMyName').value.trim();
    if (!newName) { toast('昵称不能为空', 'error'); return; }

    state.myName = newName;
    localStorage.setItem('webchat_name', newName);

    await state.supabase
      .from('users')
      .update({ display_name: newName })
      .eq('id', state.myId);

    renderMyInfo();
    await loadConversations();
    renderConversationList();
    closeModal('modalSettings');
    toast('设置已保存', 'success');
  });

  $('btnCopyId').addEventListener('click', () => {
    navigator.clipboard.writeText(state.myId).then(() => toast('身份码已复制', 'success'));
  });

  // 新建菜单
  $('btnAddMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('addMenu');
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  document.addEventListener('click', () => {
    $('addMenu').style.display = 'none';
  });

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
      const result = await addMemberToGroup(state.currentConvId, uid);
      if (!result) ok = false;
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
  $('btnSend').addEventListener('click', () => {
    const input = $('messageInput');
    sendMessage(input.value);
    input.value = '';
    input.style.height = 'auto';
  });

  $('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const input = $('messageInput');
      sendMessage(input.value);
      input.value = '';
      input.style.height = 'auto';
    }
  });

  // Auto-resize textarea
  $('messageInput').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  // 返回按钮 (mobile)
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

  // 模态框关闭
  document.querySelectorAll('.modal-close, [data-modal]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modalId = btn.dataset.modal || btn.closest('.modal-overlay')?.id;
      if (modalId) closeModal(modalId);
    });
  });

  // 点击 overlay 关闭
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  });
}

// ---------- 初始化 ----------
async function init() {
  initIdentity();
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

// 启动
init();
