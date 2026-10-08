import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const siteOrigin = "https://thectfiles.lol";
const sessionCookieName = "ctfiles_cms_session";
const sessionDurationSeconds = 8 * 60 * 60;

function parseUsers() {
  try {
    const users = JSON.parse(process.env.CMS_USERS || "{}");
    return users && typeof users === "object" && !Array.isArray(users) ? users : {};
  } catch {
    return {};
  }
}

function secureEqual(left, right) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function makeSession(username, secret) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Math.floor(Date.now() / 1000) + sessionDurationSeconds,
  })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

function setSessionCookie(response, session) {
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${session}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${sessionDurationSeconds}`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`,
  );
}

function loginPage(response) {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.status(200).send(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CMS sign in</title>
<style>
  body { max-width: 24rem; margin: 12vh auto; padding: 0 1.25rem; color: #18212b; font: 16px/1.5 system-ui, sans-serif; }
  h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
  input, button { box-sizing: border-box; width: 100%; min-height: 2.75rem; padding: .6rem .75rem; font: inherit; }
  input { border: 1px solid #77828c; border-radius: 4px; }
  button { margin-top: 1.4rem; border: 0; border-radius: 4px; background: #176b54; color: white; font-weight: 700; cursor: pointer; }
  #error { min-height: 1.5rem; color: #a32626; }
</style>
<h1>Sign in to the CMS</h1>
<form id="login-form">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  <p id="error" role="alert"></p>
</form>
<script>
  const trustedOrigin = ${JSON.stringify(siteOrigin)};
  const form = document.getElementById("login-form");
  const errorMessage = document.getElementById("error");
  let handshakeReceived = false;
  let authResult;

  function finishLogin() {
    if (!handshakeReceived || !authResult) return;
    window.opener.postMessage(
      "authorization:github:success:" + JSON.stringify(authResult),
      trustedOrigin,
    );
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== trustedOrigin || event.data !== "authorizing:github") return;
    handshakeReceived = true;
    finishLogin();
  });
  window.opener.postMessage("authorizing:github", trustedOrigin);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorMessage.textContent = "";
    const button = form.querySelector("button");
    button.disabled = true;

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.elements.username.value,
          password: form.elements.password.value,
        }),
      });
      if (!response.ok) throw new Error("Incorrect username or password.");
      authResult = await response.json();
      form.reset();
      finishLogin();
    } catch (error) {
      errorMessage.textContent = error.message;
      button.disabled = false;
    }
  });
</script>
</html>`);
}

export default async function handler(request, response) {
  const requestUrl = new URL(request.url, `https://${request.headers.host}`);
  if (requestUrl.origin !== siteOrigin) {
    return response.status(403).send("CMS authentication is only available on the production domain");
  }

  const secret = process.env.CMS_SESSION_SECRET || "";
  if (secret.length < 32) {
    return response.status(500).send("CMS session secret is not configured");
  }

  if (request.method === "GET") {
    if (requestUrl.searchParams.get("provider") !== "github") {
      return response.status(400).send("Unsupported authentication provider");
    }
    return loginPage(response);
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).send("Method not allowed");
  }

  if (request.headers.origin !== siteOrigin) {
    return response.status(403).send("Invalid request origin");
  }

  if (!process.env.GITHUB_TOKEN) {
    return response.status(500).send("GitHub repository access is not configured");
  }

  let credentials = request.body;
  if (typeof credentials === "string") {
    try {
      credentials = JSON.parse(credentials);
    } catch {
      credentials = {};
    }
  }

  const users = parseUsers();
  const expectedPassword = users[credentials?.username];
  if (
    typeof credentials?.username !== "string" ||
    typeof credentials?.password !== "string" ||
    typeof expectedPassword !== "string" ||
    !secureEqual(credentials.password, expectedPassword)
  ) {
    return response.status(401).json({ error: "Invalid credentials" });
  }

  setSessionCookie(response, makeSession(credentials.username, secret));
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({ token: "vercel-session", provider: "github" });
}