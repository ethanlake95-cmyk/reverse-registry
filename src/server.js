const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { open } = require("./db");
const auth = require("./auth");
const time = require("./time");
const { seedDemo } = require("./seed");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OCCASIONS = ["Wedding", "Birthday", "Baby shower", "Anniversary", "Engagement", "Retirement", "Housewarming", "Christmas", "Other"];
const SUGGESTED = ["No suggestion", "Under $50", "$50 to $75", "$75 to $100", "$100 to $150", "$150 and up"];
const TIMEZONES = [
  { id: "America/New_York", label: "America/New_York — Eastern" },
  { id: "America/Chicago", label: "America/Chicago — Central" },
  { id: "America/Denver", label: "America/Denver — Mountain" },
  { id: "America/Los_Angeles", label: "America/Los_Angeles — Pacific" },
];

function createApp(db = open()) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // exactly one hop (Render's edge); req.ip is what that hop saw
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  const str = (v, max) => String(v ?? "").trim().slice(0, max);
  const num = (v) => (Number.isInteger(Number(v)) ? Number(v) : null);

  // ---------- queries ----------
  const q = {
    eventBySlug: db.prepare("SELECT * FROM events WHERE slug = ?"),
    eventById: db.prepare("SELECT * FROM events WHERE id = ?"),
    categories: db.prepare("SELECT id, name FROM categories WHERE event_id = ? ORDER BY position"),
    categoryById: db.prepare("SELECT id FROM categories WHERE id = ? AND event_id = ?"),
    people: db.prepare("SELECT id, name, role, joined_at FROM people WHERE event_id = ? ORDER BY CASE role WHEN 'recipient' THEN 2 ELSE 1 END, name"),
    peopleByRole: db.prepare("SELECT id, name, role, joined_at FROM people WHERE event_id = ? AND role = ? ORDER BY name"),
    personByCode: db.prepare("SELECT * FROM people WHERE code = ?"),
    personById: db.prepare("SELECT * FROM people WHERE id = ? AND event_id = ?"),
    markJoined: db.prepare("UPDATE people SET joined_at = COALESCE(joined_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?"),
    setRole: db.prepare("UPDATE people SET role = ? WHERE id = ? AND event_id = ?"),

    insertEvent: db.prepare("INSERT INTO events (slug, occasion, title, date, timezone, suggested_min) VALUES (?,?,?,?,?,?)"),
    insertCategory: db.prepare("INSERT INTO categories (event_id, name, position) VALUES (?,?,?)"),
    insertPerson: db.prepare("INSERT INTO people (event_id, name, role, code) VALUES (?,?,?,?)"),

    gifts: db.prepare(`
      SELECT g.*, c.name AS category, giver.name AS giver_name, poster.name AS poster_name
      FROM gifts g LEFT JOIN categories c ON c.id = g.category_id
      JOIN people giver ON giver.id = g.giver_id JOIN people poster ON poster.id = g.poster_id
      WHERE g.event_id = ? ORDER BY g.created_at DESC, g.id DESC`),
    giftById: db.prepare("SELECT * FROM gifts WHERE id = ? AND event_id = ?"),
    insertGift: db.prepare("INSERT INTO gifts (event_id, giver_id, poster_id, category_id, item, link, open_to_join) VALUES (?,?,?,?,?,?,?)"),
    updateGift: db.prepare("UPDATE gifts SET item = ?, category_id = ?, link = ?, open_to_join = ? WHERE id = ?"),
    deleteGift: db.prepare("DELETE FROM gifts WHERE id = ?"),
    ackProxy: db.prepare("UPDATE gifts SET proxy_ack = 1 WHERE id = ?"),
    joins: db.prepare("SELECT j.gift_id, j.person_id, p.name FROM gift_joins j JOIN people p ON p.id = j.person_id JOIN gifts g ON g.id = j.gift_id WHERE g.event_id = ? ORDER BY j.created_at"),
    joinCount: db.prepare("SELECT COUNT(*) AS n FROM gift_joins WHERE gift_id = ?"),
    insertJoin: db.prepare("INSERT OR IGNORE INTO gift_joins (gift_id, person_id) VALUES (?,?)"),
    flags: db.prepare("SELECT f.gift_id, f.person_id, f.note FROM flags f JOIN gifts g ON g.id = f.gift_id WHERE g.event_id = ? ORDER BY f.created_at"),
    flagsForGift: db.prepare("SELECT person_id, note FROM flags WHERE gift_id = ? ORDER BY created_at"),
    insertFlag: db.prepare("INSERT OR IGNORE INTO flags (gift_id, person_id, note) VALUES (?,?,?)"),
    clearFlags: db.prepare("DELETE FROM flags WHERE gift_id = ?"),
    removeGift: db.prepare("UPDATE gifts SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), removed_reason = ? WHERE id = ?"),

    questions: db.prepare("SELECT q.id, q.body, q.created_at, p.name AS asker FROM questions q JOIN people p ON p.id = q.person_id WHERE q.event_id = ? ORDER BY q.created_at DESC"),
    questionById: db.prepare("SELECT id FROM questions WHERE id = ? AND event_id = ?"),
    replies: db.prepare("SELECT r.id, r.question_id, r.body, r.created_at, p.name AS author FROM question_replies r JOIN questions q ON q.id = r.question_id JOIN people p ON p.id = r.person_id WHERE q.event_id = ? ORDER BY r.created_at"),
    insertQuestion: db.prepare("INSERT INTO questions (event_id, person_id, body) VALUES (?,?,?)"),
    insertReply: db.prepare("INSERT INTO question_replies (question_id, person_id, body) VALUES (?,?,?)"),

    notices: db.prepare("SELECT id, body, created_at FROM notices WHERE event_id = ? ORDER BY created_at DESC"),
    insertNotice: db.prepare("INSERT INTO notices (event_id, person_id, body) VALUES (?,?,?)"),
    thread: db.prepare("SELECT t.id, t.body, t.created_at, t.person_id, p.name, p.role FROM thread_messages t JOIN people p ON p.id = t.person_id WHERE t.event_id = ? ORDER BY t.created_at"),
    insertThread: db.prepare("INSERT INTO thread_messages (event_id, person_id, body) VALUES (?,?,?)"),

    insertLookup: db.prepare("INSERT INTO lookups (event_id, person_id, requester_id) VALUES (?,?,?)"),
    lookups: db.prepare("SELECT l.created_at, p.name, r.name AS requester, r.id AS requester_id FROM lookups l JOIN people p ON p.id = l.person_id JOIN people r ON r.id = l.requester_id WHERE l.event_id = ? ORDER BY l.created_at DESC LIMIT 3"),
  };

  const lookup = (personId, eventId, slug) => {
    const event = q.eventBySlug.get(slug);
    if (!event || event.id !== eventId) return null;
    const person = q.personById.get(personId, eventId);
    if (!person) return null;
    person.event = event;
    return person;
  };
  const listRoles = auth.requireRole(lookup, ["guest", "moderator"]);      // may post, join, edit their own
  const moderatorOnly = auth.requireRole(lookup, ["moderator"]);
  const recipientOnly = auth.requireRole(lookup, ["recipient"]);
  const organiserRoles = auth.requireRole(lookup, ["recipient", "moderator"]);
  const anyRole = auth.requireRole(lookup, ["guest", "moderator", "recipient"]);

  const publicEvent = (e) => ({
    slug: e.slug, occasion: e.occasion, title: e.title, date: e.date, timezone: e.timezone,
    recipients: q.peopleByRole.all(e.id, "recipient").map((p) => p.name),
    unlockText: time.describeUnlock(e.date, e.timezone),
    unlockAt: time.unlockAt(e.date, e.timezone).toISOString(),
  });
  const fullEvent = (e) => ({ ...publicEvent(e), suggestedMin: e.suggested_min, categories: q.categories.all(e.id) });

  // ---------- setup ----------
  app.get("/api/options", (req, res) => res.json({ occasions: OCCASIONS, suggested: SUGGESTED, timezones: TIMEZONES, unlockHour: time.UNLOCK_HOUR }));

  // Preview of the unlock line for the wizard, computed server-side from the two fields.
  app.get("/api/unlock-preview", (req, res) => {
    const { date, timezone } = req.query;
    if (!time.isValidDate(date) || !time.isValidZone(timezone)) return res.status(400).json({ error: "bad date or timezone" });
    res.json({ text: time.describeUnlock(date, timezone) });
  });

  app.post("/api/events", (req, res) => {
    try {
      const b = req.body || {};
      const occasion = OCCASIONS.includes(b.occasion) ? b.occasion : "Other";
      const title = str(b.title, 120);
      const date = str(b.date, 10);
      const timezone = str(b.timezone, 64);
      const suggestedMin = SUGGESTED.includes(b.suggestedMin) ? b.suggestedMin : "No suggestion";
      const recipients = (Array.isArray(b.recipients) ? b.recipients : []).map((r) => str(r, 80)).filter(Boolean);
      const categories = [...new Set((Array.isArray(b.categories) ? b.categories : []).map((c) => str(c, 60)).filter(Boolean))];
      const guests = (Array.isArray(b.guests) ? b.guests : []).map((g) => str(typeof g === "string" ? g : g?.name, 80)).filter(Boolean);
      if (!title) return res.status(400).json({ error: "give it a title" });
      if (!time.isValidDate(date)) return res.status(400).json({ error: "pick a real date" });
      if (!time.isValidZone(timezone)) return res.status(400).json({ error: "pick the venue's timezone" });
      if (recipients.length === 0) return res.status(400).json({ error: "name at least one person receiving the gifts" });
      if (guests.length === 0) return res.status(400).json({ error: "add at least one guest" });

      const slug = crypto.randomBytes(6).toString("base64url");
      const made = { recipients: [], guests: [] };
      db.exec("BEGIN");
      try {
        const { lastInsertRowid: eventId } = q.insertEvent.run(slug, occasion, title, date, timezone, suggestedMin);
        categories.forEach((c, i) => q.insertCategory.run(eventId, c, i));
        const add = (name, role) => {
          for (let attempt = 0; attempt < 5; attempt++) {
            const code = auth.generateCode();
            try { q.insertPerson.run(eventId, name, role, code); return { name, role, code: auth.formatCode(code) }; }
            catch (err) { if (!/UNIQUE/.test(String(err.message))) throw err; } // collision: try another code
          }
          throw new Error("could not allocate a unique code");
        };
        for (const r of recipients) made.recipients.push(add(r, "recipient"));
        for (const g of guests) made.guests.push(add(g, "guest"));
        db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }

      // The one and only time the full set of codes leaves the server.
      res.status(201).json({ slug, url: `${BASE_URL}/e/${slug}`, title, date, timezone, unlockText: time.describeUnlock(date, timezone), recipients: made.recipients, guests: made.guests });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "something went wrong creating the event. Nothing was saved; try again." });
    }
  });

  // ---------- public metadata (never gifts, never categories, never codes) ----------
  app.get("/api/e/:slug", (req, res) => {
    const e = q.eventBySlug.get(req.params.slug);
    if (!e) return res.status(404).json({ error: "no such event" });
    res.json(publicEvent(e));
  });

  // ---------- the gate ----------
  app.post("/api/enter", (req, res) => {
    const code = auth.cleanCode(req.body?.code);
    const rl = auth.checkAttempt(req, code);
    if (!rl.ok) { res.setHeader("Retry-After", String(rl.retryAfterSec)); return res.status(429).json({ error: rl.why }); }
    const person = code.length === 8 ? q.personByCode.get(code) : null;
    if (!person) return res.status(401).json({ error: "that code wasn't recognised. Check it against your invitation." });
    const event = q.eventById.get(person.event_id);
    if (req.body?.slug && req.body.slug !== event.slug) return res.status(401).json({ error: "that code is for a different event" });
    q.markJoined.run(person.id);
    auth.setSessionCookie(res, req, person.id, event.id);
    res.json({ ok: true, role: person.role, slug: event.slug, name: person.name });
  });

  app.post("/api/leave", (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

  app.get("/api/e/:slug/me", anyRole, (req, res) => {
    const p = req.person;
    res.json({ id: p.id, name: p.name, role: p.role, event: publicEvent(p.event), unlocked: time.isUnlocked(p.event) });
  });

  // ---------- the list ----------
  function listPayload(person) {
    const e = person.event;
    const joins = q.joins.all(e.id);
    const flags = q.flags.all(e.id);
    const isMod = person.role === "moderator";
    const gifts = q.gifts.all(e.id).map((g) => {
      const js = joins.filter((j) => j.gift_id === g.id);
      const fl = flags.filter((f) => f.gift_id === g.id);
      const mine = g.poster_id === person.id || g.giver_id === person.id;
      const out = {
        id: g.id, item: g.item, link: g.link, category: g.category, categoryId: g.category_id, openToJoin: !!g.open_to_join, createdAt: g.created_at,
        giverName: g.giver_name, posterName: g.poster_name, proxy: g.giver_id !== g.poster_id,
        mine, removed: !!g.removed_at,
        joinedBy: js.map((j) => j.name), youJoined: js.some((j) => j.person_id === person.id),
        canDelete: mine && !g.removed_at && js.length === 0,
      };
      // The poster (or the giver) sees the flag note. Nobody else does, and never who wrote it.
      if (mine && fl.length && !g.removed_at) out.flag = { note: fl[0].note };
      if (mine && g.removed_at) out.removedReason = g.removed_reason;
      // A gift posted in your name by someone else, not yet acknowledged.
      if (g.giver_id === person.id && g.giver_id !== g.poster_id && !g.proxy_ack && !g.removed_at) out.proxyPostedBy = g.poster_name;
      if (isMod && !g.removed_at) out.moderation = { flagged: fl.length > 0, youFlagged: fl.some((f) => f.person_id === person.id), note: fl[0]?.note || "" };
      return out;
    });
    const replies = q.replies.all(e.id);
    const questions = q.questions.all(e.id).map((qu) => ({ ...qu, replies: replies.filter((r) => r.question_id === qu.id) }));
    return {
      me: { id: person.id, name: person.name, role: person.role },
      event: fullEvent(e),
      notices: q.notices.all(e.id),
      gifts, questions,
      guests: q.people.all(e.id).filter((p) => p.role !== "recipient" && p.id !== person.id).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  // What a recipient sees after the unlock: gift and giver only. No flags, reasons, controls or moderators.
  function unlockedPayload(person) {
    const e = person.event;
    const joins = q.joins.all(e.id);
    return {
      me: { id: person.id, name: person.name, role: person.role },
      event: fullEvent(e),
      unlocked: true,
      gifts: q.gifts.all(e.id).filter((g) => !g.removed_at).map((g) => ({
        id: g.id, item: g.item, link: g.link, category: g.category, giverName: g.giver_name,
        joinedBy: joins.filter((j) => j.gift_id === g.id).map((j) => j.name),
      })),
    };
  }

  app.get("/api/e/:slug/list", anyRole, (req, res) => {
    if (req.person.role === "recipient") {
      if (!time.isUnlocked(req.person.event)) return res.status(403).json({ blocked: true, error: "this list is not for you", unlockText: time.describeUnlock(req.person.event.date, req.person.event.timezone) });
      return res.json(unlockedPayload(req.person));
    }
    res.json(listPayload(req.person));
  });

  function readGiftFields(req, e) {
    const item = str(req.body.item, 200);
    let categoryId = num(req.body.categoryId);
    if (categoryId !== null && !q.categoryById.get(categoryId, e.id)) categoryId = null;
    let link = str(req.body.link, 500);
    if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
    return { item, categoryId, link, open: req.body.openToJoin ? 1 : 0 };
  }

  app.post("/api/e/:slug/gifts", listRoles, (req, res) => {
    const e = req.person.event;
    const f = readGiftFields(req, e);
    if (!f.item) return res.status(400).json({ error: "say what it is" });
    let giverId = req.person.id;
    if (req.body.giverId) {
      const giver = q.personById.get(num(req.body.giverId), e.id);
      if (!giver || giver.role === "recipient") return res.status(400).json({ error: "pick someone from the guest list" });
      giverId = giver.id;
    }
    q.insertGift.run(e.id, giverId, req.person.id, f.categoryId, f.item, f.link, f.open);
    res.status(201).json(listPayload(req.person));
  });

  // Own gift: the poster, or the person it was posted for.
  function ownGift(req, res) {
    const g = q.giftById.get(num(req.params.id), req.person.event.id);
    if (!g || g.removed_at) { res.status(404).json({ error: "no such gift" }); return null; }
    if (g.poster_id !== req.person.id && g.giver_id !== req.person.id) { res.status(403).json({ error: "not your gift" }); return null; }
    return g;
  }

  app.patch("/api/e/:slug/gifts/:id", listRoles, (req, res) => {
    const g = ownGift(req, res); if (!g) return;
    const f = readGiftFields(req, req.person.event);
    if (!f.item) return res.status(400).json({ error: "say what it is" });
    q.updateGift.run(f.item, req.body.categoryId === undefined ? g.category_id : f.categoryId, req.body.link === undefined ? g.link : f.link, req.body.openToJoin === undefined ? g.open_to_join : f.open, g.id);
    q.clearFlags.run(g.id); // editing answers the flag
    res.json(listPayload(req.person));
  });

  app.delete("/api/e/:slug/gifts/:id", listRoles, (req, res) => {
    const g = ownGift(req, res); if (!g) return;
    if (q.joinCount.get(g.id).n > 0) return res.status(409).json({ error: "someone has joined this gift, so it can be edited but not taken down" });
    q.deleteGift.run(g.id);
    res.json(listPayload(req.person));
  });

  app.post("/api/e/:slug/gifts/:id/acknowledge", listRoles, (req, res) => {
    const g = q.giftById.get(num(req.params.id), req.person.event.id);
    if (!g || g.giver_id !== req.person.id) return res.status(404).json({ error: "no such gift" });
    q.ackProxy.run(g.id);
    res.json(listPayload(req.person));
  });

  app.post("/api/e/:slug/gifts/:id/join", listRoles, (req, res) => {
    const g = q.giftById.get(num(req.params.id), req.person.event.id);
    if (!g || g.removed_at) return res.status(404).json({ error: "no such gift" });
    if (!g.open_to_join) return res.status(400).json({ error: "this gift isn't open to join" });
    if (g.poster_id === req.person.id || g.giver_id === req.person.id) return res.status(400).json({ error: "that's your own gift" });
    q.insertJoin.run(g.id, req.person.id);
    res.json(listPayload(req.person));
  });

  // Moderators: the first flag shows the poster a banner. A second, different
  // moderator agreeing removes the gift. Flags never carry a name anywhere.
  app.post("/api/e/:slug/gifts/:id/flag", moderatorOnly, (req, res) => {
    const g = q.giftById.get(num(req.params.id), req.person.event.id);
    if (!g || g.removed_at) return res.status(404).json({ error: "no such gift" });
    const existing = q.flagsForGift.all(g.id);
    const note = str(req.body.note, 300) || existing[0]?.note || "";
    if (!note) return res.status(400).json({ error: "write a note for the poster" });
    q.insertFlag.run(g.id, req.person.id, note);
    const flags = q.flagsForGift.all(g.id);
    if (new Set(flags.map((f) => f.person_id)).size >= 2) q.removeGift.run(flags[0].note, g.id);
    res.json(listPayload(req.person));
  });

  app.post("/api/e/:slug/questions", listRoles, (req, res) => {
    const body = str(req.body.body, 500);
    if (!body) return res.status(400).json({ error: "type a question" });
    q.insertQuestion.run(req.person.event.id, req.person.id, body);
    res.status(201).json(listPayload(req.person));
  });

  app.post("/api/e/:slug/questions/:id/replies", listRoles, (req, res) => {
    const qu = q.questionById.get(num(req.params.id), req.person.event.id);
    if (!qu) return res.status(404).json({ error: "no such question" });
    const body = str(req.body.body, 500);
    if (!body) return res.status(400).json({ error: "type a reply" });
    q.insertReply.run(qu.id, req.person.id, body);
    res.status(201).json(listPayload(req.person));
  });

  // ---------- organiser page: recipients and moderators. Never a gift, never a code. ----------
  const threadMsg = (m) => ({ id: m.id, body: m.body, createdAt: m.created_at, personId: m.person_id, name: m.name, role: m.role });
  function organiserPayload(person) {
    const e = person.event;
    const people = q.people.all(e.id);
    const guests = people.filter((p) => p.role !== "recipient");
    return {
      me: { id: person.id, name: person.name, role: person.role },
      event: fullEvent(e),
      unlocked: time.isUnlocked(e),
      people: people.map((p) => ({ id: p.id, name: p.name, role: p.role, joinedAt: p.joined_at })),
      joinedCount: guests.filter((p) => p.joined_at).length,
      guestCount: guests.length,
      moderatorCount: guests.filter((p) => p.role === "moderator").length,
      notices: q.notices.all(e.id),
      thread: q.thread.all(e.id).map(threadMsg),
      lookups: q.lookups.all(e.id).map((l) => ({ name: l.name, requester: l.requester, requesterId: l.requester_id, at: l.created_at })),
      url: `${BASE_URL}/e/${e.slug}`,
    };
  }

  app.get("/api/e/:slug/organiser", organiserRoles, (req, res) => res.json(organiserPayload(req.person)));

  // Promote a joined guest to moderator, or demote a moderator. Recipients only.
  app.post("/api/e/:slug/people/:id/role", recipientOnly, (req, res) => {
    const e = req.person.event;
    const target = q.personById.get(num(req.params.id), e.id);
    if (!target || target.role === "recipient") return res.status(400).json({ error: "pick a guest" });
    const role = req.body.role;
    if (role === "moderator") {
      if (!target.joined_at) return res.status(400).json({ error: "they haven't joined yet" });
      q.setRole.run("moderator", target.id, e.id);
    } else if (role === "guest") {
      q.setRole.run("guest", target.id, e.id);
    } else return res.status(400).json({ error: "role must be moderator or guest" });
    res.json(organiserPayload(req.person));
  });

  // Reveal one guest's code. Recipients only. Every reveal is recorded with who asked.
  app.post("/api/e/:slug/people/:id/reveal", recipientOnly, (req, res) => {
    const e = req.person.event;
    const target = q.personById.get(num(req.params.id), e.id);
    if (!target || target.role === "recipient") return res.status(400).json({ error: "pick a guest" });
    q.insertLookup.run(e.id, target.id, req.person.id);
    res.json({ name: target.name, code: auth.formatCode(target.code), lookups: organiserPayload(req.person).lookups });
  });

  app.post("/api/e/:slug/notices", recipientOnly, (req, res) => {
    const body = str(req.body.body, 2000);
    if (!body) return res.status(400).json({ error: "type a notice" });
    q.insertNotice.run(req.person.event.id, req.person.id, body);
    res.status(201).json(organiserPayload(req.person));
  });

  app.get("/api/e/:slug/thread", organiserRoles, (req, res) => res.json({ me: { id: req.person.id }, thread: q.thread.all(req.person.event.id).map(threadMsg) }));
  app.post("/api/e/:slug/thread", organiserRoles, (req, res) => {
    const body = str(req.body.body, 2000);
    if (!body) return res.status(400).json({ error: "type a message" });
    q.insertThread.run(req.person.event.id, req.person.id, body);
    res.status(201).json({ me: { id: req.person.id }, thread: q.thread.all(req.person.event.id).map(threadMsg) });
  });

  // ---------- pages: static shells, no data ----------
  const pub = path.join(__dirname, "..", "public");
  app.get("/new", (req, res) => res.sendFile(path.join(pub, "new.html")));
  app.get(["/e/:slug", "/e/:slug/*"], (req, res) => res.sendFile(path.join(pub, "event.html")));
  app.use(express.static(pub, { extensions: ["html"] }));

  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "bad json" });
    console.error(err);
    res.status(500).json({ error: "server error" });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const db = open();
  if (process.env.DEMO_SEED === "1") { seedDemo(db); console.log("Demo event reset at /e/test-run"); }
  createApp(db).listen(port, () => console.log(`Reverse Registry on http://localhost:${port}`));
}

module.exports = { createApp };
