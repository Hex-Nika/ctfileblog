import { createHmac, timingSafeEqual } from "node:crypto";

const siteOrigin = "https://thectfiles.lol";
const sessionCookieName = "ctfiles_cms_session";

function getCookie(request, name) {
  const cookies = request.headers.cookie || "";
  const entry = cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : "";
}

function getSessionUsername(request, secret) {
  const [payload, signature, extra] = getCookie(request, sessionCookieName).split(".");
  if (!payload || !signature || extra) return null;

  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.expiresAt > Math.floor(Date.now() / 1000) ? session.username : null;
  } catch {
    return null;
  }
}

function getProxiedPath(request, requestUrl) {
  const path = request.query?.path ?? requestUrl.searchParams.get("path");
  if (typeof path !== "string") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

export default async function handler(request, response) {
  const requestUrl = new URL(request.url, `https://${request.headers.host}`);
  if (requestUrl.origin !== siteOrigin) {
    return response.status(403).send("CMS API is only available on the production domain");
  }

  const secret = process.env.CMS_SESSION_SECRET || "";
  const username = secret.length >= 32 ? getSessionUsername(request, secret) : null;
  if (!username) {
    return response.status(401).json({ message: "CMS session expired; sign in again." });
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.headers.origin !== siteOrigin) {
    return response.status(403).send("Invalid request origin");
  }

  const apiPath = getProxiedPath(request, requestUrl);
  if (!apiPath) return response.status(400).send("Missing GitHub API path");

  if (apiPath === "/user" && request.method === "GET") {
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ login: username, name: username });
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(apiPath);
  } catch {
    return response.status(400).send("Invalid GitHub API path");
  }

  const pathSegments = decodedPath.split("/");
  if (
    pathSegments.length < 4 ||
    pathSegments[1] !== "repos" ||
    pathSegments[2] !== "Hex-Nika" ||
    pathSegments[3] !== "ctfileblog" ||
    pathSegments.slice(4).some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return response.status(404).send("GitHub API path is not available");
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response.status(500).send("GitHub repository access is not configured");
  }

  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  if (!allowedMethods.has(request.method)) {
    response.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE");
    return response.status(405).send("Method not allowed");
  }

  const upstreamUrl = new URL(`https://api.github.com${apiPath}`);
  const upstreamQuery = new URLSearchParams(requestUrl.searchParams);
  upstreamQuery.delete("path");
  upstreamUrl.search = upstreamQuery.toString();

  const headers = {
    Accept: request.headers.accept || "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "ctfiles-vercel-cms",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (request.headers["content-type"]) headers["Content-Type"] = request.headers["content-type"];

  let body;
  if (["POST", "PUT", "PATCH"].includes(request.method) && request.body !== undefined) {
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }

  try {
    const upstream = await fetch(upstreamUrl, { method: request.method, headers, body });
    const responseBody = Buffer.from(await upstream.arrayBuffer());
    for (const header of ["content-type", "etag", "link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
      let value = upstream.headers.get(header);
      if (header === "link" && value) {
        value = value.replaceAll("https://api.github.com", `${siteOrigin}/api/github`);
      }
      if (value) response.setHeader(header, value);
    }
    response.setHeader("Cache-Control", "no-store");
    return response.status(upstream.status).send(responseBody);
  } catch {
    return response.status(502).send("GitHub API request failed");
  }
}