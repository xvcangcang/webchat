-- v1.1 增量：添加"最后一条消息"视图，避免前端查全部消息
CREATE OR REPLACE VIEW conversation_last_message AS
SELECT DISTINCT ON (conversation_id)
  conversation_id, content, sender_id, created_at
FROM messages
ORDER BY conversation_id, created_at DESC;
