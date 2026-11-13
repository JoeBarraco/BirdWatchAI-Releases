// Tell a school its Classroom subscription is running out, before it does.
//
// WHY THIS EXISTS
// An annual term bought in November falls due in November, and that warning
// lands in a school inbox during a week nobody is reading mail. The 30-day
// grace window was built for exactly that — but grace is a safety net, not a
// notification. A school that burns its grace without ever being told has
// still been surprised, only later and with less time to do anything.
//
// FOUR STAGES, ONE EMAIL EACH
//   t30      30 days left     this is coming
//   t7        7 days left     this is next week
//   expired   term ended      lessons still run until <date>
//   stopped   grace ended     lessons have stopped; nothing was deleted
//
// Postgres decides which stage a term is in and excludes anything already
// mailed, so this function does not do date arithmetic at all. That is
// deliberate: community_school_state already owns "what does this date mean",
// and a second implementation here would drift from it — the version that
// decides whether to START a lesson and the version that decides whether to
// WARN about one must never disagree.
//
// ONLY THE CURRENT STAGE IS SENT. Stages are monotonic in time, so a school
// already in grace on the first run gets the 'expired' mail rather than a
// backlog of the three it missed. The first run is precisely the one most
// likely to find a term already past its date.
//
// MARK AFTER SENDING, NOT BEFORE
// A crash between the two re-sends tomorrow. That is the right way round: a
// duplicate reminder is an annoyance, a silently skipped one is the entire
// failure this is here to prevent. school_reminder_mark is insert-on-conflict
// -do-nothing and reports whether it won, so two overlapping runs cannot both
// mail the same school.
//
// NOTHING DUE MEANS NO MAIL AT ALL. Most days nothing is due.
//
// AUTHORISATION
// Called by pg_cron with the service-role key. It reads the `role` claim out
// of the bearer rather than string-comparing to SUPABASE_SERVICE_ROLE_KEY:
// this project has migrated to the publishable/secret key system, so the
// injected variable is no longer the same string as the legacy service_role
// JWT that pg_cron sends. Comparing claims works either way and survives the
// 2027 legacy retirement.
//
// ⚠ This leans on "Verify JWT" being ON, which is what checks the SIGNATURE.
// The claim is only trustworthy because the gateway has already proved the
// token is genuine.
//
// RECIPIENTS
// Each school's OWNER, because applying a renewal code is owner-only — a
// teacher who gets this mail can do nothing with it. SCHOOL_REMINDER_ADMIN,
// if set, also gets a one-line roll-up, which is what turns "their term ends
// in 30 days" into an invoice going out.
//
// THIS REPO IS PUBLIC. No address is written here; both come from secrets.
//
// DEPLOY
//   npx supabase@latest functions deploy school-term-reminders \
//       --project-ref lsamggztfizmkyljdgwq
// Then run supabase/setup-school-reminders.sql for the table and the
// schedule.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL    = Deno.env.get('INVITE_FROM_EMAIL') ?? 'BirdWatchAI <noreply@birdwatchai.com>';
const COMMUNITY_URL = Deno.env.get('COMMUNITY_URL') ?? 'https://www.birdwatchai.com/docs/community.html';
const ADMIN_EMAIL   = Deno.env.get('SCHOOL_REMINDER_ADMIN') ?? '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

type Stage = 't30' | 't7' | 'expired' | 'stopped';

interface DueTerm {
  community_id: string;
  slug: string;
  name: string;
  expires_at: string;
  grace_ends_at: string;
  stage: Stage;
  days_left: number;
  owner_email: string | null;
  owner_name: string;
  classroom_count: number;
}

/**
 * The role claim out of a bearer token.
 *
 * Returns null for anything that is not a three-part JWT — including the new
 * sb_secret_… keys, which are not JWTs at all.
 */
function bearerRole(auth: string): string | null {
  const token = auth.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(payload).role ?? null;
  } catch {
    return null;
  }
}

/** 8 November 2026 — a date a human can act on, not an ISO timestamp. */
function onDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Subject and body for one stage.
 *
 * Every one of them says what has NOT happened, because that is the fear:
 * a school reading "your subscription has ended" assumes it has lost the
 * term's work. It hasn't, ever, and the mail should say so before the reader
 * has time to wonder.
 */
function compose(t: DueTerm): { subject: string; text: string } {
  const greeting = t.owner_name ? `${t.owner_name},\n\n` : '';
  const classes  = t.classroom_count
    ? `${t.name} has ${plural(t.classroom_count, 'class', 'classes')} set up.`
    : `${t.name} has no classes set up yet.`;

  const howToRenew =
`To renew, open ${COMMUNITY_URL}, choose ${t.name} under Communities, and paste
your renewal code into the box under "This community is a school".

Renewing early costs you nothing: the new months are added to whatever is left
of the current term rather than starting it over.

If you need a code or an invoice, reply to this message.`;

  switch (t.stage) {
    case 't30':
      return {
        subject: `Classroom renews in ${plural(t.days_left, 'day', 'days')} — ${t.name}`,
        text: `${greeting}The Classroom subscription for ${t.name} ends on ${onDate(t.expires_at)}, in ${plural(t.days_left, 'day', 'days')}.

${classes} Nothing changes before then, and nothing will be deleted afterwards.

${howToRenew}

-- Bird Brain Solutions LLC
`,
      };

    case 't7':
      return {
        subject: `Classroom renews next week — ${t.name}`,
        text: `${greeting}The Classroom subscription for ${t.name} ends on ${onDate(t.expires_at)}, in ${plural(t.days_left, 'day', 'days')}.

After that date lessons keep working for a further 30 days, until
${onDate(t.grace_ends_at)}, so a renewal that arrives late is not a lost week of
teaching. Results and history are never deleted.

${howToRenew}

-- Bird Brain Solutions LLC
`,
      };

    case 'expired':
      return {
        subject: `Classroom has ended — lessons still run until ${onDate(t.grace_ends_at)}`,
        text: `${greeting}The Classroom subscription for ${t.name} ended on ${onDate(t.expires_at)}.

Lessons still work. Teachers can start sessions as normal until
${onDate(t.grace_ends_at)}, which is there precisely so a renewal landing in a
school holiday does not stop a class.

After that date, starting new lessons and creating new classes will pause.
Results, session history and everything already recorded stay exactly where
they are — nothing is deleted at any point.

${howToRenew}

-- Bird Brain Solutions LLC
`,
      };

    case 'stopped':
      return {
        subject: `Classroom lessons are paused — ${t.name}`,
        text: `${greeting}The Classroom subscription for ${t.name} ended on ${onDate(t.expires_at)},
and the 30-day grace period finished on ${onDate(t.grace_ends_at)}.

Starting new lessons and creating new classes is now paused.

Nothing has been deleted. Every result, every session and every class is still
there, teachers still have their accounts and their roles, and all of it starts
working again the moment a renewal code is applied — there is nothing to set up
again.

${howToRenew}

-- Bird Brain Solutions LLC
`,
      };
  }
}

async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, text }),
  });
  if (!res.ok) {
    console.error('Resend delivery failed:', res.status, await res.text());
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (bearerRole(req.headers.get('Authorization') ?? '') !== 'service_role') {
    return new Response('Forbidden', { status: 403 });
  }
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set; refusing to run');
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });
  }

  const { data, error } = await supabase.rpc('school_terms_due_reminders');
  if (error) {
    console.error('due-reminders query failed:', error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const due = (data ?? []) as DueTerm[];
  if (!due.length) {
    return new Response(JSON.stringify({ ok: true, due: 0 }), { status: 200 });
  }

  const sent: string[] = [];
  const skipped: string[] = [];

  for (const t of due) {
    if (!t.owner_email) {
      // A school whose owner has no address on file cannot be reminded, and
      // nobody finds out unless this is loud. Not marked as sent, so it
      // reappears tomorrow rather than being silently dropped forever.
      console.error(`${t.slug}: no owner email; cannot send ${t.stage} reminder`);
      skipped.push(`${t.slug} (no owner email)`);
      continue;
    }

    const { subject, text } = compose(t);
    const ok = await sendMail(t.owner_email, subject, text);
    if (!ok) { skipped.push(`${t.slug} (send failed)`); continue; }

    // Only after Resend has taken it. Losing the mark re-sends tomorrow;
    // writing it early loses the reminder altogether.
    const { data: won, error: markErr } = await supabase.rpc('school_reminder_mark', {
      p_community_id:    t.community_id,
      p_stage:           t.stage,
      p_term_expires_at: t.expires_at,
      p_sent_to:         t.owner_email,
    });
    if (markErr) console.error(`${t.slug}: mark failed: ${markErr.message}`);
    if (won === false) console.warn(`${t.slug}: another run had already marked ${t.stage}`);

    sent.push(`${t.slug} (${t.stage})`);
  }

  // The roll-up is what turns "their term ends in 30 days" into an invoice
  // going out. Only when something actually happened.
  if (ADMIN_EMAIL && (sent.length || skipped.length)) {
    const lines = due.map(t =>
      `  ${t.name} [${t.slug}] — ${t.stage}, ends ${onDate(t.expires_at)}`
      + `, ${plural(t.classroom_count, 'class', 'classes')}`
      + `, owner ${t.owner_email ?? 'UNKNOWN'}`);
    await sendMail(ADMIN_EMAIL,
      `School renewals: ${sent.length} reminder(s) sent`,
      `Reminders sent today:\n\n${lines.join('\n')}\n`
      + (skipped.length ? `\nNot sent:\n  ${skipped.join('\n  ')}\n` : ''));
  }

  return new Response(
    JSON.stringify({ ok: true, due: due.length, sent: sent.length, skipped }),
    { status: 200 });
});
