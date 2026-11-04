const ACADEMIC_PATH = "data/academic-calendar.json";
const STAFF_HOLIDAYS_PATH = "data/staff-holidays.json";
const SNAP_MINUTES = 15;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEK_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEK_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Kept clear of the teal accent so a person's color never looks like a site control.
const COLORS = ["#4f46e5", "#c2410c", "#be123c", "#7c3aed", "#a16207", "#0369a1", "#4d7c0f", "#9d174d"];
const OCR_PAGE_LIMIT = 5;

const LIBRARIES = {
  pdf: {
    src: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    integrity: "sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e",
  },
  ocr: {
    src: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
    integrity: "sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F",
  },
};
const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const messagesEl = document.getElementById("messages");
const filtersEl = document.getElementById("filters");
const calendarEl = document.getElementById("calendar");
const weekLabelEl = document.getElementById("week-label");
const miniGridEl = document.getElementById("mini-grid");
const miniLabelEl = document.getElementById("mini-label");
const rowsEl = document.getElementById("rows");
const conflictRowsEl = document.getElementById("conflict-rows");
const uploadStatusEl = document.getElementById("upload-status");
const reviewEl = document.getElementById("review");
const saveButton = document.getElementById("save");
const semesterEl = document.getElementById("semester");
const classFromEl = document.getElementById("term-from");
const classToEl = document.getElementById("term-to");
const dialogEl = document.getElementById("event-dialog");

const hidden = new Set();
let selected = startOfDay(new Date());
let miniYear = selected.getFullYear();
let miniMonth = selected.getMonth();
let members = [];
let blocks = [];
let semesters = [];
let events = [];
let academicError = "";
let activeTab = "class";
let activePage = "calendar";
let me = null;
let availability = [];
let timeOff = [];
let editing = null;
let actingFor = null;
let shownMembers = new Set();
let memberPickerOpen = false;
let changeRequests = [];
let appointments = [];
let staffHolidays = [];
let calendarView = "unavailability";
let staffing = [];
let reviewerContacts = [];
let bookingFilter = "open";
let myProfile = null;
let directory = [];
let profiles = [];
// True until someone has filled in their profile the first time they sign in.
let onboarding = false;
let weekLayout = { firstHour: 8, lastHour: 18 };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showMessage(text) {
  messagesEl.append(el("div", "message", text));
}

// Messages show on whichever page the person is using.
function setStatus(text, isError) {
  const status = activePage === "manage" ? document.getElementById("manage-status") : uploadStatusEl;
  status.textContent = text;
  status.classList.toggle("error", Boolean(isError));
}

function toIso(y, month, day) {
  return `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function startOfWeek(date) {
  return addDays(date, -date.getDay());
}

function sameDay(a, b) {
  return a.getTime() === b.getTime();
}

function dateToIso(date) {
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

function shiftIso(iso, count) {
  const [y, month, day] = iso.split("-").map(Number);
  return dateToIso(new Date(y, month - 1, day + count));
}

function formatIso(iso) {
  const [y, month, day] = iso.split("-").map(Number);
  return `${MONTH_NAMES[month - 1].slice(0, 3)} ${day}, ${y}`;
}

function formatIsoWithDay(iso) {
  const [y, month, day] = iso.split("-").map(Number);
  return `${WEEK_NAMES[new Date(y, month - 1, day).getDay()]}, ${formatIso(iso)}`;
}

function toMinutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function validTime(time) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function eventsOn(iso) {
  return events.filter((event) => event.from <= iso && iso <= event.to);
}

function isDayOff(iso) {
  return academicDayOff(iso, events);
}

function classesMeet(iso) {
  return classesMeetOn(iso, semesters, events);
}

function blocksOn(date) {
  const iso = dateToIso(date);
  const dayName = DAYS[(date.getDay() + 6) % 7];
  return blocks.filter((block) =>
    block.type !== "ooo" && !hidden.has(block.member) && block.from <= iso && (!block.to || iso <= block.to) &&
    block.days.includes(dayName) && (block.type !== "class" || classesMeet(iso)));
}

function outOfOfficeOn(iso) {
  return blocks.filter((block) =>
    block.type === "ooo" && !block.start && !hidden.has(block.member) && block.from <= iso && iso <= block.to);
}

function partDayTimeOffOn(iso) {
  return blocks.filter((block) =>
    block.type === "ooo" && block.start && !hidden.has(block.member) && block.from <= iso && iso <= block.to);
}

function isReviewer() {
  return me && me.role === "reviewer";
}

// Grad Students/Post-Docs only see their own schedule, like RAs, but their changes and time off save without review.
// "member" is the older name for RA.
const ROLE_LABELS = { reviewer: "Reviewer", grad: "Grad Student/Post-Doc", ra: "RA", member: "RA" };

function isGrad() {
  return me && me.role === "grad";
}

// Reviewers can always book. Anyone else needs the Booking responsibility.
function isBooker() {
  return Boolean(me) && (isReviewer() || normalizeSkills(me.skills).includes("Booking"));
}

function changesNeedReview() {
  return !isReviewer() && !isGrad();
}

// Everyone's own time off is reviewed except a Grad Student/Post-Doc's (reviewers can approve their own).
function ownTimeOffNeedsReview() {
  return !isGrad();
}

// Reviewers can enter times for any lab member; everyone else always works on their own.
function targetEmail() {
  return isReviewer() && actingFor ? actingFor : me.email;
}

function enteringForOther() {
  return targetEmail() !== me.email;
}

function canEditEntriesOf(email) {
  return email === me.email || isReviewer();
}

function renderFilters() {
  filtersEl.replaceChildren(...members.map((member) => {
    const chip = el("button", "chip");
    chip.type = "button";
    chip.style.setProperty("--member", member.color);
    chip.setAttribute("aria-pressed", String(!hidden.has(member.name)));
    chip.append(el("span", "dot"), member.name);
    chip.addEventListener("click", () => {
      if (hidden.has(member.name)) hidden.delete(member.name);
      else hidden.add(member.name);
      render();
    });
    return chip;
  }));
  filtersEl.hidden = !isReviewer() || calendarView === "lab";
  document.getElementById("empty").hidden = blocks.length > 0;
}

// Overlapping blocks in a day share the column width, side by side.
function layoutDay(dayBlocks) {
  const sorted = [...dayBlocks].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const placed = [];
  let cluster = [];
  let clusterEnd = "";

  function closeCluster() {
    const laneEnds = [];
    for (const block of cluster) {
      let lane = laneEnds.findIndex((end) => end <= block.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = block.end;
      placed.push({ block, lane });
    }
    for (const item of placed.slice(-cluster.length)) item.laneCount = laneEnds.length;
    cluster = [];
  }

  for (const block of sorted) {
    if (cluster.length && block.start >= clusterEnd) {
      closeCluster();
      clusterEnd = "";
    }
    cluster.push(block);
    if (block.end > clusterEnd) clusterEnd = block.end;
  }
  if (cluster.length) closeCluster();
  return placed;
}

function formatHour(hour) {
  return `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;
}

function formatWeekLabel(first, last) {
  const short = (date) => `${MONTH_NAMES[date.getMonth()].slice(0, 3)} ${date.getDate()}`;
  if (first.getFullYear() !== last.getFullYear()) {
    return `${short(first)}, ${first.getFullYear()} – ${short(last)}, ${last.getFullYear()}`;
  }
  if (first.getMonth() !== last.getMonth()) return `${short(first)} – ${short(last)}, ${last.getFullYear()}`;
  return `${MONTH_NAMES[first.getMonth()]} ${first.getDate()} – ${last.getDate()}, ${last.getFullYear()}`;
}

function positionFor(minutes) {
  return `calc(${(minutes - weekLayout.firstHour * 60) / 60} * var(--hour-height))`;
}

function heightFor(start, end) {
  return `calc(${(toMinutes(end) - toMinutes(start)) / 60} * var(--hour-height) - 2px)`;
}

function placeBlock(node, start, end, lane, laneCount) {
  node.style.top = positionFor(toMinutes(start));
  node.style.height = heightFor(start, end);
  node.style.left = `${(lane / laneCount) * 100}%`;
  node.style.width = `${100 / laneCount}%`;
}

function isLabView() {
  return calendarView === "lab" && isReviewer();
}

function renderWeek() {
  const colorOf = new Map(members.map((member) => [member.name, member.color]));
  const today = startOfDay(new Date());
  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(selected), index));
  weekLabelEl.textContent = formatWeekLabel(weekDates[0], weekDates[6]);
  const labView = isLabView();

  // The hours stay the same from week to week, so the grid doesn't jump around while navigating.
  const timed = labView
    ? [DEFAULT_SLOTS.lab, DEFAULT_SLOTS.scan, ...appointments.flatMap((appointment) => [appointment.lab, appointment.scan]).filter(Boolean)]
    : blocks.filter((block) => block.type !== "ooo" || block.start);
  const firstHour = Math.min(8, ...timed.map((block) => Math.floor(toMinutes(block.start) / 60)));
  const lastHour = Math.max(18, ...timed.map((block) => Math.ceil(toMinutes(block.end) / 60)));
  weekLayout = { firstHour, lastHour };
  calendarEl.style.setProperty("--hour-count", lastHour - firstHour);
  calendarEl.classList.toggle("lab-view", labView);

  const headers = weekDates.map((date) => {
    const header = el("div", `day-header${sameDay(date, today) ? " today" : ""}`);
    header.append(el("div", "muted", WEEK_NAMES[date.getDay()]), el("div", "day-number", String(date.getDate())));
    return header;
  });

  const allDayCells = weekDates.map((date) => (labView ? labAllDay(dateToIso(date)) : unavailabilityAllDay(dateToIso(date), colorOf)));

  const hours = el("div", "hours");
  for (let hour = firstHour; hour < lastHour; hour++) {
    const label = el("div", "hour-label", formatHour(hour));
    label.style.top = positionFor(hour * 60);
    hours.append(label);
  }

  const columns = weekDates.map((date) => {
    const iso = dateToIso(date);
    const offDay = labView ? Boolean(staffHolidayOn(iso, staffHolidays)) : isDayOff(iso);
    const column = el("div", `day${sameDay(date, today) ? " today" : ""}${offDay ? " day-off" : ""}`);
    if (labView) renderLabColumn(column, iso);
    else renderUnavailabilityColumn(column, date, colorOf);
    enableCreate(column, iso, labView ? openNewVisitDialog : openNewConflictDialog);
    return column;
  });

  calendarEl.replaceChildren(el("div", "corner"), ...headers, el("div", "all-day-gutter"), ...allDayCells, hours, ...columns);
}

function unavailabilityAllDay(iso, colorOf) {
  const cell = el("div", "all-day");
  for (const event of eventsOn(iso)) cell.append(el("div", `event event-${event.kind}`, event.name));
  for (const block of outOfOfficeOn(iso)) {
    const label = block.status === "pending" ? "time off pending review" : "out of office";
    const chip = el("div", `event event-ooo${block.status === "pending" ? " pending" : ""}`, `${block.member}: ${label}${block.note ? ` (${block.note})` : ""}`);
    chip.style.setProperty("--member", colorOf.get(block.member));
    chip.title = `${formatIso(block.from)} – ${formatIso(block.to)}`;
    makeClickable(chip, () => openTimeOffDialog(block));
    cell.append(chip);
  }
  return cell;
}

function renderUnavailabilityColumn(column, date, colorOf) {
  const waiting = pendingEntryIds();
  for (const { block, lane, laneCount } of layoutDay([...blocksOn(date), ...partDayTimeOffOn(dateToIso(date))])) {
    const times = `${formatTime(block.start)} – ${formatTime(block.end)}`;
    if (block.type === "ooo") {
      const node = el("div", `entry time-off${block.status === "pending" ? " pending" : ""}`);
      node.style.setProperty("--member", colorOf.get(block.member));
      placeBlock(node, block.start, block.end, lane, laneCount);
      node.title = `${block.member} can't be in the lab ${times}`;
      node.append(el("strong", "", block.member), el("div", "", block.note || "Time off"), times);
      if (block.status === "pending") node.append(el("div", "entry-tag", "Waiting for review"));
      makeInteractive(node, { start: block.start, end: block.end, draggable: false, onOpen: () => openTimeOffDialog(block), onCommit: () => {} });
      column.append(node);
      continue;
    }
    const changing = !block.ghost && waiting.has(block.id);
    const entry = el("div", `entry${block.type === "conflict" ? " conflict" : ""}${block.ghost ? " ghost" : ""}${changing ? " has-pending" : ""}`);
    entry.style.setProperty("--member", colorOf.get(block.member));
    placeBlock(entry, block.start, block.end, lane, laneCount);
    entry.title = `${block.member} can't be in the lab ${times}`;
    entry.append(el("strong", "", block.member));
    if (block.type === "conflict") entry.append(el("div", "", block.note || "Standing conflict"));
    entry.append(times);
    if (block.ghost) entry.append(el("div", "entry-tag", "Waiting for review"));
    if (changing) entry.append(el("div", "entry-tag", "Change waiting for review"));
    makeInteractive(entry, {
      start: block.start,
      end: block.end,
      draggable: !block.ghost && canEditEntriesOf(block.ownerEmail),
      onOpen: () => (block.ghost ? openRequestDialog(block.requestId) : openEntryDialog(block)),
      onCommit: (start, end) => openEntryDialog(block, { start, end }),
    });
    column.append(entry);
  }
}

function labAllDay(iso) {
  const cell = el("div", "all-day");
  const holiday = staffHolidayOn(iso, staffHolidays);
  if (holiday) cell.append(el("div", "event event-holiday", `Staff holiday: ${holiday.name}`));
  const cancelled = cancelledDefaultOn(iso, appointments);
  if (cancelled && !holiday) {
    const chip = el("div", "event event-cancelled", "Visit cancelled · Restore");
    chip.title = "Bring back this day's default participant visit";
    makeClickable(chip, async () => {
      try {
        await Store.deleteAppointment(cancelled.id);
        pingSync();
        await refresh();
        setCalendarStatus("Visit restored.");
      } catch (error) {
        setCalendarStatus(friendlyError(error), true);
      }
    });
    cell.append(chip);
  }
  return cell;
}

function shortGroupLabel(label) {
  return label.replace(" Scanners Available", "").replace(" Available", "");
}

// A day's visits in time order. Default visits only exist up to 60 days ahead.
function visitsOn(iso) {
  return appointmentsOn(iso, appointments, staffHolidays, defaultVisitsThrough(new Date()))
    .sort((a, b) => visitWindow(a).start - visitWindow(b).start);
}

// When a day has more than one visit, each is numbered, so it's clear which one is being changed or cancelled.
function visitNumber(iso, appointment) {
  const visits = visitsOn(iso);
  return visits.length > 1 ? visits.findIndex((visit) => visitKey(visit) === visitKey(appointment)) + 1 : 0;
}

function visitTimesText(appointment) {
  const window = visitWindow(appointment);
  return `${clockTime(window.start)} – ${clockTime(window.end)}`;
}

function partsText(appointment) {
  return ["lab", "scan"].filter((kind) => appointment[kind])
    .map((kind) => `${kind === "lab" ? "Lab portion" : "Scan"} ${formatTime(appointment[kind].start)} – ${formatTime(appointment[kind].end)}`)
    .join(" · ");
}

// Pass "lab" or "scan" to show just that portion's unusual times.
function unusualNotice(appointment, kind) {
  const notes = unusualTimes(appointment, kind);
  if (!notes.length) return [];
  const box = el("div", "unusual-box");
  box.append(el("strong", "", `${SEE_TIME} These aren't the usual times:`));
  for (const note of notes) box.append(el("div", "", note));
  return [box];
}

const BOOKING_SHORT = { booked: "Booked", rebooking: "Rebooking", open: "Open" };

function bookingLabel(appointment) {
  if (appointment.booking === "booked") return `Booked${appointment.bookedByName ? ` by ${appointment.bookedByName}` : ""}`;
  if (appointment.booking === "rebooking") return "Booking cancelled, open to rebook";
  return "Open for booking";
}

// Visits before booking moved to the website were booked the old way, so they don't show a booking status.
function showsBooking(iso, appointment) {
  return Boolean(appointment.booking) || iso >= BOOKING_STARTS;
}

function bookingFields(status) {
  return { booking: status, bookedBy: me.email, bookedByName: me.name, bookedAt: new Date().toISOString() };
}

function staffingFor(appointment) {
  return staffing.find((doc) => doc.visitKey === visitKey(appointment)) || null;
}

function renderLabColumn(column, iso) {
  const visits = visitsOn(iso);
  const items = visits.flatMap((appointment, index) =>
    ["lab", "scan"].filter((kind) => appointment[kind]).map((kind) => ({
      start: appointment[kind].start,
      end: appointment[kind].end,
      appointment,
      kind,
      number: visits.length > 1 ? index + 1 : 0,
    })));
  for (const { block: item, lane, laneCount } of layoutDay(items)) {
    const { appointment } = item;
    const result = evaluateSlot(iso, appointment, item.kind);
    const state = staffingState(result);
    const node = el("div", `slot slot-${state}`);
    placeBlock(node, item.start, item.end, lane, laneCount);
    node.append(
      el("strong", "", `${item.number ? `Visit ${item.number} · ` : ""}${SLOT_TITLES[item.kind]}`),
      el("div", "slot-time", `${formatTime(item.start)} – ${formatTime(item.end)}`),
    );
    const chips = el("div", "slot-chips");
    if (unusualTimes(appointment, item.kind).length) chips.append(el("span", "slot-chip chip-unusual", SEE_TIME));
    if (visitPartsLabel(appointment)) chips.append(el("span", "slot-chip", visitPartsLabel(appointment)));
    if (showsBooking(iso, appointment)) {
      chips.append(el("span", `slot-chip chip-${appointment.booking || "open"}`, BOOKING_SHORT[appointment.booking || "open"]));
    }
    const doc = staffingFor(appointment);
    if (doc) {
      const conflict = checkAssignment(iso, appointment, doc, staffingData()).issues.length > 0;
      chips.append(el("span", `slot-chip ${conflict ? "chip-conflict" : "chip-staffed"}`, conflict ? "Staffing conflict" : "Staffed"));
    }
    if (chips.children.length) node.append(chips);
    if (state === "problem") {
      for (const problem of result.problems) node.append(el("div", "slot-issue", problem));
    } else if (state === "tight") {
      if (result.tight) node.append(el("div", "slot-tight", "Tight timing"));
      for (const flag of result.flags || []) node.append(el("div", "slot-tight", flag));
    } else {
      node.append(el("div", "slot-ok", "Ready to staff"));
    }
    for (const group of result.groups) {
      const names = group.people.map(personLabel).join(", ") || "none";
      node.append(el("div", "slot-group", `${shortGroupLabel(group.label)}: ${names}`));
    }
    for (const note of result.notes || []) node.append(el("div", "slot-note", `*${note}`));
    makeInteractive(node, {
      start: item.start,
      end: item.end,
      draggable: true,
      onOpen: () => openSlotDialog(iso, appointment, item.kind),
      onCommit: async (start, end) => {
        try {
          await saveSlot(appointment, item.kind, { ...appointment[item.kind], start, end });
          setCalendarStatus(`${SLOT_TITLES[item.kind]} moved to ${formatTime(start)} – ${formatTime(end)}.`);
        } catch (error) {
          renderWeek();
          setCalendarStatus(friendlyError(error), true);
        }
      },
    });
    column.append(node);
  }
}

// --- Who can staff a visit ---

function staffingData() {
  return { members, availability, timeOff, semesters, events };
}

function availablePeople(iso, start, end) {
  return peopleAvailable(iso, start, end, staffingData());
}

function evaluateSlot(iso, appointment, kind) {
  return evaluateVisitPart(iso, appointment, kind, staffingData());
}

// --- Clicking and dragging on the calendar ---

function minutesToTime(minutes) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

function snapMinutes(minutes) {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

function pixelsToMinutes(pixels) {
  const hourHeight = parseFloat(getComputedStyle(calendarEl).getPropertyValue("--hour-height")) || 52;
  return (pixels / hourHeight) * 60;
}

function makeClickable(node, onOpen) {
  node.classList.add("clickable");
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("click", onOpen);
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  });
}

// A click opens the details. Dragging moves the block, and dragging its top or bottom edge changes when it starts or ends.
function makeInteractive(node, { start, end, draggable, onOpen, onCommit }) {
  node.classList.add("clickable");
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  });
  if (draggable) {
    node.classList.add("draggable");
    node.append(el("div", "entry-resize entry-resize-top"), el("div", "entry-resize"));
  }
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const edge = event.target.classList.contains("entry-resize")
      ? (event.target.classList.contains("entry-resize-top") ? "start" : "end")
      : null;
    const originY = event.clientY;
    const startMinutes = toMinutes(start);
    const endMinutes = toMinutes(end);
    const lowest = weekLayout.firstHour * 60;
    const highest = weekLayout.lastHour * 60;
    let newStart = startMinutes;
    let newEnd = endMinutes;
    let moved = false;
    if (draggable) node.setPointerCapture(event.pointerId);

    const onMove = (moveEvent) => {
      if (!draggable) return;
      if (Math.abs(moveEvent.clientY - originY) > 4) moved = true;
      if (!moved) return;
      const delta = snapMinutes(pixelsToMinutes(moveEvent.clientY - originY));
      if (edge === "start") {
        newStart = Math.max(lowest, Math.min(endMinutes - SNAP_MINUTES, startMinutes + delta));
      } else if (edge === "end") {
        newEnd = Math.max(startMinutes + SNAP_MINUTES, Math.min(highest, endMinutes + delta));
      } else {
        const length = endMinutes - startMinutes;
        newStart = Math.max(lowest, Math.min(highest - length, startMinutes + delta));
        newEnd = newStart + length;
      }
      node.classList.add("dragging");
      node.style.top = positionFor(newStart);
      node.style.height = heightFor(minutesToTime(newStart), minutesToTime(newEnd));
    };
    const onEnd = (endEvent) => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onEnd);
      node.removeEventListener("pointercancel", onEnd);
      if (endEvent.type === "pointercancel") {
        renderWeek();
      } else if (!moved) {
        onOpen();
      } else if (newStart !== startMinutes || newEnd !== endMinutes) {
        onCommit(minutesToTime(newStart), minutesToTime(newEnd));
      } else {
        renderWeek();
      }
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onEnd);
    node.addEventListener("pointercancel", onEnd);
  });
}

// Dragging across empty space marks out a new block. Touch is left for scrolling.
function enableCreate(column, iso, onCreate) {
  column.addEventListener("pointerdown", (event) => {
    if (event.target !== column || event.button !== 0 || event.pointerType === "touch") return;
    const top = column.getBoundingClientRect().top;
    const minuteAt = (clientY) => Math.max(weekLayout.firstHour * 60, Math.min(weekLayout.lastHour * 60,
      Math.floor((weekLayout.firstHour * 60 + pixelsToMinutes(clientY - top)) / SNAP_MINUTES) * SNAP_MINUTES));
    const anchor = minuteAt(event.clientY);
    let from = anchor;
    let to = anchor + SNAP_MINUTES;
    const ghost = el("div", "create-ghost");
    column.append(ghost);
    column.setPointerCapture(event.pointerId);
    const draw = () => {
      ghost.style.top = positionFor(from);
      ghost.style.height = heightFor(minutesToTime(from), minutesToTime(to));
      ghost.textContent = `${formatTime(minutesToTime(from))} – ${formatTime(minutesToTime(to))}`;
    };
    draw();

    const onMove = (moveEvent) => {
      const current = minuteAt(moveEvent.clientY);
      from = Math.min(anchor, current);
      to = Math.max(anchor + SNAP_MINUTES, current + (current >= anchor ? SNAP_MINUTES : 0));
      draw();
    };
    const onEnd = (endEvent) => {
      column.removeEventListener("pointermove", onMove);
      column.removeEventListener("pointerup", onEnd);
      column.removeEventListener("pointercancel", onEnd);
      ghost.remove();
      if (endEvent.type === "pointerup" && to - from >= 30) onCreate(iso, minutesToTime(from), minutesToTime(to));
    };
    column.addEventListener("pointermove", onMove);
    column.addEventListener("pointerup", onEnd);
    column.addEventListener("pointercancel", onEnd);
  });
}

// --- Dialogs ---

function setCalendarStatus(text, isError) {
  const status = document.getElementById("calendar-status");
  status.textContent = text;
  status.classList.toggle("error", Boolean(isError));
}

function setDialogStatus(text, isError) {
  const status = document.getElementById("dialog-status");
  status.textContent = text;
  status.classList.toggle("error", Boolean(isError));
}

function openDialog(title, body, actions) {
  document.getElementById("dialog-title").textContent = title;
  document.getElementById("dialog-body").replaceChildren(...body);
  document.getElementById("dialog-actions").replaceChildren(...actions);
  setDialogStatus("");
  if (!dialogEl.open) dialogEl.showModal();
}

// Runs an action from a dialog. The dialog closes when it succeeds and stays open with the error when it doesn't.
async function runDialogAction(button, action) {
  button.disabled = true;
  try {
    const message = await action();
    dialogEl.close();
    if (message) setCalendarStatus(message);
  } catch (error) {
    setDialogStatus(friendlyError(error), true);
  } finally {
    button.disabled = false;
  }
}

function dialogButton(text, className, action) {
  const button = el("button", className, text);
  button.type = "button";
  button.addEventListener("click", () => runDialogAction(button, action));
  return button;
}

// Asks for a second click before doing something hard to undo, such as cancelling a visit.
function confirmingButton(text, confirmText, className, action) {
  const button = el("button", className, text);
  button.type = "button";
  let armed = false;
  button.addEventListener("click", () => {
    if (armed) return runDialogAction(button, action);
    armed = true;
    button.textContent = confirmText;
    return undefined;
  });
  return button;
}

// A dialog button that opens another dialog in its place.
function switchButton(text, className, open) {
  const button = el("button", className, text);
  button.type = "button";
  button.addEventListener("click", open);
  return button;
}

function closeButton() {
  const button = el("button", "secondary", "Close");
  button.type = "button";
  button.addEventListener("click", () => dialogEl.close());
  return button;
}

function labeled(text, control) {
  const label = el("label", "field");
  label.append(text, control);
  return label;
}

function inputOf(type, value) {
  const input = el("input");
  input.type = type;
  input.value = value || "";
  return input;
}

function timeRange(start, end) {
  const startInput = inputOf("time", start);
  const endInput = inputOf("time", end);
  const node = el("div", "field-row");
  node.append(labeled("Start", startInput), labeled("End", endInput));
  return {
    node,
    read() {
      if (!validTime(startInput.value) || !validTime(endInput.value) || endInput.value <= startInput.value) {
        throw new Error("The end time must be after the start time.");
      }
      return { start: startInput.value, end: endInput.value };
    },
  };
}

function daysPicker(selectedDays) {
  const node = el("div", "row-days");
  for (const day of DAYS) {
    const label = el("label", "day-check");
    const box = el("input");
    box.type = "checkbox";
    box.value = day;
    box.checked = selectedDays.includes(day);
    label.append(box, day);
    node.append(label);
  }
  return { node, read: () => [...node.querySelectorAll("input:checked")].map((box) => box.value) };
}

function openEntryDialog(block, proposed) {
  const entry = availability.find((item) => item.id === block.id) || block;
  const kindLabel = entry.type === "class" ? "Class" : "Standing conflict";
  if (!canEditEntriesOf(entry.ownerEmail)) {
    openDialog(`${block.member}: ${kindLabel.toLowerCase()}`, [el("p", "", describeEntry(entry))], [closeButton()]);
    return;
  }
  const days = daysPicker(entry.days);
  const times = timeRange(proposed ? proposed.start : entry.start, proposed ? proposed.end : entry.end);
  const body = [el("p", "muted", describeEntry(entry))];
  if (pendingEntryIds().has(entry.id)) body.push(el("p", "notice", "A change to this entry is already waiting for review."));
  if (proposed) body.push(el("p", "notice", "Check the new times, then save to keep them."));
  body.push(labeled("Days", days.node), times.node);
  let noteInput = null;
  if (entry.type === "conflict") {
    noteInput = inputOf("text", entry.note || "");
    noteInput.maxLength = 60;
    body.push(labeled("Notes/Reason", noteInput));
  }
  if (changesNeedReview()) {
    body.push(el("p", "muted", "Changes go to a reviewer. Your current times stay in place until the change is approved."));
  } else if (isGrad()) {
    body.push(el("p", "muted", "Changes save straight away, and reviewers are emailed about them."));
  }
  const title = entry.ownerEmail === me.email ? `Edit ${kindLabel.toLowerCase()}` : `Edit ${nameFor(entry.ownerEmail)}'s ${kindLabel.toLowerCase()}`;
  openDialog(title, body, [
    dialogButton(changesNeedReview() ? "Send for review" : "Save", "primary", async () => {
      const updated = { ...withoutId(entry), days: days.read(), ...times.read() };
      if (noteInput) {
        updated.note = noteInput.value.trim();
        if (!updated.note) throw new Error("Please add Notes/Reason.");
      }
      checkRows([updated]);
      const message = await proposeChange({ updates: [{ id: entry.id, data: updated }] }, `Change "${describeEntry(entry)}" to "${describeEntry(updated)}"`);
      await refresh();
      return message;
    }),
    dialogButton("Remove", "secondary danger", async () => {
      const message = await proposeChange({ deletes: [entry.id] }, `Remove "${describeEntry(entry)}"`);
      await refresh();
      return message;
    }),
    dialogButton("Edit all details", "secondary", async () => {
      if (isReviewer()) setActingFor(entry.ownerEmail);
      startEditing("availability", entry);
    }),
    closeButton(),
  ]);
}

function semesterContaining(iso) {
  return semesters.find((semester) => semester.classesBegin <= iso && iso <= semester.classesEnd) || null;
}

function openNewConflictDialog(iso, start, end) {
  const semester = semesterContaining(iso);
  const repeat = el("select");
  const options = [
    ["once", "Doesn't repeat (one time only)"],
    ["until", "Every week until a date"],
    ...(semester ? [["semester", `Every week until the last day of ${semester.name} classes (${formatIso(semester.classesEnd)})`]] : []),
    ["forever", "Every week with no end date"],
  ];
  for (const [value, text] of options) {
    const option = el("option", "", text);
    option.value = value;
    repeat.append(option);
  }
  repeat.value = "once";

  const days = daysPicker([DAYS[(isoWeekday(iso) + 6) % 7]]);
  const times = timeRange(start, end);
  const dateInput = inputOf("date", iso);
  const untilInput = inputOf("date", "");
  const noteInput = inputOf("text", "");
  noteInput.maxLength = 60;
  const daysField = labeled("Days", days.node);
  const dateField = labeled("Date", dateInput);
  const untilField = labeled("Repeat until", untilInput);
  const help = el("p", "muted");

  const update = () => {
    const once = repeat.value === "once";
    daysField.hidden = once;
    untilField.hidden = repeat.value !== "until";
    dateField.firstChild.textContent = once ? "Date" : "Starts";
    help.textContent = once
      ? ownTimeOffNeedsReview()
        ? "A one-time time is sent as a time off request, so a reviewer approves it before it counts."
        : "A one-time time is saved as time off."
      : "This repeats every week on the days you choose and is saved straight away.";
  };
  // The label's text is its first child, so it can change between "Date" and "Starts".
  dateField.replaceChildren(el("span", "", "Date"), dateInput);
  repeat.addEventListener("change", update);
  update();

  openDialog("Add a time you can't be in the lab", [
    labeled("Repeats", repeat),
    daysField,
    times.node,
    dateField,
    untilField,
    labeled("Notes/Reason", noteInput),
    help,
  ], [
    dialogButton("Save", "primary", async () => {
      const note = noteInput.value.trim();
      const from = dateInput.value;
      if (!from) throw new Error("Please choose a date.");
      if (!note) throw new Error("Please add Notes/Reason.");
      if (repeat.value === "once") {
        const message = await saveTimeOffFor(me.email, null, { from, to: from, note, ...times.read() });
        await refresh();
        return message;
      }
      const row = { days: days.read(), ...times.read() };
      checkRows([row]);
      let to = "";
      if (repeat.value === "until") {
        to = untilInput.value;
        if (!to) throw new Error("Please choose when it stops repeating.");
      } else if (repeat.value === "semester") {
        to = semester.classesEnd;
      }
      if (to && to < from) throw new Error("It has to stop repeating on or after the day it starts.");
      await Store.applyClassPlan({ creates: conflictDocs(me.email, { from, to, rows: [row], note }) });
      await refresh();
      return "Saved.";
    }),
    closeButton(),
  ]);
}

function openTimeOffDialog(block) {
  const request = timeOff.find((item) => item.id === block.id) || block;
  const body = [el("p", "", `${block.member}: ${describeTimeOff(request)}`), el("div", `status-badge status-${request.status}`, STATUS_LABELS[request.status])];
  if (request.reviewNote) body.push(el("p", "muted", `Reviewer's note: ${request.reviewNote}`));
  const actions = [];
  if (canEditEntriesOf(request.ownerEmail)) {
    if (isReviewer() && request.status === "pending" && request.ownerEmail !== me.email) {
      actions.push(dialogButton("Review requests", "primary", async () => openReviewTab()));
    }
    actions.push(dialogButton(request.ownerEmail === me.email ? "Edit request" : "Edit", "secondary", async () => {
      if (isReviewer()) setActingFor(request.ownerEmail);
      startEditing("timeOff", request);
    }));
    actions.push(dialogButton(request.status === "approved" ? "Cancel time off" : "Cancel request", "secondary danger", async () => {
      await Store.deleteTimeOff(request.id);
      await refresh();
      return "Time off cancelled.";
    }));
  }
  actions.push(closeButton());
  openDialog("Time off", body, actions);
}

function openRequestDialog(requestId) {
  const request = changeRequests.find((item) => item.id === requestId);
  if (!request) return;
  const actions = [];
  if (request.ownerEmail === me.email) {
    actions.push(dialogButton("Cancel request", "secondary danger", async () => {
      await Store.deleteChangeRequest(request.id);
      await refresh();
      return "Request cancelled.";
    }));
  }
  if (isReviewer()) actions.push(dialogButton("Review requests", "primary", async () => openReviewTab()));
  actions.push(closeButton());
  openDialog("Change waiting for review", [el("p", "", `${nameFor(request.ownerEmail)}: ${request.summary}`)], actions);
}

function openReviewTab() {
  showPage("manage");
  showManageTab("review");
}

function showManageTab(tab) {
  for (const button of document.querySelectorAll(".manage-tab")) {
    button.setAttribute("aria-selected", String(button.dataset.manage === tab));
    document.getElementById(`manage-${button.dataset.manage}`).hidden = button.dataset.manage !== tab;
  }
  setStatus("");
}

function appointmentData(appointment, changes) {
  const merged = { ...appointment, ...changes };
  return {
    date: merged.date,
    ...(merged.defaultFor ? { defaultFor: merged.defaultFor } : {}),
    cancelled: Boolean(merged.cancelled),
    lab: merged.lab || null,
    scan: merged.scan || null,
    ...(merged.booking
      ? { booking: merged.booking, bookedBy: merged.bookedBy, bookedByName: merged.bookedByName || "", bookedAt: merged.bookedAt }
      : {}),
  };
}

function shiftClock(time, minutes) {
  return time ? minutesToTime(toMinutes(time) + minutes) : time;
}

// Moving the lab portion moves its phlebotomy and Wet Lab times with it, so the staffing stays in step.
async function saveSlot(appointment, kind, slot) {
  await Store.saveAppointment(appointment, appointmentData(appointment, { [kind]: slot }));
  const doc = staffingFor(appointment);
  if (doc && kind === "lab" && doc.lab && appointment.lab) {
    const delta = toMinutes(slot.start) - toMinutes(appointment.lab.start);
    if (delta) {
      await Store.saveStaffing(doc.visitKey, {
        ...withoutId(doc),
        lab: { ...doc.lab, phlebotomyAt: shiftClock(doc.lab.phlebotomyAt, delta), wetLabStart: shiftClock(doc.lab.wetLabStart, delta) },
      });
    }
  }
  pingSync();
  await refresh();
}

async function setBooking(appointment, status) {
  await Store.bookVisit(appointment, bookingFields(status));
  pingSync();
  await refresh();
}

// Cancelling a visit also removes its staffing, which takes it off the Confirmed Visits calendar.
async function cancelAppointment(appointment) {
  if (staffingFor(appointment)) await Store.deleteStaffing(visitKey(appointment));
  if (appointment.defaultFor) await Store.saveAppointment(appointment, appointmentData(appointment, { cancelled: true }));
  else await Store.deleteAppointment(appointment.id);
  pingSync();
  await refresh();
  return "Visit cancelled.";
}

async function cancelSlot(appointment, kind) {
  const other = kind === "lab" ? "scan" : "lab";
  if (!appointment[other]) return cancelAppointment(appointment);
  await Store.saveAppointment(appointment, appointmentData(appointment, { [kind]: null }));
  const doc = staffingFor(appointment);
  if (doc) await Store.saveStaffing(doc.visitKey, { ...withoutId(doc), [kind]: null });
  pingSync();
  await refresh();
  return `${SLOT_TITLES[kind]} cancelled.`;
}

function openSlotDialog(iso, appointment, kind) {
  const slot = appointment[kind];
  const result = evaluateSlot(iso, appointment, kind);
  const times = timeRange(slot.start, slot.end);
  const number = visitNumber(iso, appointment);
  const parts = visitPartsLabel(appointment);
  const body = [
    el("p", "muted", `${formatIsoWithDay(iso)} · ${number ? `Visit ${number}, ` : "Visit "}${visitTimesText(appointment)}${parts ? ` · ${parts}` : ""}`),
    ...unusualNotice(appointment, kind),
    times.node,
  ];
  let wandingBox = null;
  if (kind === "scan") {
    wandingBox = el("input");
    wandingBox.type = "checkbox";
    wandingBox.checked = slot.wandingRequired !== false;
    const label = el("label", "check-field");
    label.append(wandingBox, "Wanding/taping required");
    body.push(label, el("p", "muted", "Only turn this off for the rare visits that don't need it."));
    if (isOffHours(iso, slot.start, slot.end)) {
      body.push(el("p", "notice", "This scan is outside regular hours (weekdays 8 AM–5 PM), so someone with Level 2 Scanning is required."));
    }
  }
  const state = staffingState(result);
  if (state === "problem") {
    const issues = el("div", "slot-issues");
    issues.append(el("strong", "", "Can't be fully staffed:"));
    for (const problem of result.problems) issues.append(el("div", "", problem));
    body.push(issues);
  } else if (state === "tight" && result.tight) {
    const tight = el("div", "slot-tight-box");
    tight.append(el("strong", "", "Tight timing: "), result.timing);
    body.push(tight);
  }
  if (state !== "problem") {
    for (const warning of result.warnings || []) {
      const box = el("div", "slot-tight-box");
      box.append(el("strong", "", "Warning: "), warning);
      body.push(box);
    }
  }
  if (state === "ready") {
    body.push(el("p", "slot-ok", "Ready to staff: every requirement can be met."));
  }
  for (const group of result.groups) {
    const section = el("div", "staff-group");
    section.append(el("h3", "", `${group.label}${group.label.endsWith("Available") ? "" : " Available"}:`));
    section.append(el("p", group.people.length ? "" : "muted", group.people.map(personLabel).join(", ") || "No one"));
    body.push(section);
  }
  if ((result.notes || []).length) {
    const notes = el("div", "staff-notes");
    notes.append(el("h3", "", "Limited availability:"));
    for (const note of result.notes) notes.append(el("p", "", `*${note}`));
    body.push(notes);
  }
  if (kind === "lab") {
    body.push(el("p", "muted", "Dry Lab needs someone for the whole slot. Phlebotomy needs 30 minutes at any point in the slot. Wet Lab needs 2 hours starting within 30 minutes after phlebotomy ends, and can run past the slot. Wet Lab and Dry Lab must be different people. Without an Experienced Phlebotomist the visit gets a warning, and with only a Training Phlebotomist it needs mobile phlebotomy booked in advance."));
  }
  body.push(el("p", "muted", "A lab manager needs to be free for the whole visit, handing off if needed, and at the very least for the wrap-up after the scan."));
  if (showsBooking(iso, appointment)) body.push(bookingSummary(appointment));
  body.push(staffingSummary(iso, appointment));

  const other = kind === "lab" ? "scan" : "lab";
  const doc = staffingFor(appointment);
  const actions = [
    dialogButton("Save", "primary", async () => {
      await saveSlot(appointment, kind, { ...slot, ...times.read(), ...(wandingBox ? { wandingRequired: wandingBox.checked } : {}) });
      return "Saved.";
    }),
    switchButton(doc ? "Change staffing" : "Staff this visit", "secondary", () => openStaffingDialog(iso, appointment)),
  ];
  if (appointment.booking === "booked") {
    actions.push(dialogButton("Cancel booking", "secondary", async () => {
      await setBooking(appointment, "rebooking");
      return "Booking cancelled. The visit stays open for rebooking.";
    }));
  } else {
    actions.push(dialogButton("Mark booked", "secondary", async () => {
      await setBooking(appointment, "booked");
      return "Visit marked booked.";
    }));
  }
  if (!appointment[other]) {
    actions.push(dialogButton(`Add ${other === "lab" ? "lab portion" : "scan"}`, "secondary", async () => {
      await saveSlot(appointment, other, { ...DEFAULT_SLOTS[other] });
      return `${SLOT_TITLES[other]} added.`;
    }));
  }
  const which = number ? `visit ${number}` : "this visit";
  if (appointment[other]) {
    actions.push(confirmingButton(`Cancel ${kind === "lab" ? "lab portion" : "scan"} only`, "Click again to cancel it", "secondary danger", () => cancelSlot(appointment, kind)));
  }
  actions.push(
    confirmingButton(number ? `Cancel visit ${number}` : "Cancel visit", `Click again to cancel ${which}`, "secondary danger", () => cancelAppointment(appointment)),
    closeButton(),
  );
  openDialog(`${number ? `Visit ${number} · ` : ""}${SLOT_TITLES[kind]}`, body, actions);
}

function openVisitFromLink(key) {
  const date = key.startsWith("default-") ? key.slice("default-".length) : (appointments.find((appointment) => appointment.id === key) || {}).date;
  const appointment = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? visitsOn(date).find((visit) => visitKey(visit) === key) : null;
  if (!appointment) {
    setCalendarStatus("That visit from the email has been cancelled or isn't on the schedule.", true);
    return;
  }
  const [y, month, day] = date.split("-").map(Number);
  goTo(new Date(y, month - 1, day));
  openStaffingDialog(date, appointment);
}

function bookingSummary(appointment) {
  const line = el("p", `booking-line booking-${appointment.booking || "open"}`);
  line.append(el("strong", "", "Booking: "), bookingLabel(appointment));
  return line;
}

function staffingSummary(iso, appointment) {
  const box = el("div", "staffing-summary");
  box.append(el("h3", "", "Staffing"));
  const doc = staffingFor(appointment);
  if (!doc) {
    box.append(el("p", "muted", "Not staffed yet. Choose Staff this visit to pick from suggested options."));
    return box;
  }
  const lines = assignmentLines(appointment, doc, nameFor);
  for (const line of [...lines.lab, ...lines.scan, ...lines.managers]) box.append(el("p", "", line));
  const check = checkAssignment(iso, appointment, doc, staffingData());
  if (check.issues.length) {
    const issues = el("div", "slot-issues");
    issues.append(el("strong", "", "Staffing conflicts:"));
    for (const issue of check.issues) issues.append(el("div", "", issue));
    box.append(issues);
  }
  for (const warning of check.warnings) box.append(el("p", "notice", warning));
  box.append(el("p", "muted", `Approved by ${nameFor(doc.approvedBy)}. It's on the Confirmed Visits calendar.`));
  return box;
}

// --- Staffing a visit ---

function emptyLab() {
  return { dryLab: null, phlebotomy: null, phlebotomyAt: null, wetLab: null, wetLabStart: null };
}

function labFromOption(option) {
  if (!option) return emptyLab();
  return { dryLab: option.dryLab, phlebotomy: option.phlebotomy, phlebotomyAt: option.phlebotomyAt, wetLab: option.wetLab, wetLabStart: option.wetLabStart };
}

function scanFromOption(option) {
  return option ? { lead: option.lead, support: option.support, wanding: option.wanding } : { lead: null, support: null, wanding: null };
}

function loadText(count) {
  return `${count} visit${count === 1 ? "" : "s"} within 4 weeks`;
}

// Suggestions come first, ranked to rotate people fairly. Any role can then be changed by hand.
function openStaffingDialog(iso, appointment) {
  const key = visitKey(appointment);
  const saved = staffingFor(appointment);
  const data = staffingData();
  const loads = staffingLoads(staffing, iso, key);
  const people = candidatesOn(iso, data, () => true);
  const byEmail = new Map(people.map((person) => [person.email, person]));
  const nameOf = (email) => (byEmail.get(email) || { name: email }).name;
  const window = visitWindow(appointment);
  const options = {
    lab: appointment.lab ? labOptions(iso, appointment.lab, data, loads) : [],
    scan: appointment.scan ? scanOptions(iso, appointment.scan, data, loads) : [],
    managers: managerOptions(iso, appointment, data, loads),
  };
  const draft = {
    lab: appointment.lab ? { ...(saved && saved.lab ? saved.lab : labFromOption(options.lab[0])) } : null,
    scan: appointment.scan ? { ...(saved && saved.scan ? saved.scan : scanFromOption(options.scan[0])) } : null,
    managers: saved ? [...(saved.managers || [])] : [...((options.managers[0] || {}).managers || [])],
  };

  const freeFor = (from, to) => (person) => freeBetween(person, from, to);
  const has = (skill) => (person) => person.skills.includes(skill);
  const labRange = appointment.lab ? [toMinutes(appointment.lab.start), toMinutes(appointment.lab.end)] : [0, 0];
  const scanRange = appointment.scan ? [toMinutes(appointment.scan.start), toMinutes(appointment.scan.end)] : [0, 0];
  const offHours = appointment.scan ? isOffHours(iso, appointment.scan.start, appointment.scan.end) : false;
  const somewhereIn = (from, to) => (person) => freeStretches(person, from, to).length > 0;
  const candidates = {
    dryLab: people.filter((person) => has("Dry Lab")(person) && freeFor(...labRange)(person)),
    phlebotomy: people.filter((person) => phlebotomyLevel(person) >= 0 && somewhereIn(...labRange)(person))
      .sort((a, b) => phlebotomyLevel(a) - phlebotomyLevel(b)),
    wetLab: people.filter((person) => has("Wet Lab")(person) && somewhereIn(labRange[0] + PHLEBOTOMY_MINUTES, labRange[1] + WET_LAB_MINUTES)(person)),
    lead: people.filter((person) => canLeadScan(person, offHours) && freeFor(...scanRange)(person)),
    support: people.filter((person) => isScanner(person) && freeFor(...scanRange)(person)),
    wanding: people.filter((person) => has("Wanding/Taping")(person) && freeFor(...scanRange)(person)),
    managers: people.filter((person) => person.role === "reviewer" && somewhereIn(window.start, window.end)(person)),
  };
  const tagOf = (person) => {
    const level = phlebotomyLevel(person);
    return level >= 0 ? ` (${PHLEBOTOMY_TAGS[level]})` : "";
  };

  // A drop-down of people for one role. Someone already chosen who isn't free any more is kept, and marked.
  const personSelect = (label, value, list, onPick, { showLevel = false, optional = false } = {}) => {
    const select = el("select");
    const option = (email, text) => {
      const node = el("option", "", text);
      node.value = email;
      return node;
    };
    select.append(option("", optional ? "No one" : "Choose someone"));
    for (const person of list) {
      select.append(option(person.email, `${person.name}${showLevel ? tagOf(person) : ""} · ${loadText(loads.get(person.email) || 0)}`));
    }
    if (value && !list.some((person) => person.email === value)) select.append(option(value, `${nameOf(value)} (not free)`));
    select.value = value || "";
    select.addEventListener("change", () => {
      onPick(select.value || null);
      render();
    });
    return labeled(label, select);
  };

  // Changing who does phlebotomy or Wet Lab works out the best timing for the new pair.
  const retime = () => {
    const phlebotomist = byEmail.get(draft.lab.phlebotomy);
    const wetLabber = byEmail.get(draft.lab.wetLab);
    if (!phlebotomist || !wetLabber) return;
    const timing = labTiming(appointment.lab, phlebotomist, wetLabber);
    if (timing) {
      draft.lab.phlebotomyAt = minutesToTime(timing.phlebotomyAt);
      draft.lab.wetLabStart = minutesToTime(timing.wetStart);
    }
  };

  const optionList = (list, describe, isChosen, choose) => {
    const node = el("div", "staff-options");
    if (!list.length) node.append(el("p", "muted", "No complete option works with everyone's schedules. Choose people below to see what's missing."));
    list.forEach((choice, index) => {
      const button = el("button", "staff-option");
      button.type = "button";
      button.setAttribute("aria-pressed", String(isChosen(choice)));
      button.append(el("strong", "", index === 0 ? "Suggested" : `Option ${index + 1}`), el("div", "", describe(choice)), el("div", "muted", `${loadText(choice.load)} between them`));
      button.addEventListener("click", () => {
        choose(choice);
        render();
      });
      node.append(button);
    });
    return node;
  };

  const render = () => {
    const body = [
      el("p", "muted", `${formatIsoWithDay(iso)} · Visit ${visitTimesText(appointment)} · ${partsText(appointment)}`),
      el("p", "muted", "Suggestions use the most experienced phlebotomist available, then favor whoever has the fewest visits within four weeks. Pick another option, or change any role below."),
    ];
    if (draft.lab) {
      const section = el("div", "staff-section");
      section.append(el("h3", "", `Lab portion, ${formatTime(appointment.lab.start)} – ${formatTime(appointment.lab.end)}`), ...unusualNotice(appointment, "lab"));
      section.append(optionList(options.lab,
        (choice) => `Dry Lab: ${nameOf(choice.dryLab)} · Phlebotomy: ${nameOf(choice.phlebotomy)}${tagOf(byEmail.get(choice.phlebotomy))} at ${formatTime(choice.phlebotomyAt)} · Wet Lab: ${nameOf(choice.wetLab)} from ${formatTime(choice.wetLabStart)}${choice.standard ? "" : " (tight timing)"}`,
        (choice) => choice.dryLab === draft.lab.dryLab && choice.phlebotomy === draft.lab.phlebotomy && choice.wetLab === draft.lab.wetLab,
        (choice) => Object.assign(draft.lab, labFromOption(choice))));
      const row = el("div", "field-row");
      row.append(
        personSelect("Dry Lab", draft.lab.dryLab, candidates.dryLab, (email) => { draft.lab.dryLab = email; }),
        personSelect("Phlebotomy", draft.lab.phlebotomy, candidates.phlebotomy, (email) => { draft.lab.phlebotomy = email; retime(); }, { showLevel: true }),
        personSelect("Wet Lab", draft.lab.wetLab, candidates.wetLab, (email) => { draft.lab.wetLab = email; retime(); }),
      );
      section.append(row);
      if (draft.lab.phlebotomyAt) {
        const at = toMinutes(draft.lab.phlebotomyAt);
        const wet = toMinutes(draft.lab.wetLabStart);
        section.append(el("p", "muted", `Phlebotomy ${clockTime(at)} – ${clockTime(at + PHLEBOTOMY_MINUTES)} · Wet Lab ${clockTime(wet)} – ${clockTime(wet + WET_LAB_MINUTES)}`));
      }
      body.push(section);
    }
    if (draft.scan) {
      const section = el("div", "staff-section");
      section.append(el("h3", "", `Scan, ${formatTime(appointment.scan.start)} – ${formatTime(appointment.scan.end)}`), ...unusualNotice(appointment, "scan"));
      section.append(optionList(options.scan,
        (choice) => `Lead: ${nameOf(choice.lead)} · Support: ${nameOf(choice.support)}${choice.wanding ? ` · Wanding/Taping: ${nameOf(choice.wanding)}` : ""}`,
        (choice) => choice.lead === draft.scan.lead && choice.support === draft.scan.support && choice.wanding === draft.scan.wanding,
        (choice) => Object.assign(draft.scan, scanFromOption(choice))));
      const row = el("div", "field-row");
      row.append(
        personSelect("Lead scanner", draft.scan.lead, candidates.lead, (email) => { draft.scan.lead = email; }),
        personSelect("Support scanner", draft.scan.support, candidates.support, (email) => { draft.scan.support = email; }),
      );
      if (appointment.scan.wandingRequired !== false) {
        row.append(personSelect("Wanding/Taping", draft.scan.wanding, candidates.wanding, (email) => { draft.scan.wanding = email; }));
      }
      section.append(row);
      body.push(section);
    }
    const managerSection = el("div", "staff-section");
    managerSection.append(el("h3", "", `Lab manager, ${clockTime(window.start)} – ${clockTime(window.end)}`));
    managerSection.append(optionList(options.managers,
      (choice) => `${choice.managers.map(nameOf).join(" and ")}${choice.coverage === "whole" ? (choice.managers.length > 1 ? " (handing off)" : " (whole visit)") : " (wrap-up only)"}`,
      (choice) => choice.managers.join("|") === draft.managers.filter(Boolean).join("|"),
      (choice) => { draft.managers = [...choice.managers]; }));
    const managerRow = el("div", "field-row");
    managerRow.append(
      personSelect("Lab manager", draft.managers[0], candidates.managers, (email) => { draft.managers = [email, draft.managers[1]].filter(Boolean); }),
      personSelect("Second lab manager", draft.managers[1], candidates.managers, (email) => { draft.managers = [draft.managers[0], email].filter(Boolean); }, { optional: true }),
    );
    managerSection.append(managerRow);
    body.push(managerSection);

    const check = checkAssignment(iso, appointment, draft, data);
    if (check.issues.length) {
      const issues = el("div", "slot-issues");
      issues.append(el("strong", "", "This staffing has problems:"));
      for (const issue of check.issues) issues.append(el("div", "", issue));
      body.push(issues);
    } else {
      body.push(el("p", "slot-ok", "Everyone is cleared and free for their role."));
    }
    for (const warning of check.warnings) body.push(el("p", "notice", warning));

    const actions = [
      dialogButton(check.issues.length ? "Approve anyway" : "Approve staffing", "primary", async () => {
        await Store.saveStaffing(key, {
          date: iso,
          visitKey: key,
          lab: draft.lab,
          scan: draft.scan,
          managers: draft.managers.filter(Boolean),
          approvedBy: me.email,
          approvedAt: new Date().toISOString(),
        });
        pingSync();
        await refresh();
        return "Staffing approved. It'll be on the Confirmed Visits calendar within about 10 minutes.";
      }),
      switchButton("Back to visit", "secondary", () => openSlotDialog(iso, appointment, appointment.lab ? "lab" : "scan")),
    ];
    if (saved) {
      actions.push(confirmingButton("Remove staffing", "Click again to remove it", "secondary danger", async () => {
        await Store.deleteStaffing(key);
        pingSync();
        await refresh();
        return "Staffing removed.";
      }));
    }
    actions.push(closeButton());
    openDialog("Staff this visit", body, actions);
  };
  render();
}

// Reviewers can add a full visit, or one part for participants who only come in for that. They're marked booked
// unless the reviewer unticks Confirmed booking, for instance to check staffing for a time first.
function openNewVisitDialog(iso, start, end) {
  const times = timeRange(start, end);
  const choice = el("fieldset", "mode");
  choice.append(el("legend", "", "What kind of visit?"));
  const kinds = [
    ["full", "Full visit: lab portion, then scan (4 hours from the start)"],
    ["lab", "Lab portion only"],
    ["scan", "Scan only"],
  ];
  const radios = kinds.map(([value, text], index) => {
    const radio = el("input");
    radio.type = "radio";
    radio.name = "new-visit-kind";
    radio.value = value;
    radio.checked = index === 0;
    const label = el("label");
    label.append(radio, text);
    choice.append(label);
    return radio;
  });
  const confirmedBox = el("input");
  confirmedBox.type = "checkbox";
  confirmedBox.checked = true;
  const confirmedLabel = el("label", "check-field");
  confirmedLabel.append(confirmedBox, "Confirmed booking");
  const help = el("p", "muted", "For a full visit, only the start time is used: the lab portion runs 2 hours from it and the scan the 2 hours after. Change either part afterwards if needed. Each visit is separate, so cancelling one never cancels another visit on the same day.");
  openDialog("Add a participant visit", [el("p", "muted", formatIsoWithDay(iso)), choice, times.node, confirmedLabel, help], [
    dialogButton("Add visit", "primary", async () => {
      const kind = radios.find((radio) => radio.checked).value;
      const range = times.read();
      let lab = null;
      let scan = null;
      if (kind === "full") {
        const from = toMinutes(range.start);
        lab = { start: range.start, end: minutesToTime(from + 120) };
        scan = { start: minutesToTime(from + 120), end: minutesToTime(from + 240), wandingRequired: true };
      } else if (kind === "lab") {
        lab = range;
      } else {
        scan = { ...range, wandingRequired: true };
      }
      await Store.saveAppointment({ id: null }, { date: iso, cancelled: false, lab, scan, ...(confirmedBox.checked ? bookingFields("booked") : {}) });
      pingSync();
      await refresh();
      return confirmedBox.checked ? "Visit added and marked booked." : "Visit added. It's open for booking.";
    }),
    closeButton(),
  ]);
}

// --- Profiles and the lab directory ---
// Phone numbers go in the directory, which everyone in the lab sees. Birthdays, graduation and favorites go in a
// profile only the person and the lab managers can see.

// Lab managers keep the directory's names and roles in step with the lab list, including for people added before it.
async function syncDirectory() {
  const stale = members.filter((member) => {
    const entry = directory.find((item) => item.email === member.email);
    return !entry || entry.name !== member.name || entry.title !== titleOf(member);
  });
  await Promise.all(stale.map((member) => Store.saveDirectory(member.email, { name: member.name, title: titleOf(member) })));
  return stale.length > 0;
}

function setProfileStatus(text, isError) {
  const status = document.getElementById("profile-status");
  status.textContent = text;
  status.classList.toggle("error", Boolean(isError));
}

function formatGraduation(graduation) {
  if (!graduation || graduation === "n/a") return "N/A";
  const [year, month] = graduation.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function fillProfileForm() {
  const monthSelect = document.getElementById("profile-grad-month");
  const yearSelect = document.getElementById("profile-grad-year");
  const option = (value, text) => {
    const node = el("option", "", text);
    node.value = value;
    return node;
  };
  monthSelect.replaceChildren(option("n/a", "N/A, not a student"), ...MONTH_NAMES.map((name, index) => option(String(index + 1).padStart(2, "0"), name)));
  const thisYear = new Date().getFullYear();
  const graduation = myProfile ? myProfile.graduation : "";
  const years = Array.from({ length: 9 }, (_, index) => String(thisYear + index));
  if (graduation && graduation !== "n/a" && !years.includes(graduation.slice(0, 4))) years.unshift(graduation.slice(0, 4));
  yearSelect.replaceChildren(...years.map((year) => option(year, year)));
  monthSelect.value = graduation && graduation !== "n/a" ? graduation.slice(5) : "n/a";
  yearSelect.value = graduation && graduation !== "n/a" ? graduation.slice(0, 4) : String(thisYear);
  yearSelect.disabled = monthSelect.value === "n/a";
  monthSelect.onchange = () => {
    yearSelect.disabled = monthSelect.value === "n/a";
  };
  const entry = directory.find((item) => item.email === me.email);
  document.getElementById("profile-phone").value = (entry && entry.phone) || "";
  document.getElementById("profile-birthday").value = myProfile ? myProfile.birthday : "";
  document.getElementById("profile-dietary").value = myProfile ? myProfile.dietary : "";
  document.getElementById("profile-color").value = myProfile ? myProfile.color : "";
  document.getElementById("profile-dessert").value = myProfile ? myProfile.dessert : "";
  setProfileStatus("");
}

function startOnboarding() {
  onboarding = true;
  document.getElementById("page-nav").hidden = true;
  document.getElementById("profile-heading").textContent = `Welcome, ${me.name}`;
  document.getElementById("profile-intro").textContent = "Before you start, please fill in your profile. You can change any of it later under My Profile.";
  document.getElementById("save-profile").textContent = "Save and continue";
  showPage("profile");
}

async function saveProfileForm() {
  const value = (id) => document.getElementById(id).value.trim();
  const phone = value("profile-phone");
  const birthday = value("profile-birthday");
  const month = value("profile-grad-month");
  const dietary = value("profile-dietary");
  const color = value("profile-color");
  const dessert = value("profile-dessert");
  if (!/^[0-9+()\-.\s]{7,30}$/.test(phone)) throw new Error("Please enter your phone number.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) || birthday >= dateToIso(startOfDay(new Date()))) throw new Error("Please enter your date of birth.");
  if (!dietary) throw new Error('Please enter any dietary restrictions or allergies, or "None".');
  if (!color) throw new Error("Please enter your favorite color.");
  if (!dessert) throw new Error("Please enter your favorite kind of dessert.");
  const graduation = month === "n/a" ? "n/a" : `${value("profile-grad-year")}-${month}`;
  await Store.saveProfile(me.email, { birthday, graduation, color, dessert, dietary, updatedAt: new Date().toISOString() });
  // A directory entry the lab managers already made only needs the phone number; otherwise it's made here.
  const entry = directory.find((item) => item.email === me.email);
  await Store.saveDirectory(me.email, entry ? { phone } : { name: me.name, title: titleOf(me), phone });
  const first = onboarding;
  await refresh();
  if (first) {
    onboarding = false;
    document.getElementById("page-nav").hidden = false;
    document.getElementById("profile-heading").textContent = "My Profile";
    document.getElementById("profile-intro").textContent = "Keep your details up to date.";
    document.getElementById("save-profile").textContent = "Save profile";
    showPage("calendar");
    return;
  }
  setProfileStatus("Saved your profile.");
}

function tableOf(headings, rows) {
  const wrapper = el("div", "table-scroll");
  const table = el("table", "data-table");
  const head = el("tr");
  head.append(...headings.map((heading) => el("th", "", heading)));
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  for (const cells of rows) {
    const row = el("tr");
    row.append(...cells.map((cell) => {
      const td = el("td");
      td.append(cell);
      return td;
    }));
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function linkTo(href, text) {
  const link = el("a", "", text);
  link.href = href;
  return link;
}

function renderDirectory() {
  if (!me) return;
  const people = [...directory].sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById("directory-list").replaceChildren(people.length
    ? tableOf(["Name", "Role", "Email", "Phone"], people.map((person) => [
      person.name,
      person.title,
      linkTo(`mailto:${person.email}`, person.email),
      person.phone ? linkTo(`tel:${person.phone.replace(/[^0-9+]/g, "")}`, person.phone) : "Not added yet",
    ]))
    : el("p", "muted", "No one is in the directory yet."));
  const details = document.getElementById("manager-details");
  details.hidden = !isReviewer();
  if (!isReviewer()) return;
  const rows = [...members].sort((a, b) => a.name.localeCompare(b.name)).map((member) => {
    const profile = profiles.find((item) => item.email === member.email);
    if (!profile) return [member.name, "Hasn't filled in their profile yet", "", "", "", ""];
    return [member.name, formatIso(profile.birthday), formatGraduation(profile.graduation), profile.color, profile.dessert, profile.dietary];
  });
  document.getElementById("manager-details-list").replaceChildren(
    tableOf(["Name", "Birthday", "Expected graduation", "Favorite color", "Favorite dessert", "Dietary restrictions/allergies"], rows));
}

// --- Who's available ---
// Lets lab managers check anyone's availability at any time, by role, and test times as a visit.

const CHECK_ROLES = [
  ["Lab managers", (person) => person.role === "reviewer"],
  ...["Dry Lab", "Wet Lab", ...PHLEBOTOMY_LEVELS, "Level 2 Scanning", "Level 1 Scanning", "Auxiliary Support Scanning", "Wanding/Taping"]
    .map((skill) => [skill, (person) => person.skills.includes(skill)]),
];

function checkPartBox(title, result) {
  const state = staffingState(result);
  const box = el("div", state === "problem" ? "slot-issues" : state === "tight" ? "slot-tight-box" : "check-ok");
  box.append(el("strong", "", `${title}: ${state === "problem" ? "can't be fully staffed" : state === "tight" ? "can be staffed, with care" : "ready to staff"}`));
  for (const problem of result.problems) box.append(el("div", "", problem));
  if (result.tight) box.append(el("div", "", `Tight timing: ${result.timing}`));
  for (const warning of result.warnings || []) box.append(el("div", "", `Warning: ${warning}`));
  return box;
}

function renderAvailabilityCheck() {
  if (!isReviewer()) return;
  const dateInput = document.getElementById("check-date");
  if (!dateInput.value) dateInput.value = dateToIso(startOfDay(new Date()));
  const iso = dateInput.value;
  const start = document.getElementById("check-start").value;
  const end = document.getElementById("check-end").value;
  const kind = document.getElementById("check-kind").value;
  const out = document.getElementById("check-results");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !validTime(start) || (kind !== "full" && (!validTime(end) || end <= start))) {
    out.replaceChildren(el("p", "muted", "Pick a date and a start time, with an end time after it."));
    return;
  }
  const data = staffingData();
  const nodes = [el("h3", "", `${formatIsoWithDay(iso)}, ${formatTime(start)}${kind === "full" ? "" : ` – ${formatTime(end)}`}`)];
  const holiday = staffHolidayOn(iso, staffHolidays);
  if (holiday) nodes.push(el("p", "notice", `${holiday.name} is a USC staff holiday, so there are no visits that day.`));
  let from = toMinutes(start);
  let to = kind === "full" ? from + VISIT_MINUTES : toMinutes(end);
  if (kind !== "any") {
    const later = (minutes) => minutesToTime(from + minutes);
    const appointment = kind === "full"
      ? { lab: { start, end: later(120) }, scan: { start: later(120), end: later(240), wandingRequired: true } }
      : kind === "lab" ? { lab: { start, end }, scan: null } : { lab: null, scan: { start, end, wandingRequired: true } };
    const window = visitWindow(appointment);
    [from, to] = [window.start, window.end];
    if (kind === "full") nodes.push(el("p", "muted", `A full visit runs 4 hours, ${clockTime(from)} – ${clockTime(to)}: the lab portion for the first 2 hours and the scan for the next 2. Until isn't used.`));
    for (const part of ["lab", "scan"].filter((name) => appointment[name])) {
      const slot = appointment[part];
      nodes.push(checkPartBox(`${part === "lab" ? "Lab portion" : "Scan"}, ${formatTime(slot.start)} – ${formatTime(slot.end)}`, evaluateVisitPart(iso, appointment, part, data)));
    }
  }
  const people = candidatesOn(iso, data, () => true);
  const list = el("div", "check-roles");
  for (const [label, hasRole] of CHECK_ROLES) {
    const withRole = people.filter(hasRole);
    const whole = withRole.filter((person) => freeBetween(person, from, to));
    const part = withRole.filter((person) => !whole.includes(person) && freeStretches(person, from, to).length);
    const row = el("div", "check-role");
    row.append(el("strong", "", label));
    row.append(el("div", whole.length ? "" : "muted", whole.length ? `Free the whole time: ${whole.map((person) => person.name).join(", ")}` : "No one free the whole time"));
    if (part.length) row.append(el("div", "muted", `Free part of the time: ${part.map((person) => `${person.name} (${freeStretches(person, from, to).join(", ")})`).join("; ")}`));
    list.append(row);
  }
  nodes.push(list);
  out.replaceChildren(...nodes);
}

// --- Booking ---
// Bookers see visits and whether they're booked, never who is staffing them. Participant details never go
// through this site: bookers email them to reviewers from their own USC email instead.

function bookableVisits() {
  const through = defaultVisitsThrough(new Date());
  const first = [dateToIso(startOfDay(new Date())), BOOKING_STARTS].sort()[1];
  const list = [];
  for (let iso = first; iso <= through; iso = shiftIso(iso, 1)) {
    for (const appointment of visitsOn(iso)) list.push({ iso, appointment });
  }
  // Extra visits reviewers have added further ahead.
  for (const appointment of appointments) {
    if (!appointment.defaultFor && appointment.date > through) list.push({ iso: appointment.date, appointment });
  }
  return list.sort((a, b) => a.iso.localeCompare(b.iso) || visitWindow(a.appointment).start - visitWindow(b.appointment).start);
}

const PUBLISHED_SITE = "https://dbelkind.github.io/lab-schedules/";

// A link that opens a visit's staffing on the site, for reviewers.
function visitLink(appointment) {
  const here = window.location && window.location.origin && window.location.origin !== "null"
    ? `${window.location.origin}${window.location.pathname}`
    : PUBLISHED_SITE;
  return `${here}#visit=${visitKey(appointment)}`;
}

// The booker's email to the reviewers, sent from their own USC account. The booker types the Screener ID in, so
// participant information only ever travels by email and goes on the lab's own Google Calendar, never this site.
// Cancelled bookings aren't emailed this way: the Apps Script emails lab managers about them automatically.
function bookingEmailUrl(iso, appointment) {
  const to = reviewerContacts.map((reviewer) => reviewer.email).join(",");
  const { subject, body } = bookingEmail({
    when: `${formatIsoWithDay(iso)}, ${visitTimesText(appointment)}`,
    parts: partsText(appointment),
    seeTime: unusualTimes(appointment),
    link: visitLink(appointment),
  });
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function bookingEmailLink(iso, appointment) {
  const link = el("a", "secondary small button-link", "Email booking details to reviewers");
  link.href = bookingEmailUrl(iso, appointment);
  return link;
}

// Opens a drafted email in the booker's email app. If nothing opens, the button on the visit does the same.
function openEmailDraft(url) {
  if (window.location && typeof window.location.assign === "function") window.location.assign(url);
}

// Asks the Apps Script to update LCL Visits and send any cancellation emails now, rather than at its next 10-minute
// run. Nothing is sent with it, and if it fails the 10-minute run catches up.
function pingSync() {
  if (typeof SYNC_URL === "undefined" || !SYNC_URL || typeof fetch !== "function") return;
  fetch(SYNC_URL, { method: "POST", mode: "no-cors" }).catch(() => {});
}

function setBookingStatus(text, isError) {
  const status = document.getElementById("booking-status");
  status.textContent = text;
  status.classList.toggle("error", Boolean(isError));
}

function bookingCard(iso, appointment) {
  const card = el("div", `booking-card booking-${appointment.booking || "open"}`);
  const main = el("div", "booking-main");
  const number = visitNumber(iso, appointment);
  main.append(
    el("strong", "", `${number ? `Visit ${number}: ` : ""}${visitTimesText(appointment)}`),
    el("div", "muted", `${partsText(appointment)}${visitPartsLabel(appointment) ? ` · ${visitPartsLabel(appointment)}` : ""}`),
  );
  for (const note of unusualTimes(appointment)) main.append(el("div", "booking-unusual", `${SEE_TIME} ${note}`));
  main.append(el("span", `slot-chip chip-${appointment.booking || "open"}`, bookingLabel(appointment)));
  const actions = el("div", "booking-actions");
  const act = (text, className, status, done) => {
    const button = el("button", className, text);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await setBooking(appointment, status);
        setBookingStatus(done);
        if (status === "booked") openEmailDraft(bookingEmailUrl(iso, appointment));
      } catch (error) {
        setBookingStatus(friendlyError(error), true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  };
  if (appointment.booking === "booked") {
    actions.append(bookingEmailLink(iso, appointment),
      act("Cancel booking", "secondary small", "rebooking", "Booking cancelled. The visit stays open so it can be rebooked, and the lab managers are emailed automatically."));
  } else {
    actions.append(act(appointment.booking === "rebooking" ? "Book again" : "Mark booked", "primary small", "booked",
      "Visit booked. An email to the reviewers has opened: add the Screener ID and send it. If it didn't open, use Email booking details to reviewers."));
  }
  card.append(main, actions);
  return card;
}

function renderBookingPage() {
  if (!isBooker()) return;
  for (const button of document.querySelectorAll("[data-booking-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.bookingFilter === bookingFilter));
  }
  const wanted = ({ appointment }) => bookingFilter === "all"
    || (bookingFilter === "booked" ? appointment.booking === "booked" : appointment.booking !== "booked");
  const visits = bookableVisits().filter(wanted);
  const listEl = document.getElementById("booking-list");
  if (!visits.length) {
    listEl.replaceChildren(el("p", "muted", `No ${bookingFilter === "all" ? "" : `${bookingFilter} `}visits right now. Visits from ${formatIso(BOOKING_STARTS)} on are booked here, and a new day opens at 8:00 AM each morning, 60 days ahead.`));
    return;
  }
  const nodes = [];
  let day = "";
  for (const { iso, appointment } of visits) {
    if (iso !== day) {
      day = iso;
      nodes.push(el("h3", "booking-day", formatIsoWithDay(iso)));
    }
    nodes.push(bookingCard(iso, appointment));
  }
  listEl.replaceChildren(...nodes);
}

function setCalendarView(view) {
  calendarView = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  const lab = isLabView();
  document.getElementById("calendar-scope").textContent = lab
    ? "Participant visit staffing"
    : isReviewer() ? "When lab members are unavailable" : "When you're unavailable";
  document.getElementById("calendar-hint").textContent = lab
    ? "Each visit lists who's qualified and free. Red visits can't be fully staffed, and amber ones only work with careful timing, have no experienced phlebotomist, or have gaps in lab manager cover. An asterisk marks someone who's only free part of the time. Click a visit to change or cancel it, drag it to move it, or drag on empty space to add one."
    : "Each block is a time someone can't be in the lab. Open time is when they're available. Click your own blocks to change them, or drag on empty space to add a time.";
  setCalendarStatus("");
  renderFilters();
  renderWeek();
}

function renderMiniMonth() {
  miniLabelEl.textContent = `${MONTH_NAMES[miniMonth]} ${miniYear}`;
  const today = startOfDay(new Date());
  const weekStart = startOfWeek(selected);
  const weekEnd = addDays(weekStart, 6);
  const gridStart = startOfWeek(new Date(miniYear, miniMonth, 1));

  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(gridStart, index);
    const cell = el("button", "mini-date", String(date.getDate()));
    cell.type = "button";
    if (date.getMonth() !== miniMonth) cell.classList.add("outside");
    if (date >= weekStart && date <= weekEnd) cell.classList.add("in-week");
    if (isDayOff(dateToIso(date))) cell.classList.add("day-off");
    if (sameDay(date, today)) cell.classList.add("today");
    cell.setAttribute("aria-label", date.toDateString());
    cell.addEventListener("click", () => goTo(date));
    return cell;
  });
  miniGridEl.replaceChildren(...WEEK_HEADERS.map((header) => el("div", "week-header", header)), ...cells);
}

function goTo(date) {
  selected = startOfDay(date);
  miniYear = selected.getFullYear();
  miniMonth = selected.getMonth();
  renderWeek();
  renderMiniMonth();
}

function shiftMiniMonth(months) {
  const target = new Date(miniYear, miniMonth + months, 1);
  miniYear = target.getFullYear();
  miniMonth = target.getMonth();
  renderMiniMonth();
}

function render() {
  renderFilters();
  renderWeek();
  renderMiniMonth();
  renderSemesterOptions();
  renderActingFor();
  renderMyEntries();
  renderReviewList();
  renderMemberList();
  renderBookingPage();
  renderAvailabilityCheck();
  renderDirectory();
}

// --- Reading an uploaded schedule ---

function loadLibrary({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error("couldn't download the file reader; check your connection"));
    document.head.append(script);
  });
}

async function ocrCanvases(canvases) {
  if (!window.Tesseract) await loadLibrary(LIBRARIES.ocr);
  setStatus("Getting the text reader ready (the first time can take a minute)...");
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: (progress) => {
      if (progress.status === "recognizing text") setStatus(`Reading text... ${Math.round(progress.progress * 100)}%`);
    },
  });
  try {
    const lines = [];
    for (const canvas of canvases) {
      const { data } = await worker.recognize(canvas);
      for (const line of data.lines) {
        lines.push({ words: line.words.map((word) => ({ text: word.text, x0: word.bbox.x0, x1: word.bbox.x1 })) });
      }
    }
    return lines;
  } finally {
    await worker.terminate();
  }
}

async function linesFromImage(file) {
  const image = await createImageBitmap(file);
  // Screenshots often have small text, and OCR reads it much better enlarged.
  const scale = Math.max(1, Math.min(2, 2400 / image.width));
  const canvas = document.createElement("canvas");
  canvas.width = image.width * scale;
  canvas.height = image.height * scale;
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return ocrCanvases([canvas]);
}

async function linesFromPdf(file) {
  if (!window.pdfjsLib) await loadLibrary(LIBRARIES.pdf);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

  const lines = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const item of items) {
      const text = item.str.trim();
      if (!text) continue;
      const y = item.transform[5];
      let row = rows.find((candidate) => Math.abs(candidate.y - y) < 3);
      if (!row) {
        row = { y, words: [] };
        rows.push(row);
      }
      row.words.push({ text, x0: item.transform[4], x1: item.transform[4] + item.width });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const row of rows) {
      row.words.sort((a, b) => a.x0 - b.x0);
      lines.push({ words: row.words });
    }
  }
  const characters = lines.reduce((total, line) =>
    total + line.words.reduce((sum, word) => sum + word.text.length, 0), 0);
  if (characters >= 20) return lines;

  // A scanned PDF has no text inside it, so read the page images instead.
  const canvases = [];
  for (let number = 1; number <= Math.min(pdf.numPages, OCR_PAGE_LIMIT); number++) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    canvases.push(canvas);
  }
  return ocrCanvases(canvases);
}

function addRow(container, { days = [], start = "", end = "" } = {}) {
  const row = el("div", "row");
  const dayPicker = daysPicker(days).node;
  const startInput = el("input");
  startInput.type = "time";
  startInput.value = start;
  startInput.setAttribute("aria-label", "Start time");
  const endInput = el("input");
  endInput.type = "time";
  endInput.value = end;
  endInput.setAttribute("aria-label", "End time");
  const remove = el("button", "link-button", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => row.remove());
  row.append(dayPicker, startInput, el("span", "muted", "to"), endInput, remove);
  container.append(row);
}

function openSemesters() {
  const today = dateToIso(new Date());
  return semesters.filter((semester) => semester.classesEnd >= today);
}

function selectedSemester() {
  return semesters.find((semester) => semester.id === semesterEl.value);
}

function renderSemesterOptions() {
  const current = semesterEl.value;
  semesterEl.replaceChildren(...openSemesters().map((semester) => {
    const option = el("option", "", semester.name);
    option.value = semester.id;
    return option;
  }));
  if (current) semesterEl.value = current;
  if (semesterEl.value && !classFromEl.value) applySemesterDates();
}

function isScheduleChange() {
  return document.getElementById("mode-changed").checked;
}

// New schedules cover the whole semester; a change starts today, or on the first day of a later semester.
function applySemesterDates() {
  const semester = selectedSemester();
  if (!semester) return;
  const today = dateToIso(new Date());
  classFromEl.min = classToEl.min = semester.classesBegin;
  classFromEl.max = classToEl.max = semester.classesEnd;
  classFromEl.value = isScheduleChange() && today > semester.classesBegin ? today : semester.classesBegin;
  classToEl.value = semester.classesEnd;
  document.getElementById("from-label").textContent = isScheduleChange() ? "New schedule starts" : "First day of classes";
}

async function handleFile(file) {
  rowsEl.replaceChildren();
  reviewEl.hidden = true;
  updateSaveVisibility();
  setStatus(`Reading ${file.name}...`);
  try {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const lines = isPdf ? await linesFromPdf(file) : await linesFromImage(file);
    const rows = parseScheduleLines(lines);
    if (rows.length) rows.forEach((row) => addRow(rowsEl, row));
    else addRow(rowsEl);

    let semesterNote = "";
    let problem = false;
    const detected = detectSemester(lines);
    if (detected && detected !== semesterEl.value) {
      const match = openSemesters().find((semester) => semester.id === detected);
      if (match) {
        semesterEl.value = detected;
        applySemesterDates();
        semesterNote = ` Your file says ${match.name}, so that semester is now selected.`;
      } else {
        semesterNote = ` Your file appears to be for ${detected.replace("-", " ")}, which isn't available here. Please check that it's the right file and semester.`;
        problem = true;
      }
    }

    const missingDays = rows.filter((row) => !row.days.length).length;
    if (!rows.length) {
      setStatus(`Couldn't find any class times in that file, so please enter them below.${semesterNote}`, true);
    } else if (missingDays) {
      setStatus(`Found ${rows.length} class times, but ${missingDays} need days chosen. Please check them all below.${semesterNote}`, true);
    } else {
      setStatus(`Found ${rows.length} class times. Please check them against your schedule.${semesterNote}`, problem);
    }
  } catch (error) {
    addRow(rowsEl);
    setStatus(`Couldn't read that file (${error.message}). You can enter your times below.`, true);
  }
  reviewEl.hidden = false;
  updateSaveVisibility();
}

// --- Saving ---

function readRows(container) {
  return [...container.querySelectorAll(".row")].map((row) => {
    const [startInput, endInput] = row.querySelectorAll('input[type="time"]');
    return {
      days: [...row.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value),
      start: startInput.value,
      end: endInput.value,
    };
  });
}

function checkRows(rows) {
  if (!rows.length) throw new Error("Please add at least one time.");
  if (rows.some((row) => !row.days.length)) throw new Error("Each time needs at least one day.");
  if (rows.some((row) => !validTime(row.start) || !validTime(row.end) || row.end <= row.start)) {
    throw new Error("Each time needs a start and an end, with the end after the start.");
  }
}

function readClassForm() {
  const semester = selectedSemester();
  if (!semester) throw new Error("Please choose a semester.");
  const rows = readRows(rowsEl);
  checkRows(rows);
  const from = classFromEl.value;
  const to = classToEl.value;
  if (!from || !to || to < from || from < semester.classesBegin || to > semester.classesEnd) {
    throw new Error(`Dates must fall within ${semester.name} classes: ${formatIso(semester.classesBegin)} to ${formatIso(semester.classesEnd)}.`);
  }
  return { semester: semester.id, from, to, rows };
}

function readConflictForm() {
  const rows = readRows(conflictRowsEl);
  checkRows(rows);
  const from = document.getElementById("conflict-from").value;
  const to = document.getElementById("conflict-to").value;
  if (!from) throw new Error("Please choose when this conflict starts.");
  if (to && to < from) throw new Error("The end date must be on or after the start date.");
  const note = document.getElementById("conflict-note").value.trim();
  if (!note) throw new Error("Please add Notes/Reason.");
  return { from, to, rows, note };
}

function readTimeOffForm() {
  const from = document.getElementById("ooo-from").value;
  const to = document.getElementById("ooo-to").value;
  const start = document.getElementById("ooo-start").value;
  const end = document.getElementById("ooo-end").value;
  if (!from || !to || to < from) throw new Error("Please choose a first and last day off.");
  const form = { from, to, note: document.getElementById("ooo-note").value.trim() };
  if (!form.note) throw new Error("Please add Notes/Reason.");
  if (!start && !end) return form;
  if (from !== to) throw new Error("Times can only be set when the first and last day are the same. Leave them empty for whole days.");
  if (!validTime(start) || !validTime(end) || end <= start) throw new Error("The end time must be after the start time.");
  return { ...form, start, end };
}

function withoutId({ id, ...data }) {
  return data;
}

// A new class schedule replaces this person's classes for its dates only, so anything earlier in the semester stays as it was.
function planClassChange(existing, ownerEmail, { semester, from, to, rows }) {
  const plan = { creates: [], updates: [], deletes: [] };
  for (const block of existing) {
    if (block.type !== "class" || block.to < from || block.from > to) continue;
    const data = withoutId(block);
    const head = block.from < from ? { ...data, to: shiftIso(from, -1) } : null;
    const tail = block.to > to ? { ...data, from: shiftIso(to, 1) } : null;
    if (head) plan.updates.push({ id: block.id, data: head });
    if (tail && head) plan.creates.push(tail);
    if (tail && !head) plan.updates.push({ id: block.id, data: tail });
    if (!head && !tail) plan.deletes.push(block.id);
  }
  for (const row of rows) plan.creates.push({ ownerEmail, type: "class", semester, ...row, from, to });
  return plan;
}

function conflictDocs(ownerEmail, { from, to, rows, note }) {
  return rows.map((row) => ({
    ownerEmail,
    type: "conflict",
    ...row,
    from,
    ...(to ? { to } : {}),
    ...(note ? { note } : {}),
  }));
}

function timeOffDoc(ownerEmail, { from, to, note, start, end }) {
  return { ownerEmail, from, to, status: "pending", ...(start ? { start, end } : {}), ...(note ? { note } : {}) };
}

// Time off a reviewer enters for someone else counts as approved as soon as it's saved.
// Grad Students/Post-Docs approve their own time off as they save it.
function timeOffFor(ownerEmail, form) {
  const doc = timeOffDoc(ownerEmail, form);
  if (ownerEmail === me.email && !isGrad()) return doc;
  return { ...doc, status: "approved", reviewedBy: me.email, reviewedAt: dateToIso(new Date()) };
}

async function saveTimeOffFor(ownerEmail, id, form) {
  const doc = timeOffFor(ownerEmail, form);
  await Store.saveTimeOff(id, doc);
  if (ownerEmail !== me.email) return "Saved.";
  if (isGrad()) {
    await leaveNotice("timeOff", `Time off: ${describeTimeOff(doc)}`);
    return "Saved. Reviewers have been told about your time off.";
  }
  return "Sent for review. It will appear on the calendar once it's approved.";
}

function describeEntry(block) {
  const dates = block.to ? `${formatIso(block.from)} – ${formatIso(block.to)}` : `from ${formatIso(block.from)}, no end date`;
  const label = block.type === "class" ? "Unavailable for class" : `Unavailable, standing conflict${block.note ? ` (${block.note})` : ""}`;
  return `${label}: ${block.days.join(", ")}, ${formatTime(block.start)} – ${formatTime(block.end)}, ${dates}`;
}

function describeTimeOff(request) {
  const dates = request.from === request.to ? formatIso(request.from) : `${formatIso(request.from)} – ${formatIso(request.to)}`;
  const hours = request.start ? `, ${formatTime(request.start)} – ${formatTime(request.end)}` : "";
  return `${dates}${hours}${request.note ? ` (${request.note})` : ""}`;
}

const STATUS_LABELS = { pending: "Waiting for review", approved: "Approved", declined: "Declined" };

function setRows(container, rows) {
  container.replaceChildren();
  rows.forEach((row) => addRow(container, row));
}

function startEditing(collection, entry) {
  editing = { collection, id: entry.id };
  showPage("update");
  if (collection === "timeOff") {
    showTab("ooo");
    document.getElementById("ooo-from").value = entry.from;
    document.getElementById("ooo-to").value = entry.to;
    document.getElementById("ooo-note").value = entry.note || "";
    document.getElementById("ooo-start").value = entry.start || "";
    document.getElementById("ooo-end").value = entry.end || "";
  } else if (entry.type === "conflict") {
    showTab("conflict");
    setRows(conflictRowsEl, [entry]);
    document.getElementById("conflict-from").value = entry.from;
    document.getElementById("conflict-to").value = entry.to || "";
    document.getElementById("conflict-note").value = entry.note || "";
  } else {
    showTab("class");
    setRows(rowsEl, [entry]);
    semesterEl.value = entry.semester;
    applySemesterDates();
    classFromEl.value = entry.from;
    classToEl.value = entry.to;
    reviewEl.hidden = false;
  }
  updateEditingBanner();
  updateSaveVisibility();
}

function updateEditingBanner() {
  document.getElementById("editing-banner").hidden = !editing;
  document.getElementById("mode-fieldset").hidden = Boolean(editing);
  document.getElementById("editing-text").textContent = editing && editing.collection === "timeOff" && !enteringForOther() && ownTimeOffNeedsReview()
    ? "You're editing a request. Saving sends it back for review, and it won't count as approved until it's reviewed again."
    : enteringForOther()
      ? `You're editing ${nameFor(targetEmail())}'s saved entry. Changes save straight away.`
      : isReviewer()
      ? "You're editing a saved entry."
      : isGrad()
      ? "You're editing a saved entry. Changes save straight away, and reviewers are emailed about them."
      : "You're editing a saved entry. Saving sends the change to a reviewer, and your current times stay in place until it's approved.";
}

function actionButton(text, action) {
  const button = el("button", "link-button", text);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function personHeader(person) {
  const header = el("div", "person");
  const initials = person.name.split(/\s+/).filter(Boolean).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  const avatar = el("span", "avatar", initials || "?");
  if (person.color) avatar.style.setProperty("--member", person.color);
  avatar.setAttribute("aria-hidden", "true");
  const name = el("div", "person-name", person.name);
  if (person.role) name.append(el("span", `role-badge role-${person.role === "member" ? "ra" : person.role}`, ROLE_LABELS[person.role] || "RA"));
  if (me && person.email === me.email) name.append(el("span", "role-badge you", "You"));
  const text = el("div", "person-text");
  text.append(name, el("div", "person-email", person.email));
  header.append(avatar, text);
  return header;
}

function personFor(email) {
  return members.find((member) => member.email === email) || { name: email, email };
}

function entryRow(text, ...buttons) {
  const row = el("div", "my-entry");
  const actions = el("div", "entry-actions");
  actions.append(...buttons);
  row.append(el("div", "", text), actions);
  return row;
}

function pendingEntryIds() {
  const ids = new Set();
  for (const request of changeRequests.filter((item) => item.status === "pending")) {
    for (const update of request.plan.updates) ids.add(update.id);
    for (const id of request.plan.deletes) ids.add(id);
  }
  return ids;
}

// Members can add entries straight away, but changing or removing a saved one needs a reviewer's approval.
function leaveNotice(kind, summary) {
  return Store.createNotice({ ownerEmail: me.email, kind, summary, createdAt: new Date().toISOString() });
}

async function proposeChange(plan, summary) {
  const full = { creates: [], updates: [], deletes: [], ...plan };
  const changesSaved = full.updates.length || full.deletes.length;
  if (isReviewer() || !changesSaved) {
    await Store.applyClassPlan(full);
    return "Saved.";
  }
  if (isGrad()) {
    await Store.applyClassPlan(full);
    await leaveNotice("change", summary);
    return "Saved. Reviewers have been told about the change.";
  }
  await Store.createChangeRequest({ ownerEmail: me.email, status: "pending", summary, plan: full, createdAt: dateToIso(new Date()) });
  return "Sent for review. Your saved times stay as they are until a reviewer approves the change.";
}

function renderMyEntries() {
  const listEl = document.getElementById("my-entries");
  if (!me) return;
  const owner = targetEmail();
  const mine = availability.filter((block) => block.ownerEmail === owner);
  const requests = timeOff.filter((request) => request.ownerEmail === owner);
  const changes = changeRequests.filter((request) => request.ownerEmail === owner && request.status !== "approved");
  const waiting = pendingEntryIds();
  const rows = [];
  for (const block of mine) {
    const row = entryRow(
      describeEntry(block),
      actionButton("Edit", async () => startEditing("availability", block)),
      actionButton("Remove", async () => {
        const message = await proposeChange({ deletes: [block.id] }, `Remove "${describeEntry(block)}"`);
        await refresh();
        setStatus(message === "Saved." ? "Removed." : message);
      }),
    );
    if (waiting.has(block.id)) row.firstChild.append(el("div", "status-badge status-pending", "Change waiting for review"));
    rows.push(row);
  }
  for (const request of changes) {
    const row = entryRow(
      `Requested change: ${request.summary}`,
      actionButton(request.status === "pending" ? "Cancel request" : "Dismiss", async () => {
        await Store.deleteChangeRequest(request.id);
        await refresh();
        setStatus(request.status === "pending" ? "Request cancelled." : "Dismissed.");
      }),
    );
    row.firstChild.append(el("div", `status-badge status-${request.status}`, STATUS_LABELS[request.status]));
    if (request.reviewNote) row.firstChild.append(el("div", "muted", `Reviewer's note: ${request.reviewNote}`));
    rows.push(row);
  }
  for (const request of requests) {
    const row = entryRow(
      `Time off (${request.start ? "unavailable" : "unavailable all day"}): ${describeTimeOff(request)}`,
      actionButton("Edit", async () => startEditing("timeOff", request)),
      actionButton("Cancel request", async () => {
        await Store.deleteTimeOff(request.id);
        await refresh();
        setStatus("Request cancelled.");
      }),
    );
    const status = el("div", `status-badge status-${request.status}`, STATUS_LABELS[request.status]);
    row.firstChild.append(status);
    if (request.reviewNote) row.firstChild.append(el("div", "muted", `Reviewer's note: ${request.reviewNote}`));
    rows.push(row);
  }
  listEl.replaceChildren(...(rows.length ? rows : [el("p", "muted", enteringForOther() ? `No unavailable times have been added for ${nameFor(owner)} yet.` : "You haven't added any times you're unavailable yet.")]));
}

function decide(request, status, note) {
  return Store.decideTimeOff(request.id, {
    status,
    reviewedBy: me.email,
    reviewedAt: dateToIso(new Date()),
    ...(note ? { reviewNote: note } : {}),
  });
}

function decision(status, note) {
  return { status, reviewedBy: me.email, reviewedAt: dateToIso(new Date()), ...(note ? { reviewNote: note } : {}) };
}

// Checks a requested change still matches what's saved and only touches the requester's own entries.
function checkedPlan(request) {
  const saved = new Map(availability.map((block) => [block.id, block]));
  const { creates, updates, deletes } = request.plan;
  for (const id of [...deletes, ...updates.map((update) => update.id)]) {
    const block = saved.get(id);
    if (!block) throw new Error("This change is out of date because the entry it changes no longer exists. Decline it and ask them to send it again.");
    if (block.ownerEmail !== request.ownerEmail) throw new Error("This change touches someone else's entry, so it can't be approved.");
  }
  const owned = (data) => ({ ...data, ownerEmail: request.ownerEmail });
  return {
    creates: creates.map(owned),
    updates: updates.map((update) => ({ id: update.id, data: owned(update.data) })),
    deletes,
  };
}

function reviewNoteInput(value) {
  const input = el("input", "review-note");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "Note to them (optional)";
  input.setAttribute("aria-label", "Note for this request");
  input.value = value || "";
  return input;
}

function renderReviewList() {
  const listEl = document.getElementById("review-list");
  const tab = document.querySelector('.manage-tab[data-manage="review"]');
  if (!isReviewer()) return;
  const order = { pending: 0, approved: 1, declined: 2 };
  const pendingChanges = changeRequests.filter((request) => request.status === "pending");
  const sorted = [...timeOff].sort((a, b) => order[a.status] - order[b.status] || a.from.localeCompare(b.from));
  const pendingCount = timeOff.filter((request) => request.status === "pending").length + pendingChanges.length;
  tab.textContent = pendingCount ? `Review requests (${pendingCount})` : "Review requests";
  document.getElementById("manage-link").textContent = pendingCount ? `Lab Management (${pendingCount})` : "Lab Management";

  const changeRows = pendingChanges.map((request) => {
    const noteInput = reviewNoteInput("");
    const row = entryRow(
      `Schedule change: ${request.summary}`,
      noteInput,
      actionButton("Approve", async () => {
        await Store.approveChangeRequest(request.id, checkedPlan(request), decision("approved", noteInput.value.trim()));
        await refresh();
        setStatus(`Approved ${nameFor(request.ownerEmail)}'s change.`);
      }),
      actionButton("Decline", async () => {
        await Store.decideChangeRequest(request.id, decision("declined", noteInput.value.trim()));
        await refresh();
        setStatus(`Declined ${nameFor(request.ownerEmail)}'s change.`);
      }),
    );
    row.firstChild.append(el("div", "status-badge status-pending", STATUS_LABELS.pending));
    row.firstChild.prepend(personHeader(personFor(request.ownerEmail)));
    row.classList.add("request-row");
    return row;
  });

  const timeOffRows = sorted.map((request) => {
    const noteInput = reviewNoteInput(request.reviewNote);
    const decide = (status, text) => actionButton(text, async () => {
      await Store.decideTimeOff(request.id, decision(status, noteInput.value.trim()));
      await refresh();
      setStatus(`${status === "approved" ? "Approved" : "Declined"} ${nameFor(request.ownerEmail)}'s request.`);
    });
    const buttons = [];
    if (request.status !== "approved") buttons.push(decide("approved", "Approve"));
    if (request.status !== "declined") buttons.push(decide("declined", "Decline"));
    const row = entryRow(`Time off: ${describeTimeOff(request)}`, noteInput, ...buttons);
    row.firstChild.append(el("div", `status-badge status-${request.status}`, STATUS_LABELS[request.status]));
    row.firstChild.prepend(personHeader(personFor(request.ownerEmail)));
    row.classList.add("request-row");
    return row;
  });

  const rows = [...changeRows, ...timeOffRows];
  listEl.replaceChildren(...(rows.length ? rows : [el("p", "muted", "No requests yet.")]));
}

// With trackChanges, saved training is shown filled and anything changed since is marked unsaved,
// so it's clear when a save has gone through.
function skillPicker(selectedSkills, { trackChanges = false, onChange = () => {} } = {}) {
  const node = el("div", "skill-picker");
  const boxes = [];
  const markChange = (box, label) => {
    label.classList.toggle("unsaved", trackChanges && box.checked !== selectedSkills.includes(box.value));
    onChange(boxes.some((other) => other.checked !== selectedSkills.includes(other.value)));
  };
  // Within an exclusive group, such as the phlebotomy levels, ticking one unticks the others.
  const addGroup = (title, skills, exclusive = false) => {
    const group = el("div", "skill-group");
    group.append(el("span", "skill-group-label", title));
    const pills = el("div", "row-days");
    const groupBoxes = [];
    for (const skill of skills) {
      const label = el("label", "day-check");
      const box = el("input");
      box.type = "checkbox";
      box.value = skill;
      box.checked = selectedSkills.includes(skill);
      boxes.push(box);
      if (trackChanges) label.classList.add("saved-skill");
      box.addEventListener("change", () => {
        if (exclusive && box.checked) {
          for (const other of groupBoxes) {
            if (other.box === box || !other.box.checked) continue;
            other.box.checked = false;
            markChange(other.box, other.label);
          }
        }
        markChange(box, label);
      });
      groupBoxes.push({ box, label });
      label.append(box, skill);
      pills.append(label);
    }
    group.append(pills);
    node.append(group);
  };
  addGroup("Cleared for", SKILLS.filter((skill) => !PHLEBOTOMY_LEVELS.includes(skill)));
  addGroup("Phlebotomy level", PHLEBOTOMY_LEVELS, true);
  addGroup("Also trained in", SECONDARY_SKILLS);
  addGroup("Responsibilities", RESPONSIBILITIES);
  return { node, read: () => boxes.filter((box) => box.checked).map((box) => box.value) };
}

// Only the fields the database keeps for a person, so saving one setting never drops another.
function memberData(member, changes = {}) {
  return {
    name: member.name,
    role: member.role,
    skills: member.skills || [],
    ...(member.notify !== undefined ? { notify: member.notify } : {}),
    ...(member.emails ? { emails: member.emails } : {}),
    ...(member.title ? { title: member.title } : {}),
    ...changes,
  };
}

// Each kind of reviewer email has its own switch, saved as soon as it's changed.
function emailSettings(self) {
  const wrapper = el("div", "notify-setting");
  wrapper.append(el("h3", "", "Email alerts"));
  for (const { key, label: text, help } of REVIEWER_EMAILS) {
    const label = el("label", "check-field");
    const box = el("input");
    box.type = "checkbox";
    box.checked = wantsEmail(self, key);
    box.addEventListener("change", async () => {
      box.disabled = true;
      const emails = Object.fromEntries(REVIEWER_EMAILS.map((kind) => [kind.key, kind.key === key ? box.checked : wantsEmail(self, kind.key)]));
      try {
        await Store.saveMember(self.email, memberData(self, { emails }));
        await refresh();
        setStatus(box.checked ? `You'll get "${text}" emails.` : `You won't get "${text}" emails.`);
      } catch (error) {
        box.checked = !box.checked;
        setStatus(friendlyError(error), true);
      } finally {
        box.disabled = false;
      }
    });
    label.append(box, text);
    wrapper.append(label, el("p", "muted", help));
  }
  wrapper.append(el("p", "muted", "When you're staffing a visit, its calendar invite and updates come regardless, like everyone else's."));
  return wrapper;
}

// The label shown in the lab directory, separate from what someone can do on the site.
function titleSelect(member) {
  const select = el("select", "role-select");
  select.setAttribute("aria-label", `${member.name}'s directory role`);
  for (const title of DIRECTORY_TITLES) {
    const option = el("option", "", title);
    option.value = title;
    select.append(option);
  }
  select.value = titleOf(member);
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      await Store.saveMember(member.email, memberData(member, { title: select.value }));
      await refresh();
      setStatus(`${member.name} is listed as ${select.value} in the directory.`);
    } catch (error) {
      select.value = titleOf(member);
      setStatus(friendlyError(error), true);
    } finally {
      select.disabled = false;
    }
  });
  return select;
}

function memberRow(member) {
  const own = member.email === me.email;
  const unsavedNote = el("span", "unsaved-note", "Unsaved changes");
  unsavedNote.hidden = true;
  const save = actionButton("Saved training", async () => {
    await Store.saveMember(member.email, memberData(member, { skills: skills.read() }));
    await refresh();
    setStatus(own ? "Saved your training." : `Saved ${member.name}'s training.`);
  });
  // The button only becomes a save button once something has changed.
  const showChanged = (changed) => {
    unsavedNote.hidden = !changed;
    save.textContent = changed ? "Save training" : "Saved training";
    save.disabled = !changed;
  };
  const skills = skillPicker(member.skills, { trackChanges: true, onChange: showChanged });
  showChanged(false);
  const buttons = [labeled("Directory role", titleSelect(member)), unsavedNote, save];
  if (!own) {
    buttons.push(actionButton("Edit schedule", async () => {
      setActingFor(member.email);
      showPage("update");
      showTab("entries");
    }));
    buttons.push(actionButton("Remove", async () => {
      await Store.deleteMember(member.email);
      shownMembers.delete(member.email);
      await refresh();
      setStatus(`Removed ${member.name} and their schedule.`);
    }));
  }
  if (!own) {
    const role = el("select", "role-select");
    role.setAttribute("aria-label", `${member.name}'s role`);
    for (const value of ["ra", "grad", "reviewer"]) {
      const option = el("option", "", ROLE_LABELS[value]);
      option.value = value;
      role.append(option);
    }
    role.value = member.role === "member" ? "ra" : member.role;
    role.addEventListener("change", async () => {
      role.disabled = true;
      try {
        await Store.saveMember(member.email, memberData(member, { role: role.value }));
        await refresh();
        setStatus(`${member.name} is now ${role.value === "ra" ? "an" : "a"} ${ROLE_LABELS[role.value]}.`);
      } catch (error) {
        role.value = member.role === "member" ? "ra" : member.role;
        setStatus(friendlyError(error), true);
      } finally {
        role.disabled = false;
      }
    });
    buttons.unshift(labeled("Role", role));
  }
  const row = el("div", "member-card");
  row.dataset.email = member.email;
  const top = el("div", "member-card-top");
  const actions = el("div", "entry-actions");
  actions.append(...buttons);
  top.append(personHeader(member), actions);
  row.append(top, skills.node);
  return row;
}

function otherMembers() {
  return members.filter((member) => member.email !== me.email).sort((a, b) => a.name.localeCompare(b.name));
}

function setShownMembers(emails) {
  shownMembers = new Set(emails);
  renderMemberList();
}

function pickerSummaryText(total) {
  return shownMembers.size
    ? `Showing ${shownMembers.size} of ${total} lab member${total === 1 ? "" : "s"}`
    : "Choose lab members to show";
}

// Lab members starts empty; reviewers tick the people they want to see in this checkbox drop-down.
// Ticking updates the drop-down in place rather than rebuilding it, so the page doesn't jump.
function renderMemberPicker(others) {
  const details = el("details", "multi-select");
  details.open = memberPickerOpen;
  details.addEventListener("toggle", () => {
    memberPickerOpen = details.open;
  });
  const summary = el("summary", "", pickerSummaryText(others.length));
  const boxes = [];
  const showChosen = () => {
    for (const box of boxes) box.checked = shownMembers.has(box.value);
    summary.textContent = pickerSummaryText(others.length);
    renderShownMembers(others);
  };
  const panel = el("div", "multi-select-panel");
  const quick = el("div", "multi-select-actions");
  const quickButton = (text, emails) => {
    const button = el("button", "link-button", text);
    button.type = "button";
    button.addEventListener("click", () => {
      shownMembers = new Set(emails);
      showChosen();
    });
    return button;
  };
  quick.append(quickButton("Show everyone", others.map((member) => member.email)), quickButton("Clear", []));
  panel.append(quick);
  for (const member of others) {
    const option = el("label", "multi-option");
    const box = el("input");
    box.type = "checkbox";
    box.value = member.email;
    box.checked = shownMembers.has(member.email);
    box.addEventListener("change", () => {
      if (box.checked) shownMembers.add(member.email);
      else shownMembers.delete(member.email);
      showChosen();
    });
    boxes.push(box);
    option.append(box, personHeader(member));
    panel.append(option);
  }
  details.append(summary, panel);
  return details;
}

function renderShownMembers(others) {
  const shown = others.filter((member) => shownMembers.has(member.email));
  document.getElementById("member-list").replaceChildren(...(shown.length
    ? shown.map(memberRow)
    : [el("p", "muted", "Choose people above to see and edit their training.")]));
}

// Clicking anywhere outside the open drop-down, or pressing Escape, closes it.
function closeMemberPicker(event) {
  const details = document.getElementById("member-picker").firstChild;
  if (!details || !details.open) return;
  if (event.type === "keydown" ? event.key !== "Escape" : details.contains(event.target)) return;
  details.open = false;
  memberPickerOpen = false;
}

function renderMemberList() {
  if (!isReviewer()) return;
  const others = otherMembers();
  shownMembers = new Set([...shownMembers].filter((email) => others.some((member) => member.email === email)));
  const picker = document.getElementById("member-picker");
  if (!others.length) {
    picker.replaceChildren();
    document.getElementById("member-list").replaceChildren(el("p", "muted", "No one else has been added yet. Add people below."));
  } else {
    picker.replaceChildren(renderMemberPicker(others));
    renderShownMembers(others);
  }
  const self = members.find((member) => member.email === me.email);
  document.getElementById("my-info").replaceChildren(...(self ? [memberRow(self), emailSettings(self)] : []));
}

let newMemberSkills = null;

function renderNewMemberTitle() {
  const select = document.getElementById("new-member-title");
  select.replaceChildren(...DIRECTORY_TITLES.map((title) => {
    const option = el("option", "", title);
    option.value = title;
    return option;
  }));
  select.value = titleOf({ role: document.getElementById("new-member-role").value });
}

function renderNewMemberSkills() {
  newMemberSkills = skillPicker([]);
  document.getElementById("new-member-skills").replaceChildren(newMemberSkills.node);
}

async function addMember() {
  const emailEl = document.getElementById("new-member-email");
  const nameInput = document.getElementById("new-member-name");
  const email = emailEl.value.trim().toLowerCase();
  const name = nameInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("Please enter their USC email.");
  if (!name) throw new Error("Please enter their name.");
  await Store.saveMember(email, {
    name,
    role: document.getElementById("new-member-role").value,
    title: document.getElementById("new-member-title").value,
    skills: newMemberSkills.read(),
  });
  shownMembers.add(email);
  emailEl.value = "";
  nameInput.value = "";
  renderNewMemberSkills();
  await refresh();
  setStatus(`${name} can now sign in with ${email}.`);
}

function friendlyError(error) {
  if (error.code === "permission-denied") return "You don't have permission to do that. Try signing out and back in.";
  if (error.code === "unavailable") return "Couldn't reach the server. Please check your connection and try again.";
  return error.message;
}

function updateSaveVisibility() {
  const needsReview = activeTab === "class" && reviewEl.hidden;
  saveButton.hidden = needsReview || activeTab === "entries";
  saveButton.textContent = activeTab === "ooo" && !enteringForOther() && ownTimeOffNeedsReview() ? "Send for review" : "Save";
}

function clearEditing() {
  editing = null;
  updateEditingBanner();
}

function showTab(tab) {
  activeTab = tab;
  for (const button of document.querySelectorAll(".tab")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    document.getElementById(`panel-${button.dataset.tab}`).hidden = button.dataset.tab !== tab;
  }
  setStatus("");
  if (tab === "conflict" && !conflictRowsEl.children.length) addRow(conflictRowsEl);
  updateSaveVisibility();
}

function resetForm() {
  clearEditing();
  rowsEl.replaceChildren();
  conflictRowsEl.replaceChildren();
  reviewEl.hidden = true;
  document.getElementById("schedule-file").value = "";
  for (const id of ["conflict-from", "conflict-to", "conflict-note", "ooo-from", "ooo-to", "ooo-note", "ooo-start", "ooo-end"]) {
    document.getElementById(id).value = "";
  }
  if (activeTab === "conflict") addRow(conflictRowsEl);
  updateSaveVisibility();
}

async function saveActiveTab() {
  const editingId = editing && editing.id;
  const owner = targetEmail();
  const mine = availability.filter((block) => block.ownerEmail === owner);
  const original = editingId && mine.find((block) => block.id === editingId);
  let done;
  if (activeTab === "class") {
    const form = readClassForm();
    if (editingId) {
      const [first, ...others] = form.rows.map((row) => ({ ownerEmail: owner, type: "class", semester: form.semester, ...row, from: form.from, to: form.to }));
      done = await proposeChange({ creates: others, updates: [{ id: editingId, data: first }] }, `Change "${describeEntry(original)}" to "${describeEntry(first)}"`);
    } else {
      const plan = planClassChange(mine, owner, form);
      const semesterName = (semesters.find((semester) => semester.id === form.semester) || {}).name || form.semester;
      done = await proposeChange(plan, `New ${semesterName} class times from ${formatIso(form.from)} to ${formatIso(form.to)}: ${form.rows.map((row) => `${row.days.join(", ")} ${formatTime(row.start)} – ${formatTime(row.end)}`).join("; ")}`);
    }
  } else if (activeTab === "conflict") {
    const [first, ...others] = conflictDocs(owner, readConflictForm());
    if (editingId) {
      done = await proposeChange({ creates: others, updates: [{ id: editingId, data: first }] }, `Change "${describeEntry(original)}" to "${describeEntry(first)}"`);
    } else {
      done = await proposeChange({ creates: [first, ...others] }, "");
    }
  } else {
    done = await saveTimeOffFor(owner, editingId, readTimeOffForm());
  }
  await refresh();
  resetForm();
  setStatus(owner === me.email ? done : `${done} Saved for ${nameFor(owner)}.`.replace("Saved. Saved for", "Saved for"));
}

// --- Loading and signing in ---

function nameFor(email) {
  const member = members.find((candidate) => candidate.email === email);
  return member ? member.name : email;
}

function buildBlocks() {
  const entries = availability.map((block) => ({ ...block, member: nameFor(block.ownerEmail) }));
  const requests = timeOff
    .filter((request) => request.status !== "declined")
    .map((request) => ({ ...request, type: "ooo", member: nameFor(request.ownerEmail) }));
  // Times a pending change would add are shown faintly so people can see what they've asked for.
  const proposed = changeRequests
    .filter((request) => request.status === "pending")
    .flatMap((request) => [...request.plan.creates, ...request.plan.updates.map((update) => update.data)]
      .map((data) => ({ ...data, ghost: true, requestId: request.id, ownerEmail: request.ownerEmail, member: nameFor(request.ownerEmail) })));
  return [...entries, ...requests, ...proposed];
}

// Only reviewers ask for everyone's entries. For anyone else the database refuses that request.
async function refresh() {
  const scope = isReviewer() ? undefined : me.email;
  const [people, loadedAvailability, loadedTimeOff, loadedChanges, loadedAppointments, loadedStaffing, contacts, profile, loadedDirectory, loadedProfiles] = await Promise.all([
    isReviewer() ? Store.listMembers() : [me],
    Store.listAvailability(scope),
    Store.listTimeOff(scope),
    Store.listChangeRequests(scope),
    isBooker() ? Store.listAppointments() : [],
    isReviewer() ? Store.listStaffing() : [],
    isBooker() && !isReviewer() ? Store.listReviewers() : [],
    Store.getProfile(me.email),
    Store.listDirectory(),
    isReviewer() ? Store.listProfiles() : [],
  ]);
  members = people.map((member, index) => ({ ...member, skills: normalizeSkills(member.skills), color: COLORS[index % COLORS.length] }));
  availability = loadedAvailability;
  timeOff = loadedTimeOff;
  changeRequests = loadedChanges;
  appointments = loadedAppointments;
  staffing = loadedStaffing;
  reviewerContacts = isReviewer() ? members.filter((member) => member.role === "reviewer") : contacts;
  myProfile = profile;
  directory = loadedDirectory;
  profiles = loadedProfiles;
  if (isReviewer() && await syncDirectory()) directory = await Store.listDirectory();
  blocks = buildBlocks();
  render();
}

function renderActingFor() {
  const field = document.getElementById("acting-for-field");
  field.hidden = !isReviewer();
  if (!isReviewer()) return;
  if (actingFor && !members.some((member) => member.email === actingFor)) actingFor = null;
  const select = document.getElementById("acting-for");
  const option = (email, text) => {
    const node = el("option", "", text);
    node.value = email;
    return node;
  };
  const others = members.filter((member) => member.email !== me.email).sort((a, b) => a.name.localeCompare(b.name));
  select.replaceChildren(option(me.email, `Myself (${me.name})`), ...others.map((member) => option(member.email, member.name)));
  select.value = targetEmail();
  const name = nameFor(targetEmail());
  const note = document.getElementById("acting-for-note");
  note.hidden = !enteringForOther();
  note.textContent = enteringForOther()
    ? `You're entering ${name}'s unavailable times. Everything you save for ${name} applies straight away, without review, and they'll see it on their calendar.`
    : "";
  document.querySelector('.tab[data-tab="entries"]').textContent = enteringForOther() ? `${name}'s availability` : "My availability";
}

function setActingFor(email) {
  actingFor = email === me.email ? null : email;
  resetForm();
  renderActingFor();
  renderMyEntries();
  updateSaveVisibility();
}

function showPage(page) {
  activePage = page;
  document.getElementById("page-calendar").hidden = page !== "calendar";
  document.getElementById("page-update").hidden = page !== "update";
  document.getElementById("page-manage").hidden = page !== "manage";
  document.getElementById("page-booking").hidden = page !== "booking";
  document.getElementById("page-profile").hidden = page !== "profile";
  document.getElementById("page-directory").hidden = page !== "directory";
  if (page === "profile") fillProfileForm();
  for (const link of document.querySelectorAll(".page-link")) {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function showScreen(screen) {
  document.getElementById("signin-screen").hidden = screen !== "signin";
  document.getElementById("not-listed-screen").hidden = screen !== "not-listed";
  document.getElementById("app-screen").hidden = screen !== "app";
  document.getElementById("user-bar").hidden = screen === "signin";
  document.getElementById("page-nav").hidden = screen !== "app";
}

async function handleAuthChange(user) {
  me = null;
  members = [];
  availability = [];
  timeOff = [];
  changeRequests = [];
  appointments = [];
  staffing = [];
  reviewerContacts = [];
  myProfile = null;
  directory = [];
  profiles = [];
  onboarding = false;
  bookingFilter = "open";
  blocks = [];
  actingFor = null;
  shownMembers = new Set();
  memberPickerOpen = false;
  hidden.clear();
  calendarView = "unavailability";
  messagesEl.replaceChildren();
  if (academicError) showMessage(academicError);
  if (!user) {
    showScreen("signin");
    return;
  }
  const email = user.email.toLowerCase();
  document.getElementById("user-email").textContent = email;
  try {
    const member = await Store.getMember(email);
    if (!member) {
      document.getElementById("not-listed-email").textContent = email;
      showScreen("not-listed");
      return;
    }
    me = member;
    document.getElementById("manage-link").hidden = !isReviewer();
    document.getElementById("booking-link").hidden = !isBooker();
    document.getElementById("view-switch").hidden = !isReviewer();
    document.getElementById("ooo-help").textContent = ownTimeOffNeedsReview()
      ? "Ask for time you won't be in the lab, either whole days or part of a single day. Your request goes to a reviewer, and it's marked as pending on your calendar until they approve it."
      : "Add time you won't be in the lab, either whole days or part of a single day. It's saved straight away, and reviewers are emailed about it.";
    if (isReviewer()) {
      renderNewMemberSkills();
      renderNewMemberTitle();
    }
    showScreen("app");
    await refresh();
    setCalendarView(isReviewer() ? "lab" : "unavailability");
    const hasPending = isReviewer() &&
      (timeOff.some((request) => request.status === "pending") || changeRequests.some((request) => request.status === "pending"));
    showTab("class");
    showManageTab("review");
    // Links in request emails end in #review, which opens Review requests. Links in booking emails end in
    // #visit=<key>, which opens that visit's staffing.
    const hash = (window.location || {}).hash || "";
    const fromEmail = isReviewer() && hash === "#review";
    const visitFromEmail = isReviewer() && hash.startsWith("#visit=") ? decodeURIComponent(hash.slice(7)) : "";
    // The first time someone signs in, they fill in their profile before anything else.
    if (!myProfile) {
      startOnboarding();
      return;
    }
    showPage((hasPending || fromEmail) && !visitFromEmail ? "manage" : "calendar");
    if (visitFromEmail) openVisitFromLink(visitFromEmail);
  } catch (error) {
    showMessage(`Couldn't load your unavailable times (${friendlyError(error)}).`);
  }
}

function wireUpEvents() {
  document.getElementById("today").addEventListener("click", () => goTo(new Date()));
  document.getElementById("prev-week").addEventListener("click", () => goTo(addDays(selected, -7)));
  document.getElementById("next-week").addEventListener("click", () => goTo(addDays(selected, 7)));
  document.getElementById("prev-month").addEventListener("click", () => shiftMiniMonth(-1));
  document.getElementById("next-month").addEventListener("click", () => shiftMiniMonth(1));
  document.getElementById("prev-year").addEventListener("click", () => shiftMiniMonth(-12));
  document.getElementById("next-year").addEventListener("click", () => shiftMiniMonth(12));
  document.getElementById("add-row").addEventListener("click", () => addRow(rowsEl));
  document.getElementById("add-conflict-row").addEventListener("click", () => addRow(conflictRowsEl));
  document.getElementById("manual").addEventListener("click", () => {
    if (!rowsEl.children.length) addRow(rowsEl);
    reviewEl.hidden = false;
    updateSaveVisibility();
  });
  document.getElementById("schedule-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) handleFile(file);
  });
  for (const link of document.querySelectorAll("[data-page]")) {
    link.addEventListener("click", () => showPage(link.dataset.page));
  }
  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => {
      if (editing) resetForm();
      showTab(button.dataset.tab);
    });
  }
  semesterEl.addEventListener("change", applySemesterDates);
  document.getElementById("acting-for").addEventListener("change", (event) => setActingFor(event.target.value));
  document.getElementById("mode-new").addEventListener("change", applySemesterDates);
  document.getElementById("mode-changed").addEventListener("change", applySemesterDates);
  document.getElementById("cancel-edit").addEventListener("click", () => {
    resetForm();
    showTab("entries");
  });
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => setCalendarView(button.dataset.view));
  }
  for (const button of document.querySelectorAll(".manage-tab")) {
    button.addEventListener("click", () => showManageTab(button.dataset.manage));
  }
  // A new person's directory role follows their site role until it's changed.
  document.getElementById("new-member-role").addEventListener("change", renderNewMemberTitle);
  document.getElementById("save-profile").addEventListener("click", async () => {
    const button = document.getElementById("save-profile");
    button.disabled = true;
    try {
      await saveProfileForm();
    } catch (error) {
      setProfileStatus(friendlyError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  for (const id of ["check-date", "check-start", "check-end", "check-kind"]) {
    document.getElementById(id).addEventListener("change", renderAvailabilityCheck);
  }
  for (const button of document.querySelectorAll("[data-booking-filter]")) {
    button.addEventListener("click", () => {
      bookingFilter = button.dataset.bookingFilter;
      setBookingStatus("");
      renderBookingPage();
    });
  }
  document.getElementById("dialog-close").addEventListener("click", () => dialogEl.close());
  document.addEventListener("click", closeMemberPicker);
  document.addEventListener("keydown", closeMemberPicker);
  // Closing a dialog redraws the week, so a block dragged but not saved goes back where it was.
  dialogEl.addEventListener("close", () => {
    if (me) renderWeek();
  });
  document.getElementById("add-member").addEventListener("click", async () => {
    try {
      await addMember();
    } catch (error) {
      setStatus(friendlyError(error), true);
    }
  });
  for (const id of ["sign-in", "sign-out", "not-listed-sign-out"]) {
    document.getElementById(id).addEventListener("click", async () => {
      try {
        await (id === "sign-in" ? Store.signIn() : Store.signOut());
      } catch (error) {
        if (error.code !== "auth/popup-closed-by-user") showMessage(`Couldn't sign in (${friendlyError(error)}).`);
      }
    });
  }
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      await saveActiveTab();
    } catch (error) {
      setStatus(friendlyError(error), true);
    } finally {
      saveButton.disabled = false;
    }
  });
}

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function init() {
  wireUpEvents();
  updateSaveVisibility();
  try {
    const academic = await loadJson(ACADEMIC_PATH);
    semesters = academic.semesters;
    events = academic.events;
  } catch (error) {
    academicError = `Couldn't load ${ACADEMIC_PATH} (${error.message}), so USC dates aren't shown and classes aren't limited to semester dates.`;
  }
  try {
    staffHolidays = (await loadJson(STAFF_HOLIDAYS_PATH)).holidays;
  } catch (error) {
    academicError += ` Couldn't load ${STAFF_HOLIDAYS_PATH} (${error.message}), so visits are scheduled on staff holidays too.`;
  }
  if (!Store.isConfigured()) {
    showScreen("signin");
    document.getElementById("sign-in").hidden = true;
    showMessage("Sign-in isn't set up yet. Add your Firebase project's values to firebase-config.js.");
    return;
  }
  Store.onAuthChange(handleAuthChange);
}

init();
