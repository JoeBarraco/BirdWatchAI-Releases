# Gumroad → license key: setup runbook

What this wires up: a Gumroad sale fires a ping at a Supabase edge function,
which mints a **BirdWatch AI license key signed with our own RSA private key**
and emails it to the buyer.

**The two things to keep in mind while doing this:**

1. Existing license keys are unaffected. Validation is an offline signature
   check in the apps; nothing here can invalidate a key already in the wild.
2. Hand-minting with the desktop `LicenseGeneratorTool` keeps working exactly
   as it does today. Gumroad is a *second* minting path using the *same*
   private key. The apps cannot tell them apart, and no app release is needed.

Order matters: **do step 1 first**, or nothing else can be tested.

---

## Step 1 — Convert the signing key to PEM (one time, on your machine)

The edge function signs with WebCrypto, which wants PKCS#8 PEM. The desktop
tool's key is in .NET's XML format. Convert it in the `birdwatchai-server`
repo:

```bash
dotnet run --project tools/BirdWatch.LicenseKeyTool -- pem "C:\Users\jbarraco\Documents\GitHub\BirdWatchAI\LicenseGeneratorTool\bin\Debug\net8.0-windows\Keys\private_key.xml" --out license_private_key.pem
```

(That path is where the key actually sits today — the generator writes `Keys/`
next to its own binary. Confirmed present and confirmed to be the pair whose
public half both apps embed.)

The tool verifies that the key you handed it is the one whose public half is
embedded in both apps, and refuses to write the PEM if it isn't — that mismatch
is the single most likely way to end up mailing customers keys that don't
activate.

Treat `license_private_key.pem` like a password: it is the thing that mints
licenses. Paste it into the Supabase secret (step 3), then delete the file.
Don't commit it — the repo's `.gitignore` should already cover `*.pem`, but
check.

## Step 2 — Create the database objects (Supabase)

Supabase dashboard → **SQL Editor** → paste and run
[`supabase/setup-licenses.sql`](../../setup-licenses.sql).

That creates the `licenses` table, the Gumroad provenance columns, and three
RPCs: `license_lookup_by_email`, `record_manual_license`, `revoke_license`. The
file is written to be re-runnable, so running it again later after an edit is
safe.

## Step 3 — Set the function secrets (Supabase)

Dashboard → **Edge Functions → Secrets** (or the CLI, below). Generate the ping
token with something like `openssl rand -hex 32`.

| Secret | Required | What it is |
|---|---|---|
| `GUMROAD_PING_TOKEN` | **yes** | Long random string. Also goes in the ping URL as `?token=…`. The function returns 503 without it. |
| `LICENSE_PRIVATE_KEY_PEM` | **yes** | The whole PEM from step 1, `-----BEGIN PRIVATE KEY-----` line included. |
| `GUMROAD_PRODUCT_ID` | strongly recommended | Product id (or comma-separated ids/permalinks) allowed to mint. Without it, *any* product on your Gumroad account mints a license — including a $1 one. |
| `GUMROAD_ACCESS_TOKEN` | recommended | Lets the function call Gumroad back to confirm the sale is real. Needed if you turn Gumroad's own license keys off (see step 4). |
| `GUMROAD_REQUIRE_CALLBACK` | optional | `1` = refuse any ping that can't be confirmed against Gumroad's API. Turn this on once the callback route works. |
| `RESEND_API_KEY` | for email | Without it the key is stored but never mailed, and you'd have to send it by hand. |
| `LICENSE_FROM_EMAIL` | optional | e.g. `BirdWatch AI <licenses@birdwatchai.com>`. Must be a Resend-verified sender. |
| `LICENSE_TERM_DAYS` | optional | Unset/`0` = perpetual, which is the current product. `365` would issue annual keys. |
| `LICENSE_PRODUCT_VERSION` | optional | Stamped into the license payload. |

CLI equivalent (see `supabase/install_supabase_cli_and_deploy.txt` for getting
the CLI set up):

```bash
supabase secrets set GUMROAD_PING_TOKEN=... GUMROAD_PRODUCT_ID=... GUMROAD_ACCESS_TOKEN=...
supabase secrets set LICENSE_PRIVATE_KEY_PEM="$(cat license_private_key.pem)"
```

## Step 4 — Set up the Gumroad side

The products already exist — this is about pointing them at the function, not
creating anything.

1. **Allowlist every product that includes the software license — but a Gumroad
   Bundle is not one of them.** The failure here is silent: a buyer pays, no key
   is minted, and you don't find out until they email you.

   **Bundles need no entry of their own.** Tested 2026-08-18; the earlier
   advice in this file was wrong. Four different products were bought in a row,
   and all four rows in `licenses` recorded the *same* `gumroad_product_id` —
   the licence's. Gumroad reports the contained licence product, not the bundle
   wrapper. So:

   ```
   GUMROAD_PRODUCT_ID=dajhd
   ```

   covers the licence sold alone **and** every bundle containing it.

   That same test showed the allowlist is genuinely working rather than being
   unset. The Nest Indoor contains three things — licence, indoor feeder,
   camera — and produced exactly one row. Had `GUMROAD_PRODUCT_ID` been empty,
   every constituent would have minted and there would have been three. The
   feeder and camera pings are being ignored as intended.

   The function matches on either the API `product_id` or the permalink, so
   permalinks are fine here and are what you already have written down.

   **What DOES need adding: a licence-bearing product that is not a Bundle.**
   A standalone product carrying a licence reports its own id, matches nothing,
   and the buyer pays with no key. The live example is the shipping-inclusive
   `BirdWatchAI License + Indoor Feeder — delivered` ($120) — build it as a
   Bundle containing `dajhd` and no allowlist change is needed; build it
   standalone and it must be listed here. Prefer the Bundle, which also
   inherits "Require shipping address" from the feeder.

   The Shipping & Handling product must **not** be in the list. It carries no
   license, and a cart containing license + S&H fires one ping per product; the
   S&H ping is meant to be ignored.

2. **Decide about Gumroad's own license keys.** There's a per-product option
   along the lines of *"Generate a unique license key per sale"*:

   - **Off (recommended).** The buyer receives exactly one key — ours, by
     email. Cleaner, no "which of these two keys do I paste?" support mail.
     Requires `GUMROAD_ACCESS_TOKEN` so the function can verify sales via
     `/v2/sales/:id`.
   - **On.** Gumroad's key rides along in the ping, and the function verifies
     it via the public `/v2/licenses/verify` endpoint — no access token needed.
     Cost: Gumroad's receipt shows the buyer a key that is *not* the activation
     key. If you pick this, edit the product's receipt/content text to say
     "your activation key arrives in a separate email."

   Either way the function figures out which route it has and uses it; this
   only decides which secret you need and what the buyer sees.

3. **(Optional) Get the API `product_id`s** if you'd rather allowlist those
   than permalinks — the API id is not the number in the product-edit URL:

   ```bash
   curl "https://api.gumroad.com/v2/products?access_token=YOUR_TOKEN"
   ```

   and read each `id`. Permalinks work just as well for the allowlist.

4. **Point the ping at the function.** Gumroad **Settings → Advanced → Ping**
   (Gumroad moves this UI around; you're looking for the endpoint Gumroad POSTs
   to on every sale). Set it to:

   ```
   https://<your-project-ref>.functions.supabase.co/gumroad-license-webhook?token=YOUR_PING_TOKEN
   ```

5. **Generate an access token** if you need one: **Settings → Advanced →
   Applications** → create an application → generate an access token. Scope it
   to your own account; this is not an OAuth app for anyone else.

6. **Refunds and disputes — deliberately NOT set up.** There are no returns on
   the software license (owner's decision, 2026-08-17), so Gumroad is never
   told to call this function for refunds or disputes. The revoke and
   `dispute_won` un-revoke paths in the code are live but unreachable. Don't
   "fix" that; it's the intent.

   If the policy ever changes, here's the wiring. Note **`-X PUT`** — Gumroad
   creates resource subscriptions with PUT, not POST — and note that creating
   one needs a broader OAuth scope than the `view_sales` token the function
   runs on. Mint a separate short-lived token for these calls rather than
   widening the one in `GUMROAD_ACCESS_TOKEN`:

   ```bash
   curl -X PUT https://api.gumroad.com/v2/resource_subscriptions \
     -d "access_token=YOUR_TOKEN" \
     -d "resource_name=refund" \
     -d "post_url=https://<ref>.supabase.co/functions/v1/gumroad-license-webhook?token=YOUR_PING_TOKEN"
   ```

   Repeat with `resource_name=dispute` and `resource_name=dispute_won`. The
   function routes refunds and lost disputes to the revoke path, and
   `dispute_won` (the seller won the chargeback, so the sale stands) back to
   un-revoke. Confirm what's registered with:

   ```bash
   curl "https://api.gumroad.com/v2/resource_subscriptions?access_token=YOUR_TOKEN&resource_name=refund"
   ```

   Valid resource names, for reference: `sale`, `refund`, `dispute`,
   `dispute_won`, `cancellation`, `subscription_updated`,
   `subscription_ended`, `subscription_restarted`.

## Step 5 — Deploy the function

```bash
supabase functions deploy gumroad-license-webhook --no-verify-jwt
```

**`--no-verify-jwt` is not optional.** Supabase edge functions demand an
`Authorization: Bearer <jwt>` header by default, and Gumroad will never send
one — without the flag every ping gets a 401 and no license is ever issued.
That is exactly why `GUMROAD_PING_TOKEN` exists: it's the auth for an endpoint
that has no JWT gate.

## Step 6 — Test it end to end

1. Create a **100%-off discount code** on the product and buy it yourself with
   a real email you can read. Gumroad has no separate sandbox, so a free sale
   is the closest thing to a test purchase.
2. Watch **Dashboard → Edge Functions → gumroad-license-webhook → Logs**. On
   success you'll see `issued BWG-XXXX-XXXX-XXXX for sale …`.
3. Check the email arrives and contains a key ending in a long base64 block
   after a `|`.
4. **Verify the key actually activates** before you ever sell one. Two ways:

   ```bash
   dotnet run --project tools/BirdWatch.LicenseKeyTool -- verify "<the key from the email>"
   ```

   which checks it against the same embedded public key the apps use, and/or
   paste it into the server dashboard (Settings → License) or the Windows app
   (Help → Enter License Key).
5. Delete the test row when you're done:
   `delete from licenses where is_test or customer_email = 'your@email';`
6. Now set `GUMROAD_REQUIRE_CALLBACK=1` and redeploy, so unverifiable pings get
   rejected from here on.

---

## Things that will bite you

- **A 401 on every ping** means the `--no-verify-jwt` flag was missed.
- **A 403 on every ping** means the `?token=` in the Gumroad ping URL doesn't
  match `GUMROAD_PING_TOKEN`. Watch for a trailing space or a truncated paste.
- **A 503** means `GUMROAD_PING_TOKEN` isn't set at all.
- **`mint failed` in the logs** means `LICENSE_PRIVATE_KEY_PEM` is malformed —
  usually the header/footer lines got mangled or the newlines were eaten. The
  function returns 500 on purpose so Gumroad retries; fix the secret and the
  retry delivers the key without you touching anything.
- **The key arrives but won't activate.** You converted the wrong private key.
  Re-run step 1 and read what the tool says about the public-key match.
- **Bundle buyers get no key while license-only buyers do.** The bundle's
  product isn't in `GUMROAD_PRODUCT_ID`. The logs will show
  `ignoring ping for unrelated product`. See step 4.1 — this is the most likely
  way to lose a delivery, and it recurs every time a new bundle is created.
- **Buyer says they got two different keys.** Gumroad's native license keys are
  on; see step 4.2.
- **Revoking does not disable an activated install.** Validation is offline by
  design. Revocation stops portal re-downloads and marks the row for the day an
  online activation check exists.
