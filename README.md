# Lab Schedule

A weekly calendar of lab members' recurring schedules, hosted on GitHub Pages. It's plain HTML, CSS and JavaScript with no build step.

## Updating the schedule

Edit [`data/schedule.json`](data/schedule.json), either on GitHub (pencil icon, then "Commit changes") or locally. The site updates a minute or so after the change is committed.

- `members`: everyone on the calendar. Colors are assigned by position in this list.
- `entries`: one object per recurring weekly block:

| Field | Required | Format |
|---|---|---|
| `member` | yes | Must exactly match a name in `members` |
| `day` | yes | `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat` or `Sun` |
| `start`, `end` | yes | 24-hour `HH:MM`, such as `13:30` |
| `activity`, `location` | no | Any text |

Entries with a mistake are skipped and listed in a red message at the top of the page.

## Privacy

GitHub Pages sites can be viewed by anyone with the link, and on a free GitHub account the repository must be public too, including its full edit history. Don't commit anything here that shouldn't be public.

## Running locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000.
