/**
 * ============================================================================
 *  RUBBER TRACKER — Nightly Table Tennis Session Sync Agent
 * ============================================================================
 *
 *  PURPOSE
 *  -------
 *  Pulls table tennis activity sessions from the Google Fit REST API (with
 *  future-proof scaffolding for the Google Health API) and stores them in a
 *  Google Sheet. A companion web endpoint (doGet) serves the data as JSON so
 *  the Rubber Tracker dashboard can consume it.
 *
 *  ARCHITECTURE
 *  ------------
 *  ┌──────────────┐  nightly trigger   ┌───────────────┐
 *  │  Google Fit   │ ◄──────────────── │ syncSessions() │
 *  │  REST API     │ ──── sessions ──► │                │
 *  └──────────────┘                    │  Google Sheet  │
 *                                      │  (4 tabs)      │
 *  ┌──────────────┐  HTTP GET          │                │
 *  │  Dashboard    │ ◄──── JSON ────── │  doGet()       │
 *  └──────────────┘                    └───────────────┘
 *
 *  GOOGLE SHEET TABS
 *  -----------------
 *  1. Sessions       — A:date | B:activity_type | C:duration_minutes |
 *                       D:source | E:synced_at
 *  2. Rubber Sheets  — A:id | B:name | C:installed_date | D:replaced_date
 *  3. Config         — A1:"last_sync_timestamp" | B1:<ISO datetime>
 *  4. Logs           — A:timestamp | B:type | C:message
 *
 *  SETUP STEPS (one-time)
 *  ----------------------
 *  1.  Create a Google Cloud project and enable the Fitness API.
 *  2.  Create OAuth 2.0 credentials (Web Application type).
 *      - Authorized redirect URI:
 *        https://script.google.com/macros/d/{SCRIPT_ID}/usercallback
 *  3.  In the Apps Script editor → Project Settings → Script Properties, set:
 *        CLIENT_ID       = <your OAuth client ID>
 *        CLIENT_SECRET   = <your OAuth client secret>
 *        SPREADSHEET_ID  = <the ID of your Google Sheet>
 *  4.  Run `setupSheet()` to create tabs and headers.
 *  5.  Run `showAuthUrl()` and open the logged URL to authorize.
 *  6.  Run `createDailyTrigger()` to schedule the nightly sync.
 *  7.  Optionally deploy as web app to enable the doGet JSON endpoint.
 *
 *  IMPORTANT NOTES
 *  ---------------
 *  - The Google Fit REST API is still functional as of 2026 and is used as
 *    the primary data source. When the Google Health API offers a stable
 *    sessions endpoint, swap the fetch logic inside `fetchSessionsFromAPI()`.
 *  - This script never logs tokens, secrets, or credentials.
 *  - `syncSessions()` is idempotent — safe to re-run at any time.
 *
 * ============================================================================
 */


// ─────────────────────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Tab names inside the spreadsheet. */
const TAB_SESSIONS      = 'Sessions';
const TAB_RUBBER_SHEETS = 'Rubber Sheets';
const TAB_BLADES        = 'Blades';
const TAB_CONFIG        = 'Config';
const TAB_LOGS          = 'Logs';

/** Google Health API v4 — exercise data endpoint. */
const HEALTH_API_BASE = 'https://health.googleapis.com/v4';
const EXERCISE_ENDPOINT = HEALTH_API_BASE + '/users/me/dataTypes/exercise/dataPoints';

/**
 * Exercise type strings for table tennis in Google Health API.
 * Fitbit reports: "TABLE_TENNIS" (uppercase).
 * We check multiple variants for safety.
 */
const TABLE_TENNIS_TYPES = ['TABLE_TENNIS', 'PING_PONG'];

/** OAuth2 callback function name — must match the function exported below. */
const OAUTH_CALLBACK_NAME = 'authCallback';


// ─────────────────────────────────────────────────────────────────────────────
//  OAUTH2 AUTHENTICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds and returns the OAuth2 service for the Google Fitness API.
 *
 * Credentials are read from Script Properties (never hardcoded).
 * The OAuth2 library caches tokens in the user's Properties Service
 * and handles refresh automatically.
 *
 * @return {OAuth2.Service} Configured OAuth2 service.
 */
function getHealthService() {
  const props = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('CLIENT_ID');
  const clientSecret = props.getProperty('CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing CLIENT_ID or CLIENT_SECRET in Script Properties. ' +
      'Set them via Project Settings → Script Properties.'
    );
  }

  return OAuth2.createService('healthService')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/v2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(clientId)
    .setClientSecret(clientSecret)
    .setCallbackFunction(OAUTH_CALLBACK_NAME)
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly')
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent');   // Force refresh token on first auth
}

/**
 * OAuth2 callback handler — called automatically by the OAuth2 library
 * after the user authorises the app.
 *
 * @param {Object} request  The callback request object.
 * @return {HtmlOutput}     Success / failure HTML page.
 */
function authCallback(request) {
  const service = getHealthService();
  const authorized = service.handleCallback(request);

  if (authorized) {
    return HtmlService.createHtmlOutput(
      '<h2>✅ Authorization successful!</h2>' +
      '<p>You can close this tab and return to the Apps Script editor.</p>'
    );
  }

  return HtmlService.createHtmlOutput(
    '<h2>❌ Authorization denied.</h2>' +
    '<p>Please try again or check your OAuth credentials.</p>'
  );
}

/**
 * Run this function ONCE from the Apps Script editor to get the
 * authorization URL. Open the URL in your browser to grant access.
 */
function showAuthUrl() {
  const service = getHealthService();

  if (service.hasAccess()) {
    Logger.log('Already authorized — no action needed.');
    return;
  }

  const authUrl = service.getAuthorizationUrl();
  Logger.log('Open this URL to authorize:\n' + authUrl);
}


// ─────────────────────────────────────────────────────────────────────────────
//  SPREADSHEET HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the target Spreadsheet.
 *
 * If the script is container-bound it uses the active spreadsheet.
 * Otherwise it reads SPREADSHEET_ID from Script Properties.
 *
 * @return {Spreadsheet}
 */
function getSpreadsheet() {
  // Try container-bound first.
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) {
    throw new Error(
      'SPREADSHEET_ID not set in Script Properties and script is not container-bound.'
    );
  }
  return SpreadsheetApp.openById(id);
}

/**
 * Returns a sheet by name, or null if it doesn't exist.
 *
 * @param  {Spreadsheet} ss   The spreadsheet instance.
 * @param  {string}      name Tab name.
 * @return {Sheet|null}
 */
function getTab(ss, name) {
  return ss.getSheetByName(name);
}

/**
 * Ensures a tab exists with the given headers. Creates it if missing.
 *
 * @param {Spreadsheet} ss      The spreadsheet.
 * @param {string}      name    Tab name.
 * @param {string[]}    headers Column headers for row 1.
 * @return {Sheet}
 */
function ensureTab(ss, name, headers) {
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    Logger.log('Created tab: ' + name);
  }

  return sheet;
}


// ─────────────────────────────────────────────────────────────────────────────
//  SETUP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the required tabs and headers if they don't already exist.
 * Pre-populates Rubber Sheets with Dignics 05 (FH) and (BH).
 * Safe to run multiple times.
 */
function setupSheet() {
  const ss = getSpreadsheet();

  ensureTab(ss, TAB_SESSIONS,      ['date', 'activity_type', 'duration_minutes', 'source', 'synced_at']);
  ensureTab(ss, TAB_LOGS,          ['timestamp', 'type', 'message']);

  // Rubber Sheets tab — pre-populate with Dignics 05 (FH) and (BH) if newly created.
  let rubberSheet = ss.getSheetByName(TAB_RUBBER_SHEETS);
  if (!rubberSheet) {
    rubberSheet = ss.insertSheet(TAB_RUBBER_SHEETS);
    rubberSheet.appendRow(['id', 'name', 'installed_date', 'replaced_date']);
    rubberSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    rubberSheet.appendRow(['rs-fh-001', 'Dignics 05 (FH)', '2026-03-20', '']);
    rubberSheet.appendRow(['rs-bh-001', 'Dignics 05 (BH)', '2026-03-20', '']);
    Logger.log('Created tab: ' + TAB_RUBBER_SHEETS + ' with Dignics 05 (FH) and (BH)');
  }

  // Blades tab — pre-populate with Butterfly Viscaria if newly created.
  let bladesSheet = ss.getSheetByName(TAB_BLADES);
  if (!bladesSheet) {
    bladesSheet = ss.insertSheet(TAB_BLADES);
    bladesSheet.appendRow(['id', 'name', 'installed_date', 'replaced_date']);
    bladesSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    bladesSheet.appendRow(['b-001', 'Butterfly Viscaria', '2026-03-20', '']);
    Logger.log('Created tab: ' + TAB_BLADES + ' with Butterfly Viscaria');
  }

  // Config tab has a special layout: A1 = label, B1 = value.
  let configSheet = ss.getSheetByName(TAB_CONFIG);
  if (!configSheet) {
    configSheet = ss.insertSheet(TAB_CONFIG);
    configSheet.getRange('A1').setValue('last_sync_timestamp');
    // Default: sync from the rubber install date so first run pulls all history.
    configSheet.getRange('B1').setValue('2026-03-20T00:00:00Z');
    configSheet.getRange('A1').setFontWeight('bold');
    Logger.log('Created tab: ' + TAB_CONFIG + ' (sync from install date: 2026-03-20)');
  }

  Logger.log('Sheet setup complete.');
}


// ─────────────────────────────────────────────────────────────────────────────
//  TRIGGER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a time-driven trigger that runs `syncSessions` daily
 * between 2:00 AM and 3:00 AM (in the script's timezone).
 */
function createDailyTrigger() {
  // Avoid duplicates — delete existing triggers for syncSessions first.
  deleteTriggers();

  ScriptApp.newTrigger('syncSessions')
    .timeBased()
    .everyDays(1)
    .atHour(2)                   // Between 2:00 – 3:00 AM
    .create();

  Logger.log('Daily trigger created: syncSessions will run between 2–3 AM.');
}

/**
 * Deletes ALL triggers associated with this project.
 * Useful for cleanup or before re-creating triggers.
 */
function deleteTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  if (triggers.length > 0) {
    Logger.log('Deleted ' + triggers.length + ' trigger(s).');
  } else {
    Logger.log('No triggers to delete.');
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appends a log entry to the Logs tab.
 *
 * @param {Spreadsheet} ss      The spreadsheet.
 * @param {string}      type    Log level: INFO | WARN | ERROR
 * @param {string}      message Human-readable message.
 */
function appendLog(ss, type, message) {
  const logsSheet = getTab(ss, TAB_LOGS);
  if (!logsSheet) {
    Logger.log('[' + type + '] ' + message);
    return;
  }

  logsSheet.appendRow([
    new Date().toISOString(),
    type,
    message
  ]);
}


// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the last sync timestamp from the Config tab (cell B1).
 * Returns a Date object. If missing/invalid, returns 30 days ago.
 *
 * @param  {Spreadsheet} ss
 * @return {Date}
 */
function getLastSyncTimestamp(ss) {
  const configSheet = getTab(ss, TAB_CONFIG);

  if (!configSheet) {
    Logger.log('Config tab missing — defaulting to 30 days ago.');
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  }

  const raw = configSheet.getRange('B1').getValue();

  if (!raw) {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  }

  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) {
    Logger.log('Invalid timestamp in Config B1 — defaulting to 30 days ago.');
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  }

  return parsed;
}

/**
 * Updates the last sync timestamp in the Config tab (cell B1).
 *
 * @param {Spreadsheet} ss
 * @param {Date}        timestamp
 */
function setLastSyncTimestamp(ss, timestamp) {
  const configSheet = getTab(ss, TAB_CONFIG);

  if (!configSheet) {
    Logger.log('Config tab missing — cannot update checkpoint.');
    return;
  }

  configSheet.getRange('B1').setValue(timestamp.toISOString());
}


// ─────────────────────────────────────────────────────────────────────────────
//  API FETCH — GOOGLE HEALTH API v4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches exercise sessions from the Google Health API v4.
 *
 * Endpoint: GET /v4/users/me/dataTypes/exercise/dataPoints
 * Uses the filter parameter to restrict by start time.
 * Then filters client-side for table tennis exercise type.
 *
 * @param  {OAuth2.Service} service  Authorized OAuth2 service.
 * @param  {Date}           since    Start of the time window (inclusive).
 * @return {Object[]}       Array of normalised session objects.
 */
function fetchSessionsFromAPI(service, since) {
  const token = service.getAccessToken();

  // Build filter using civil_start_time (required for exercise data type).
  // Format: ISO 8601 date string YYYY-MM-DD
  const sinceDate = Utilities.formatDate(since, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const filter = 'exercise.interval.civil_start_time >= "' + sinceDate + '"';

  const url = EXERCISE_ENDPOINT
    + '?filter=' + encodeURIComponent(filter)
    + '&pageSize=25';  // Max page size for exercise data type

  const allSessions = [];
  let nextPageToken = null;

  // Paginate through all results.
  do {
    let fetchUrl = url;
    if (nextPageToken) {
      fetchUrl += '&pageToken=' + encodeURIComponent(nextPageToken);
    }

    const response = UrlFetchApp.fetch(fetchUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();

    if (code !== 200) {
      throw new Error(
        'Google Health API returned HTTP ' + code + ': ' +
        response.getContentText().substring(0, 500)
      );
    }

    const data = JSON.parse(response.getContentText());
    const dataPoints = data.dataPoints || [];

    for (const dp of dataPoints) {
      const exercise = dp.exercise;
      if (!exercise) continue;

      // Check if this is table tennis (API returns "TABLE_TENNIS").
      const exerciseType = exercise.exerciseType || '';
      if (TABLE_TENNIS_TYPES.indexOf(exerciseType) === -1) continue;

      // Extract timing — API uses camelCase: startTime, endTime.
      const interval = exercise.interval || {};
      const startTimeStr = interval.startTime;
      const endTimeStr = interval.endTime;

      if (!startTimeStr || !endTimeStr) continue;

      const startDate = new Date(startTimeStr);

      // Prefer activeDuration (in seconds string like "1486s") for accuracy.
      let durMins;
      if (exercise.activeDuration) {
        const durationSecs = parseInt(exercise.activeDuration.replace('s', ''), 10);
        durMins = Math.round(durationSecs / 60);
      } else {
        const endDate = new Date(endTimeStr);
        durMins = Math.round((endDate - startDate) / 60000);
      }

      if (durMins <= 0) continue;

      allSessions.push({
        date:             Utilities.formatDate(startDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
        activity_type:    'table_tennis',
        duration_minutes: durMins,
        source:           'Google Health / Fitbit',
        synced_at:        new Date().toISOString()
      });
    }

    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  return allSessions;
}


// ─────────────────────────────────────────────────────────────────────────────
//  DEDUPLICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a Set of deduplication keys from the existing Sessions sheet.
 * Key format: "YYYY-MM-DD|<duration_minutes>"
 *
 * @param  {Sheet} sessionsSheet
 * @return {Set<string>}
 */
function getExistingSessionKeys(sessionsSheet) {
  const keys = new Set();
  const lastRow = sessionsSheet.getLastRow();

  // Row 1 = headers, so start from row 2.
  if (lastRow < 2) return keys;

  // Read columns A (date) and C (duration_minutes) in bulk.
  const data = sessionsSheet.getRange(2, 1, lastRow - 1, 3).getValues();

  for (const row of data) {
    const dateVal     = row[0];
    const durationVal = row[2];

    // Normalise the date value — could be a Date object or string.
    let dateStr;
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } else {
      dateStr = String(dateVal);
    }

    keys.add(dateStr + '|' + String(durationVal));
  }

  return keys;
}


// ─────────────────────────────────────────────────────────────────────────────
//  SYNC AGENT — MAIN ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main nightly sync function. Designed to be called by a time-driven trigger.
 *
 * Workflow:
 *   1. Read last sync timestamp from Config.
 *   2. Authenticate via OAuth2 (refresh token flow).
 *   3. Fetch sessions from API since the last sync.
 *   4. Filter to table tennis only (done inside fetchSessionsFromAPI).
 *   5. Deduplicate against existing Sessions sheet rows.
 *   6. Append new sessions.
 *   7. Update the sync checkpoint (only after successful write).
 *   8. Log a run summary.
 *
 * Idempotent — safe to re-run. Will not duplicate rows.
 */
function syncSessions() {
  const ss = getSpreadsheet();

  try {
    // ── Step 1: Read checkpoint ──────────────────────────────────────────
    const since = getLastSyncTimestamp(ss);
    appendLog(ss, 'INFO', 'Sync started. Fetching sessions since ' + since.toISOString());

    // ── Step 2: Authenticate ─────────────────────────────────────────────
    const service = getHealthService();

    if (!service.hasAccess()) {
      appendLog(ss, 'ERROR', 'OAuth2 token missing or expired. Run showAuthUrl() to re-authorize.');
      Logger.log('ERROR: Not authorized. Run showAuthUrl() to get the auth URL.');
      return;
    }

    // ── Step 3 & 4: Fetch + filter ───────────────────────────────────────
    let sessions;
    try {
      sessions = fetchSessionsFromAPI(service, since);
    } catch (apiErr) {
      appendLog(ss, 'ERROR', 'API fetch failed: ' + apiErr.message);
      Logger.log('API error — checkpoint NOT updated. ' + apiErr.message);
      return;   // Exit cleanly, do NOT update checkpoint.
    }

    appendLog(ss, 'INFO', 'API returned ' + sessions.length + ' table tennis session(s).');

    // ── Step 5: Deduplicate ──────────────────────────────────────────────
    const sessionsSheet = getTab(ss, TAB_SESSIONS);

    if (!sessionsSheet) {
      appendLog(ss, 'ERROR', 'Sessions tab missing. Run setupSheet() first.');
      return;
    }

    const existingKeys = getExistingSessionKeys(sessionsSheet);

    const newSessions = sessions.filter(s => {
      const key = s.date + '|' + String(s.duration_minutes);
      return !existingKeys.has(key);
    });

    // ── Step 6: Check for zero new ───────────────────────────────────────
    if (newSessions.length === 0) {
      appendLog(ss, 'INFO', 'No new sessions found. Nothing to write.');
      Logger.log('No new sessions — done.');
      // Still update checkpoint so the next run starts from now.
      setLastSyncTimestamp(ss, new Date());
      return;
    }

    // ── Step 7: Append new sessions ──────────────────────────────────────
    const rows = newSessions.map(s => [
      s.date,
      s.activity_type,
      s.duration_minutes,
      s.source,
      s.synced_at
    ]);

    sessionsSheet.getRange(
      sessionsSheet.getLastRow() + 1,
      1,
      rows.length,
      rows[0].length
    ).setValues(rows);

    // ── Step 8: Update checkpoint ────────────────────────────────────────
    setLastSyncTimestamp(ss, new Date());

    // ── Step 9: Log summary ──────────────────────────────────────────────
    const summary = 'Sync complete. ' + newSessions.length + ' new session(s) written.';
    appendLog(ss, 'INFO', summary);
    Logger.log(summary);

  } catch (err) {
    // Catch-all: log unexpected errors, do NOT update checkpoint.
    appendLog(ss, 'ERROR', 'Unexpected error: ' + err.message);
    Logger.log('FATAL: ' + err.message + '\n' + err.stack);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
//  WEB API ENDPOINT — doGet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serves session and rubber sheet data as JSON for the web dashboard.
 *
 * Usage:
 *   GET https://script.google.com/macros/s/{DEPLOY_ID}/exec
 *   GET ...?sheet_id=<SPREADSHEET_ID>   (optional override)
 *
 * Response format:
 *   {
 *     "rubber_sheets": [ { id, name, installed_date, replaced_date }, ... ],
 *     "sessions":      [ { date, activity_type, duration_minutes, source, synced_at }, ... ]
 *   }
 *
 * @param  {Object} e  Event object with query parameters.
 * @return {TextOutput} JSON response.
 */
function doGet(e) {
  try {
    let ss;

    // Support optional sheet_id parameter for non-bound scripts.
    const sheetId = e && e.parameter && e.parameter.sheet_id;

    if (sheetId) {
      ss = SpreadsheetApp.openById(sheetId);
    } else {
      ss = getSpreadsheet();
    }

    const payload = {
      rubber_sheets: readTabAsObjects(ss, TAB_RUBBER_SHEETS),
      blades:        readTabAsObjects(ss, TAB_BLADES),
      sessions:      readTabAsObjects(ss, TAB_SESSIONS)
    };

    return ContentService
      .createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    const errorPayload = {
      error: true,
      message: err.message
    };

    return ContentService
      .createTextOutput(JSON.stringify(errorPayload))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Reads all rows from a sheet tab and returns them as an array of objects,
 * using row 1 as property names.
 *
 * @param  {Spreadsheet} ss    The spreadsheet.
 * @param  {string}      name  Tab name.
 * @return {Object[]}          Array of row objects.
 */
function readTabAsObjects(ss, name) {
  const sheet = getTab(ss, name);

  if (!sheet) return [];

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2 || lastCol < 1) return [];   // Only headers or empty.

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  return data.map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      let val = row[i];

      // Convert Date objects to ISO strings for JSON transport.
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }

      obj[header] = val;
    });
    return obj;
  });
}


// ─────────────────────────────────────────────────────────────────────────────
//  DEBUG HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DEBUG: Fetch and log ALL exercise sessions from Google Health API v4.
 * Run this to see what exercise types your Fitbit reports.
 */
function debugListSessions() {
  const service = getHealthService();

  if (!service.hasAccess()) {
    Logger.log('Not authorized. Run showAuthUrl() to get the auth URL.');
    return;
  }

  const token = service.getAccessToken();

  // Look back 90 days to find any exercises.
  const since = new Date();
  since.setDate(since.getDate() - 90);

  const filter = 'exercise.interval.start_time >= "' + since.toISOString() + '"';
  const url = EXERCISE_ENDPOINT
    + '?filter=' + encodeURIComponent(filter)
    + '&pageSize=25';

  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });

  Logger.log('HTTP Status: ' + response.getResponseCode());

  if (response.getResponseCode() !== 200) {
    Logger.log('Error response: ' + response.getContentText().substring(0, 1000));
    return;
  }

  const data = JSON.parse(response.getContentText());
  const dataPoints = data.dataPoints || [];

  Logger.log('Total exercise data points found: ' + dataPoints.length);

  // Log the raw JSON of the first 5 data points for inspection.
  dataPoints.slice(0, 5).forEach(function(dp, i) {
    Logger.log('--- Exercise ' + (i + 1) + ' ---');
    Logger.log(JSON.stringify(dp, null, 2));
  });

  if (dataPoints.length === 0) {
    Logger.log('No exercise data points found in the last 90 days.');
    Logger.log('Raw response: ' + response.getContentText().substring(0, 2000));
  }
}
