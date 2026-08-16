import type { D1Database, R2Bucket, SendEmail, DurableObjectNamespace } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  ATTACHMENTS_BUCKET: R2Bucket;
  SECTOR_EMAIL?: SendEmail;
  MAILBOX_DO?: DurableObjectNamespace;
  JWT_SECRET?: string;
}

export interface DomainInfo {
  id: string;
  name: string;
  status: string;
  email_routing_enabled: boolean;
}

export interface MailboxRecord {
  id: string;
  address: string;
  domain: string;
  display_name?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_pass?: string;
  smtp_secure?: number;
  created_at: number;
}

export interface ContactRecord {
  id: string;
  user_id: string;
  name: string;
  email: string;
  notes?: string;
  created_at: number;
}

export interface MessageRecord {
  id: string;
  user_id: string;
  folder: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | string;
  sender_address: string;
  sender_name?: string;
  recipient_address: string;
  subject: string;
  snippet?: string;
  text_body?: string;
  html_body?: string;
  r2_object_key?: string;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  created_at: number;
}

export interface AttachmentRecord {
  id: string;
  message_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
}
