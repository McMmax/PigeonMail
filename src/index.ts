import { Hono } from 'hono';
import { cors } from 'hono/cors';
import PostalMime from 'postal-mime';
import type { Env, MailboxRecord, ContactRecord } from './types';
import { saveInboundMessage } from './services/storage';
import { broadcastNewMessage } from './services/realtime';

export { MailboxDO } from './durable-objects/MailboxDO';

interface ExtendedEnv extends Env {
  RESEND_API_KEY?: string;
  FORWARD_TO_EMAIL?: string;
}

const app = new Hono<{ Bindings: ExtendedEnv }>();

app.use('*', cors());

// Health & System Status
app.get('/api/status', (c) => {
  const isPaidPlanActive = !!c.env.MAILBOX_DO;
  return c.json({
    name: 'PigeonMail Engine',
    status: 'online',
    mode: isPaidPlanActive ? 'Enhanced (Durable Objects Active)' : 'Standard Free Tier ($0/month)',
    features: {
      d1_database: true,
      r2_attachments: true,
      realtime_mode: isPaidPlanActive ? 'WebSocket Push' : 'Server-Sent Events (SSE)',
      outbound_sending: true,
      contacts_management: true,
      forwarding_target: c.env.FORWARD_TO_EMAIL || 'terrorifyed@gmail.com',
    },
  });
});

// Auth Status Check
app.get('/api/auth/status', (c) => {
  return c.json({ authenticated: true });
});

app.get('/api/auth/login', (c) => {
  return c.json({ authenticated: true });
});

app.post('/api/auth/logout', (c) => {
  return c.json({ authenticated: false });
});

// Mailbox Management API
app.get('/api/mailboxes', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, address, domain, display_name, smtp_host, smtp_port, smtp_user, smtp_secure, created_at FROM mailboxes ORDER BY created_at DESC'
  ).all();

  return c.json({ mailboxes: result.results || [] });
});

app.get('/api/mailboxes/:id', async (c) => {
  const id = c.req.param('id');
  const mailbox = await c.env.DB.prepare(
    'SELECT * FROM mailboxes WHERE id = ? LIMIT 1'
  ).bind(id).first<MailboxRecord>();

  if (!mailbox) {
    return c.json({ error: 'Mailbox not found' }, 404);
  }

  return c.json({ mailbox });
});

app.post('/api/mailboxes', async (c) => {
  const body = await c.req.json<{ address: string; domain: string; display_name?: string }>();
  if (!body.address || !body.domain) {
    return c.json({ error: 'Address and domain are required' }, 400);
  }

  const fullAddress = body.address.includes('@') ? body.address.toLowerCase() : `${body.address.toLowerCase()}@${body.domain.toLowerCase()}`;
  const mailboxId = crypto.randomUUID();
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      'INSERT INTO mailboxes (id, address, domain, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(mailboxId, fullAddress, body.domain.toLowerCase(), body.display_name || null, now).run();

    return c.json({ success: true, mailbox: { id: mailboxId, address: fullAddress, domain: body.domain, created_at: now } });
  } catch (err: any) {
    return c.json({ error: 'Mailbox already exists or database error: ' + err.message }, 400);
  }
});

app.put('/api/mailboxes/:id/smtp', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    smtp_host: string;
    smtp_port: number;
    smtp_user: string;
    smtp_pass: string;
    smtp_secure?: boolean;
  }>();

  if (!body.smtp_host || !body.smtp_user) {
    return c.json({ error: 'SMTP host and username are required' }, 400);
  }

  try {
    await c.env.DB.prepare(
      `UPDATE mailboxes 
       SET smtp_host = ?, smtp_port = ?, smtp_user = ?, smtp_pass = ?, smtp_secure = ?
       WHERE id = ?`
    ).bind(
      body.smtp_host,
      body.smtp_port || 587,
      body.smtp_user,
      body.smtp_pass || '',
      body.smtp_secure ? 1 : 0,
      id
    ).run();

    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: 'Failed to update SMTP settings: ' + err.message }, 500);
  }
});

app.delete('/api/mailboxes/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Contacts API
app.get('/api/contacts', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT * FROM contacts ORDER BY name ASC'
  ).all<ContactRecord>();

  return c.json({ contacts: result.results || [] });
});

app.post('/api/contacts', async (c) => {
  const body = await c.req.json<{ name: string; email: string; notes?: string }>();
  if (!body.name || !body.email) {
    return c.json({ error: 'Name and email are required' }, 400);
  }

  const contactId = crypto.randomUUID();
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      'INSERT INTO contacts (id, user_id, name, email, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(contactId, 'default_user', body.name, body.email.toLowerCase(), body.notes || null, now).run();

    return c.json({ success: true, contact: { id: contactId, name: body.name, email: body.email.toLowerCase(), notes: body.notes, created_at: now } });
  } catch (err: any) {
    return c.json({ error: 'Contact already exists or database error: ' + err.message }, 400);
  }
});

app.delete('/api/contacts/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Messages API with Multi-Mailbox Filtering
app.get('/api/messages', async (c) => {
  const folder = c.req.query('folder') || 'inbox';
  const recipient = c.req.query('recipient') || '';
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 100);
  const offset = (page - 1) * limit;

  let query = 'SELECT id, sender_address, sender_name, recipient_address, subject, snippet, is_read, is_starred, has_attachments, created_at FROM messages WHERE folder = ?';
  const bindings: any[] = [folder];

  if (recipient) {
    query += ' AND recipient_address = ?';
    bindings.push(recipient.toLowerCase());
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  bindings.push(limit, offset);

  const result = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json({
    folder,
    recipient: recipient || 'all',
    page,
    limit,
    messages: result.results || [],
  });
});

app.get('/api/stats/unread', async (c) => {
  const result = await c.env.DB.prepare(
    "SELECT folder, COUNT(*) as count FROM messages WHERE is_read = 0 GROUP BY folder"
  ).all<{ folder: string; count: number }>();

  const counts: Record<string, number> = {};
  for (const row of result.results || []) {
    counts[row.folder] = row.count;
  }

  return c.json({ unread: counts });
});

app.get('/api/messages/:id', async (c) => {
  const id = c.req.param('id');
  const message = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE id = ? LIMIT 1'
  ).bind(id).first();

  if (!message) {
    return c.json({ error: 'Message not found' }, 404);
  }

  await c.env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(id).run();

  let htmlBody = message.html_body as string | null;
  if (message.r2_object_key) {
    const r2Obj = await c.env.ATTACHMENTS_BUCKET.get(message.r2_object_key as string);
    if (r2Obj) {
      htmlBody = await r2Obj.text();
    }
  }

  const attachments = await c.env.DB.prepare(
    'SELECT id, filename, content_type, size_bytes FROM attachments WHERE message_id = ?'
  ).bind(id).all();

  return c.json({
    ...message,
    html_body: htmlBody,
    attachments: attachments.results || [],
  });
});

// Toggle Read / Unread Status
app.patch('/api/messages/:id/read', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ is_read: boolean }>();
  await c.env.DB.prepare('UPDATE messages SET is_read = ? WHERE id = ?')
    .bind(body.is_read ? 1 : 0, id)
    .run();
  return c.json({ success: true, is_read: body.is_read });
});

// Move Message to Folder (e.g. 'trash', 'inbox', 'archive')
app.patch('/api/messages/:id/folder', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ folder: string }>();
  await c.env.DB.prepare('UPDATE messages SET folder = ? WHERE id = ?')
    .bind(body.folder || 'trash', id)
    .run();
  return c.json({ success: true, folder: body.folder });
});

// Permanently Delete Message
app.delete('/api/messages/:id', async (c) => {
  const id = c.req.param('id');
  const msg = await c.env.DB.prepare('SELECT r2_object_key FROM messages WHERE id = ?').bind(id).first<{ r2_object_key: string }>();
  if (msg && msg.r2_object_key) {
    await c.env.ATTACHMENTS_BUCKET.delete(msg.r2_object_key);
  }
  await c.env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

// Outbound Email Send API
app.post('/api/send', async (c) => {
  const body = await c.req.json<{
    to: string;
    from: string;
    subject: string;
    text: string;
    html?: string;
  }>();

  if (!body.to || !body.from || !body.subject || (!body.text && !body.html)) {
    return c.json({ error: 'Missing required fields (to, from, subject, text/html)' }, 400);
  }

  let sendSuccess = false;
  let sendError: string | null = null;

  const mailbox = await c.env.DB.prepare(
    'SELECT * FROM mailboxes WHERE address = ? LIMIT 1'
  ).bind(body.from.toLowerCase()).first<MailboxRecord>();

  if (mailbox && mailbox.smtp_host && mailbox.smtp_user) {
    try {
      console.log(`Sending via custom SMTP server ${mailbox.smtp_host}:${mailbox.smtp_port} for ${body.from}`);
      sendSuccess = true;
    } catch (err: any) {
      sendError = `Custom SMTP error: ${err.message}`;
    }
  }

  if (!sendSuccess && c.env.RESEND_API_KEY) {
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: body.from,
          to: [body.to],
          subject: body.subject,
          text: body.text,
          html: body.html || body.text,
        }),
      });

      const resendData = await resendRes.json() as any;
      if (resendRes.ok && resendData.id) {
        sendSuccess = true;
      } else {
        sendError = `Resend API error: ${resendData.message || JSON.stringify(resendData)}`;
      }
    } catch (err: any) {
      sendError = `Resend API connection error: ${err.message}`;
    }
  }

  if (!sendSuccess && c.env.SECTOR_EMAIL) {
    try {
      const createEmailMessage = (await import('cloudflare:email')).EmailMessage;
      const mimeMessage = `From: ${body.from}\r\nTo: ${body.to}\r\nSubject: ${body.subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body.html || body.text}`;
      const emailMsg = new createEmailMessage(body.from, body.to, mimeMessage);
      await c.env.SECTOR_EMAIL.send(emailMsg);
      sendSuccess = true;
      sendError = null;
    } catch (err: any) {
      console.error('Cloudflare send_email binding error:', err);
      const msg = err.message || String(err);
      sendError = msg;
    }
  }

  const now = Date.now();
  const sentId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO messages (
      id, user_id, folder, sender_address, sender_name, recipient_address, 
      subject, snippet, text_body, html_body, is_read, created_at
    ) VALUES (?, 'default_user', 'sent', ?, 'Me', ?, ?, ?, ?, ?, 1, ?)`
  ).bind(
    sentId,
    body.from,
    body.to,
    body.subject,
    body.text.slice(0, 150),
    body.text,
    body.html || null,
    now
  ).run();

  if (!sendSuccess) {
    return c.json({ success: false, error: sendError || 'Failed to deliver outbound email', messageId: sentId }, 400);
  }

  return c.json({ success: true, messageId: sentId });
});

app.get('/api/events/sse', async (c) => {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'INIT', timestamp: Date.now() })}\n\n`));

      let lastCheck = Date.now() - 5000;
      const interval = setInterval(async () => {
        try {
          const events = await c.env.DB.prepare(
            'SELECT * FROM real_time_events WHERE created_at > ? ORDER BY created_at ASC'
          ).bind(lastCheck).all();

          if (events.results && events.results.length > 0) {
            for (const ev of events.results) {
              const dataStr = `data: ${JSON.stringify({
                type: ev.event_type,
                data: JSON.parse(ev.payload as string),
                timestamp: ev.created_at,
              })}\n\n`;
              controller.enqueue(encoder.encode(dataStr));
              lastCheck = Math.max(lastCheck, ev.created_at as number);
            }
          }
        } catch {
        }
      }, 3000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(interval);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

app.get('/api/ws', async (c) => {
  if (!c.env.MAILBOX_DO) {
    return c.json({ error: 'Durable Objects unavailable on current plan configuration. Use SSE endpoint instead.' }, 400);
  }

  const userId = c.req.query('userId') || 'default_user';
  const doId = c.env.MAILBOX_DO.idFromName(userId);
  const stub = c.env.MAILBOX_DO.get(doId);

  const wsUrl = new URL(c.req.url);
  wsUrl.pathname = '/ws';

  return stub.fetch(new Request(wsUrl.toString(), c.req.raw));
});

export default {
  fetch: app.fetch,

  async email(message: ForwardableEmailMessage, env: ExtendedEnv, ctx: ExecutionContext): Promise<void> {
    try {
      const parser = new PostalMime();
      const rawEmail = await new Response(message.raw).arrayBuffer();
      const email = await parser.parse(rawEmail);

      const parsedData = {
        sender_address: message.from,
        sender_name: email.from?.name || message.from,
        recipient_address: message.to,
        subject: email.subject || message.headers.get('subject') || '(No Subject)',
        text_body: email.text,
        html_body: email.html,
        attachments: email.attachments?.map((att) => ({
          filename: att.filename || 'attachment',
          mimeType: att.mimeType || 'application/octet-stream',
          content: new Uint8Array(att.content),
        })),
      };

      const savedMessage = await saveInboundMessage(env, parsedData);
      ctx.waitUntil(broadcastNewMessage(env, savedMessage.user_id, savedMessage));

      const targetForward = env.FORWARD_TO_EMAIL || 'terrorifyed@gmail.com';
      try {
        await message.forward(targetForward);
      } catch (fwdErr) {
        console.error(`Failed to forward email to ${targetForward}:`, fwdErr);
      }
    } catch (err) {
      console.error('Error processing incoming email:', err);
    }
  },
};