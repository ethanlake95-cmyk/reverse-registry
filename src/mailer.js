// Outgoing email. Every message is recorded in the outbox table first, then
// sent through Resend if RESEND_API_KEY is set. With no key, the message
// stays in the outbox with status "no-mailer" and the organiser page shows it
// so codes can be copied out by hand.
//
// All mail is one-way: From is a no-reply address and there is no Reply-To.

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "Reverse Registry <noreply@example.com>";

function makeMailer(db) {
  const insert = db.prepare("INSERT INTO outbox (event_id, to_email, subject, body, status, detail) VALUES (?,?,?,?,?,?)");
  const update = db.prepare("UPDATE outbox SET status = ?, detail = ? WHERE id = ?");

  async function send({ eventId, to, subject, body }) {
    if (!to) return;
    const status = RESEND_API_KEY ? "queued" : "no-mailer";
    const { lastInsertRowid: id } = insert.run(eventId, to, subject, body, status, "");
    if (!RESEND_API_KEY) return;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text: body }),
      });
      if (res.ok) update.run("sent", "", id);
      else update.run("failed", `${res.status} ${await res.text()}`, id);
    } catch (err) {
      update.run("failed", String(err.message || err), id);
    }
  }

  return { send, configured: Boolean(RESEND_API_KEY) };
}

module.exports = { makeMailer };
