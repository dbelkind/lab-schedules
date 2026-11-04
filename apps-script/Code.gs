// Connects the Lifespan Cognition Lab Schedule to Google Calendar and email. It keeps four calendars for lab managers:
// - "LCL Visits": each participant visit, colored by its booking (gray open, blue booked, orange waiting to be
//   rebooked), with who's available for each part. Updated every 10 minutes, and straight away when the site pings it.
// - "LCL Confirmed Visits": each staffed visit, with who's doing what. Updated every 10 minutes.
// - "LCL Unavailability": when each lab member can't be in the lab. Updated every hour.
// - "LCL Birthdays & Graduations": everyone's birthday and expected graduation, for the next year. Updated every hour.
// It also emails reviewers about requests, cancellations, and at 8:30 AM which visit's scan to book and upcoming
// birthdays and graduations, and emails staff about the visits they're staffing.
// Run setUp() once from the Apps Script editor, and again whenever this file changes.
//
// The staffing rules aren't copied here. They're loaded from the published site's scheduling.js on every run,
// so the calendars always match what the website shows.
//
// Calendar access uses Google's "calendars created by this app" permission, so the script can only see and change
// the calendars it makes, never your other calendars. That permission can't share them, so share them by hand.

const CONFIG = {
  projectId: "lab-schedules",
  siteUrl: "https://dbelkind.github.io/lab-schedules/",
  visitsCalendarName: "LCL Visits",
  confirmedCalendarName: "LCL Confirmed Visits",
  unavailabilityCalendarName: "LCL Unavailability",
  celebrationsCalendarName: "LCL Birthdays & Graduations",
  daysAhead: 60,
  timeZone: "America/Los_Angeles",
  // While this is false, assigned staff are only listed in the Confirmed Visits events, not added as guests, and
  // aren't emailed. Only reviewers get emails. Set it to true to add staff as guests and email them about their visits.
  // Google itself never emails guests: the script sends each person their own email instead.
  inviteStaff: false,
  // The site's pings run at most this often, since anyone with the web app's link could call it.
  quickSyncSeconds: 5,
};

// Google Calendar's event colors, which look the same to everyone the calendar is shared with.
// LCL Visits is colored by booking: 8 is gray (Graphite), 9 is blue (Blueberry) and 6 is orange (Tangerine).
// Visits from before booking moved to the website keep the calendar's own color.
const BOOKING_COLORS = { open: "8", booked: "9", rebooking: "6" };
const BOOKING_TITLES = { open: "Open", booked: "Booked", rebooking: "Rebooking" };
const TITLE_MARKS = { ready: "✅", tight: "🟡", problem: "⚠️" };

const RULE_NAMES = [
  "appointmentsOn", "evaluateVisitSlot", "evaluateManagers", "managerCandidates", "normalizeSkills", "isOffHours",
  "SLOT_TITLES", "staffingState", "personLabel", "visitKey", "visitWindow", "unusualTimes", "visitPartsLabel",
  "defaultVisitsThrough", "assignmentLines", "checkAssignment", "BOOKING_STARTS", "clockTime", "wantsEmail", "SEE_TIME",
  "staffRoles", "unavailableOn",
];
// Older trigger names are listed too, so running setUp again clears them away.
const TRIGGERS = ["syncStaffing", "hourlySync", "checkRequests", "frequentChecks", "dailyVisits"];

function setUp() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (TRIGGERS.includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("hourlySync").timeBased().everyHours(1).create();
  ScriptApp.newTrigger("frequentChecks").timeBased().everyMinutes(10).create();
  // Google runs daily triggers within about 15 minutes of the time asked for.
  ScriptApp.newTrigger("dailyVisits").timeBased().everyDays(1).atHour(8).nearMinute(30).inTimezone(CONFIG.timeZone).create();
  hourlySync();
  frequentChecks();
}

// Everything the rules need, read fresh from the site and the database.
function loadSite() {
  const rules = loadRules();
  const academic = fetchJson("data/academic-calendar.json");
  const staff = fetchJson("data/staff-holidays.json");
  const members = listCollection("members");
  return {
    rules,
    members,
    holidays: staff.holidays,
    appointments: listCollection("appointments"),
    data: {
      members: members.map((doc) => ({ email: doc.id, name: doc.name, role: doc.role, skills: rules.normalizeSkills(doc.skills) })),
      availability: listCollection("availability"),
      timeOff: listCollection("timeOff"),
      semesters: academic.semesters,
      events: academic.events,
    },
  };
}

// Runs one sync at a time, so a ping from the site and a timed run never write the same calendar at once.
function withLock(work) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) return false;
  try {
    work();
    return true;
  } finally {
    lock.releaseLock();
  }
}

// Every hour: LCL Unavailability and LCL Birthdays & Graduations.
function hourlySync() {
  withLock(() => {
    const site = loadSite();
    const today = new Date();
    syncUnavailability(site, today);
    syncCelebrations(site, listCollection("profiles"), today);
  });
}

function syncUnavailability(site, today) {
  const wanted = buildUnavailabilityEvents(site.rules, site.data, today);
  const calendarId = calendarIdFor("unavailabilityCalendarId", CONFIG.unavailabilityCalendarName,
    "When each lab member can't be in the lab. Filled in automatically every hour from the Lifespan Cognition Lab Schedule.");
  const changes = writeCalendar(calendarId, wanted, today, CONFIG.daysAhead + 1);
  console.log(`LCL Unavailability synced: ${wanted.length} times, ${changes.created} added, ${changes.updated} updated, ${changes.deleted} removed.`);
}

function syncVisits(site, staffing, today) {
  const wanted = buildVisitEvents(site.rules, site.data, site.appointments, site.holidays, today, staffing);
  const calendarId = calendarIdFor("calendarId", CONFIG.visitsCalendarName,
    "Participant visits: gray when open, blue when booked, orange when a booking was cancelled and it's open to rebook. Says who's available for each part. From the Lifespan Cognition Lab Schedule.");
  const changes = writeCalendar(calendarId, wanted, today, CONFIG.daysAhead + 1);
  console.log(`LCL Visits synced: ${wanted.length} visits, ${changes.created} added, ${changes.updated} updated, ${changes.deleted} removed.`);
}

// Every 10 minutes: emails about requests and cancellations, LCL Visits, LCL Confirmed Visits, and staff emails.
// Staff invites and emails wait for this run, so a mistake fixed within a few minutes never reaches anyone.
function frequentChecks() {
  withLock(() => {
    checkRequests();
    const site = loadSite();
    const staffing = listCollection("staffing");
    const today = new Date();
    checkCancellations(site, staffing, today);
    syncVisits(site, staffing, today);
    syncConfirmed(site, staffing, today);
    notifyStaff(site, staffing, today);
  });
}

// The site pings this web app after a booking, visit or staffing change, so LCL Visits and cancellation emails
// don't wait for the 10-minute run. Staff invites and emails still do. It takes no input and changes nothing on the
// site; anyone with the link could call it, so it runs at most once every few seconds.
function doPost() {
  quickSync();
  return ContentService.createTextOutput("ok");
}

function doGet() {
  return doPost();
}

function quickSync() {
  const cache = CacheService.getScriptCache();
  if (cache.get("quickSync")) return false;
  cache.put("quickSync", "1", CONFIG.quickSyncSeconds);
  return withLock(() => {
    const site = loadSite();
    const staffing = listCollection("staffing");
    const today = new Date();
    checkCancellations(site, staffing, today);
    syncVisits(site, staffing, today);
  });
}

// --- Emailing reviewers ---

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_ABBREVIATIONS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EMAIL_FOOTER = "To choose which emails you get, go to Lab Management → My information on the site.";

function emailDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTH_ABBREVIATIONS[month - 1]} ${day}, ${year}`;
}

function emailDateWithDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${WEEKDAY_ABBREVIATIONS[new Date(year, month - 1, day).getDay()]}, ${emailDate(iso)}`;
}

function emailTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function describeTimeOffForEmail(request) {
  const dates = request.from === request.to ? emailDate(request.from) : `${emailDate(request.from)} – ${emailDate(request.to)}`;
  const hours = request.start ? `, ${emailTime(request.start)} – ${emailTime(request.end)}` : "";
  return `${dates}${hours}${request.note ? ` (${request.note})` : ""}`;
}

function namesList(people) {
  const names = people.map((person) => person.name);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Sends one email to all the reviewers who'd get the same news, rather than one each. Everything comes from the
// account the script runs under, so separate emails would also show up there as copies of each other.
// `kind` is one of the REVIEWER_EMAILS keys, and reviewers who've turned that kind off are left out.
// Items are { id, owner }; nobody is emailed about something they did themselves. `compose` turns a reviewer
// group's items into { subject, lines }.
function emailReviewers(rules, members, kind, items, compose) {
  const reviewers = members.filter((member) => member.role === "reviewer" && rules.wantsEmail(member, kind));
  const groups = new Map();
  for (const reviewer of reviewers) {
    const theirs = items.filter((item) => item.owner !== reviewer.id);
    if (!theirs.length) continue;
    const key = theirs.map((item) => item.id).join("|");
    if (!groups.has(key)) groups.set(key, { reviewers: [], items: theirs });
    groups.get(key).reviewers.push(reviewer);
  }
  for (const group of groups.values()) {
    const { subject, lines } = compose(group.items);
    MailApp.sendEmail({
      to: group.reviewers.map((reviewer) => reviewer.id).join(","),
      subject,
      body: [`Hi ${namesList(group.reviewers)},`, "", ...lines, "", EMAIL_FOOTER].join("\n"),
    });
  }
  return groups.size;
}

// Emails reviewers about requests waiting for review, once per request, and about changes Grad Students/Post-Docs
// have already saved. The first run only notes what's already waiting, so turning this on doesn't send a flood.
function checkRequests() {
  const rules = loadRules();
  const members = listCollection("members");
  const nameOf = (email) => (members.find((member) => member.id === email) || {}).name || email;
  const pending = [
    ...listCollection("timeOff").filter((request) => request.status === "pending").map((request) => ({
      id: `timeOff/${request.id}`,
      owner: request.ownerEmail,
      text: `Time off: ${describeTimeOffForEmail(request)}`,
    })),
    ...listCollection("changeRequests").filter((request) => request.status === "pending").map((request) => ({
      id: `changeRequests/${request.id}`,
      owner: request.ownerEmail,
      text: `Schedule change: ${request.summary}`,
    })),
  ];
  const notices = listCollection("notices").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const properties = PropertiesService.getScriptProperties();
  const saved = properties.getProperty("notifiedRequests");
  const pendingIds = pending.map((request) => request.id);
  if (saved === null) {
    properties.setProperty("notifiedRequests", JSON.stringify(pendingIds));
    for (const notice of notices) deleteDocument(`notices/${notice.id}`);
    console.log(`Request emails turned on. ${pending.length} request(s) and ${notices.length} update(s) already there weren't emailed.`);
    return { emailed: 0, fresh: 0 };
  }

  const notified = new Set(JSON.parse(saved));
  const fresh = pending.filter((request) => !notified.has(request.id));
  // Requests and saved updates are separate kinds of email, so each reviewer gets just the ones they want.
  const updateItems = notices.map((notice) => ({ id: `notices/${notice.id}`, owner: notice.ownerEmail, text: notice.summary }));
  const emailed = emailReviewers(rules, members, "requests", fresh, (requests) => {
    const subject = requests.length === 1
      ? `Lab schedule: ${nameOf(requests[0].owner)} sent a request to review`
      : `Lab schedule: ${requests.length} new requests to review`;
    return {
      subject,
      lines: [
        requests.length === 1 ? "A new request is waiting for review on the Lifespan Cognition Lab Schedule:" : "New requests are waiting for review on the Lifespan Cognition Lab Schedule:",
        "",
        ...requests.map((request) => `• ${nameOf(request.owner)}: ${request.text}`),
        "",
        `Review them here: ${CONFIG.siteUrl}#review`,
      ],
    };
  }) + emailReviewers(rules, members, "updates", updateItems, (updates) => ({
    subject: updates.length === 1 ? `Lab schedule: ${nameOf(updates[0].owner)} updated their schedule` : `Lab schedule: ${updates.length} schedule updates`,
    lines: ["Grad Students/Post-Docs saved these changes (no review needed):", "", ...updates.map((notice) => `• ${nameOf(notice.owner)}: ${notice.text}`)],
  }));
  // Only requests still waiting are remembered, so this list stays small. Notices are done with once emailed.
  properties.setProperty("notifiedRequests", JSON.stringify(pendingIds));
  for (const notice of notices) deleteDocument(`notices/${notice.id}`);
  if (fresh.length || notices.length) console.log(`${fresh.length} new request(s) and ${notices.length} update(s); sent ${emailed} email(s).`);
  return { emailed, fresh: fresh.length };
}

function visitTimesForEmail(rules, appointment) {
  const window = rules.visitWindow(appointment);
  return `${rules.clockTime(window.start)} – ${rules.clockTime(window.end)}`;
}

// Emails lab managers straight away when a booking is cancelled (the visit stays open to rebook, and its staff
// aren't told) or a booked or staffed visit is cancelled (its staff hear from notifyStaff). Bookings themselves
// aren't emailed from here: the booker emails the reviewers from their own account, with the Screener ID.
function checkCancellations(site = loadSite(), staffing = listCollection("staffing"), today = new Date()) {
  const { rules, members, appointments, holidays } = site;
  const todayIso = isoOf(today);
  const staffed = new Set(staffing.map((doc) => doc.visitKey));
  // Upcoming visits that are booked or staffed: the ones whose cancellation matters.
  const current = {};
  const dates = new Set([...appointments.map((appointment) => appointment.date), ...staffing.map((doc) => doc.date)]);
  for (const iso of [...dates].filter((date) => date >= todayIso)) {
    for (const appointment of visitsOn(rules, iso, appointments, holidays)) {
      const key = rules.visitKey(appointment);
      if (!appointment.booking && !staffed.has(key)) continue;
      current[key] = {
        date: iso,
        times: visitTimesForEmail(rules, appointment),
        booking: appointment.booking || "",
        by: appointment.bookedByName || appointment.bookedBy || "",
        owner: appointment.bookedBy || "",
        seeTime: rules.unusualTimes(appointment).length > 0,
      };
    }
  }
  const properties = PropertiesService.getScriptProperties();
  const saved = properties.getProperty("watchedVisits");
  properties.setProperty("watchedVisits", JSON.stringify(current));
  if (saved === null) {
    console.log(`Cancellation emails turned on, watching ${Object.keys(current).length} booked or staffed visit(s).`);
    return { emailed: 0, cancellations: 0 };
  }
  const before = JSON.parse(saved);
  const items = [];
  for (const [key, visit] of Object.entries(current)) {
    const old = before[key];
    if (old && old.booking === "booked" && visit.booking === "rebooking") items.push({ id: `${key}:rebooking`, owner: visit.owner, key, visit, kind: "booking" });
  }
  for (const [key, old] of Object.entries(before)) {
    if (!current[key] && old.date >= todayIso) items.push({ id: `${key}:cancelled`, owner: null, key, visit: old, kind: "visit" });
  }
  items.sort((a, b) => a.visit.date.localeCompare(b.visit.date));
  const describe = (item) => `${emailDateWithDay(item.visit.date)}, ${item.visit.times}${item.visit.seeTime ? ` ${rules.SEE_TIME}` : ""}`;
  const emailed = emailReviewers(rules, members, "cancellations", items, (theirs) => {
    const bookings = theirs.filter((item) => item.kind === "booking");
    const visits = theirs.filter((item) => item.kind === "visit");
    const subject = theirs.length === 1
      ? `Lab schedule: ${bookings.length ? "booking" : "visit"} cancelled for ${emailDateWithDay(theirs[0].visit.date)}`
      : `Lab schedule: ${theirs.length} cancellations`;
    const lines = [];
    if (bookings.length) {
      lines.push(bookings.length === 1 ? "A booking was cancelled:" : "Bookings were cancelled:", "");
      for (const item of bookings) lines.push(`• ${describe(item)}${item.visit.by ? `, cancelled by ${item.visit.by}` : ""}`, `  Cancel the visit if it won't be rebooked: ${CONFIG.siteUrl}#visit=${item.key}`);
      lines.push("", "The visit stays open so it can be rebooked, and its staff haven't been told. Update the lab's appointment calendar in Google Calendar.");
    }
    if (visits.length) {
      if (lines.length) lines.push("");
      lines.push(visits.length === 1 ? "A visit was cancelled:" : "Visits were cancelled:", "", ...visits.map((item) => `• ${describe(item)}`), "",
        CONFIG.inviteStaff
          ? "Its staff are emailed automatically within 10 minutes. Update the lab's appointment calendar in Google Calendar."
          : "Staff emails are switched off for now, so its staff haven't been emailed. Update the lab's appointment calendar in Google Calendar.");
    }
    return { subject, lines };
  });
  if (items.length) console.log(`${items.length} cancellation(s); sent ${emailed} email(s).`);
  return { emailed, cancellations: items.length };
}

// At 8:30 AM: which scan to book, and upcoming birthdays and graduations.
function dailyVisits() {
  const site = loadSite();
  remindScanBooking(site);
  remindCelebrations(site, listCollection("profiles"), new Date());
  withLock(() => syncVisits(site, listCollection("staffing"), new Date()));
}

// The day that opened at 8:00 AM, 60 days ahead, needs its scan booked.
function remindScanBooking(site) {
  const iso = site.rules.defaultVisitsThrough(new Date());
  if (iso < site.rules.BOOKING_STARTS) return;
  const visits = site.rules.appointmentsOn(iso, site.appointments, site.holidays, iso).filter((appointment) => appointment.defaultFor && appointment.scan);
  if (visits.length) {
    const [visit] = visits;
    emailReviewers(site.rules, site.members, "scanReminders", [{ id: iso, owner: null }], () => ({
      subject: `Lab schedule: book the scan for ${emailDateWithDay(iso)}`,
      lines: [
        `A new participant visit opened for booking on ${emailDateWithDay(iso)}, ${visitTimesForEmail(site.rules, visit)}.`,
        "",
        `Please book the scan for ${emailTime(visit.scan.start)} – ${emailTime(visit.scan.end)}.`,
        "",
        `See it here: ${CONFIG.siteUrl}`,
      ],
    }));
    console.log(`Asked reviewers to book the scan for ${iso}.`);
  }
}

// --- Birthdays and graduations ---
// Profiles hold { birthday: "YYYY-MM-DD", graduation: "YYYY-MM" or "n/a", color, dessert, dietary }. Only lab
// managers see these: in LCL Birthdays & Graduations, and in reminder emails 1 month, 1 week and 1 day before, and on
// the morning of. A graduation is marked on the first of its month, since only the month is known.

function addDaysIso(iso, count) {
  const [year, month, day] = iso.split("-").map(Number);
  return isoOf(new Date(year, month - 1, day + count));
}

// The same day a month earlier, or the last day of that month when it's shorter (Mar 31 becomes Feb 28).
function monthBefore(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const lastDay = new Date(year, month - 1, 0).getDate();
  return isoOf(new Date(year, month - 2, Math.min(day, lastDay)));
}

// A Feb 29 birthday is marked on Feb 28 in other years.
function birthdayIn(birthday, year) {
  const [, month, day] = birthday.split("-").map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 2 && day === 29 && !leap) return `${year}-02-28`;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function graduationText(graduation) {
  const [year, month] = graduation.split("-").map(Number);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1]} ${year}`;
}

// Everyone's birthdays and expected graduations from one date to another, inclusive.
// Kept free of Google services so it can be tested on its own.
function celebrationsBetween(profiles, nameOf, fromIso, toIso) {
  const list = [];
  for (const profile of profiles) {
    const name = nameOf(profile.id);
    for (let year = Number(fromIso.slice(0, 4)); year <= Number(toIso.slice(0, 4)); year++) {
      const iso = birthdayIn(profile.birthday, year);
      if (iso >= fromIso && iso <= toIso) list.push({ iso, kind: "birthday", email: profile.id, name, profile });
    }
    if (profile.graduation && profile.graduation !== "n/a") {
      const iso = `${profile.graduation}-01`;
      if (iso >= fromIso && iso <= toIso) list.push({ iso, kind: "graduation", email: profile.id, name, profile });
    }
  }
  return list.sort((a, b) => a.iso.localeCompare(b.iso) || a.name.localeCompare(b.name));
}

function celebrationTitle(item) {
  return item.kind === "birthday" ? `🎂 ${item.name}'s birthday` : `🎓 ${item.name}'s expected graduation (${graduationText(item.profile.graduation)})`;
}

function favoritesLines(profile) {
  return [
    `Favorite color: ${profile.color}`,
    `Favorite dessert: ${profile.dessert}`,
    `Dietary restrictions/allergies: ${profile.dietary}`,
  ];
}

// The reminders due today: on the day, the day before, a week before and a month before.
function celebrationReminders(profiles, nameOf, todayIso) {
  return celebrationsBetween(profiles, nameOf, todayIso, addDaysIso(todayIso, 40)).flatMap((item) => {
    let when = "";
    if (item.iso === todayIso) when = "today";
    else if (item.iso === addDaysIso(todayIso, 1)) when = "tomorrow";
    else if (item.iso === addDaysIso(todayIso, 7)) when = "in 1 week";
    else if (monthBefore(item.iso) === todayIso) when = "in 1 month";
    return when ? [{ ...item, when }] : [];
  });
}

function buildCelebrationEvents(profiles, nameOf, today) {
  const todayIso = isoOf(today);
  // A year ahead, less a day, so each birthday shows once.
  return celebrationsBetween(profiles, nameOf, todayIso, addDaysIso(todayIso, 364)).map((item) => ({
    key: `${item.kind}:${item.email}:${item.iso}`,
    title: celebrationTitle(item),
    description: [...favoritesLines(item.profile), "", `From the Lifespan Cognition Lab Schedule: ${CONFIG.siteUrl}`].join("\n"),
    start: dateAt(item.iso, "00:00"),
    end: dateAt(addDaysIso(item.iso, 1), "00:00"),
    allDay: item.iso,
  }));
}

function syncCelebrations(site, profiles, today) {
  const nameOf = (email) => (site.members.find((member) => member.id === email) || {}).name || email;
  // Profiles of people no longer on the lab list are left out.
  const current = profiles.filter((profile) => site.members.some((member) => member.id === profile.id));
  const wanted = buildCelebrationEvents(current, nameOf, today);
  const calendarId = calendarIdFor("celebrationsCalendarId", CONFIG.celebrationsCalendarName,
    "Birthdays and expected graduations in the Lifespan Cognition Lab, with favorites. For lab managers only.");
  writeCalendar(calendarId, wanted, today, 367);
}

// Lab managers get one email a morning with any reminders due. Nobody is reminded about their own.
function remindCelebrations(site, profiles, today) {
  const nameOf = (email) => (site.members.find((member) => member.id === email) || {}).name || email;
  const current = profiles.filter((profile) => site.members.some((member) => member.id === profile.id));
  const due = celebrationReminders(current, nameOf, isoOf(today)).map((item) => ({ ...item, id: `${item.kind}:${item.email}`, owner: item.email }));
  return emailReviewers(site.rules, site.members, "celebrations", due, (items) => {
    const first = items[0];
    const subject = items.length === 1
      ? `Lab: ${first.name}'s ${first.kind === "birthday" ? "birthday" : "expected graduation"} is ${first.when}`
      : `Lab: ${items.length} birthdays and graduations coming up`;
    const lines = [];
    for (const item of items) {
      const date = item.kind === "birthday" ? emailDateWithDay(item.iso) : `${graduationText(item.profile.graduation)}, marked on ${emailDateWithDay(item.iso)}`;
      lines.push(`${celebrationTitle(item)}: ${item.when} (${date})`, ...favoritesLines(item.profile).map((line) => `  ${line}`), "");
    }
    lines.push(`See everyone's details in the Lab Directory: ${CONFIG.siteUrl}`);
    return { subject, lines };
  });
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

function deleteDocument(path) {
  const response = UrlFetchApp.fetch(`https://firestore.googleapis.com/v1/projects/${CONFIG.projectId}/databases/(default)/documents/${path}`, {
    method: "delete",
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}`, "X-Goog-User-Project": CONFIG.projectId },
  });
  if (response.getResponseCode() !== 200) {
    throw new Error(`Couldn't delete ${path} from Firebase (HTTP ${response.getResponseCode()}): ${response.getContentText().slice(0, 300)}`);
  }
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

function dateAtMinutes(iso, minutes) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
}

function visitsOn(rules, iso, appointments, holidays, through) {
  return rules.appointmentsOn(iso, appointments, holidays, through)
    .sort((a, b) => rules.visitWindow(a).start - rules.visitWindow(b).start);
}

function unusualLines(rules, appointment) {
  const notes = rules.unusualTimes(appointment);
  return notes.length ? [`${rules.SEE_TIME} These aren't the usual times:`, ...notes.map((note) => `• ${note}`), ""] : [];
}

const BOOKING_TEXT = { booked: "Booked", rebooking: "Booking cancelled, open to rebook" };

function partLines(rules, iso, appointment, kind, result) {
  const state = rules.staffingState(result);
  const slot = appointment[kind];
  const heading = `${kind === "lab" ? "Lab portion" : "Scan"}, ${emailTime(slot.start)} – ${emailTime(slot.end)}`;
  const lines = [];
  if (state === "problem") lines.push(`${heading}: ${TITLE_MARKS.problem} can't be fully staffed`, ...result.problems.map((problem) => `• ${problem}`));
  else if (state === "tight") lines.push(`${heading}: ${TITLE_MARKS.tight} ${result.tight ? `tight timing. ${result.timing}.` : "staffable, with a warning"}`, ...(result.warnings || []).map((warning) => `• Warning: ${warning}.`));
  else lines.push(`${heading}: ${TITLE_MARKS.ready} ready to staff`);
  for (const group of result.groups) {
    const label = group.label.endsWith("Available") ? group.label : `${group.label} Available`;
    lines.push(`${label}: ${group.people.map(rules.personLabel).join(", ") || "No one"}`);
  }
  lines.push(...(result.notes || []).map((note) => `*${note}`));
  if (kind === "scan" && slot.wandingRequired === false) lines.push("Wanding/taping isn't required for this visit.");
  if (kind === "scan" && rules.isOffHours(iso, slot.start, slot.end)) lines.push("Outside regular hours, so someone with Level 2 Scanning is required.");
  return lines;
}

// Why a result isn't green, for the event title.
function reasonsFor(rules, result) {
  const state = rules.staffingState(result);
  if (state === "problem") return ["can't fully staff"];
  if (state === "tight") return [...(result.tight ? ["tight timing"] : []), ...(result.flags || []).map((flag) => flag.toLowerCase())];
  return [];
}

// One event per visit, for the whole visit. Its color is its booking; its title and description say whether each part
// can be staffed, who's available, and whether it's staffed. Kept free of Google services so it can be tested.
function buildVisitEvents(rules, data, appointments, holidays, today, staffing = []) {
  const events = [];
  const through = rules.defaultVisitsThrough(today);
  const nameOf = (email) => (data.members.find((member) => member.email === email) || {}).name || email;
  for (let offset = 0; offset <= CONFIG.daysAhead; offset++) {
    const iso = isoOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
    const visits = visitsOn(rules, iso, appointments, holidays, through);
    visits.forEach((appointment, index) => {
      const key = rules.visitKey(appointment);
      const window = rules.visitWindow(appointment);
      const parts = ["lab", "scan"].filter((kind) => appointment[kind]).map((kind) => ({ kind, result: rules.evaluateVisitSlot(iso, appointment[kind], kind, data) }));
      const managers = rules.evaluateManagers(rules.managerCandidates(iso, data), window);
      const managerResult = { problems: managers.problems, warnings: managers.warnings, flags: managers.flags, tight: false };
      const states = [...parts.map((part) => rules.staffingState(part.result)), rules.staffingState(managerResult)];
      const state = states.includes("problem") ? "problem" : states.includes("tight") ? "tight" : "ready";
      const booking = appointment.booking || (iso >= rules.BOOKING_STARTS ? "open" : "");
      const doc = staffing.find((item) => item.visitKey === key);
      const check = doc ? rules.checkAssignment(iso, appointment, doc, data) : null;
      const tail = [...new Set([...parts.flatMap((part) => reasonsFor(rules, part.result)), ...reasonsFor(rules, managerResult)])];
      if (doc) tail.push(check.issues.length ? "staffing conflict" : "staffed");
      const seeTime = rules.unusualTimes(appointment).length > 0;
      const partsLabel = rules.visitPartsLabel(appointment);

      const lines = [...unusualLines(rules, appointment), `Whole visit: ${rules.clockTime(window.start)} – ${rules.clockTime(window.end)}${partsLabel ? ` (${partsLabel})` : ""}`];
      if (booking) lines.push(`Booking: ${BOOKING_TEXT[appointment.booking] || "Open"}${appointment.bookedByName ? ` (${appointment.bookedByName})` : ""}`);
      for (const part of parts) lines.push("", ...partLines(rules, iso, appointment, part.kind, part.result));
      lines.push("", `Lab manager: ${managers.problems.length ? `${TITLE_MARKS.problem} ${managers.problems.join("; ")}` : managers.warnings.length ? `${TITLE_MARKS.tight} ${managers.warnings.join("; ")}` : `${TITLE_MARKS.ready} covered`}`,
        `Lab Managers Available: ${managers.group.people.map(rules.personLabel).join(", ") || "No one"}`, ...managers.notes.map((note) => `*${note}`));
      if (doc) {
        const assigned = rules.assignmentLines(appointment, doc, nameOf);
        lines.push("", "Staffed:", ...[...assigned.lab, ...assigned.scan, ...assigned.managers].map((line) => `• ${line}`));
        if (check.issues.length) lines.push("Staffing conflicts:", ...check.issues.map((issue) => `• ${issue}`));
      }
      lines.push("", `Staff or change this visit: ${CONFIG.siteUrl}#visit=${key}`);
      events.push({
        key: `${key}:visit`,
        title: `${TITLE_MARKS[state]} ${seeTime ? `${rules.SEE_TIME} ` : ""}${booking ? `${BOOKING_TITLES[booking]}: ` : ""}Participant Visit${visits.length > 1 ? ` ${index + 1}` : ""}${partsLabel ? ` (${partsLabel})` : ""}${tail.length ? ` · ${tail.join(", ")}` : ""}`,
        description: lines.join("\n"),
        start: dateAtMinutes(iso, window.start),
        end: dateAtMinutes(iso, window.end),
        color: booking ? BOOKING_COLORS[booking] : null,
      });
    });
  }
  return events;
}

// When each lab member can't be in the lab: classes, standing conflicts and time off, each person in their own color.
// Kept free of Google services so it can be tested on its own.
function buildUnavailabilityEvents(rules, data, today) {
  const events = [];
  const nameOf = (email) => (data.members.find((member) => member.email === email) || {}).name || email;
  const colorOf = (email) => String((Math.max(0, data.members.findIndex((member) => member.email === email)) % 11) + 1);
  for (let offset = 0; offset <= CONFIG.daysAhead; offset++) {
    const iso = isoOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
    for (const block of rules.unavailableOn(iso, data)) {
      const name = nameOf(block.email);
      let title;
      if (block.kind === "class") title = `${name}: class`;
      else if (block.kind === "conflict") title = `${name}: ${block.note || "standing conflict"}`;
      else title = `${name}: time off${block.pending ? " (waiting for review)" : ""}${block.note ? `, ${block.note}` : ""}`;
      const allDay = !block.start;
      events.push({
        key: `${block.kind}:${block.id}:${iso}`,
        title,
        description: `Can't be in the lab. From the Lifespan Cognition Lab Schedule: ${CONFIG.siteUrl}`,
        start: allDay ? dateAt(iso, "00:00") : dateAt(iso, block.start),
        end: allDay ? dateAt(isoOf(new Date(dateAt(iso, "12:00").getTime() + 86400000)), "00:00") : dateAt(iso, block.end),
        allDay: allDay ? iso : null,
        color: colorOf(block.email),
      });
    }
  }
  return events;
}

// Two events per staffed visit: one for the whole visit (4 hours from the start), for the lab staff and lab manager,
// and one for the scan, for the scanners. Staff who are only needed for part of the visit are told their own times.
// Kept free of Google services so it can be tested on its own.
function buildConfirmedEvents(rules, data, appointments, holidays, staffing, today) {
  const events = [];
  const todayIso = isoOf(today);
  const nameOf = (email) => (data.members.find((member) => member.email === email) || {}).name || email;
  for (const doc of staffing) {
    if (doc.date < todayIso) continue;
    const visits = visitsOn(rules, doc.date, appointments, holidays);
    const index = visits.findIndex((appointment) => rules.visitKey(appointment) === doc.visitKey);
    // A cancelled visit isn't listed, so its events are removed.
    if (index === -1) continue;
    const appointment = visits[index];
    const number = visits.length > 1 ? ` (visit ${index + 1} of ${visits.length} that day)` : "";
    const unusual = rules.unusualTimes(appointment).length > 0;
    const window = rules.visitWindow(appointment);
    const range = (from, to) => `${rules.clockTime(from)} – ${rules.clockTime(to)}`;
    const assigned = rules.assignmentLines(appointment, doc, nameOf);
    const lab = doc.lab || {};
    const scan = doc.scan || {};
    const parts = [
      appointment.lab ? `Lab portion: ${emailTime(appointment.lab.start)} – ${emailTime(appointment.lab.end)}` : "",
      appointment.scan ? `Scan: ${emailTime(appointment.scan.start)} – ${emailTime(appointment.scan.end)}` : "",
    ].filter(Boolean);
    const prefix = unusual ? `${rules.SEE_TIME} ` : "";

    const visitPeople = [...new Set([lab.dryLab, lab.phlebotomy, lab.wetLab, ...(doc.managers || [])].filter(Boolean))];
    if (visitPeople.length && (appointment.lab || (doc.managers || []).length)) {
      events.push({
        key: `${doc.visitKey}:visit`,
        title: `${prefix}Participant Visit${number}`,
        description: [
          ...unusualLines(rules, appointment),
          `Whole visit: ${range(window.start, window.end)}`,
          ...parts,
          "",
          "Staff:",
          ...[...assigned.lab, ...assigned.managers].map((line) => `• ${line}`),
          "",
          "Lab staff are only needed for their own times above and don't need to come back after the scan; a lab manager finishes the visit.",
          ...(appointment.scan ? ["Scanners have a separate invite for the scan."] : []),
          "",
          `Staffing on the Lifespan Cognition Lab Schedule: ${CONFIG.siteUrl}#visit=${doc.visitKey}`,
        ].join("\n"),
        start: dateAtMinutes(doc.date, window.start),
        end: dateAtMinutes(doc.date, window.end),
        attendees: visitPeople,
      });
    }

    const scanPeople = [...new Set([scan.lead, scan.support, scan.wanding].filter(Boolean))];
    if (appointment.scan && scanPeople.length) {
      events.push({
        key: `${doc.visitKey}:scan`,
        title: `${prefix}Participant Visit - Scan${number}`,
        description: [
          ...unusualLines(rules, appointment),
          `Scan: ${emailTime(appointment.scan.start)} – ${emailTime(appointment.scan.end)}`,
          `Whole visit: ${range(window.start, window.end)}`,
          "",
          "Staff:",
          ...assigned.scan.map((line) => `• ${line}`),
          ...(appointment.scan.wandingRequired === false ? ["", "Wanding/taping isn't required for this visit."] : []),
          "",
          `Lifespan Cognition Lab Schedule: ${CONFIG.siteUrl}`,
        ].join("\n"),
        start: dateAt(doc.date, appointment.scan.start),
        end: dateAt(doc.date, appointment.scan.end),
        attendees: scanPeople,
      });
    }
  }
  return events;
}

// Staff are only added as guests once CONFIG.inviteStaff is turned on. Until then they're listed in the description
// alone. Google never emails guests itself; notifyStaff sends each person their own email.
function syncConfirmed(site = loadSite(), staffing = listCollection("staffing"), today = new Date()) {
  const wanted = buildConfirmedEvents(site.rules, site.data, site.appointments, site.holidays, staffing, today)
    .map((event) => (CONFIG.inviteStaff ? event : { ...event, attendees: [] }));
  const calendarId = calendarIdFor("confirmedCalendarId", CONFIG.confirmedCalendarName,
    "Staffed participant visits, from the Lifespan Cognition Lab Schedule. Filled in automatically every 10 minutes.");
  const changes = writeCalendar(calendarId, wanted, today, 120);
  if (changes.created || changes.updated || changes.deleted) {
    console.log(`Confirmed Visits synced: ${changes.created} added, ${changes.updated} updated, ${changes.deleted} removed.`);
  }
}

// --- Emailing staff ---
// Each person gets one email per run about what changed for them: assigned, times changed, taken off, or the visit
// cancelled. A cancelled booking waiting to be rebooked changes nothing, so it sends nothing. What each person was last
// told is kept in script properties, one per visit, so a fix made before the next run never reaches anyone.

// What each person is doing on each upcoming staffed visit. Kept free of Google services so it can be tested.
function staffSnapshot(rules, appointments, holidays, staffing, today) {
  const todayIso = isoOf(today);
  const snapshot = {};
  for (const doc of staffing) {
    if (doc.date < todayIso) continue;
    const appointment = visitsOn(rules, doc.date, appointments, holidays).find((visit) => rules.visitKey(visit) === doc.visitKey);
    if (!appointment) continue;
    const window = rules.visitWindow(appointment);
    const people = {};
    for (const role of rules.staffRoles(appointment, doc)) {
      (people[role.email] = people[role.email] || []).push(`${role.role}, ${rules.clockTime(role.from)}–${rules.clockTime(role.to)}`);
    }
    snapshot[doc.visitKey] = {
      date: doc.date,
      visit: `${rules.clockTime(window.start)} – ${rules.clockTime(window.end)}`,
      seeTime: rules.unusualTimes(appointment),
      people,
    };
  }
  return snapshot;
}

// The changes for each person between what they were last told and now. `stillScheduled(key, date)` tells a
// visit that's been unstaffed from one that's been cancelled.
function staffChanges(before, after, todayIso, stillScheduled) {
  const changes = {};
  const add = (email, change) => (changes[email] = changes[email] || []).push(change);
  for (const [key, visit] of Object.entries(after)) {
    const old = before[key];
    for (const [email, roles] of Object.entries(visit.people)) {
      const was = old && old.people[email];
      if (!was) add(email, { type: "assigned", visit, roles });
      else if (was.join("|") !== roles.join("|") || old.visit !== visit.visit || old.date !== visit.date) add(email, { type: "changed", visit, roles, was, oldVisit: old });
    }
    for (const [email, roles] of Object.entries((old && old.people) || {})) {
      if (!visit.people[email]) add(email, { type: "removed", visit: old, roles });
    }
  }
  for (const [key, old] of Object.entries(before)) {
    // Visits that have happened are simply forgotten.
    if (after[key] || old.date < todayIso) continue;
    const type = stillScheduled(key, old.date) ? "removed" : "cancelled";
    for (const [email, roles] of Object.entries(old.people)) add(email, { type, visit: old, roles });
  }
  return changes;
}

const STAFF_SUBJECTS = {
  assigned: (date) => `Lab visit: you're staffing ${date}`,
  changed: (date) => `Lab visit: your times changed for ${date}`,
  removed: (date) => `Lab visit: you're no longer staffing ${date}`,
  cancelled: (date) => `Lab visit cancelled: ${date}`,
};

function staffEmail(rules, name, changes) {
  const lines = [`Hi ${name},`, ""];
  for (const change of changes) {
    const date = emailDateWithDay(change.visit.date);
    if (change.type === "assigned") {
      lines.push(`You're staffing a participant visit on ${date} (whole visit ${change.visit.visit}).`, `Your role: ${change.roles.join("; ")}`);
    } else if (change.type === "changed") {
      lines.push(`Your times changed for the participant visit on ${date} (whole visit ${change.visit.visit}).`,
        `Before: ${change.was.join("; ")}${change.oldVisit.date !== change.visit.date ? ` on ${emailDateWithDay(change.oldVisit.date)}` : ""}`,
        `Now: ${change.roles.join("; ")}`);
    } else if (change.type === "removed") {
      lines.push(`You're no longer staffing the participant visit on ${date}. You were down for: ${change.roles.join("; ")}.`);
    } else {
      lines.push(`The participant visit on ${date} (${change.visit.visit}) has been cancelled. You were down for: ${change.roles.join("; ")}.`);
    }
    const current = change.type === "assigned" || change.type === "changed";
    if (current && change.visit.seeTime.length) {
      lines.push(`${rules.SEE_TIME} These aren't the usual times, so please check yours:`, ...change.visit.seeTime.map((note) => `• ${note}`));
    }
    lines.push("");
  }
  lines.push("Your Google Calendar has been updated to match. Questions? Ask a lab manager.");
  const first = changes[0];
  const seeTime = changes.some((change) => (change.type === "assigned" || change.type === "changed") && change.visit.seeTime.length);
  const subject = changes.length === 1 ? STAFF_SUBJECTS[first.type](emailDateWithDay(first.visit.date)) : `Lab visits: ${changes.length} updates for you`;
  return { subject: `${subject}${seeTime ? ` ${rules.SEE_TIME}` : ""}`, body: lines.join("\n") };
}

// Staff can't turn these off: they carry the times people need. Nothing is sent, or remembered, until
// CONFIG.inviteStaff is on, so turning it on tells everyone about the upcoming visits they're staffing.
function notifyStaff(site = loadSite(), staffing = listCollection("staffing"), today = new Date()) {
  if (!CONFIG.inviteStaff) return { emailed: 0 };
  const { rules } = site;
  const properties = PropertiesService.getScriptProperties();
  const before = {};
  for (const [name, value] of Object.entries(properties.getProperties())) {
    if (name.startsWith("staff:")) before[name.slice("staff:".length)] = JSON.parse(value);
  }
  const after = staffSnapshot(rules, site.appointments, site.holidays, staffing, today);
  const stillScheduled = (key, date) => visitsOn(rules, date, site.appointments, site.holidays).some((visit) => rules.visitKey(visit) === key);
  const changes = staffChanges(before, after, isoOf(today), stillScheduled);
  const nameOf = (email) => (site.members.find((member) => member.id === email) || {}).name || email;
  let emailed = 0;
  for (const [email, theirs] of Object.entries(changes)) {
    const { subject, body } = staffEmail(rules, nameOf(email), theirs);
    MailApp.sendEmail({ to: email, subject, body });
    emailed++;
  }
  for (const key of Object.keys(before)) if (!after[key]) properties.deleteProperty(`staff:${key}`);
  for (const [key, visit] of Object.entries(after)) properties.setProperty(`staff:${key}`, JSON.stringify(visit));
  if (emailed) console.log(`Emailed ${emailed} staff member(s) about their visits.`);
  return { emailed };
}

// --- Writing the calendars ---

function calendarIdFor(propertyName, name, description) {
  const properties = PropertiesService.getScriptProperties();
  const savedId = properties.getProperty(propertyName);
  if (savedId) {
    let calendar = null;
    try {
      calendar = Calendar.Calendars.get(savedId);
    } catch (error) {
      // The calendar was deleted, so make a new one below.
    }
    // A calendar made under an older name, such as "Lab Staffing", is renamed rather than replaced.
    if (calendar && calendar.summary !== name) Calendar.Calendars.patch({ summary: name, description }, savedId);
    if (calendar) return calendar.id;
  }
  const calendar = Calendar.Calendars.insert({ summary: name, description, timeZone: CONFIG.timeZone });
  properties.setProperty(propertyName, calendar.id);
  return calendar.id;
}

function signatureOf(event) {
  const text = JSON.stringify([event.title, event.description, event.start.getTime(), event.end.getTime(), event.color || "", (event.attendees || []).slice().sort()]);
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8));
}

// Guests who've already replied keep their reply when an event is updated. Whole days off are all-day events.
function eventResource(item, signature, previous) {
  const replies = new Map(((previous && previous.attendees) || []).map((guest) => [guest.email, guest.responseStatus]));
  return {
    summary: item.title,
    description: item.description,
    ...(item.allDay
      ? { start: { date: item.allDay }, end: { date: isoOf(item.end) } }
      : { start: { dateTime: item.start.toISOString(), timeZone: CONFIG.timeZone }, end: { dateTime: item.end.toISOString(), timeZone: CONFIG.timeZone } }),
    ...(item.color ? { colorId: item.color } : {}),
    attendees: (item.attendees || []).map((email) => ({ email, ...(replies.has(email) ? { responseStatus: replies.get(email) } : {}) })),
    guestsCanModify: false,
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

// Only events that actually changed are rewritten, so runs stay well inside Google's limits.
// Google is always told not to email guests: staff hear from notifyStaff instead.
function writeCalendar(calendarId, wanted, today, days) {
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const windowEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  const existing = new Map();
  const changes = { created: 0, updated: 0, deleted: 0 };
  const options = { sendUpdates: "none" };

  for (const event of listEvents(calendarId, windowStart, windowEnd)) {
    const tags = (event.extendedProperties && event.extendedProperties.private) || {};
    if (!tags.labKey) continue;
    if (existing.has(tags.labKey)) {
      Calendar.Events.remove(calendarId, event.id, options);
      changes.deleted++;
    } else {
      existing.set(tags.labKey, { id: event.id, signature: tags.labSignature, event });
    }
  }

  for (const item of wanted) {
    const signature = signatureOf(item);
    const found = existing.get(item.key);
    existing.delete(item.key);
    if (found && found.signature === signature) continue;
    if (found) {
      Calendar.Events.update(eventResource(item, signature, found.event), calendarId, found.id, options);
      changes.updated++;
    } else {
      Calendar.Events.insert(eventResource(item, signature), calendarId, options);
      changes.created++;
    }
  }

  // Anything left over is a visit that was cancelled, unstaffed or no longer exists.
  for (const found of existing.values()) {
    Calendar.Events.remove(calendarId, found.id, options);
    changes.deleted++;
  }
  return changes;
}
