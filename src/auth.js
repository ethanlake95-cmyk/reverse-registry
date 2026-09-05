// The security-relevant parts, in one file.
//
//  * The code is the identity. Each person has a unique code. Presenting it
//    binds an HttpOnly, HMAC-signed session cookie to that person.
//  * Every API route that returns gift data checks the cookie and the person's
//    role on the server. A recipient's session can never reach the list
//    before the unlock time.
//  * Code attempts are throttled per submitted code (so one guessed-at code
//    can't be hammered) with a looser cap per client IP.

const crypto = require("node:crypto");

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_TTL_SEC = 60 * 60 * 24 * 90;
const COOKIE_NAME = "rr_session";

// ---------- codes ----------

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

function generateCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)]; // unbiased
  return s; // stored/compared without the hyphen; displayed as XXXX-XXXX
}

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

// Middleware factory. `lookup(personId, eventId, slug)` returns the person row
// (with role and event) if that person belongs to that event, else null.
// `roles` lists who may pass. A recipient asking for a list-only route is told
// they're blocked; any other mismatch is "not your page".
function requireRole(lookup, roles) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const t = readToken(cookies[COOKIE_NAME]);
    if (!t) return res.status(401).json({ error: "code required" });
    const person = lookup(t.personId, t.eventId, req.params.slug);
    if (!person) return res.status(401).json({ error: "code required" });
    if (!roles.includes(person.role)) {
      if (person.role === "recipient") return res.status(403).json({ blocked: true, error: "this list is not for you" });
      return res.status(403).json({ error: "not your page" });
    }
    req.person = person;
    next();
  };
}

// ---------- rate limiting ----------
// Two counters. Per submitted code: a stranger can't hammer one code, and a
// table full of relatives mistyping doesn't burn anyone else's allowance.
// Per client IP: a single machine can't walk the keyspace slowly.

const buckets = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const PER_CODE = 25;
const PER_IP = 300;

function bump(key, limit) {
  const now = Date.now();
  let rec = buckets.get(key);
  if (!rec || rec.resetAt < now) { rec = { count: 0, resetAt: now + WINDOW_MS }; buckets.set(key, rec); }
  rec.count += 1;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  return rec.count <= limit ? null : Math.ceil((rec.resetAt - now) / 1000);
}

// req.ip is the address Render (or any single proxy hop) saw, with trust proxy = 1.
function checkAttempt(req, code) {
  const ip = req.ip || req.socket.remoteAddress || "?";
  const byIp = bump(`ip|${ip}`, PER_IP);
  if (byIp) return { ok: false, retryAfterSec: byIp, why: "too many tries from this network. Wait a few minutes." };
  const byCode = code ? bump(`code|${code}`, PER_CODE) : null;
  if (byCode) return { ok: false, retryAfterSec: byCode, why: "that code has been tried too many times. Wait a few minutes." };
  return { ok: true };
}

module.exports = {
  COOKIE_NAME, generateCode, cleanCode, formatCode,
  issueToken, readToken, parseCookies, setSessionCookie, clearSessionCookie,
  requireRole, checkAttempt,
};
