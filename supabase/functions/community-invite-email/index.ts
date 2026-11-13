// Tell somebody they have been invited to a community.
//
// WHY THIS EXISTS
// Community invites are keyed by email address and redeemed by
// community_redeem_invites() on the recipient's next sign-in. That design is
// good and is not changing: there is no token in the link, so nothing to
// forward and nothing to leak. But it had a hole that only showed up with
// real people in it — NOTHING EVER TOLD THEM. Four teachers sat as pending
// invites for three days because the only way they could have found out was
// somebody mentioning it to them in a corridor.
//
// So this sends a notification, not a credential. The email carries the
// community name, the role, and the address to sign in WITH. It carries no
// token, no password and no magic link, which means forwarding it to the
// wrong person grants that person nothing at all: they would have to receive
// mail at the invited address to get in. The security property that justified
// sending no email in the first place is kept exactly.
//
// AUTHORISATION
// The caller's own JWT is used to call community_invite, so the RPC's
// existing community_require_role check IS the authorisation — owner and
// moderator only, and moderators cannot mint moderators. That matters for a
// function that sends mail: without it this would be an open relay for
// "you have been invited to BirdWatchAI" to any address on earth. You can
// only cause an email to be sent to somebody you were already entitled to
// invite.
//
// The service-role client is used for ONE thing: reading the community's
// display name for the email body. It never writes.
//
// DEPLOY
//   npx supabase@latest functions deploy community-invite-email \
//       --project-ref lsamggztfizmkyljdgwq
// Secrets: RESEND_API_KEY already exists (weekly-digest, send-temp-password).
// COMMUNITY_URL and INVITE_FROM_EMAIL are optional and have defaults.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL   = Deno.env.get('INVITE_FROM_EMAIL') ?? 'BirdWatchAI <noreply@birdwatchai.com>';
const COMMUNITY_URL = Deno.env.get('COMMUNITY_URL') ?? 'https://www.birdwatchai.com/docs/community.html';

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function esc(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// What each role actually lets you do, in a teacher's words rather than the
// schema's. A line that says "you are a viewer" tells somebody nothing.
function roleLine(role: string) {
  if (role === 'teacher')   return 'You can run classroom sessions and see your own classes.';
  if (role === 'moderator') return 'You can manage the roster and approve feeders.';
  return 'You can see this community’s feeders and detections.';
}

function buildHtml(community: string, role: string, email: string, invitedBy: string) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:2rem;color:#1a1a1a;">
  <div style="text-align:center;margin-bottom:1.5rem;">
    <span style="font-size:2rem;">&#128038;</span>
    <h2 style="margin:0.5rem 0 0;font-size:1.25rem;">You've been added to ${esc(community)}</h2>
  </div>
  <p>${esc(invitedBy)} added you to <strong>${esc(community)}</strong> on BirdWatchAI
     as a <strong>${esc(role)}</strong>.</p>
  <p style="color:#4a4640;">${roleLine(role)}</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:1rem 1.25rem;margin:1.25rem 0;">
    <p style="margin:0 0 0.4rem;font-size:0.85rem;color:#6b7280;">Sign in with this address</p>
    <p style="margin:0;font-weight:600;">${esc(email)}</p>
  </div>
  <p style="font-size:0.9rem;">Open the community page, choose <strong>Sign In</strong> and enter
     that address. You'll be emailed a link to click &mdash; there's no password to set up, and
     you're added automatically the first time you sign in.</p>
  <div style="text-align:center;margin:1.5rem 0;">
    <a href="${COMMUNITY_URL}" style="display:inline-block;background:#2eaa4f;color:white;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:600;font-size:0.95rem;">Open BirdWatchAI</a>
  </div>
  <p style="font-size:0.75rem;color:#9ca3af;text-align:center;">
    This message is only a notification &mdash; it contains no sign-in link and grants nothing
    on its own. If you didn't expect it, you can ignore it.</p>
</body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return new Response('Method Not Allowed', { status: 405, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return json({ error: 'Sign-in required' }, 401);

    const { community_id, email, role } = await req.json();
    if (!community_id || !email) return json({ error: 'community_id and email are required' }, 400);
    const wantRole = role === 'moderator' || role === 'teacher' ? role : 'viewer';

    // AS THE CALLER. community_invite does the permission check itself, and
    // doing it this way means this function cannot invite anybody the caller
    // could not have invited from the panel.
    // SUPABASE_ANON_KEY is injected into every edge function by default, but
    // fall back to the apikey the caller sent rather than dying on a missing
    // env var — the Authorization header is what actually carries identity.
    const anon = SUPABASE_ANON_KEY || req.headers.get('apikey') || '';
    const asUser = createClient(SUPABASE_URL, anon, {
      global: { headers: { Authorization: auth } },
    });

    const { data: me } = await asUser.auth.getUser();
    if (!me?.user) return json({ error: 'Sign-in required' }, 401);

    const { error: inviteErr } = await asUser.rpc('community_invite', {
      p_community_id: community_id,
      p_email:        email,
      p_role:         wantRole,
    });
    // Forwarded verbatim: these are the real messages ("Only the community
    // owner can invite moderators", "The teacher role is only available in a
    // community set up as a school") and the panel already knows how to show
    // them.
    if (inviteErr) return json({ error: inviteErr.message }, 400);

    // The invite is stored. Everything below is the notification, and a
    // failure past this point must not read as a failed invite.
    const { data: comm } = await admin
      .from('communities').select('name').eq('id', community_id).single();
    const community = comm?.name ?? 'a BirdWatchAI community';

    const { data: prof } = await admin
      .from('user_profiles').select('display_name').eq('id', me.user.id).single();
    const invitedBy = (prof?.display_name || '').trim() || me.user.email || 'A BirdWatchAI member';

    let sent = false, warning: string | null = null;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: email,
          subject: `You've been added to ${community} on BirdWatchAI`,
          html: buildHtml(community, wantRole, email, invitedBy),
        }),
      });
      sent = res.ok;
      if (!res.ok) {
        warning = 'The invite was created but the email could not be sent.';
        console.error('Resend error:', await res.text());
      }
    } catch (e) {
      warning = 'The invite was created but the email could not be sent.';
      console.error('Resend threw:', e);
    }

    return json({ success: true, invited: true, email_sent: sent, role: wantRole, community, warning });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
