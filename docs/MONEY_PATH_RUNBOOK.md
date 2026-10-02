# Money-path test: one real card, one real invoice (owner runbook)

Goal: prove that a brand-new, non-comped account can pay: Checkout -> webhook -> billing row -> usage -> meter
events -> invoice. Nothing here can be done by automation because it needs a real card. Budget: about $0.05 of
usage; the card is charged only if you choose Path B below.

Do NOT use your own account (195e7bde-..., comped: usage is never sent to Stripe, so it proves nothing).

## 0. Prerequisites (2 minutes)

```bash
cd ReadAloudAI/backend      # the money-path branch or main, both have the script
export STRIPE_SECRET_KEY=sk_live_...        # live key for acct_1Rj2XTKFBTQTkmzt (read-only use)
export SUPABASE_URL=https://qtfoqroezsdznbimeopj.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...
modal app list | grep -E "realtime-stt-worker|sound-effects-worker-readaloud"
```

* `realtime-stt-worker` must be listed (deployed). It was on 2026-10-02.
* `sound-effects-worker-readaloud` was NOT deployed on 2026-10-02. If it is missing, step 5 (sound effect) will
  sit in `processing` forever and bill nothing. Deploy it first (`cd backend/modal && modal deploy
  sound_effects_worker.py`), or skip step 5 and drop 1,800 units from every expected total below. Remember to
  `modal app stop sound-effects-worker-readaloud` afterwards if you do not want it left running.
* The backend must have been up for at least 5 minutes (the drain timer starts at boot).

## 1. Create the second account (use a different email than yours)

1. Open https://readaloudai.org/developers in a private window, sign up with a **second email** (not an
   @privaterelay address). Do not use a comp code.
2. Immediately run the check, which should show a fresh account:

```bash
node scripts/verify-money-path.mjs second@example.com
```

Expect: `no realtimetts_billing row`, `FREE CREDITS granted=10000 used=0 remaining=10000`, verdict `WARN no
realtimetts_billing row`. If it says COMPED, stop: that account was comped by mistake.

3. On /developers, create an API key (`rtts_...`). Save it.

## 2. Add the payment method (the only step that needs your card)

On /developers click **Add payment method**, complete Stripe Checkout with a real card. Stripe charges $0 now (the
price is metered, no base fee). Wait ~20 seconds for the webhook, then:

```bash
node scripts/verify-money-path.mjs second@example.com
```

Expect all of:

* `active=true comped=false`, `stripe_customer_id=cus_...`, `stripe_subscription_id=sub_...`
* `subscription ... status=active collection=charge_automatically`
* `default payment method present: true`
* `meter=mtr_...` on one item whose `event_name=realtimetts_characters`; total `0 units`
* verdicts `PASS` for billing row, subscription, payment method; a `WARN` for 0 units is correct at this point.

If `active=false` or no row: the webhook did not land. See "If something is off", item 1.

## 3. Run the three usage calls (about two minutes)

Free credits are not touched once the account is active and has a customer: all usage goes to Stripe.

**3a. One text-to-speech call, exactly 1,000 characters (Kokoro).** Expected billing: **1,000 units** ($0.01).
Node 22+ (global `WebSocket`):

```bash
export RTTS_KEY=rtts_...
node --input-type=module -e '
const text = ("The quick brown fox jumps over the lazy dog. ".repeat(30)).slice(0, 1000);
const r = await (await fetch("https://api.readaloudai.org/tts/authorize", {method:"POST",
  headers:{"content-type":"application/json"}, body: JSON.stringify({key: process.env.RTTS_KEY, engine:"kokoro"})})).json();
console.log("authorized", Object.keys(r));
const ws = new WebSocket(r.url + (r.url.includes("?") ? "&" : "?") + "token=" + r.token);
let bytes = 0;
ws.binaryType = "arraybuffer";
ws.onopen = () => ws.send(JSON.stringify({type:"synthesize", text, voice:"default", speed:1.0}));
ws.onmessage = (m) => { if (typeof m.data === "string") { const j = JSON.parse(m.data); if (j.type==="done"||j.type==="error") { console.log(j, "bytes", bytes); ws.close(); } } else bytes += m.data.byteLength; };
'
```

Expect `{ type: 'done' }` and a few hundred KB of audio. (If the exact wire details differ from
https://readaloudai.org/developers#reference, follow that page; what matters is exactly 1,000 characters on the
Kokoro engine and a `done` message. The gateway may count a handful of characters differently after text
normalisation; allow +/- 2%.)

**3b. One speech-to-text call, about 60 s of audio.** Expected billing: `round(duration_seconds x 3.0556)` units;
for a 60.0 s clip **183 units** ($0.00183). Make a clip and call the web tool or API:

```bash
say -v Samantha "Welcome to the quarterly update. Over the past three months our team shipped a new billing system, reduced latency, and onboarded two hundred customers. Thank you all for the hard work." -o t.aiff
ffmpeg -y -i t.aiff -ar 16000 -ac 1 -af apad=whole_dur=60 -t 60 t.wav     # padded to exactly 60.000 s
```

Upload `t.wav` at https://readaloudai.org/transcribe while signed in as the second account (this path bills
immediately, no 5-minute wait), or use the API in the developers page (`stt/authorize`, then `POST <url>/v1/stt`;
that path is drained every 5 minutes). Note the `duration` field of the response; expected units =
`round(duration x 3.0556)`.

**3c. One sound effect, 12 s.** Expected billing: 12 x 150 = **1,800 units** ($0.018). At
https://readaloudai.org/sound-effects type a prompt nobody has used (a cache hit is free and would bill
nothing), set duration 12, generate, and wait for the audio to appear.

**Expected total so far: about 1,000 + 183 + 1,800 = 2,983 units = $0.0298.**

## 4. Wait for the usage drain, then run the check

* Sound effect and web-STT meter events are sent the moment the job completes.
* Text-to-speech (and STT through an API key) is billed by the backend's drain job, which runs **every 5
  minutes** (`reportUsageToStripe`, started in `backend/src/index.ts`). Wait **6 minutes** after step 3a.
* Stripe's event summaries and invoice preview can trail the events by a few minutes. Re-run after another
  few minutes rather than concluding anything from a single zero.

```bash
node scripts/verify-money-path.mjs second@example.com
```

Expect:

| Item | Expected |
|---|---|
| character meter total | ~2,983 units (1,000 TTS + ~183 STT + 1,800 SFX), plus/minus the +/-2% on TTS |
| `~$` next to the meter | about $0.0298 |
| upcoming invoice | one line for `realtime-tts-per-char-v2-0.01-per-1k`, quantity about 2,983, amount rounded to **$0.03** (Stripe rounds a metered line to whole cents) |
| verdicts | PASS for active row, subscription, payment method, "character meter received N units" |
| free credits | unchanged at 10000 / 0 (they are not used once the account is paying) |

Do not expect separate lines per service: dub, isolate, convert, SFX, STT and TTS all land on the one
character meter as "character equivalents".

## 5. How to tell the drain worked, and what to check if not

The drain worked if the meter total rose by about 1,000 units for 3a with nothing else changing.

If the meter is still short after 12 minutes:

1. **Webhook never created the row** (step 2 failed): Stripe Dashboard -> Developers -> Webhooks -> the
   `.../webhooks/stripe` endpoint -> recent deliveries, look for non-2xx on `checkout.session.completed`.
   Check `realtimetts_billing` for this user. The backend ignores checkout sessions whose metadata is not
   `product=realtime-tts-api`.
2. **Drain not running**: `flyctl logs -a listenai-backend` (read-only) and look for `Periodic realtime-tts usage
   report failed`, `Failed to drain gateway usage`, `Failed to report usage to Stripe`. The line `Usage reported
   for a gateway key with no owning user record` means the gateway key id is not in `realtimetts_api_keys` for
   this user (key created on a different account, or the row is missing).
3. **Gateway counters**: the gateway zeroes its per-key counters at each drain. If the backend crashed between
   drain and Stripe call, that batch is lost (documented best-effort behaviour); repeat 3a and watch.
4. **Account is comped** (script prints WARN comped): usage is skipped on purpose.
5. **SFX / STT meter events missing**: check the job actually completed (status `ready`); failed jobs are not
   billed. For SFX confirm the Modal app is deployed (Prerequisites).
6. **Meter exists but not on the subscription**: the script prints FAIL "not attached to the
   realtimetts_characters meter"; the checkout used the wrong price id.

## 6. Close the test

Choose one:

**Path A (default, nothing is charged).** The usage is about $0.03, below Stripe's $0.50 minimum charge, so no
card charge can happen. In Stripe Dashboard -> Customers -> the second account -> Subscriptions -> Cancel
subscription -> **Immediately**, tick "Invoice now" if you want to see the final invoice line items (the
invoice is finalised but, being under the minimum, is not charged). Then delete the customer or leave it.

**Path B (proves the card is actually collected).** Before cancelling, add usage until the meter is >= 50,000
units (>= $0.50): e.g. run step 3a with 50 x 1,000-character Kokoro calls. Then Cancel -> Immediately with
"Invoice now". The card is charged; confirm the invoice is `paid`, then refund it from the invoice page
(Refund payment, full amount). Stripe keeps the processing fee on a refund (about $0.30 + 2.9%); that is the
cost of this test.

Afterwards confirm the local state flipped:

```bash
node scripts/verify-money-path.mjs second@example.com
```

Expect the billing row `active=false` (the webhook deactivates on `customer.subscription.deleted`) and the
subscription `status=canceled`. Finally, delete the second account's API key from /developers.

## What this runbook cannot prove

* That a card is accepted in a country/currency other than your own.
* Proration, tax (Stripe Tax is off: `automatic_tax.enabled=false`) and dunning for failed payments.
* Anything about the owner (comped) account beyond it being skipped.
