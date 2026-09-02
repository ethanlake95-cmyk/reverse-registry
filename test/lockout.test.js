// Proof that the lockout is enforced by the server, not the browser.
//
// Starts a real server on a random port with a throwaway database, sets up an
// event the way the wizard does, posts a recognisable "canary" gift as a
// guest, then attacks the gate the way a nosy recipient would. Every response
// body is searched for the canary. If it ever shows up on a request that
// isn't from a verified guest session, the test fails.
//
// Run:  npm test

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rr-")), "test.db");
process.env.SESSION_SECRET = "test-secret-do-not-use";
delete process.env.RESEND_API_KEY;

const { createApp } = require("../src/server");
const auth = require("../src/auth");

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
const leaks = (r) => r.text.includes(CANARY);
const cookieOf = (r) => r.setCookie.split(";")[0];
const enter = (code, extra = {}) => req("POST", "/api/enter", { body: { code }, ...extra });

async function main() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nServer up at ${base}\n`);

  // --- setup, exactly what the wizard sends ---
  const created = await req("POST", "/api/events", { body: {
    occasion: "Wedding", title: "Sam and Alex's wedding", date: "2026-10-17",
    recipients: ["Sam Lee", "Alex Chen"], categories: ["Kitchen", "Outdoor cooking"], suggestedMin: "$75 to $100",
    guests: [{ name: "Jordan", email: "jordan@example.com" }, { name: "Riley", email: "" }, { name: "Priya", email: "priya@example.com" }, { name: "Aunt Jean", email: "" }],
  } });
  const ev = created.json;
  const slug = ev.slug;
  const codes = Object.fromEntries([...ev.recipients, ...ev.guests].map((p) => [p.name, p.code]));
  check("event created, one code per person", created.status === 201 && ev.recipients.length === 2 && ev.guests.length === 4 && new Set(Object.values(codes)).size === 6);
  const otherEv = (await req("POST", "/api/events", { body: { occasion: "Birthday", title: "Other", recipients: ["Nobody"], guests: [{ name: "Pat" }] } })).json;

  // Jordan (guest) posts the canary through the front door.
  const jordan = cookieOf(await enter(codes.Jordan));
  await req("POST", `/api/e/${slug}/gifts`, { cookie: jordan, body: { item: CANARY, openToJoin: true } });

  console.log("1. What any browser receives before a code is entered");
  for (const url of [`/e/${slug}`, `/e/${slug}/list`, `/e/${slug}/organiser`, `/app.js`, `/api/e/${slug}`]) {
    const r = await req("GET", url);
    check(`${url} contains no gifts and no codes`, r.status === 200 && !leaks(r) && !Object.values(codes).some((c) => r.text.includes(c)));
  }
  const noCookie = await req("GET", `/api/e/${slug}/list`);
  check("list without a cookie -> 401, nothing in body", noCookie.status === 401 && !leaks(noCookie));
  check("posting without a cookie -> 401", (await req("POST", `/api/e/${slug}/gifts`, { body: { item: "x" } })).status === 401);
  check("organiser page without a cookie -> 401", (await req("GET", `/api/e/${slug}/organiser`)).status === 401);

  console.log("\n2. The recipient tries");
  const sam = await enter(codes["Sam Lee"]);
  check("recipient code is accepted and routed to the organiser page", sam.status === 200 && sam.json.role === "recipient" && sam.json.slug === slug);
  const samCookie = cookieOf(sam);
  const samList = await req("GET", `/api/e/${slug}/list`, { cookie: samCookie });
  check("recipient session asking for the list -> 403 blocked, no gifts in body", samList.status === 403 && samList.json?.blocked === true && !leaks(samList));
  check("recipient session posting a gift -> 403", (await req("POST", `/api/e/${slug}/gifts`, { cookie: samCookie, body: { item: "x" } })).status === 403);
  check("recipient session joining a gift -> 403", (await req("POST", `/api/e/${slug}/gifts/1/join`, { cookie: samCookie })).status === 403);
  const samOrg = await req("GET", `/api/e/${slug}/organiser`, { cookie: samCookie });
  check("recipient's own page shows a count but never the gift", samOrg.status === 200 && samOrg.json.giftCount === 1 && !leaks(samOrg));
  check("recipient's page never includes questions or the list payload", !("gifts" in samOrg.json) && !("questions" in samOrg.json));
  const alexCookie = cookieOf(await enter(codes["Alex Chen"]));
  check("second recipient is also blocked from the list", (await req("GET", `/api/e/${slug}/list`, { cookie: alexCookie })).status === 403);
  const orgCookie = cookieOf(await enter(ev.organiserCode));
  const orgList = await req("GET", `/api/e/${slug}/list`, { cookie: orgCookie });
  check("organiser code (non-recipient) also cannot reach the list", orgList.status === 403 && !leaks(orgList));

  console.log("\n3. Guessing and forging");
  check("unknown code -> 401, no cookie", (await enter("ZZZZ-ZZZZ")).status === 401);
  check("empty code -> 401", (await enter("")).status === 401);
  const junk = await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=1.1.9999999999.abc` });
  check("made-up cookie -> 401", junk.status === 401 && !leaks(junk));
  const [pid, eid, exp, sig] = jordan.split("=")[1].split(".");
  const forgedSig = crypto.createHmac("sha256", "guessed").update(`${pid}.${eid}.${exp}`).digest("base64url");
  check("cookie signed with the wrong secret -> 401", (await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${pid}.${eid}.${exp}.${forgedSig}` })).status === 401);
  check("real cookie with edited expiry -> 401", (await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${pid}.${eid}.${Number(exp) + 1}.${sig}` })).status === 401);
  // A recipient takes their own valid cookie and swaps the person id for a guest's. Signature no longer matches.
  const [spid, seid, sexp, ssig] = samCookie.split("=")[1].split(".");
  const swapped = await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${pid}.${seid}.${sexp}.${ssig}` });
  check("recipient cookie with the person id swapped to a guest's -> 401", swapped.status === 401 && !leaks(swapped));
  const expiredPayload = `${pid}.${eid}.${Math.floor(Date.now() / 1000) - 10}`;
  const expiredSig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(expiredPayload).digest("base64url");
  check("validly-signed but expired cookie -> 401", (await req("GET", `/api/e/${slug}/list`, { cookie: `${auth.COOKIE_NAME}=${expiredPayload}.${expiredSig}` })).status === 401);
  const patCookie = cookieOf(await enter(otherEv.guests[0].code));
  const cross = await req("GET", `/api/e/${slug}/list`, { cookie: patCookie });
  check("valid guest cookie for event B against event A -> 401", cross.status === 401 && !leaks(cross));
  check("a guest code entered on the wrong event's page is refused", (await req("POST", "/api/enter", { body: { code: otherEv.guests[0].code, slug } })).status === 401);

  console.log("\n4. Guests can't reach the recipients' page");
  const jOrg = await req("GET", `/api/e/${slug}/organiser`, { cookie: jordan });
  check("guest session on organiser page -> 403", jOrg.status === 403);
  check("guest cannot make moderators", (await req("POST", `/api/e/${slug}/moderators`, { cookie: jordan, body: { personId: 1 } })).status === 403);
  check("guest cannot post notices", (await req("POST", `/api/e/${slug}/notices`, { cookie: jordan, body: { body: "x" } })).status === 403);
  check("plain guest cannot read the private thread", (await req("GET", `/api/e/${slug}/thread`, { cookie: jordan })).status === 403);
  check("plain guest cannot vote to remove", (await req("POST", `/api/e/${slug}/gifts/1/remove-vote`, { cookie: jordan, body: { reason: "x" } })).status === 403);

  console.log("\n5. The front door");
  const rileyEnter = await enter(codes.Riley.toLowerCase().replace("-", " "));
  check("guest code in any case/spacing -> 200 with HttpOnly SameSite cookie", rileyEnter.status === 200 && rileyEnter.json.role === "guest" && /HttpOnly/i.test(rileyEnter.setCookie) && /SameSite=Lax/i.test(rileyEnter.setCookie));
  const riley = cookieOf(rileyEnter);
  const list = await req("GET", `/api/e/${slug}/list`, { cookie: riley });
  check("verified guest sees the list, categories and suggested minimum", list.status === 200 && leaks(list) && list.json.event.categories.length === 2 && list.json.event.suggestedMin === "$75 to $100");
  check("gift shows whose it is, from the guest list, not typed", list.json.gifts[0].giverName === "Jordan");
  const jean = list.json.guests.find((g) => g.name === "Aunt Jean");
  const proxy = await req("POST", `/api/e/${slug}/gifts`, { cookie: riley, body: { item: "Toaster", giverId: jean.id, categoryId: list.json.event.categories[0].id } });
  const toaster = proxy.json.gifts.find((g) => g.item === "Toaster");
  check("proxy post is recorded as Aunt Jean's, posted by Riley", proxy.status === 201 && toaster.giverName === "Aunt Jean" && toaster.posterName === "Riley" && toaster.proxy === true);
  check("proxy giver must be on the guest list", (await req("POST", `/api/e/${slug}/gifts`, { cookie: riley, body: { item: "x", giverId: 999 } })).status === 400);
  check("proxy giver cannot be a recipient", (await req("POST", `/api/e/${slug}/gifts`, { cookie: riley, body: { item: "x", giverId: 1 } })).status === 400);
  const joined = await req("POST", `/api/e/${slug}/gifts/${list.json.gifts[0].id}/join`, { cookie: riley });
  check("guest can join an open gift", joined.status === 200 && joined.json.gifts.find((g) => g.item === CANARY).joinedBy.includes("Riley"));
  check("cannot join a gift that isn't open", (await req("POST", `/api/e/${slug}/gifts/${toaster.id}/join`, { cookie: riley })).status === 400);
  const asked = await req("POST", `/api/e/${slug}/questions`, { cookie: riley, body: { body: "Is anyone doing a card?" } });
  const replied = await req("POST", `/api/e/${slug}/questions/${asked.json.questions[0].id}/replies`, { cookie: jordan, body: { body: "I am." } });
  check("questions are public on the list and any guest can reply", asked.status === 201 && replied.status === 201 && replied.json.questions[0].replies[0].author === "Jordan");

  console.log("\n6. Moderation: two moderators must agree");
  const org = (await req("GET", `/api/e/${slug}/organiser`, { cookie: samCookie })).json;
  const jordanId = org.joined.find((p) => p.name === "Jordan").id, rileyId = org.joined.find((p) => p.name === "Riley").id;
  check("recipient sees who has joined, by name, with no gifts", org.joined.length === 2 && !JSON.stringify(org).includes(CANARY));
  check("cannot promote someone who hasn't joined", (await req("POST", `/api/e/${slug}/moderators`, { cookie: samCookie, body: { personId: org.people.find((p) => p.name === "Priya").id } })).status === 400);
  check("make Jordan a moderator", (await req("POST", `/api/e/${slug}/moderators`, { cookie: samCookie, body: { personId: jordanId } })).json.moderatorCount === 1);
  check("make Riley a moderator", (await req("POST", `/api/e/${slug}/moderators`, { cookie: samCookie, body: { personId: rileyId } })).json.moderatorCount === 2);
  check("no third moderator", (await req("POST", `/api/e/${slug}/moderators`, { cookie: samCookie, body: { personId: jordanId } })).status === 400);
  const v1 = await req("POST", `/api/e/${slug}/gifts/${toaster.id}/remove-vote`, { cookie: jordan, body: { reason: "Duplicate of an earlier gift" } });
  let t = v1.json.gifts.find((g) => g.id === toaster.id);
  check("one moderator's vote does not remove the gift", v1.status === 200 && t.removed === false && t.removal.youVoted === true);
  const v1again = await req("POST", `/api/e/${slug}/gifts/${toaster.id}/remove-vote`, { cookie: jordan, body: {} });
  check("the same moderator voting twice still doesn't remove it", v1again.json.gifts.find((g) => g.id === toaster.id).removed === false);
  const v2 = await req("POST", `/api/e/${slug}/gifts/${toaster.id}/remove-vote`, { cookie: riley, body: {} });
  t = v2.json.gifts.find((g) => g.id === toaster.id);
  check("second moderator agrees -> gift is removed, still listed, with the reason", t.removed === true && t.removedReason === "Duplicate of an earlier gift");
  const plainView = (await req("GET", `/api/e/${slug}/list`, { cookie: cookieOf(await enter(codes.Priya)) })).json;
  check("guests never see who the moderators are or pending votes", !JSON.stringify(plainView).includes("isModerator\":true") && !plainView.gifts.some((g) => "removal" in g));
  check("moderators can read and write the private thread", (await req("POST", `/api/e/${slug}/thread`, { cookie: jordan, body: { body: "Hi from a moderator" } })).status === 201);
  const orgAfter = (await req("GET", `/api/e/${slug}/organiser`, { cookie: alexCookie })).json;
  check("recipient's count excludes removed gifts and the thread shows the moderator's message", orgAfter.giftCount === 1 && orgAfter.thread[0].role === "moderator");

  console.log("\n7. Notices and email");
  const notice = await req("POST", `/api/e/${slug}/notices`, { cookie: samCookie, body: { body: "Parking is behind the hall." } });
  await new Promise((r) => setTimeout(r, 50));
  const ob = (await req("GET", `/api/e/${slug}/organiser`, { cookie: samCookie })).json.outbox;
  check("notice is stored and queued to every guest with an email (no mailer -> outbox)", notice.status === 201 && ob.filter((m) => m.subject.startsWith("A notice")).length === 2 && ob.every((m) => m.status === "no-mailer"));
  check("guests see the notice at the top of the list", (await req("GET", `/api/e/${slug}/list`, { cookie: riley })).json.notices[0].body === "Parking is behind the hall.");
  check("invitation emails were written for guests with addresses only", ob.filter((m) => m.subject.startsWith("Your code")).length === 2);

  console.log("\n8. Brute force");
  let last;
  for (let i = 0; i < 12; i++) last = await enter("AAAA-AAAA", { headers: { "X-Forwarded-For": "203.0.113.9" } });
  check("11th+ wrong attempt from one IP -> 429", last.status === 429);
  check("a different IP is not affected", (await enter(codes.Priya, { headers: { "X-Forwarded-For": "203.0.113.10" } })).status === 200);

  server.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
