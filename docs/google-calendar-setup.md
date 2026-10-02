# Google Calendar sync - setup guide

Every researcher can connect their own Google account so that scheduled participant-sessions
(Experimental Sessions → assign) automatically become events on **their own** Google Calendar,
inviting the participant. This is per-researcher - connecting your account never touches anyone
else's calendar, and no one else's events show up on yours.

There are two audiences for this guide:
- **The project admin** (whoever manages the Google Cloud project - today, Andrej) - a one-time
  step per *new* researcher, in Google Cloud Console.
- **Every researcher** - a 30-second in-app step, done once (or again if you ever disconnect).

---

## Part 1 - Project admin: adding a new researcher

Google requires every account that will use this integration to be pre-approved, because the app
stays in Google's "Testing" publishing mode (avoids a multi-week verification review that isn't
worth it for a handful of known researchers - up to 100 accounts are supported this way).

1. Open [Google Cloud Console](https://console.cloud.google.com), select the project this app
   uses.
2. Left sidebar → **Google Auth Platform** → **Audience** tab. (Google reorganized this UI at some
   point - if you don't see "Google Auth Platform" in the sidebar, look for "OAuth consent
   screen" instead; the Test users list lives in the same place either way.)
3. Scroll to **Test users** → **+ ADD USERS**.
4. Enter the researcher's Google account email (the one they'll use to connect their calendar) →
   **Save**.

That's it - no code changes, no restart needed. The researcher can connect immediately after.

**If you ever see "Access blocked: this app's request is invalid" or "app hasn't completed
verification"** when someone tries to connect: it means their account isn't in the Test users list
yet. Add it there and have them try again.

## Part 2 - Researcher: connecting your calendar

1. Log into the Admin Dashboard.
2. Left nav → **Podešavanja / Settings**.
3. Click **"Poveži Google nalog" / "Connect Google account"**.
4. You'll land on a real Google sign-in/consent screen. Sign in with the Google account your
   study Google Calendar should live on (the admin must have added this exact account per Part 1
   first), and click **Allow**.
5. You're redirected back to the Settings page, now showing **"Povezano kao
   your-email@gmail.com"**.

From now on, every time you assign a participant to a time slot (Experimental Sessions page), a
45-minute event appears on your Google Calendar automatically, inviting the participant if they
have an email on file. Rescheduling the experimental session's date moves the event too (same
time of day). Unassigning or deleting the experimental session cancels the event.

**To disconnect**: same Settings page → "Prekini vezu" / "Disconnect". Future assignments simply
won't create events until you reconnect - nothing else breaks.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Access blocked: this app's request is invalid" during connect | Your Google account isn't in the Test users list yet | Ask the project admin to add it (Part 1) |
| Settings page shows "not connected" right after you approved on Google | The redirect landed on `?calendarError=1` | Check the server log for the real error (a sanitized message is shown to you on purpose); most commonly the Calendar API itself isn't enabled yet in the project - see below |
| Assigning a session doesn't create a calendar event, no error shown anywhere | You're not connected (or disconnected) | This is by design - sync is best-effort and silent when not connected. Connect via Settings and re-assign, or just wait for the next new assignment |
| Server log shows `Google Calendar API has not been used in project ... or it is disabled` | The OAuth *client* is configured, but the Calendar *API itself* was never enabled for the project | Google Cloud Console → APIs & Services → Library → search "Google Calendar API" → Enable. Takes effect within a minute or two |

## One-time technical setup (already done for this project - reference only)

If this project ever needs to be re-created in a fresh Google Cloud project:

1. Enable the **Google Calendar API** (APIs & Services → Library).
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **"Web
   application"** → add the exact redirect URI from `GOOGLE_CALENDAR_REDIRECT_URI` in `.env`
   (e.g. `http://localhost:4312/api/admin/calendar/oauth2callback` for local dev; the deployed
   backend's own equivalent URL in production).
3. Put the resulting Client ID/Secret into `.env` as `GOOGLE_CALENDAR_CLIENT_ID` /
   `GOOGLE_CALENDAR_CLIENT_SECRET`.
4. Generate `CALENDAR_TOKEN_ENCRYPTION_KEY` once:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → paste into `.env`.
5. Set `ADMIN_DASHBOARD_APP_URL` to the frontend's own base URL (where Settings redirects back to
   after consent).
6. Follow Part 1 above for every researcher who'll use it.
