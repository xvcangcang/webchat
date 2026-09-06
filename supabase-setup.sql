-- ============================================
-- WebChat 数据库初始化脚本
-- 在 Supabase SQL Editor 中执行此脚本
-- ============================================

-- 用户表 (身份码)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                    -- UUID 身份码
  display_name TEXT NOT NULL DEFAULT '用户', -- 昵称
  avatar_color TEXT DEFAULT '#4A90D9',    -- 头像颜色
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- 好友关系表
CREATE TABLE IF NOT EXISTS contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remark TEXT,                            -- 备注名
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, contact_id)
);

-- 会话表 (私聊 / 群聊)
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'direct',    -- 'direct' | 'group'
  name TEXT,                              -- 群名 (私聊为空)
  avatar_color TEXT DEFAULT '#5B8C5A',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 会话成员表
CREATE TABLE IF NOT EXISTS conversation_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',             -- 'owner' | 'admin' | 'member'
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(conversation_id, user_id)
);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  msg_type TEXT DEFAULT 'text',           -- 'text' | 'system'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- === 索引 ===
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_contact ON contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_conv_members_conv ON conversation_members(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);

-- === RLS 策略 (因为不用 Supabase Auth，先设为全开放，应用层做校验) ===
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 允许匿名读写 (通过 anon key)
CREATE POLICY "anon_all_users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_contacts" ON contacts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_conversations" ON conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_conv_members" ON conversation_members FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_messages" ON messages FOR ALL USING (true) WITH CHECK (true);

-- === 启用 Realtime ===
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- === 视图：每条会话的最后一条消息 ===
CREATE OR REPLACE VIEW conversation_last_message AS
SELECT DISTINCT ON (conversation_id)
  conversation_id, content, sender_id, created_at
FROM messages
ORDER BY conversation_id, created_at DESC;
