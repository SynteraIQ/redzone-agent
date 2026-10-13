"use client";

import { signIn, signOut } from "next-auth/react";

function Brand() {
  return (
    <a className="auth-brand" href="/" aria-label="Red Zone home">
      <span className="brand-mark">R</span>
      <span>redzone<span className="brand-period">.</span></span>
    </a>
  );
}

export function LoginScreen({ configured, loggedOut }: { configured: boolean; loggedOut: boolean }) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <div className="auth-card-content">
          <h1 id="login-title">Sign into RedZone</h1>
          <p className="auth-description">Welcome back, let’s start reviewing.</p>
          {loggedOut && <p className="auth-confirmation" role="status">You have been signed out.</p>}
          {configured ? (
            <button className="github-auth-button" type="button" onClick={() => signIn("github", { callbackUrl: "/" })}>
              <span className="github-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" role="img" aria-label=""><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.1c-3.1.67-3.76-1.31-3.76-1.31-.5-1.28-1.24-1.62-1.24-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.7 1.15 1.7 1.15.99 1.7 2.6 1.21 3.23.92.1-.72.39-1.21.7-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.12-1.45 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.34.75 1 .75 2.02v3.12c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z" /></svg>
              </span>
              <span>GitHub Cloud</span>
              <span className="auth-arrow" aria-hidden="true">↗</span>
            </button>
          ) : (
            <div className="auth-unavailable" role="status">GitHub sign-in is not configured. Add <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> to <code>.env</code>, then restart the app.</div>
          )}
          <div className="auth-separator"><span /> <span>OR</span> <span /></div>
          <div className="auth-sso-placeholder">Single Sign-On <span>Not configured</span></div>
          <p className="auth-signup">New to RedZone? <span>Sign in with GitHub to get started.</span></p>
        </div>
        <footer className="auth-footer"><span>REDZONE AGENT</span><span>Evidence before confidence.</span></footer>
      </section>
    </main>
  );
}

export function LogoutScreen({ userName }: { userName: string | null }) {
  return (
    <main className="auth-page">
      <div className="auth-orbit auth-orbit-one" aria-hidden="true" />
      <div className="auth-orbit auth-orbit-two" aria-hidden="true" />
      <section className="auth-card logout-card" aria-labelledby="logout-title">
        <Brand />
        <div className="auth-card-content">
          <div className="auth-eyebrow"><span /> SESSION SETTINGS</div>
          <h1 id="logout-title">Sign out of RedZone?</h1>
          <p className="auth-description">{userName ? `You’re signed in as ${userName}.` : "Your GitHub session will be ended on this device."} Your repository installation stays connected until you remove RedZone from GitHub.</p>
          <button className="github-auth-button logout-button" type="button" onClick={() => signOut({ callbackUrl: "/login?loggedOut=true" })}>
            Sign out
            <span className="auth-arrow" aria-hidden="true">→</span>
          </button>
          <a className="stay-signed-in" href="/">Stay signed in</a>
        </div>
        <footer className="auth-footer"><span>REDZONE AGENT</span><span>Session and app installation are separate.</span></footer>
      </section>
    </main>
  );
}
