// The security-relevant parts, in one file.
//
//  * The code is the identity. Each person has a unique code. Presenting it
//    binds an HttpOnly, HMAC-signed session cookie to that person.
//  * Every API route that returns gift data checks the cookie and the person's
//    role on the server. A recipient's session can never reach the list.
//  * Code attempts are rate-limited per IP.

const crypto = require("node:crypto");

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_SEC = 60 * 60 * 24 * 60; // 60 days: guests come back near the date
const COOKIE_NAME = "rr_session";

// ---------- codes ----------

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

function generateCode() {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s; // stored/compared without the hyphen; displayed as XXXX-XXXX
}

// The alphabet has no O, I, L, 0 or 1, so a lookalike typed by mistake is simply a wrong code.
function cleanCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatCode(code) {
  return code.slice(0, 4) + "-" + code.slice(4);
}

// ---------- session token: "<personId>.<eventId>.<exp>.<sig>" ----------

function sign(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function issueToken(personId, eventId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `${personId}.${eventId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [pid, eid, exp, sig] = parts;
  if (![pid, eid, exp].every((x) => /^\d+$/.test(x))) return null;
  const want = Buffer.from(sign(`${pid}.${eid}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return { personId: Number(pid), eventId: Number(eid) };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, req, personId, eventId) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const attrs = [`${COOKIE_NAME}=${issueToken(personId, eventId)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_TTL_SEC}`];
  if (secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Middleware factory. `lookup(personId, eventId)` returns the person row (with
// role) if that person belongs to that event, else null. `roles` is the set of
// roles allowed through. Recipients asking for guest-only routes get 403 blocked.
function requireRole(lookup, roles) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const t = readToken(cookies[COOKIE_NAME]);
    if (!t) return res.status(401).json({ error: "code required" });
    const person = lookup(t.personId, t.eventId, req.params.slug);
    if (!person) return res.status(401).json({ error: "code required" });
    if (!roles.includes(person.role)) {
      if (person.role !== "guest" && roles.includes("guest")) {
        return res.status(403).json({ blocked: true, error: "this list is not for you" });
      }
      return res.status(403).json({ error: "not your page" });
    }
    req.person = person;
    next();
  };
}

// ---------- rate limiting ----------

const attempts = new Map();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
}

function checkRateLimit(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }
  rec.count += 1;
  if (rec.count > MAX_ATTEMPTS) return { ok: false, retryAfterSec: Math.ceil((rec.resetAt - now) / 1000) };
  return { ok: true };
}

function resetRateLimit(key) {
  attempts.delete(key);
}

module.exports = {
  COOKIE_NAME, generateCode, cleanCode, formatCode,
  issueToken, readToken, parseCookies, setSessionCookie, clearSessionCookie,
  requireRole, clientIp, checkRateLimit, resetRateLimit,
};
