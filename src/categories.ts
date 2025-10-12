import { supabase } from './supabaseClient';
import { upsertBudget } from './data';

export type Category = {
  id: string;
  household_id: string;
  name: string;
  sort_order?: number | null;
  color?: string | null;
};

export async function listCategories(householdId: string) {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('household_id', householdId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || []) as Category[];
}

export async function createCategory(householdId: string, name: string) {
  const { data, error } = await supabase
    .from('categories')
    .insert({ household_id: householdId, name })
    .select('*')
    .single();
  // 23505 = unique_violation (e.g., same name already exists for household)
  // @ts-ignore
  if (error && error.code === '23505') return null;
  if (error) throw error;
  return data as Category;
}

export async function updateCategoryColor(id: string, color: string | null) {
  const { data, error } = await supabase
    .from('categories')
    .update({ color })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data as Category | null;
}

/** Rename a category and migrate existing transactions & budgets that use the old name */
export async function renameCategoryAndMigrate(
  householdId: string,
  id: string,
  oldName: string,
  newName: string
) {
  // Update the category row
  const { error: e1 } = await supabase
    .from('categories')
    .update({ name: newName })
    .eq('id', id);
  if (e1) throw e1;

  // Migrate transactions
  const { error: e2 } = await supabase
    .from('transactions')
    .update({ category: newName })
    .eq('household_id', householdId)
    .eq('category', oldName);
  if (e2) throw e2;

  // Migrate budget row if exists
  const { data: oldBud } = await supabase
    .from('budgets')
    .select('*')
    .eq('household_id', householdId)
    .eq('category', oldName)
    .maybeSingle();

  if (oldBud) {
    await upsertBudget(householdId, newName, Number(oldBud.amount));
    await supabase.from('budgets')
      .delete()
      .eq('household_id', householdId)
      .eq('category', oldName);
  }
}

/** Delete a category only if unused by any transactions or budgets */
export async function deleteCategoryIfUnused(householdId: string, id: string, name: string) {
  // any transactions?
  const { count: tcount, error: eT } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('household_id', householdId)
    .eq('category', name);
  if (eT) throw eT;
  if ((tcount || 0) > 0) throw new Error('Category in use by transactions');

  // any budget row?
  const { count: bcount, error: eB } = await supabase
    .from('budgets')
    .select('*', { count: 'exact', head: true })
    .eq('household_id', householdId)
    .eq('category', name);
  if (eB) throw eB;
  if ((bcount || 0) > 0) throw new Error('Category in use by budgets');

  const { error } = await supabase.from('categories').delete().eq('id', id);
  if (error) throw error;
}

/** One-click seed if you have no categories yet */
export async function seedDefaultCategories(householdId: string) {
  const defaults = [
    'Groceries','Dining & Cafes','Transport & Fuel','Shopping & Retail',
    'Beauty & Personal Care','Health & Pharmacy','Utilities & Bills',
    'Insurance','Travel & Accommodation','Kids/Family','Gifts',
    'Entertainment & Subscriptions','Fees & Charges','Taxes & Government',
    'Work/Study','Home','Medical','Other'
  ];
  const rows = defaults.map((name, i) => ({ household_id: householdId, name, sort_order: i }));
  const { error } = await supabase.from('categories').insert(rows);
  if (error && error.code !== '23505') throw error; // ignore dup if seeded already
}
