// Staffing rules for participant visits. Nothing here touches the page, so the same rules run on the website,
// in tests, and in the Google Apps Script that copies staffing to Google Calendar (apps-script/Code.gs).

const SKILLS = ["Wet Lab", "Dry Lab", "Phlebotomy", "Level 1 Scanning", "Level 2 Scanning", "Auxiliary Support Scanning"];
// Training saved before the scanner trainings were renamed is read under the new names.
const SKILL_RENAMES = {
  "Level 1 Scanner": "Level 1 Scanning",
  "Level 2 Scanner": "Level 2 Scanning",
  "Auxiliary Support Scanner": "Auxiliary Support Scanning",
};
const SECONDARY_SKILLS = ["Wanding/Taping"];
const DEFAULT_SLOTS = {
  lab: { start: "09:00", end: "11:00" },
  scan: { start: "11:00", end: "13:00", wandingRequired: true },
};
const SLOT_TITLES = { lab: "Participant Visit - Lab", scan: "Participant Visit - Scan" };
const REGULAR_HOURS = { start: "08:00", end: "17:00" };

function isoWeekday(iso) {
  const [y, month, day] = iso.split("-").map(Number);
  return new Date(y, month - 1, day).getDay();
}

function staffHolidayOn(iso, holidays) {
  return holidays.find((holiday) => holiday.from <= iso && iso <= holiday.to) || null;
}

// Every weekday that isn't a staff holiday gets a default visit. Saved records only hold changes to it, plus extra visits.
function appointmentsOn(iso, stored, holidays) {
  const list = [];
  const weekday = isoWeekday(iso);
  if (weekday !== 0 && weekday !== 6 && !staffHolidayOn(iso, holidays)) {
    const override = stored.find((appointment) => appointment.defaultFor === iso);
    if (!override) {
      list.push({ id: null, defaultFor: iso, date: iso, lab: { ...DEFAULT_SLOTS.lab }, scan: { ...DEFAULT_SLOTS.scan } });
    } else if (!override.cancelled) {
      list.push(override);
    }
  }
  for (const appointment of stored) {
    if (!appointment.defaultFor && appointment.date === iso) list.push(appointment);
  }
  return list;
}

function cancelledDefaultOn(iso, stored) {
  return stored.find((appointment) => appointment.defaultFor === iso && appointment.cancelled) || null;
}

function isOffHours(iso, start, end) {
  const weekday = isoWeekday(iso);
  return weekday === 0 || weekday === 6 || start < REGULAR_HOURS.start || end > REGULAR_HOURS.end;
}

function normalizeSkills(skills) {
  return [...new Set((skills || []).map((skill) => SKILL_RENAMES[skill] || skill))];
}

function withSkill(people, skill) {
  return people.filter((person) => person.skills.includes(skill));
}

// Wet Lab and Dry Lab need two different people; Phlebotomy can be done by either of them or someone else.
function evaluateLab(people) {
  const wet = withSkill(people, "Wet Lab");
  const dry = withSkill(people, "Dry Lab");
  const phlebotomy = withSkill(people, "Phlebotomy");
  const problems = [];
  if (!wet.length) problems.push("No one available for Wet Lab");
  if (!dry.length) problems.push("No one available for Dry Lab");
  if (!phlebotomy.length) problems.push("No one available for Phlebotomy");
  if (wet.length && dry.length && !wet.some((wetPerson) => dry.some((dryPerson) => dryPerson !== wetPerson))) {
    problems.push(`Wet Lab and Dry Lab need two different people, but only ${wet[0].name} is available for them`);
  }
  return {
    groups: [
      { label: "Wet Lab", people: wet },
      { label: "Dry Lab", people: dry },
      { label: "Phlebotomy", people: phlebotomy },
    ],
    problems,
  };
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

function evaluateVisitSlot(iso, slot, kind, data) {
  const people = peopleAvailable(iso, slot.start, slot.end, data);
  if (kind === "lab") return evaluateLab(people);
  return evaluateScan(people, { offHours: isOffHours(iso, slot.start, slot.end), wandingRequired: slot.wandingRequired !== false });
}
