# Google Forms integration - setup guide

Every researcher can connect their own Google account so the platform can read the live question
structure of a Google Form used by a "Google Forms"-task-type research (Task Configuration page →
"Struktura ankete" / "Form structure" → "Pročitaj strukturu ankete" / "Read form structure"). This
is a **separate connection from Google Calendar** (its own OAuth client, its own encrypted token
column) - a form might be owned under a different Google account than the one used for scheduling.
Without connecting anything, a researcher can still describe CSV columns by hand in the same panel
- the automatic read is a convenience, not a requirement.

There are two audiences for this guide, same split as `google-calendar-setup.md`:
- **The project admin** (whoever manages the Google Cloud project) - a one-time step per project,
  plus adding each new researcher as a Test user.
- **Every researcher** - a 30-second in-app step, done once (or again after disconnecting).

---

## Part 1 - Project admin: one-time technical setup

This project already has a Google Cloud project set up for Calendar sync - reuse the same
project, just add a second OAuth client and enable a second API.

1. Enable the **Google Forms API** (Google Cloud Console → APIs & Services → Library → search
   "Google Forms API" → Enable). This is the same "must separately enable this specific API"
   requirement the Calendar integration hit - the OAuth client alone isn't enough.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type **"Web
   application"** → add the exact redirect URI from `GOOGLE_FORMS_REDIRECT_URI` in `.env` (e.g.
   `http://localhost:4312/api/admin/google-forms/oauth2callback` for local dev; the deployed
   backend's own equivalent URL in production). Use a **separate** client from the Calendar one -
   don't reuse it.
3. Put the resulting Client ID/Secret into `.env` as `GOOGLE_FORMS_CLIENT_ID` /
   `GOOGLE_FORMS_CLIENT_SECRET` (uncomment the placeholder lines already there).
4. `GOOGLE_FORMS_TOKEN_ENCRYPTION_KEY` is already generated and in `.env` - nothing to do here
   unless setting this project up fresh elsewhere, in which case generate one the same way as
   Calendar's: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
5. Add each researcher who'll use this as a **Test user**: Google Cloud Console → left sidebar →
   **Google Auth Platform** → **Audience** tab → Test users → **+ ADD USERS** → their Google
   account email. Same list Calendar already uses - if a researcher is already a Calendar test
   user, they still need adding here too (Test user status is per-*app*, but this is the exact
   same OAuth consent screen/app registration, so in practice the list is shared - double-check
   in the Audience tab rather than assuming).
6. **Explicitly add the Forms scope to the consent screen's Data Access list** - this step is easy
   to miss and, unlike a missing Test user, fails silently: Google Cloud Console → **Google Auth
   Platform** → **Data Access** tab → **Add or remove scopes** → filter/search for "Forms API" →
   check `.../auth/forms.body.readonly` → **Update** → **Save**. Requesting the scope from the
   app's code (`server/google-forms/oauth.mjs`) is not enough by itself - if it isn't also present
   in this Data Access list, Google silently issues a token that's missing the scope instead of
   failing the consent screen, and every read then 502s with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` (see
   Troubleshooting). Do this **before** any researcher connects - anyone who already connected
   before this step needs to disconnect and reconnect afterward (see Troubleshooting).

**If a researcher sees "Access blocked: this app's request is invalid"**: their account isn't in
the Test users list yet - add it there.

## Part 2 - Researcher: connecting your Google Forms access

1. Log into the Admin Dashboard.
2. Left nav → **Konfiguracija / Configuration**.
3. Scroll to **Google Forms** → click **"Poveži Google nalog" / "Connect Google account"**.
4. Sign in with the Google account that owns (or has at least view access to) the form your
   research actually uses, and click **Allow**.
5. You're redirected back to Configuration, now showing **"Povezano kao
   your-email@gmail.com"**.

From now on, the Task Configuration page's "Struktura ankete" panel shows a "Pročitaj strukturu
ankete" button for any Google-Forms-task-type research - it reads that research's saved form URL
using your connected account and fills in a question per row (label + a best-guess type), which
you can still hand-edit afterward before saving.

**To disconnect**: same Configuration page → "Prekini vezu" / "Disconnect". The saved
`TaskFormQuestion` rows aren't affected - only future re-reads stop working until you reconnect.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Access blocked: this app's request is invalid" during connect | Your Google account isn't in the Test users list yet | Ask the project admin to add it (Part 1, step 5) |
| "Pročitaj strukturu ankete" returns a FORMS_API_ERROR | The connected account doesn't have access to this specific form, or the form's id in the saved URL is wrong | Reconnect with the account that actually owns/can view the form; double-check the saved Google Forms link |
| Server log / error detail shows `Request had insufficient authentication scopes` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | The `forms.body.readonly` scope was never added to the OAuth consent screen's **Data Access** list (Part 1, step 6) - the connected account's token was issued *without* that permission even though the code asked for it, so every read 403s regardless of which form or which account | Add the scope in Data Access (Part 1, step 6) if not already done, **then** in the app: Configuration → Google Forms → "Prekini vezu" (Disconnect) → "Poveži Google nalog" (Connect) again - the *existing* token stays scope-less forever; only a fresh consent picks up the newly added scope |
| Server log shows `Google Forms API has not been used in project ... or it is disabled` | The OAuth *client* is configured, but the Forms *API itself* was never enabled for the project | Google Cloud Console → APIs & Services → Library → "Google Forms API" → Enable |
| "Niste povezali Google nalog" / "You haven't connected a Google account" shown even after connecting | You connected under a different logged-in researcher account than the one now viewing this page | Each researcher's connection is their own - reconnect from the account you're actually logged in as |
