const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn("SUPABASE_URL / SUPABASE_ANON_KEY not set — real accounts (signup/login) will not work until these env vars are set.");
}

// Base client — used only for signUp/signInWithPassword/getUser/refreshSession
// (auth operations that don't need row-level access).
const supabase = createClient(SUPABASE_URL || "https://placeholder.supabase.co", SUPABASE_ANON_KEY || "placeholder");

// Per-request client carrying the signed-in user's JWT, so Postgres RLS
// policies (auth.uid() = user_id) evaluate correctly for THIS user's queries.
// A single shared client cannot do this — every authenticated request must
// build its own via this function.
function createUserClient(accessToken) {
  return createClient(SUPABASE_URL || "https://placeholder.supabase.co", SUPABASE_ANON_KEY || "placeholder", {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = { supabase, createUserClient };
