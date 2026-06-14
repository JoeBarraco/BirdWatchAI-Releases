// Edge function: license-lookup
//
// Account-portal read path. The portal sends the user through a Supabase
// magic-link auth flow, then POSTs the resulting access_token here. We
// verify the token, pull the email out of it, and return the user's
// (non-revoked) license keys via the license_lookup_by_email RPC.
//
// Token verification uses Supabase's auth.getUser — the user-scoped client
// rejects expired or forged JWTs, so we don't need to handle the JWT crypto
// ourselves.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Content-Type':                 'application/json',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
      },
    });
  }
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  let access_token = '';
  try {
    const body = await req.json();
    access_token = body?.access_token ?? '';
  } catch {
    return new Response(JSON.stringify({ error: 'Bad JSON' }), { status: 400, headers: corsHeaders });
  }
  if (!access_token) {
    return new Response(JSON.stringify({ error: 'access_token required' }), { status: 401, headers: corsHeaders });
  }

  // Use the anon client with the user's JWT to verify the token.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${access_token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user?.email) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: corsHeaders });
  }
  const email = userData.user.email;

  const { data: rows, error: rpcErr } = await admin.rpc('license_lookup_by_email', { p_email: email });
  if (rpcErr) {
    return new Response(JSON.stringify({ error: rpcErr.message }), { status: 500, headers: corsHeaders });
  }

  return new Response(
    JSON.stringify({ email, licenses: rows ?? [] }),
    { status: 200, headers: corsHeaders }
  );
});
