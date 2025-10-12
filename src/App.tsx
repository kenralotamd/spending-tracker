import './App.css';
import { useSession, SignIn } from './auth';
import { supabase } from './supabaseClient';
import Tracker from './tracker/Tracker';

function SignedIn() {
  async function signOut() {
    await supabase.auth.signOut();
  }
  return (
    <div>
      <div style={{ padding: 12, borderBottom: '1px solid #eee', display:'flex', justifyContent:'space-between' }}>
        <div><strong>Spending Tracker</strong></div>
        <button onClick={signOut}>Sign out</button>
      </div>
      <Tracker />
    </div>
  );
}

export default function App() {
  const session = useSession();
  if (!session) return <SignIn />;
  return <SignedIn />;
}
