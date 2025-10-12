import { supabase } from './supabaseClient';

const LS_ACTIVE = 'active_household_id';

export function getActiveHousehold(): string | null {
  try { return localStorage.getItem(LS_ACTIVE); } catch { return null; }
}
export function setActiveHousehold(id: string) {
  try { localStorage.setItem(LS_ACTIVE, id); } catch {}
}

export async function listMyHouseholds(): Promise<{id:string; name:string}[]> {
  // RLS lets you see households you created or where you're a member
  const { data, error } = await supabase
    .from('households')
    .select('id,name')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as {id:string; name:string}[];
}

export async function createHousehold(name: string): Promise<string> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) throw new Error('Not signed in');

  const id = crypto.randomUUID();

  // Insert household (created_by defaults to auth.uid() in DB)
  const { error: hhe } = await supabase.from('households').insert({ id, name });
  if (hhe) throw hhe;

  // Join as owner
  const { error: jerr } = await supabase
    .from('household_members')
    .insert({ household_id: id, user_id: uid, role: 'owner' });
  if (jerr) throw jerr;

  setActiveHousehold(id);
  return id;
}

export async function ensureHousehold(): Promise<string> {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  const email = u.user?.email || null;
  if (!uid) throw new Error('No user');

  // Ensure profile row exists
  await supabase.from('profiles').upsert({ id: uid, email });

  // Use previously selected household if present
  const saved = getActiveHousehold();
  if (saved) return saved;

  // If user is already a member of any household, pick the first
  const { data: mems, error } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', uid);
  if (error) throw error;

  if (mems && mems.length) {
    const hid = mems[0].household_id as string;
    setActiveHousehold(hid);
    return hid;
  }

  // Otherwise create a default
  return await createHousehold('Family');
}
