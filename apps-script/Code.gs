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
const TAB_PLAYERS       = 'Players';
const TAB_COACHES       = 'Coaches';
const TAB_PARENTS       = 'Parents';

/** Google Health API v4 — exercise data endpoint. */
const HEALTH_API_BASE = 'https://health.googleapis.com/v4';
const EXERCISE_ENDPOINT = HEALTH_API_BASE + '/users/me/dataTypes/exercise/dataPoints';

/** Heart rate data endpoint. */
const HEART_RATE_ENDPOINT = HEALTH_API_BASE + '/users/me/dataTypes/heart-rate/dataPoints';

/** New sheet tab for heart rate data. */
const TAB_HEART_RATE = 'Heart Rate';

/** New sheet tab for coaching feedback. */
const TAB_FEEDBACK = 'Feedback';

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
function upgradeTabWithPlayerId(ss, tabName, defaultPlayerId) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) return;
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (headers.indexOf('player_id') === -1) {
    sheet.insertColumnBefore(1);
    sheet.getRange(1, 1).setValue('player_id');
    sheet.getRange(1, 1).setFontWeight('bold');
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const values = [];
      for (let i = 2; i <= lastRow; i++) {
        values.push([defaultPlayerId]);
      }
      sheet.getRange(2, 1, lastRow - 1, 1).setValues(values);
    }
    Logger.log('Upgraded ' + tabName + ' with player_id first column');
  }
}

function setupSheet() {
  const ss = getSpreadsheet();
  Logger.log('SPREADSHEET DETAILS:');
  Logger.log('  Name: ' + ss.getName());
  Logger.log('  URL: ' + ss.getUrl());
  Logger.log('  ID: ' + ss.getId());

  // Upgrade existing tables if they exist to contain player_id
  upgradeTabWithPlayerId(ss, TAB_SESSIONS, 'player-001');
  upgradeTabWithPlayerId(ss, TAB_RUBBER_SHEETS, 'player-001');
  upgradeTabWithPlayerId(ss, TAB_BLADES, 'player-001');
  upgradeTabWithPlayerId(ss, TAB_HEART_RATE, 'player-001');
  upgradeTabWithPlayerId(ss, TAB_FEEDBACK, 'player-001');

  ensureTab(ss, TAB_SESSIONS,      ['player_id', 'date', 'activity_type', 'duration_minutes', 'source', 'synced_at', 'calories', 'steps']);
  ensureTab(ss, TAB_LOGS,          ['timestamp', 'type', 'message']);

  // Rubber Sheets tab — pre-populate with Dignics 05 (FH) and (BH) if newly created.
  let rubberSheet = ss.getSheetByName(TAB_RUBBER_SHEETS);
  if (!rubberSheet) {
    rubberSheet = ss.insertSheet(TAB_RUBBER_SHEETS);
    rubberSheet.appendRow(['player_id', 'id', 'name', 'installed_date', 'replaced_date']);
    rubberSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    rubberSheet.appendRow(['player-001', 'rs-fh-001', 'Dignics 05 (FH)', '2026-03-20', '']);
    rubberSheet.appendRow(['player-001', 'rs-bh-001', 'Dignics 05 (BH)', '2026-03-20', '']);
    rubberSheet.appendRow(['player-002', 'rs-fh-002', 'Tenergy 05 (FH)', '2026-04-10', '']);
    rubberSheet.appendRow(['player-002', 'rs-bh-002', 'Tenergy 05 (BH)', '2026-04-10', '']);
    Logger.log('Created tab: ' + TAB_RUBBER_SHEETS);
  }

  // Blades tab — pre-populate if newly created.
  let bladesSheet = ss.getSheetByName(TAB_BLADES);
  if (!bladesSheet) {
    bladesSheet = ss.insertSheet(TAB_BLADES);
    bladesSheet.appendRow(['player_id', 'id', 'name', 'installed_date', 'replaced_date']);
    bladesSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    bladesSheet.appendRow(['player-001', 'b-001', 'Butterfly Viscaria', '2026-03-20', '']);
    bladesSheet.appendRow(['player-002', 'b-002', 'Tenergy Blade', '2026-04-10', '']);
    Logger.log('Created tab: ' + TAB_BLADES);
  }

  // Heart Rate tab — stores per-session heart rate summaries.
  let hrSheet = ss.getSheetByName(TAB_HEART_RATE);
  if (!hrSheet) {
    hrSheet = ss.insertSheet(TAB_HEART_RATE);
    hrSheet.appendRow([
      'player_id', 'date', 'avg_bpm', 'max_bpm', 'min_bpm',
      'zone1_mins', 'zone2_mins', 'zone3_mins', 'zone4_mins', 'zone5_mins',
      'start_time', 'end_time'
    ]);
    hrSheet.getRange(1, 1, 1, 12).setFontWeight('bold');
    Logger.log('Created tab: ' + TAB_HEART_RATE);
  }

  // Feedback tab — stores coaching feedback comments and drill breakdown.
  let feedbackSheet = ss.getSheetByName(TAB_FEEDBACK);
  if (!feedbackSheet) {
    feedbackSheet = ss.insertSheet(TAB_FEEDBACK);
    feedbackSheet.appendRow(['player_id', 'session_date', 'session_duration', 'coaches_comments', 'drills']);
    feedbackSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    Logger.log('Created tab: ' + TAB_FEEDBACK);
  }

  // Players tab
  let playersSheet = ss.getSheetByName(TAB_PLAYERS);
  if (!playersSheet) {
    playersSheet = ss.insertSheet(TAB_PLAYERS);
    playersSheet.appendRow(['player_id', 'name', 'email', 'access_code', 'default_lifespan', 'athlete_age']);
    playersSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    playersSheet.appendRow(['player-001', 'Michael Guo', 'michael@ttinsights.com', '1234', '80', '18']);
    playersSheet.appendRow(['player-002', 'Sarah Connor', 'sarah@ttinsights.com', '5678', '100', '25']);
    Logger.log('Created tab: ' + TAB_PLAYERS);
  }

  // Coaches tab
  let coachesSheet = ss.getSheetByName(TAB_COACHES);
  if (!coachesSheet) {
    coachesSheet = ss.insertSheet(TAB_COACHES);
    coachesSheet.appendRow(['coach_id', 'name', 'email', 'access_code']);
    coachesSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    coachesSheet.appendRow(['coach-001', 'Coach Waldner', 'waldner@ttinsights.com', '9999']);
    Logger.log('Created tab: ' + TAB_COACHES);
  }

  // Parents tab
  let parentsSheet = ss.getSheetByName(TAB_PARENTS);
  if (!parentsSheet) {
    parentsSheet = ss.insertSheet(TAB_PARENTS);
    parentsSheet.appendRow(['parent_id', 'name', 'email', 'access_code', 'linked_player_ids']);
    parentsSheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    parentsSheet.appendRow(['parent-001', 'Mr. Guo', 'parent.guo@ttinsights.com', '1111', 'player-001']);
    parentsSheet.appendRow(['parent-002', 'Mrs. Connor', 'parent.connor@ttinsights.com', '2222', 'player-002']);
    parentsSheet.appendRow(['parent-003', 'Super Parent', 'super@ttinsights.com', '3333', 'player-001,player-002']);
    Logger.log('Created tab: ' + TAB_PARENTS);
  }

  // Config tab has a special layout: A1 = label, B1 = value.
  let configSheet = ss.getSheetByName(TAB_CONFIG);
  if (!configSheet) {
    configSheet = ss.insertSheet(TAB_CONFIG);
    configSheet.getRange('A1').setValue('last_sync_timestamp');
    configSheet.getRange('B1').setValue('2026-03-20T00:00:00Z');
    configSheet.getRange('A1').setFontWeight('bold');
    configSheet.getRange('A2').setValue('athlete_age');
    configSheet.getRange('B2').setValue(DEFAULT_ATHLETE_AGE);
    Logger.log('Created tab: ' + TAB_CONFIG);
  } else {
    if (!configSheet.getRange('A2').getValue()) {
      configSheet.getRange('A2').setValue('athlete_age');
      configSheet.getRange('B2').setValue(DEFAULT_ATHLETE_AGE);
    }
  }

  Logger.log('Sheet setup complete.');
}

function seedSarahConnorData() {
  const ss = getSpreadsheet();
  Logger.log('Seeding Sarah Connor (player-002) sample data...');

  // Ensure Sessions tab exists
  let sessionsSheet = ss.getSheetByName(TAB_SESSIONS);
  if (sessionsSheet) {
    const data = readTabAsObjects(ss, TAB_SESSIONS);
    const hasSarah = data.some(row => row.player_id === 'player-002');
    if (!hasSarah) {
      sessionsSheet.appendRow(['player-002', '2026-04-12', 'table_tennis', 60, 'Google Health / Fitbit', '2026-04-13T03:00:00Z', 450, 5000]);
      sessionsSheet.appendRow(['player-002', '2026-04-15', 'table_tennis', 75, 'Google Health / Fitbit', '2026-04-16T03:00:00Z', 550, 6200]);
      sessionsSheet.appendRow(['player-002', '2026-04-18', 'table_tennis', 90, 'Google Health / Fitbit', '2026-04-19T03:00:00Z', 650, 7500]);
      Logger.log('Added 3 sample sessions for Sarah Connor.');
    } else {
      Logger.log('Sarah Connor already has sessions. Skipped.');
    }
  }

  // Ensure Heart Rate tab exists
  let hrSheet = ss.getSheetByName(TAB_HEART_RATE);
  if (hrSheet) {
    const data = readTabAsObjects(ss, TAB_HEART_RATE);
    const hasSarah = data.some(row => row.player_id === 'player-002');
    if (!hasSarah) {
      hrSheet.appendRow(['player-002', '2026-04-12', 132, 168, 80, 10, 20, 20, 8, 2, '2026-04-12T15:00:00Z', '2026-04-12T16:00:00Z']);
      hrSheet.appendRow(['player-002', '2026-04-15', 138, 174, 84, 12, 25, 25, 10, 3, '2026-04-15T16:30:00Z', '2026-04-15T17:45:00Z']);
      hrSheet.appendRow(['player-002', '2026-04-18', 142, 180, 88, 15, 25, 30, 15, 5, '2026-04-18T14:00:00Z', '2026-04-18T15:30:00Z']);
      Logger.log('Added 3 sample heart rate sessions for Sarah Connor.');
    } else {
      Logger.log('Sarah Connor already has heart rate data. Skipped.');
    }
  }

  // Ensure Feedback tab exists
  let feedbackSheet = ss.getSheetByName(TAB_FEEDBACK);
  if (feedbackSheet) {
    const data = readTabAsObjects(ss, TAB_FEEDBACK);
    const hasSarah = data.some(row => row.player_id === 'player-002');
    if (!hasSarah) {
      feedbackSheet.appendRow([
        'player-002', '2026-04-18', 90, 
        'Sarah showed excellent looping consistency from mid-distance today. Focus was on backhand transitions and keeping a low center of gravity during side movements.',
        '[{"name":"Warmup","duration":15},{"name":"Loop Transition","duration":45},{"name":"Footwork","duration":30}]'
      ]);
      feedbackSheet.appendRow([
        'player-002', '2026-04-15', 75, 
        'Great effort on multi-ball drills. We worked on backhand counter-attacks and blocking heavy topspin loops.',
        '[{"name":"Warmup","duration":15},{"name":"Counter-attack","duration":35},{"name":"Match Play","duration":25}]'
      ]);
      Logger.log('Added 2 sample feedback comments/drills for Sarah Connor.');
    } else {
      Logger.log('Sarah Connor already has feedback. Skipped.');
    }
  }

  // Ensure Rubber Sheets tab exists and has Sarah Connor (player-002) data
  let rubberSheet = ss.getSheetByName(TAB_RUBBER_SHEETS);
  if (rubberSheet) {
    const data = readTabAsObjects(ss, TAB_RUBBER_SHEETS);
    const hasSarah = data.some(row => row.player_id === 'player-002');
    if (!hasSarah) {
      rubberSheet.appendRow(['player-002', 'rs-fh-002', 'Tenergy 05 (FH)', '2026-04-10', '']);
      rubberSheet.appendRow(['player-002', 'rs-bh-002', 'Tenergy 05 (BH)', '2026-04-10', '']);
      Logger.log('Added 2 sample rubber sheets for Sarah Connor.');
    } else {
      Logger.log('Sarah Connor already has rubber sheets. Skipped.');
    }
  }

  // Ensure Blades tab exists and has Sarah Connor (player-002) data
  let bladesSheet = ss.getSheetByName(TAB_BLADES);
  if (bladesSheet) {
    const data = readTabAsObjects(ss, TAB_BLADES);
    const hasSarah = data.some(row => row.player_id === 'player-002');
    if (!hasSarah) {
      bladesSheet.appendRow(['player-002', 'b-002', 'Tenergy Blade', '2026-04-10', '']);
      Logger.log('Added sample blade for Sarah Connor.');
    } else {
      Logger.log('Sarah Connor already has blades. Skipped.');
    }
  }

  Logger.log('Sarah Connor seeding completed.');
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
  const playersSheet = ss.getSheetByName(TAB_PLAYERS);
  if (playersSheet) {
    const players = readTabAsObjects(ss, TAB_PLAYERS);
    const primary = players.find(p => p.player_id === 'player-001');
    if (primary && primary.athlete_age) {
      const age = parseInt(primary.athlete_age, 10);
      if (age > 0 && age < 120) return age;
    }
  }
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
function fetchSessionsFromAPI(service, since, timeZone) {
  const token = service.getAccessToken();
  const tz = timeZone || Session.getScriptTimeZone();

  // Build filter using civil_start_time (required for exercise data type).
  // Format: ISO 8601 date string YYYY-MM-DD
  const sinceDate = Utilities.formatDate(since, tz, 'yyyy-MM-dd');
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
        date:             Utilities.formatDate(startDate, tz, 'yyyy-MM-dd'),
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
  const tz = ss.getSpreadsheetTimeZone();
  appendLog(ss, 'INFO', 'Sync started (30-day window).');

  try {
    // ── Step 1: Authenticate ─────────────────────────────────────────────
    const service = getHealthService();
    if (!service.hasAccess()) {
      appendLog(ss, 'ERROR', 'OAuth2 token missing or expired. Run showAuthUrl() to re-authorize.');
      return;
    }

    // ── Step 2: Fetch all sessions from API for the last 30 days ──────────
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let apiSessions;
    try {
      apiSessions = fetchSessionsFromAPI(service, since, tz);
    } catch (apiErr) {
      appendLog(ss, 'ERROR', 'API fetch failed: ' + apiErr.message);
      return;
    }

    appendLog(ss, 'INFO', 'API returned ' + apiSessions.length + ' table tennis session(s) in last 30 days.');

    // Create a lookup set for API sessions: "date|duration"
    const apiKeys = new Set(apiSessions.map(s => s.date + '|' + String(s.duration_minutes)));

    // ── Step 3: Process Sessions tab (clean up deletions & get new keys) ──
    const sessionsSheet = getTab(ss, TAB_SESSIONS);
    if (!sessionsSheet) {
      appendLog(ss, 'ERROR', 'Sessions tab missing. Run setupSheet() first.');
      return;
    }

    const lastRowS = sessionsSheet.getLastRow();
    const headersS = sessionsSheet.getRange(1, 1, 1, sessionsSheet.getLastColumn()).getValues()[0];
    const idxPlayerId = headersS.indexOf('player_id');
    const idxDate = headersS.indexOf('date');
    const idxType = headersS.indexOf('activity_type');
    const idxDuration = headersS.indexOf('duration_minutes');
    const idxSource = headersS.indexOf('source');
    const idxSyncedAt = headersS.indexOf('synced_at');
    const idxCalories = headersS.indexOf('calories');
    const idxSteps = headersS.indexOf('steps');

    const keptSessions = [];
    const deletedSessionDates = new Set();    // For cleaning up HR logs
    const deletedSessionKeys = new Set();     // For cleaning up feedback comments ("date|duration")
    const existingKeys = new Set();

    const cutoffStr = Utilities.formatDate(since, tz, 'yyyy-MM-dd');

    if (lastRowS >= 2) {
      const dataS = sessionsSheet.getRange(2, 1, lastRowS - 1, headersS.length).getValues();
      for (const row of dataS) {
        let rowDate = row[idxDate];
        if (rowDate instanceof Date) {
          rowDate = Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd');
        } else {
          rowDate = String(rowDate);
        }
        const rowDuration = String(row[idxDuration]);
        const rowSource = String(row[idxSource]);
        const key = rowDate + '|' + rowDuration;

        const isWithinWindow = rowDate >= cutoffStr;
        const isFitbit = rowSource === 'Google Health / Fitbit';

        if (isWithinWindow && isFitbit) {
          if (apiKeys.has(key)) {
            // Session still exists in Google Fit, keep it
            keptSessions.push(row);
            existingKeys.add(key);
          } else {
            // Session was deleted in Fitbit! Record key to clean up HR and Comments
            deletedSessionDates.add(rowDate);
            deletedSessionKeys.add(key);
            appendLog(ss, 'INFO', 'Detected deleted session on ' + rowDate + ' (' + rowDuration + ' min). Removing.');
          }
        } else {
          // Keep manual sessions or older historical sessions
          keptSessions.push(row);
          existingKeys.add(key);
        }
      }
    }

    // Filter out API sessions we don't have yet
    const newSessions = apiSessions.filter(s => {
      const key = s.date + '|' + String(s.duration_minutes);
      return !existingKeys.has(key);
    });

    // Append new sessions to kept sessions list
    newSessions.forEach(s => {
      const newRow = new Array(headersS.length);
      if (idxPlayerId !== -1) newRow[idxPlayerId] = 'player-001';
      if (idxDate !== -1) newRow[idxDate] = s.date;
      if (idxType !== -1) newRow[idxType] = s.activity_type;
      if (idxDuration !== -1) newRow[idxDuration] = s.duration_minutes;
      if (idxSource !== -1) newRow[idxSource] = s.source;
      if (idxSyncedAt !== -1) newRow[idxSyncedAt] = s.synced_at;
      if (idxCalories !== -1) newRow[idxCalories] = s.calories || 0;
      if (idxSteps !== -1) newRow[idxSteps] = s.steps || 0;
      keptSessions.push(newRow);
    });

    // Rewrite Sessions sheet in bulk
    if (lastRowS >= 2) {
      sessionsSheet.getRange(2, 1, lastRowS - 1, headersS.length).clearContent();
    }
    if (keptSessions.length > 0) {
      keptSessions.sort((a, b) => (a[idxDate] < b[idxDate] ? -1 : a[idxDate] > b[idxDate] ? 1 : 0));
      sessionsSheet.getRange(2, 1, keptSessions.length, headersS.length).setValues(keptSessions);
    }

    // ── Step 4: Process Heart Rate tab ───────────────────────────────────
    const hrSheet = getTab(ss, TAB_HEART_RATE);
    if (hrSheet) {
      const lastRowHR = hrSheet.getLastRow();
      const headersHR = hrSheet.getRange(1, 1, 1, hrSheet.getLastColumn()).getValues()[0];
      const idxHrPlayerId = headersHR.indexOf('player_id');
      const idxHrDate = headersHR.indexOf('date');
      const idxHrAvg = headersHR.indexOf('avg_bpm');
      const idxHrMax = headersHR.indexOf('max_bpm');
      const idxHrMin = headersHR.indexOf('min_bpm');
      const idxHrZ1 = headersHR.indexOf('zone1_mins');
      const idxHrZ2 = headersHR.indexOf('zone2_mins');
      const idxHrZ3 = headersHR.indexOf('zone3_mins');
      const idxHrZ4 = headersHR.indexOf('zone4_mins');
      const idxHrZ5 = headersHR.indexOf('zone5_mins');
      const idxHrStart = headersHR.indexOf('start_time');
      const idxHrEnd = headersHR.indexOf('end_time');

      const keptHR = [];

      if (lastRowHR >= 2) {
        const dataHR = hrSheet.getRange(2, 1, lastRowHR - 1, headersHR.length).getValues();
        for (const row of dataHR) {
          let rowDate = row[idxHrDate];
          if (rowDate instanceof Date) {
            rowDate = Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd');
          } else {
            rowDate = String(rowDate);
          }

          // Filter out HR rows for sessions that were deleted
          if (!deletedSessionDates.has(rowDate)) {
            keptHR.push(row);
          } else {
            appendLog(ss, 'INFO', 'Removing heart rate log for deleted session on ' + rowDate);
          }
        }
      }

      // Fetch HR data for newly added sessions
      const athleteAge = getAthleteAge(ss);
      let hrCount = 0;

      for (const session of newSessions) {
        try {
          const start = session.start_time || (session.date + 'T00:00:00Z');
          const end   = session.end_time || (session.date + 'T23:59:59Z');

          const hrPoints = fetchHeartRateDataPoints(service, start, end);

          if (hrPoints.length > 0) {
            const summary = computeHRSummary(hrPoints, athleteAge, session.duration_minutes);
            if (summary) {
              const newHrRow = new Array(headersHR.length);
              if (idxHrPlayerId !== -1) newHrRow[idxHrPlayerId] = 'player-001';
              if (idxHrDate !== -1) newHrRow[idxHrDate] = session.date;
              if (idxHrAvg !== -1) newHrRow[idxHrAvg] = summary.avgBpm;
              if (idxHrMax !== -1) newHrRow[idxHrMax] = summary.maxBpm;
              if (idxHrMin !== -1) newHrRow[idxHrMin] = summary.minBpm;
              if (idxHrZ1 !== -1) newHrRow[idxHrZ1] = summary.zones.zone1_mins;
              if (idxHrZ2 !== -1) newHrRow[idxHrZ2] = summary.zones.zone2_mins;
              if (idxHrZ3 !== -1) newHrRow[idxHrZ3] = summary.zones.zone3_mins;
              if (idxHrZ4 !== -1) newHrRow[idxHrZ4] = summary.zones.zone4_mins;
              if (idxHrZ5 !== -1) newHrRow[idxHrZ5] = summary.zones.zone5_mins;
              if (idxHrStart !== -1) newHrRow[idxHrStart] = start;
              if (idxHrEnd !== -1) newHrRow[idxHrEnd] = end;
              keptHR.push(newHrRow);
              hrCount++;
            }
          }
        } catch (hrErr) {
          appendLog(ss, 'WARN', 'HR fetch failed for ' + session.date + ': ' + hrErr.message);
        }
      }

      // Rewrite Heart Rate sheet in bulk
      if (lastRowHR >= 2) {
        hrSheet.getRange(2, 1, lastRowHR - 1, headersHR.length).clearContent();
      }
      if (keptHR.length > 0) {
        keptHR.sort((a, b) => (a[idxHrDate] < b[idxHrDate] ? -1 : a[idxHrDate] > b[idxHrDate] ? 1 : 0));
        hrSheet.getRange(2, 1, keptHR.length, headersHR.length).setValues(keptHR);
      }

      appendLog(ss, 'INFO', 'Heart rate logs updated. Fetched ' + hrCount + ' new log(s).');
    }

    // ── Step 5: Process Feedback tab (clean up comments for deleted sessions)
    const feedbackSheet = getTab(ss, TAB_FEEDBACK);
    if (feedbackSheet) {
      const lastRowF = feedbackSheet.getLastRow();
      const headersF = feedbackSheet.getRange(1, 1, 1, feedbackSheet.getLastColumn()).getValues()[0];
      const idxFPlayerId = headersF.indexOf('player_id');
      const idxFSessionDate = headersF.indexOf('session_date');
      const idxFSessionDuration = headersF.indexOf('session_duration');
      const idxFComments = headersF.indexOf('coaches_comments');
      const idxFDrills = headersF.indexOf('drills');

      const keptFeedback = [];

      if (lastRowF >= 2) {
        const dataF = feedbackSheet.getRange(2, 1, lastRowF - 1, headersF.length).getValues();
        for (const row of dataF) {
          let rowDate = row[idxFSessionDate];
          if (rowDate instanceof Date) {
            rowDate = Utilities.formatDate(rowDate, tz, 'yyyy-MM-dd');
          } else {
            rowDate = String(rowDate);
          }
          const rowDuration = String(row[idxFSessionDuration]);
          const key = rowDate + '|' + rowDuration;

          // Filter out comments/drills for deleted sessions
          if (!deletedSessionKeys.has(key)) {
            keptFeedback.push(row);
          } else {
            appendLog(ss, 'INFO', 'Removing comments/drills details for deleted session on ' + rowDate);
          }
        }
      }

      // Rewrite Feedback sheet in bulk
      if (lastRowF >= 2) {
        feedbackSheet.getRange(2, 1, lastRowF - 1, headersF.length).clearContent();
      }
      if (keptFeedback.length > 0) {
        keptFeedback.sort((a, b) => (a[idxFSessionDate] < b[idxFSessionDate] ? -1 : a[idxFSessionDate] > b[idxFSessionDate] ? 1 : 0));
        feedbackSheet.getRange(2, 1, keptFeedback.length, headersF.length).setValues(keptFeedback);
      }
    }

    // ── Step 6: Update sync trigger checkpoint ───────────────────────────
    setLastSyncTimestamp(ss, new Date());

    const summary = 'Sync complete. Processed ' + apiSessions.length + ' sessions. Added ' + newSessions.length + ' new session(s).';
    appendLog(ss, 'INFO', summary);
    Logger.log(summary);

  } catch (err) {
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

    // Auto-trigger setupSheet() if Players sheet doesn't exist
    if (!ss.getSheetByName(TAB_PLAYERS)) {
      setupSheet();
    }

    // Helper to read and strip access_code
    function readAndSanitizeTab(tabName, codeField) {
      const list = readTabAsObjects(ss, tabName);
      return list.map(item => {
        if (item.hasOwnProperty(codeField)) {
          delete item[codeField];
        }
        return item;
      });
    }

    const payload = {
      rubber_sheets:       readTabAsObjects(ss, TAB_RUBBER_SHEETS),
      blades:              readTabAsObjects(ss, TAB_BLADES),
      sessions:            readTabAsObjects(ss, TAB_SESSIONS),
      heart_rate_sessions: readTabAsObjects(ss, TAB_HEART_RATE),
      feedback:            readTabAsObjects(ss, TAB_FEEDBACK),
      players:             readAndSanitizeTab(TAB_PLAYERS, 'access_code'),
      coaches:             readAndSanitizeTab(TAB_COACHES, 'access_code'),
      parents:             readAndSanitizeTab(TAB_PARENTS, 'access_code')
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

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];   // Only headers or empty.

  const headers = values[0];
  const data    = values.slice(1);

  return data.map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      let val = row[i];

      // Convert Date objects to ISO strings for JSON transport.
      if (val instanceof Date) {
        val = Utilities.formatDate(val, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
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
    dateStr = Utilities.formatDate(lastDate, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
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

/**
 * Serves POST requests to update coaching comments and training breakdowns.
 *
 * Request body must be a JSON string with format:
 * {
 *   "action": "save_feedback",
 *   "session_date": "YYYY-MM-DD",
 *   "session_duration": 60,
 *   "coaches_comments": "...",
 *   "drills": "JSON_string"
 * }
 */
function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);
    const action = postData.action;

    if (action === 'login') {
      const username = String(postData.username || postData.email || '').trim().toLowerCase();
      const accessCode = String(postData.access_code || '').trim();

      if (!username || !accessCode) {
        throw new Error('Missing username or access_code');
      }

      let ss = getSpreadsheet();
      let foundUser = null;
      let userRole = '';
      let idField = '';

      // 1. Search Players
      const players = readTabAsObjects(ss, TAB_PLAYERS);
      foundUser = players.find(u => {
        const uEmail = String(u.email || '').trim().toLowerCase();
        const uName = String(u.name || '').trim().toLowerCase();
        const uCode = String(u.access_code || '').trim();
        return (uEmail === username || uName === username) && uCode === accessCode;
      });
      if (foundUser) {
        userRole = 'player';
        idField = 'player_id';
      }

      // 2. Search Coaches (if not found in players)
      if (!foundUser) {
        const coaches = readTabAsObjects(ss, TAB_COACHES);
        foundUser = coaches.find(u => {
          const uEmail = String(u.email || '').trim().toLowerCase();
          const uName = String(u.name || '').trim().toLowerCase();
          const uCode = String(u.access_code || '').trim();
          return (uEmail === username || uName === username) && uCode === accessCode;
        });
        if (foundUser) {
          userRole = 'coach';
          idField = 'coach_id';
        }
      }

      // 3. Search Parents (if not found in players or coaches)
      if (!foundUser) {
        const parents = readTabAsObjects(ss, TAB_PARENTS);
        foundUser = parents.find(u => {
          const uEmail = String(u.email || '').trim().toLowerCase();
          const uName = String(u.name || '').trim().toLowerCase();
          const uCode = String(u.access_code || '').trim();
          return (uEmail === username || uName === username) && uCode === accessCode;
        });
        if (foundUser) {
          userRole = 'parent';
          idField = 'parent_id';
        }
      }

      if (!foundUser) {
        return ContentService
          .createTextOutput(JSON.stringify({ success: false, message: 'Invalid name or access code.' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      // Construct safe user object
      const userObj = {
        id: foundUser[idField],
        name: foundUser.name,
        email: foundUser.email,
        role: userRole
      };

      if (userRole === 'player') {
        userObj.default_lifespan = foundUser.default_lifespan;
        userObj.athlete_age = foundUser.athlete_age;
      } else if (userRole === 'parent') {
        userObj.linked_player_ids = foundUser.linked_player_ids;
      }

      return ContentService
        .createTextOutput(JSON.stringify({ success: true, user: userObj }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action !== 'save_feedback') {
      throw new Error('Unsupported action: ' + action);
    }

    const playerId = postData.player_id || 'player-001';
    const sessionDate = postData.session_date;
    const sessionDuration = parseInt(postData.session_duration, 10);
    const coachesComments = postData.coaches_comments || '';
    const drills = postData.drills || '[]';

    if (!sessionDate || isNaN(sessionDuration)) {
      throw new Error('Missing session_date or session_duration');
    }

    let ss = getSpreadsheet();
    let sheet = ss.getSheetByName(TAB_FEEDBACK);
    if (!sheet) {
      sheet = ss.insertSheet(TAB_FEEDBACK);
      sheet.appendRow(['player_id', 'session_date', 'session_duration', 'coaches_comments', 'drills']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    const lastRow = sheet.getLastRow();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idxPlayerId = headers.indexOf('player_id');
    const idxSessionDate = headers.indexOf('session_date');
    const idxSessionDuration = headers.indexOf('session_duration');
    const idxCoachesComments = headers.indexOf('coaches_comments');
    const idxDrills = headers.indexOf('drills');

    let foundRowIndex = -1;

    if (lastRow >= 2) {
      const data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rowPlayer = String(row[idxPlayerId]);
        let rowDate = row[idxSessionDate];
        if (rowDate instanceof Date) {
          rowDate = Utilities.formatDate(rowDate, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
        } else {
          rowDate = String(rowDate);
        }
        const rowDuration = parseInt(row[idxSessionDuration], 10);

        if (rowPlayer === playerId && rowDate === sessionDate && rowDuration === sessionDuration) {
          foundRowIndex = i + 2;
          break;
        }
      }
    }

    if (foundRowIndex !== -1) {
      // Update existing row
      sheet.getRange(foundRowIndex, idxCoachesComments + 1).setValue(coachesComments);
      sheet.getRange(foundRowIndex, idxDrills + 1).setValue(drills);
    } else {
      // Append new row in order of headers
      const newRow = new Array(headers.length);
      if (idxPlayerId !== -1) newRow[idxPlayerId] = playerId;
      if (idxSessionDate !== -1) newRow[idxSessionDate] = sessionDate;
      if (idxSessionDuration !== -1) newRow[idxSessionDuration] = sessionDuration;
      if (idxCoachesComments !== -1) newRow[idxCoachesComments] = coachesComments;
      if (idxDrills !== -1) newRow[idxDrills] = drills;
      sheet.appendRow(newRow);
    }

    const payload = {
      success: true,
      message: 'Feedback saved successfully.'
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
