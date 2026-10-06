import { requestUrl } from "obsidian";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Full Drive scope so the plugin can see files that already exist in the
// chosen folder (drive.file would only see files this plugin created).
export const SCOPE = "https://www.googleapis.com/auth/drive";
export const DEFAULT_REDIRECT = "https://dg0988.github.io/ObsidianGSync/callback.html";
export const PROTOCOL_ACTION = "gsync-auth";
const PENDING_TTL_MS = 15 * 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Saved between opening the browser and Google sending the user back. */
export interface PendingAuth {
  verifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function formBody(o: Record<string, string>): string {
  return Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Opens Google's consent page in the browser. Google redirects to the static
 * callback page, which hands the code back via obsidian://gsync-auth.
 * The vault name rides along in `state` so the right vault is reopened.
 */
export async function beginSignIn(clientId: string, redirectUri: string, vaultName: string): Promise<PendingAuth> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const state =
    base64url(crypto.getRandomValues(new Uint8Array(16))) + "~" + base64url(new TextEncoder().encode(vaultName));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  window.open(`${AUTH_URL}?${params.toString()}`);
  return { verifier, state, redirectUri, createdAt: Date.now() };
}

export function isPendingValid(p: PendingAuth | null | undefined): p is PendingAuth {
  return !!p && Date.now() - p.createdAt < PENDING_TTL_MS;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  pending: PendingAuth
): Promise<TokenSet> {
  const r = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: formBody({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: pending.verifier,
      grant_type: "authorization_code",
      redirect_uri: pending.redirectUri,
    }),
    throw: false,
  });
  if (r.status !== 200) throw new Error(`Token exchange failed (${r.status}): ${r.text}`);
  const j = r.json;
  if (!j.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and sign in again.");
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: number }> {
  const r = await requestUrl({
    url: TOKEN_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: formBody({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    throw: false,
  });
  if (r.status !== 200) {
    if (r.text.includes("invalid_grant")) {
      throw new Error(
        "Google rejected the saved sign-in (invalid_grant). Sign in again. If this happens every ~7 days, publish your OAuth app to 'In production' in Google Cloud."
      );
    }
    if (r.text.includes("invalid_client") || r.text.includes("unauthorized_client")) {
      throw new Error("Google rejected the client ID/secret. If you switched OAuth clients, sign in again with the new one.");
    }
    throw new Error(`Token refresh failed (${r.status}): ${r.text}`);
  }
  const j = r.json;
  return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
}
