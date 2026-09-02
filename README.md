# Reverse Registry

Guests post what they're bringing so nobody doubles up. The people receiving the gifts can't see the list.

## Run it

```
npm install
npm start          # http://localhost:3000
npm test           # 56-check proof that the lockout is server-side
```

Node 22+ (uses the built-in `node:sqlite`; no native build). Environment variables:

| Variable | What |
|---|---|
| `SESSION_SECRET` | Required in production. Without it a random one is made per process, so a restart logs everyone out. |
| `BASE_URL` | Public URL used in emails and on the codes page, e.g. `https://registry.example.com`. |
| `RESEND_API_KEY` | Sends codes and notices through Resend. Without it, every email is written to the outbox on the organiser page instead. |
| `MAIL_FROM` | From address, e.g. `Reverse Registry <noreply@yourdomain>`. Resend needs a verified domain. |
| `DB_PATH` | SQLite file. Defaults to `data/registry.db`. |
| `PORT` | Defaults to 3000. |

## How it works

**The code is the identity.** Setting up an event generates one code per person from the guest list. There are no name fields anywhere: a gift is "from Jamie" because Jamie's code posted it, or because someone picked Jamie from the guest list when posting on her behalf.

Three kinds of code, all entered in the same box:

- **Guest code** → categories and suggested minimum, then the list. Post, join open gifts, ask and answer questions.
- **Recipient code** → the organiser page: gift count (never the gifts), who has joined, make-moderator buttons, notice box, private thread, everyone's codes, the email outbox. Pointed at the list, it gets the blocked page.
- **Organiser code** → same page as a recipient, for the case where the person setting up isn't receiving gifts. If you are a recipient, ignore it and use your recipient code.

**Moderation.** The recipients promote two joined guests. A moderator proposes removing a gift with a reason; the other agrees; the gift stays on the list struck through with the reason. Guests never see who the moderators are or that a removal is pending. Moderators can read and write the private thread.

**Email.** One-way. Codes go out at setup, notices go out when posted. No Reply-To. Everything is logged to the outbox.

## How the lockout holds

The browser never decides anything. The whole rule is `requireRole` in `src/auth.js`, sitting in front of every data route in `src/server.js`.

1. Every page under `/e/<slug>/…` is the same static shell. No gifts, no codes, no categories in it.
2. `POST /api/enter` looks the code up. A match sets an HttpOnly cookie holding an HMAC-signed token bound to that person id and event id. Page JavaScript can't read it and can't forge it.
3. Every data route verifies the signature, expiry, person, event, and **role**. A recipient's session asking for the list gets `403 {blocked:true}` with nothing else in the body. A guest's session asking for the organiser page gets 403. Anything else gets 401.
4. Code guessing is throttled: 10 misses per IP per 15 minutes, then 429. Codes are 8 characters from a 31-letter alphabet (~850 billion), so guessing isn't a route in.

Delete `public/app.js` and the gifts are exactly as unreachable.

Codes are stored in plain text on purpose: the organiser page has to display them so they can be pasted into invitations, and hashing would add nothing, since anyone with the database already has the gifts.

## What the proof checks (`npm test`)

A real server on a throwaway database, an event set up the way the wizard does it, a canary gift posted by a guest, then:

- every page and public endpoint is free of gifts and codes before any code is entered
- no cookie → 401 on list, post, and organiser page
- recipient code accepted and routed to the organiser page; recipient session on list/post/join → 403 blocked, canary absent; their page shows a count of 1 and no gift; organiser code equally blocked
- unknown code, empty code, made-up cookie, wrong-secret signature, edited expiry, person-id swapped from a recipient's own cookie, expired token, cookie from another event, code entered on the wrong event's page → all refused
- guest session cannot reach the organiser page, make moderators, post notices, read the thread, or vote
- proxy post is recorded as Aunt Jean's, posted by Riley; the giver must be a guest on the list
- joins work only on open gifts; questions are public and any guest can reply
- moderator flow: can't promote someone who hasn't joined; max two; one vote doesn't remove; the same moderator twice doesn't remove; two moderators do, with the first reason kept; guests see no moderator identity or pending votes; count on the recipient page excludes removed gifts
- notices reach every guest with an email via the outbox; invitations were written only for guests with addresses
- 11th wrong code from one IP → 429; other IPs unaffected

`test/screens-phone.png` and `test/screens-desktop.png` are the same flow driven in a headless browser.

## Layout

```
src/auth.js      codes, session tokens, role gate, rate limit   (read this one)
src/server.js    all routes
src/db.js        schema
src/mailer.js    outbox + Resend
public/app.css   THEME block at the top: every colour, font and radius. Occasion themes later go here as [data-occasion="…"] overrides.
public/index.html  landing + code entry
public/new.html + wizard.js   4-step setup, back button on every step, codes at the end
public/event.html + app.js    code · hoping for · list · post · thread · organiser page · blocked
test/lockout.test.js
```

## Design

Direction from linear.app / stripe.com / notion.com: near-white ground, one column, Inter with tight tracking, a single indigo accent for primary actions only, hairline borders and one soft shadow. Nothing occasion-specific in the styling; occasion only changes wording (the `COPY` map at the top of `app.js`).

## Not built (on purpose)

Payments, retailer integrations, external sign-in, guest logins, live chat, shipping addresses, thank-you tracking, RSVP, occasion themes (hook is in place, nothing uses it yet).

## Open questions for Ethan

- Un-joining a gift and demoting a moderator aren't in the spec, so there's no undo for either. Say the word if you want them.
- The organiser code exists so a non-recipient can set things up. If every event's organiser will be a recipient, it can go.
