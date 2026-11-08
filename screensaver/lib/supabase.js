// BirdWatchAI Community Feed — shared Supabase constants
//
// The publishable (anon) key is deliberately in source: it is the same key the
// public community site ships, and it grants nothing beyond what RLS allows an
// anonymous visitor. Private feeders are reached with a signed-in user's JWT
// instead — see lib/auth.js.

const SUPABASE_URL = 'https://lsamggztfizmkyljdgwq.supabase.co';
const ANON_KEY     = 'sb_publishable_-80LQjkx2s82XnURj2DfQQ_d7ARz3js';

module.exports = { SUPABASE_URL, ANON_KEY };
