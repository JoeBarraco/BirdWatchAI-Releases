import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY        = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM_EMAIL            = Deno.env.get('MOD_FROM_EMAIL') ?? 'BirdWatchAI <noreply@birdwatchai.com>';
const COMMUNITY_URL         = Deno.env.get('COMMUNITY_URL') ?? 'https://joebarraco.github.io/birdwatchai-releases/docs/community.html';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildInviteHtml(email: string, tempPassword: string, role: string) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:2rem;color:#1a1a1a;">
  <div style="text-align:center;margin-bottom:1.5rem;">
    <span style="font-size:2rem;">🐦</span>
    <h2 style="margin:0.5rem 0 0;font-size:1.25rem;">Welcome to BirdWatchAI</h2>
  </div>
  <p>You've been added as a <strong>${esc(role)}</strong> on the BirdWatchAI Community Feed.</p>
  <p>Use the credentials below to log in:</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:1rem 1.25rem;margin:1rem 0;">
    <p style="margin:0 0 0.5rem;font-size:0.85rem;color:#6b7280;">Email</p>
    <p style="margin:0 0 1rem;font-weight:600;">${esc(email)}</p>
    <p style="margin:0 0 0.5rem;font-size:0.85rem;color:#6b7280;">Temporary Password</p>
    <p style="margin:0;font-weight:600;font-family:monospace;font-size:1.1rem;letter-spacing:1px;">${esc(tempPassword)}</p>
  </div>
  <p style="font-size:0.85rem;color:#e74c3c;font-weight:600;">You will be asked to set a new password on first login.</p>
  <div style="text-align:center;margin:1.5rem 0;">
    <a href="${COMMUNITY_URL}" style="display:inline-block;background:#2eaa4f;color:white;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:600;font-size:0.95rem;">Log In Now</a>
  </div>
  <p style="font-size:0.75rem;color:#9ca3af;text-align:center;">If you didn't expect this email, you can safely ignore it.</p>
</body>
</html>`;
}

function buildResetHtml(email: string, tempPassword: string) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:2rem;color:#1a1a1a;">
  <div style="text-align:center;margin-bottom:1.5rem;">
    <span style="font-size:2rem;">🐦</span>
    <h2 style="margin:0.5rem 0 0;font-size:1.25rem;">Password Reset</h2>
  </div>
  <p>A password reset was requested for your BirdWatchAI moderator account.</p>
  <p>Use the temporary password below to log in:</p>
  <div style="background:#f4f4f5;border-radius:8px;padding:1rem 1.25rem;margin:1rem 0;">
    <p style="margin:0 0 0.5rem;font-size:0.85rem;color:#6b7280;">Email</p>
    <p style="margin:0 0 1rem;font-weight:600;">${esc(email)}</p>
    <p style="margin:0 0 0.5rem;font-size:0.85rem;color:#6b7280;">Temporary Password</p>
    <p style="margin:0;font-weight:600;font-family:monospace;font-size:1.1rem;letter-spacing:1px;">${esc(tempPassword)}</p>
  </div>
  <p style="font-size:0.85rem;color:#e74c3c;font-weight:600;">You will be asked to set a new password when you log in.</p>
  <div style="text-align:center;margin:1.5rem 0;">
    <a href="${COMMUNITY_URL}" style="display:inline-block;background:#2eaa4f;color:white;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:600;font-size:0.95rem;">Log In Now</a>
  </div>
  <p style="font-size:0.75rem;color:#9ca3af;text-align:center;">If you didn't request this, your account may have been compromised. Please contact your administrator.</p>
</body>
</html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const body = await req.json();
    const { action } = body;

    // ── ACTION: invite (admin adds a new user) ────────────────────────────────
    if (action === 'invite') {
      const { admin_email, admin_password, new_email, new_role } = body;

      if (!admin_email || !admin_password || !new_email) {
        return new Response(
          JSON.stringify({ error: 'Missing required fields' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Call the RPC to create the user (validates admin creds server-side)
      const { data, error } = await supabase.rpc('moderator_add_user', {
        p_email: admin_email,
        p_password: admin_password,
        p_new_email: new_email,
        p_new_role: new_role || 'moderator',
      });

      if (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Send the invite email
      const { temp_password } = data;
      const html = buildInviteHtml(new_email, temp_password, new_role || 'moderator');

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: new_email,
          subject: '🐦 You\'ve been invited to BirdWatchAI',
          html,
        }),
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error('Resend error:', errText);
        // User was created but email failed - still return success with warning
        return new Response(
          JSON.stringify({ success: true, email_sent: false, warning: 'User created but email could not be sent.' }),
          { status: 200, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ success: true, email_sent: true }),
        { status: 200, headers: corsHeaders }
      );
    }

    // ── ACTION: reset (forgot password) ───────────────────────────────────────
    if (action === 'reset') {
      const { email } = body;

      if (!email) {
        return new Response(
          JSON.stringify({ error: 'Email is required' }),
          { status: 400, headers: corsHeaders }
        );
      }

      // Generate a temp password via service-role-only function
      const { data, error } = await supabase.rpc('moderator_reset_password', {
        p_target_email: email,
      });

      if (error) {
        console.error('Reset error:', error);
      }

      // Always return success to avoid leaking whether email exists
      if (!data) {
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: corsHeaders }
        );
      }

      const { temp_password } = data;
      const html = buildResetHtml(email, temp_password);

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: email,
          subject: '🐦 BirdWatchAI Password Reset',
          html,
        }),
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error('Resend error:', errText);
      }

      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action. Use "invite" or "reset".' }),
      { status: 400, headers: corsHeaders }
    );

  } catch (err) {
    console.error('send-temp-password error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: corsHeaders }
    );
  }
});
