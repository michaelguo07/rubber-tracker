# 🏓 Rubber Tracker

**Table Tennis Rubber Sheet Usage Tracker** — Automatically sync your table tennis sessions from Google Health (via Fitbit) and track how long each rubber sheet has been used.

## What It Does

1. **Nightly Sync**: A Google Apps Script runs every night, queries the Google Health API for new table tennis sessions logged by your Fitbit, and appends them to a Google Sheet.
2. **Analysis Dashboard**: A local web app reads the session data and displays:
   - Key usage stats (total play time, session count, averages, frequency)
   - Cumulative play time chart (line chart over time)
   - Session duration chart (bar chart per session)
   - Data anomaly flags (suspiciously long/short sessions, long gaps)
   - Plain-English summary of rubber sheet usage
   - Comparison to prior rubber sheets (if data exists)

---

## Architecture

```
Fitbit Device → Google Health Cloud → Apps Script (nightly sync) → Google Sheet
                                                                        ↓
                                            Web Dashboard ← reads data via Apps Script Web API
```

| Component | Technology | Location |
|-----------|-----------|----------|
| Sync Agent | Google Apps Script | `apps-script/` |
| Data Store | Google Sheets | Your Google Drive |
| Dashboard | HTML/CSS/JS + Chart.js | `dashboard/` |
| Analysis Engine | Vanilla JavaScript | `dashboard/analyzer.js` |

---

## Setup Guide

### Prerequisites

- A **Fitbit device** that auto-detects table tennis (e.g., Fitbit Ace)
- Fitbit account **migrated to a Google account**
- A **Google Cloud project** (free tier is sufficient)
- Node.js installed (for the local dev server — optional)

---

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "Rubber Tracker")
3. Enable the **Fitness API**:
   - Navigate to **APIs & Services > Library**
   - Search for "Fitness API" and enable it
4. Configure the **OAuth consent screen**:
   - Go to **APIs & Services > OAuth consent screen**
   - Choose "External" (or "Internal" if using a Workspace account)
   - Fill in the app name: "Rubber Tracker"
   - Add the scope: `https://www.googleapis.com/auth/fitness.activity.read`
   - Add yourself as a test user
5. Create **OAuth 2.0 credentials**:
   - Go to **APIs & Services > Credentials**
   - Click **Create Credentials > OAuth client ID**
   - Application type: **Web application**
   - Add an authorized redirect URI: `https://script.google.com/macros/d/{YOUR_SCRIPT_ID}/usercallback`
     *(You'll fill in the script ID after creating the Apps Script project)*
   - Note down your **Client ID** and **Client Secret**

---

### Step 2: Set Up the Google Sheet

1. Create a new Google Sheet
2. Create 5 tabs (sheets) with these exact names:
   - **Sessions** — Add headers in row 1: `date | activity_type | duration_minutes | source | synced_at`
   - **Rubber Sheets** — Add headers in row 1: `id | name | installed_date | replaced_date`
   - **Blades** — Add headers in row 1: `id | name | installed_date | replaced_date`
   - **Config** — Cell A1: `last_sync_timestamp`, Cell B1: `2025-01-01T00:00:00Z` (or your preferred start date)
   - **Logs** — Add headers in row 1: `timestamp | type | message`
3. In the **Rubber Sheets** tab, add your current rubber sheet:
   ```
   rs-fh-001 | Dignics 05 (FH) | 2026-03-20 |
   ```
   *(Leave the `replaced_date` column empty for the active sheet)*
   And in the **Blades** tab, add your current blade:
   ```
   b-001 | Butterfly Viscaria | 2026-03-20 |
   ```
4. Note down the **Spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`

---

### Step 3: Set Up the Google Apps Script

1. Go to [Google Apps Script](https://script.google.com/) and create a new project
2. Name it "Rubber Tracker Sync"
3. Delete the default `Code.gs` content and paste the contents of `apps-script/Code.gs`
4. Create a new file for the manifest:
   - Click the gear icon (⚙️ Project Settings)
   - Check **"Show 'appsscript.json' manifest file in editor"**
   - Open `appsscript.json` and replace its contents with `apps-script/appsscript.json`
5. Add the **OAuth2 library**:
   - Click the **+** next to Libraries
   - Enter the library ID: `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`
   - Select version **43** and click Add
6. Set **Script Properties** (⚙️ Project Settings > Script Properties):
   - `CLIENT_ID` = your OAuth Client ID from Step 1
   - `CLIENT_SECRET` = your OAuth Client Secret from Step 1
   - `SPREADSHEET_ID` = your Google Sheet ID from Step 2
7. Update the redirect URI in your Google Cloud Console:
   - Go back to your OAuth credentials
   - Set the redirect URI to: `https://script.google.com/macros/d/{YOUR_SCRIPT_ID}/usercallback`
   - *(Find your script ID in the Apps Script URL)*

---

### Step 4: Authorize & Test

1. In the Apps Script editor, run `showAuthUrl()`:
   - View > Logs to see the authorization URL
   - Open the URL in your browser and grant access
   - You should see "Authorization successful"
2. Run `setupSheet()` to verify the sheet structure
3. Run `syncSessions()` manually to test — check the Logs tab for results
4. Run `createDailyTrigger()` to set up the nightly sync (runs between 2–3 AM)

---

### Step 5: Deploy as Web App (for the Dashboard)

1. In the Apps Script editor: **Deploy > New deployment**
2. Type: **Web app**
3. Execute as: **Me**
4. Who has access: **Anyone**
5. Click **Deploy** and copy the **Web app URL**
6. You'll paste this URL into the dashboard settings

---

### Step 6: Run the Dashboard

**Option A: Using npm (recommended)**
```bash
cd rubber_tracker
npm run dev
```
Opens at `http://localhost:3000`

**Option B: Just open the file**
Open `dashboard/index.html` directly in your browser.
*(Note: fetching from the Apps Script API may not work due to CORS when using file:// protocol — use a local server instead)*

**Connect to live data:**
1. In the dashboard, scroll to the **Settings** section at the bottom
2. Paste your Apps Script Web App URL
3. Click **Load from API**

---

## Project Structure

```
rubber_tracker/
├── dashboard/              # Web dashboard
│   ├── index.html          # Main page
│   ├── styles.css          # Dark-theme styling
│   ├── app.js              # App logic & chart rendering
│   └── analyzer.js         # Analysis engine
├── apps-script/            # Google Apps Script (deploy separately)
│   ├── Code.gs             # Sync agent + web API
│   └── appsscript.json     # Manifest
├── sample-data.json        # Sample data for dashboard demo
├── package.json            # Dev server config
└── README.md               # This file
```

---

## Data Format

Sessions are stored in the Google Sheet and served as JSON in this format:

```json
{
  "rubber_sheets": [
    {
      "id": "rs-001",
      "name": "Tenergy 05",
      "installed_date": "2026-03-20",
      "replaced_date": null
    }
  ],
  "blades": [
    {
      "id": "b-001",
      "name": "Butterfly Viscaria",
      "installed_date": "2026-03-20",
      "replaced_date": null
    }
  ],
  "sessions": [
    {
      "date": "2026-06-20",
      "activity_type": "table_tennis",
      "duration_minutes": 74,
      "source": "Google Health / Fitbit",
      "synced_at": "2026-06-21T06:00:00Z"
    }
  ]
}
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Authorization required" error in Apps Script | Run `showAuthUrl()` and complete the OAuth flow |
| No sessions syncing | Check that your Fitbit detects "table tennis" (not generic "workout"). Check the Logs tab. |
| Dashboard shows "Failed to load data" | Verify the Apps Script web app URL is correct and deployed |
| Duplicate sessions after re-running sync | The sync agent deduplicates automatically — this shouldn't happen. Check the Logs tab. |

---

## Notes

- **Google Fit REST API** is deprecated and will shut down end of 2026. The sync agent is designed to be updated to the Google Health API when it's fully available.
- The sync agent only logs **table tennis** sessions — all other activities are filtered out.
- The analysis engine never fabricates data or estimates rubber lifespan — it only reports what the data shows.
