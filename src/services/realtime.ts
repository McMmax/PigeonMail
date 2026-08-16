import type { Env, MessageRecord } from '../types';

export async function broadcastNewMessage(
  env: Env,
  userId: string,
  message: MessageRecord
): Promise<void> {
  const eventPayload = {
    type: 'NEW_EMAIL',
    timestamp: Date.now(),
    data: {
      id: message.id,
      sender_address: message.sender_address,
      sender_name: message.sender_name,
      subject: message.subject,
      snippet: message.snippet,
      created_at: message.created_at,
    },
  };

  if (env.MAILBOX_DO) {
    try {
      const doId = env.MAILBOX_DO.idFromName(userId);
      const stub = env.MAILBOX_DO.get(doId);
      await stub.fetch('https://mailbox-do/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload),
      });
      return;
    } catch (err) {
      console.warn('Durable Object broadcast failed, falling back to D1 event queue:', err);
    }
  }

  try {
    const eventId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO real_time_events (id, user_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(eventId, userId, eventPayload.type, JSON.stringify(eventPayload.data), eventPayload.timestamp).run();

    const oneHourAgo = Date.now() - 3600000;
    await env.DB.prepare('DELETE FROM real_time_events WHERE created_at < ?').bind(oneHourAgo).run();
  } catch (err) {
    console.error('Failed to write SSE event to D1:', err);
  }
}
