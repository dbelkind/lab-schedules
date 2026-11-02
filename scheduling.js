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

// The stretches of [from, to] someone is free, such as "9:30 AM–10:30 AM".
function freeStretches(person, from, to) {
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
  return stretches.map(([start, end]) => `${clockTime(start)}–${clockTime(end)}`);
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
function evaluateLab(people, slot = DEFAULT_SLOTS.lab) {
  const slotStart = timeToMinutes(slot.start);
  const slotEnd = timeToMinutes(slot.end);
  const dry = withSkill(people, "Dry Lab").filter((person) => freeBetween(person, slotStart, slotEnd));
  const phlebotomists = withSkill(people, "Phlebotomy");
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
    if (choice) plans.push({ phlebotomyAt: option.at, wetStart: choice.start });
  }

  const problems = [];
  if (!wet.length) problems.push("No one available for Wet Lab");
  if (!dry.length) problems.push("No one available for Dry Lab");
  if (!phlebotomy.length) problems.push("No one available for Phlebotomy");
  if (!problems.length && !plans.length) {
    const timingWorks = options.some((option) => option.phlebotomy.length && option.wet.length);
    problems.push(timingWorks
      ? `Wet Lab and Dry Lab need two different people, but only ${wet[0].name} is available for them`
      : "Phlebotomy and Wet Lab can't be lined up: Wet Lab needs 2 hours, starting within 30 minutes after phlebotomy ends");
  }

  const standard = plans.find((plan) => plan.phlebotomyAt === slotStart && plan.wetStart === slotStart + PHLEBOTOMY_MINUTES);
  const tight = !problems.length && !standard;
  const plan = problems.length ? null : standard || plans[0];

  // Anyone who can only help at certain times is marked, with the details listed under the names.
  const notes = [];
  const markPhlebotomy = phlebotomy.map((person) => {
    if (freeBetween(person, slotStart, slotEnd)) return person;
    notes.push(`${person.name} (Phlebotomy): free ${freeStretches(person, slotStart, slotEnd).join(", ")}`);
    return { ...person, limited: true };
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
    tight,
    timing: plan && tight
      ? `Works if phlebotomy is at ${clockTime(plan.phlebotomyAt)} and Wet Lab runs ${clockTime(plan.wetStart)}–${clockTime(plan.wetStart + WET_LAB_MINUTES)}`
      : "",
    notes,
  };
}

// For showing a result: "problem", "tight" or "ready", and names with an asterisk when someone is only free part of the time.
function staffingState(result) {
  if (result.problems.length) return "problem";
  return result.tight ? "tight" : "ready";
}

function personLabel(person) {
  return person.limited ? `${person.name}*` : person.name;
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
  if (kind === "lab") {
    // Lab roles don't all need the whole slot, so each person's free time is checked as the timing is worked out.
    const candidates = data.members
      .filter((member) => (member.skills || []).length)
      .map((member) => ({
        name: member.name,
        email: member.email,
        skills: member.skills,
        isFree: (from, to) => !isBusyDuring(member.email, iso, from, to, data),
      }));
    return evaluateLab(candidates, slot);
  }
  const people = peopleAvailable(iso, slot.start, slot.end, data);
  return evaluateScan(people, { offHours: isOffHours(iso, slot.start, slot.end), wandingRequired: slot.wandingRequired !== false });
}
