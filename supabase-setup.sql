-- ============================================
-- WebChat 数据库初始化脚本（安全加固版 v2）
-- 幂等：全新安装与已有数据库迁移均可直接执行
--
-- 执行前请先在 Supabase 控制台开启匿名登录：
--   Authentication → Sign In / Providers → Anonymous → Enable
-- ============================================

-- === 1. 建表（全新安装；已有库为无操作） ===
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                       -- 5/6 位身份码（对外）
  display_name TEXT NOT NULL DEFAULT '用户',
  avatar_color TEXT DEFAULT '#4A90D9',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  auth_uid UUID UNIQUE                       -- 绑定的 Supabase Auth 用户（安全锚点）
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'direct',
  name TEXT,
  avatar_color TEXT DEFAULT '#5B8C5A',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  msg_type TEXT DEFAULT 'text',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 迁移：老库补上 auth_uid 列
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_uid UUID;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_uid_key ON users(auth_uid);

-- === 2. 索引 ===
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_contact ON contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_conv_members_conv ON conversation_members(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);

-- === 3. 数据清理 + 字段格式约束 ===
-- 历史脏数据（非法颜色）先修正，否则 CHECK 约束加不上
UPDATE users SET avatar_color = '#4A90D9'
WHERE avatar_color IS NULL OR avatar_color !~ '^#[0-9A-Fa-f]{6}$';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_color_format') THEN
    ALTER TABLE users ADD CONSTRAINT users_avatar_color_format
      CHECK (avatar_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- === 4. 辅助函数（SECURITY DEFINER：避免策略自引用递归，同时只返回调用者自身信息） ===

-- 当前登录用户的身份码（未登录/未注册返回 NULL）
CREATE OR REPLACE FUNCTION me() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM users WHERE auth_uid = auth.uid();
$$;

-- 是否为指定会话的成员
CREATE OR REPLACE FUNCTION is_member(conv uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM conversation_members WHERE conversation_id = conv AND user_id = me()
  );
$$;

-- 当前用户在指定会话中的角色（非成员返回 NULL）
CREATE OR REPLACE FUNCTION my_role(conv uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM conversation_members WHERE conversation_id = conv AND user_id = me();
$$;

-- === 5. 启用 RLS 并移除旧的全开放策略 ===
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_users" ON users;
DROP POLICY IF EXISTS "anon_all_contacts" ON contacts;
DROP POLICY IF EXISTS "anon_all_conversations" ON conversations;
DROP POLICY IF EXISTS "anon_all_conv_members" ON conversation_members;
DROP POLICY IF EXISTS "anon_all_messages" ON messages;

-- 覆盖本脚本旧版本的策略（幂等重跑）
DROP POLICY IF EXISTS "users_select" ON users;
DROP POLICY IF EXISTS "users_insert" ON users;
DROP POLICY IF EXISTS "users_update" ON users;
DROP POLICY IF EXISTS "contacts_select" ON contacts;
DROP POLICY IF EXISTS "contacts_insert" ON contacts;
DROP POLICY IF EXISTS "contacts_update" ON contacts;
DROP POLICY IF EXISTS "contacts_delete" ON contacts;
DROP POLICY IF EXISTS "conversations_select" ON conversations;
DROP POLICY IF EXISTS "conversations_insert" ON conversations;
DROP POLICY IF EXISTS "conversations_update" ON conversations;
DROP POLICY IF EXISTS "conversations_delete" ON conversations;
DROP POLICY IF EXISTS "members_select" ON conversation_members;
DROP POLICY IF EXISTS "members_insert" ON conversation_members;
DROP POLICY IF EXISTS "members_update" ON conversation_members;
DROP POLICY IF EXISTS "members_delete" ON conversation_members;
DROP POLICY IF EXISTS "messages_select" ON messages;
DROP POLICY IF EXISTS "messages_insert" ON messages;
DROP POLICY IF EXISTS "messages_delete" ON messages;

-- === 6. 新策略（全部限定 authenticated：光有 key、未登录者一律不可访问） ===

-- 用户表：只能看到 自己 / 我的好友 / 同会话成员（防身份码全量枚举）
CREATE POLICY "users_select" ON users FOR SELECT TO authenticated
  USING (
    auth_uid = auth.uid()
    OR EXISTS (
      SELECT 1 FROM contacts c WHERE c.user_id = me() AND c.contact_id = users.id
    )
    OR EXISTS (
      SELECT 1 FROM conversation_members cm1
      JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
      WHERE cm1.user_id = me() AND cm2.user_id = users.id
    )
  );

-- 用户表：只能认领/新建绑定到自己 auth.uid 的行，且身份码须为 5/6 位数字
CREATE POLICY "users_insert" ON users FOR INSERT TO authenticated
  WITH CHECK (auth_uid = auth.uid() AND id ~ '^[0-9]{5,6}$');

-- 用户表：只能改自己已绑定的行，或认领尚未被认领（auth_uid 为 NULL）的历史行
CREATE POLICY "users_update" ON users FOR UPDATE TO authenticated
  USING (auth_uid = auth.uid() OR auth_uid IS NULL)
  WITH CHECK (auth_uid IS NULL OR auth_uid = auth.uid());
-- 注意：无 DELETE 策略，用户行不可删除

-- 好友：看与自己相关的行；只能写入 user_id = 自己 的行（单向添加，需双向确认）
CREATE POLICY "contacts_select" ON contacts FOR SELECT TO authenticated
  USING (user_id = me() OR contact_id = me());
CREATE POLICY "contacts_insert" ON contacts FOR INSERT TO authenticated
  WITH CHECK (user_id = me() AND contact_id <> me());
CREATE POLICY "contacts_update" ON contacts FOR UPDATE TO authenticated
  USING (user_id = me()) WITH CHECK (user_id = me());
CREATE POLICY "contacts_delete" ON contacts FOR DELETE TO authenticated
  USING (user_id = me() OR contact_id = me());

-- 会话：成员或创建者可见/可建；群管操作仅群主；私聊成员可删除
CREATE POLICY "conversations_select" ON conversations FOR SELECT TO authenticated
  USING (is_member(id) OR created_by = me());
CREATE POLICY "conversations_insert" ON conversations FOR INSERT TO authenticated
  WITH CHECK (created_by = me());
CREATE POLICY "conversations_update" ON conversations FOR UPDATE TO authenticated
  USING (my_role(id) = 'owner') WITH CHECK (my_role(id) = 'owner');
CREATE POLICY "conversations_delete" ON conversations FOR DELETE TO authenticated
  USING (my_role(id) = 'owner' OR (type = 'direct' AND is_member(id)));

-- 会话成员：
--  SELECT 仅限自己参与的会话
--  INSERT 自己：必须已在会话中，或自己是会话创建者（创建首个成员）
--           他人：必须已在会话中（仅邀请方可加人）
--  UPDATE 仅群主（设/撤管理员、转让群主）
--  DELETE 自己（退群）/ 群主（踢人）/ 管理员（踢普通成员）
CREATE POLICY "members_select" ON conversation_members FOR SELECT TO authenticated
  USING (is_member(conversation_id));
CREATE POLICY "members_insert" ON conversation_members FOR INSERT TO authenticated
  WITH CHECK (
    (user_id = me() AND (
      is_member(conversation_id)
      OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.created_by = me())
    ))
    OR (user_id <> me() AND is_member(conversation_id))
  );
CREATE POLICY "members_update" ON conversation_members FOR UPDATE TO authenticated
  USING (my_role(conversation_id) = 'owner')
  WITH CHECK (my_role(conversation_id) = 'owner');
CREATE POLICY "members_delete" ON conversation_members FOR DELETE TO authenticated
  USING (
    user_id = me()
    OR my_role(conversation_id) = 'owner'
    OR (my_role(conversation_id) = 'admin' AND role = 'member')
  );

-- 消息：仅会话成员可读；只能以自己的身份发言；成员可撤回/清空
CREATE POLICY "messages_select" ON messages FOR SELECT TO authenticated
  USING (is_member(conversation_id));
CREATE POLICY "messages_insert" ON messages FOR INSERT TO authenticated
  WITH CHECK (sender_id = me() AND is_member(conversation_id));
CREATE POLICY "messages_delete" ON messages FOR DELETE TO authenticated
  USING (is_member(conversation_id));
-- 注意：无 UPDATE 策略，消息不可被修改

-- === 7. 视图：最后一条消息（security_invoker：调用者权限执行，避免绕过 RLS） ===
DROP VIEW IF EXISTS conversation_last_message;
CREATE VIEW conversation_last_message WITH (security_invoker = true) AS
SELECT DISTINCT ON (conversation_id)
  conversation_id, content, sender_id, created_at
FROM messages
ORDER BY conversation_id, created_at DESC;

-- === 8. 启用 Realtime（幂等） ===
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;
