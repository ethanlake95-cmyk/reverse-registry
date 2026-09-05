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
| `DB_PATH` | SQLite file. Defaults to `data/registry.db`. |
| `PORT` | Defaults to 3000. |

## How it works

**The code is the identity.** Setting up an event generates one code per person from the guest list. There are no name fields anywhere: a gift is "from Jamie" because Jamie's code posted it, or because someone picked Jamie from the guest list when posting on her behalf. Codes travel on paper invitations; nothing is emailed.

Three roles, all entered in the same box:

- **Guest** → categories and suggested minimum, then the list. Post, join open gifts, edit or take down your own gifts, ask and answer questions.
- **Moderator** → a guest the recipients promoted. Also gets the organiser page (roster and private thread) and can flag gifts.
- **Recipient** → the organiser page: who has joined, promote/demote moderators, look up one guest's lost code, notices, private thread. Never codes, never gifts, never a count. The list opens to recipients at **06:00 the morning after the event date, in the venue's timezone**, enforced on the server.

**Codes are shown once**, on the final setup screen, built to print. The organiser page never shows them. A recipient can reveal one guest's code at a time; every reveal is recorded with who asked and shown to recipients and moderators.

**Moderation.** A moderator flags a gift with a note. The poster sees a banner with the note, unsigned, and can edit (which clears the flag) or take the gift down. If a second moderator agrees, the gift comes off: struck through for guests with no reason shown, the reason visible only to the poster, absent from the recipients' post-unlock view. Guests never learn who the moderators are.

**Own gifts.** Poster (or the person a gift was posted for) can edit any time and delete until someone has joined. A gift posted in your name shows you a banner until you confirm or remove it.

**Freshness.** The list refetches every 15 s while the tab is visible and on `visibilitychange`; the post form warns on a close match with an existing gift.

## How the lockout holds

The browser never decides anything. The whole rule is `requireRole` in `src/auth.js`, sitting in front of every data route in `src/server.js`.

1. Every page under `/e/<slug>/…` is the same static shell. No gifts, no codes, no categories in it.
2. `POST /api/enter` looks the code up. A match sets an HttpOnly cookie holding an HMAC-signed token bound to that person id and event id. Page JavaScript can't read it and can't forge it.
3. Every data route verifies the signature, expiry, person, event, and **role**. A recipient's session asking for the list before the unlock gets `403 {blocked:true}` with only the unlock time in the body. A guest's session asking for the organiser page gets 403. Anything else gets 401.
4. Recipients never receive a code in any payload after setup, so there's no guest code to copy off their own page.
5. Code guessing is throttled per submitted code (25 per 15 min) with a looser per-IP cap (300), keyed on `req.ip` behind one trusted proxy hop. Codes are 8 characters from a 31-letter alphabet (~850 billion).

Delete `public/app.js` and the gifts are exactly as unreachable.

Codes are stored in plain text on purpose: the one-code lookup has to display them, and hashing would add nothing, since anyone with the database already has the gifts.

## What the proof checks (`npm test`)

56 checks against a real server: impossible dates and unknown zones rejected; unlock is 06:00 next day in the venue's zone; every page and public endpoint free of gifts and codes; recipient blocked from the list, cannot post/join/edit/flag, and gets a page with no codes, gifts or count; forged/edited/swapped/expired cookies and cross-event cookies refused; poster-only edit and delete, delete blocked once joined; proxy banner and acknowledge; promote (joined only), flag visible to poster only and unsigned, edit clears it, one moderator can't remove, two can, guests see no reason or name, poster sees the reason, demote; single-code reveal recorded and no code elsewhere; recipient sees the list after the unlock with no flags/reasons/controls, still locked on the event day; per-code throttle.

## Layout

```
src/auth.js      codes, session tokens, role gate, rate limit   (read this one)
src/server.js    all routes
src/db.js        schema
src/time.js      unlock time: 06:00 the morning after, in the venue's zone
public/app.css   THEME block at the top: every colour, font and radius. Occasion themes later go here as [data-occasion="…"] overrides.
public/index.html  landing + code entry
public/new.html + wizard.js   4-step setup, back button on every step, codes at the end
public/event.html + app.js    code · hoping for · list · post · thread · organiser page · blocked
test/lockout.test.js
```

## Design

Direction from linear.app / stripe.com / notion.com: near-white ground, one column, Inter with tight tracking, a single indigo accent for primary actions only, hairline borders and one soft shadow. Nothing occasion-specific in the styling; occasion only changes wording (the `COPY` map at the top of `app.js`).

## Not built (on purpose)

Payments, retailer integrations, external sign-in, guest logins, live chat, shipping addresses, thank-you tracking, RSVP, email of any kind, occasion themes (hook is in place), persistence across restarts and `SESSION_SECRET` enforcement (accepted for this run), multiple sessions per browser.
