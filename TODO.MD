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
- **When you change `css/style.css` or `js/main.js`, bump the `?v=` on both tags in index.html.** GitHub Pages serves assets with a 10-minute max-age, so a browser can load new HTML against the previous JS. That mismatch is silent and looks like a feature is simply broken — it is what made the pricing configurator's total stop updating. The current stamp is `20260816b`; any new value works, a date plus a letter is fine.
- **Gumroad: selling configured builds.** Prices are now in sync — checked live: `l/dajhd` $75, `l/dzjxfn` $110, `l/irvwmy` $130, all matching the builder. Still outstanding:
     - **Names.** The kits were renamed from "The Full Nest — Indoor/Outdoor" to "The Nest — Indoor/Outdoor"; "The Full Nest" now means the kit plus a preloaded computer. The Gumroad listings still use the old names. Product URLs are unchanged, so this is a rename in Gumroad only — no link edits needed here.
     - **Every component is wired and every combination is purchasable at the right price.** All nine components exist in Gumroad and are in `COMPONENTS` in `js/main.js`; four bundles are in `BUNDLES`. Verified against Gumroad that all thirteen permalinks resolve with the correct name and price.
     - **The remaining six bundles are optional, not blocking.** Indoor Finch $275 / Cardinal $325 and all four Outdoor builds already check out at exactly the right total as *The Nest* bundle plus the computer component — two cart adds instead of one click. Creating them buys a nicer checkout, nothing more, so the 10-a-day product limit is not in the way. When they exist, add a row to `BUNDLES` with its `contains` list and the builder picks it up automatically:

       | Bundle | Price | `contains` |
       |---|---|---|
       | Full Nest Indoor — The Finch | $275 | software, feederIndoor, camera, computerStdExt |
       | Full Nest Indoor — The Cardinal | $325 | software, feederIndoor, camera, computerHighExt |
       | Full Nest Outdoor — The Wren | $240 | software, feederOutdoor, camera, computerStdStd |
       | Full Nest Outdoor — The Jay | $290 | software, feederOutdoor, camera, computerHighStd |
       | Full Nest Outdoor — The Finch | $295 | software, feederOutdoor, camera, computerStdExt |
       | Full Nest Outdoor — The Cardinal | $345 | software, feederOutdoor, camera, computerHighExt |

     - **The software discount now lives in bundle prices, not in a discounted licence.** Every bundle is exactly $25 under the sum of its parts, which is the old $50-vs-$75 licence gap expressed as a bundle saving. No cheap licence product exists to be found in the page source. The consequence: a combination with no matching bundle pays the full $75 — "software + camera, no feeder" is $115, not $90.
     - **What the builder can offer.** Findings from probing Gumroad directly, so nobody repeats the work:
          - The overlay widget does **not** bundle. Reading `assets.gumroad.com/js/gumroad-bundle.js`: it binds every `<a>` on the page and, on click, sets a single iframe's `src` to that one product. Each click replaces the last. The help-centre text claiming linked products bundle together is wrong for the current script.
          - Gumroad *does* have a real cart — `/checkout` exposes `max_allowed_cart_products: 50` plus `add_products` and `clear_cart`.
          - `https://gumroad.com/checkout?product=<permalink>` adds exactly one product to it. Repeating `?product=` keeps only the last; `product[]`, `products=`, comma-separated and `add_products[]` all add nothing.
          - Adds **do** accumulate — confirmed by hand in a real browser, since the cart is held client-side and a cookie-only session always reports `cart: null`. So a build becomes one link per line and a single checkout, which is what the builder now renders.
     - Nothing to list yet for the computers or complete builds — all Coming Soon.
- The "Download Free Trial" button still ships the old WinForms app, and there is no click-to-download path to the server edition at all. Today index.html's #download-btn is hardcoded to
  .../releases/download/v2.1.2.0/BirdWatchAI_Setup_2.1.2.0.exe, so a visitor sold on the server screenshots gets the desktop app instead. Installing the server is documented in the manual, but reading install docs is not a download button. Options, roughly in order of effort:
     - Publish self-contained builds as release assets on birdwatchai-server-releases (win-x64, linux-x64, linux-arm64, osx-arm64) and give the download section a small platform picker. Note this changes docs/RELEASING.md, which deliberately publishes tags + notes only, no binaries — that decision needs revisiting first.
     - Publish a prebuilt Raspberry Pi SD-card image. This is the genuinely clean "one click, flash, done" path, and it doubles as the thing the preloaded-Pi product is built from.
     - At minimum, split the download section into two cards — "Windows desktop app" and "Server edition" — so the server stops being invisible even while its install is still manual.
  While in there: #download-btn pins an exact version in the URL, so every release needs a code edit, whereas the Finder button already uses /releases/latest/download/. Worth making both use latest.
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
- ~~Enable the live detection ticker (currently hidden) with real detections for social proof.~~ DONE
- ~~Add a testimonials / user quotes section.~~ DONE
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

Technical
- ~~Document and promote the embeddable widget (widget.html exists but isn't documented). A copy-paste iframe for "Latest birds from my feeder."~~ DONE
- Add a public read-only API for detections to enable community integrations (eBird-style).
- ~~Refactor community.html (6000+ lines) — split JS/CSS into modules for maintainability.~~ DONE (CSS extracted to docs/css/community.css, JS split into docs/js/community-core.js, community-views.js, community-social.js, community-auth.js. HTML reduced from 7400+ to ~540 lines.)
