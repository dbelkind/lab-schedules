// Staffing rules for participant visits. Nothing here touches the page, so the same rules run on the website,
// in tests, and in the Google Apps Script that copies staffing to Google Calendar (apps-script/Code.gs).

// Phlebotomy levels, most experienced first. Each person has at most one.
const PHLEBOTOMY_LEVELS = ["Experienced Phlebotomist", "Phlebotomist", "Training Phlebotomist"];
const PHLEBOTOMY_TAGS = ["Experienced", "Regular", "Training"];
const SKILLS = ["Wet Lab", "Dry Lab", ...PHLEBOTOMY_LEVELS, "Level 1 Scanning", "Level 2 Scanning", "Auxiliary Support Scanning"];
// Training saved under older names is read under the new ones. Phlebotomy from before there were levels counts as Phlebotomist.
const SKILL_RENAMES = {
  "Level 1 Scanner": "Level 1 Scanning",
  "Level 2 Scanner": "Level 2 Scanning",
  "Auxiliary Support Scanner": "Auxiliary Support Scanning",
  Phlebotomy: "Phlebotomist",
};
const SECONDARY_SKILLS = ["Wanding/Taping"];
// Responsibilities aren't staffing roles. Booking lets someone book participants into visits.
const RESPONSIBILITIES = ["Booking"];
// The emails reviewers can each turn on or off. Staff emails about visits they're staffing can't be turned off.
const REVIEWER_EMAILS = [
  { key: "requests", label: "Requests to review", help: "Time off requests and schedule changes from RAs, within about 10 minutes. Your own aren't emailed to you." },
  { key: "updates", label: "Saved schedule changes", help: "Changes and time off that Grad Students/Post-Docs save without review." },
  { key: "cancellations", label: "Cancellations", help: "Straight away when a booking is cancelled (the visit stays open to rebook), or a booked or staffed visit is cancelled. Bookings themselves come from the booker's own email." },
  { key: "scanReminders", label: "Scan booking reminder", help: "At 8:30 AM each morning, which newly opened visit needs its scan booked." },
  { key: "missingSchedules", label: "Missing class schedules", help: "A week before a semester starts, which RAs still haven't added their class schedule." },
  { key: "websiteUpdates", label: "Website updates", help: "When the USC academic calendar or staff holidays need the next year's dates added, then monthly until they're in." },
  { key: "celebrations", label: "Birthdays and graduations", help: "At 8:30 AM, 1 month, 1 week and 1 day before, and on the day, with their favorite color, dessert and dietary restrictions/allergies." },
];
// What each person is in the lab directory. It's only a label: what someone can do on the site comes from their role.
const DIRECTORY_TITLES = ["RA", "PhD Student", "Post-Doc", "Lab Manager", "PI"];

// Birthdays are kept as "MM-DD", without the year. Ones saved before that ("YYYY-MM-DD") read the same way.
function birthdayMonthDay(birthday) {
  return String(birthday || "").slice(-5);
}

// Someone whose directory role hasn't been chosen yet gets one from their site role. firestore.rules matches this.
function titleOf(member) {
  if (member.title) return member.title;
  return member.role === "reviewer" ? "Lab Manager" : member.role === "grad" ? "PhD Student" : "RA";
}

// Marks a visit whose times aren't the usual ones, wherever it's shown.
const SEE_TIME = "🕒 [SEE TIME]";

// Before there were separate settings, one switch covered every email, so it still applies to any not set yet.
function wantsEmail(member, kind) {
  if (member.emails && kind in member.emails) return member.emails[kind] !== false;
  return member.notify !== false;
}
const DEFAULT_SLOTS = {
  lab: { start: "09:00", end: "11:00" },
  scan: { start: "11:00", end: "13:00", wandingRequired: true },
};
const SLOT_TITLES = { lab: "Participant Visit - Lab", scan: "Participant Visit - Scan" };
const REGULAR_HOURS = { start: "08:00", end: "17:00" };
// A full visit lasts 4 hours from its start, even when the lab and scan portions take less. After the scan,
// a lab manager finishes up the visit; that wrap-up is at least the last 30 minutes.
const VISIT_MINUTES = 240;
const WRAP_UP_MINUTES = 30;
// Default visits open 60 days ahead, with the newest day added at 8:00 AM each morning.
const VISITS_DAYS_AHEAD = 60;
const VISITS_OPEN_HOUR = 8;
// Booking on the website starts with the spring 2027 visits. Earlier ones were booked the old way.
const BOOKING_STARTS = "2027-01-03";

function isoWeekday(iso) {
  const [y, month, day] = iso.split("-").map(Number);
  return new Date(y, month - 1, day).getDay();
}

function staffHolidayOn(iso, holidays) {
  return holidays.find((holiday) => holiday.from <= iso && iso <= holiday.to) || null;
}

function isoOfDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftIsoDays(iso, count) {
  const [y, month, day] = iso.split("-").map(Number);
  return isoOfDate(new Date(y, month - 1, day + count));
}

// The last date that has its default visit yet: 60 days from today from 8:00 AM, 59 before then.
function defaultVisitsThrough(now) {
  const ahead = VISITS_DAYS_AHEAD - (now.getHours() < VISITS_OPEN_HOUR ? 1 : 0);
  return isoOfDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
}

// Every weekday that isn't a staff holiday gets a default visit, up to `through` when it's given.
// Saved records only hold changes to it, plus extra visits.
function appointmentsOn(iso, stored, holidays, through) {
  const list = [];
  const weekday = isoWeekday(iso);
  if (weekday !== 0 && weekday !== 6 && !staffHolidayOn(iso, holidays) && (!through || iso <= through)) {
    const override = stored.find((appointment) => appointment.defaultFor === iso);
    if (!override) {
      list.push({ id: null, defaultFor: iso, date: iso, lab: { ...DEFAULT_SLOTS.lab }, scan: { ...DEFAULT_SLOTS.scan } });
    } else if (!override.cancelled) {
      list.push(override);
    }
  }
  for (const appointment of stored) {
    if (!appointment.defaultFor && appointment.date === iso && !appointment.cancelled) list.push(appointment);
  }
  return list;
}

function cancelledDefaultOn(iso, stored) {
  return stored.find((appointment) => appointment.defaultFor === iso && appointment.cancelled) || null;
}

// Staffing and invites are stored under this key, which stays the same when a default visit is first changed.
function visitKey(appointment) {
  return appointment.id || `default-${appointment.defaultFor}`;
}

// In minutes: when the visit starts and ends, and when the wrap-up after the scan starts.
// A visit with only one part lasts as long as that part.
function visitWindow(appointment) {
  const parts = ["lab", "scan"].filter((kind) => appointment[kind]).map((kind) => appointment[kind]);
  const start = Math.min(...parts.map((part) => timeToMinutes(part.start)));
  const partsEnd = Math.max(...parts.map((part) => timeToMinutes(part.end)));
  const end = appointment.lab && appointment.scan ? Math.max(start + VISIT_MINUTES, partsEnd) : partsEnd;
  const afterScan = appointment.scan ? timeToMinutes(appointment.scan.end) : partsEnd;
  return { start, end, wrapUpStart: Math.max(start, Math.min(afterScan, end - WRAP_UP_MINUTES)) };
}

function lengthText(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [];
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest) parts.push(`${rest} minutes`);
  return parts.join(" ");
}

// Booked and confirmed visits that don't start at 9:00 AM get 🕒 [SEE TIME], so nobody turns up at the usual time
// by mistake. A scan shorter than 2 hours is noted too, but only for the scan: pass "scan" for the scan's notes,
// "lab" for the lab portion's, or nothing for the whole visit. Open slots aren't flagged.
function unusualTimes(appointment, only) {
  if (!isBooked(appointment)) return [];
  const notes = [];
  const start = visitWindow(appointment).start;
  const usualStart = timeToMinutes(DEFAULT_SLOTS.lab.start);
  if (start !== usualStart) notes.push(`Starts at ${clockTime(start)} instead of ${clockTime(usualStart)}`);
  if (only !== "lab" && appointment.scan) {
    const length = timeToMinutes(appointment.scan.end) - timeToMinutes(appointment.scan.start);
    if (length < 120) notes.push(`Scan is only ${lengthText(length)} long`);
  }
  return notes;
}

// Where a visit is in booking: "open" (including a cancelled booking waiting to be rebooked), "booked" (waiting for
// a reviewer to confirm it) or "confirmed".
function visitStatus(appointment) {
  if (appointment.booking !== "booked") return "open";
  return appointment.confirmed ? "confirmed" : "booked";
}

function isBooked(appointment) {
  return visitStatus(appointment) !== "open";
}

// A visit's lab portion and scan from its start time and scan times: the lab portion runs 2 hours from the start,
// or until the scan if that's sooner. Times are "HH:MM".
function visitPartsFrom(start, scanStart, scanEnd, wandingRequired = true) {
  const from = timeToMinutes(start);
  const scanFrom = timeToMinutes(scanStart);
  const labEnd = scanFrom > from && scanFrom < from + 120 ? scanFrom : from + 120;
  return {
    lab: { start, end: clockOf(labEnd) },
    scan: { start: scanStart, end: scanEnd, wandingRequired },
  };
}

// The start times a booker can ask for instead of the slot's, which a reviewer has to approve.
const REQUESTABLE_STARTS = ["08:00", "08:15", "08:30", "08:45", "09:00", "09:15", "09:30", "09:45", "10:00"];

function visitPartsLabel(appointment) {
  if (appointment.lab && appointment.scan) return "";
  return appointment.lab ? "Lab portion only" : "Scan only";
}

function isOffHours(iso, start, end) {
  const weekday = isoWeekday(iso);
  return weekday === 0 || weekday === 6 || start < REGULAR_HOURS.start || end > REGULAR_HOURS.end;
}

function normalizeSkills(skills) {
  const renamed = [...new Set((skills || []).map((skill) => SKILL_RENAMES[skill] || skill))];
  // Only the highest phlebotomy level is kept.
  const level = PHLEBOTOMY_LEVELS.find((name) => renamed.includes(name));
  return renamed.filter((skill) => !PHLEBOTOMY_LEVELS.includes(skill) || skill === level);
}

// 0 for Experienced Phlebotomist, 1 for Phlebotomist, 2 for Training Phlebotomist, -1 for none.
function phlebotomyLevel(person) {
  return PHLEBOTOMY_LEVELS.findIndex((level) => person.skills.includes(level));
}

function withSkill(people, skill) {
  return people.filter((person) => person.skills.includes(skill));
}

const PHLEBOTOMY_MINUTES = 30;
const WET_LAB_MINUTES = 120;
const MAX_GAP_MINUTES = 30;
const TIMING_STEP_MINUTES = 5;

function clockTime(minutes) {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour < 12 || hour === 24 ? "AM" : "PM"}`;
}

// People without an isFree check (as in simple tests) count as free all day.
function freeBetween(person, from, to) {
  return person.isFree ? person.isFree(from, to) : true;
}

// The stretches of [from, to] someone is free, as [start, end] in minutes.
function freeIntervals(person, from, to) {
  const stretches = [];
  let runStart = null;
  for (let minute = from; minute < to; minute += TIMING_STEP_MINUTES) {
    const free = freeBetween(person, minute, minute + TIMING_STEP_MINUTES);
    if (free && runStart === null) runStart = minute;
    if (!free && runStart !== null) {
      stretches.push([runStart, minute]);
      runStart = null;
    }
  }
  if (runStart !== null) stretches.push([runStart, to]);
  return stretches;
}

// The same, as text such as "9:30 AM–10:30 AM".
function freeStretches(person, from, to) {
  return freeIntervals(person, from, to).map(([start, end]) => `${clockTime(start)}–${clockTime(end)}`);
}

// Wet Lab takes 2 hours and has to start no more than 30 minutes after phlebotomy ends. It may run past the slot.
function wetLabStarts(person, phlebotomyAt) {
  const starts = [];
  const earliest = phlebotomyAt + PHLEBOTOMY_MINUTES;
  for (let start = earliest; start <= earliest + MAX_GAP_MINUTES; start += TIMING_STEP_MINUTES) {
    if (freeBetween(person, start, start + WET_LAB_MINUTES)) starts.push(start);
  }
  return starts;
}

// Dry Lab needs someone for the whole slot. Phlebotomy needs 30 minutes at any point in the slot. Wet Lab follows
// phlebotomy as above, and must be a different person from Dry Lab. A slot is "tight" when it only works with a
// particular timing, rather than phlebotomy at the start and Wet Lab straight after.
// Phlebotomy goes to the most experienced level that works: without an Experienced Phlebotomist the slot gets a
// warning, and with only a Training Phlebotomist it can't be staffed unless mobile phlebotomy is booked.
function evaluateLab(people, slot = DEFAULT_SLOTS.lab) {
  const slotStart = timeToMinutes(slot.start);
  const slotEnd = timeToMinutes(slot.end);
  const dry = withSkill(people, "Dry Lab").filter((person) => freeBetween(person, slotStart, slotEnd));
  const phlebotomists = people.filter((person) => phlebotomyLevel(person) >= 0)
    .sort((a, b) => phlebotomyLevel(a) - phlebotomyLevel(b));
  const wetLabbers = withSkill(people, "Wet Lab");

  const options = [];
  for (let at = slotStart; at + PHLEBOTOMY_MINUTES <= slotEnd; at += TIMING_STEP_MINUTES) {
    options.push({
      at,
      phlebotomy: phlebotomists.filter((person) => freeBetween(person, at, at + PHLEBOTOMY_MINUTES)),
      wet: wetLabbers.flatMap((person) => wetLabStarts(person, at).map((start) => ({ person, start }))),
    });
  }
  const phlebotomy = phlebotomists.filter((person) => options.some((option) => option.phlebotomy.includes(person)));
  const wet = wetLabbers.filter((person) => options.some((option) => option.wet.some((choice) => choice.person === person)));

  const plans = [];
  for (const option of options) {
    if (!option.phlebotomy.length) continue;
    const choice = option.wet.find((candidate) => dry.some((dryPerson) => dryPerson !== candidate.person));
    if (choice) plans.push({ phlebotomyAt: option.at, wetStart: choice.start, level: phlebotomyLevel(option.phlebotomy[0]) });
  }

  const problems = [];
  const flags = [];
  if (!wet.length) problems.push("No one available for Wet Lab");
  if (!dry.length) problems.push("No one available for Dry Lab");
  if (!phlebotomy.length) problems.push("No one available for Phlebotomy");
  if (!problems.length && !plans.length) {
    const timingWorks = options.some((option) => option.phlebotomy.length && option.wet.length);
    problems.push(timingWorks
      ? `Wet Lab and Dry Lab need two different people, but only ${wet[0].name} is available for them`
      : "Phlebotomy and Wet Lab can't be lined up: Wet Lab needs 2 hours, starting within 30 minutes after phlebotomy ends");
  }

  const level = Math.min(...(plans.length ? plans.map((plan) => plan.level) : phlebotomy.map(phlebotomyLevel)));
  const warnings = [];
  if (level === 2) {
    problems.push("Only a Training Phlebotomist is available: this visit can only be staffed if mobile phlebotomy is booked in advance");
  } else if (level === 1) {
    warnings.push("No Experienced Phlebotomist is available: mobile phlebotomy may need to be on stand-by, and if the participant has difficult veins, book mobile phlebotomy in advance");
    flags.push("No experienced phlebotomist");
  }

  const levelPlans = plans.filter((plan) => plan.level === level);
  const standard = levelPlans.find((plan) => plan.phlebotomyAt === slotStart && plan.wetStart === slotStart + PHLEBOTOMY_MINUTES);
  const tight = !problems.length && !standard;
  const plan = problems.length ? null : standard || levelPlans[0];

  // Anyone who can only help at certain times is marked, with the details listed under the names.
  const notes = [];
  const markPhlebotomy = phlebotomy.map((person) => {
    const tagged = { ...person, tag: PHLEBOTOMY_TAGS[phlebotomyLevel(person)] };
    if (freeBetween(person, slotStart, slotEnd)) return tagged;
    notes.push(`${person.name} (Phlebotomy): free ${freeStretches(person, slotStart, slotEnd).join(", ")}`);
    return { ...tagged, limited: true };
  });
  const markWet = wet.map((person) => {
    if (wetLabStarts(person, slotStart).includes(slotStart + PHLEBOTOMY_MINUTES)) return person;
    const starts = [...new Set(options.flatMap((option) => option.wet.filter((choice) => choice.person === person).map((choice) => choice.start)))].sort((a, b) => a - b);
    const range = starts[0] === starts[starts.length - 1] ? `at ${clockTime(starts[0])}` : `between ${clockTime(starts[0])} and ${clockTime(starts[starts.length - 1])}`;
    notes.push(`${person.name} (Wet Lab): can only start ${range}`);
    return { ...person, limited: true };
  });

  return {
    groups: [
      { label: "Wet Lab", people: markWet },
      { label: "Dry Lab", people: dry },
      { label: "Phlebotomy", people: markPhlebotomy },
    ],
    problems,
    warnings,
    flags,
    tight,
    timing: plan && tight
      ? `Works if phlebotomy is at ${clockTime(plan.phlebotomyAt)} and Wet Lab runs ${clockTime(plan.wetStart)}–${clockTime(plan.wetStart + WET_LAB_MINUTES)}`
      : "",
    notes,
  };
}

// For showing a result: "problem", "tight" (amber: tight timing or a warning) or "ready", and names with an asterisk
// when someone is only free part of the time, plus their phlebotomy level.
function staffingState(result) {
  if (result.problems.length) return "problem";
  return result.tight || (result.warnings || []).length ? "tight" : "ready";
}

function personLabel(person) {
  return `${person.name}${person.limited ? "*" : ""}${person.tag ? ` (${person.tag})` : ""}`;
}

// Two scanners are needed. Auxiliary support only counts alongside someone with Level 2 Scanning,
// and outside regular hours one of the two must have Level 2 Scanning.
function evaluateScan(people, { offHours, wandingRequired }) {
  const level2 = withSkill(people, "Level 2 Scanning");
  const level1 = withSkill(people, "Level 1 Scanning").filter((person) => !level2.includes(person));
  const auxiliary = withSkill(people, "Auxiliary Support Scanning")
    .filter((person) => !level2.includes(person) && !level1.includes(person));
  const scannerCount = level2.length + level1.length + auxiliary.length;
  const problems = [];

  if (offHours) {
    if (!level2.length) {
      problems.push("Outside regular hours (weekdays 8 AM–5 PM) someone with Level 2 Scanning is required, and no one is available");
    } else if (scannerCount < 2) {
      problems.push("Needs 2 scanners, but only 1 is available");
    }
  } else {
    const staffed = level1.length + level2.length >= 2 || (level2.length >= 1 && auxiliary.length >= 1);
    if (!staffed && scannerCount < 2) {
      problems.push(`Needs 2 scanners, but ${scannerCount ? "only 1 is" : "none are"} available`);
    } else if (!staffed) {
      problems.push("Auxiliary Support Scanning must be paired with someone with Level 2 Scanning, and no one is available");
    }
  }
  const wanding = withSkill(people, "Wanding/Taping");
  if (wandingRequired && !wanding.length) problems.push("No one available for wanding/taping");

  return {
    groups: [
      { label: "Lead Scanners Available", people: offHours ? level2 : [...level2, ...level1] },
      { label: "Support Scanners Available", people: offHours ? [...level1, ...auxiliary] : auxiliary },
      { label: "Wanding/Taping Available", people: wanding },
    ],
    problems,
    warnings: [],
    flags: [],
  };
}

// --- Who is free for a visit ---
// `data` is { members, availability, timeOff, semesters, events }: everyone's saved entries plus the USC academic calendar.

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timeToMinutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function academicDayOff(iso, events) {
  return events.some((event) => event.from <= iso && iso <= event.to && (event.kind === "holiday" || event.kind === "break"));
}

// Classes only meet between the first and last day of a semester, and not on holidays or recesses.
function classesMeetOn(iso, semesters, events) {
  if (!semesters.length) return true;
  const inSemester = semesters.some((semester) => semester.classesBegin <= iso && iso <= semester.classesEnd);
  return inSemester && !academicDayOff(iso, events);
}

function isBusyDuring(email, iso, startMinutes, endMinutes, data) {
  const weekday = WEEKDAY_NAMES[isoWeekday(iso)];
  const inClassOrConflict = data.availability.some((block) =>
    block.ownerEmail === email && block.from <= iso && (!block.to || iso <= block.to) && block.days.includes(weekday) &&
    (block.type !== "class" || classesMeetOn(iso, data.semesters, data.events)) &&
    timeToMinutes(block.start) < endMinutes && startMinutes < timeToMinutes(block.end));
  // Time off waiting for review still counts, so nobody is scheduled on a day they've asked to be away.
  const away = data.timeOff.some((request) =>
    request.ownerEmail === email && request.status !== "declined" && request.from <= iso && iso <= request.to &&
    (!request.start || (timeToMinutes(request.start) < endMinutes && startMinutes < timeToMinutes(request.end))));
  return inClassOrConflict || away;
}

function peopleAvailable(iso, start, end, data) {
  return data.members
    .filter((member) => (member.skills || []).length)
    .filter((member) => !isBusyDuring(member.email, iso, timeToMinutes(start), timeToMinutes(end), data))
    .map((member) => ({ name: member.name, email: member.email, skills: member.skills }));
}

// People with their free time on a date, checked as it's needed. By default only people with training.
function candidatesOn(iso, data, include = (member) => (member.skills || []).length) {
  return data.members.filter(include).map((member) => ({
    name: member.name,
    email: member.email,
    skills: member.skills || [],
    role: member.role,
    isFree: (from, to) => !isBusyDuring(member.email, iso, from, to, data),
  }));
}

function evaluateVisitSlot(iso, slot, kind, data) {
  if (kind === "lab") {
    // Lab roles don't all need the whole slot, so each person's free time is checked as the timing is worked out.
    return evaluateLab(candidatesOn(iso, data), slot);
  }
  const people = peopleAvailable(iso, slot.start, slot.end, data);
  return evaluateScan(people, { offHours: isOffHours(iso, slot.start, slot.end), wandingRequired: slot.wandingRequired !== false });
}

// --- Lab managers ---
// Reviewers are the lab managers. Ideally they cover the whole visit between them (handing off is fine);
// at the very least one must be there for the wrap-up after the scan.

function managerCandidates(iso, data) {
  return candidatesOn(iso, data, (member) => member.role === "reviewer");
}

// The stretches of [from, to] when none of these people are free.
function uncoveredStretches(people, from, to) {
  const gaps = [];
  let gapStart = null;
  for (let minute = from; minute < to; minute += TIMING_STEP_MINUTES) {
    const covered = people.some((person) => freeBetween(person, minute, Math.min(minute + TIMING_STEP_MINUTES, to)));
    if (!covered && gapStart === null) gapStart = minute;
    if (covered && gapStart !== null) {
      gaps.push([gapStart, minute]);
      gapStart = null;
    }
  }
  if (gapStart !== null) gaps.push([gapStart, to]);
  return gaps;
}

function stretchText(stretches) {
  return stretches.map(([from, to]) => `${clockTime(from)}–${clockTime(to)}`).join(", ");
}

function evaluateManagers(managers, { start, end, wrapUpStart }) {
  const notes = [];
  const present = managers.filter((manager) => freeStretches(manager, start, end).length);
  const people = present.map((manager) => {
    if (freeBetween(manager, start, end)) return manager;
    notes.push(`${manager.name} (Lab manager): free ${freeStretches(manager, start, end).join(", ")}`);
    return { ...manager, limited: true };
  });
  const problems = [];
  const warnings = [];
  const flags = [];
  const wrapUpGaps = uncoveredStretches(present, wrapUpStart, end);
  const gaps = uncoveredStretches(present, start, end);
  if (!present.length) {
    problems.push("No lab manager is free during this visit");
  } else if (wrapUpGaps.length) {
    problems.push(`No lab manager is free for the wrap-up at the end of the visit (${clockTime(wrapUpStart)}–${clockTime(end)})`);
  } else if (gaps.length) {
    warnings.push(`Lab managers can't cover the whole visit (no one is free ${stretchText(gaps)}), though someone is free for the wrap-up at the end`);
    flags.push("Lab manager gaps");
  }
  return { group: { label: "Lab Manager", people }, problems, warnings, flags, notes };
}

// One part of a visit, plus the lab manager check for the visit as a whole.
function evaluateVisitPart(iso, appointment, kind, data) {
  const part = evaluateVisitSlot(iso, appointment[kind], kind, data);
  const managers = evaluateManagers(managerCandidates(iso, data), visitWindow(appointment));
  return {
    ...part,
    groups: [...part.groups, managers.group],
    problems: [...part.problems, ...managers.problems],
    warnings: [...(part.warnings || []), ...managers.warnings],
    flags: [...(part.flags || []), ...managers.flags],
    notes: [...(part.notes || []), ...managers.notes],
  };
}

// --- Suggested staffing ---
// Assignments are saved per visit as { date, visitKey, lab: { dryLab, phlebotomy, phlebotomyAt, wetLab, wetLabStart },
// scan: { lead, support, wanding }, managers: [emails] }, with emails for people and "HH:MM" for times.

function clockOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function staffedEmails(assignment) {
  const lab = assignment.lab || {};
  const scan = assignment.scan || {};
  return [lab.dryLab, lab.phlebotomy, lab.wetLab, scan.lead, scan.support, scan.wanding, ...(assignment.managers || [])].filter(Boolean);
}

// How many visits each person is staffing within four weeks either side of a date, so suggestions rotate people fairly.
function staffingLoads(staffing, iso, exceptKey) {
  const from = shiftIsoDays(iso, -28);
  const to = shiftIsoDays(iso, 28);
  const loads = new Map();
  for (const doc of staffing) {
    if (doc.visitKey === exceptKey || doc.date < from || doc.date > to) continue;
    for (const email of new Set(staffedEmails(doc))) loads.set(email, (loads.get(email) || 0) + 1);
  }
  return loads;
}

function loadOf(loads, people) {
  return [...new Set(people)].reduce((sum, person) => sum + (loads.get(person.email) || 0), 0);
}

// The earliest timing that works for this phlebotomist and Wet Lab person, so phlebotomy at the start and Wet Lab
// straight after whenever they can.
function labTiming(slot, phlebotomist, wetLabber) {
  const slotStart = timeToMinutes(slot.start);
  const slotEnd = timeToMinutes(slot.end);
  for (let at = slotStart; at + PHLEBOTOMY_MINUTES <= slotEnd; at += TIMING_STEP_MINUTES) {
    if (!freeBetween(phlebotomist, at, at + PHLEBOTOMY_MINUTES)) continue;
    const [wetStart] = wetLabStarts(wetLabber, at);
    if (wetStart !== undefined) return { phlebotomyAt: at, wetStart, standard: at === slotStart && wetStart === slotStart + PHLEBOTOMY_MINUTES };
  }
  return null;
}

// Ranked by phlebotomy level, then by who has the fewest visits nearby, then by the usual timing.
function labOptions(iso, slot, data, loads, limit = 3) {
  const people = candidatesOn(iso, data);
  const dry = withSkill(people, "Dry Lab").filter((person) => freeBetween(person, timeToMinutes(slot.start), timeToMinutes(slot.end)));
  const phlebotomists = people.filter((person) => phlebotomyLevel(person) >= 0);
  const wetLabbers = withSkill(people, "Wet Lab");
  const timings = new Map();
  const timingFor = (phlebotomist, wetLabber) => {
    const key = `${phlebotomist.email}|${wetLabber.email}`;
    if (!timings.has(key)) timings.set(key, labTiming(slot, phlebotomist, wetLabber));
    return timings.get(key);
  };
  const options = [];
  for (const dryPerson of dry) {
    for (const phlebotomist of phlebotomists) {
      for (const wetLabber of wetLabbers) {
        if (wetLabber === dryPerson) continue;
        const timing = timingFor(phlebotomist, wetLabber);
        if (!timing) continue;
        options.push({
          dryLab: dryPerson.email,
          phlebotomy: phlebotomist.email,
          phlebotomyAt: clockOf(timing.phlebotomyAt),
          wetLab: wetLabber.email,
          wetLabStart: clockOf(timing.wetStart),
          level: phlebotomyLevel(phlebotomist),
          standard: timing.standard,
          load: loadOf(loads, [dryPerson, phlebotomist, wetLabber]),
          names: `${dryPerson.name} ${phlebotomist.name} ${wetLabber.name}`,
        });
      }
    }
  }
  options.sort((a, b) => a.level - b.level || a.load - b.load || Number(b.standard) - Number(a.standard) || a.names.localeCompare(b.names));
  return options.slice(0, limit);
}

function canLeadScan(person, offHours) {
  return person.skills.includes("Level 2 Scanning") || (!offHours && person.skills.includes("Level 1 Scanning"));
}

function isScanner(person) {
  return ["Level 1 Scanning", "Level 2 Scanning", "Auxiliary Support Scanning"].some((skill) => person.skills.includes(skill));
}

// Auxiliary Support Scanning only counts alongside someone with Level 2 Scanning.
function canSupportScan(support, lead) {
  if (!isScanner(support)) return false;
  const fullScanner = support.skills.includes("Level 1 Scanning") || support.skills.includes("Level 2 Scanning");
  return fullScanner || lead.skills.includes("Level 2 Scanning");
}

// A scanner who can also do wanding/taping is preferred for it, so the scan needs fewer people.
function scanOptions(iso, slot, data, loads, limit = 3) {
  const people = candidatesOn(iso, data).filter((person) => freeBetween(person, timeToMinutes(slot.start), timeToMinutes(slot.end)));
  const offHours = isOffHours(iso, slot.start, slot.end);
  const wanders = withSkill(people, "Wanding/Taping").sort((a, b) => (loads.get(a.email) || 0) - (loads.get(b.email) || 0) || a.name.localeCompare(b.name));
  const options = [];
  for (const lead of people.filter((person) => canLeadScan(person, offHours))) {
    for (const support of people) {
      if (support === lead || !canSupportScan(support, lead)) continue;
      let wanding = null;
      if (slot.wandingRequired !== false) {
        wanding = [lead, support].find((person) => person.skills.includes("Wanding/Taping")) || wanders.find((person) => person !== lead && person !== support);
        if (!wanding) continue;
      }
      options.push({
        lead: lead.email,
        support: support.email,
        wanding: wanding ? wanding.email : null,
        load: loadOf(loads, [lead, support, ...(wanding ? [wanding] : [])]),
        leadLevel2: lead.skills.includes("Level 2 Scanning"),
        pair: [lead.email, support.email].sort().join("|"),
        names: `${lead.name} ${support.name}`,
      });
    }
  }
  options.sort((a, b) => a.load - b.load || Number(b.leadLevel2) - Number(a.leadLevel2) || a.names.localeCompare(b.names));
  const seen = new Set();
  return options.filter((option) => !seen.has(option.pair) && seen.add(option.pair)).slice(0, limit);
}

// One lab manager for the whole visit if possible, then two who hand off, then just someone for the wrap-up.
function managerOptions(iso, appointment, data, loads, limit = 3) {
  const managers = managerCandidates(iso, data);
  const window = visitWindow(appointment);
  const covers = (group, from) => !uncoveredStretches(group, from, window.end).length;
  const byLoad = (a, b) => a.load - b.load || a.names.localeCompare(b.names);
  const option = (group, coverage) => ({ managers: group.map((manager) => manager.email), coverage, load: loadOf(loads, group), names: group.map((manager) => manager.name).join(" ") });
  let options = managers.filter((manager) => covers([manager], window.start)).map((manager) => option([manager], "whole"));
  if (!options.length) {
    for (const [index, first] of managers.entries()) {
      for (const second of managers.slice(index + 1)) {
        if (covers([first, second], window.start)) options.push(option([first, second], "whole"));
      }
    }
  }
  if (!options.length) options = managers.filter((manager) => covers([manager], window.wrapUpStart)).map((manager) => option([manager], "wrap-up"));
  return options.sort(byLoad).slice(0, limit);
}

// Checks a saved or proposed assignment against everyone's current schedules. Issues are things that don't work;
// warnings can go ahead with care.
function checkAssignment(iso, appointment, assignment, data) {
  const people = new Map(candidatesOn(iso, data, () => true).map((person) => [person.email, person]));
  const issues = [];
  const warnings = [];
  const needs = (email, role, cleared, from, to) => {
    if (!email) {
      issues.push(`No one is assigned to ${role}`);
      return null;
    }
    const person = people.get(email);
    if (!person) {
      issues.push(`${email} (${role}) is no longer on the lab list`);
      return null;
    }
    if (!cleared(person)) issues.push(`${person.name} isn't cleared for ${role}`);
    if (!freeBetween(person, from, to)) issues.push(`${person.name} isn't free for ${role} (${clockTime(from)}–${clockTime(to)})`);
    return person;
  };
  const has = (skill) => (person) => person.skills.includes(skill);

  if (appointment.lab) {
    const lab = assignment.lab || {};
    const slotStart = timeToMinutes(appointment.lab.start);
    const slotEnd = timeToMinutes(appointment.lab.end);
    const at = lab.phlebotomyAt ? timeToMinutes(lab.phlebotomyAt) : slotStart;
    const wetStart = lab.wetLabStart ? timeToMinutes(lab.wetLabStart) : at + PHLEBOTOMY_MINUTES;
    needs(lab.dryLab, "Dry Lab", has("Dry Lab"), slotStart, slotEnd);
    const phlebotomist = needs(lab.phlebotomy, "Phlebotomy", (person) => phlebotomyLevel(person) >= 0, at, at + PHLEBOTOMY_MINUTES);
    needs(lab.wetLab, "Wet Lab", has("Wet Lab"), wetStart, wetStart + WET_LAB_MINUTES);
    if (at < slotStart || at + PHLEBOTOMY_MINUTES > slotEnd) issues.push("Phlebotomy has to be during the lab portion");
    if (wetStart < at + PHLEBOTOMY_MINUTES || wetStart > at + PHLEBOTOMY_MINUTES + MAX_GAP_MINUTES) {
      issues.push("Wet Lab has to start within 30 minutes after phlebotomy ends");
    }
    if (lab.dryLab && lab.dryLab === lab.wetLab) issues.push("Wet Lab and Dry Lab must be different people");
    if (phlebotomist && phlebotomyLevel(phlebotomist) === 2) {
      issues.push(`${phlebotomist.name} is a Training Phlebotomist: this visit can only go ahead if mobile phlebotomy is booked in advance`);
    } else if (phlebotomist && phlebotomyLevel(phlebotomist) === 1) {
      warnings.push(`${phlebotomist.name} isn't an Experienced Phlebotomist: mobile phlebotomy may need to be on stand-by, and if the participant has difficult veins, book mobile phlebotomy in advance`);
    }
  }

  if (appointment.scan) {
    const scan = assignment.scan || {};
    const from = timeToMinutes(appointment.scan.start);
    const to = timeToMinutes(appointment.scan.end);
    const offHours = isOffHours(iso, appointment.scan.start, appointment.scan.end);
    const lead = needs(scan.lead, "Lead scanner", (person) => canLeadScan(person, offHours), from, to);
    const support = needs(scan.support, "Support scanner", isScanner, from, to);
    if (scan.lead && scan.lead === scan.support) issues.push("The two scanners must be different people");
    if (lead && support && lead !== support && !canSupportScan(support, lead)) {
      issues.push("Auxiliary Support Scanning must be paired with someone with Level 2 Scanning");
    }
    if (offHours && lead && !lead.skills.includes("Level 2 Scanning")) {
      issues.push("Outside regular hours (weekdays 8 AM–5 PM) the lead scanner needs Level 2 Scanning");
    }
    if (appointment.scan.wandingRequired !== false) needs(scan.wanding, "Wanding/Taping", has("Wanding/Taping"), from, to);
  }

  const window = visitWindow(appointment);
  const managers = (assignment.managers || []).map((email) => people.get(email)).filter(Boolean);
  if (!managers.length) {
    issues.push("No lab manager is assigned");
  } else if (uncoveredStretches(managers, window.wrapUpStart, window.end).length) {
    issues.push(`The assigned lab manager${managers.length === 1 ? " isn't" : "s aren't"} free for the wrap-up at the end of the visit (${clockTime(window.wrapUpStart)}–${clockTime(window.end)})`);
  } else if (uncoveredStretches(managers, window.start, window.end).length) {
    warnings.push(`The assigned lab manager${managers.length === 1 ? " isn't" : "s aren't"} free ${stretchText(uncoveredStretches(managers, window.start, window.end))}`);
  }
  return { issues, warnings };
}

// The email a booker sends the reviewers from their own USC account when they book a visit, with a blank Screener ID
// line for them to fill in. `when` is the visit's day and times, `parts` its lab and scan times, `requestedStart`
// any other start time they asked for, and `link` the visit on the site. The site drafts it; the Apps Script sends a
// sample in its test emails.
function bookingEmail({ when, parts, requestedStart, link }) {
  return {
    subject: `Booked: ${when}${requestedStart ? " (start time change requested)" : ""}`,
    body: [
      "A participant is booked for this visit.",
      "",
      `Visit: ${when}`,
      parts,
      ...(requestedStart ? [`Requested start time: ${requestedStart} (needs your approval)`] : []),
      "",
      "Screener ID: ",
      "",
      "For reviewers:",
      `1. Confirm the booking on the Lab Calendar and record the scan time${requestedStart ? ", approving or changing the requested start time" : ""}: ${link}`,
      "2. Staff it from the suggested staffing. Approving the staffing sends the staff their calendar invites and emails automatically.",
      "3. Add the appointment to the lab's appointment calendar in Google Calendar, with the participant ID and other study details. Participant information goes there only, never on the lab's Researcher Portal website.",
    ].join("\n"),
  };
}

// Each assigned person's roles on a visit, as [{ email, role, from, to }] with times in minutes.
function staffRoles(appointment, assignment) {
  const roles = [];
  // `part` is the portion the role belongs to; lab managers cover the whole visit.
  const add = (email, role, from, to, part) => {
    if (email) roles.push({ email, role, from, to, part });
  };
  if (appointment.lab && assignment.lab) {
    const lab = assignment.lab;
    add(lab.dryLab, "Dry Lab", timeToMinutes(appointment.lab.start), timeToMinutes(appointment.lab.end), "lab");
    const at = timeToMinutes(lab.phlebotomyAt || appointment.lab.start);
    add(lab.phlebotomy, "Phlebotomy", at, at + PHLEBOTOMY_MINUTES, "lab");
    const wetStart = timeToMinutes(lab.wetLabStart || appointment.lab.start);
    add(lab.wetLab, "Wet Lab", wetStart, wetStart + WET_LAB_MINUTES, "lab");
  }
  if (appointment.scan && assignment.scan) {
    const from = timeToMinutes(appointment.scan.start);
    const to = timeToMinutes(appointment.scan.end);
    add(assignment.scan.lead, "Lead scanner", from, to, "scan");
    add(assignment.scan.support, "Support scanner", from, to, "scan");
    add(assignment.scan.wanding, "Wanding/Taping", from, to, "scan");
  }
  const window = visitWindow(appointment);
  for (const email of assignment.managers || []) add(email, "Lab manager", window.start, window.end, "visit");
  return roles;
}

// Who does what and when, as lines for the site and the calendar invites. `nameOf` turns an email into a name.
function assignmentLines(appointment, assignment, nameOf) {
  const range = (from, to) => `${clockTime(from)}–${clockTime(to)}`;
  const lines = { lab: [], scan: [], managers: [] };
  if (appointment.lab && assignment.lab) {
    const lab = assignment.lab;
    if (lab.dryLab) lines.lab.push(`Dry Lab: ${nameOf(lab.dryLab)}, ${range(timeToMinutes(appointment.lab.start), timeToMinutes(appointment.lab.end))}`);
    if (lab.phlebotomy) {
      const at = timeToMinutes(lab.phlebotomyAt || appointment.lab.start);
      lines.lab.push(`Phlebotomy: ${nameOf(lab.phlebotomy)}, ${range(at, at + PHLEBOTOMY_MINUTES)}`);
    }
    if (lab.wetLab) {
      const start = timeToMinutes(lab.wetLabStart || appointment.lab.start);
      lines.lab.push(`Wet Lab: ${nameOf(lab.wetLab)}, ${range(start, start + WET_LAB_MINUTES)}`);
    }
  }
  if (appointment.scan && assignment.scan) {
    const scan = assignment.scan;
    const times = range(timeToMinutes(appointment.scan.start), timeToMinutes(appointment.scan.end));
    if (scan.lead) lines.scan.push(`Lead scanner: ${nameOf(scan.lead)}, ${times}`);
    if (scan.support) lines.scan.push(`Support scanner: ${nameOf(scan.support)}, ${times}`);
    if (scan.wanding) lines.scan.push(`Wanding/Taping: ${nameOf(scan.wanding)}, ${times}`);
  }
  if ((assignment.managers || []).length) {
    const window = visitWindow(appointment);
    lines.managers.push(`Lab manager: ${assignment.managers.map(nameOf).join(" and ")}, ${range(window.start, window.end)}, including the wrap-up at the end (${range(window.wrapUpStart, window.end)})`);
  }
  return lines;
}
