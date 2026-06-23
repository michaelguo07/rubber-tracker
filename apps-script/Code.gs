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

/** Heart rate data endpoint. */
const HEART_RATE_ENDPOINT = HEALTH_API_BASE + '/users/me/dataTypes/heart-rate/dataPoints';

/** New sheet tab for heart rate data. */
const TAB_HEART_RATE = 'Heart Rate';

/** Default athlete age for HR zone calculation (220 - age = max HR). */
const DEFAULT_ATHLETE_AGE = 18;

/**
 * Heart rate zone definitions (percentage of max HR).
 * Standard 5-zone model used by Fitbit / Google Health.
 */
const HR_ZONES = [
  { zone: 1, name: 'Light',    minPct: 0.50, maxPct: 0.60 },
  { zone: 2, name: 'Moderate', minPct: 0.60, maxPct: 0.70 },
  { zone: 3, name: 'Hard',     minPct: 0.70, maxPct: 0.80 },
  { zone: 4, name: 'Vigorous', minPct: 0.80, maxPct: 0.90 },
  { zone: 5, name: 'Peak',     minPct: 0.90, maxPct: 1.00 },
];

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
    .setScope([
      'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
      'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly'
    ].join(' '))
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
  } else {
    // Check if any headers are missing in the existing tab and append them dynamically
    const lastCol = sheet.getLastColumn();
    if (lastCol > 0) {
      const existingHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
      const missingHeaders = headers.filter(h => existingHeaders.indexOf(h) === -1);
      if (missingHeaders.length > 0) {
        sheet.getRange(1, lastCol + 1, 1, missingHeaders.length)
             .setValues([missingHeaders])
             .setFontWeight('bold');
        Logger.log('Added missing headers to ' + name + ': ' + missingHeaders.join(', '));
      }
    }
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

  ensureTab(ss, TAB_SESSIONS,      ['date', 'activity_type', 'duration_minutes', 'source', 'synced_at', 'calories', 'steps']);
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

  // Heart Rate tab — stores per-session heart rate summaries.
  let hrSheet = ss.getSheetByName(TAB_HEART_RATE);
  if (!hrSheet) {
    hrSheet = ss.insertSheet(TAB_HEART_RATE);
    hrSheet.appendRow([
      'date', 'avg_bpm', 'max_bpm', 'min_bpm',
      'zone1_mins', 'zone2_mins', 'zone3_mins', 'zone4_mins', 'zone5_mins',
      'start_time', 'end_time'
    ]);
    hrSheet.getRange(1, 1, 1, 11).setFontWeight('bold');
    Logger.log('Created tab: ' + TAB_HEART_RATE);
  }

  // Config tab has a special layout: A1 = label, B1 = value.
  let configSheet = ss.getSheetByName(TAB_CONFIG);
  if (!configSheet) {
    configSheet = ss.insertSheet(TAB_CONFIG);
    configSheet.getRange('A1').setValue('last_sync_timestamp');
    // Default: sync from the rubber install date so first run pulls all history.
    configSheet.getRange('B1').setValue('2026-03-20T00:00:00Z');
    configSheet.getRange('A1').setFontWeight('bold');
    // Athlete age for HR zone calculation.
    configSheet.getRange('A2').setValue('athlete_age');
    configSheet.getRange('B2').setValue(DEFAULT_ATHLETE_AGE);
    Logger.log('Created tab: ' + TAB_CONFIG + ' (sync from install date: 2026-03-20)');
  } else {
    // Proactively populate the age key/value if it's missing in an existing tab.
    if (!configSheet.getRange('A2').getValue()) {
      configSheet.getRange('A2').setValue('athlete_age');
      configSheet.getRange('B2').setValue(DEFAULT_ATHLETE_AGE);
    }
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


/**
 * Reads the athlete age from the Config tab (cell B2).
 * Returns DEFAULT_ATHLETE_AGE if missing or invalid.
 *
 * @param  {Spreadsheet} ss
 * @return {number}
 */
function getAthleteAge(ss) {
  const configSheet = getTab(ss, TAB_CONFIG);
  if (!configSheet) return DEFAULT_ATHLETE_AGE;

  const raw = configSheet.getRange('B2').getValue();
  const age = parseInt(raw, 10);
  return (age > 0 && age < 120) ? age : DEFAULT_ATHLETE_AGE;
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

      const metrics = exercise.metricsSummary || {};
      const calories = Number(metrics.caloriesKcal || exercise.caloriesKcal || exercise.calories_kcal || exercise.calories || 0);
      const steps = Number(metrics.steps || exercise.steps || exercise.step_count || 0);

      allSessions.push({
        date:             Utilities.formatDate(startDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
        activity_type:    'table_tennis',
        duration_minutes: durMins,
        source:           'Google Health / Fitbit',
        synced_at:        new Date().toISOString(),
        start_time:       startTimeStr,
        end_time:         endTimeStr,
        calories:         calories,
        steps:            steps
      });
    }

    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  return allSessions;
}


// ─────────────────────────────────────────────────────────────────────────────
//  API FETCH — HEART RATE DATA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches heart rate data points for a specific time window from
 * the Google Health API v4.
 *
 * @param  {OAuth2.Service} service   Authorized OAuth2 service.
 * @param  {string}         startTime ISO 8601 start time of the session.
 * @param  {string}         endTime   ISO 8601 end time of the session.
 * @return {Object[]}       Array of { timestamp, bpm } objects.
 */
function fetchHeartRateDataPoints(service, startTime, endTime) {
  const token = service.getAccessToken();

  // Filter HR data points within the exercise session window.
  // Note: Google Health API v4 represents heart rate as a "Sample" kind,
  // which filters on sample_time.physical_time instead of interval fields.
  const filter = 'heart_rate.sample_time.physical_time >= "' + startTime + '"' +
                 ' AND heart_rate.sample_time.physical_time < "' + endTime + '"';

  const url = HEART_RATE_ENDPOINT
    + '?filter=' + encodeURIComponent(filter)
    + '&pageSize=100';

  const allPoints = [];
  let nextPageToken = null;

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
      Logger.log('Heart rate API returned HTTP ' + code + ': ' +
                 response.getContentText().substring(0, 300));
      return [];   // Return empty — don't block sync for HR failures.
    }

    const data = JSON.parse(response.getContentText());
    const dataPoints = data.dataPoints || [];

    for (const dp of dataPoints) {
      const hr = dp.heartRate || dp.heart_rate;
      if (!hr) continue;

      // Google Health API v4 represents heart rate value using beatsPerMinute
      // and time using sampleTime.physicalTime. We handle multiple cases for resilience.
      const bpm = hr.beatsPerMinute || hr.beats_per_minute || hr.bpm || hr.value;
      const sampleTime = hr.sampleTime || hr.sample_time || {};
      const interval = hr.interval || dp.interval || {};
      const timestamp = sampleTime.physicalTime || sampleTime.physical_time || interval.startTime || interval.start_time || hr.timestamp || '';

      if (bpm && bpm > 0) {
        allPoints.push({ timestamp: timestamp, bpm: Number(bpm) });
      }
    }

    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  return allPoints;
}

/**
 * Computes heart rate summary stats and zone breakdown from raw HR data points.
 *
 * @param  {Object[]} hrPoints   Array of { timestamp, bpm }.
 * @param  {number}   athleteAge Age of the athlete (for max HR calculation).
 * @param  {number}   sessionMins Total session duration in minutes.
 * @return {Object}   { avgBpm, maxBpm, minBpm, zones: { zone1_mins, ..., zone5_mins } }
 */
function computeHRSummary(hrPoints, athleteAge, sessionMins) {
  if (!hrPoints || hrPoints.length === 0) {
    return null;
  }

  const maxHR = 220 - athleteAge;
  const bpmValues = hrPoints.map(p => p.bpm);

  const avgBpm = Math.round(bpmValues.reduce((a, b) => a + b, 0) / bpmValues.length);
  const maxBpm = Math.max(...bpmValues);
  const minBpm = Math.min(...bpmValues);

  // Count data points in each zone, then convert to proportional minutes.
  const zoneCounts = [0, 0, 0, 0, 0];
  const totalPoints = bpmValues.length;

  for (const bpm of bpmValues) {
    const pct = bpm / maxHR;

    if (pct >= 0.85)      zoneCounts[3]++; // Peak (mapped to zone4_mins)
    else if (pct >= 0.70) zoneCounts[2]++; // Vigorous (mapped to zone3_mins)
    else if (pct >= 0.50) zoneCounts[1]++; // Moderate (mapped to zone2_mins)
    else                  zoneCounts[0]++; // Light (mapped to zone1_mins)
  }

  // Convert point counts to proportional minutes of the total session.
  const zones = {};
  for (let i = 0; i < 5; i++) {
    const proportion = totalPoints > 0 ? zoneCounts[i] / totalPoints : 0;
    zones['zone' + (i + 1) + '_mins'] = Math.round(proportion * sessionMins);
  }

  return { avgBpm, maxBpm, minBpm, zones };
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
      s.synced_at,
      s.calories || 0,
      s.steps || 0
    ]);

    sessionsSheet.getRange(
      sessionsSheet.getLastRow() + 1,
      1,
      rows.length,
      rows[0].length
    ).setValues(rows);

    // ── Step 7b: Fetch heart rate data for new sessions ───────────────────
    const hrSheet = getTab(ss, TAB_HEART_RATE);
    if (hrSheet) {
      const athleteAge = getAthleteAge(ss);
      let hrCount = 0;

      for (const session of newSessions) {
        try {
          const start = session.start_time || (session.date + 'T00:00:00Z');
          const end   = session.end_time || (session.date + 'T23:59:59Z');

          const hrPoints = fetchHeartRateDataPoints(service, start, end);

          if (hrPoints.length === 0) {
            appendLog(ss, 'INFO', 'No HR data found for session on ' + session.date);
            continue;
          }

          const summary = computeHRSummary(hrPoints, athleteAge, session.duration_minutes);

          if (summary) {
            hrSheet.appendRow([
              session.date,
              summary.avgBpm,
              summary.maxBpm,
              summary.minBpm,
              summary.zones.zone1_mins,
              summary.zones.zone2_mins,
              summary.zones.zone3_mins,
              summary.zones.zone4_mins,
              summary.zones.zone5_mins,
              start,
              end
            ]);
            hrCount++;
          }
        } catch (hrErr) {
          appendLog(ss, 'WARN', 'HR fetch failed for ' + session.date + ': ' + hrErr.message);
        }
      }

      appendLog(ss, 'INFO', 'Heart rate data written for ' + hrCount + '/' + newSessions.length + ' session(s).');
    }

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
      rubber_sheets:       readTabAsObjects(ss, TAB_RUBBER_SHEETS),
      blades:              readTabAsObjects(ss, TAB_BLADES),
      sessions:            readTabAsObjects(ss, TAB_SESSIONS),
      heart_rate_sessions: readTabAsObjects(ss, TAB_HEART_RATE)
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


/**
 * DEBUG: Fetch and log heart rate data for the most recent day
 * with a table tennis session.
 *
 * Run this from the Apps Script editor to verify HR data access.
 */
function debugHeartRate() {
  const service = getHealthService();

  if (!service.hasAccess()) {
    Logger.log('Not authorized. Run showAuthUrl() to get the auth URL.');
    return;
  }

  const ss = getSpreadsheet();
  const sessionsSheet = getTab(ss, TAB_SESSIONS);

  if (!sessionsSheet || sessionsSheet.getLastRow() < 2) {
    Logger.log('No sessions found. Run syncSessions() first.');
    return;
  }

  // Get the most recent session date.
  const lastRow = sessionsSheet.getLastRow();
  const lastDate = sessionsSheet.getRange(lastRow, 1).getValue();
  let dateStr;
  if (lastDate instanceof Date) {
    dateStr = Utilities.formatDate(lastDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  } else {
    dateStr = String(lastDate);
  }

  Logger.log('Fetching heart rate data for: ' + dateStr);

  const dayStart = dateStr + 'T00:00:00Z';
  const dayEnd   = dateStr + 'T23:59:59Z';

  const hrPoints = fetchHeartRateDataPoints(service, dayStart, dayEnd);

  Logger.log('Total HR data points found: ' + hrPoints.length);

  if (hrPoints.length > 0) {
    // Log first 10 points.
    Logger.log('First 10 data points:');
    hrPoints.slice(0, 10).forEach(function(p, i) {
      Logger.log('  ' + (i + 1) + '. ' + p.timestamp + ' → ' + p.bpm + ' bpm');
    });

    // Compute and log summary.
    const athleteAge = getAthleteAge(ss);
    const sessionDuration = sessionsSheet.getRange(lastRow, 3).getValue();
    const summary = computeHRSummary(hrPoints, athleteAge, sessionDuration);

    Logger.log('\n--- HR Summary ---');
    Logger.log('Avg BPM: ' + summary.avgBpm);
    Logger.log('Max BPM: ' + summary.maxBpm);
    Logger.log('Min BPM: ' + summary.minBpm);
    Logger.log('Zone 1 (Light):    ' + summary.zones.zone1_mins + ' min');
    Logger.log('Zone 2 (Moderate): ' + summary.zones.zone2_mins + ' min');
    Logger.log('Zone 3 (Hard):     ' + summary.zones.zone3_mins + ' min');
    Logger.log('Zone 4 (Vigorous): ' + summary.zones.zone4_mins + ' min');
    Logger.log('Zone 5 (Peak):     ' + summary.zones.zone5_mins + ' min');
    Logger.log('Max HR used: ' + (220 - athleteAge) + ' bpm (age: ' + athleteAge + ')');
  } else {
    Logger.log('No heart rate data found for this day.');
    Logger.log('Make sure a HR-capable device was worn during the session.');
  }
}

/**
 * Backfill heart rate data for all existing sessions that don't
 * already have HR data in the Heart Rate tab.
 */
function backfillHeartRate() {
  const ss = getSpreadsheet();
  const service = getHealthService();

  if (!service.hasAccess()) {
    Logger.log('Not authorized. Run showAuthUrl() to get the auth URL.');
    return;
  }

  const hrSheet = getTab(ss, TAB_HEART_RATE);
  if (!hrSheet) {
    Logger.log('Heart Rate sheet missing. Run setupSheet() first.');
    return;
  }

  // Clear existing HR data below headers to ensure clean, correct backfill.
  const lastRow = hrSheet.getLastRow();
  if (lastRow >= 2) {
    hrSheet.deleteRows(2, lastRow - 1);
    Logger.log('Cleared existing heart rate data.');
  }

  const athleteAge = getAthleteAge(ss);
  const maxHR = 220 - athleteAge;
  Logger.log('Using Athlete Age: ' + athleteAge + ' (Max HR: ' + maxHR + ' bpm)');
  const since = new Date('2026-03-20T00:00:00Z'); // Start from installation date

  Logger.log('Fetching exercise sessions from API...');
  let sessions;
  try {
    sessions = fetchSessionsFromAPI(service, since);
  } catch (err) {
    Logger.log('Failed to fetch sessions: ' + err.message);
    return;
  }

  Logger.log('Found ' + sessions.length + ' session(s). Fetching heart rate data for each...');
  let hrCount = 0;

  for (const session of sessions) {
    try {
      const start = session.start_time;
      const end = session.end_time;
      Logger.log('Fetching HR for ' + session.date + ' (' + start + ' to ' + end + ')...');

      const hrPoints = fetchHeartRateDataPoints(service, start, end);

      if (hrPoints.length === 0) {
        Logger.log('No HR data found for ' + session.date);
        continue;
      }

      const summary = computeHRSummary(hrPoints, athleteAge, session.duration_minutes);

      if (summary) {
        hrSheet.appendRow([
          session.date,
          summary.avgBpm,
          summary.maxBpm,
          summary.minBpm,
          summary.zones.zone1_mins,
          summary.zones.zone2_mins,
          summary.zones.zone3_mins,
          summary.zones.zone4_mins,
          summary.zones.zone5_mins,
          start,
          end
        ]);
        hrCount++;
        Logger.log('Wrote HR summary for ' + session.date + ': Avg=' + summary.avgBpm + ' bpm');
      }
    } catch (err) {
      Logger.log('Error fetching HR for ' + session.date + ': ' + err.message);
    }
  }

  Logger.log('--- Backfill Complete ---');
  Logger.log('HR data written: ' + hrCount);
  appendLog(ss, 'INFO', 'HR backfill complete. ' + hrCount + ' session(s) updated.');
}

/**
 * UTILITY: Clears all synced sessions and resets the Config tab sync timestamp
 * so a full historical re-sync of exercise sessions can be performed.
 *
 * This populates calories and steps for all historical sessions.
 */
function clearAndReSync() {
  const ss = getSpreadsheet();
  
  // Clear Sessions tab (below headers)
  const sessionsSheet = getTab(ss, TAB_SESSIONS);
  if (sessionsSheet && sessionsSheet.getLastRow() >= 2) {
    sessionsSheet.deleteRows(2, sessionsSheet.getLastRow() - 1);
    Logger.log('Cleared Sessions tab.');
  }
  
  // Reset Config tab checkpoint
  setLastSyncTimestamp(ss, new Date('2026-03-20T00:00:00Z'));
  
  Logger.log('Cleared sessions and reset checkpoint. Now run syncSessions() to fetch all sessions.');
}
