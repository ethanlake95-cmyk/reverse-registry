const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { open } = require("./db");
const auth = require("./auth");
const { makeMailer } = require("./mailer");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OCCASIONS = ["Wedding", "Birthday", "Baby shower", "Anniversary", "Engagement", "Retirement", "Housewarming", "Christmas", "Other"];
const SUGGESTED = ["No suggestion", "Under $50", "$50 to $75", "$75 to $100", "$100 to $150", "$150 and up"];

function createApp(db = open()) {
  const app = express();
  const mailer = makeMailer(db);
  app.disable("x-powered-by");
  app.set("trust proxy", true);
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
    peopleByRole: db.prepare("SELECT id, name, email, role, code, is_moderator, joined_at FROM people WHERE event_id = ? AND role = ? ORDER BY name"),
    peopleAll: db.prepare("SELECT id, name, email, role, code, is_moderator, joined_at FROM people WHERE event_id = ? ORDER BY role, name"),
    personByCode: db.prepare("SELECT * FROM people WHERE code = ?"),
    personById: db.prepare("SELECT * FROM people WHERE id = ? AND event_id = ?"),
    markJoined: db.prepare("UPDATE people SET joined_at = COALESCE(joined_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?"),
    joined: db.prepare("SELECT id, name, is_moderator, joined_at FROM people WHERE event_id = ? AND role = 'guest' AND joined_at IS NOT NULL ORDER BY joined_at"),
    moderatorCount: db.prepare("SELECT COUNT(*) AS n FROM people WHERE event_id = ? AND is_moderator = 1"),
    moderators: db.prepare("SELECT id FROM people WHERE event_id = ? AND is_moderator = 1"),
    setModerator: db.prepare("UPDATE people SET is_moderator = 1 WHERE id = ? AND event_id = ? AND role = 'guest' AND joined_at IS NOT NULL"),

    insertEvent: db.prepare("INSERT INTO events (slug, occasion, title, date, suggested_min) VALUES (?,?,?,?,?)"),
    insertCategory: db.prepare("INSERT INTO categories (event_id, name, position) VALUES (?,?,?)"),
    insertPerson: db.prepare("INSERT INTO people (event_id, name, email, role, code) VALUES (?,?,?,?,?)"),

    giftCount: db.prepare("SELECT COUNT(*) AS n FROM gifts WHERE event_id = ? AND removed_at IS NULL"),
    gifts: db.prepare(`
      SELECT g.id, g.item, g.link, g.open_to_join, g.removed_at, g.removed_reason, g.created_at,
             g.giver_id, g.poster_id, c.name AS category,
             giver.name AS giver_name, poster.name AS poster_name
      FROM gifts g
      LEFT JOIN categories c ON c.id = g.category_id
      JOIN people giver ON giver.id = g.giver_id
      JOIN people poster ON poster.id = g.poster_id
      WHERE g.event_id = ? ORDER BY g.created_at DESC, g.id DESC`),
    giftById: db.prepare("SELECT * FROM gifts WHERE id = ? AND event_id = ?"),
    insertGift: db.prepare("INSERT INTO gifts (event_id, giver_id, poster_id, category_id, item, link, open_to_join) VALUES (?,?,?,?,?,?,?)"),
    joinsForEvent: db.prepare("SELECT j.gift_id, j.person_id, p.name FROM gift_joins j JOIN people p ON p.id = j.person_id JOIN gifts g ON g.id = j.gift_id WHERE g.event_id = ? ORDER BY j.created_at"),
    insertJoin: db.prepare("INSERT OR IGNORE INTO gift_joins (gift_id, person_id) VALUES (?,?)"),
    votesForEvent: db.prepare("SELECT v.gift_id, v.person_id, v.reason, v.created_at FROM removal_votes v JOIN gifts g ON g.id = v.gift_id WHERE g.event_id = ? ORDER BY v.created_at"),
    votesForGift: db.prepare("SELECT person_id, reason FROM removal_votes WHERE gift_id = ? ORDER BY created_at"),
    insertVote: db.prepare("INSERT OR IGNORE INTO removal_votes (gift_id, person_id, reason) VALUES (?,?,?)"),
    removeGift: db.prepare("UPDATE gifts SET removed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), removed_reason = ? WHERE id = ?"),

    questions: db.prepare("SELECT q.id, q.body, q.created_at, p.name AS asker FROM questions q JOIN people p ON p.id = q.person_id WHERE q.event_id = ? ORDER BY q.created_at DESC"),
    questionById: db.prepare("SELECT id FROM questions WHERE id = ? AND event_id = ?"),
    replies: db.prepare("SELECT r.id, r.question_id, r.body, r.created_at, p.name AS author FROM question_replies r JOIN questions q ON q.id = r.question_id JOIN people p ON p.id = r.person_id WHERE q.event_id = ? ORDER BY r.created_at"),
    insertQuestion: db.prepare("INSERT INTO questions (event_id, person_id, body) VALUES (?,?,?)"),
    insertReply: db.prepare("INSERT INTO question_replies (question_id, person_id, body) VALUES (?,?,?)"),

    notices: db.prepare("SELECT id, body, created_at FROM notices WHERE event_id = ? ORDER BY created_at DESC"),
    insertNotice: db.prepare("INSERT INTO notices (event_id, person_id, body) VALUES (?,?,?)"),
    thread: db.prepare("SELECT t.id, t.body, t.created_at, t.person_id, p.name, p.role, p.is_moderator FROM thread_messages t JOIN people p ON p.id = t.person_id WHERE t.event_id = ? ORDER BY t.created_at"),
    insertThread: db.prepare("INSERT INTO thread_messages (event_id, person_id, body) VALUES (?,?,?)"),
    outbox: db.prepare("SELECT id, to_email, subject, body, status, detail, created_at FROM outbox WHERE event_id = ? ORDER BY created_at DESC LIMIT 200"),
  };

  // The session cookie names a person + event. Confirm both exist and match the URL's event.
  const lookup = (personId, eventId, slug) => {
    const event = q.eventBySlug.get(slug);
    if (!event || event.id !== eventId) return null;
    const person = q.personById.get(personId, eventId);
    if (!person) return null;
    person.event = event;
    return person;
  };
  const guestOnly = auth.requireRole(lookup, ["guest"]);
  const organiserOnly = auth.requireRole(lookup, ["recipient", "organiser"]);
  const anyRole = auth.requireRole(lookup, ["guest", "recipient", "organiser"]);
  const threadMember = [anyRole, (req, res, next) => {
    if (req.person.role === "guest" && !req.person.is_moderator) return res.status(403).json({ error: "not your page" });
    next();
  }];

  const publicEvent = (e) => ({
    slug: e.slug, occasion: e.occasion, title: e.title, date: e.date,
    recipients: q.peopleByRole.all(e.id, "recipient").map((p) => p.name),
  });
  const fullEvent = (e) => ({ ...publicEvent(e), suggestedMin: e.suggested_min, categories: q.categories.all(e.id) });

  // ---------- setup wizard ----------
  app.get("/api/options", (req, res) => res.json({ occasions: OCCASIONS, suggested: SUGGESTED }));

  app.post("/api/events", async (req, res) => {
    const b = req.body || {};
    const occasion = OCCASIONS.includes(b.occasion) ? b.occasion : "Other";
    const title = str(b.title, 120);
    const date = b.date ? str(b.date, 20) : null;
    const suggestedMin = SUGGESTED.includes(b.suggestedMin) ? b.suggestedMin : "No suggestion";
    const recipients = (Array.isArray(b.recipients) ? b.recipients : []).map((r) => str(r, 80)).filter(Boolean);
    const categories = [...new Set((Array.isArray(b.categories) ? b.categories : []).map((c) => str(c, 60)).filter(Boolean))];
    const guests = (Array.isArray(b.guests) ? b.guests : [])
      .map((g) => ({ name: str(g?.name, 80), email: str(g?.email, 200).toLowerCase() }))
      .filter((g) => g.name);
    if (!title) return res.status(400).json({ error: "give it a title" });
    if (recipients.length === 0) return res.status(400).json({ error: "name at least one person receiving the gifts" });
    if (guests.length === 0) return res.status(400).json({ error: "add at least one guest" });
    for (const g of guests) if (g.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g.email)) return res.status(400).json({ error: `that email doesn't look right: ${g.email}` });

    const slug = crypto.randomBytes(6).toString("base64url");
    const made = { recipients: [], organiser: null, guests: [] };
    db.exec("BEGIN");
    try {
      const { lastInsertRowid: eventId } = q.insertEvent.run(slug, occasion, title, date, suggestedMin);
      categories.forEach((c, i) => q.insertCategory.run(eventId, c, i));
      const add = (name, email, role) => {
        const code = auth.generateCode();
        q.insertPerson.run(eventId, name, email, role, code);
        return { name, email, role, code: auth.formatCode(code) };
      };
      for (const r of recipients) made.recipients.push(add(r, "", "recipient"));
      made.organiser = add("Organiser", "", "organiser");
      for (const g of guests) made.guests.push(add(g.name, g.email, "guest"));
      db.exec("COMMIT");
      made.eventId = eventId;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    // Invitations go out in the background; the organiser page shows the outbox either way.
    for (const g of made.guests) {
      mailer.send({
        eventId: made.eventId, to: g.email,
        subject: `Your code for ${title}`,
        body: `Hi ${g.name},\n\nYou're invited to post what you're bringing to ${title}.\n\nYour code: ${g.code}\n\nGo to ${BASE_URL} and enter it. The code is how the site knows it's you, so keep it to yourself.\n\nThis is a one-way email; replies aren't read.`,
      }).catch(() => {});
    }

    res.status(201).json({ slug, url: `${BASE_URL}/e/${slug}`, recipients: made.recipients, organiserCode: made.organiser.code, guests: made.guests, mailerConfigured: mailer.configured });
  });

  // ---------- public metadata (never gifts, never categories) ----------
  app.get("/api/e/:slug", (req, res) => {
    const e = q.eventBySlug.get(req.params.slug);
    if (!e) return res.status(404).json({ error: "no such event" });
    res.json(publicEvent(e));
  });

  // ---------- the gate ----------
  app.post("/api/enter", (req, res) => {
    const rlKey = auth.clientIp(req);
    const rl = auth.checkRateLimit(rlKey);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({ error: "too many attempts. Try again in a few minutes." });
    }
    const code = auth.cleanCode(req.body?.code);
    const person = code.length === 8 ? q.personByCode.get(code) : null;
    if (!person) return res.status(401).json({ error: "that code isn't on the list" });
    const event = q.eventById.get(person.event_id);
    // If a slug was given, the code must belong to that event.
    if (req.body?.slug && req.body.slug !== event.slug) return res.status(401).json({ error: "that code is for a different event" });
    auth.resetRateLimit(rlKey);
    q.markJoined.run(person.id);
    auth.setSessionCookie(res, req, person.id, event.id);
    res.json({ ok: true, role: person.role, slug: event.slug, name: person.name });
  });

  app.post("/api/leave", (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

  // Who am I (for page routing). Never returns gifts.
  app.get("/api/e/:slug/me", anyRole, (req, res) => {
    const p = req.person;
    res.json({ id: p.id, name: p.name, role: p.role, isModerator: !!p.is_moderator, event: publicEvent(p.event) });
  });

  // ---------- guests only: the list ----------
  function listPayload(person) {
    const e = person.event;
    const joins = q.joinsForEvent.all(e.id);
    const votes = person.is_moderator ? q.votesForEvent.all(e.id) : [];
    const gifts = q.gifts.all(e.id).map((g) => {
      const js = joins.filter((j) => j.gift_id === g.id);
      const out = {
        id: g.id, item: g.item, link: g.link, category: g.category, openToJoin: !!g.open_to_join, createdAt: g.created_at,
        giverName: g.giver_name, posterName: g.poster_name, proxy: g.giver_id !== g.poster_id,
        mine: g.poster_id === person.id || g.giver_id === person.id,
        removed: !!g.removed_at, removedReason: g.removed_reason,
        joinedBy: js.map((j) => j.name), youJoined: js.some((j) => j.person_id === person.id),
      };
      if (person.is_moderator && !g.removed_at) {
        const v = votes.filter((x) => x.gift_id === g.id);
        out.removal = { proposed: v.length > 0, reason: v[0]?.reason || "", youVoted: v.some((x) => x.person_id === person.id) };
      }
      return out;
    });
    const replies = q.replies.all(e.id);
    const questions = q.questions.all(e.id).map((qu) => ({ ...qu, replies: replies.filter((r) => r.question_id === qu.id) }));
    return {
      me: { id: person.id, name: person.name, isModerator: !!person.is_moderator },
      event: fullEvent(e),
      notices: q.notices.all(e.id),
      gifts,
      questions,
      guests: q.peopleByRole.all(e.id, "guest").filter((p) => p.id !== person.id).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  app.get("/api/e/:slug/list", guestOnly, (req, res) => res.json(listPayload(req.person)));

  app.post("/api/e/:slug/gifts", guestOnly, (req, res) => {
    const e = req.person.event;
    const item = str(req.body.item, 200);
    if (!item) return res.status(400).json({ error: "say what it is" });
    let categoryId = num(req.body.categoryId);
    if (categoryId !== null && !q.categoryById.get(categoryId, e.id)) categoryId = null;
    let link = str(req.body.link, 500);
    if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
    let giverId = req.person.id;
    if (req.body.giverId) {
      const giver = q.personById.get(num(req.body.giverId), e.id);
      if (!giver || giver.role !== "guest") return res.status(400).json({ error: "pick someone from the guest list" });
      giverId = giver.id;
    }
    q.insertGift.run(e.id, giverId, req.person.id, categoryId, item, link, req.body.openToJoin ? 1 : 0);
    res.status(201).json(listPayload(req.person));
  });

  app.post("/api/e/:slug/gifts/:id/join", guestOnly, (req, res) => {
    const g = q.giftById.get(num(req.params.id), req.person.event.id);
    if (!g || g.removed_at) return res.status(404).json({ error: "no such gift" });
    if (!g.open_to_join) return res.status(400).json({ error: "this gift isn't open to join" });
    q.insertJoin.run(g.id, req.person.id);
    res.json(listPayload(req.person));
  });

  // Moderators: a removal needs two different moderators to agree.
  app.post("/api/e/:slug/gifts/:id/remove-vote", guestOnly, (req, res) => {
    if (!req.person.is_moderator) return res.status(403).json({ error: "moderators only" });
    const g = q.giftById.get(num(req.params.id), req.person.event.id);
    if (!g || g.removed_at) return res.status(404).json({ error: "no such gift" });
    const existing = q.votesForGift.all(g.id);
    const reason = str(req.body.reason, 300) || existing[0]?.reason || "";
    if (!reason) return res.status(400).json({ error: "give a reason" });
    q.insertVote.run(g.id, req.person.id, reason);
    const votes = q.votesForGift.all(g.id);
    if (new Set(votes.map((v) => v.person_id)).size >= 2) q.removeGift.run(votes[0].reason, g.id);
    res.json(listPayload(req.person));
  });

  app.post("/api/e/:slug/questions", guestOnly, (req, res) => {
    const body = str(req.body.body, 500);
    if (!body) return res.status(400).json({ error: "type a question" });
    q.insertQuestion.run(req.person.event.id, req.person.id, body);
    res.status(201).json(listPayload(req.person));
  });

  app.post("/api/e/:slug/questions/:id/replies", guestOnly, (req, res) => {
    const qu = q.questionById.get(num(req.params.id), req.person.event.id);
    if (!qu) return res.status(404).json({ error: "no such question" });
    const body = str(req.body.body, 500);
    if (!body) return res.status(400).json({ error: "type a reply" });
    q.insertReply.run(qu.id, req.person.id, body);
    res.status(201).json(listPayload(req.person));
  });

  // ---------- recipients / organiser: their page. Never a gift. ----------
  function organiserPayload(person) {
    const e = person.event;
    return {
      me: { id: person.id, name: person.name, role: person.role },
      event: fullEvent(e),
      giftCount: q.giftCount.get(e.id).n,
      joined: q.joined.all(e.id).map((p) => ({ id: p.id, name: p.name, isModerator: !!p.is_moderator, joinedAt: p.joined_at })),
      moderatorCount: q.moderatorCount.get(e.id).n,
      people: q.peopleAll.all(e.id).map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role, code: auth.formatCode(p.code), joined: !!p.joined_at })),
      notices: q.notices.all(e.id),
      thread: q.thread.all(e.id).map(threadMsg),
      outbox: q.outbox.all(e.id),
      mailerConfigured: mailer.configured,
      url: `${BASE_URL}/e/${e.slug}`,
    };
  }
  const threadMsg = (m) => ({ id: m.id, body: m.body, createdAt: m.created_at, personId: m.person_id, name: m.name, role: m.is_moderator ? "moderator" : m.role });

  app.get("/api/e/:slug/organiser", organiserOnly, (req, res) => res.json(organiserPayload(req.person)));

  app.post("/api/e/:slug/moderators", organiserOnly, (req, res) => {
    const e = req.person.event;
    if (q.moderatorCount.get(e.id).n >= 2) return res.status(400).json({ error: "there are already two moderators" });
    const r = q.setModerator.run(num(req.body.personId), e.id);
    if (r.changes === 0) return res.status(400).json({ error: "pick someone who has joined" });
    res.json(organiserPayload(req.person));
  });

  app.post("/api/e/:slug/notices", organiserOnly, async (req, res) => {
    const e = req.person.event;
    const body = str(req.body.body, 2000);
    if (!body) return res.status(400).json({ error: "type a notice" });
    q.insertNotice.run(e.id, req.person.id, body);
    const guests = q.peopleByRole.all(e.id, "guest").filter((g) => g.email);
    for (const g of guests) {
      mailer.send({ eventId: e.id, to: g.email, subject: `A notice about ${e.title}`, body: `${body}\n\n—\nPosted on the gift list for ${e.title}. This is a one-way email; replies aren't read.` }).catch(() => {});
    }
    res.status(201).json(organiserPayload(req.person));
  });

  app.get("/api/e/:slug/thread", ...threadMember, (req, res) => res.json({ me: { id: req.person.id }, thread: q.thread.all(req.person.event.id).map(threadMsg) }));

  app.post("/api/e/:slug/thread", ...threadMember, (req, res) => {
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
  createApp().listen(port, () => console.log(`Reverse Registry on http://localhost:${port}`));
}

module.exports = { createApp };
