// A complete test-run event with fixed codes, created at startup when
// DEMO_SEED=1. On a host with no persistent disk it comes back after every
// restart, so a walkthrough always has something to walk through.
//
// Remove the DEMO_SEED setting before the real event is created.

const SLUG = "test-run";

// Codes use the app's alphabet (no O, I, L, 0, 1).
const PEOPLE = [
  ["Andrea Nunez", "recipient", "ANDREA26", true],
  ["Ethan Lake", "recipient", "ETHAN226", true],
  ["Dana Levitt", "moderator", "DANAM2D2", true],
  ["Nadia Fournier", "moderator", "NADAM3D3", true],
  ["Jamie Okonkwo", "guest", "GUEST2AB", true],
  ["Priya Raman", "guest", "GUEST2CD", true],
  ["Marcus Hale", "guest", "GUEST2JK", true],
  ["Tom & Sue Brennan", "guest", "GUEST2GH", true],
  ["Ray Whitfield", "guest", "GUEST2EF", false],
];

function seedDemo(db) {
  // Reset the demo to pristine on every boot, so nothing a tester does to it
  // sticks. Only ever touches the demo slug; real events are never affected.
  // (ON DELETE CASCADE clears the demo's gifts, people, flags, lookups, etc.)
  const existing = db.prepare("SELECT id FROM events WHERE slug = ?").get(SLUG);
  if (existing) db.prepare("DELETE FROM events WHERE id = ?").run(existing.id);
  db.exec("BEGIN");
  try {
    const { lastInsertRowid: eventId } = db
      .prepare("INSERT INTO events (slug, occasion, title, date, timezone, suggested_min) VALUES (?,?,?,?,?,?)")
      .run(SLUG, "Wedding", "Test run: Ethan and Andrea's wedding", "2026-11-21", "America/New_York", "$75 to $100");
    const cat = {};
    ["Kitchen", "Outdoor cooking", "Home and decor", "Experiences"].forEach((name, i) => {
      cat[name] = db.prepare("INSERT INTO categories (event_id, name, position) VALUES (?,?,?)").run(eventId, name, i).lastInsertRowid;
    });
    const id = {};
    for (const [name, role, code, joined] of PEOPLE) {
      id[name] = db.prepare("INSERT INTO people (event_id, name, role, code, joined_at) VALUES (?,?,?,?,?)")
        .run(eventId, name, role, code, joined ? new Date(Date.now() - 86400000 * 2).toISOString() : null).lastInsertRowid;
    }
    const gift = (giver, poster, category, item, open = 0) =>
      db.prepare("INSERT INTO gifts (event_id, giver_id, poster_id, category_id, item, open_to_join) VALUES (?,?,?,?,?,?)")
        .run(eventId, id[giver], id[poster], category ? cat[category] : null, item, open).lastInsertRowid;
    const mixer = gift("Priya Raman", "Priya Raman", "Kitchen", "KitchenAid stand mixer, cream", 1);
    const skillet = gift("Jamie Okonkwo", "Jamie Okonkwo", "Kitchen", "Cast-iron skillet set");
    gift("Tom & Sue Brennan", "Tom & Sue Brennan", "Home and decor", "Garden bench for the back terrace");
    const lodge = gift("Jamie Okonkwo", "Jamie Okonkwo", "Experiences", "Two nights at the Lodge", 1);
    gift("Jamie Okonkwo", "Dana Levitt", null, "Espresso grinder"); // posted in Jamie's name by Dana
    db.prepare("INSERT INTO gift_joins (gift_id, person_id) VALUES (?,?)").run(mixer, id["Marcus Hale"]);
    db.prepare("INSERT INTO gift_joins (gift_id, person_id) VALUES (?,?)").run(lodge, id["Nadia Fournier"]);
    db.prepare("INSERT INTO flags (gift_id, person_id, note) VALUES (?,?,?)").run(skillet, id["Dana Levitt"], "Andrea's parents are already bringing this one.");
    db.prepare("INSERT INTO notices (event_id, person_id, body) VALUES (?,?,?)").run(eventId, id["Andrea Nunez"], "Parking is behind the hall, not on the street.");
    db.prepare("INSERT INTO thread_messages (event_id, person_id, body) VALUES (?,?,?)").run(eventId, id["Dana Levitt"], "Flagged the skillet. Your parents mentioned they're bringing one.");
    const q = db.prepare("INSERT INTO questions (event_id, person_id, body) VALUES (?,?,?)").run(eventId, id["Priya Raman"], "Is anyone organising a card for everyone to sign?").lastInsertRowid;
    db.prepare("INSERT INTO question_replies (question_id, person_id, body) VALUES (?,?,?)").run(q, id["Marcus Hale"], "I'll bring one.");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return true;
}

module.exports = { seedDemo, SLUG, PEOPLE };
