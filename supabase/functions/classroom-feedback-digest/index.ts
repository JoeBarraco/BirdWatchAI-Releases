// Mail whatever teachers have flagged since the last digest.
//
// WHY THIS IS A CRON JOB AND NOT A REMINDER
// Teachers flag questions in the middle of a lesson. Finding out used to
// mean going and looking — the review panel, or a scheduled task on a laptop
// that had to be switched on, with the app open, holding a live browser
// session. Every one of those is a way of saying "someone remembers to
// check". Four teachers are about to start using this, and a flag nobody
// reads for a week is the same as no flag at all.
//
// WHAT COUNTS AS NEW
// notified_at on classroom_question_feedback — set here, once, when a row is
// mailed. The obvious alternative filter, "still unresolved", re-sends every
// open item every morning until it is dealt with, which trains the reader to
// ignore the mail. Being told about a flag and dealing with it are different
// events, so they are different columns.
//
// NOTHING NEW MEANS NO EMAIL. A quiet day should be silent, not an empty
// message. The trade-off is that silence cannot be distinguished from a
// broken job; the cron run is visible in the dashboard if that is ever in
// doubt.
//
// AUTHORISATION
// Called by pg_cron with the service-role key. The bearer is compared to
// that key exactly: without the check any signed-in user's JWT would pass
// the gateway's verify_jwt and could trigger digest mail at will.
//
// RECIPIENT
// FEEDBACK_DIGEST_TO, a secret. THIS REPO IS PUBLIC — a personal address
// written here is a personal address published, and the deploy notes already
// carry a scar about a committed key.
//
// DEPLOY
//   npx supabase@latest functions deploy classroom-feedback-digest \
//       --project-ref lsamggztfizmkyljdgwq
// Then run supabase/setup-classroom-feedback-digest.sql for the column and
// the schedule.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TO_EMAIL      = Deno.env.get('FEEDBACK_DIGEST_TO') ?? '';
const FROM_EMAIL    = Deno.env.get('INVITE_FROM_EMAIL') ?? 'BirdWatchAI <noreply@birdwatchai.com>';
const COMMUNITY_URL = Deno.env.get('COMMUNITY_URL') ?? 'https://www.birdwatchai.com/docs/community.html';

// A cap, so one bad afternoon cannot produce a thousand-row email. Anything
// beyond this is still marked notified — the point is to stop mail growing
// without bound, not to re-send the overflow tomorrow.
const MAX_ROWS = 60;

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function esc(s: unknown) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function when(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

type Row = {
  id: string; community_id: string; classroom_id: string | null;
  template_id: string; grade_band: string; prompt: string | null;
  kind: string | null; reason: string | null; comment: string | null;
  created_at: string;
};

function card(r: Row, communityName: string, classroomName: string) {
  // The comment is the thing worth reading, so it leads. The question it is
  // about is context and sits under it, quieter.
  const where = [communityName, classroomName].filter(Boolean).join(' · ');
  const tag = [r.kind, r.reason].filter(Boolean).join('/') || 'feedback';
  return `
  <div style="border:1px solid #e8e4de;border-radius:8px;padding:0.9rem 1rem;margin:0 0 0.8rem;">
    <p style="margin:0 0 0.5rem;font-size:0.78rem;color:#7a756d;">
      ${esc(where)} &middot; ${esc(r.grade_band)} &middot; <code>${esc(r.template_id)}</code>
      &middot; ${esc(tag)} &middot; ${esc(when(r.created_at))}
    </p>
    <p style="margin:0 0 0.6rem;font-size:1rem;color:#1a1a1a;">
      ${r.comment ? esc(r.comment) : '<em style="color:#7a756d;">(no comment left)</em>'}
    </p>
    ${r.prompt ? `<p style="margin:0;font-size:0.82rem;color:#4a4640;border-left:3px solid #e8e4de;padding-left:0.7rem;">
      ${esc(String(r.prompt).replace(/\n/g, ' / '))}</p>` : ''}
  </div>`;
}

Deno.serve(async (req) => {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

  // Service role only. verify_jwt alone would let any signed-in user set
  // this off, and the result lands in somebody's inbox.
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${SUPABASE_SERVICE_ROLE}`) return json({ error: 'Forbidden' }, 403);

  if (!TO_EMAIL) return json({ error: 'FEEDBACK_DIGEST_TO is not set' }, 500);

  try {
    const { data: rows, error } = await db
      .from('classroom_question_feedback')
      .select('id, community_id, classroom_id, template_id, grade_band, prompt, kind, reason, comment, created_at')
      .is('notified_at', null)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS);

    if (error) return json({ error: error.message }, 500);
    // Silence on a quiet day. Reported in the response so a manual run can
    // tell "nothing to send" from "something went wrong".
    if (!rows || rows.length === 0) return json({ ok: true, new_items: 0, email_sent: false });

    // Names, so the email reads like a place and a class rather than a pair
    // of UUIDs. One query each rather than a join, because PostgREST embeds
    // would need FK metadata this table does not advertise.
    const commIds = [...new Set(rows.map(r => r.community_id).filter(Boolean))];
    const roomIds = [...new Set(rows.map(r => r.classroom_id).filter(Boolean))] as string[];

    const { data: comms } = commIds.length
      ? await db.from('communities').select('id, name').in('id', commIds) : { data: [] };
    const { data: rooms } = roomIds.length
      ? await db.from('classrooms').select('id, name').in('id', roomIds) : { data: [] };

    const commName = new Map((comms ?? []).map((c: any) => [c.id, c.name]));
    const roomName = new Map((rooms ?? []).map((c: any) => [c.id, c.name]));

    const n = rows.length;
    const subject = `${n} new classroom ${n === 1 ? 'note' : 'notes'} on BirdWatchAI`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:620px;margin:0 auto;padding:1.6rem;color:#1a1a1a;">
  <h2 style="margin:0 0 0.3rem;font-size:1.15rem;">
    ${n} new ${n === 1 ? 'note' : 'notes'} from the classroom</h2>
  <p style="margin:0 0 1.2rem;font-size:0.85rem;color:#7a756d;">
    Flagged by teachers since the last digest. Each one is shown once.</p>
  ${rows.map(r => card(r as Row, commName.get(r.community_id) ?? '', roomName.get(r.classroom_id ?? '') ?? '')).join('')}
  <div style="text-align:center;margin:1.4rem 0 0.6rem;">
    <a href="${COMMUNITY_URL}" style="display:inline-block;background:#2eaa4f;color:white;text-decoration:none;padding:9px 22px;border-radius:6px;font-weight:600;font-size:0.9rem;">Open the review panel</a>
  </div>
  <p style="font-size:0.72rem;color:#9ca3af;text-align:center;margin-top:1rem;">
    Daily at 7am Eastern. Nothing new means no email.</p>
</body></html>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: TO_EMAIL, subject, html }),
    });

    if (!res.ok) {
      // Do NOT mark notified: these rows have not been delivered, and
      // tomorrow's run should carry them rather than losing them silently.
      const text = await res.text();
      console.error('Resend error:', text);
      return json({ error: 'send failed', detail: text.slice(0, 300), new_items: n }, 502);
    }

    const { error: markErr } = await db
      .from('classroom_question_feedback')
      .update({ notified_at: new Date().toISOString() })
      .in('id', rows.map(r => r.id));
    // The mail is gone either way. A failure here means tomorrow repeats
    // these, which is a far better outcome than losing them, so it is
    // reported rather than treated as a failure of the run.
    if (markErr) console.error('could not mark notified:', markErr.message);

    return json({ ok: true, new_items: n, email_sent: true, marked: !markErr });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
