# Lifespan Cognition Lab Schedule

A week-by-week calendar of the times lab members can't be in the lab, hosted on GitHub Pages. Members add their unavailable times (classes, other commitments and time off), and any time they haven't added counts as available. Use the arrows or the small month calendar to move between weeks, months and years. It's plain HTML, CSS and JavaScript with no build step.

## Using it

Sign in with the Google account your lab reviewer added. There are three roles: **RAs** and **Grad Students/Post-Docs** see only their own schedule, and **Reviewers** see everyone's and manage the lab. RAs' changes to saved times and their time off go to a reviewer for approval; Grad Students/Post-Docs' save straight away, and reviewers are emailed about them. The top bar switches between **Calendar** and **Update Availability**, and reviewers also see **Lab Management**. You only see your own unavailable times; reviewers can see everyone's.

- **Class schedule:** pick the semester, then upload a PDF or screenshot, or enter times by hand. The file is read in your browser and is never uploaded. Check the times it found, then save. If your schedule changes partway through, choose **A change to my schedule partway through**: your earlier classes stay, and the new times start on the date you pick.
- **Standing conflict:** regular commitments outside class, which stay on the calendar through holidays and breaks.
- **Request time off:** whole days, or part of a single day, with a required Notes/Reason. For RAs it goes to a reviewer, and shows as pending on your own calendar until it's approved. Editing an approved request sends it back for review.
- **My availability:** edit or remove anything you've saved, and see the status of your requests.
- **On the calendar:** click your own blocks to change or remove them, drag a block to change its time (drag its bottom edge to change when it ends), or drag across empty space to add a time. You choose whether it repeats every week (until a date, until the last day of classes, or with no end) or happens once. Repeating times save straight away; one-time times are sent as a time off request for that part of the day. Changes to times you've already saved go to a reviewer, and your saved times stay in place until the change is approved. You can cancel a change while it's waiting.
- **Lab Events** (reviewers only): reviewers' calendar opens on **Lab Events**, which shows participant visits; switch to **Unavailability** to see everyone's unavailable times. Every weekday that isn't a USC staff holiday has a *Participant Visit - Lab* slot (9–11 AM: Dry Lab for the whole slot; Phlebotomy for 30 minutes at any point in the slot; Wet Lab for 2 hours starting within 30 minutes after phlebotomy ends, which can run past the slot; Wet Lab and Dry Lab done by different people; phlebotomy goes to the most experienced level free: with no Experienced Phlebotomist the slot is amber with a note that mobile phlebotomy may need to be on stand-by, or booked in advance for difficult veins, and with only a Training Phlebotomist it's red, since it can only go ahead if mobile phlebotomy is booked in advance) and a *Participant Visit - Scan* slot (11 AM–1 PM; two scanners, with Auxiliary Support Scanning paired with Level 2 Scanning, someone with Level 2 Scanning outside weekdays 8 AM–5 PM, and someone for wanding/taping unless that's turned off for the visit). Each slot lists who's trained and free; red slots can't be fully staffed and say why, and amber slots only work with a particular timing, which the slot spells out, or have no Experienced Phlebotomist. An asterisk marks someone who's only free for part of the time, with details below the names. Click a slot to change its time, turn off wanding/taping, or cancel it; drag to move it; drag across empty space to add a visit. Cancelled default visits show a **Restore** link. Time off that's still waiting for review counts as unavailable.
- **Lab Management** (reviewers only), with **Review requests**, **Lab members** and **My information** tabs: approve or decline requests, and manage who has access. Removing someone also deletes their schedule. **Edit schedule** next to a person opens **Update Availability** for them: reviewers can pick anyone under **Entering times for** and add, change or remove their classes, conflicts and time off, which saves straight away without review (time off entered this way counts as approved). Reviewers can also click or drag anyone's blocks on the Unavailability calendar. Each person's training (Wet Lab, Dry Lab, a phlebotomy level of Experienced Phlebotomist, Phlebotomist or Training Phlebotomist, Level 1 Scanning, Level 2 Scanning, Auxiliary Support Scanning, and Wanding/Taping) can be changed at any time under **Lab members**. Reviewers get an email when a new time off request or schedule change is waiting (see **Request emails** below), and can turn that off under **My information**.

Reading works best when each class has its days and times written out as text, such as `MWF 9:00-9:50 AM`. Calendar-style screenshots that show classes only as colored blocks have no times to read, so those need to be entered by hand.

## USC dates

Semesters, holidays and breaks are in [`data/academic-calendar.json`](data/academic-calendar.json), copied from the [USC academic calendar](https://usc.edu/academic-calendar/) through Summer 2029. Add later years there as USC publishes them. Each "Break between terms" is the gap between official terms, not a name USC uses. Some USC schools publish their own calendars, which can differ.

Class times only appear from the first to the last day of classes, and not on holidays or breaks. Study days and final exams are labeled, but regular class times aren't shown on them.

## USC staff holidays

Participant visits skip the dates in [`data/staff-holidays.json`](data/staff-holidays.json). They follow USC's Paid University Holidays policy (New Year's Day, MLK Day, Presidents' Day, Memorial Day, Independence Day, Labor Day, Thanksgiving and the day after, Christmas) plus winter recess. A Saturday holiday is observed the Friday before and a Sunday holiday the Monday after. USC sometimes adds a bridge day when a holiday falls on a Tuesday or Thursday, so add those to the file when they're announced. The 2026 winter break runs Dec 17, 2026 to Jan 10, 2027 for staff, matching the student break. Visits still run during student-only breaks.

## How it's set up

This repository is public and holds only the site's code and USC's public dates. Schedules live in a private Firebase database. The site's code runs in people's browsers, so **[`firestore.rules`](firestore.rules) is what actually enforces privacy**. After any change to that file, paste it into the Firebase console (Firestore Database > Rules) and publish it.

The values in `firebase-config.js` identify the project and are meant to be public. Never commit a service account key.

Setup:

1. Create a project in the [Firebase console](https://console.firebase.google.com/) and add a Web app. Copy its values into `firebase-config.js`.
2. Under **Authentication > Sign-in method**, enable **Google**. Under **Authentication > Settings > Authorized domains**, add `dbelkind.github.io`.
3. Create a **Firestore Database** in production mode, and paste in `firestore.rules` under **Rules**.
4. Add the first reviewer by hand: create a collection named `members` and a document whose ID is their Google email in lowercase, with the string fields `name` and `role` set to `reviewer`. Add everyone else from the site.

## Staffing in Google Calendar

[`apps-script/Code.gs`](apps-script/Code.gs) is a Google Apps Script that copies participant visit staffing into a **Lab Staffing** calendar in your Google Calendar every hour, covering the next 60 days. Each visit slot becomes an event: green when it can be fully staffed, yellow when it only works with careful timing, and red when it can't, with who's available for each role in the event details. It reads the schedule with your own Google login, so it must run under the account that owns the Firebase project (dbelkind@usc.edu), and it loads the staffing rules from the published site, so push site changes to GitHub before expecting them in the calendar. Its calendar permission is limited to calendars the script creates itself, so it can't see or change any of your other calendars.

Setup, once:

1. Go to [script.google.com](https://script.google.com) signed in as dbelkind@usc.edu and create a **New project**. Name it "Lab Staffing Sync".
2. Under **Project Settings** (the gear), tick **Show "appsscript.json" manifest file in editor**.
3. Back in the **Editor**, replace the contents of `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json), and the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs). Save.
4. Choose **setUp** in the function menu at the top and click **Run**. Google asks for permission; because it's your own script it may say Google hasn't verified it, so choose **Advanced**, then **Go to Lab Staffing Sync**, and allow.
5. A **Lab Staffing** calendar appears in Google Calendar within a minute. Keep it to yourself: its events show who's free when.

It then updates the calendar every hour and checks for new requests every 10 minutes on its own.

**Request emails.** The same script emails reviewers about new time off requests and schedule changes, once per request, and about changes and time off Grad Students/Post-Docs have saved, from the account it runs under. Each reviewer can turn this off by unticking **Email me when requests need review** under **Lab Management → My information**; it's on unless they do. Nobody is emailed about their own request. The first check after setup only notes what's already waiting, so it doesn't email old requests. The link in each email opens **Review requests**. To see what it did, open **Executions** in the Apps Script sidebar. To stop it, delete its trigger under **Triggers**. Only events the script made are changed; anything you add to the Lab Staffing calendar by hand is left alone. Edit visits on the website, not in Google Calendar, since the next hourly run puts the calendar back in line with the site.



```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. If port 8000 is taken, use a different number.

After changing `style.css` or any of the site's `.js` files, raise the `?v=` number on its link in `index.html`, so browsers don't keep using their cached copy.
