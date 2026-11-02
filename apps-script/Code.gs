// Copies participant visit staffing from the Lifespan Cognition Lab Schedule into a "Lab Staffing" Google Calendar.
// Run setUp() once from the Apps Script editor: it syncs straight away and then every hour.
//
// The staffing rules aren't copied here. They're loaded from the published site's scheduling.js on every run,
// so the calendar always matches what the website shows.

const CONFIG = {
  projectId: "lab-schedules",
  siteUrl: "https://dbelkind.github.io/lab-schedules/",
  calendarName: "Lab Staffing",
  daysAhead: 60,
};

const RULE_NAMES = ["appointmentsOn", "evaluateVisitSlot", "normalizeSkills", "isOffHours", "SLOT_TITLES"];

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
        const ready = !result.problems.length;
        const lines = ready ? ["Ready to staff.", ""] : ["Can't be fully staffed:", ...result.problems.map((problem) => `• ${problem}`), ""];
        for (const group of result.groups) {
          const label = group.label.endsWith("Available") ? group.label : `${group.label} Available`;
          lines.push(`${label}: ${group.people.map((person) => person.name).join(", ") || "No one"}`);
        }
        if (kind === "scan" && slot.wandingRequired === false) lines.push("", "Wanding/taping isn't required for this visit.");
        if (kind === "scan" && rules.isOffHours(iso, slot.start, slot.end)) {
          lines.push("", "Outside regular hours, so someone with Level 2 Scanning is required.");
        }
        lines.push("", `Change visits at ${CONFIG.siteUrl}`);
        events.push({
          key: `${appointment.id || `default-${iso}`}:${kind}`,
          title: `${ready ? "✅" : "⚠️"} ${rules.SLOT_TITLES[kind]}${ready ? "" : " (can't fully staff)"}`,
          description: lines.join("\n"),
          start: dateAt(iso, slot.start),
          end: dateAt(iso, slot.end),
          color: ready ? CalendarApp.EventColor.GREEN : CalendarApp.EventColor.RED,
        });
      }
    }
  }
  return events;
}

// --- Writing the calendar ---

function staffingCalendar() {
  const properties = PropertiesService.getScriptProperties();
  const savedId = properties.getProperty("calendarId");
  const existing = savedId && CalendarApp.getCalendarById(savedId);
  if (existing) return existing;
  const calendar = CalendarApp.createCalendar(CONFIG.calendarName, {
    summary: "Who's available for participant visits. Filled in automatically every hour from the Lifespan Cognition Lab Schedule.",
  });
  properties.setProperty("calendarId", calendar.getId());
  return calendar;
}

function signatureOf(event) {
  const text = JSON.stringify([event.title, event.description, event.start.getTime(), event.end.getTime(), event.color]);
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8));
}

// Only events whose staffing actually changed are rewritten, so hourly runs stay well inside Google's limits.
function writeCalendar(wanted, today) {
  const calendar = staffingCalendar();
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const windowEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + CONFIG.daysAhead);
  const existing = new Map();
  const changes = { created: 0, updated: 0, deleted: 0 };

  for (const event of calendar.getEvents(windowStart, windowEnd)) {
    const key = event.getTag("labKey");
    if (!key) continue;
    if (existing.has(key)) {
      event.deleteEvent();
      changes.deleted++;
    } else {
      existing.set(key, event);
    }
  }

  for (const item of wanted) {
    const signature = signatureOf(item);
    const event = existing.get(item.key);
    existing.delete(item.key);
    if (event && event.getTag("labSignature") === signature) continue;
    if (event) {
      event.setTitle(item.title);
      event.setTime(item.start, item.end);
      event.setDescription(item.description);
      event.setColor(item.color);
      event.setTag("labSignature", signature);
      changes.updated++;
    } else {
      const created = calendar.createEvent(item.title, item.start, item.end, { description: item.description });
      created.setColor(item.color);
      created.setTag("labKey", item.key);
      created.setTag("labSignature", signature);
      changes.created++;
    }
  }

  // Anything left over is a visit that was cancelled or no longer exists.
  for (const event of existing.values()) {
    event.deleteEvent();
    changes.deleted++;
  }
  return changes;
}
