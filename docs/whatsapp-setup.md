# WhatsApp setup

This guide connects Wallet Budget Companion to the **WhatsApp Cloud API**. Once it's done you get the daily brief on WhatsApp, can reply `Budget` for the full brief at any time, and can optionally ask Claude questions.

WhatsApp is optional. The dashboard and sync work without it.

Meta changes its dashboards often. The steps below were checked against Meta's documentation in September 2026, and each section links the official page. If a menu name differs from what you see, the linked page is authoritative.

**You will end up with four secrets and a few settings:**

| Where | Name | From |
| --- | --- | --- |
| Worker secret | `WHATSAPP_ACCESS_TOKEN` | System user token (step 3) |
| Worker secret | `WHATSAPP_PHONE_NUMBER_ID` | API Setup panel (step 4) |
| Worker secret | `META_APP_SECRET` | App settings → Basic (step 5) |
| Worker secret | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Any random string you choose (step 6) |
| Dashboard setting | `whatsapp_to_numbers`, `wa_template_name`, `wa_template_lang`, `whatsapp_enabled`, `dry_run` | Steps 7–9 |

Set the secrets with `npm run setup` (it offers the WhatsApp secrets, and can generate the verify token) or one at a time:

```sh
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_WEBHOOK_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET
```

Secrets take effect immediately. `wrangler secret put` deploys a new version of the Worker.

---

## 1. Create a Meta app with WhatsApp

1. Go to [developers.facebook.com](https://developers.facebook.com/apps) → **My Apps** → **Create App**.
2. Choose the use case **Connect with customers through WhatsApp**.
3. Select your **business portfolio** (formerly Business Manager), or create one. The portfolio owns the WhatsApp Business Account (WABA), the phone numbers and the system users.
4. Finish creating the app. You land on the WhatsApp **Quickstart** / **API Setup** page, and the WhatsApp product is already added.

Official guide: [Get started with the WhatsApp Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started).

## 2. Test number or real number

Meta creates a **test WhatsApp Business Account and test phone number** for you. This is the fastest way to try things out:

- In **API Setup**, pick the test number as **From**, then add your own WhatsApp number as a **To** recipient and confirm it with the code WhatsApp sends you. A test number can only message recipients added this way.
- The test number can send templates without a payment method, but its messaging limits are relaxed only for testing. It isn't meant for daily use.

For everyday use, add a **real business phone number** (see [Phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)):

- You must own the number. It needs a country and area code (short codes aren't allowed) and must be able to receive an SMS or voice call.
- It can't be registered on the WhatsApp or WhatsApp Business app at the same time. Delete that account first, or use a spare number.
- After adding and verifying it in WhatsApp Manager, you must **register** it through the API with a 6-digit two-step-verification PIN you choose. It can't be registered from WhatsApp Manager or the App Dashboard ([Registration](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration)):

  ```sh
  curl -X POST "https://graph.facebook.com/v26.0/<PHONE_NUMBER_ID>/register" \
    -H "Authorization: Bearer <ACCESS_TOKEN>" -H "Content-Type: application/json" \
    -d '{"messaging_product":"whatsapp","pin":"<6-digit PIN>"}'
  ```

- You also provide a **display name**. Its review doesn't block messaging, only whether the name is shown in chats ([Display names](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names)).
- To send templates from a real number, the WABA needs a payment method (WhatsApp Manager).

## 3. Permanent access token (system user)

The token shown on the API Setup page is temporary and expires within a day. For the Worker, create a **system user** token ([Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)):

1. Open [Business settings](https://business.facebook.com/settings) for your business portfolio → **System users** → **Add**. Give it a name and the **Admin** role, or **Employee** (an Employee must be given access to the WABA explicitly).
2. **Assign assets** to the system user:
   - your **app**, with full control (*Manage app*),
   - your **WhatsApp account** (WABA), with full control.
3. **Generate token** → select your app → choose the expiration → select the permissions **`whatsapp_business_messaging`**, **`whatsapp_business_management`** and **`business_management`**.
4. Copy the token and store it as `WHATSAPP_ACCESS_TOKEN`.

About expiry: Meta offers non-expiring and 60-day tokens, and recommends expiring tokens for security ([system user tokens](https://developers.facebook.com/docs/business-management-apis/system-users/install-apps-generate-refresh-and-revoke-tokens)). A non-expiring token is simpler for a household bot. If you pick a 60-day token, set a reminder to generate a new one and re-run `npx wrangler secret put WHATSAPP_ACCESS_TOKEN`. An expired token shows up as error **190** in the run log.

## 4. Phone number ID

The **Phone number ID** (and the WhatsApp Business Account ID) are shown in the app's **WhatsApp → API Setup** panel, next to the selected **From** number. Store the phone number **ID**, not the phone number itself, as `WHATSAPP_PHONE_NUMBER_ID`.

## 5. App secret

In the App Dashboard, open **App settings → Basic** and reveal the **App secret**. Store it as `META_APP_SECRET`.

Meta signs every webhook call with it: the header `X-Hub-Signature-256: sha256=<hex>` is an HMAC-SHA256 of the raw request body keyed with the app secret ([Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint)). **This app requires it and fails closed:**

- without `META_APP_SECRET`, every webhook POST is rejected, and
- a missing or wrong signature gets `401`.

## 6. Configure the webhook

The webhook is how the app receives your messages (`Budget`, questions). It is also how it knows when the 24-hour window is open.

1. Make sure the Worker is deployed and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is set. Any random string works, for example `openssl rand -hex 32`. `npm run setup` can generate one.
2. In the App Dashboard, open **WhatsApp → Configuration** (in the use-case layout: **Use cases → Customize → Configuration**).
3. Set **Callback URL** to `https://<your-worker>.<your-subdomain>.workers.dev/webhook`.
4. Set **Verify token** to exactly the same value as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, then verify and save. Meta calls `GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`, and the Worker echoes the challenge only if the token matches.
5. Under **Webhook fields**, **subscribe to `messages`**. This field carries both incoming messages and the delivery status of messages you send.

If no events arrive after you switch to a real WhatsApp Business Account, check that your app is subscribed to that WABA. `GET https://graph.facebook.com/v26.0/<WABA_ID>/subscribed_apps` should list your app. If it doesn't, `POST` to the same URL with the system user token ([subscribed_apps reference](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/)).

Meta retries failed webhook deliveries for up to 7 days ([Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview)). The Worker answers `200` immediately, does the work in the background, and ignores duplicates by message ID. It also ignores messages older than the `stale_seconds` setting (default 300), so a burst of retries after an outage doesn't produce a burst of replies.

**Only numbers listed in the `whatsapp_to_numbers` setting may talk to the bot.** Messages from any other number are logged as `IGNORED_SENDER` and never answered. An empty list allows nobody.

## 7. The 24-hour window, and why you need a template

WhatsApp only lets a business send **free-form** messages inside a **customer service window**. The window opens, or resets to 24 hours, whenever the user messages (or calls) you. Outside the window, a business-initiated message must be a **pre-approved template** ([Service messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/service-messages)).

The daily brief is business-initiated, so the app decides per recipient:

- **Window open** (the recipient's last message was less than 23.5 hours ago; the app keeps a 30-minute safety margin): the full, multi-line brief is sent as normal text.
- **Window closed**: your approved template (`wa_template_name`) is sent, with the date, yesterday's expenses and the overall numbers filled in as parameters.

The recommended template ends with *"reply Budget"*. Each reply reopens the window and brings back the full brief, so on active days most briefs go out as free text.

The app learns about the window only from webhook messages. Without a configured webhook, it always sends the template.

## 8. Create the daily template

Create it in **WhatsApp Manager → Account tools → Message templates** → create a template ([Templates overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)):

- **Name**: e.g. `daily_budget_update` (lowercase letters, digits and underscores).
- **Category**: **Utility** or **Marketing**.
  - Utility templates are cheaper, and free inside an open window. They must be non-promotional, and a user-requested account update qualifies.
  - Meta may **recategorise** a utility template it considers marketing ([Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)).
  - Marketing templates are always charged and are subject to per-user delivery limits (error 131049).
- **Language**: English (`en`), or the language you write the body in.
- **Parameter type**: **Named** parameters (`{{date}}` rather than `{{1}}`).
- **Body**: paste the text below exactly. When you add the parameters, give each one a **sample value**; Meta requires one per parameter for review. For example: `Fri, 26 Sep 2026` for `date`; `2026-09-25 · Groceries — €42.10 from Main account` for `expense_1`; `–` for the others; `€1,234.00 of €2,000.00` for `overall_spent`.

```
💰 Family Budget Brief
{{date}}

━━━━━━━━━━━━━━━━━━
Yesterday's Expenses

- {{expense_1}}
- {{expense_2}}
- {{expense_3}}
- {{expense_4}}
- {{expense_5}}
- {{expense_6}}
- {{expense_7}}
- {{expense_8}}
- {{expense_9}}
- {{expense_10}}
━━━━━━━━━━━━━━━━━━
📊 Overall

Spent: {{overall_spent}}
Remaining: {{overall_remaining}}
Forecast: {{overall_forecast}}
━━━━━━━━━━━━━━━━━━
To see insights per category, reply Budget

Visit Budget Bakers to correct an expense's category label
```

The app fills exactly these 14 named parameters (see `renderTemplateParams` in [`src/budget/brief.ts`](../src/budget/brief.ts)):

| Parameter | Filled with |
| --- | --- |
| `date` | Today's date in your timezone, e.g. `Fri, 26 Sep 2026` |
| `expense_1` … `expense_10` | One of yesterday's included expenses each: `date · category — amount from account`. Unused slots get `–`, because Meta rejects empty parameters. Only the first 10 expenses fit; the free-text brief lists all of them. |
| `overall_spent` | `<spent> of <budget>` for the current budget period |
| `overall_remaining` | Remaining overall budget |
| `overall_forecast` | Forecast overall spend for the period |

Notes:

- Parameter values can't contain line breaks. That is why each expense has its own parameter. The app replaces line breaks in values with ` · `, collapses repeated whitespace and caps each value at 200 characters.
- Meta rejects templates that start or end with a parameter. The body above starts and ends with fixed text.
- You can change the wording, the emoji or the title line (it's fixed text in the template, independent of the `brief_title` setting), as long as you keep the parameter names. A template with different parameter names will fail to send (error 132000).
- Review usually takes minutes, and can take up to 24 hours.

## 9. Configure the app and test safely

In the dashboard, open **Settings** (or the WhatsApp step of the setup wizard):

1. **Recipients** (`whatsapp_to_numbers`): international format with `+`, comma-separated, e.g. `+15550100001,+15550100002`. These numbers receive the brief, and they are the only ones allowed to use the bot.
2. **Template name / language** (`wa_template_name`, `wa_template_lang`): exactly as approved, e.g. `daily_budget_update` / `en`. The language code must match the template's language (`en` is not the same as `en_US`).
3. **Brief hour** (`brief_hour_local`) and **timezone**.
4. Turn on **WhatsApp** (`whatsapp_enabled`).
5. Leave **dry run** (`dry_run`) **on** at first. Briefs and replies are then built and written to the message log with status `DRY_RUN`, but not sent. Compare them with the dashboard's **Brief** page, which shows the exact text and the template parameters. The log is under **Settings → Logs**.
6. Send a message to your business number from a recipient's phone (anything, e.g. `hi`). With dry run on, the log shows the reply that would have been sent. This also confirms the webhook and signature check work.
7. Turn **dry run off**, reply `Budget` from your phone, and use **Send brief now** (Settings) in the dashboard to trigger a real send.

## Troubleshooting

Errors are recorded under **Settings → Logs** in the dashboard (`run_log` and `message_log`). Delivery failures come back through the webhook as `whatsapp.status … status=failed errors=<code> …`. Common codes ([error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes)):

| Code | Meaning | What to do |
| --- | --- | --- |
| **131047** | Re-engagement message: more than 24 hours since the recipient last replied, so free-form text isn't allowed. | Configure `wa_template_name` so the app can fall back to the template. Replying `Budget` reopens the window. |
| **132001** | The template doesn't exist in that language, or isn't approved yet. | Check the name and `wa_template_lang` match the approved template exactly. |
| **132000** | The number of parameters doesn't match the template. | The template must use exactly the 14 named parameters above. |
| **131049** | Not delivered "to maintain healthy ecosystem engagement": Meta's per-user limit on marketing templates. | Wait 24 hours. Consider a Utility template, or keep the window open by replying `Budget`. |
| **131026** | Message undeliverable: the number isn't on WhatsApp, hasn't accepted the latest terms, or runs an old app version. | Check the recipient number and app. |
| **190** | Access token expired. | Generate a new system user token (step 3) and `npx wrangler secret put WHATSAPP_ACCESS_TOKEN`. |

Other symptoms:

- **Webhook verification fails**: the Worker isn't deployed, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` isn't set, or it differs from the value typed in Meta's form.
- **Messages arrive at Meta but the bot never answers**:
  - The run log shows `META_APP_SECRET is not set` or rejected signatures: check the app secret.
  - It shows `IGNORED_SENDER`: add the number to `whatsapp_to_numbers`.
  - Also make sure the `messages` field is subscribed.
- **"Free-text questions are disabled"**: Claude Q&A needs both the `ANTHROPIC_API_KEY` secret and the `ai_enabled` setting.
- **Test number send fails with "recipient not in allowed list"**: add the recipient in API Setup (step 2).
