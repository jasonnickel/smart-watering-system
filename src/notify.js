// Notification dispatch
// Sends alerts via n8n webhook (preferred) or logs for systemd journal pickup.
// SMTP via nodemailer can be added later if needed.

import './env.js';
import { log } from './log.js';

const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

/**
 * Send a notification.
 *
 * @param {string} type - Notification category (watchdog, weather, summary, alert)
 * @param {string} severity - info, warning, critical
 * @param {string} subject - Short subject line
 * @param {string} message - Full message body (plain text)
 * @param {object} data - Optional structured data payload
 */
export async function notify(type, severity, subject, message, data = {}) {
  log(severity === 'critical' ? 0 : 1, `[${type}] ${subject}: ${message}`);

  if (!WEBHOOK_URL) {
    log(2, 'No N8N_WEBHOOK_URL configured, notification logged only');
    return;
  }

  try {
    const response = await fetch(`${WEBHOOK_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        severity,
        subject,
        message,
        data,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      log(0, `Notification webhook returned ${response.status}`);
    }
  } catch (err) {
    log(0, `Notification webhook failed: ${err.message}`);
  }
}

/**
 * Send a daily summary email via n8n webhook.
 *
 * @param {string} htmlBody - Full HTML email content
 * @param {string} subject - Email subject
 */
export async function sendSummaryEmail(subject, htmlBody) {
  log(1, `Sending summary: ${subject}`);

  if (!WEBHOOK_URL) {
    log(1, 'No N8N_WEBHOOK_URL configured, summary not sent');
    return;
  }

  try {
    await fetch(`${WEBHOOK_URL}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, html: htmlBody, timestamp: new Date().toISOString() }),
    });
  } catch (err) {
    log(0, `Summary webhook failed: ${err.message}`);
  }
}
