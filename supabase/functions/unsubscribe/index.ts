import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SITE_URL              = Deno.env.get('SITE_URL') ?? 'https://joebarraco.github.io/birdwatchai-releases';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get('token');

  if (!token) {
    return new Response('Missing token.', { status: 400 });
  }

  const { error } = await supabase
    .from('newsletter_signups')
    .delete()
    .eq('unsubscribe_token', token);

  if (error) {
    console.error('Unsubscribe error:', error);
    return new Response('Something went wrong. Please try again.', { status: 500 });
  }

  // Redirect to site with success message
  return new Response(null, {
    status: 302,
    headers: { Location: `${SITE_URL}/?unsubscribed=1` },
  });
});
