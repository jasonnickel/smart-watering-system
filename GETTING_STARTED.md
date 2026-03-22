# Getting Started

This guide assumes you have a Rachio sprinkler controller and optionally an Ambient Weather station. No coding experience required.

## Before You Start: Getting Your API Keys

You need to gather a few keys before installing. This section walks through exactly where to find each one.

### Rachio API Key (required)

Your Rachio API key lets this system talk to your sprinkler controller. Here's how to get it:

1. Open a web browser and go to **https://app.rach.io**
2. Log in with the same email/password you use in the Rachio phone app
3. Click your **name or profile icon** in the bottom-left corner
4. Click **Account Settings**
5. Scroll down to the section labeled **API Access**
6. Click **Get API Key**
7. A long string of letters and numbers will appear (example: `46d88fc7-ac38-45a8-bfed-1caab7400a2d`)
8. Copy this entire string - you'll paste it during setup

If you don't see an API Access section, your Rachio firmware may need an update. Open the Rachio phone app and check for updates under Device Settings.

### Ambient Weather Keys (optional but recommended)

If you have an Ambient Weather station in your yard, this system can read directly from it for hyper-accurate local conditions. You need three things: an API Key, an Application Key, and your station's MAC address.

**If you don't have a weather station**, skip this section entirely. The system will use OpenMeteo forecast data instead - it works fine, just less precise.

**Getting your API Key and Application Key:**

1. Go to **https://ambientweather.net** and log in
2. Click your **name** in the top-right corner
3. Click **My Account** from the dropdown
4. On the account page, look for a tab or link labeled **API Keys**
5. You should see two keys listed:
   - **API Key** - a long string of letters and numbers (example: `e29f9738c3594f53...`)
   - **Application Key** - another long string (example: `c22da4ee62c14aca...`)
6. If no keys are listed, click **Create API Key** and **Create Application Key**
7. Copy both strings - you'll paste them during setup

**Finding your station's MAC address:**

1. While still on ambientweather.net, click **My Devices** (or **Devices** in the nav bar)
2. Click on your weather station's name
3. Look for **MAC Address** in the device details (example: `2C:F4:32:24:A9:B3`)
4. Copy this value - you'll paste it during setup

The MAC address is also printed on a sticker on the back of your weather station's indoor console unit if you can't find it online.

### Your Zone Layout (can adjust later)

The system comes pre-configured with 9 zones. You can adjust this later, but it helps to know:

- **How many zones** your Rachio controls (check the Rachio app under Zones)
- **Zone types** - which are lawn (spray/rotor heads) and which are drip irrigation
- **Approximate area** of each zone in square feet (a rough guess is fine to start)

Don't worry about getting this perfect. The defaults work for most yards, and you can fine-tune through the web UI after the system is running. The system adapts over time.

**Estimating zone area if you have no idea:**
- Small front yard section: 200-400 sq ft
- Typical side yard: 200-300 sq ft
- Full backyard: 400-800 sq ft
- Drip bed: 100-300 sq ft
- Google Earth (earth.google.com) has a measurement tool - search your address, right-click, and select "Measure distance" to outline each zone

### Where to Run It

You need a computer that stays on. Any of these work:

- **Synology/QNAP NAS** - If it supports Docker, use the Docker install path
- **Proxmox LXC or VM** - Use the direct install path
- **Raspberry Pi** - Use the direct install path (Pi 4 or newer recommended)
- **Unraid** - Use the Docker install path
- **Any always-on Linux machine** - Either path works
- **Old laptop running Ubuntu** - Either path works

The system uses very little resources (less than 100MB RAM, negligible CPU). It only runs actively for a few seconds each hour.

---

## Option A: Docker (Easiest)

This is the simplest way to get running. You need Docker and Docker Compose installed.

**Step 1: Download the project**

```bash
git clone https://github.com/jasonnickel/smart-watering-system.git
cd smart-watering-system
```

**Step 2: Create your configuration**

```bash
cp .env.example .env
```

Open `.env` in any text editor and fill in your API keys. The file has comments explaining each setting.

**Step 3: Edit your zones**

Open `zones.yaml` in any text editor. It's pre-configured with 9 zones. Adjust the zone numbers, types (lawn or drip), sun exposure, and area to match your yard. The file has comments explaining each field.

**Step 4: Start the system**

```bash
docker compose up -d
```

**Step 5: Open the web UI**

Go to `http://your-server-ip:3000` in your browser. You'll see the dashboard with soil moisture levels, weather data, and recent decisions.

The system starts in **shadow mode** by default. It will log what it would do without actually controlling your Rachio. After a week, use the Settings page to switch to live mode.

## Option B: Direct Install (More Control)

**Step 1: Install Node.js**

On Ubuntu/Debian:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
```

On a Proxmox LXC, Node.js may already be installed. Check with `node --version`.

**Step 2: Download and install**

```bash
git clone https://github.com/jasonnickel/smart-watering-system.git ~/smart-water
cd ~/smart-water
npm install --production
```

**Step 3: Run the setup wizard**

```bash
node src/cli.js setup
```

The wizard asks plain-English questions:
- "Rachio API key:" - paste your key
- "Do you have an Ambient Weather station?" - answer y or n
- "n8n webhook URL:" - leave blank if you don't use n8n
- "Notification email:" - where to send alerts

It writes your configuration file automatically. No manual file editing needed.

**Step 4: Verify everything works**

```bash
node src/cli.js doctor
```

You should see green "OK" next to each check:
- Rachio API: connected
- Ambient Weather: connected (with current temperature)
- OpenMeteo: connected
- Database: initialized

If anything shows red, the doctor tells you what to fix.

**Step 5: Run your first shadow cycle**

```bash
node src/cli.js run --shadow
```

This makes a real decision using live weather data but does NOT send any commands to your Rachio. Check what it decided:

```bash
node src/cli.js status
```

**Step 6: Start the web UI**

```bash
node src/web.js
```

Open `http://your-server-ip:3000` in your browser.

To run it permanently as a background service:

```bash
sudo cp deploy/smart-water-web.service /etc/systemd/system/
sudo systemctl enable --now smart-water-web
```

**Step 7: Install the automatic scheduler**

```bash
bash deploy/install.sh
```

This installs three systemd timers:
- **Hourly**: runs the decision cycle every hour
- **Watchdog**: alerts at 2am if no run succeeded
- **Summary**: sends a daily report email at 6am (requires n8n webhook)

**Step 8: Wait a week, then go live**

After 7+ days of shadow runs, switch to live mode:

```bash
node src/cli.js go-live
```

This checks that the system has been running successfully before enabling Rachio control. It asks for confirmation before making any changes.

## Using the Web UI

The web UI has four pages:

**Dashboard** - Current system status at a glance
- Weather source and conditions
- Soil moisture bars for every zone (green/yellow/red)
- Today's forecast
- Water usage and cost
- Quick action buttons: "Water Now" and shadow/live toggle

**Run History** - Every decision the system has made
- Filter by last 24h, 48h, or 7 days
- See DECIDE, COMMAND, and VERIFY phases
- Color-coded results (green for WATER, yellow for SKIP, red for FAILED)

**Zones** - Edit your zone configuration
- Directly edit zones.yaml in the browser
- Save button validates the YAML before writing
- Changes take effect on the next scheduled run

**Settings** - System configuration
- Toggle shadow/live mode
- Edit API keys and environment variables
- All changes saved to ~/.smart-water/.env

## Daily Use

Once the system is running, you don't need to do anything. It makes decisions automatically every hour.

**Check on it**: Open the web UI dashboard or run `node src/cli.js status`

**Read the morning report**: If you configured n8n webhook notifications, you'll get a daily email at 6am with overnight activity, soil moisture, forecast, and cost summary.

**Water manually**: Click "Water Now" on the dashboard or run `node src/cli.js water` from a terminal. This overrides budget and forecast skips but still respects safety conditions (wind, rain, freeze).

**Something seems wrong**: Run `node src/cli.js doctor` to check system health. Green/yellow/red results tell you exactly what needs attention.

## Troubleshooting

**"No runs in the last 24 hours"**
- Check that the systemd timer is running: `systemctl status smart-water.timer`
- Or if using Docker: `docker logs smart-water-scheduler`

**"Rachio API: FAIL"**
- Verify your API key at rachio.com -> Account Settings
- Make sure your Rachio controller is online and connected to WiFi

**"Ambient Weather: FAIL"**
- Check that your station is powered and connected to WiFi
- Verify your API keys at ambientweather.net -> My Account
- The system will fall back to OpenMeteo data - this is fine for basic operation

**"Shadow mode is ON"**
- This is the default and expected for the first week
- Run `node src/cli.js go-live` when you're ready to control your Rachio
- Or toggle it from the Settings page in the web UI

**Decisions don't match what I expect**
- Check `node src/cli.js status --json` for the full decision context
- Review the run history in the web UI
- The system logs every decision with full reasoning - query the SQLite database for details
