// src/pages/Login.tsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

type Profile = { username: string | null };

export default function Login() {
  const nav = useNavigate();

  // tabs
  const [tab, setTab] = useState<"password" | "magic">("password");

  // login
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // signup
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirm, setSignupConfirm] = useState("");

  // magic link
  const [magicEmail, setMagicEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);

  // resend confirmation
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  // forgot password
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  // UX
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // session
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);

  // -------- sync session + username --------
  useEffect(() => {
    let mounted = true;

    async function syncInitial() {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (!mounted) return;

      if (error) {
        console.error("getSession error:", error);
      }

      const user = session?.user ?? null;
      setSessionEmail(user?.email ?? null);
      setSessionUserId(user?.id ?? null);

      if (user?.id) {
        const { data, error: profileError } = await supabase
          .from("profiles")
          .select("username")
          .eq("id", user.id)
          .maybeSingle();

        if (!mounted) return;

        if (profileError) {
          console.error("profile load error:", profileError);
        }
        setUsername((data as Profile | null)?.username ?? null);
      } else {
        setUsername(null);
      }
    }

    syncInitial();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;

      const user = session?.user ?? null;
      setSessionEmail(user?.email ?? null);
      setSessionUserId(user?.id ?? null);

      if (user?.id) {
        supabase
          .from("profiles")
          .select("username")
          .eq("id", user.id)
          .maybeSingle()
          .then(({ data, error }) => {
            if (error) {
              console.error("profile load error (sub):", error);
            }
            setUsername((data as Profile | null)?.username ?? null);
          });
      } else {
        setUsername(null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function ensureProfile(userId: string) {
    await supabase
      .from("profiles")
      .upsert({ id: userId }, { onConflict: "id" });
  }

  // -------- handlers --------
  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setResetError(null);
    setResetMessage(null);
    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim(),
      password: loginPassword,
    });

    setLoading(false);

    if (error) {
      console.error("login error:", error);
      return setError(error.message);
    }

    if (data.session && data.user) {
      await ensureProfile(data.user.id);
      nav("/");
    }
  }

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setResetError(null);
    setResetMessage(null);

    if (signupPassword.length < 6) {
      return setError("Password must be at least 6 characters.");
    }
    if (signupPassword !== signupConfirm) {
      return setError("Passwords do not match.");
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signUp({
      email: signupEmail.trim(),
      password: signupPassword,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setLoading(false);

    if (error) return setError(error.message);

    if (data.user && !data.session) {
      setNotice(
        "Account created. Please confirm your email to finish sign-up."
      );
      return;
    }

    if (data.session && data.user) {
      await ensureProfile(data.user.id);
      nav("/");
    }
  }

  async function resendConfirmation(to: string) {
    setResendMsg(null);
    if (!to.trim()) return setResendMsg("Please enter your email first.");
    setResending(true);
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: to.trim(),
    });
    setResending(false);
    setResendMsg(
      error
        ? error.message
        : `Confirmation email re-sent to ${to}. Check spam too.`
    );
  }

  async function onMagic(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setResetError(null);
    setResetMessage(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: magicEmail.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setLoading(false);
    if (error) return setError(error.message);
    setMagicSent(true);
    setNotice(
      `Magic link sent to ${magicEmail}. Open it in this same browser.`
    );
  }

  async function handleForgotPassword() {
    setResetError(null);
    setResetMessage(null);

    const email = loginEmail.trim();
    if (!email) {
      setResetError("Enter your email above, then click Forgot password.");
      return;
    }

    try {
      setResetLoading(true);

      const redirectTo = `${window.location.origin}/reset-password`;

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo,
      });

      if (error) {
        console.error("[Login] resetPasswordForEmail error:", error);
        setResetError("Could not send reset email. Double-check your email.");
      } else {
        setResetMessage(
          "If that email exists, a reset link has been sent to your inbox."
        );
      }
    } finally {
      setResetLoading(false);
    }
  }

  // -------- render: already signed in --------
  if (sessionEmail) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-200">
        <div className="w-full max-w-md bg-slate-900/60 p-8 rounded-2xl">
          <h1 className="text-2xl font-bold text-yellow-400 text-center mb-4">
            You’re signed in
          </h1>
          <p className="text-center text-slate-300 mb-2">
            <span className="text-slate-400">Email:</span>{" "}
            <b>{sessionEmail}</b>
          </p>
          <p className="text-center text-slate-300 mb-6">
            <span className="text-slate-400">Username:</span>{" "}
            <b>{username ?? "—"}</b>{" "}
            <button
              type="button"
              className="text-yellow-400 underline"
              onClick={() =>
                nav("/username", {
                  state: {
                    userId: sessionUserId,
                    email: sessionEmail,
                  },
                })
              }
            >
              {username ? "edit" : "set username"}
            </button>
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => nav("/")}
              className="flex-1 bg-yellow-400 text-black font-semibold py-2 rounded-xl hover:bg-yellow-300"
            >
              Go to Weekly Picks
            </button>
            <button
              onClick={async () => {
                await supabase.auth.signOut();
              }}
              className="px-4 py-2 rounded-xl border border-slate-700 hover:bg-slate-800"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    );
  }

  // -------- render: default sign-in form --------
  return (
    <div className="min-h-[60vh] flex items-center justify-center text-gray-200">
      <div className="w-full max-w-md bg-slate-900/60 p-8 rounded-2xl">
        <h1 className="text-2xl font-bold text-yellow-400 text-center mb-6">
          Sign In
        </h1>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab("password")}
            className={`flex-1 py-2 rounded ${
              tab === "password"
                ? "bg-yellow-400 text-black"
                : "bg-slate-800 text-slate-200"
            }`}
          >
            Email &amp; Password
          </button>
          <button
            onClick={() => setTab("magic")}
            className={`flex-1 py-2 rounded ${
              tab === "magic"
                ? "bg-yellow-400 text-black"
                : "bg-slate-800 text-slate-200"
            }`}
          >
            Magic Link
          </button>
        </div>

        {tab === "password" ? (
          <>
            {/* Login form */}
            <form onSubmit={onLogin} className="space-y-3">
              <input
                className="w-full rounded-xl bg-slate-800 p-3 border border-slate-700 focus:border-yellow-400"
                type="email"
                placeholder="you@example.com"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                required
              />
              <input
                className="w-full rounded-xl bg-slate-800 p-3 border border-slate-700 focus:border-yellow-400"
                type="password"
                placeholder="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                required
              />
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-2 rounded-xl font-semibold ${
                  loading
                    ? "opacity-70 pointer-events-none"
                    : "bg-yellow-400 text-black hover:bg-yellow-300"
                }`}
              >
                {loading ? "Logging in…" : "Log In"}
              </button>
            </form>

            {/* Forgot password */}
            <div className="mt-3 text-xs text-center text-slate-400">
              <button
                type="button"
                onClick={handleForgotPassword}
                disabled={resetLoading}
                className="text-yellow-300 hover:text-yellow-200 disabled:opacity-60"
              >
                {resetLoading ? "Sending reset link…" : "Forgot password?"}
              </button>
              {resetMessage && (
                <p className="mt-1 text-emerald-300">{resetMessage}</p>
              )}
              {resetError && (
                <p className="mt-1 text-rose-300">{resetError}</p>
              )}
            </div>

            <div className="my-5 text-center text-slate-500 text-sm">or</div>

            {/* Signup form */}
            <form onSubmit={onSignup} className="space-y-3">
              <input
                className="w-full rounded-xl bg-slate-800 p-3 border border-slate-700 focus:border-yellow-400"
                type="email"
                placeholder="you@example.com"
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                required
              />
              <input
                className="w-full rounded-xl bg-slate-800 p-3 border border-slate-700 focus:border-yellow-400"
                type="password"
                placeholder="password (min 6)"
                value={signupPassword}
                onChange={(e) => setSignupPassword(e.target.value)}
                required
              />
              <input
                className="w-full rounded-xl bg-slate-800 p-3 border border-slate-700 focus:border-yellow-400"
                type="password"
                placeholder="confirm password"
                value={signupConfirm}
                onChange={(e) => setSignupConfirm(e.target.value)}
                required
              />
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-2 rounded-xl ${
                  loading
                    ? "opacity-70 pointer-events-none"
                    : "bg-slate-800 hover:bg-slate-700 border border-slate-600"
                }`}
              >
                Create Account
              </button>
            </form>

            <button
              type="button"
              onClick={() => resendConfirmation(signupEmail || loginEmail)}
              className="w-full mt-3 text-xs text-yellow-300 underline"
              disabled={resending}
            >
              {resending ? "Resending…" : "Resend confirmation email"}
            </button>
            {resendMsg && (
              <p className="text-emerald-300 text-xs mt-1 text-center">
                {resendMsg}
              </p>
            )}
          </>
        ) : (
          <form onSubmit={onMagic} className="space-y-3">
            <input
              className="w-full rounded-xl bg-slate-800 p-3 border border-slate-700 focus:border-yellow-400"
              type="email"
              placeholder="you@example.com"
              value={magicEmail}
              onChange={(e) => setMagicEmail(e.target.value)}
              required
            />
            <button
              type="submit"
              disabled={loading}
              className={`w-full py-2 rounded-xl font-semibold ${
                loading
                  ? "opacity-70 pointer-events-none"
                  : "bg-yellow-400 text-black hover:bg-yellow-300"
              }`}
            >
              {loading ? "Sending…" : "Send Magic Link"}
            </button>
            {magicSent && (
              <p className="text-emerald-300 text-sm text-center">
                Check your inbox and open the link in this browser.
              </p>
            )}
          </form>
        )}

        {notice && (
          <p className="text-emerald-300 text-sm text-center mt-3">
            {notice}
          </p>
        )}
        {error && (
          <p className="text-red-400 text-sm text-center mt-3">{error}</p>
        )}
      </div>
    </div>
  );
}