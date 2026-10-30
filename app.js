const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS = DAYS.slice(0, 5);
const COLORS = ["#2563eb", "#c2410c", "#047857", "#7c3aed", "#be123c", "#0e7490", "#a16207", "#4d7c0f"];

const messagesEl = document.getElementById("messages");
const filtersEl = document.getElementById("filters");
const calendarEl = document.getElementById("calendar");

const hidden = new Set();
let members = [];
let entries = [];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toMinutes(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function showMessage(text) {
  messagesEl.append(el("div", "message", text));
}

// Bad rows are skipped and reported, so one typo doesn't take down the whole calendar.
function parseEntries(rawEntries, names) {
  const valid = [];
  rawEntries.forEach((entry, index) => {
    const start = toMinutes(entry.start);
    const end = toMinutes(entry.end);
    const row = `Entry ${index + 1} in data/schedule.json`;
    if (!names.has(entry.member)) {
      showMessage(`${row}: "${entry.member}" isn't in the members list.`);
    } else if (!DAYS.includes(entry.day)) {
      showMessage(`${row}: day must be one of ${DAYS.join(", ")}.`);
    } else if (start === null || end === null || end <= start) {
      showMessage(`${row}: start and end must be HH:MM (24-hour), with end after start.`);
    } else {
      valid.push({ ...entry, startMin: start, endMin: end });
    }
  });
  return valid;
}

// Overlapping entries in a day share the column width, side by side.
function layoutDay(dayEntries) {
  const sorted = [...dayEntries].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const placed = [];
  let cluster = [];
  let clusterEnd = -1;

  function closeCluster() {
    const laneEnds = [];
    for (const entry of cluster) {
      let lane = laneEnds.findIndex((end) => end <= entry.startMin);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = entry.endMin;
      entry.lane = lane;
    }
    for (const entry of cluster) placed.push({ ...entry, laneCount: laneEnds.length });
    cluster = [];
  }

  for (const entry of sorted) {
    if (entry.startMin >= clusterEnd) closeCluster();
    cluster.push({ ...entry });
    clusterEnd = Math.max(clusterEnd, entry.endMin);
  }
  closeCluster();
  return placed;
}

function formatHour(hour) {
  const suffix = hour < 12 || hour === 24 ? "am" : "pm";
  return `${hour % 12 || 12} ${suffix}`;
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
}

function renderCalendar() {
  const colorOf = new Map(members.map((member) => [member.name, member.color]));
  const visible = entries.filter((entry) => !hidden.has(entry.member));
  const days = DAYS.filter((day) => WEEKDAYS.includes(day) || entries.some((entry) => entry.day === day));
  const firstHour = Math.min(8, ...entries.map((entry) => Math.floor(entry.startMin / 60)));
  const lastHour = Math.max(18, ...entries.map((entry) => Math.ceil(entry.endMin / 60)));
  const hourCount = lastHour - firstHour;
  const todayName = DAYS[(new Date().getDay() + 6) % 7];

  calendarEl.style.setProperty("--day-count", days.length);
  calendarEl.style.setProperty("--hour-count", hourCount);
  const toPosition = (minutes) => `calc(${(minutes - firstHour * 60) / 60} * var(--hour-height))`;

  const headers = days.map((day) =>
    el("div", `day-header${day === todayName ? " today" : ""}`, day));

  const hours = el("div", "hours");
  for (let hour = firstHour; hour < lastHour; hour++) {
    const label = el("div", "hour-label", formatHour(hour));
    label.style.top = toPosition(hour * 60);
    hours.append(label);
  }

  const columns = days.map((day) => {
    const column = el("div", `day${day === todayName ? " today" : ""}`);
    for (const entry of layoutDay(visible.filter((item) => item.day === day))) {
      const block = el("div", "entry");
      block.style.setProperty("--member", colorOf.get(entry.member));
      block.style.top = toPosition(entry.startMin);
      block.style.height = `calc(${(entry.endMin - entry.startMin) / 60} * var(--hour-height) - 2px)`;
      block.style.left = `${(entry.lane / entry.laneCount) * 100}%`;
      block.style.width = `${100 / entry.laneCount}%`;
      block.title = `${entry.member}: ${entry.start}-${entry.end} ${entry.activity || ""}`.trim();
      block.append(el("strong", "", entry.member));
      if (entry.activity) block.append(entry.activity);
      if (entry.location) block.append(el("div", "", entry.location));
      column.append(block);
    }
    return column;
  });

  calendarEl.replaceChildren(el("div", "corner"), ...headers, hours, ...columns);
}

function render() {
  renderFilters();
  renderCalendar();
}

async function init() {
  try {
    const response = await fetch("data/schedule.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    members = data.members.map((name, index) => ({ name, color: COLORS[index % COLORS.length] }));
    entries = parseEntries(data.entries, new Set(data.members));
    document.getElementById("updated").textContent = data.updated ? `Last updated ${data.updated}` : "";
    render();
  } catch (error) {
    showMessage(`Couldn't load data/schedule.json (${error.message}). Check that it's valid JSON.`);
  }
}

init();
