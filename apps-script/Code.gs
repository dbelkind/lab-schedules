// Connects the Lifespan Cognition Lab Researcher Portal to Google Calendar and email. It keeps three calendars for lab managers:
// - "LCL Visits": each participant visit, colored by its booking (gray open, blue booked, orange waiting to be
//   rebooked), with who's available for each part. Updated every 10 minutes, and straight away when the site pings it.
// - "LCL Confirmed Visits": each staffed visit, with who's doing what. Updated every 10 minutes.
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
  celebrationsCalendarName: "LCL Birthdays & Graduations",
  daysAhead: 60,
  timeZone: "America/Los_Angeles",
  // While this is false, assigned staff are only listed in the Confirmed Visits events, not added as guests, and
  // aren't emailed. Only reviewers get emails. Set it to true to add staff as guests and email them about their visits.
  // Google itself never emails guests: the script sends each person their own email instead.
  inviteStaff: false,
  // While this is false, RAs and other lab members aren't emailed either: no semester or finals schedule reminders,
  // and no word when a request of theirs is reviewed. Turn it on with inviteStaff once testing is done.
  emailLabMembers: false,
  // Which semesters RAs are asked to send a class schedule for. Summer is left out, since most RAs don't take
  // summer classes; add "summer" to ask for those too.
  scheduleSemesters: ["spring", "fall"],
  // Where "Received this email by mistake?" at the bottom of every email goes.
  labManagerEmail: "dbelkind@usc.edu",
  // Where scans are booked, linked from the 8:30 AM scan booking reminder.
  scanBookingUrl: "https://dni.usc.edu/dashboard.php",
  // Where sendTestEmails sends its samples.
  testEmailsTo: "dbelkind@usc.edu",
  // The site's pings run at most this often, since anyone with the web app's link could call it.
  quickSyncSeconds: 5,
};

// Google Calendar's event colors, which look the same to everyone the calendar is shared with.
// LCL Visits is colored by booking: 8 is gray (Graphite) for open, 9 is blue (Blueberry) for booked and waiting to be
// confirmed, 10 is green (Basil) for confirmed, and 6 is orange (Tangerine) for a cancelled booking waiting to be
// rebooked. Visits from before booking moved to the website keep the calendar's own color.
const BOOKING_COLORS = { open: "8", booked: "9", confirmed: "10", rebooking: "6" };
const BOOKING_TITLES = { open: "Open", booked: "Booked", confirmed: "Confirmed", rebooking: "Rebooking" };
const TITLE_MARKS = { ready: "✅", tight: "🟡", problem: "⚠️" };

const RULE_NAMES = [
  "appointmentsOn", "evaluateVisitSlot", "evaluateManagers", "managerCandidates", "normalizeSkills", "isOffHours",
  "SLOT_TITLES", "staffingState", "personLabel", "visitKey", "visitWindow", "unusualTimes", "visitPartsLabel",
  "defaultVisitsThrough", "assignmentLines", "checkAssignment", "BOOKING_STARTS", "clockTime", "wantsEmail", "SEE_TIME",
  "staffRoles", "bookingEmail", "birthdayMonthDay", "visitStatus",
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
// The USC calendars come from Lab Management → Website Management once a lab manager has saved them there, and
// from the files published with the site until then.
function loadSite() {
  const rules = loadRules();
  const settings = listCollection("settings");
  const savedAcademic = settings.find((doc) => doc.id === "academicCalendar");
  const savedHolidays = settings.find((doc) => doc.id === "staffHolidays");
  const academic = savedAcademic && savedAcademic.semesters ? savedAcademic : fetchJson("data/academic-calendar.json");
  const staff = savedHolidays && savedHolidays.holidays ? savedHolidays : fetchJson("data/staff-holidays.json");
  const members = listCollection("members");
  return {
    rules,
    members,
    academic: { semesters: academic.semesters, events: academic.events || [] },
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

// Every hour: LCL Birthdays & Graduations.
function hourlySync() {
  withLock(() => syncCelebrations(loadSite(), listCollection("profiles"), new Date()));
}

function syncVisits(site, staffing, today) {
  const wanted = buildVisitEvents(site.rules, site.data, site.appointments, site.holidays, today, staffing);
  const calendarId = calendarIdFor("calendarId", CONFIG.visitsCalendarName,
    "Participant visits: gray when open, blue when booked, orange when a booking was cancelled and it's open to rebook. Says who's available for each part. From the Lifespan Cognition Lab Researcher Portal.");
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
const EMAIL_FOOTER = "To choose which emails you get, go to Lab Management → My Settings on the site.";

// Emails are written as lines with a little markup, so what matters stands out: **bold**, __underlined__ and
// ==highlighted==. They go out as HTML, with the markup taken out of the plain-text copy.
function bold(text) {
  return `**${text}**`;
}

function underline(text) {
  return `__${text}__`;
}

function highlight(text) {
  return `==${text}==`;
}

// Dates and times are the easiest things to miss, so they're bold and highlighted.
function dateMark(text) {
  return bold(highlight(text));
}

function plainText(line) {
  return line.replace(/\*\*|__|==/g, "");
}

function htmlLine(line) {
  let html = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  html = html.replace(/(https?:\/\/[^\s<]*[^\s<.,;:)])/g, '<a href="$1" style="color:#0f766e;font-weight:600">$1</a>');
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/==(.+?)==/g, '<mark style="background:#fde68a;color:#14201e;padding:0 3px;border-radius:3px">$1</mark>')
    .replace(/__(.+?)__/g, "<u>$1</u>");
  if (!line.trim()) return '<div style="height:12px"></div>';
  const indent = line.startsWith("  ") ? "padding-left:18px;" : "";
  return `<div style="${indent}margin:0 0 4px">${html}</div>`;
}

function mistakeLink(subject) {
  return `mailto:${CONFIG.labManagerEmail}?subject=${encodeURIComponent("Lab email received by mistake")}&body=${encodeURIComponent(`I received this email by mistake, or it has an error.\n\nThe email's subject: ${subject}\n\nWhat's wrong: `)}`;
}

function emailHtml(subject, lines, footer) {
  const footerHtml = [
    ...footer.map((line) => `<div style="margin:0 0 6px">${htmlLine(line).replace(/^<div[^>]*>|<\/div>$/g, "")}</div>`),
    `<div>Received this email by mistake? <a href="${mistakeLink(subject)}" style="color:#a03a6a;font-weight:600">Click here</a> to notify the lab manager if there was an error.</div>`,
  ].join("");
  return [
    '<div style="background:#f5f7f7;padding:24px 12px;font-family:Inter,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif">',
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e1e7e6;border-radius:12px;overflow:hidden">',
    '<div style="background:#0f766e;color:#ffffff;padding:14px 22px;font-size:15px;font-weight:700;border-bottom:4px solid #f1abc8">Lifespan Cognition Lab</div>',
    `<div style="padding:20px 22px;font-size:15px;line-height:1.55;color:#14201e">${lines.map(htmlLine).join("")}</div>`,
    `<div style="padding:14px 22px;border-top:1px solid #f8d0e0;background:#fdf3f7;color:#5b6b68;font-size:12px;line-height:1.5">${footerHtml}</div>`,
    "</div></div>",
  ].join("");
}

// Every email goes through here, so they all look the same and all say how to report one sent by mistake.
function sendEmail({ to, subject, lines, footer = [] }) {
  MailApp.sendEmail({
    to,
    subject,
    body: [...lines.map(plainText), "", ...footer.map(plainText), `Received this email by mistake? Let the lab manager know: ${CONFIG.labManagerEmail}`].join("\n"),
    htmlBody: emailHtml(subject, lines, footer),
  });
}

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
  const dates = request.from === request.to ? emailDateWithDay(request.from) : `${emailDateWithDay(request.from)} – ${emailDateWithDay(request.to)}`;
  const hours = request.start ? `, ${emailTime(request.start)} – ${emailTime(request.end)}` : "";
  return `${dateMark(`${dates}${hours}`)}${request.note ? ` (${request.note})` : ""}`;
}

function namesList(people) {
  const names = people.map((person) => person.name);
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// --- Email choices ---
// Before anything that sends an email, the site asks the person doing it who should get it, and saves any change
// (people left off, no email at all, or a message to add) in emailChoices under the email's kind and ref. Each is
// used once and then deleted; ones never used, as while staff emails are off, are cleared after two days.

const CHOICE_DAYS = 2;

function loadEmailChoices(today = new Date()) {
  const choices = new Map();
  const oldest = today.getTime() - CHOICE_DAYS * 24 * 60 * 60 * 1000;
  for (const doc of listCollection("emailChoices")) {
    if (!(Date.parse(doc.createdAt) >= oldest)) {
      deleteDocument(`emailChoices/${doc.id}`);
      continue;
    }
    choices.set(`${doc.kind}|${doc.ref}`, doc);
  }
  return choices;
}

// The choice for one email, which is then used up.
function takeChoice(choices, kind, ref) {
  const choice = choices.get(`${kind}|${ref}`) || null;
  if (choice) {
    choices.delete(`${kind}|${ref}`);
    deleteDocument(`emailChoices/${choice.id}`);
  }
  return choice;
}

function leftOut(choice, email) {
  return Boolean(choice) && (choice.none === true || (choice.skip || []).includes(email));
}

// Any messages added for these items, once each.
function choiceMessageLines(items) {
  const lines = [...new Set(items.map((item) => item.choice).filter((choice) => choice && choice.message)
    .map((choice) => `${bold(`Message from ${choice.byName || choice.by}:`)} ${choice.message}`))];
  return lines.length ? ["", ...lines] : [];
}

// Sends one email to all the reviewers who'd get the same news, rather than one each. Everything comes from the
// account the script runs under, so separate emails would also show up there as copies of each other.
// `kind` is one of the REVIEWER_EMAILS keys, and reviewers who've turned that kind off are left out.
// Items are { id, owner, choice }; nobody is emailed about something they did themselves, or that they were left off
// (see Email choices). `compose` turns a reviewer group's items into { subject, lines }.
function emailReviewers(rules, members, kind, items, compose) {
  const reviewers = members.filter((member) => member.role === "reviewer" && rules.wantsEmail(member, kind));
  const groups = new Map();
  for (const reviewer of reviewers) {
    const theirs = items.filter((item) => item.owner !== reviewer.id && !leftOut(item.choice, reviewer.id));
    if (!theirs.length) continue;
    const key = theirs.map((item) => item.id).join("|");
    if (!groups.has(key)) groups.set(key, { reviewers: [], items: theirs });
    groups.get(key).reviewers.push(reviewer);
  }
  for (const group of groups.values()) {
    const { subject, lines } = compose(group.items);
    sendEmail({ to: group.reviewers.map((reviewer) => reviewer.id).join(","), subject, lines: reviewerLines(group.reviewers, [...lines, ...choiceMessageLines(group.items)]), footer: [EMAIL_FOOTER] });
  }
  return groups.size;
}

function reviewerLines(reviewers, lines) {
  return [`Hi ${namesList(reviewers)},`, "", ...lines];
}

// --- The reviewer email templates. Each returns { subject, lines }, and sendTestEmails sends a sample of each. ---

function requestsEmail(requests, nameOf) {
  return {
    subject: requests.length === 1
      ? `Lab schedule: ${nameOf(requests[0].owner)} sent a request to review`
      : `Lab schedule: ${requests.length} new requests to review`,
    lines: [
      requests.length === 1 ? "A new request is waiting for review on the Lifespan Cognition Lab Researcher Portal:" : "New requests are waiting for review on the Lifespan Cognition Lab Researcher Portal:",
      "",
      ...requests.map((request) => `• ${bold(nameOf(request.owner))}: ${request.text}`),
      "",
      `Review them here: ${CONFIG.siteUrl}#review`,
    ],
  };
}

function updatesEmail(updates, nameOf) {
  return {
    subject: updates.length === 1 ? `Lab schedule: ${nameOf(updates[0].owner)} updated their schedule` : `Lab schedule: ${updates.length} schedule updates`,
    lines: ["Grad Students/Post-Docs saved these changes (no review needed):", "", ...updates.map((notice) => `• ${bold(nameOf(notice.owner))}: ${notice.text}`)],
  };
}

// Emails reviewers about requests waiting for review, once per request, and about changes Grad Students/Post-Docs
// have already saved. The first run only notes what's already waiting, so turning this on doesn't send a flood.
function checkRequests() {
  const rules = loadRules();
  const members = listCollection("members");
  const nameOf = (email) => (members.find((member) => member.id === email) || {}).name || email;
  const allTimeOff = listCollection("timeOff");
  const allChanges = listCollection("changeRequests");
  const pending = [
    ...allTimeOff.filter((request) => request.status === "pending").map((request) => ({
      id: `timeOff/${request.id}`,
      owner: request.ownerEmail,
      text: `Time off: ${describeTimeOffForEmail(request)}`,
    })),
    ...allChanges.filter((request) => request.status === "pending").map((request) => ({
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
  const choices = loadEmailChoices();
  const fresh = pending.filter((request) => !notified.has(request.id)).map((request) => ({ ...request, choice: takeChoice(choices, "requests", request.id) }));
  // Requests and saved updates are separate kinds of email, so each reviewer gets just the ones they want.
  const updateItems = notices.map((notice) => ({ id: `notices/${notice.id}`, owner: notice.ownerEmail, text: notice.summary, choice: takeChoice(choices, "updates", `notices/${notice.id}`) }));
  const emailed = emailReviewers(rules, members, "requests", fresh, (requests) => requestsEmail(requests, nameOf))
    + emailReviewers(rules, members, "updates", updateItems, (updates) => updatesEmail(updates, nameOf));
  // Requests that were waiting last time and have been decided since: the person who sent them hears how it went.
  const decided = [...notified].filter((id) => !pendingIds.includes(id)).map((id) => {
    const [collection, docId] = id.split("/");
    const request = (collection === "timeOff" ? allTimeOff : allChanges).find((item) => item.id === docId);
    return request && ["approved", "declined"].includes(request.status) ? { ...request, kind: collection, choice: takeChoice(choices, "reviewResult", id) } : null;
  }).filter(Boolean);
  if (CONFIG.emailLabMembers) {
    for (const request of decided) {
      if (leftOut(request.choice, request.ownerEmail)) continue;
      const email = reviewResultEmail(request, nameOf);
      sendEmail({ to: request.ownerEmail, subject: email.subject, lines: [...email.lines, ...choiceMessageLines([request])] });
    }
  } else if (decided.length) {
    console.log(`${decided.length} request(s) decided; lab member emails are switched off, so their senders weren't emailed.`);
  }
  // Only requests still waiting are remembered, so this list stays small. Notices are done with once emailed.
  properties.setProperty("notifiedRequests", JSON.stringify(pendingIds));
  for (const notice of notices) deleteDocument(`notices/${notice.id}`);
  if (fresh.length || notices.length) console.log(`${fresh.length} new request(s) and ${notices.length} update(s); sent ${emailed} email(s).`);
  return { emailed, fresh: fresh.length };
}

// To the person who sent a request, once a reviewer has decided it.
function reviewResultEmail(request, nameOf) {
  const approved = request.status === "approved";
  const decision = bold(underline(approved ? "approved" : "declined"));
  const what = request.kind === "timeOff" ? "time off request" : "schedule change";
  const detail = request.kind === "timeOff" ? ` for ${describeTimeOffForEmail(request)}` : `: ${request.summary}`;
  return {
    subject: `Lab schedule: your ${what} was ${approved ? "approved" : "declined"}`,
    lines: [
      `Hi ${nameOf(request.ownerEmail)},`,
      "",
      `Your ${what}${detail} was ${decision} by ${bold(nameOf(request.reviewedBy))}.`,
      ...(request.reviewNote ? ["", `${bold("Their note:")} ${request.reviewNote}`] : []),
      "",
      approved ? "It's on your calendar now." : "If you have questions, ask the lab manager. You can send a new request any time.",
      "",
      `See your schedule: ${CONFIG.siteUrl}`,
    ],
  };
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
  if (items.length) {
    const choices = loadEmailChoices(today);
    for (const item of items) item.choice = takeChoice(choices, "cancellations", item.id);
  }
  const emailed = emailReviewers(rules, members, "cancellations", items, (theirs) => cancellationsEmail(rules, theirs));
  if (items.length) console.log(`${items.length} cancellation(s); sent ${emailed} email(s).`);
  return { emailed, cancellations: items.length };
}

// Items are { key, kind: "booking" | "visit", visit: { date, times, by, seeTime } }.
function cancellationsEmail(rules, items) {
  const describe = (item) => `${dateMark(`${emailDateWithDay(item.visit.date)}, ${item.visit.times}`)}${item.visit.seeTime ? ` ${highlight(rules.SEE_TIME)}` : ""}`;
  const bookings = items.filter((item) => item.kind === "booking");
  const visits = items.filter((item) => item.kind === "visit");
  const subject = items.length === 1
    ? `Lab schedule: ${bookings.length ? "booking" : "visit"} cancelled for ${emailDateWithDay(items[0].visit.date)}`
    : `Lab schedule: ${items.length} cancellations`;
  const cancelled = bold(underline("cancelled"));
  const lines = [];
  if (bookings.length) {
    lines.push(bookings.length === 1 ? `A booking was ${cancelled}:` : `Bookings were ${cancelled}:`, "");
    for (const item of bookings) lines.push(`• ${describe(item)}${item.visit.by ? `, cancelled by ${bold(item.visit.by)}` : ""}`, `  Cancel the visit if it won't be rebooked: ${CONFIG.siteUrl}#visit=${item.key}`);
    lines.push("", `The visit ${bold("stays open")} so it can be rebooked, and its staff ${bold("haven't been told")}. Update the lab's appointment calendar in Google Calendar.`);
  }
  if (visits.length) {
    if (lines.length) lines.push("");
    lines.push(visits.length === 1 ? `A visit was ${cancelled}:` : `Visits were ${cancelled}:`, "", ...visits.map((item) => `• ${describe(item)}`), "",
      CONFIG.inviteStaff
        ? "Its staff are emailed automatically within 10 minutes. Update the lab's appointment calendar in Google Calendar."
        : `Staff emails are switched off for now, so its staff ${bold("haven't been emailed")}. Update the lab's appointment calendar in Google Calendar.`);
  }
  return { subject, lines };
}

// At 8:30 AM: which scan to book, upcoming birthdays and graduations, class and finals schedule reminders for RAs,
// and whether the USC calendars need adding to.
function dailyVisits() {
  const site = loadSite();
  const profiles = listCollection("profiles");
  remindScanBooking(site);
  remindCelebrations(site, profiles, new Date());
  remindLabMembers(site, profiles, listCollection("changeRequests"), new Date());
  remindCalendarData(site, new Date());
  withLock(() => syncVisits(site, listCollection("staffing"), new Date()));
}

function scanReminderEmail(rules, iso, visit) {
  return {
    subject: `Lab schedule: book the scan for ${emailDateWithDay(iso)}`,
    lines: [
      `A new participant visit opened for booking on ${dateMark(emailDateWithDay(iso))}, ${visitTimesForEmail(rules, visit)}.`,
      "",
      `Please ${bold("book the scan")} for ${dateMark(`${emailTime(visit.scan.start)} – ${emailTime(visit.scan.end)}`)}.`,
      "",
      `Book it here: ${CONFIG.scanBookingUrl}`,
      "",
      `If you get a different time than ${dateMark(`${emailTime(visit.scan.start)} – ${emailTime(visit.scan.end)}`)}, ${bold(underline("change the slot's scan time"))} on the Lab Calendar before anyone books it: ${CONFIG.siteUrl}#visit=${rules.visitKey(visit)}`,
    ],
  };
}

// The day that opened at 8:00 AM, 60 days ahead, needs its scan booked.
function remindScanBooking(site) {
  const iso = site.rules.defaultVisitsThrough(new Date());
  if (iso < site.rules.BOOKING_STARTS) return;
  const visits = site.rules.appointmentsOn(iso, site.appointments, site.holidays, iso).filter((appointment) => appointment.defaultFor && appointment.scan);
  if (visits.length) {
    const [visit] = visits;
    emailReviewers(site.rules, site.members, "scanReminders", [{ id: iso, owner: null }], () => scanReminderEmail(site.rules, iso, visit));
    console.log(`Asked reviewers to book the scan for ${iso}.`);
  }
}

// --- Class and finals schedules ---
// A month before a semester ends, RAs still in school are asked for next semester's class schedule, one email each,
// then every two weeks until they've added it. A week before classes start, lab managers hear who still hasn't.
// Two weeks before finals they're asked for their finals times, and a week before if they still haven't.

function daysBetween(fromIso, toIso) {
  return Math.round((dateAt(toIso, "12:00") - dateAt(fromIso, "12:00")) / 86400000);
}

// A semester's finals: its own dates if a lab manager added them, or the USC "Final exams" event just after classes end.
function finalsOf(semester, events) {
  if (semester.finalsBegin && semester.finalsEnd) return { from: semester.finalsBegin, to: semester.finalsEnd };
  const exams = events.find((event) => /final exam/i.test(event.name) && event.from > semester.classesEnd && event.from <= addDaysIso(semester.classesEnd, 21));
  return exams ? { from: exams.from, to: exams.to } : null;
}

function semesterEnd(semester, events) {
  const finals = finalsOf(semester, events);
  return finals ? finals.to : semester.classesEnd;
}

// RAs who are still students in a given month. Someone who hasn't filled in a profile is asked anyway; N/A means
// they aren't a student.
function studentRa(member, profile, month) {
  if (!["ra", "member"].includes(member.role)) return false;
  if (!profile) return true;
  return profile.graduation !== "n/a" && profile.graduation >= month;
}

function pendingCreates(changeRequests, email) {
  return changeRequests.filter((request) => request.ownerEmail === email && request.status === "pending").flatMap((request) => (request.plan || {}).creates || []);
}

// Done means they've added classes for it (saved or waiting for review), or said they have none.
function hasClassSchedule(email, semester, availability, changeRequests, noClasses = []) {
  if (((noClasses.find((item) => item.id === email) || {}).semesters || []).includes(semester.id)) return true;
  const forSemester = (block) => block.type === "class" && (block.semester === semester.id || (block.from >= semester.classesBegin && block.from <= semester.classesEnd));
  return availability.some((block) => block.ownerEmail === email && forSemester(block)) || pendingCreates(changeRequests, email).some(forSemester);
}

// Finals times go in as time off or one-off conflicts during finals.
function hasFinalsTimes(email, finals, data, changeRequests) {
  const during = (from, to) => from <= finals.to && (to || from) >= finals.from;
  return data.timeOff.some((request) => request.ownerEmail === email && request.status !== "declined" && during(request.from, request.to))
    || [...data.availability.filter((block) => block.ownerEmail === email), ...pendingCreates(changeRequests, email)]
      .some((block) => block.type === "conflict" && block.to && during(block.from, block.to));
}

// A cheerful opening for where the semester is.
function semesterGreeting(semester, events, todayIso) {
  const finals = finalsOf(semester, events);
  if (todayIso <= semester.classesEnd) return `Happy (almost) end of the semester! 🎉${finals ? " Good luck with finals!" : ""}`;
  if (finals && todayIso <= finals.to) return "Good luck with finals! 📚 You've got this.";
  return "Hope you're having a nice break :)";
}

function scheduleReminderEmail(name, semester, greeting, reminder) {
  return {
    subject: reminder ? `Reminder: please add your ${semester.name} class schedule` : `Please add your ${semester.name} class schedule`,
    lines: [
      `Hi ${name},`,
      "",
      greeting,
      "",
      `${reminder ? "Just a reminder: please" : "Please"} ${bold(`add your class schedule for ${semester.name}`)} on the lab's Researcher Portal, so we know when you can work in the lab. Classes start ${dateMark(emailDateWithDay(semester.classesBegin))}.`,
      "",
      `Go to ${bold("Schedules → Update Your Availability → Class Schedule")}, choose ${semester.name}, and upload a screenshot or PDF of your schedule, or enter the times by hand: ${CONFIG.siteUrl}`,
      "",
      `Not taking classes in ${semester.name}? Click ${bold(`I have no classes in ${semester.name}`)} on that page instead, and the reminders will stop.`,
      "",
      "We'll send a reminder every two weeks until it's in. Thank you!",
    ],
  };
}

function finalsEmail(name, semester, finals, reminder) {
  return {
    subject: reminder ? "Reminder: please add your finals schedule" : `Please add your finals schedule for ${semester.name}`,
    lines: [
      `Hi ${name},`,
      "",
      "Finals are almost here. Good luck! 🍀",
      "",
      `Final exams run ${dateMark(`${emailDateWithDay(finals.from)} – ${emailDateWithDay(finals.to)}`)}. Your regular class times don't apply then, so please ${bold("add the times of your finals")} on the lab's Researcher Portal, so nobody schedules you during an exam.`,
      "",
      `Go to ${bold("Schedules → Update Your Availability → Request Time Off")} and add each exam for part of a day, or drag across its time on the Lab Calendar and choose ${bold("Doesn't repeat")}: ${CONFIG.siteUrl}`,
      "",
      reminder ? "If none of your finals clash with the lab, you can ignore this." : "If none of your finals clash with the lab, there's nothing to add.",
    ],
  };
}

// Kept free of Google services so it can be tested on its own. Returns the emails due today, one per RA, and any
// lists of missing schedules for lab managers.
function labMemberReminders(site, profiles, changeRequests, todayIso, noClasses = []) {
  const { semesters, events } = site.academic;
  const main = semesters.filter((semester) => CONFIG.scheduleSemesters.some((prefix) => semester.id.startsWith(prefix)))
    .sort((a, b) => a.classesBegin.localeCompare(b.classesBegin));
  const profileOf = (email) => profiles.find((profile) => profile.id === email) || null;
  const toRas = [];
  const missing = [];
  main.forEach((semester, index) => {
    const next = main[index + 1];
    if (next) {
      const month = next.classesBegin.slice(0, 7);
      const without = site.members.filter((member) => studentRa(member, profileOf(member.id), month)
        && !hasClassSchedule(member.id, next, site.data.availability, changeRequests, noClasses));
      const first = monthBefore(semesterEnd(semester, events));
      const since = daysBetween(first, todayIso);
      if (since >= 0 && since % 14 === 0 && todayIso < next.classesBegin) {
        const greeting = semesterGreeting(semester, events, todayIso);
        for (const member of without) toRas.push({ to: member.id, ...scheduleReminderEmail(member.name, next, greeting, since > 0) });
      }
      if (todayIso === addDaysIso(next.classesBegin, -7) && without.length) missing.push({ semester: next, people: without });
    }
    const finals = finalsOf(semester, events);
    if (finals && [14, 7].includes(daysBetween(todayIso, finals.from))) {
      const reminder = daysBetween(todayIso, finals.from) === 7;
      const month = finals.from.slice(0, 7);
      for (const member of site.members) {
        if (studentRa(member, profileOf(member.id), month) && !hasFinalsTimes(member.id, finals, site.data, changeRequests)) {
          toRas.push({ to: member.id, ...finalsEmail(member.name, semester, finals, reminder) });
        }
      }
    }
  });
  return { toRas, missing };
}

function missingSchedulesEmail(semester, people) {
  return {
    subject: `Lab schedule: ${people.length} RA${people.length === 1 ? " hasn't" : "s haven't"} added their ${semester.name} schedule`,
    lines: [
      `${semester.name} classes start ${dateMark(emailDateWithDay(semester.classesBegin))}, and ${people.length === 1 ? "this RA hasn't" : "these RAs haven't"} added their class schedule yet:`,
      "",
      ...people.map((person) => `• ${bold(person.name)} (${person.id})`),
      "",
      CONFIG.emailLabMembers ? "They've been reminded every two weeks since a month before last semester ended." : "Lab member emails are switched off for now, so they haven't been reminded.",
      `You can add it for them under ${bold("Lab Management → Lab Members → Edit Schedule")}: ${CONFIG.siteUrl}`,
    ],
  };
}

function remindLabMembers(site, profiles, changeRequests, today, noClasses = listCollection("noClasses")) {
  const { toRas, missing } = labMemberReminders(site, profiles, changeRequests, isoOf(today), noClasses);
  if (CONFIG.emailLabMembers) for (const email of toRas) sendEmail(email);
  else if (toRas.length) console.log(`${toRas.length} schedule reminder(s) due; lab member emails are switched off, so none were sent.`);
  for (const { semester, people } of missing) {
    emailReviewers(site.rules, site.members, "missingSchedules", [{ id: semester.id, owner: null }], () => missingSchedulesEmail(semester, people));
  }
  return { emailed: CONFIG.emailLabMembers ? toRas.length : 0, missing: missing.length };
}

// --- Keeping the USC calendars current ---
// From the start of the last semester the academic calendar covers (and the start of the last year of staff
// holidays), lab managers are asked to add the next dates under Website management, then monthly until they do.

// Kept free of Google services so it can be tested on its own.
function calendarDataNeeds(academic, holidays, todayIso) {
  const needs = [];
  const lastSemester = [...academic.semesters].sort((a, b) => a.classesBegin.localeCompare(b.classesBegin)).pop();
  if (lastSemester && todayIso >= lastSemester.classesBegin) {
    needs.push(`The USC academic calendar only goes through ${bold(lastSemester.name)} (classes end ${dateMark(emailDateWithDay(lastSemester.classesEnd))}).`);
  }
  const lastHoliday = [...holidays].sort((a, b) => a.to.localeCompare(b.to)).pop();
  if (lastHoliday && todayIso >= `${lastHoliday.from.slice(0, 4)}-01-01`) {
    needs.push(`The USC staff holidays only go through ${dateMark(emailDateWithDay(lastHoliday.to))}.`);
  }
  return needs;
}

function calendarDataEmail(needs) {
  return {
    subject: "Lab schedule: please add the next USC calendar dates",
    lines: [
      `The USC dates on the lab's Researcher Portal are ${bold(underline("running out"))}:`,
      "",
      ...needs.map((need) => `• ${need}`),
      "",
      `Please add the next year's dates under ${bold("Lab Management → Website Management")}: ${CONFIG.siteUrl}#website`,
      "Until they're added, classes aren't limited to semester dates and visits could be scheduled on staff holidays.",
      "",
      "USC's academic calendar: https://usc.edu/academic-calendar/",
      "We'll remind you monthly until they're in.",
    ],
  };
}

function remindCalendarData(site, today) {
  const todayIso = isoOf(today);
  const needs = calendarDataNeeds(site.academic, site.holidays, todayIso);
  const properties = PropertiesService.getScriptProperties();
  if (!needs.length) {
    properties.deleteProperty("calendarDataReminder");
    return false;
  }
  const last = properties.getProperty("calendarDataReminder");
  if (last && monthBefore(todayIso) < last) return false;
  emailReviewers(site.rules, site.members, "websiteUpdates", [{ id: "calendars", owner: null }], () => calendarDataEmail(needs));
  properties.setProperty("calendarDataReminder", todayIso);
  return true;
}

// --- Birthdays and graduations ---
// Profiles hold { birthday: "MM-DD", graduation: "YYYY-MM" or "n/a", color, dessert, dietary }. Only lab
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

// Birthdays are "MM-DD" (older ones "YYYY-MM-DD"). A Feb 29 birthday is marked on Feb 28 in other years.
function birthdayIn(birthday, year) {
  const [month, day] = birthday.slice(-5).split("-").map(Number);
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
    description: [...favoritesLines(item.profile), "", `From the Lifespan Cognition Lab Researcher Portal: ${CONFIG.siteUrl}`].join("\n"),
    start: dateAt(item.iso, "00:00"),
    end: dateAt(addDaysIso(item.iso, 1), "00:00"),
    allDay: item.iso,
  }));
}

// First and last name, from the lab list and the directory.
function fullNameOf(site, directory) {
  return (email) => {
    const first = (site.members.find((member) => member.id === email) || {}).name || email;
    const last = (directory.find((entry) => entry.id === email) || {}).lastName;
    return last ? `${first} ${last}` : first;
  };
}

function syncCelebrations(site, profiles, today, directory = listCollection("directory")) {
  const nameOf = fullNameOf(site, directory);
  // Profiles of people no longer on the lab list are left out.
  const current = profiles.filter((profile) => site.members.some((member) => member.id === profile.id));
  const wanted = buildCelebrationEvents(current, nameOf, today);
  const calendarId = calendarIdFor("celebrationsCalendarId", CONFIG.celebrationsCalendarName,
    "Birthdays and expected graduations in the Lifespan Cognition Lab, with favorites. For lab managers only.");
  writeCalendar(calendarId, wanted, today, 367);
}

// Items are celebrations with `when`: "today", "tomorrow", "in 1 week" or "in 1 month".
function celebrationsEmail(items) {
  const first = items[0];
  const subject = items.length === 1
    ? `Lab: ${first.name}'s ${first.kind === "birthday" ? "birthday" : "expected graduation"} is ${first.when}`
    : `Lab: ${items.length} birthdays and graduations coming up`;
  const lines = [];
  for (const item of items) {
    const date = item.kind === "birthday" ? emailDateWithDay(item.iso) : `${graduationText(item.profile.graduation)}, marked on ${emailDateWithDay(item.iso)}`;
    lines.push(`${bold(celebrationTitle(item))}: ${highlight(bold(item.when))} (${bold(date)})`, ...favoritesLines(item.profile).map((line) => `  ${line.replace(/^([^:]+:)/, (label) => bold(label))}`), "");
  }
  lines.push(`See everyone's details in the Lab Directory: ${CONFIG.siteUrl}`);
  return { subject, lines };
}

// Lab managers get one email a morning with any reminders due. Nobody is reminded about their own.
function remindCelebrations(site, profiles, today, directory = listCollection("directory")) {
  const nameOf = fullNameOf(site, directory);
  const current = profiles.filter((profile) => site.members.some((member) => member.id === profile.id));
  const due = celebrationReminders(current, nameOf, isoOf(today)).map((item) => ({ ...item, id: `${item.kind}:${item.email}`, owner: item.email }));
  return emailReviewers(site.rules, site.members, "celebrations", due, celebrationsEmail);
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

// Pass "lab" or "scan" for just that portion's unusual times.
function unusualLines(rules, appointment, kind) {
  const notes = rules.unusualTimes(appointment, kind);
  return notes.length ? [`${rules.SEE_TIME} These aren't the usual times:`, ...notes.map((note) => `• ${note}`), ""] : [];
}


function partLines(rules, iso, appointment, kind, result) {
  const state = rules.staffingState(result);
  const slot = appointment[kind];
  const heading = `${kind === "lab" ? "Lab portion" : "Scan"}, ${emailTime(slot.start)} – ${emailTime(slot.end)}`;
  const lines = [];
  if (state === "problem") lines.push(`${heading}: ${TITLE_MARKS.problem} can't be fully staffed`, ...result.problems.map((problem) => `• ${problem}`));
  else if (state === "tight") lines.push(`${heading}: ${TITLE_MARKS.tight} ${result.tight ? `tight timing. ${result.timing}.` : "staffable, with a warning"}`, ...(result.warnings || []).map((warning) => `• Warning: ${warning}.`));
  else lines.push(`${heading}: ${TITLE_MARKS.ready} able to be staffed`);
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
      const status = rules.visitStatus(appointment);
      const booking = appointment.booking === "rebooking" ? "rebooking"
        : status !== "open" ? status : iso >= rules.BOOKING_STARTS ? "open" : "";
      const doc = staffing.find((item) => item.visitKey === key);
      const check = doc ? rules.checkAssignment(iso, appointment, doc, data) : null;
      const tail = [...new Set([...parts.flatMap((part) => reasonsFor(rules, part.result)), ...reasonsFor(rules, managerResult)])];
      if (doc) tail.push(check.issues.length ? "staffing conflict" : "staffed");
      if (visits.length > 1) tail.push(`👥 ${visits.length} participants`);
      const seeTime = rules.unusualTimes(appointment).length > 0;
      const partsLabel = rules.visitPartsLabel(appointment);

      const lines = [...unusualLines(rules, appointment), `Whole visit: ${rules.clockTime(window.start)} – ${rules.clockTime(window.end)}${partsLabel ? ` (${partsLabel})` : ""}`];
      if (booking) lines.push(`Booking: ${BOOKING_TITLES[booking]}${appointment.bookedByName ? ` (${appointment.bookedByName})` : ""}${appointment.requestedStart && status === "booked" ? `, asked to start at ${emailTime(appointment.requestedStart)}` : ""}`);
      if (visits.length > 1) lines.push(`👥 ${visits.length} participants are scheduled this day.`);
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

// Two events per staffed visit: one for the whole visit (4 hours from the start), for the lab staff and lab manager,
// and one for the scan, for the scanners. Staff who are only needed for part of the visit are told their own times.
// Kept free of Google services so it can be tested on its own.
function buildConfirmedEvents(rules, data, appointments, holidays, staffing, today) {
  const events = [];
  const todayIso = isoOf(today);
  const nameOf = (email) => (data.members.find((member) => member.email === email) || {}).name || email;
  // Confirmed visits, whether staffed yet or not, and any staffed visit (such as fall visits booked the old way).
  const wanted = new Map();
  for (const appointment of appointments) {
    if (appointment.date >= todayIso && rules.visitStatus(appointment) === "confirmed") wanted.set(rules.visitKey(appointment), { date: appointment.date, visitKey: rules.visitKey(appointment) });
  }
  for (const doc of staffing) if (doc.date >= todayIso) wanted.set(doc.visitKey, doc);
  for (const doc of wanted.values()) {
    const visits = visitsOn(rules, doc.date, appointments, holidays);
    const index = visits.findIndex((appointment) => rules.visitKey(appointment) === doc.visitKey);
    // A cancelled visit isn't listed, so its events are removed.
    if (index === -1) continue;
    const appointment = visits[index];
    const number = visits.length > 1 ? ` (👥 visit ${index + 1} of ${visits.length} that day)` : "";
    // The visit event is flagged for the lab portion's times (or the scan's, for a scan-only visit), and the scan
    // event for the scan's, so a shorter scan doesn't flag the lab staff's invite.
    const visitPart = appointment.lab ? "lab" : "scan";
    const window = rules.visitWindow(appointment);
    const range = (from, to) => `${rules.clockTime(from)} – ${rules.clockTime(to)}`;
    const assigned = rules.assignmentLines(appointment, doc, nameOf);
    const lab = doc.lab || {};
    const scan = doc.scan || {};
    const parts = [
      appointment.lab ? `Lab portion: ${emailTime(appointment.lab.start)} – ${emailTime(appointment.lab.end)}` : "",
      appointment.scan ? `Scan: ${emailTime(appointment.scan.start)} – ${emailTime(appointment.scan.end)}` : "",
    ].filter(Boolean);
    const prefixFor = (part) => (rules.unusualTimes(appointment, part).length ? `${rules.SEE_TIME} ` : "");

    const visitPeople = [...new Set([lab.dryLab, lab.phlebotomy, lab.wetLab, ...(doc.managers || [])].filter(Boolean))];
    const unstaffed = ["Not staffed yet."];
    if (appointment.lab || visitPeople.length) {
      events.push({
        key: `${doc.visitKey}:visit`,
        title: `${prefixFor(visitPart)}Participant Visit${number}`,
        description: [
          ...unusualLines(rules, appointment, visitPart),
          `Whole visit: ${range(window.start, window.end)}`,
          ...parts,
          "",
          "Staff:",
          ...([...assigned.lab, ...assigned.managers].map((line) => `• ${line}`).concat(visitPeople.length ? [] : unstaffed)),
          "",
          "Lab staff are only needed for their own times above and don't need to come back after the scan; a lab manager finishes the visit.",
          ...(appointment.scan ? ["Scanners have a separate invite for the scan."] : []),
          "",
          `Staffing on the Lifespan Cognition Lab Researcher Portal: ${CONFIG.siteUrl}#visit=${doc.visitKey}`,
        ].join("\n"),
        start: dateAtMinutes(doc.date, window.start),
        end: dateAtMinutes(doc.date, window.end),
        attendees: visitPeople,
      });
    }

    const scanPeople = [...new Set([scan.lead, scan.support, scan.wanding].filter(Boolean))];
    if (appointment.scan) {
      events.push({
        key: `${doc.visitKey}:scan`,
        title: `${prefixFor("scan")}Participant Visit - Scan${number}`,
        description: [
          ...unusualLines(rules, appointment, "scan"),
          `Scan: ${emailTime(appointment.scan.start)} – ${emailTime(appointment.scan.end)}`,
          `Whole visit: ${range(window.start, window.end)}`,
          "",
          "Staff:",
          ...(scanPeople.length ? assigned.scan.map((line) => `• ${line}`) : unstaffed),
          ...(appointment.scan.wandingRequired === false ? ["", "Wanding/taping isn't required for this visit."] : []),
          "",
          `Lifespan Cognition Lab Researcher Portal: ${CONFIG.siteUrl}`,
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
    "Staffed participant visits, from the Lifespan Cognition Lab Researcher Portal. Filled in automatically every 10 minutes.");
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
    const parts = {};
    for (const role of rules.staffRoles(appointment, doc)) {
      (people[role.email] = people[role.email] || []).push(`${role.role}, ${rules.clockTime(role.from)}–${rules.clockTime(role.to)}`);
      (parts[role.email] = parts[role.email] || new Set()).add(role.part);
    }
    // Each person is only pointed to unusual times in the portion they work; lab managers see both.
    const seeTime = {};
    for (const [email, theirs] of Object.entries(parts)) {
      seeTime[email] = theirs.has("visit") ? rules.unusualTimes(appointment)
        : [...new Set(["lab", "scan"].filter((part) => theirs.has(part)).flatMap((part) => rules.unusualTimes(appointment, part)))];
    }
    snapshot[doc.visitKey] = {
      date: doc.date,
      visit: `${rules.clockTime(window.start)} – ${rules.clockTime(window.end)}`,
      participants: visitsOn(rules, doc.date, appointments, holidays).length,
      seeTime,
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
      const seeTime = (visit.seeTime && visit.seeTime[email]) || [];
      // Only someone's own roles and times count: a moved scan doesn't email the lab staff.
      if (!was) add(email, { type: "assigned", key, visit, roles, seeTime });
      else if (was.join("|") !== roles.join("|") || old.date !== visit.date) add(email, { type: "changed", key, visit, roles, was, oldVisit: old, seeTime });
    }
    for (const [email, roles] of Object.entries((old && old.people) || {})) {
      if (!visit.people[email]) add(email, { type: "removed", key, visit: old, roles });
    }
  }
  for (const [key, old] of Object.entries(before)) {
    // Visits that have happened are simply forgotten.
    if (after[key] || old.date < todayIso) continue;
    const type = stillScheduled(key, old.date) ? "removed" : "cancelled";
    for (const [email, roles] of Object.entries(old.people)) add(email, { type, key, visit: old, roles });
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
  const roles = (list) => list.map((role) => bold(highlight(role))).join("; ");
  for (const change of changes) {
    const date = dateMark(emailDateWithDay(change.visit.date));
    if (change.type === "assigned") {
      lines.push(`You're staffing a participant visit on ${date} (whole visit ${change.visit.visit}).`, `${bold("Your role:")} ${roles(change.roles)}`);
    } else if (change.type === "changed") {
      lines.push(`Your times ${bold(underline("changed"))} for the participant visit on ${date} (whole visit ${change.visit.visit}).`,
        `${bold(underline("Before:"))} ${change.was.join("; ")}${change.oldVisit.date !== change.visit.date ? ` on ${emailDateWithDay(change.oldVisit.date)}` : ""}`,
        `${bold(underline("Now:"))} ${roles(change.roles)}`);
    } else if (change.type === "removed") {
      lines.push(`You're ${bold(underline("no longer"))} staffing the participant visit on ${date}. You were down for: ${change.roles.join("; ")}.`);
    } else {
      lines.push(`The participant visit on ${date} (${change.visit.visit}) has been ${bold(underline("cancelled"))}. You were down for: ${change.roles.join("; ")}.`);
    }
    if (change.message) lines.push(`${bold(`Message from ${change.messageBy}:`)} ${change.message}`);
    const current = change.type === "assigned" || change.type === "changed";
    if (current && change.visit.participants > 1) lines.push(`👥 ${bold(`${change.visit.participants} participants`)} are scheduled that day, so check which visit is yours.`);
    if (current && (change.seeTime || []).length) {
      lines.push(`${highlight(bold(rules.SEE_TIME))} These ${bold("aren't the usual times")}, so please check yours:`, ...change.seeTime.map((note) => `• ${bold(note)}`));
    }
    lines.push("");
  }
  lines.push("Your Google Calendar has been updated to match. Questions? Ask the lab manager.");
  const first = changes[0];
  const seeTime = changes.some((change) => (change.type === "assigned" || change.type === "changed") && (change.seeTime || []).length);
  const subject = changes.length === 1 ? STAFF_SUBJECTS[first.type](emailDateWithDay(first.visit.date)) : `Lab visits: ${changes.length} updates for you`;
  return { subject: `${subject}${seeTime ? ` ${rules.SEE_TIME}` : ""}`, lines };
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
  // Whoever made a change could leave people off its email, or add a message (see Email choices).
  const keys = [...new Set(Object.values(changes).flat().map((change) => change.key))];
  const choices = keys.length ? loadEmailChoices(today) : new Map();
  const choiceFor = new Map(keys.map((key) => [key, takeChoice(choices, "staff", key)]));
  let emailed = 0;
  for (const [email, all] of Object.entries(changes)) {
    const theirs = all.filter((change) => !leftOut(choiceFor.get(change.key), email)).map((change) => {
      const choice = choiceFor.get(change.key);
      return choice && choice.message ? { ...change, message: choice.message, messageBy: choice.byName || choice.by } : change;
    });
    if (!theirs.length) continue;
    sendEmail({ to: email, ...staffEmail(rules, nameOf(email), theirs) });
    emailed++;
  }
  for (const key of Object.keys(before)) if (!after[key]) properties.deleteProperty(`staff:${key}`);
  for (const [key, visit] of Object.entries(after)) properties.setProperty(`staff:${key}`, JSON.stringify(visit));
  if (emailed) console.log(`Emailed ${emailed} staff member(s) about their visits.`);
  return { emailed };
}

// --- Test emails ---
// Run sendTestEmails from the Apps Script editor to see one sample of every email the lab sends (the booker's comes
// from the site, so it's shown here as the plain text it drafts). They all go to
// CONFIG.testEmailsTo alone, with [TEST] in the subject, using made-up people and visits; nobody else is emailed and
// nothing is saved.
function sendTestEmails() {
  const rules = loadRules();
  const to = CONFIG.testEmailsTo;
  let sent = 0;
  const send = (audience, { subject, lines, footer = [] }) => {
    sendEmail({ to, subject: `[TEST] ${subject}`, lines: [`(Test email: this is what ${audience} get.)`, "", ...lines], footer });
    sent++;
  };
  const reviewers = [{ name: "Alex" }, { name: "Sam" }];
  const toReviewers = ({ subject, lines }) => send("lab managers", { subject, lines: reviewerLines(reviewers, lines), footer: [EMAIL_FOOTER] });
  const nameOf = (email) => ({ "jordan@usc.edu": "Jordan", "taylor@usc.edu": "Taylor", "alex@usc.edu": "Alex" }[email] || email);
  const profile = { birthday: "12-10", graduation: "2027-05", color: "Teal", dessert: "Tiramisu", dietary: "Tree nut allergy" };
  const usual = { defaultFor: "2027-01-12", lab: { start: "09:00", end: "11:00" }, scan: { start: "11:00", end: "13:00", wandingRequired: true } };
  // A booked visit starting at 9:30 with a 90-minute scan, to show the time alerts.
  const late = { lab: { start: "09:30", end: "11:30" }, scan: { start: "11:30", end: "13:00", wandingRequired: true }, booking: "booked", confirmed: true };
  const spring = { id: "spring-2027", name: "Spring 2027", classesBegin: "2027-01-11", classesEnd: "2027-04-30" };

  toReviewers(requestsEmail([
    { owner: "jordan@usc.edu", text: `Time off: ${describeTimeOffForEmail({ from: "2027-01-20", to: "2027-01-20", start: "14:00", end: "16:00", note: "Doctor's appointment" })}` },
    { owner: "taylor@usc.edu", text: 'Schedule change: Add "Unavailable, standing conflict (Lab meeting): Fri, 1:00 PM – 2:00 PM"' },
  ], nameOf));
  toReviewers(updatesEmail([{ owner: "taylor@usc.edu", text: "Time off: Feb 3, 2027 (Conference)" }], nameOf));
  toReviewers(cancellationsEmail(rules, [{ key: "default-2027-01-12", kind: "booking", visit: { date: "2027-01-12", times: "9:00 AM – 1:00 PM", by: "Jordan", seeTime: false } }]));
  toReviewers(cancellationsEmail(rules, [{ key: "x", kind: "visit", visit: { date: "2027-01-14", times: "9:00 AM – 1:00 PM", seeTime: true } }]));
  toReviewers(scanReminderEmail(rules, "2027-01-12", usual));
  toReviewers(celebrationsEmail([{ iso: "2026-12-10", kind: "birthday", name: "Jordan Lee", profile, when: "in 1 week" }]));
  toReviewers(celebrationsEmail([
    { iso: "2026-12-10", kind: "birthday", name: "Jordan Lee", profile, when: "today" },
    { iso: "2027-05-01", kind: "graduation", name: "Taylor Kim", profile: { ...profile, dietary: "Vegetarian" }, when: "in 1 month" },
  ]));
  toReviewers(missingSchedulesEmail(spring, [{ id: "jordan@usc.edu", name: "Jordan" }, { id: "taylor@usc.edu", name: "Taylor" }]));
  toReviewers(calendarDataEmail([
    `The USC academic calendar only goes through ${bold("Summer 2029")} (classes end ${dateMark("Tue, Aug 7, 2029")}).`,
    `The USC staff holidays only go through ${dateMark("Tue, Jan 1, 2030")}.`,
  ]));

  const booker = rules.bookingEmail({
    when: "Tue, Jan 12, 2027, 9:00 AM – 1:00 PM",
    parts: "Lab portion 9:00 AM – 11:00 AM · Scan 11:00 AM – 1:00 PM",
    requestedStart: "9:30 AM",
    link: `${CONFIG.siteUrl}#visit=default-2027-01-12`,
  });
  send("reviewers from a booker (the site drafts it in the booker's own email, as plain text; they fill in the Screener ID)", { subject: booker.subject, lines: booker.body.split("\n") });

  const visit = { date: "2027-01-12", visit: "9:30 AM – 1:30 PM", participants: 2, people: {} };
  const roles = ["Phlebotomy, 9:30 AM–10:00 AM", "Wet Lab, 10:00 AM–12:00 PM"];
  // Lab staff hear about the start time, but not the shorter scan.
  const seeTime = rules.unusualTimes(late, "lab");
  const staffSample = (changes) => send("staff (once staff emails are switched on)", staffEmail(rules, "Jordan", changes));
  staffSample([{ type: "assigned", visit, roles, seeTime }]);
  staffSample([{ type: "changed", visit, roles: ["Phlebotomy, 9:30 AM–10:00 AM", "Wet Lab, 10:15 AM–12:15 PM"], was: roles, oldVisit: visit, seeTime }]);
  staffSample([{ type: "removed", visit, roles }]);
  staffSample([{ type: "cancelled", visit, roles }]);
  staffSample([{ type: "assigned", visit, roles, seeTime }, { type: "cancelled", visit: { ...visit, date: "2027-01-14" }, roles: ["Lead scanner, 11:00 AM–1:00 PM"] }]);

  const toMember = "RAs and other lab members (once lab member emails are switched on)";
  send(toMember, reviewResultEmail({ kind: "timeOff", ownerEmail: "jordan@usc.edu", reviewedBy: "alex@usc.edu", status: "approved", from: "2027-01-20", to: "2027-01-20", start: "14:00", end: "16:00", note: "Doctor's appointment", reviewNote: "Feel better!" }, nameOf));
  send(toMember, reviewResultEmail({ kind: "changeRequests", ownerEmail: "jordan@usc.edu", reviewedBy: "alex@usc.edu", status: "declined", summary: 'Remove "Unavailable, class: Mon, 9:00 AM – 10:00 AM"', reviewNote: "That class is still on your schedule." }, nameOf));
  send(toMember, scheduleReminderEmail("Jordan", spring, "Happy (almost) end of the semester! 🎉 Good luck with finals!", false));
  send(toMember, scheduleReminderEmail("Jordan", spring, "Hope you're having a nice break :)", true));
  send(toMember, finalsEmail("Jordan", { name: "Fall 2026" }, { from: "2026-12-09", to: "2026-12-16" }, false));
  send(toMember, finalsEmail("Jordan", { name: "Fall 2026" }, { from: "2026-12-09", to: "2026-12-16" }, true));
  console.log(`Sent ${sent} test emails to ${to}.`);
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
