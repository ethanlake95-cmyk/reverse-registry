// Proof that the lockout is enforced by the server, not the browser, and that
// the seven handoff changes hold.
//
// Starts a real server on a random port with a throwaway database, sets up an
// event the way the wizard does, posts a recognisable "canary" gift as a guest,
// then attacks the gate the way a nosy recipient would. Every response body is
// searched for the canary and for every guest code.
//
// Run:  npm test

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rr-")), "test.db");
process.env.SESSION_SECRET = "test-secret-do-not-use";

const { createApp } = require("../src/server");
const auth = require("../src/auth");
const time = require("../src/time");

const CANARY = "CANARY_STAND_MIXER_9931";
let base, passed = 0, failed = 0;

function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
}

async function req(method, url, { body, cookie, headers = {} } = {}) {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, setCookie: res.headers.get("set-cookie") || "" };
}
const cookieOf = (r) => r.setCookie.split(";")[0];
const enter = (code, extra = {}) => req("POST", "/api/enter", { body: { code }, ...extra });

function tomorrow(offsetDays) { const d = new Date(Date.now() + offsetDays * 86400000); return d.toISOString().slice(0, 10); }

async function main() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nServer up at ${base}\n`);

  console.log("0. Setup");
  const bad = await req("POST", "/api/events", { body: { title: "x", date: "2026-02-30", timezone: "America/New_York", recipients: ["R"], guests: ["G"] } });
  check("an impossible date is rejected", bad.status === 400);
  const badTz = await req("POST", "/api/events", { body: { title: "x", date: "2026-11-21", timezone: "Mars/Base", recipients: ["R"], guests: ["G"] } });
  check("an unknown timezone is rejected", badTz.status === 400);
  const created = await req("POST", "/api/events", { body: {
    occasion: "Wedding", title: "Ethan and Andrea's wedding", date: "2026-11-21", timezone: "America/New_York",
    recipients: ["Ethan Lake", "Andrea Nunez"], categories: ["Kitchen", "Outdoor cooking"], suggestedMin: "$75 to $100",
    guests: ["Jamie Okonkwo", "Priya Raman", "Dana Levitt", "Nadia Fournier", "Ray Whitfield"],
  } });
  const ev = created.json, slug = ev.slug;
  const codes = Object.fromEntries([...ev.recipients, ...ev.guests].map((p) => [p.name, p.code]));
  const allCodes = Object.values(codes);
  const leaks = (r) => r.text.includes(CANARY) || allCodes.some((c) => r.text.includes(c) || r.text.includes(c.replace("-", "")));
  check("event created; codes returned once; no email anywhere in the response", created.status === 201 && ev.guests.length === 5 && !("email" in ev.guests[0]) && !("organiserCode" in ev));
  check("unlock is 06:00 the morning after, in the venue's zone", ev.unlockText === "6am, 22 November 2026 — Eastern time" && time.unlockAt("2026-11-21", "America/New_York").toISOString() === "2026-11-22T11:00:00.000Z");

  const jamie = cookieOf(await enter(codes["Jamie Okonkwo"]));
  const priya = cookieOf(await enter(codes["Priya Raman"]));
  const dana = cookieOf(await enter(codes["Dana Levitt"]));
  const nadia = cookieOf(await enter(codes["Nadia Fournier"]));
  await req("POST", `/api/e/${slug}/gifts`, { cookie: jamie, body: { item: CANARY, openToJoin: true } });

  console.log("\n1. What any browser receives before a code is entered");
  for (const url of [`/e/${slug}`, `/e/${slug}/list`, `/e/${slug}/organiser`, `/app.js`, `/api/e/${slug}`]) {
    const r = await req("GET", url);
    check(`${url} contains no gifts and no codes`, r.status === 200 && !leaks(r));
  }
  check("list without a cookie -> 401", (await req("GET", `/api/e/${slug}/list`)).status === 401);
  check("organiser page without a cookie -> 401", (await req("GET", `/api/e/${slug}/organiser`)).status === 401);

  console.log("\n2. The recipient tries (before the unlock)");
  const ethanEnter = await enter(codes["Ethan Lake"]);
  const ethan = cookieOf(ethanEnter);
  check("recipient code is routed to the organiser page", ethanEnter.json.role === "recipient");
  const rl = await req("GET", `/api/e/${slug}/list`, { cookie: ethan });
  check("recipient asks for the list -> 403 blocked, with the unlock time, no gifts", rl.status === 403 && rl.json.blocked === true && rl.json.unlockText.startsWith("6am") && !leaks(rl));
  check("recipient cannot post, join, edit or flag", [
    (await req("POST", `/api/e/${slug}/gifts`, { cookie: ethan, body: { item: "x" } })).status,
    (await req("POST", `/api/e/${slug}/gifts/1/join`, { cookie: ethan })).status,
    (await req("PATCH", `/api/e/${slug}/gifts/1`, { cookie: ethan, body: { item: "x" } })).status,
    (await req("POST", `/api/e/${slug}/gifts/1/flag`, { cookie: ethan, body: { note: "x" } })).status,
  ].every((s) => s === 403));
  const org = await req("GET", `/api/e/${slug}/organiser`, { cookie: ethan });
  check("recipient's page: names and joined state, NO codes, NO gifts, NO count", org.status === 200 && !leaks(org) && !("giftCount" in org.json) && org.json.people.every((p) => !("code" in p)) && org.json.joinedCount === 4);
  const meR = await req("GET", `/api/e/${slug}/me`, { cookie: ethan });
  check("/me for a recipient carries no codes either", !leaks(meR));

  console.log("\n3. Guessing and forging");
  check("unknown code -> 401 with a neutral message", (await enter("ZZZZ-ZZZZ")).json.error.includes("wasn't recognised"));
  const [pid, eid, exp, sig] = jamie.split("=")[1].split(".");
  check("cookie signed with the wrong secret -> 401", (await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${pid}.${eid}.${exp}.${crypto.createHmac("sha256", "guessed").update(`${pid}.${eid}.${exp}`).digest("base64url")}` })).status === 401);
  check("real cookie with edited expiry -> 401", (await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${pid}.${eid}.${Number(exp) + 1}.${sig}` })).status === 401);
  const [, seid, sexp, ssig] = ethan.split("=")[1].split(".");
  const swapped = await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${pid}.${seid}.${sexp}.${ssig}` });
  check("recipient cookie with a guest's person id swapped in -> 401", swapped.status === 401 && !leaks(swapped));
  const other = (await req("POST", "/api/events", { body: { title: "Other", date: "2026-12-01", timezone: "America/Chicago", recipients: ["N"], guests: ["Pat"] } })).json;
  const pat = cookieOf(await enter(other.guests[0].code));
  check("valid cookie for event B against event A -> 401", (await req("GET", `/api/e/${slug}/list`, { cookie: pat })).status === 401);

  console.log("\n4. Guests, the list, and their own gifts");
  const jl = await req("GET", `/api/e/${slug}/list`, { cookie: jamie });
  check("guest sees the list", jl.status === 200 && jl.text.includes(CANARY));
  check("list payload carries no codes and no moderator identities", !allCodes.some((c) => jl.text.includes(c)) && !jl.text.includes("moderation"));
  check("guest cannot reach the organiser page, thread, role or reveal routes", [
    (await req("GET", `/api/e/${slug}/organiser`, { cookie: jamie })).status,
    (await req("GET", `/api/e/${slug}/thread`, { cookie: jamie })).status,
    (await req("POST", `/api/e/${slug}/people/1/role`, { cookie: jamie, body: { role: "moderator" } })).status,
    (await req("POST", `/api/e/${slug}/people/1/reveal`, { cookie: jamie })).status,
  ].every((s) => s === 403));
  const canary = jl.json.gifts.find((g) => g.item === CANARY);
  const edited = await req("PATCH", `/api/e/${slug}/gifts/${canary.id}`, { cookie: jamie, body: { item: "KitchenAid stand mixer, cream" } });
  check("poster can edit their own gift", edited.status === 200 && edited.json.gifts[0].item === "KitchenAid stand mixer, cream");
  check("someone else cannot edit it", (await req("PATCH", `/api/e/${slug}/gifts/${canary.id}`, { cookie: priya, body: { item: "hacked" } })).status === 403);
  check("someone else cannot delete it", (await req("DELETE", `/api/e/${slug}/gifts/${canary.id}`, { cookie: priya })).status === 403);
  await req("POST", `/api/e/${slug}/gifts/${canary.id}/join`, { cookie: priya });
  const del = await req("DELETE", `/api/e/${slug}/gifts/${canary.id}`, { cookie: jamie });
  check("delete is blocked once someone has joined (409), edit still open", del.status === 409 && (await req("PATCH", `/api/e/${slug}/gifts/${canary.id}`, { cookie: jamie, body: { item: "KitchenAid stand mixer" } })).status === 200);
  const solo = await req("POST", `/api/e/${slug}/gifts`, { cookie: priya, body: { item: "Garden bench" } });
  const bench = solo.json.gifts.find((g) => g.item === "Garden bench");
  const gone = await req("DELETE", `/api/e/${slug}/gifts/${bench.id}`, { cookie: priya });
  check("poster can delete their own un-joined gift, and it disappears", gone.status === 200 && !gone.json.gifts.some((g) => g.id === bench.id));

  console.log("\n5. Proxy posting");
  const nadiaId = jl.json.guests.find((g) => g.name === "Nadia Fournier").id;
  const proxy = await req("POST", `/api/e/${slug}/gifts`, { cookie: dana, body: { item: "Espresso grinder", giverId: nadiaId } });
  const grinder = proxy.json.gifts.find((g) => g.item === "Espresso grinder");
  check("gift is recorded as Nadia's, posted by Dana", grinder.giverName === "Nadia Fournier" && grinder.posterName === "Dana Levitt" && grinder.proxy === true);
  const nl = await req("GET", `/api/e/${slug}/list`, { cookie: nadia });
  check("Nadia sees 'Dana posted a gift in your name'; nobody else does", nl.json.gifts.find((g) => g.id === grinder.id).proxyPostedBy === "Dana Levitt" && !("proxyPostedBy" in jl.json.gifts[0]));
  const ack = await req("POST", `/api/e/${slug}/gifts/${grinder.id}/acknowledge`, { cookie: nadia });
  check("'That's right' clears the banner", ack.status === 200 && !("proxyPostedBy" in ack.json.gifts.find((g) => g.id === grinder.id)));
  check("Nadia can remove a gift posted in her name", (await req("DELETE", `/api/e/${slug}/gifts/${grinder.id}`, { cookie: nadia })).status === 200);
  check("proxy giver cannot be a recipient", (await req("POST", `/api/e/${slug}/gifts`, { cookie: dana, body: { item: "x", giverId: 1 } })).status === 400);

  console.log("\n6. Moderators: promote, flag, agree, demote");
  const people = org.json.people;
  const id = (n) => people.find((p) => p.name === n).id;
  check("cannot promote someone who hasn't joined", (await req("POST", `/api/e/${slug}/people/${id("Ray Whitfield")}/role`, { cookie: ethan, body: { role: "moderator" } })).status === 400);
  const p1 = await req("POST", `/api/e/${slug}/people/${id("Dana Levitt")}/role`, { cookie: ethan, body: { role: "moderator" } });
  const p2 = await req("POST", `/api/e/${slug}/people/${id("Nadia Fournier")}/role`, { cookie: ethan, body: { role: "moderator" } });
  check("recipient promotes two joined guests", p1.status === 200 && p2.json.moderatorCount === 2);
  check("a moderator now reaches the organiser page and the thread, but not role or reveal", [
    (await req("GET", `/api/e/${slug}/organiser`, { cookie: dana })).status === 200,
    (await req("POST", `/api/e/${slug}/thread`, { cookie: dana, body: { body: "hi" } })).status === 201,
    (await req("POST", `/api/e/${slug}/people/${id("Priya Raman")}/role`, { cookie: dana, body: { role: "moderator" } })).status === 403,
    (await req("POST", `/api/e/${slug}/people/${id("Priya Raman")}/reveal`, { cookie: dana })).status === 403,
  ].every(Boolean));
  const modOrg = await req("GET", `/api/e/${slug}/organiser`, { cookie: dana });
  check("moderator's organiser payload has no codes and no gifts", !leaks(modOrg));
  const f1 = await req("POST", `/api/e/${slug}/gifts/${canary.id}/flag`, { cookie: dana, body: { note: "Andrea's parents are already bringing this one." } });
  check("one flag does not remove the gift", f1.status === 200 && f1.json.gifts.find((g) => g.id === canary.id).removed === false);
  const jf = (await req("GET", `/api/e/${slug}/list`, { cookie: jamie })).json.gifts.find((g) => g.id === canary.id);
  check("the poster sees the flag note, unsigned", jf.flag?.note === "Andrea's parents are already bringing this one." && !JSON.stringify(jf).includes("Dana"));
  const pf = (await req("GET", `/api/e/${slug}/list`, { cookie: priya })).json.gifts.find((g) => g.id === canary.id);
  check("other guests see no flag at all", !("flag" in pf) && !("moderation" in pf));
  const editClears = await req("PATCH", `/api/e/${slug}/gifts/${canary.id}`, { cookie: jamie, body: { item: "KitchenAid stand mixer, cream" } });
  check("editing the gift clears the flag", !("flag" in editClears.json.gifts.find((g) => g.id === canary.id)));
  await req("POST", `/api/e/${slug}/gifts/${canary.id}/flag`, { cookie: dana, body: { note: "Duplicate" } });
  const same = await req("POST", `/api/e/${slug}/gifts/${canary.id}/flag`, { cookie: dana, body: {} });
  check("the same moderator twice still doesn't remove it", same.json.gifts.find((g) => g.id === canary.id).removed === false);
  const f2 = await req("POST", `/api/e/${slug}/gifts/${canary.id}/flag`, { cookie: nadia, body: {} });
  check("second moderator agrees -> removed", f2.json.gifts.find((g) => g.id === canary.id).removed === true);
  const pr = (await req("GET", `/api/e/${slug}/list`, { cookie: priya })).json.gifts.find((g) => g.id === canary.id);
  check("guests see it struck through with no reason and no name", pr.removed === true && !("removedReason" in pr) && !JSON.stringify(pr).includes("Duplicate"));
  const jr = (await req("GET", `/api/e/${slug}/list`, { cookie: jamie })).json.gifts.find((g) => g.id === canary.id);
  check("the poster sees the reason", jr.removedReason === "Duplicate");
  const demote = await req("POST", `/api/e/${slug}/people/${id("Nadia Fournier")}/role`, { cookie: ethan, body: { role: "guest" } });
  check("recipient can demote a moderator", demote.json.moderatorCount === 1 && (await req("GET", `/api/e/${slug}/organiser`, { cookie: nadia })).status === 403);

  console.log("\n7. Code lookup");
  const rv = await req("POST", `/api/e/${slug}/people/${id("Ray Whitfield")}/reveal`, { cookie: ethan });
  check("recipient can reveal one guest's code, and it's recorded with their name", rv.status === 200 && rv.json.code === codes["Ray Whitfield"] && rv.json.lookups[0].name === "Ray Whitfield" && rv.json.lookups[0].requester === "Ethan Lake");
  check("cannot reveal a recipient's code", (await req("POST", `/api/e/${slug}/people/${id("Andrea Nunez")}/reveal`, { cookie: ethan })).status === 400);
  const orgAfter = await req("GET", `/api/e/${slug}/organiser`, { cookie: ethan });
  check("organiser page shows the lookup record but still no code", orgAfter.json.lookups.length === 1 && !leaks(orgAfter));

  console.log("\n8. After the unlock");
  const past = (await req("POST", "/api/events", { body: { title: "Last week", date: tomorrow(-3), timezone: "America/New_York", recipients: ["Sam"], guests: ["Guest A", "Guest B"] } })).json;
  const ga = cookieOf(await enter(past.guests[0].code)), gb = cookieOf(await enter(past.guests[1].code));
  const pg = (await req("POST", `/api/e/${past.slug}/gifts`, { cookie: ga, body: { item: "Toaster", openToJoin: true } })).json.gifts[0];
  await req("POST", `/api/e/${past.slug}/gifts/${pg.id}/join`, { cookie: gb });
  const sam = cookieOf(await enter(past.recipients[0].code));
  const ul = await req("GET", `/api/e/${past.slug}/list`, { cookie: sam });
  check("recipient sees the list once the unlock has passed", ul.status === 200 && ul.json.unlocked === true && ul.json.gifts[0].item === "Toaster" && ul.json.gifts[0].joinedBy[0] === "Guest B");
  check("unlocked view has no flags, reasons, controls or moderator info", !JSON.stringify(ul.json).match(/flag|moderation|removedReason|canDelete|mine/));
  const future = (await req("POST", "/api/events", { body: { title: "Tonight", date: tomorrow(0), timezone: "Pacific/Kiritimati", recipients: ["Sam"], guests: ["G"] } })).json;
  const sam2 = cookieOf(await enter(future.recipients[0].code));
  check("an event dated today is still locked (unlock is tomorrow 6am)", (await req("GET", `/api/e/${future.slug}/list`, { cookie: sam2 })).status === 403);

  console.log("\n9. Throttling");
  let last;
  for (let i = 0; i < 27; i++) last = await enter("AAAA-AAAA", { headers: { "X-Forwarded-For": "203.0.113.9" } });
  check("26th try of one code -> 429, message names the code not the person", last.status === 429 && /tried too many times/.test(last.json.error));
  check("a different code from the same client still works", (await enter(codes["Priya Raman"], { headers: { "X-Forwarded-For": "203.0.113.9" } })).status === 200);
  check("a valid code from another client is unaffected", (await enter(codes["Jamie Okonkwo"], { headers: { "X-Forwarded-For": "203.0.113.10" } })).status === 200);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
