-- 【已废弃】本增量脚本已并入 supabase-setup.sql（安全加固版）。
-- 若单独执行过旧版，会重建出一个绕过 RLS 的视图；请用下方安全版本覆盖。

DROP VIEW IF EXISTS conversation_last_message;
CREATE VIEW conversation_last_message WITH (security_invoker = true) AS
SELECT DISTINCT ON (conversation_id)
  conversation_id, content, sender_id, created_at
FROM messages
ORDER BY conversation_id, created_at DESC;
