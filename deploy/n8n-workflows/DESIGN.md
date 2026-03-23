# n8n Integration Design

n8n serves as a thin shell for notifications and manual triggers only.
The decision engine runs independently via systemd.

## Workflow 1: Manual Water Trigger

Webhook node (POST /webhook/taproot/water)
  -> Execute Command node: `node /home/jason/taproot/src/cli.js water`
  -> IF node: check exit code
     -> Success: Email notification "Manual watering started"
     -> Failure: Email notification "Manual watering failed"

Webhook URL becomes an iOS Shortcut for "water now" from phone.

## Workflow 2: Status Query

Webhook node (GET /webhook/taproot/status)
  -> Execute Command node: `node /home/jason/taproot/src/cli.js status`
  -> Respond to Webhook node: return stdout as JSON

## Workflow 3: Notification Relay

Webhook node (POST /webhook/taproot/notify)
  -> Email Send node: forward notification to NOTIFICATION_EMAIL

The CLI can POST to this webhook instead of handling SMTP directly.
Simpler than configuring SMTP in the Node.js app.

## Workflow 4: Watchdog Alert

Triggered by taproot-watchdog.service via webhook POST.
Sends a high-priority email if no successful run in 24 hours.

## Setup

1. Import these workflow templates into n8n
2. Set the webhook URLs in ~/.taproot/.env as N8N_WEBHOOK_URL
3. Configure n8n email credentials for notification delivery
