/**
 * Rubber Sheet Usage Analyzer
 *
 * Pure analysis engine — takes structured session + rubber sheet data
 * and returns key stats, chart data, anomalies, and a human-readable summary.
 */

/**
 * Analyze rubber sheet usage.
 *
 * @param {Object} data - { rubber_sheets: [...], sessions: [...] }
 * @param {string} [rubberSheetId] - ID of the sheet to analyze.
 *   Defaults to the active sheet (replaced_date === null).
 * @returns {Object} Analysis result
 */
export function analyzeRubberUsage(data, rubberSheetId) {
  const { rubber_sheets, sessions } = data;

  // --- Resolve target sheet ---------------------------------------------------
  let sheet;
  if (rubberSheetId) {
    sheet = rubber_sheets.find((s) => s.id === rubberSheetId);
  }
  if (!sheet) {
    sheet = rubber_sheets.find((s) => s.replaced_date === null);
  }
  if (!sheet) {
    sheet = rubber_sheets[rubber_sheets.length - 1];
  }

  const installDate = sheet.installed_date;
  const endDate = sheet.replaced_date || _today();

  // --- Filter sessions --------------------------------------------------------
  const filtered = sessions
    .filter(
      (s) =>
        s.activity_type === "table_tennis" &&
        s.date >= installDate &&
        s.date <= endDate
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // --- Key stats --------------------------------------------------------------
  const totalMinutes = filtered.reduce((sum, s) => sum + s.duration_minutes, 0);
  const totalPlayTime = {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };

  const sessionsLogged = filtered.length;

  const avgSessionMinutes =
    sessionsLogged > 0 ? Math.round(totalMinutes / sessionsLogged) : 0;

  const dateRange = {
    first: filtered.length > 0 ? filtered[0].date : installDate,
    last: filtered.length > 0 ? filtered[filtered.length - 1].date : installDate,
  };

  const daysSinceInstall = _daysBetween(installDate, _today());

  const weeksActive = daysSinceInstall / 7 || 1;
  const sessionsPerWeek = parseFloat((sessionsLogged / weeksActive).toFixed(2));

  const keyStats = {
    totalPlayTime,
    sessionsLogged,
    avgSessionMinutes,
    dateRange,
    daysSinceInstall,
    sessionsPerWeek,
  };

  // --- Chart data -------------------------------------------------------------
  let cumulativeMinutes = 0;
  const cumulative_chart = filtered.map((s) => {
    cumulativeMinutes += s.duration_minutes;
    return {
      date: s.date,
      cumulative_hours: parseFloat((cumulativeMinutes / 60).toFixed(2)),
    };
  });

  const session_chart = filtered.map((s) => ({
    date: s.date,
    duration_minutes: s.duration_minutes,
  }));

  const chartData = { cumulative_chart, session_chart };

  // --- Prior sheet comparison -------------------------------------------------
  let priorSheet = null;
  const sheetIndex = rubber_sheets.findIndex((s) => s.id === sheet.id);
  if (sheetIndex > 0) {
    const prior = rubber_sheets[sheetIndex - 1];
    const priorEnd = prior.replaced_date || _today();
    const priorSessions = sessions.filter(
      (s) =>
        s.activity_type === "table_tennis" &&
        s.date >= prior.installed_date &&
        s.date <= priorEnd
    );
    const priorMinutes = priorSessions.reduce(
      (sum, s) => sum + s.duration_minutes,
      0
    );
    priorSheet = {
      name: prior.name,
      totalHours: parseFloat((priorMinutes / 60).toFixed(2)),
    };
  }

  // --- Anomalies --------------------------------------------------------------
  const anomalies = [];

  filtered.forEach((s) => {
    if (s.duration_minutes > 180) {
      anomalies.push({
        type: "suspicious duration",
        description: `Session lasted ${s.duration_minutes} minutes (over 3 hours)`,
        date: s.date,
      });
    } else if (s.duration_minutes < 5) {
      anomalies.push({
        type: "suspicious duration",
        description: `Session lasted only ${s.duration_minutes} minutes`,
        date: s.date,
      });
    }
  });

  for (let i = 1; i < filtered.length; i++) {
    const gap = _daysBetween(filtered[i - 1].date, filtered[i].date);
    if (gap > 30) {
      anomalies.push({
        type: "long gap",
        description: `${gap}-day gap between sessions (${filtered[i - 1].date} → ${filtered[i].date})`,
        date: filtered[i].date,
      });
    }
  }

  // --- Summary ----------------------------------------------------------------
  const totalHoursDecimal = (totalMinutes / 60).toFixed(1);
  const sheetStatus =
    sheet.replaced_date === null ? "currently in use" : "retired";

  let summary = `The ${sheet.name} rubber sheet has been ${sheetStatus === "currently in use" ? "installed for" : "used for"} ${daysSinceInstall} days${sheetStatus === "currently in use" ? " and is still active" : ` before being replaced on ${sheet.replaced_date}`}. `;
  summary += `Over ${sessionsLogged} logged session${sessionsLogged !== 1 ? "s" : ""}, the sheet has accumulated ${totalHoursDecimal} hours of play time with an average session length of ${avgSessionMinutes} minutes. `;
  summary += `Play frequency averages ${sessionsPerWeek} sessions per week. `;

  if (priorSheet) {
    const diff = parseFloat(totalHoursDecimal) - priorSheet.totalHours;
    if (diff > 0) {
      summary += `Compared to the previous sheet (${priorSheet.name}, ${priorSheet.totalHours} hours), this sheet has already logged ${diff.toFixed(1)} more hours of use.`;
    } else if (diff < 0) {
      summary += `The previous sheet (${priorSheet.name}) accumulated ${priorSheet.totalHours} hours — ${Math.abs(diff).toFixed(1)} hours more than the current sheet so far.`;
    } else {
      summary += `This sheet has matched the previous ${priorSheet.name} at ${priorSheet.totalHours} hours.`;
    }
  }

  // --- Blade tracking ---------------------------------------------------------
  const blades = data.blades || [];
  let bladeStats = null;
  if (blades.length > 0) {
    let activeBlade = blades.find((b) => b.replaced_date === null);
    if (!activeBlade) {
      activeBlade = blades[blades.length - 1];
    }
    
    const bladeInstallDate = activeBlade.installed_date;
    const bladeEndDate = activeBlade.replaced_date || _today();
    
    const bladeSessions = sessions.filter(
      (s) =>
        s.activity_type === "table_tennis" &&
        s.date >= bladeInstallDate &&
        s.date <= bladeEndDate
    );
    
    const bladeMinutes = bladeSessions.reduce((sum, s) => sum + s.duration_minutes, 0);
    const bladeDays = _daysBetween(bladeInstallDate, _today());
    
    bladeStats = {
      name: activeBlade.name,
      totalPlayTime: {
        hours: Math.floor(bladeMinutes / 60),
        minutes: bladeMinutes % 60,
      },
      daysInUse: bladeDays,
      installedDate: bladeInstallDate,
      replacedDate: activeBlade.replaced_date
    };
  }

  return { keyStats, chartData, priorSheet, anomalies, summary, bladeStats };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + "T00:00:00");
  const b = new Date(dateStrB + "T00:00:00");
  return Math.round(Math.abs(b - a) / 86_400_000);
}
