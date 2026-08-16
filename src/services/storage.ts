import type { Env, MessageRecord } from '../types';

export interface ParsedEmailData {
  sender_address: string;
  sender_name?: string;
  recipient_address: string;
  subject: string;
  text_body?: string;
  html_body?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    content: Uint8Array;
  }>;
}

export async function saveInboundMessage(
  env: Env,
  data: ParsedEmailData
): Promise<MessageRecord> {
  const messageId = crypto.randomUUID();
  const now = Date.now();
  const snippet = (data.text_body || data.html_body || '').slice(0, 150).replace(/\s+/g, ' ').trim();

  let r2Key: string | undefined = undefined;
  const hasAttachments = (data.attachments && data.attachments.length > 0) ? 1 : 0;

  if (data.html_body && data.html_body.length > 20000) {
    r2Key = `messages/${messageId}/body.html`;
    await env.ATTACHMENTS_BUCKET.put(r2Key, data.html_body, {
      httpMetadata: { contentType: 'text/html' },
    });
  }

  const userResult = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? LIMIT 1'
  ).bind(data.recipient_address.toLowerCase()).first<{ id: string }>();

  const userId = userResult?.id || 'default_user';

  if (data.attachments && data.attachments.length > 0) {
    for (let i = 0; i < data.attachments.length; i++) {
      const att = data.attachments[i];
      const attId = crypto.randomUUID();
      const attKey = `attachments/${messageId}/${attId}-${att.filename}`;

      await env.ATTACHMENTS_BUCKET.put(attKey, att.content, {
        httpMetadata: { contentType: att.mimeType },
      });

      await env.DB.prepare(
        'INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(attId, messageId, att.filename || `attachment_${i+1}`, att.mimeType || 'application/octet-stream', att.content.byteLength, attKey).run();
    }
  }

  await env.DB.prepare(
    `INSERT INTO messages (
      id, user_id, folder, sender_address, sender_name, recipient_address, 
      subject, snippet, text_body, html_body, r2_object_key, is_read, is_starred, has_attachments, created_at
    ) VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(
    messageId,
    userId,
    data.sender_address,
    data.sender_name || data.sender_address,
    data.recipient_address,
    data.subject || '(No Subject)',
    snippet,
    data.text_body || null,
    r2Key ? null : (data.html_body || null),
    r2Key || null,
    hasAttachments,
    now
  ).run();

  return {
    id: messageId,
    user_id: userId,
    folder: 'inbox',
    sender_address: data.sender_address,
    sender_name: data.sender_name || data.sender_address,
    recipient_address: data.recipient_address,
    subject: data.subject || '(No Subject)',
    snippet,
    text_body: data.text_body,
    html_body: data.html_body,
    r2_object_key: r2Key,
    is_read: 0,
    is_starred: 0,
    has_attachments: hasAttachments,
    created_at: now,
  };
}
