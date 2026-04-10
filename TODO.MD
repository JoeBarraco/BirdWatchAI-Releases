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
- Favorited detection uploads should translate to "Liked" by the uploaded
- Need to provide some photos of the bird feeder (both types) so we can price "The full nest" option. I am thinking the Full Nest should be $150 and the software half that ($75).
     - Need to update pricing on "Gumroad" first, as well as add Full nest to gumroad.
- Add the ability for bird feeders to provide GPS location in addition to zip code. This will allow for more precise detection location mapping.
- Add the concept of linking bird feeders to users of the website. Email may be the common link.
- Once bird feeders are linked to users, add the concept of time based cloud storage. The feeder site would always preserve detections, but photos and videos only for 30 days unless the user has paid for a subscription.

WEBSITE ENHANCEMENTS

Community Engagement
- Add optional user accounts (lightweight, magic link via Supabase Auth) to enable persistent likes across devices, profiles, and real leaderboards.
- Add public per-user life lists with shareable links so birders have a personal species "collection" to chase.
- Add "Follow a Feeder" feature — subscribe to a specific feeder and get notified when it catches something rare.
- Add comments/threads on detections so users can discuss IDs (e.g. "I think that's a female Purple Finch, not House Finch").
- Add community flagging/reporting for mis-IDs or inappropriate content, feeding a moderation queue instead of post-hoc cleanup.

Discovery & Content
- Add full-text search covering species, feeder name, and notes (currently filter-only).
- Add dedicated species pages aggregating all detections, best photos, seasonality chart, and Xeno-canto audio. Good for SEO.
- Add rare bird email/SMS alert subscription for users — notify when rare sightings occur within a zip code radius.
- Add "On This Day Last Year" nostalgia card on the landing page, leveraging existing calendar heatmap data.

Landing Page Conversion
- Enable the live detection ticker (currently hidden) with real detections for social proof.
- Add a testimonials / user quotes section.
- Promote the feeder hotspot map higher on the page (above the fold) to hook visitors.
- Make the "Sign up for weekly digest" more prominent inline — the weekly-digest edge function already exists.
- Add an interactive demo — embed a sandbox community feed on the landing page so visitors can try it without downloading.

Mobile & Accessibility
- Complete PWA support (sw.js and manifest.json already exist in docs/) so users can install to their phone home screen.
- Redesign the stats dashboard for mobile — 11 tabs is a lot on a phone screen.
- Audit dark mode persistence across pages.
- Improve accessibility — add ARIA labels to stats tabs, filter bar, and other interactive elements; expand keyboard navigation.

Monetization & Product
- Add Gumroad embed for "Full Nest" kit with direct "Buy Nest Kit" CTA and pricing on the landing page.
- Add a referral program — existing users get a discount for referring someone who buys.
- Add affiliate links to recommended cameras (TAPO C120, etc.).
- Add a subscription tier for extended cloud storage of photos/videos beyond 30 days.

Technical
- Document and promote the embeddable widget (widget.html exists but isn't documented). A copy-paste iframe for "Latest birds from my feeder."
- Add a public read-only API for detections to enable community integrations (eBird-style).
- Refactor community.html (6000+ lines) — split JS/CSS into modules for maintainability.
