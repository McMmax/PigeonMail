# ?? PigeonMail

PigeonMail is a lightweight, privacy-focused email engine and webmail client built for Cloudflare Workers.

It features a hybrid architecture designed to run seamlessly on Cloudflare's free tier while automatically enhancing performance when deployed on accounts with Workers Paid enabled.

---

## ?? Features

- **Free-Tier Core ($0/month)**:
  - **Inbound Processing**: Cloudflare Email Routing passes emails to Workers.
  - **Indexed Storage**: D1 database for message metadata, folders, and search indexes.
  - **Attachment Storage**: R2 bucket for binary attachments and large HTML payloads.
  - **Live Notifications**: Server-Sent Events (SSE) streaming on the standard plan.
- **Enhanced Mode ($5/month Paid Plan)**:
  - **Instant Push Updates**: Durable Objects WebSocket broadcast server for real-time delivery.
  - **Background Queues**: Non-blocking delivery and queue processing.
- **Webmail UI**: Built-in dark mode dashboard with live connection indicators, message reader, and compose modal.

---

## ??? Getting Started

### Local Development

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Initialize Local Database**:
   ```bash
   npm run db:migrate:local
   ```

3. **Run Dev Server**:
   ```bash
   npm run dev
   ```

Open `http://localhost:8787` in your browser.

---

## ?? Production Deployment

1. **Create Cloudflare Resources**:
   ```bash
   wrangler d1 create pigeonmail-db
   wrangler r2 bucket create pigeonmail-attachments
   ```
   Update the `database_id` in `wrangler.jsonc`.

2. **Apply Remote Migrations**:
   ```bash
   npm run db:migrate:prod
   ```

3. **Deploy to Cloudflare**:
   ```bash
   npm run deploy
   ```

4. **Setup Email Routing**:
   In Cloudflare Dashboard ? Email Routing ? Routing Rules ? Add Rule (`*@yourdomain.com` -> Send to Worker `pigeonmail`).

