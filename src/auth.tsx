import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export function useSession() {
  const [session, setSession] = useState<any>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  return session;
}

export function SignIn() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function signIn() {
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (!error) setSent(true);
    else alert(error.message);
  }

  if (sent) return <p style={{padding:24}}>Magic link sent. Check your email.</p>;
  return (
    <div style={{ maxWidth: 420, margin: '4rem auto', display: 'grid', gap: 12 }}>
      <h2>Sign in</h2>
      <input
        placeholder="you@example.com"
        value={email}
        onChange={e=>setEmail(e.target.value)}
        style={{ padding: 8, border: '1px solid #ccc', borderRadius: 6 }}
      />
      <button onClick={signIn} style={{ padding: 10, borderRadius: 6 }}>Send magic link</button>
    </div>
  );
}
