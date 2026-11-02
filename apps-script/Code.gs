// Copies participant visit staffing from the Lifespan Cognition Lab Schedule into a "Lab Staffing" Google Calendar.
// Run setUp() once from the Apps Script editor: it syncs straight away and then every hour.
//
// The staffing rules aren't copied here. They're loaded from the published site's scheduling.js on every run,
// so the calendar always matches what the website shows.
//
// Calendar access uses Google's "calendars created by this app" permission, so the script can only see and change
// the Lab Staffing calendar it makes, never your other calendars.

const CONFIG = {
  projectId: "lab-schedules",
  siteUrl: "https://dbelkind.github.io/lab-schedules/",
  calendarName: "Lab Staffing",
  daysAhead: 60,
  timeZone: "America/Los_Angeles",
};

// Google Calendar's event colors: 10 is green (Basil), 6 is orange (Tangerine) and 11 is red (Tomato).
const COLORS_BY_STATE = { ready: "10", tight: "6", problem: "11" };
const TITLE_MARKS = { ready: ["✅", ""], tight: ["🟠", " (tight timing)"], problem: ["⚠️", " (can't fully staff)"] };

const RULE_NAMES = ["appointmentsOn", "evaluateVisitSlot", "normalizeSkills", "isOffHours", "SLOT_TITLES", "staffingState", "personLabel"];

function setUp() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "syncStaffing") ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("syncStaffing").timeBased().everyHours(1).create();
  syncStaffing();
}

function syncStaffing() {
  const rules = loadRules();
  const academic = fetchJson("data/academic-calendar.json");
  const staff = fetchJson("data/staff-holidays.json");
  const data = {
    members: listCollection("members").map((doc) => ({ email: doc.id, name: doc.name, skills: rules.normalizeSkills(doc.skills) })),
    availability: listCollection("availability"),
    timeOff: listCollection("timeOff"),
    semesters: academic.semesters,
    events: academic.events,
  };
  const today = new Date();
  const wanted = buildStaffingEvents(rules, data, listCollection("appointments"), staff.holidays, today);
  const changes = writeCalendar(wanted, today);
  console.log(`Lab Staffing synced: ${wanted.length} slots, ${changes.created} added, ${changes.updated} updated, ${changes.deleted} removed.`);
}

// --- Reading the website and the database ---

function fetchText(path) {
  const response = UrlFetchApp.fetch(`${CONFIG.siteUrl}${path}?t=${Date.now()}`, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error(`Couldn't load ${CONFIG.siteUrl}${path} (HTTP ${response.getResponseCode()}). Is the site published?`);
  }
  return response.getContentText();
}

function fetchJson(path) {
  return JSON.parse(fetchText(path));
}

function loadRules() {
  const code = fetchText("scheduling.js");
  const rules = new Function(`${code}\nreturn { ${RULE_NAMES.map((name) => `${name}: typeof ${name} === "undefined" ? undefined : ${name}`).join(", ")} };`)();
  const missing = RULE_NAMES.filter((name) => rules[name] === undefined);
  if (missing.length) throw new Error(`The published scheduling.js is out of date (missing ${missing.join(", ")}). Push the latest site to GitHub.`);
  return rules;
}

function decodeValue(value) {
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields)) result[key] = decodeValue(value);
  return result;
}

// Reads with your own Google login, which the database trusts as the project owner, so its privacy rules don't apply here.
function listCollection(name) {
  const documents = [];
  let pageToken = "";
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${CONFIG.projectId}/databases/(default)/documents/${name}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}`, "X-Goog-User-Project": CONFIG.projectId },
    });
    if (response.getResponseCode() !== 200) {
      throw new Error(`Couldn't read ${name} from Firebase (HTTP ${response.getResponseCode()}): ${response.getContentText().slice(0, 300)}`);
    }
    const page = JSON.parse(response.getContentText());
    for (const doc of page.documents || []) {
      documents.push({ id: doc.name.split("/").pop(), ...decodeFields(doc.fields || {}) });
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return documents;
}

// --- Working out the events ---

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateAt(iso, time) {
  const [year, month, day] = iso.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

// Kept free of Google services so it can be tested on its own.
function buildStaffingEvents(rules, data, appointments, holidays, today) {
  const events = [];
  for (let offset = 0; offset < CONFIG.daysAhead; offset++) {
    const iso = isoOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
    for (const appointment of rules.appointmentsOn(iso, appointments, holidays)) {
      for (const kind of ["lab", "scan"]) {
        const slot = appointment[kind];
        if (!slot) continue;
        const result = rules.evaluateVisitSlot(iso, slot, kind, data);
        const state = rules.staffingState(result);
        const lines = state === "problem"
          ? ["Can't be fully staffed:", ...result.problems.map((problem) => `• ${problem}`), ""]
          : state === "tight" ? [`Tight timing: ${result.timing}.`, ""] : ["Ready to staff.", ""];
        for (const group of result.groups) {
          const label = group.label.endsWith("Available") ? group.label : `${group.label} Available`;
          lines.push(`${label}: ${group.people.map(rules.personLabel).join(", ") || "No one"}`);
        }
        if ((result.notes || []).length) lines.push("", ...result.notes.map((note) => `*${note}`));
        if (kind === "scan" && slot.wandingRequired === false) lines.push("", "Wanding/taping isn't required for this visit.");
        if (kind === "scan" && rules.isOffHours(iso, slot.start, slot.end)) {
          lines.push("", "Outside regular hours, so someone with Level 2 Scanning is required.");
        }
        lines.push("", `Change visits at ${CONFIG.siteUrl}`);
        events.push({
          key: `${appointment.id || `default-${iso}`}:${kind}`,
          title: `${TITLE_MARKS[state][0]} ${rules.SLOT_TITLES[kind]}${TITLE_MARKS[state][1]}`,
          description: lines.join("\n"),
          start: dateAt(iso, slot.start),
          end: dateAt(iso, slot.end),
          color: COLORS_BY_STATE[state],
        });
      }
    }
  }
  return events;
}

// --- Writing the calendar ---

function staffingCalendarId() {
  const properties = PropertiesService.getScriptProperties();
  const savedId = properties.getProperty("calendarId");
  if (savedId) {
    try {
      return Calendar.Calendars.get(savedId).id;
    } catch (error) {
      // The calendar was deleted, so make a new one below.
    }
  }
  const calendar = Calendar.Calendars.insert({
    summary: CONFIG.calendarName,
    description: "Who's available for participant visits. Filled in automatically every hour from the Lifespan Cognition Lab Schedule.",
    timeZone: CONFIG.timeZone,
  });
  properties.setProperty("calendarId", calendar.id);
  return calendar.id;
}

function signatureOf(event) {
  const text = JSON.stringify([event.title, event.description, event.start.getTime(), event.end.getTime(), event.color]);
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8));
}

function eventResource(item, signature) {
  return {
    summary: item.title,
    description: item.description,
    start: { dateTime: item.start.toISOString(), timeZone: CONFIG.timeZone },
    end: { dateTime: item.end.toISOString(), timeZone: CONFIG.timeZone },
    colorId: item.color,
    extendedProperties: { private: { labKey: item.key, labSignature: signature } },
  };
}

function listEvents(calendarId, timeMin, timeMax) {
  const events = [];
  let pageToken;
  do {
    const page = Calendar.Events.list(calendarId, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      maxResults: 2500,
      ...(pageToken ? { pageToken } : {}),
    });
    events.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events;
}

// Only events whose staffing actually changed are rewritten, so hourly runs stay well inside Google's limits.
function writeCalendar(wanted, today) {
  const calendarId = staffingCalendarId();
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const windowEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + CONFIG.daysAhead);
  const existing = new Map();
  const changes = { created: 0, updated: 0, deleted: 0 };

  for (const event of listEvents(calendarId, windowStart, windowEnd)) {
    const tags = (event.extendedProperties && event.extendedProperties.private) || {};
    if (!tags.labKey) continue;
    if (existing.has(tags.labKey)) {
      Calendar.Events.remove(calendarId, event.id);
      changes.deleted++;
    } else {
      existing.set(tags.labKey, { id: event.id, signature: tags.labSignature });
    }
  }

  for (const item of wanted) {
    const signature = signatureOf(item);
    const event = existing.get(item.key);
    existing.delete(item.key);
    if (event && event.signature === signature) continue;
    if (event) {
      Calendar.Events.update(eventResource(item, signature), calendarId, event.id);
      changes.updated++;
    } else {
      Calendar.Events.insert(eventResource(item, signature), calendarId);
      changes.created++;
    }
  }

  // Anything left over is a visit that was cancelled or no longer exists.
  for (const event of existing.values()) {
    Calendar.Events.remove(calendarId, event.id);
    changes.deleted++;
  }
  return changes;
}
