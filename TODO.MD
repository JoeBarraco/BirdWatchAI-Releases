TO DO LIST
- ~~Remove auto selecting "Near Me" when entering into community feed. Currently every refresh reselects "Near Me".~~ DONE
- ~~Fix problem with confetti showing on every refresh. Very annoying.~~ DONE
- ~~"Play Call" Button opens web page to "Macaulaylibrary.org", but doesnt actually play the audio~~ DONE
- ~~Need the concept of a community moderator. Need to be able to assign users the ability to "cleanup" detections (Rename, delete, adjust rarity, etc)~~ DONE
- ~~Remove the "Debug log" screenshot from the "See it in action" section of the main page.~~ DONE
- ~~Allow moderators and administrators the ability to change their passwords.~~ DONE
- ~~Need to finalize mailing list with Resend.~~ DONE
- ~~Not all detections are showing in the statistics panel. I know there are woodpeckers, blue birds, and squirrel that do not show there.~~ DONE
- ~~When the refresh occurs, it brings the bird of the day back if I dismissed it.~~ DONE
- ~~Would like to be able to disable auto refresh, or adjust the refresh frequency.~~ DONE
- ~~Would like to allow users to like detections, then be able to sort by most liked. Currently I dont think the likes are seen by others.~~ DONE
- Favorited detection uploads should translate to "Liked" by the uploaded (requires backend: add is_favorite column to community_detections and auto-create reaction on upload)
- ~~Need to provide some photos of the bird feeder (both types) so we can price "The full nest" option. I am thinking the Full Nest should be $150 and the software half that ($75).~~ DONE (Full Nest priced at $150, software license at $75)
     - ~~Need to update pricing on "Gumroad" first, as well as add Full nest to gumroad.~~ DONE
- **When you change `css/style.css` or `js/main.js`, bump the `?v=` on both tags in index.html.** GitHub Pages serves assets with a 10-minute max-age, so a browser can load new HTML against the previous JS. That mismatch is silent and looks like a feature is simply broken — it is what made the pricing configurator's total stop updating. The current stamp is `20260817c`; any new value works, a date plus a letter is fine.
- **Gumroad: selling configured builds.** Done — every product exists, is wired, and was verified live. All 22 permalinks resolve with the expected name and price; all 120 builder combinations were driven end to end, and 119 of 119 real ones check out at the correct total (the 120th is an empty selection at $0, which correctly offers nothing).

     - **Shipping is live and rate-limited by order size.** `SHIPPING.permalink` is `gktxni` ($25). It is added once per order, only when something physical is in the build, and waived at $100 or more. A licence on its own never posts it. That makes 15 of the 120 combinations one-click: the licence, the four computers (all over $100, so shipping-free), and all ten bundles. Small hardware orders — a lone lens, a feeder, a camera — are two adds, the item plus the fee.
     - **DONE — shipping-inclusive products, to stop the fee being deleted from the cart.** The separate `gktxni` fee is a normal cart line, so a buyer can remove it and ship for free. Fix: sell each sub-$100 build as one product with the $25 already inside. **Exactly 11 exist** — every computer starts at $110 so any build with one already ships free, and the two feeders are mutually exclusive. Code is wired and verified (`SHIPPED` table in `js/main.js`); a `null` permalink there falls back to the old component-plus-fee cart, so these can be created a few at a time and each goes live the moment its permalink is pasted in. Nothing breaks in between.

          All 11 exist, all 11 wired into `SHIPPED` in `js/main.js`, no empty slots left:

          | Product name | Price | `SHIPPED` key | Permalink |
          |---|---|---|---|
          | Indoor Feeder — delivered | $45 | `feederIndoor` | `xcrqr` |
          | Macro Lens — delivered | $50 | `macro` | `fifssk` |
          | Camera — delivered | $65 | `camera` | `fnygup` |
          | Outdoor Feeder — delivered | $65 | `feederOutdoor` | `ypbrqy` |
          | Indoor Feeder + Macro Lens — delivered | $70 | `feederIndoor+macro` | `pnpth` |
          | Indoor Feeder + Camera — delivered | $85 | `camera+feederIndoor` | `znfdbp` |
          | Camera + Macro Lens — delivered | $90 | `camera+macro` | `lktnp` |
          | Outdoor Feeder + Macro Lens — delivered | $90 | `feederOutdoor+macro` | `piqcnu` |
          | Outdoor Feeder + Camera — delivered | $105 | `camera+feederOutdoor` | `typcpg` |
          | Indoor Feeder + Camera + Macro Lens — delivered | $110 | `camera+feederIndoor+macro` | `hdjurk` |
          | BirdWatchAI License + Indoor Feeder — delivered | $120 | `feederIndoor+software` | `alizce` |

          The last one was the only licence-bearing member and was built as a Gumroad **bundle**
          containing `dajhd` + `ittcdq` + `gktxni`. Verified on creation: `native_type: bundle`,
          $120, contains the licence, and `require_shipping: true` inherited from the feeder. So
          the licence webhook fires on the contained licence product and mints a key with no
          `GUMROAD_PRODUCT_ID` change.

          Rules for every one of them:
          - Turn on **"Require shipping address"**. Gumroad no longer has a Physical good type — this toggle is what collects an address. A Bundle cannot set it directly but **inherits** it from any item inside that requires shipping. Both halves verified live on 2026-08-17: a lone indoor feeder checked out as "Indoor Feeder — delivered" at $45 and demanded an address, and a Full Nest bundle demanded one too.
          - **Worth doing first:** turn the toggle on for the four bare components (`ittcdq`, `pqwifk`, `mnrvz`, `ujgfpc`). Because bundles inherit it, that should make all ten existing kit bundles collect addresses as well — closing the fulfilment gap across the whole storefront, not just these eleven products.
          - Paste the permalink into the matching `SHIPPED` key in `js/main.js` and bump the `?v=` on both tags in `index.html`.
          - The $120 one delivers a licence, so **build it as a Gumroad Bundle containing `dajhd`** (plus the indoor feeder). Tested 2026-08-18: Gumroad reports the *contained* licence rather than the bundle wrapper, so a bundle needs no `GUMROAD_PRODUCT_ID` change at all — while a standalone licence-bearing product reports its own id, matches nothing, and the buyer pays $120 and gets no key. The bundle also inherits "Require shipping address" from the feeder, so one choice solves both.

          Superseded: `asuoeh`, `exnelh` and `ybqrn` were the first three, created as standalone
          products rather than bundles. They were rebuilt as bundles containing Shipping & Handling —
          `xcrqr` $45, `fifssk` $50, `fnygup` $65 — and the builder points at the new three. The old
          three are still Published and still sell at the same prices; archive them.

          Known and accepted: the four bare components (`ittcdq`, `pqwifk`, `mnrvz`, `ujgfpc`) **must stay published** — 60+ over-$100 builds still add them individually at free shipping. So a $20 indoor feeder and a $45 indoor-feeder-delivered coexist in the store. Hide the bare four from the Gumroad profile/discovery so only builder links reach them, otherwise someone finds the $20 listing and ships free anyway.
     - **The two BYOC listings are retired.** The builder now points at the new `nuhhw` (Nest — Indoor, $110) and `dtqrunq` (Nest — Outdoor, $130). `dzjxfn` and `irvwmy` are no longer referenced anywhere in the site, and the dead `#buy-btn` / `#buy-nest-btn` handlers that still called `irvwmy` are gone. Both old listings are still Published in Gumroad — unpublish them so nobody reaches a duplicate through search.
     - **All ten bundles are wired**, each verified to link to its own product: Nest Indoor/Outdoor, and Wren/Finch/Jay/Cardinal in both feeder styles.

     Still to check in Gumroad itself, none of it visible from the site:
     - **Nothing is flagged as a physical good, so no address is being collected.** Checked live: every product reports `is_physical: false` / `native_type: "digital"`, including the feeders, camera, lens and computers. Gumroad only shows the shipping section — destinations, rates, and the address fields at checkout — on products created as a *Physical good*, so today a Nest order captures an email and nothing else. This blocks fulfilment, not just the fee.
     - **Product type appears to be chosen at creation.** Gumroad's own walkthrough starts "click New product and choose Physical good"; whether an existing digital product can be converted could not be verified from outside the editor. Check one before assuming — if it cannot be changed, the eight physical components and the hardware bundles need recreating as physical goods, which is another run at the 10-a-day limit.
     - **Then set each physical product's shipping rate to $0** (Options tab, "Amount alone" and "Amount with others"). Gumroad rates are per product, so anything left on charges again on top of the $25 S&H item, and twice on a two-item cart.
     - **Keep the separate S&H product regardless.** Gumroad's native shipping is a flat per-product rate with no order-value threshold, so "free over $100" cannot be expressed there — that rule only exists in the builder, and only works with the native rates at zero.
     - **Shipping destinations are how you limit where you sell.** Only countries added as a destination can buy the product, which is also the answer to restricting outside the US — though it stays country-level, so the US still includes AK and HI. The site says continental US and points elsewhere at support@birdwatchai.com.
     - Cosmetic: `dzjxfn` has a double space in "The Nest  - Indoor" and `irvwmy` is missing the space before its em dash. Only matters if you keep them rather than unpublishing.
     **How the mechanism works**, from probing Gumroad directly, so nobody repeats the work:
          - The overlay widget does **not** bundle. Reading `assets.gumroad.com/js/gumroad-bundle.js`: it binds every `<a>` on the page and, on click, sets a single iframe's `src` to that one product. Each click replaces the last. The help-centre text claiming linked products bundle together is wrong for the current script.
          - Gumroad *does* have a real cart — `/checkout` exposes `max_allowed_cart_products: 50` plus `add_products` and `clear_cart`.
          - `https://gumroad.com/checkout?product=<permalink>` adds exactly one product to it. Repeating `?product=` keeps only the last; `product[]`, `products=`, comma-separated and `add_products[]` all add nothing.
          - Adds **do** accumulate, so a build becomes one link per item and a single checkout.
          - The software discount lives in bundle prices: every bundle is exactly $25 under the sum of its parts, which is the old $50-vs-$75 licence gap expressed as a saving. No cheap licence product exists to be found in the page source. The consequence: a combination with no matching bundle pays the full $75 — "software + camera, no feeder" is $115, not $90.
- ~~The "Download Free Trial" button still ships the old WinForms app, and there is no click-to-download path to the server edition at all.~~ DONE (2026-08-17) — the download section is now server-first: two install cards (Raspberry Pi / a computer you already own, with Windows · macOS · Linux buttons), a copy-paste three-line Docker quick start, and the legacy desktop installer demoted to a collapsed `<details>` labelled "no longer being developed". `#download-btn` and its JS handler are gone; the legacy installer is a plain `<a>` (still pinned to v2.1.2.0, which is correct now that the desktop app is frozen). Nav and hero say "Start Free Trial", not "Download", since there is no single file to hand over. Trial length corrected to 30 days everywhere on the page (server default, `BirdWatchSettings.TrialDays`); the old copy said 14 days and claimed a watermark, which is desktop behavior — on the server, expiry stops monitoring until a key is entered.
  Still open, and now purely upside rather than a gap:
     - Publish self-contained builds as release assets on birdwatchai-server-releases (win-x64, linux-x64, linux-arm64, osx-arm64) and turn the platform buttons into real downloads. Note this changes docs/RELEASING.md, which deliberately publishes tags + notes only, no binaries — that decision needs revisiting first.
     - Publish a prebuilt Raspberry Pi SD-card image. Still the genuinely clean "one click, flash, done" path, and it doubles as the thing the preloaded-Pi product is built from.
     - ~~The manual has no macOS install section, so the landing page’s macOS button points at MACOS-SETUP.md on the birdwatchai-server-releases repo rather than the manual.~~ DONE (2026-08-17) — `docs/manual/part-3-installation.html` now carries a `#macos-docker` section between Windows + Docker and Other Linux, ported from MACOS-SETUP.md: Docker Desktop (Apple Silicon vs Intel), Git via the Command Line Tools, clone, compose up, dashboard, auto-start on reboot, the `.command` helper scripts and hands-off mode. The two Mac-only traps are called out where you hit them rather than in a troubleshooting table — Gatekeeper refusing an unsigned `.command`, and Docker Desktop’s Linux VM interposing its own timezone over the `/etc/localtime` mount, which reads as detections stamped hours off. Every platform list in the manual gained macOS: the sidebar TOC on all ten pages, the Desktop-vs-Server table, the server requirements, the “pick your path” table and the quick start. The landing page’s macOS button now points at the manual anchor.
       - Found while verifying: three `<title>` tags still carried pre-reorder part numbers (Camera Hardware said Part 4, Installation said Part 2, First-Time Setup said Part 3). Fixed — all eight parts now agree across `<title>`, `data-part`, breadcrumb and part-tag. Only the title was ever wrong, so it showed up in browser tabs and search results while every on-page number read correctly.
       - **New drift risk.** The macOS walkthrough now exists twice: `docs/manual/part-3-installation.html#macos-docker` here, and MACOS-SETUP.md on birdwatchai-server-releases (sourced from `docs/release-repo-content/` in the private server repo). Windows and the Pi already had this problem; it is now three platforms deep. If an install step changes, both copies need it.
     - ~~`docs/setup-guide.html` still tells people to "run the installer" and links back to #download for the desktop app.~~ DONE (2026-08-17) — rewritten around the server. Step 1 is now the four install walkthroughs plus the three-line Docker quick start; step 2 opens `:8080` and runs the first-run wizard; step 3 clicks “Start monitoring” on the dashboard. Notification sections renamed to the settings headings the server actually uses (Email / Pushover / ntfy notifications) and ntfy added, since it is the free no-account option and was missing. Camera advice corrected: it recommended the C120 for “excellent 2K quality”, which is the exact configuration `CLAUDE.md` warns against — 2K on stream1 saturates the camera Wi-Fi uplink and corrupts h264. Now recommends the C113 (matching the landing page) and explains the stream2-vs-stream1 tradeoff. Manual links repointed from the legacy `manual.html` to `manual/`. Nothing on the site steers a new user at the desktop app anymore.
       - Still inconsistent, untouched: `docs/tapo-setup.html` is written entirely around the **C120**, while the landing page, the requirements card and now this guide all recommend the **C113**. Someone following the recommendation lands on a guide for a different model. Either retitle it as a generic Tapo C1xx guide or add the C113 specifics.
- Weekly digest is not operational. The signup form on the landing page collects addresses and the weekly-digest edge function exists, but no digest actually goes out. Trace it end to end: is the function on a Supabase cron schedule, is the Resend API key present and the sender domain verified, and does the function read the right subscriber table? Then send a test digest to a real inbox before announcing it. The landing page currently promises "Sent every Sunday morning" — either make that true or soften the copy until it is.
- Add the ability for bird feeders to provide GPS location in addition to zip code. This will allow for more precise detection location mapping.
- Add the concept of linking bird feeders to users of the website. Email may be the common link.
- Once bird feeders are linked to users, add the concept of time based cloud storage. The feeder site would always preserve detections, but photos and videos only for 14 days unless the user has paid for a subscription. (The landing page now publishes 14 days as the free Basic tier — this line said 30, so the retention window needs to be settled and kept consistent in both places.)

WEBSITE ENHANCEMENTS

Community Engagement
- ~~Add optional user accounts (lightweight, magic link via Supabase Auth) to enable persistent likes across devices, profiles, and real leaderboards.~~ DONE
- ~~Add public per-user life lists with shareable links so birders have a personal species "collection" to chase.~~ DONE
- ~~Add "Follow a Feeder" feature — subscribe to a specific feeder and get notified when it catches something rare.~~ DONE
- ~~Add comments/threads on detections so users can discuss IDs (e.g. "I think that's a female Purple Finch, not House Finch").~~ DONE
- ~~Add community flagging/reporting for mis-IDs or inappropriate content, feeding a moderation queue instead of post-hoc cleanup.~~ DONE
     - NOTE: Run supabase/setup-community-engagement.sql in Supabase Dashboard to activate these features.

Discovery & Content
- ~~Add full-text search covering species, feeder name, and notes (currently filter-only).~~ DONE
- Add dedicated species pages aggregating all detections, best photos, seasonality chart, and Xeno-canto audio. Good for SEO.
- Add rare bird email/SMS alert subscription for users — notify when rare sightings occur within a zip code radius.
- ~~Add "On This Day Last Year" nostalgia card on the landing page, leveraging existing calendar heatmap data.~~ DONE

Landing Page Conversion
- ~~The pricing configurator is buried at the bottom of the pricing section, and a question about one of its dropdowns means scrolling up to hunt for the write-up.~~ DONE (2026-08-17) — a "Build Yours" nav entry and a hero button both jump straight to `#build`; a "Build Yours Today" band sits between the screenshots and the testimonials; the pricing section header carries a "Build & price yours" button. Each configurator label is now a link to that piece's write-up (`#opt-software`, `#opt-feeder`, `#opt-camera`, `#computers`, `#opt-storage`, `#opt-macro`) with a "↓ Back to the builder" link closing every group. Two side effects worth knowing: the nav gained a seventh item, so it now switches to the hamburger at 1024px rather than 768px and tightens its spacing below 1200px; and `scroll-padding-top` went 80px → 110px because anchored headings were landing under the live ticker.
- ~~Enable the live detection ticker (currently hidden) with real detections for social proof.~~ DONE
- ~~Add a testimonials / user quotes section.~~ DONE, then REVERTED 2026-08-22. The section shipped with three invented customers ("Sarah M.", "Mike R.", "Linda K.", five stars each) on a product with no customers, which is an FTC endorsement problem and a credibility leak besides. Markup and CSS both removed. Only bring this back with attributable quotes from real users who consented; until then use this feeder's own numbers as the social proof.
- ~~Promote the feeder hotspot map higher on the page (above the fold) to hook visitors.~~ DONE
- ~~Make the "Sign up for weekly digest" more prominent inline — the weekly-digest edge function already exists.~~ DONE
- ~~Add an interactive demo — embed a sandbox community feed on the landing page so visitors can try it without downloading.~~ DONE
- ~~Replace the WinForms screenshots with captures of the server dashboard.~~ DONE — hero is now the Gallery page (screenshot-server-gallery.jpg), and the two wide "See It in Action" tiles are Detection history and Statistics (screenshot-server-history.jpg, screenshot-server-stats.jpg), all captured from the live server at 1440x900. The burned-overlay bird photos (screenshot-titmouse.jpg, thumb-wren.jpg, thumb-action.jpg) are engine output and stay valid as-is.
     - Four images are now unreferenced and can be deleted: screenshot-app-full.jpg, screenshot-test-image.jpg, Screenshot-statistics.png, screenshot-debug-log.png. Left in place for now in case you want to compare.
     - The Identify page was the obvious stand-in for the old Test Image dialog, but it renders as an empty file-picker until a photo is uploaded, so History was used instead. Worth revisiting once Identify has a result state worth showing.

Mobile & Accessibility
- ~~Complete PWA support (sw.js and manifest.json already exist in docs/) so users can install to their phone home screen.~~ DONE
- ~~Redesign the stats dashboard for mobile — 11 tabs is a lot on a phone screen.~~ DONE
- ~~Audit dark mode persistence across pages.~~ DONE
- ~~Improve accessibility — add ARIA labels to stats tabs, filter bar, and other interactive elements; expand keyboard navigation.~~ DONE

Monetization & Product
- ~~Add Gumroad embed for "Full Nest" kit with direct "Buy Nest Kit" CTA and pricing on the landing page.~~ DONE
- Add a referral program — existing users get a discount for referring someone who buys.
- ~~Add affiliate links to recommended cameras (TAPO C120, etc.).~~ DONE
- Add a subscription tier for extended cloud storage of photos/videos beyond the free Basic retention window (14 days as published on the landing page).
- **Sell communities — users buy an unlock code, create their own community, and pick its admins.** Requested 2026-08-23. Tiers by feeder count: **1–5 feeders $20**, **6–25 $50**, **26–100 $150** (see the boundary note below — the numbers as first written overlapped at 5 and 25). A Gumroad product per tier delivers a one-per-purchase unlock code; redeeming it lets that user create one community at that tier and become its owner. Public or private is the buyer's choice.

     **Most of the substrate is already built** — this is much less work than it sounds, and the parts that exist should not be rebuilt:
     - `communities.visibility` is already `public | private` with a check constraint, and private already suppresses precise feeder coordinates by default (`suppress_location`).
     - `community_members.role` is already `owner | moderator | viewer`, so "choose your admins" is largely a UI job over an existing column.
     - `community_invites` already invites by **email** with a role, a token and a 30-day expiry, and materializes membership on first sign-in — so an owner can already staff a community with people who have no account yet.
     - `community_feeders` already has the `pending | approved | rejected` join flow, initiated feeder-side because `device_key` is the only proof of feeder ownership.
     - RLS already hides private communities' feeders and detections from everyone outside them (`community_user_sees_feeder`).

     **What's actually new:**
     - **A tier and a feeder cap on `communities`** (`tier`, `feeder_limit`), enforced where a join is *approved* rather than where it's requested — otherwise a full community silently swallows requests. Decide what a cap breach does to feeders already approved: grandfather them, or block new joins only.
     - **An unlock-code table and a redeem RPC.** Codes minted by a Gumroad webhook, single-use, bound to a tier, and marked redeemed atomically so one code can't create two communities. This is the same shape as the licence webhook — reuse `gumroad-license-webhook` as the template, including the `GUMROAD_REQUIRE_CALLBACK` lock-down item from that punch list, so a spoofed ping can't mint free communities.
     - **A self-serve create flow.** `community_create` exists but is deliberately reachable only through a moderator-credentialed admin wrapper (its `execute` is revoked from `public`, `anon` and `authenticated` — see the PUBLIC-grant trap in CLAUDE.md). A user-facing path needs a *new* RPC that takes a code, validates it, and creates the community in one transaction. **Do not loosen the grants on the existing function** — that's exactly the hole that was open from 2026-04-06 to 2026-08-21.
     - **Slug collision handling on a user-facing form.** `communities.slug` is unique and today only a moderator picks one; a public form needs to handle "taken" gracefully and reject reserved words.

     **Open questions, worth settling before any code:**
     - **One-time or recurring?** This is the big one. "Unlock code" implies one-time, but a community is an ongoing hosting cost — 100 feeders publishing images and clips indefinitely for a single $150 is a bet on storage prices. Stream 2 (tiered storage) is a subscription, and these two interact: does a community's tier cover its feeders' storage, or does each feeder still carry its own? Decide together, not separately.
     - **Does the community fee stack on top of per-install licences?** A school with 100 feeders already owes 100 × $75. If the $150 is *instead of* that, this undercuts Stream 1; if it's *in addition*, say so plainly on the storefront, because "buy a community" reads like it includes the software.
     - **Tier boundaries overlap as written** (1–5 / 5–25 / 25–100). Clean bands are 1–5 / 6–25 / 26–100. Worth noting the implied per-feeder price is $4 → $2 → $1.50, which is a sensible volume curve.
     - **Upgrade path.** Buying the $50 tier after the $20 one: a second code that raises the existing community's tier, or a fresh community? Raising in place is friendlier and avoids orphaning feeders.
     - **Refund and chargeback.** A Gumroad refund should suspend the community rather than delete it — the member feeders' detections are other people's data.

Technical
- ~~Document and promote the embeddable widget (widget.html exists but isn't documented). A copy-paste iframe for "Latest birds from my feeder."~~ DONE
- Add a public read-only API for detections to enable community integrations (eBird-style).
- ~~Refactor community.html (6000+ lines) — split JS/CSS into modules for maintainability.~~ DONE (CSS extracted to docs/css/community.css, JS split into docs/js/community-core.js, community-views.js, community-social.js, community-auth.js. HTML reduced from 7400+ to ~540 lines.)

COMPETITIVE TEARDOWN — BIRD BUDDY (report dated 2026-08-21, triaged 2026-08-22)

Site-facing items from a Bird Buddy / Birdfy comparison. The report was written from the public site and the manual rather than from the server codebase, so most of its *product* recommendations were already stale — those were triaged separately into `docs/ROADMAP.md` in the private server repo, including the finding it ranked first ("serve a web UI on the device"), which has been shipped for months. What follows is what survived for the website, plus the recommendations that were **declined**, recorded so they don't get re-proposed.

Credibility — all four verified against the live files on 2026-08-22
- ~~**The testimonials are fabricated personas and they are live.**~~ FIXED 2026-08-22 by removal. Was `index.html` lines 362-392: "Sarah M.", "Mike R." and "Linda K.", five stars each, on a product that had not launched. Section markup and the `.testimonial-*` CSS are both gone, each replaced by a comment recording why. **Still open, and the better half of the fix:** put this feeder's own data in its place — real detection counts, real screenshots, real dates, attributed to Joe. "412 detections across 31 species at my feeder since March" is more persuasive than a stranger's praise anyway. The page currently has no dedicated social-proof block at all; the live ticker and the community feed embed are carrying it alone.
- **Two download buttons go nowhere.** `index.html:926` (Download Screensaver) and `index.html:940` (Download Finder) are both `href="#"`. The screensaver is one of the genuinely charming differentiators and it currently does nothing when clicked.
- **The software price is never printed as a number.** It exists — $75 alone / $50 bundled, in `js/main.js:163-164` and live on Gumroad — but the Software option card at `index.html:532` lists six feature bullets and no price, so a visitor has to drive the configurator to discover what the licence costs. Put the number on the card. Anchor it against the competitor while you are there: $75 once versus $69.99 every year is a comparison that wins on the first read and needs no explaining.
- **Reframe "965+ species".** Bird Buddy claims 13,000; a visitor comparing tabs reads 965 as one-thirteenth the product, when roughly a thousand covers essentially everything recorded in the ABA area. Lead with "every bird you're realistically going to see in North America", mention the 2,498-species SpeciesNet option second, and stop leading with a number the comparison loses.

Community & content
- Seed the community feed before promoting anything. A first-time visitor landing on an empty feed concludes the product is dead. Several of Joe's own feeders across different regions, running continuously for a month. This is mostly a hardware and patience problem rather than an engineering one, which is exactly why it has to start early — it costs a month of wall-clock time no matter how fast anything else ships.
- Fuzz feeder locations by default. **This conflicts with an existing line above** ("Add the ability for bird feeders to provide GPS location in addition to zip code ... more precise detection location mapping") — same knob, opposite directions. A map pin on a backyard feeder is a home address; the report wants coordinates coarsened to a few-kilometre grid cell unless the user deliberately opts into precision. Both can be true (store precise, display coarse) but the default needs deciding before launch rather than after an incident, and "we blur your location by default" is a trust asset for a privacy-first product, not just a safeguard.
- Write the content license down. The site hosts user photographs and redistributes them through the widget, the screensaver and the digest. Spell out who owns what, how attribution works, and what we are allowed to do with a shared photo. Photographers ask, and a clear answer costs nothing now and a lot later.
- Publish the Weekly Digest as public web pages, not only as email. Every issue archived as an indexable page becomes a growing library of seasonal content and something to link when posting in birding forums. **Blocked on the digest actually sending** — see the "Weekly digest is not operational" item above.
- Seasonal events on top of the leaderboard — a spring migration challenge, a "big sit" weekend, county-level standings. The leaderboard already exists; time-boxed events give people a reason to come back and a reason to tell someone else, and each event is a natural moment for an email and a social post.
- Give away a printable feeder built for the C113. A free STL on Printables and MakerWorld, designed around the C113's actual focal distance, with a cable channel and a rain shroud. This audience owns 3D printers — the same person who will run a Pi in a closet. A well-photographed free model with a link in the description is the best top-of-funnel a weekend of CAD can buy, and it lands in a community Bird Buddy structurally cannot reach.
- Pitch the embeddable widget actively — nature bloggers and local Audubon chapters — with a discreet "powered by BirdWatchAI" link and a gallery of sites using it. A one-line embed is a live demo and a backlink at the same time. The widget and its documentation are done; only the outreach is missing.
- Lines the report independently arrived at that are already written above, no new action: dedicated species pages for SEO, rare-bird alerts within a zip radius, and the public read-only API (the report frames that last one as eBird export, which is the sharper version of the same idea).

Declined — recorded so they don't come back
Four pricing and catalogue recommendations, all declined. They are reasonable general advice that the report costed at zero because it could not see the storefront work already done. Revisit only if the pricing model is deliberately reopened.
- **$39 launch / $59 standard licence.** Pricing is already set at $75 alone / $50 bundled, live on Gumroad and minting real keys since 2026-08-17. The report did not know a price existed at all (see the credibility item above) and reverse-engineered one from Bird Buddy's $69.99/yr. The "one-time versus $69.99 every year" framing is worth stealing; the numbers are not.
- **A free single-camera forever tier.** Contradicts the shipped model — a 30-day fully-featured trial, then a one-time key. Introducing a permanent free tier now would undercut a storefront that is already selling.
- **Shipping: free over $75, flat $6.95 below.** The attach-rate argument is fair on its face — $25 flat does mean a $20 indoor feeder costs $45, and nobody adds an accessory at that number. But the current rule ($25, waived at $100) is baked into the eleven shipping-inclusive Gumroad products that were just created and verified, against a ten-products-per-day creation limit. Moving the threshold means rebuilding all eleven. Not worth it now.
- **Collapse the hardware line to three SKUs** ($39-59 software / $99 camera kit / $179 complete). 22 permalinks exist, every one resolving at the expected name and price, with 119 of 119 real builder combinations verified end to end. Same objection as above, larger. The underlying observation is real and worth answering in copy rather than by rebuilding the catalogue: The Wren at $220 sits above a fully integrated, solar-powered Birdbuddy 2 at $199 and nearly double a complete Birdfy at $109.99, and a shopper comparing shelf prices does not yet understand why ours costs more.
