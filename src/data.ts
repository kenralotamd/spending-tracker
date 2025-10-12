import { supabase } from './supabaseClient';

export type Txn = {
  id?: string;
  household_id: string;
  date: string;                       // yyyy-mm-dd
  person: 'Ken' | 'Wife' | 'Both';
  merchant?: string;
  description?: string;
  amount: number;                     // +spend, -refund
  category?: string;
  tags?: string[];
  notes?: string;
  source?: 'manual' | 'import';
  external_id?: string | null;        // used for server-side de-dupe
};

export async function listTransactions(householdId: string, from?: string, to?: string) {
  let q = supabase.from('transactions').select('*').eq('household_id', householdId).order('date', { ascending: true });
  if (from) q = q.gte('date', from);
  if (to) q = q.lte('date', to);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []) as Txn[];
}

export async function addTransaction(t: Txn) {
  const { data, error } = await supabase.from('transactions').insert(t).select('*').single();
  // Unique violation (duplicate external_id) -> ignore silently
  // @ts-ignore
  if (error && error.code === '23505') return null;
  if (error) throw error;
  return data as Txn;
}

export async function updateTransaction(id: string, patch: Partial<Txn>) {
  const { data, error } = await supabase.from('transactions').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data as Txn;
}

export async function deleteTransaction(id: string) {
  const { error } = await supabase.from('transactions').delete().eq('id', id);
  if (error) throw error;
}

export async function listBudgets(householdId: string) {
  const { data, error } = await supabase.from('budgets').select('*').eq('household_id', householdId);
  if (error) throw error;
  return (data || []) as { household_id: string; category: string; amount: number }[];
}

export async function upsertBudget(householdId: string, category: string, amount: number) {
  const { data, error } = await supabase.from('budgets').upsert({ household_id: householdId, category, amount }).select('*').single();
  if (error) throw error;
  return data as { household_id: string; category: string; amount: number };
}

// ---------- CSV helpers ----------
export function toISO(d: any): string | null {
  const tryParse = (dayFirst: boolean) => {
    const m = new Date(d);
    if (!isNaN(m.getTime())) return m.toISOString().slice(0,10);
    if (typeof d === 'string') {
      const mm = d.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (mm) {
        const a = Number(mm[1]), b = Number(mm[2]), c = Number(mm[3]);
        const dd = dayFirst ? a : b; const mon = dayFirst ? b : a; const yyyy = c < 100 ? 2000 + c : c;
        const dt = new Date(Date.UTC(yyyy, mon - 1, dd));
        if (!isNaN(dt.getTime())) return dt.toISOString().slice(0,10);
      }
    }
    return null;
  };
  return tryParse(false) || tryParse(true);
}

export function parseNumber(x: any): number {
  if (x === null || x === undefined) return NaN;
  const n = parseFloat(String(x).replace(/,/g, '').trim());
  return isFinite(n) ? n : NaN;
}

export function cleanStr(s: string) {
  return (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
}

export function fingerprint(dateISO: string, amount: number, merchant: string, description: string) {
  const cents = Math.round(Math.abs(amount) * 100);
  const base = [dateISO.slice(0,10), String(cents), cleanStr(merchant), cleanStr(description)].join('|');
  let h = 0;
  for (let i = 0; i < base.length; i++) { h = ((h << 5) - h) + base.charCodeAt(i); h |= 0; }
  return String(h);
}
