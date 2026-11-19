# WhatsApp automatic messages: setup

What it does, every day after 8:00 AM (Lagos time):
- Birthday: sends a birthday wish to members whose birthday is today.
- Reminder: the day before each weekly program, reminds every member who agreed to messages.
- Welcome: welcomes members who joined in the last 2 days.
Only members who ticked "Send me church updates on WhatsApp" (and have a WhatsApp number) get messages. If a member replies STOP, they are removed automatically.

Until you add the WhatsApp details below, the site stays in TEST MODE: it shows what it would send, and sends nothing. Admin > WhatsApp shows the status and a log.

## Step 1. Meta account and WhatsApp number
1. Go to developers.facebook.com, create an app (type: Business) and add the WhatsApp product.
2. Add the church's phone number in WhatsApp Manager. Use a number that is not already used on the normal WhatsApp app.
3. Copy the Phone number ID. This is WA_PHONE_ID.
4. In Meta Business Settings > System users, create a system user, give it your WhatsApp account, and generate a permanent token with the permissions whatsapp_business_messaging and whatsapp_business_management. This is WA_TOKEN.
5. To message real members you must complete Meta business verification and add a payment method. Until then Meta only lets you message a few test numbers.

## Step 2. Create 3 message templates (WhatsApp Manager > Message templates)
Language: English. Copy the text exactly, including the {{1}} style placeholders.

church_birthday
Happy birthday, {{1}}! Everyone at {{2}} celebrates you today. May God's favour follow you this new year. Reply STOP to stop messages.

church_reminder
Hello {{1}}, a reminder that {{2}} holds tomorrow at {{3}}. We look forward to seeing you at {{4}}. Reply STOP to stop messages.

church_welcome
Welcome to the {{1}} family, {{2}}! We are glad you joined us. Reply STOP to stop messages.

Meta must approve each template (usually minutes to a day). Meta chooses whether it counts as Utility or Marketing, which changes the price per message.

## Step 3. Add settings on Render (church-site > Environment)
- WA_TOKEN = the token from step 1
- WA_PHONE_ID = the Phone number ID
- WA_APP_SECRET = your Meta app secret (App settings > Basic)
- WA_VERIFY_TOKEN = any secret word you choose
- CRON_SECRET = any long random text
- WA_TEMPLATE_BIRTHDAY = church_birthday
- WA_TEMPLATE_REMINDER = church_reminder
- WA_TEMPLATE_WELCOME = church_welcome
- TIMEZONE = Africa/Lagos and SEND_HOUR = 8 (already set by render.yaml)
Save. Render restarts the site.

## Step 4. Connect the STOP webhook
In your Meta app > WhatsApp > Configuration > Webhook:
- Callback URL: https://YOUR-SITE.onrender.com/api/wa/webhook
- Verify token: your WA_VERIFY_TOKEN
- Subscribe to the field: messages

## Step 5. Make it run every day (free plan sleeps)
Create a free account on cron-job.org and add a job:
- URL: https://YOUR-SITE.onrender.com/api/cron/run?key=YOUR_CRON_SECRET
- Schedule: every hour
It only sends once per day, after 8:00 AM. If the site is asleep, this request wakes it. On a paid Render plan the site is always awake and also checks by itself every 10 minutes.

## Step 6. Test
1. Admin > WhatsApp > "Run now". In test mode it lists what it would send.
2. Add your own number to a member with the opt-in ticked, set your birthday to today, and run again.
3. Messages are charged by Meta per message. Check Meta's current price list for Nigeria.

## Notes
- Birthday and reminder messages use the approved templates above, not the wording in the admin boxes. Those boxes are for messages you send by hand.
- Only message people who agreed. Reply STOP is honoured automatically.
- Failed sends (for example a wrong number) are shown in the log and retried on the next run.
