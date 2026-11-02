// Turns text read from a class schedule into weekly busy times.
// A line is { words: [{ text, x0, x1 }] }; the x positions are only used for grid-style schedules.

const TIME_RANGE = /(?<![\d/:.])(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?(?![a-z]))?\s*(?:-|–|—|\bto\b)\s*(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m?\.?(?![a-z]))?(?![\d/])/gi;
const FULL_DAY = /^(mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?$/i;
const COMPACT_DAYS = /^(?:Th|TH|Tu|TU|Sa|SA|Su|SU|M|T|W|R|F)+$/;
const COMPACT_PIECE = /Th|TH|Tu|TU|Sa|SA|Su|SU|M|T|W|R|F/g;
const COMPACT_NAMES = { M: "Mon", T: "Tue", TU: "Tue", W: "Wed", R: "Thu", TH: "Thu", F: "Fri", SA: "Sat", SU: "Sun" };
const WEEK_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fullDayName(token) {
  const match = FULL_DAY.exec(token);
  if (!match) return null;
  const prefix = match[1].slice(0, 3).toLowerCase();
  return prefix[0].toUpperCase() + prefix.slice(1);
}

function tokenDays(token) {
  const full = fullDayName(token);
  if (full) return [full];
  if (!COMPACT_DAYS.test(token)) return null;
  return token.match(COMPACT_PIECE).map((piece) => COMPACT_NAMES[piece.toUpperCase()]);
}

function tokenize(text) {
  return text.split(/[\s,/&|;:.\-–—()]+/).filter(Boolean);
}

// Day codes must sit right next to the time, so a stray "M" in a course title isn't read as Monday.
function daysNearTime(segment, walkBackward) {
  const tokens = tokenize(segment);
  if (walkBackward) tokens.reverse();
  const days = [];
  for (const token of tokens) {
    if (/^and$/i.test(token) && days.length) continue;
    const found = tokenDays(token);
    if (!found) break;
    days.push(...found);
  }
  if (days.length) return days;
  return tokens.map(fullDayName).filter(Boolean);
}

function resolveTimes(match) {
  const startHour = Number(match[1]);
  const startMinute = Number(match[2] || 0);
  const endHour = Number(match[4]);
  const endMinute = Number(match[5] || 0);
  const startMark = match[3] && match[3].toLowerCase();
  const endMark = match[6] && match[6].toLowerCase();

  // Without a colon or am/pm, something like "8-12" is more likely a date or a number than a time.
  if (!match[2] && !match[5] && !startMark && !endMark) return null;
  if (startMinute > 59 || endMinute > 59 || startHour > 23 || endHour > 23) return null;

  const to24 = (hour, mark) => {
    if (mark === "a") return hour === 12 ? 0 : hour;
    if (mark === "p") return hour === 12 ? 12 : hour + 12;
    return hour;
  };

  let start;
  let end;
  if (endMark) {
    end = to24(endHour, endMark) * 60 + endMinute;
    start = to24(startHour, startMark || endMark) * 60 + startMinute;
    if (!startMark && start >= end) start = to24(startHour, endMark === "p" ? "a" : "p") * 60 + startMinute;
  } else if (startMark) {
    start = to24(startHour, startMark) * 60 + startMinute;
    end = to24(endHour, startMark) * 60 + endMinute;
    if (end <= start) end = to24(endHour, startMark === "a" ? "p" : "a") * 60 + endMinute;
  } else {
    // No am/pm at all: assume classes run from 8am to 7:59pm.
    const guess = (hour) => (hour >= 1 && hour < 8 ? hour + 12 : hour);
    start = guess(startHour) * 60 + startMinute;
    end = guess(endHour) * 60 + endMinute;
  }
  if (start >= end || end > 24 * 60) return null;

  const format = (minutes) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { start: format(start), end: format(end) };
}

function joinLine(line) {
  let text = "";
  const spans = [];
  for (const word of line.words) {
    if (text) text += " ";
    spans.push({ from: text.length, to: text.length + word.text.length, word });
    text += word.text;
  }
  return { text, spans };
}

function dayOnlyLine(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  const days = [];
  for (const token of tokens) {
    const found = tokenDays(token);
    if (!found) return null;
    days.push(...found);
  }
  return days;
}

function columnHeaders(line) {
  const columns = [];
  for (const word of line.words) {
    const day = fullDayName(tokenize(word.text)[0] || "");
    if (day && word.x0 !== undefined) columns.push({ day, x: (word.x0 + word.x1) / 2 });
  }
  return new Set(columns.map((column) => column.day)).size >= 3 ? columns : null;
}

function matchCenter(spans, from, to) {
  const touched = spans.filter((span) => span.from < to && span.to > from && span.word.x0 !== undefined);
  if (!touched.length) return null;
  return (touched[0].word.x0 + touched[touched.length - 1].word.x1) / 2;
}

function parseScheduleLines(lines) {
  const rows = [];
  const seen = new Set();
  let columns = null;
  let carriedDays = null;

  lines.forEach((line, lineIndex) => {
    const { text, spans } = joinLine(line);
    const matches = [...text.matchAll(TIME_RANGE)].filter((match) => resolveTimes(match));

    if (!matches.length) {
      const headers = columnHeaders(line);
      if (headers) {
        columns = headers;
        carriedDays = null;
      } else {
        carriedDays = dayOnlyLine(text) || carriedDays;
      }
      return;
    }

    matches.forEach((match, matchIndex) => {
      const previous = matches[matchIndex - 1];
      const next = matches[matchIndex + 1];
      const before = text.slice(previous ? previous.index + previous[0].length : 0, match.index);
      const after = text.slice(match.index + match[0].length, next ? next.index : text.length);

      let days = daysNearTime(before, true);
      if (!days.length) days = daysNearTime(after, false);
      if (!days.length && columns) {
        const center = matchCenter(spans, match.index, match.index + match[0].length);
        if (center !== null) {
          const nearest = columns.reduce((best, column) =>
            Math.abs(column.x - center) < Math.abs(best.x - center) ? column : best);
          days = [nearest.day];
        }
      }
      if (!days.length && carriedDays) days = carriedDays;
      if (!days.length && lines[lineIndex + 1]) days = dayOnlyLine(joinLine(lines[lineIndex + 1]).text) || [];

      const row = { days: WEEK_ORDER.filter((day) => days.includes(day)), ...resolveTimes(match) };
      const key = `${row.days.join()}|${row.start}|${row.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(row);
      }
    });
  });
  return rows;
}

// Finds a label like "Fall 2026" so the form can pick the matching semester.
function detectSemester(lines) {
  const text = lines.map((line) => joinLine(line).text).join("\n");
  const match = /\b(fall|spring|summer)\s*(?:semester|term|session)?\s*(20\d{2})\b/i.exec(text);
  return match ? `${match[1].toLowerCase()}-${match[2]}` : null;
}
