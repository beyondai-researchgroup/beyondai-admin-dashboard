# Email relay (Google Apps Script) — production email setup

Render's free tier blocks outbound SMTP (ports 25/465/587), so the deployed APIs (admin-dashboard,
consent, rei40, bigfive) can't use Gmail SMTP the way local dev does. Instead, `server/email/mailer.mjs`
POSTs each message over HTTPS to a small Google Apps Script web app owned by
`beyondai.researchgroup@gmail.com`, which sends it with `MailApp`. Local dev keeps using Gmail SMTP
(`GMAIL_USER`/`GMAIL_APP_PASSWORD`) — the relay is only used when `MAIL_RELAY_URL` and
`MAIL_RELAY_SECRET` are both set.

Limits: a consumer Gmail account can send to **100 recipients per day** through `MailApp`
(each participant gets ~3 emails: consent link, questionnaire links, Intro link).

## Script

Created at https://script.google.com while signed in as `beyondai.researchgroup@gmail.com`
(project name "BeyondAI Mailer"). Replace `PASTE_SECRET_HERE` with the same random value stored in
the Render env var `MAIL_RELAY_SECRET` — never commit the real value.

```javascript
const SHARED_SECRET = 'PASTE_SECRET_HERE';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SHARED_SECRET) return json({ ok: false, error: 'FORBIDDEN' });
    if (!body.to || !body.subject || !body.html) return json({ ok: false, error: 'BAD_REQUEST' });
    MailApp.sendEmail({
      to: body.to,
      subject: body.subject,
      htmlBody: body.html,
      body: body.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      name: body.fromName || 'BeyondAI Research Group',
    });
    return json({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run this once from the editor to grant the send-mail permission.
function authorize() {
  Logger.log('Remaining daily quota: ' + MailApp.getRemainingDailyQuota());
}
```

## Steps

1. Paste the script, save, select `authorize` → **Run** → grant permission (on the "unverified app"
   warning: **Advanced → Go to BeyondAI Mailer (unsafe) → Allow**).
2. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone** → Deploy.
3. Set `MAIL_RELAY_URL` (the Web app URL) and `MAIL_RELAY_SECRET` on the four Render services
   (`beyondai-admin-api`, `beyondai-consent-api`, `beyondai-survey-a-api`, `beyondai-survey-b-api`).

Editing the script later requires **Deploy → Manage deployments → Edit → New version**; saving alone
doesn't update the live web app. Rotating the secret: change it in the script (new version) and in all
four Render services.
