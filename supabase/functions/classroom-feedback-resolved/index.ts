// Email a teacher when a note they filed about a classroom question is
// resolved: what they said, the question as their class saw it, and what
// changed.
//
// WHY
// A flag that vanishes into silence teaches the person who filed it that
// flagging does nothing. The fix itself is invisible: a question that used
// to be wrong just quietly stops being wrong, weeks later, in some other
// lesson. This closes the loop with the one person who cares.
//
// WHAT IT SENDS, AND TO WHOM
// Rows resolved by BirdWatchAI (resolved_by null), claimed through
// classroom_feedback_claim_resolved so each row is mailed at most once even
// when several triggers overlap. One email per submitter per run: three of
// one teacher's notes fixed together are one email listing three, not three
// emails. The address comes from auth.users through the admin API and goes
// nowhere but the To line. See supabase/setup-classroom-feedback-resolved.sql
// for which resolutions mail and why a school moderator's "Mark closed"
// does not.
//
// resolved_note is written by the review task as
//   "Fixed in <hash>: <sentence>"  -> "is fixed", with the sentence
//   "Not changing: <reason>"       -> "we looked at it", with the reason
// and anything else is shown as written under a neutral heading. The commit
// hash is stripped: it means nothing to a teacher.
//
// AUTHORISATION
// Service role only, by the bearer's role claim, exactly as in
// classroom-feedback-digest (which explains why a string comparison against
// SUPABASE_SERVICE_ROLE_KEY is not enough on this project). Leans on
// "Verify JWT" being ON for the function.
//
// DEPLOY
//   npx supabase@latest functions deploy classroom-feedback-resolved \
//       --project-ref lsamggztfizmkyljdgwq
// Then run supabase/setup-classroom-feedback-resolved.sql. RESEND_API_KEY
// and INVITE_FROM_EMAIL are the same secrets the digest already uses.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL    = Deno.env.get('INVITE_FROM_EMAIL') ?? 'BirdWatchAI <noreply@birdwatchai.com>';
const COMMUNITY_URL = Deno.env.get('COMMUNITY_URL') ?? 'https://www.birdwatchai.com/docs/community.html';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function esc(s: unknown) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Same as classroom-feedback-digest; see the note there.
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

function day(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'America/New_York', month: 'long', day: 'numeric',
    });
  } catch { return iso; }
}

type Row = {
  id: string; community_id: string; classroom_id: string | null;
  template_id: string; prompt: string | null; reason: string | null;
  comment: string | null; created_by: string | null; created_at: string;
  resolved_note: string | null;
};

type Outcome = { kind: 'fixed' | 'declined' | 'other'; text: string };

function outcome(note: string | null): Outcome {
  const n = (note ?? '').trim();
  const fixed = n.match(/^fixed in [0-9a-f]{6,40}\s*[:\-–—]\s*/i);
  if (fixed) return { kind: 'fixed', text: n.slice(fixed[0].length) };
  if (/^fixed\b/i.test(n)) return { kind: 'fixed', text: n.replace(/^fixed\s*[:\-–—]?\s*/i, '') };
  const not = n.match(/^not changing\s*[:\-–—]\s*/i);
  if (not) return { kind: 'declined', text: n.slice(not[0].length) };
  return { kind: 'other', text: n };
}

function card(r: Row, room: string) {
  // The same two shapes the digest handles: a flag has the teacher's words
  // in `comment` and the question in `prompt`; a standalone idea has no
  // comment and the idea itself is the prompt.
  const isIdea = !r.comment && (r.reason === 'idea' || r.template_id === 'suggestion');
  const theirs = isIdea ? (r.prompt ?? '') : (r.comment ?? '');
  const question = isIdea ? '' : (r.prompt ?? '');
  const o = outcome(r.resolved_note);
  const head = o.kind === 'fixed' ? 'Fixed' : o.kind === 'declined' ? 'We looked at this' : 'Update';
  const colour = o.kind === 'fixed' ? '#2eaa4f' : '#7a756d';

  return `
  <div style="border:1px solid #e8e4de;border-radius:8px;padding:0.9rem 1rem;margin:0 0 0.8rem;">
    <p style="margin:0 0 0.4rem;font-size:0.78rem;color:#7a756d;">
      ${esc([room, `filed ${day(r.created_at)}`].filter(Boolean).join(' · '))}</p>
    <p style="margin:0 0 0.5rem;font-size:0.95rem;color:#1a1a1a;">
      You said: &ldquo;${esc(String(theirs).replace(/^Skipped during a lesson:\s*/i, '').replace(/\n/g, ' / '))}&rdquo;</p>
    ${question ? `<p style="margin:0 0 0.6rem;font-size:0.82rem;color:#4a4640;border-left:3px solid #e8e4de;padding-left:0.7rem;">
      ${esc(String(question).replace(/\n/g, ' / '))}</p>` : ''}
    ${o.text ? `<p style="margin:0;font-size:0.92rem;color:#1a1a1a;">
      <strong style="color:${colour};">${head}:</strong> ${esc(o.text)}</p>` : ''}
  </div>`;
}

Deno.serve(async (req) => {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

  const auth = req.headers.get('Authorization') ?? '';
  const isServiceRole = bearerRole(auth) === 'service_role'
                     || (!!SUPABASE_SERVICE_ROLE && auth === `Bearer ${SUPABASE_SERVICE_ROLE}`);
  if (!isServiceRole) return json({ error: 'Forbidden' }, 403);

  try {
    const { data: claimed, error } = await db.rpc('classroom_feedback_claim_resolved', { p_limit: 50 });
    if (error) return json({ error: error.message }, 500);
    const rows = (claimed ?? []) as Row[];
    if (!rows.length) return json({ ok: true, resolved: 0, emails: 0 });

    const roomIds = [...new Set(rows.map(r => r.classroom_id).filter(Boolean))] as string[];
    const { data: rooms } = roomIds.length
      ? await db.from('classrooms').select('id, name').in('id', roomIds) : { data: [] };
    const roomName = new Map((rooms ?? []).map((c: any) => [c.id, c.name]));

    // Group by submitter. A row with no submitter, or one whose account is
    // gone, stays claimed: there is nobody to tell, and retrying would only
    // find nobody again.
    const bySubmitter = new Map<string, Row[]>();
    for (const r of rows) {
      if (!r.created_by) continue;
      if (!bySubmitter.has(r.created_by)) bySubmitter.set(r.created_by, []);
      bySubmitter.get(r.created_by)!.push(r);
    }

    let sent = 0, skipped = 0;
    const failed: string[] = [];
    for (const [uid, mine] of bySubmitter) {
      let to = '';
      try {
        const { data: u } = await db.auth.admin.getUserById(uid);
        to = u?.user?.email ?? '';
      } catch { /* no address */ }
      if (!to) { skipped += mine.length; continue; }

      const { data: prof } = await db.from('user_profiles').select('display_name').eq('id', uid).maybeSingle();
      const first = String((prof as any)?.display_name ?? '').trim().split(/\s+/)[0] || '';

      const allFixed = mine.every(r => outcome(r.resolved_note).kind === 'fixed');
      const n = mine.length;
      const subject = allFixed
        ? (n === 1 ? 'Your note about a classroom question is fixed'
                   : `${n} of your notes about classroom questions are fixed`)
        : (n === 1 ? 'An update on your note about a classroom question'
                   : `An update on ${n} of your notes about classroom questions`);
      const onlyRoom = new Set(mine.map(r => r.classroom_id)).size === 1 ? mine[0].classroom_id : null;
      const href = onlyRoom ? `${COMMUNITY_URL}?classroom=${encodeURIComponent(onlyRoom)}` : COMMUNITY_URL;

      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:620px;margin:0 auto;padding:1.6rem;color:#1a1a1a;">
  <p style="margin:0 0 1rem;font-size:0.95rem;">${first ? `Hi ${esc(first)},` : 'Hi,'}</p>
  <p style="margin:0 0 1.2rem;font-size:0.95rem;">
    Thank you for ${n === 1 ? 'the note' : 'the notes'} you sent from the BirdWatchAI classroom.
    ${allFixed ? (n === 1 ? 'It is fixed, and the change is live now.' : 'They are fixed, and the changes are live now.')
               : 'Here is where things stand.'}</p>
  ${mine.map(r => card(r, roomName.get(r.classroom_id ?? '') ?? '')).join('')}
  <div style="text-align:center;margin:1.4rem 0 0.6rem;">
    <a href="${esc(href)}" style="display:inline-block;background:#2eaa4f;color:white;text-decoration:none;padding:9px 22px;border-radius:6px;font-weight:600;font-size:0.9rem;">Open your classroom</a>
  </div>
  <p style="font-size:0.72rem;color:#9ca3af;text-align:center;margin-top:1rem;">
    You are getting this because you flagged or suggested something in a BirdWatchAI classroom.
    It is sent once per note.</p>
</body></html>`;

      // A thrown network error must land here, not in the outer catch,
      // or these rows would stay claimed and never be retried.
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
        });
        if (res.ok) { sent++; continue; }
        console.error('Resend error:', (await res.text()).slice(0, 300));
      } catch (e) {
        console.error('send threw:', String(e));
      }
      failed.push(...mine.map(r => r.id));
    }

    // Hand failed sends back so the daily sweep tries again. Logged, not
    // fatal, if even that fails: those rows then simply never mail, which
    // is the safe direction for a teacher's inbox.
    if (failed.length) {
      const { error: uerr } = await db.rpc('classroom_feedback_unclaim_resolved', { p_ids: failed });
      if (uerr) console.error('could not unclaim:', uerr.message);
    }

    return json({ ok: !failed.length, resolved: rows.length, emails: sent,
                  no_address: skipped, failed: failed.length }, failed.length ? 502 : 200);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
