// Event pages. This file never decides who may see gifts; it asks the API and
// renders whatever comes back (a list, a 401, or a 403 "blocked").
(() => {
  const slug = location.pathname.split("/")[2];
  const view = document.getElementById("view");
  const barRight = document.getElementById("bar-right");
  let me = null;      // { id, name, role, event, unlocked }
  let data = null;    // last list or organiser payload
  let lastJson = "";  // to skip re-rendering an unchanged list
  let editing = null; // gift id being edited inline, if any
  let pollTimer = null;

  // ---------- tiny DOM helper ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "hidden") el.hidden = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const mount = (...kids) => view.replaceChildren(...kids.flat().filter(Boolean));
  const btn = (label, cls, on, attrs = {}) => h("button", { class: `btn ${cls}`, type: "button", onclick: on, ...attrs }, label);
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s.length === 10 ? s + "T12:00:00" : s); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); };
  const fmtShort = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
  const fmtTime = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
  const names = (arr) => arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
  let toastTimer;
  const toast = (msg) => { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 1800); };

  // Occasion changes wording only. Add lines here, never styles.
  const COPY = {
    default: { they: (e) => names(e.recipients) || "the recipients", hoping: "Before you post, here's what they asked for." },
    Wedding: { they: (e) => names(e.recipients) || "the couple", hoping: "Before you post, here's what the couple asked for." },
    "Baby shower": { they: (e) => names(e.recipients) || "the parents", hoping: "Before you post, here's what the parents-to-be asked for." },
  };
  const copy = (e) => ({ ...COPY.default, ...(COPY[e.occasion] || {}) });

  async function api(path, opts = {}) {
    const res = await fetch(path, { method: opts.method || "GET", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: opts.body ? JSON.stringify(opts.body) : undefined });
    let json = {};
    try { json = await res.json(); } catch {}
    return { status: res.status, ok: res.ok, data: json };
  }
  const ev = (path, opts) => api(`/api/e/${slug}${path}`, opts);
  const seenKey = () => `rr_seen_${slug}_${me?.id}`;
  const seen = () => { try { return !!localStorage.getItem(seenKey()); } catch { return true; } };
  const markSeen = () => { try { localStorage.setItem(seenKey(), "1"); } catch {} };

  // ---------- routing ----------
  const route = () => location.pathname.split("/")[3] || "";
  function nav(name, replace) { history[replace ? "replaceState" : "pushState"]({}, "", `/e/${slug}/${name}`); render(); }
  window.addEventListener("popstate", render);

  async function render() {
    stopPolling();
    barRight.textContent = "";
    if (!me) {
      const r = await ev("/me");
      if (r.status === 401) return showCode();
      if (r.status === 404) return showMissing();
      me = r.data;
      document.documentElement.dataset.occasion = (me.event.occasion || "").toLowerCase().replace(/\s+/g, "-");
    }
    document.title = `${me.event.title} · Reverse Registry`;
    const r = route();
    if (me.role === "moderator") barRight.append(btn(r === "organiser" ? "The list" : "Organiser page", "ghost sm", () => nav(r === "organiser" ? "list" : "organiser")));
    barRight.append(btn("Leave", "ghost sm", leave));
    if (me.role === "recipient") {
      if (r === "list") return showList();          // the server answers: blocked, or the unlocked list
      if (r === "post" || r === "hoping") return showBlocked();
      return showOrganiser();
    }
    if (r === "organiser") return me.role === "moderator" ? showOrganiser() : showNotYours();
    if (r === "post") return showPost();
    if (r === "hoping" || ((r === "" || r === "list") && !seen())) return showHoping();
    return showList();
  }

  async function leave() { await api("/api/leave", { method: "POST" }); me = null; data = null; location.href = "/"; }

  // ---------- code ----------
  async function showCode() {
    const pub = await api(`/api/e/${slug}`);
    if (pub.status === 404) return showMissing();
    const e = pub.data;
    const err = h("p", { class: "err", role: "alert" });
    const input = h("input", { name: "code", class: "code", placeholder: "XXXX-XXXX", maxlength: 9, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", required: true });
    const form = h("form", { onsubmit: async (evt) => {
      evt.preventDefault(); err.textContent = "";
      const r = await api("/api/enter", { method: "POST", body: { code: input.value, slug } });
      if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; }
      me = null;
      nav(r.data.role === "recipient" ? "organiser" : "list", true);
    } },
      h("label", { class: "field" }, h("span", {}, "Your code ", h("em", {}, "from your invitation")), input),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn primary block", type: "submit" }, "Continue")),
    );
    mount(h("section", { class: "card" },
      h("p", { class: "eyebrow" }, "You've been invited"),
      h("h1", {}, e.title),
      h("p", { class: "lede" }, [e.occasion, fmtDate(e.date)].filter(Boolean).join(" · "), ". Everyone can see what's already claimed, so nobody turns up with the same thing twice."),
      form,
    ));
    input.focus();
  }

  function showMissing() {
    mount(h("section", { class: "card blocked" }, h("h1", {}, "No such list"), h("p", {}, "Check the link you were sent.")));
  }

  // ---------- guest: hoping ----------
  async function showHoping() {
    const r = await ev("/list");
    if (r.status === 403 && r.data.blocked) return showBlocked(r.data);
    if (!r.ok) return showCode();
    data = r.data;
    const e = data.event, c = copy(e);
    markSeen();
    mount(h("section", { class: "card" },
      h("h1", {}, "What they're hoping for"),
      h("p", { class: "lede" }, c.hoping),
      e.categories.length
        ? h("div", { class: "tags", style: "margin:0 0 20px" }, e.categories.map((cat) => h("span", { class: "tag" }, cat.name)))
        : h("p", { class: "muted", style: "margin-bottom:20px" }, "No categories set. Bring what you think is right."),
      h("div", { class: "stat" }, h("span", {}, "Suggested minimum"), h("strong", {}, e.suggestedMin || "No suggestion")),
      h("p", { class: "hint" }, "Giving less is fine. Join someone else's gift and put in whatever you can, or make something. Nothing here is a price of entry."),
      h("div", { class: "actions" }, btn("See the list", "primary block", () => nav("list", true))),
    ));
  }

  // ---------- the list ----------
  async function fetchList() {
    const r = await ev("/list");
    if (r.status === 403 && r.data.blocked) { showBlocked(r.data); return null; }
    if (!r.ok) { showCode(); return null; }
    return r.data;
  }

  async function showList() {
    const d = await fetchList();
    if (!d) return;
    data = d; lastJson = JSON.stringify(d);
    if (d.unlocked) return renderUnlocked();
    renderList();
    startPolling();
  }

  // Refetch on a timer while the tab is visible, and whenever it becomes visible.
  // Two guests browsing at once must see each other's posts.
  function startPolling() {
    stopPolling();
    const tick = async () => {
      if (document.hidden || editing !== null || route() !== "list") return;
      const d = await fetchList();
      if (!d) return;
      const j = JSON.stringify(d);
      if (j !== lastJson) { data = d; lastJson = j; renderList(); }
    };
    pollTimer = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    pollTimer.tick = tick;
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); document.removeEventListener("visibilitychange", pollTimer.tick); pollTimer = null; }
  }

  function apply(r) { if (r.ok) { data = r.data; lastJson = JSON.stringify(data); renderList(); } else toast(r.data.error || "Something went wrong"); }

  function renderList() {
    const e = data.event;
    const live = data.gifts.filter((g) => !g.removed).length;
    const askInput = h("input", { placeholder: "Ask everyone something", maxlength: 500 });
    const askErr = h("p", { class: "err", role: "alert" });

    // Banners: only for things that concern this person.
    const banners = [];
    for (const g of data.gifts) {
      if (g.flag) banners.push(h("div", { class: "note" },
        h("span", { class: "title" }, "A moderator flagged your ", g.item),
        h("span", { class: "body" }, "The note reads: “", g.flag.note, "” It isn't signed, and only you can see this. Nothing has been removed — change it or take it down yourself."),
        h("div", { class: "row-actions" }, btn("Edit it", "secondary sm", () => startEdit(g)), g.canDelete ? btn("Take it down", "ghost sm", () => removeGift(g)) : null)));
      if (g.proxyPostedBy) banners.push(h("div", { class: "note neutral" },
        h("span", { class: "title" }, g.proxyPostedBy, " posted a gift in your name"),
        h("span", { class: "body" }, "“", g.item, "” is on the list as coming from you. If that's wrong, remove it — it's yours to manage either way."),
        h("div", { class: "row-actions" }, btn("That's right", "secondary sm", async () => apply(await ev(`/gifts/${g.id}/acknowledge`, { method: "POST" }))), g.canDelete ? btn("Remove it", "ghost sm", () => removeGift(g)) : null)));
      if (g.removed && g.removedReason) banners.push(h("div", { class: "note neutral" },
        h("span", { class: "title" }, "Your ", g.item, " was taken off the list"),
        h("span", { class: "body" }, "Two moderators agreed. The note reads: “", g.removedReason, "” It stays visible, struck through, so nobody re-posts it by mistake.")));
    }

    mount(
      h("section", { class: "card" },
        h("div", { class: "header-row" },
          h("div", {}, h("h1", {}, "What everyone's bringing"), h("p", { class: "lede", style: "margin-bottom:16px" }, live === 0 ? "Nothing claimed yet. You're first." : `${live} ${live === 1 ? "gift" : "gifts"} claimed so far`)),
          btn("Post what you're bringing", "primary", () => nav("post"))),
        h("div", { class: "banners", role: "status", "aria-live": "polite" }, banners),
        data.notices.length ? h("div", { style: "margin-bottom:20px" }, data.notices.map((n) => h("div", { class: "notice" }, n.body))) : null,
        data.gifts.length ? h("div", {}, data.gifts.map(giftRow)) : null,
      ),
      h("section", { class: "card" },
        h("h2", {}, "Questions"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, "Anything asked here is public to every guest. ", copy(e).they(e), " can't see it."),
        h("form", { onsubmit: async (evt) => { evt.preventDefault(); askErr.textContent = ""; const rr = await ev("/questions", { method: "POST", body: { body: askInput.value } }); if (!rr.ok) { askErr.textContent = rr.data.error || "Something went wrong"; return; } apply(rr); }, style: "display:flex;gap:8px" },
          askInput, h("button", { class: "btn secondary", type: "submit" }, "Ask")),
        askErr,
        data.questions.length ? h("div", { style: "margin-top:16px" }, data.questions.map(questionRow)) : null,
      ),
    );
  }

  function giftRow(g) {
    if (editing === g.id) return editRow(g);
    const meta = [];
    meta.push(g.giverName);
    if (g.proxy) meta.push(`posted by ${g.posterName}`);
    if (g.joinedBy.length) meta.push(`${names(g.joinedBy)} joined`);
    const kids = [
      h("div", { class: "header-row", style: "align-items:center" },
        h("div", {}, h("div", { class: "item" }, g.item), h("div", { class: "meta" }, g.category ? h("span", { class: "cat" }, g.category) : null, h("span", {}, meta.join(" · ")), g.link ? h("a", { href: g.link, target: "_blank", rel: "noopener" }, "Link ↗") : null)),
        h("div", { class: "row-actions", style: "margin:0" }, rowControls(g))),
    ];
    if (g.removed) {
      kids.push(h("div", { class: "sub" }, "Taken off the list by the moderators."));
      return h("div", { class: "gift gone" }, kids);
    }
    if (g.mine && g.joinedBy.length) kids.push(h("div", { class: "lock-note" }, `${names(g.joinedBy)} joined this, so it can be edited but not taken down.`));
    else if (g.openToJoin && !g.joinedBy.length) kids.push(h("div", { class: "sub" }, "Open for others to chip in."));
    if (data.me.role === "moderator" && g.moderation?.flagged && !g.moderation.youFlagged) kids.push(h("div", { class: "pending" }, "Another moderator flagged this: “", g.moderation.note, "” Agree and it comes off the list."));
    return h("div", { class: "gift" }, kids);
  }

  function rowControls(g) {
    if (g.removed) return [];
    const c = [];
    if (g.mine) {
      if (g.flag) c.push(h("span", { class: "tag outline" }, "Flagged"));
      c.push(btn("Edit", "ghost sm", () => startEdit(g)));
      if (g.canDelete) c.push(btn("Remove", "ghost sm", () => removeGift(g)));
    } else if (g.openToJoin) {
      c.push(g.youJoined ? btn("Joined", "secondary sm", null, { disabled: true }) : btn("Join this", "secondary sm", async () => { apply(await ev(`/gifts/${g.id}/join`, { method: "POST" })); toast("You're in"); }));
    }
    if (data.me.role === "moderator" && !g.mine && g.moderation) {
      if (g.moderation.youFlagged) c.push(h("span", { class: "tag outline" }, "You flagged this"));
      else if (g.moderation.flagged) c.push(btn("Agree and remove", "danger sm", async () => apply(await ev(`/gifts/${g.id}/flag`, { method: "POST", body: {} }))));
      else c.push(btn("Flag", "ghost sm", () => flagGift(g)));
    }
    return c;
  }

  function startEdit(g) { editing = g.id; renderList(); }
  function editRow(g) {
    const input = h("input", { value: g.item, maxlength: 200, "aria-label": "Gift" });
    const err = h("p", { class: "err", role: "alert" });
    const save = async () => {
      const r = await ev(`/gifts/${g.id}`, { method: "PATCH", body: { item: input.value } });
      if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; }
      editing = null; apply(r); toast("Saved");
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") { editing = null; renderList(); } });
    setTimeout(() => input.focus());
    return h("div", { class: "gift" },
      h("div", { class: "inline-edit" }, input, btn("Save", "primary sm", save), btn("Cancel", "ghost sm", () => { editing = null; renderList(); })),
      err);
  }

  async function removeGift(g) {
    const r = await ev(`/gifts/${g.id}`, { method: "DELETE" });
    if (r.ok) { apply(r); toast("Taken down"); } else toast(r.data.error || "Something went wrong");
  }

  function flagGift(g) {
    const input = h("input", { placeholder: "A note the poster will see. It isn't signed.", maxlength: 300 });
    const err = h("p", { class: "err", role: "alert" });
    mount(h("section", { class: "card" },
      h("button", { class: "back", type: "button", onclick: renderList }, "Back"),
      h("h1", { style: "margin-top:12px" }, "Flag a gift"),
      h("p", { class: "lede" }, "“", g.item, "” stays on the list. The poster sees your note as a banner, unsigned, and can change or remove the gift themselves. If another moderator agrees with you, it comes off."),
      h("label", { class: "field" }, h("span", {}, "Note"), input), err,
      h("div", { class: "actions" },
        btn("Flag it", "primary block", async () => { const r = await ev(`/gifts/${g.id}/flag`, { method: "POST", body: { note: input.value } }); if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; } apply(r); }),
        btn("Cancel", "ghost block", renderList)),
    ));
    input.focus();
  }

  function questionRow(qu) {
    const input = h("input", { placeholder: "Reply", maxlength: 500 });
    return h("div", { class: "q" },
      h("div", { class: "who" }, qu.asker, " · ", fmtTime(qu.created_at)),
      h("div", { class: "body" }, qu.body),
      qu.replies.map((r) => h("div", { class: "reply" }, h("div", { class: "who" }, r.author), h("div", {}, r.body))),
      h("form", { onsubmit: async (evt) => { evt.preventDefault(); apply(await ev(`/questions/${qu.id}/replies`, { method: "POST", body: { body: input.value } })); } },
        input, h("button", { class: "btn secondary sm", type: "submit" }, "Reply")),
    );
  }

  // ---------- post ----------
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  function similar(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const wa = new Set(a.split(" ").filter((w) => w.length > 2)), wb = new Set(b.split(" ").filter((w) => w.length > 2));
    const shared = [...wa].filter((w) => wb.has(w)).length;
    return shared >= 2 || (shared >= 1 && Math.min(wa.size, wb.size) === 1);
  }

  async function showPost() {
    if (!data || data.unlocked) { const d = await fetchList(); if (!d) return; data = d; }
    const e = data.event;
    const item = h("input", { placeholder: "Describe it plainly", maxlength: 200, required: true });
    const warn = h("div", { class: "warn", role: "status", hidden: true });
    const cat = h("select", {}, h("option", { value: "" }, e.categories.length ? "Choose one" : "No categories set"), e.categories.map((c) => h("option", { value: c.id }, c.name)));
    const link = h("input", { placeholder: "https://", inputmode: "url", maxlength: 500 });
    const giver = h("select", {}, h("option", { value: "" }, "It's from me"), data.guests.map((g) => h("option", { value: g.id }, g.name)));
    const open = h("input", { type: "checkbox" });
    const err = h("p", { class: "err", role: "alert" });
    item.addEventListener("input", () => {
      const match = data.gifts.find((g) => !g.removed && similar(g.item, item.value));
      warn.hidden = !match;
      if (match) warn.textContent = `Looks close to “${match.item}”, which ${match.giverName} already claimed. Post anyway if it's different.`;
    });
    const form = h("form", { onsubmit: async (evt) => {
      evt.preventDefault(); err.textContent = "";
      const r = await ev("/gifts", { method: "POST", body: { item: item.value, categoryId: cat.value || null, link: link.value, giverId: giver.value || null, openToJoin: open.checked } });
      if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; }
      data = r.data; lastJson = JSON.stringify(data); nav("list", true); toast("Posted");
    } },
      h("label", { class: "field" }, h("span", {}, "What is it"), item), warn,
      h("label", { class: "field" }, h("span", {}, "Category"), cat),
      h("label", { class: "field" }, h("span", {}, "Link ", h("em", {}, "if there is one")), link),
      h("label", { class: "field" }, h("span", {}, "Posting for someone else?"), giver, h("p", { class: "hint" }, "Pick them from the guest list. They'll see it's in their name and can manage it.")),
      h("label", { class: "check" }, open, h("span", {}, "Open for others to chip in", h("small", {}, "Other guests can join this gift. Money is sorted between you, not here."))),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn primary block", type: "submit" }, "Post it"), btn("Cancel", "ghost block", () => nav("list", true))),
    );
    mount(h("section", { class: "card" }, h("button", { class: "back", type: "button", onclick: () => nav("list", true) }, "Back"), h("h1", { style: "margin-top:12px" }, "Add a gift"), form));
    item.focus();
  }

  // ---------- recipient, after the unlock ----------
  function renderUnlocked() {
    const e = data.event;
    mount(h("section", { class: "card" },
      h("div", { class: "header-row" },
        h("div", {}, h("h1", {}, "Here's what everyone brought"), h("p", { class: "lede" }, "Opened ", e.unlockText, " · nothing to edit, nothing to remove")),
        h("span", { class: "tag accent" }, "Unlocked")),
      data.gifts.length ? h("div", {}, data.gifts.map((g) => h("div", { class: "gift" },
        h("div", { class: "header-row", style: "align-items:baseline" },
          h("div", {}, h("div", { class: "item" }, g.item), g.category ? h("div", { class: "meta" }, h("span", { class: "cat" }, g.category)) : null),
          h("div", { class: "meta", style: "margin:0" }, g.giverName, g.joinedBy.length ? `, with ${names(g.joinedBy)}` : ""))))) : h("p", { class: "muted" }, "Nothing was posted."),
      h("div", { class: "actions" }, btn("Your page", "secondary block", () => nav("organiser", true))),
    ));
  }

  // ---------- thread ----------
  function threadBox(t, onUpdate) {
    const box = h("div", { class: "thread" }, t.thread.length ? t.thread.map((m) => h("div", { class: `msg${m.personId === t.me.id ? " me" : ""}` }, h("span", { class: "who" }, m.personId === t.me.id ? "You" : `${m.name} · ${m.role}`), m.body)) : h("p", { class: "muted small" }, "Nothing yet."));
    const input = h("input", { placeholder: "Message", maxlength: 2000 });
    const form = h("form", { class: "composer", onsubmit: async (evt) => { evt.preventDefault(); if (!input.value.trim()) return; const r = await ev("/thread", { method: "POST", body: { body: input.value } }); if (r.ok) onUpdate(r.data); } }, input, h("button", { class: "btn secondary", type: "submit" }, "Send"));
    setTimeout(() => (box.scrollTop = box.scrollHeight));
    return h("div", {}, box, form);
  }

  // ---------- organiser page: recipients and moderators ----------
  async function showOrganiser() {
    const r = await ev("/organiser");
    if (!r.ok) return showCode();
    data = r.data;
    renderOrganiser();
  }

  let shownCode = null; // { id, name, code } — one at a time
  function renderOrganiser() {
    const d = data, e = d.event, isRecipient = d.me.role === "recipient";
    document.getElementById("app").classList.add("wide");
    const noticeInput = h("textarea", { placeholder: "Anything your guests should know", maxlength: 2000, rows: 3 });
    const noticeErr = h("p", { class: "err", role: "alert" });
    const guests = d.people.filter((p) => p.role !== "recipient");

    const roleTag = (p) => h("span", { class: `tag ${p.role === "recipient" ? "accent" : p.role === "moderator" ? "outline" : "neutral"}` }, p.role === "recipient" ? "Recipient" : p.role === "moderator" ? "Moderator" : "Guest");
    const setRole = async (p, role) => { const r = await ev(`/people/${p.id}/role`, { method: "POST", body: { role } }); if (r.ok) { data = r.data; renderOrganiser(); } else toast(r.data.error || "Something went wrong"); };
    const actionCell = (p) => {
      if (p.role === "recipient" || !isRecipient) return h("span", { class: "muted small" }, "—");
      if (p.role === "moderator") return btn("Remove moderator", "ghost sm", () => setRole(p, "guest"));
      if (!p.joinedAt) return h("span", { class: "small", style: "color:var(--ink-3)" }, "Hasn't joined");
      return btn("Make moderator", "secondary sm", () => setRole(p, "moderator"));
    };

    // Code lookup (recipients only). One code visible at a time; changing the select hides it.
    let lookupBlock = null;
    if (isRecipient) {
      const sel = h("select", { "aria-label": "Who asked?" }, h("option", { value: "" }, "Choose a guest"), guests.map((p) => h("option", { value: p.id }, p.name)));
      const result = h("div", { "aria-live": "polite" });
      const drawResult = () => result.replaceChildren(shownCode
        ? h("div", { class: "reveal" }, h("div", {}, h("div", { class: "who" }, shownCode.name), h("div", { class: "big" }, shownCode.code), h("div", { class: "small" }, "Read it to them — this is the only copy. Recorded against your name just now, and visible to your moderators.")), btn("Hide it", "ghost sm", () => { shownCode = null; drawResult(); }))
        : h("div", { class: "reveal-idle" }, "No code is showing. One name at a time — picking another hides this one."));
      sel.addEventListener("change", () => { shownCode = null; drawResult(); });
      drawResult();
      const lookupsLine = () => d.lookups.length ? "Last three lookups: " + d.lookups.map((l) => `${l.name} (${l.requesterId === d.me.id ? "you" : l.requester}, ${fmtShort(l.at)})`).join(", ") + "." : "No lookups yet.";
      lookupBlock = h("section", { class: "card" },
        h("h2", {}, "A guest has lost their code"),
        h("p", { class: "hint", style: "margin:0 0 14px;max-width:34em" }, "Show that one code, never the set. Every lookup is recorded with your name and the date."),
        h("div", { class: "control-row" }, h("label", { class: "field" }, h("span", {}, "Who asked?"), sel),
          btn("Show this code", "primary", async () => { if (!sel.value) return; const r = await ev(`/people/${sel.value}/reveal`, { method: "POST" }); if (!r.ok) { toast(r.data.error || "Something went wrong"); return; } shownCode = { id: sel.value, name: r.data.name, code: r.data.code }; d.lookups = r.data.lookups; drawResult(); lookupsP.textContent = lookupsLine(); })),
        h("div", { style: "margin-top:14px" }, result),
      );
      const lookupsP = h("p", { class: "hint", style: "margin-top:12px" }, lookupsLine());
      lookupBlock.append(lookupsP);
    }

    mount(
      h("section", { class: "card" },
        h("div", { class: "header-row" },
          h("div", {}, h("h1", {}, e.title), h("p", { class: "lede", style: "margin-bottom:0" }, `${fmtDate(e.date)} · ${d.joinedCount} of ${d.guestCount} guests ${d.joinedCount === 1 ? "has" : "have"} joined · ${d.moderatorCount} moderator${d.moderatorCount === 1 ? "" : "s"}`)),
          h("span", { class: "tag accent" }, isRecipient ? "You're a recipient" : "You're a moderator")),
        isRecipient ? (d.unlocked
          ? h("div", { class: "note" }, h("span", { class: "title" }, "The list is open to you now"), h("span", { class: "body" }, "It opened ", e.unlockText, ". "), h("div", { class: "row-actions" }, btn("See what everyone brought", "primary sm", () => nav("list"))))
          : h("div", { class: "note neutral" }, h("span", { class: "title" }, "The list is closed to you until ", e.unlockText), h("span", { class: "body" }, "You can see who has joined and manage moderators. Gifts, givers and counts stay hidden. If a guest tells you they've lost their code, the lookup further down the page will show you that one code.")))
          : h("div", { class: "note neutral" }, h("span", { class: "title" }, "You moderate the list"), h("span", { class: "body" }, "Flag a gift from the list and the poster sees your note, unsigned. If the other moderator agrees, it comes off. This page shows who's joined and the private thread with ", names(e.recipients), ".")),
        h("p", { class: "section-label" }, "Guests"),
        h("div", { class: "tablewrap" }, h("table", { class: "codes" },
          h("tr", {}, h("th", { style: "width:34%" }, "Name"), h("th", { style: "width:20%" }, "Role"), h("th", { style: "width:22%" }, "Joined"), h("th", {}, isRecipient ? "Moderators" : "")),
          d.people.map((p) => h("tr", {}, h("td", {}, p.name), h("td", {}, roleTag(p)), h("td", { class: "small muted" }, p.joinedAt ? fmtShort(p.joinedAt) : "Not yet"), h("td", {}, actionCell(p)))))),
      ),
      lookupBlock,
      h("section", { class: "card" },
        h("h2", {}, "Notices"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, isRecipient ? "Sits at the top of the list for every guest. Nothing comes back to you." : "What the recipients have told the guests."),
        isRecipient ? [noticeInput, noticeErr, h("div", { class: "actions", style: "margin-top:12px" }, btn("Post notice", "primary", async () => { noticeErr.textContent = ""; const r = await ev("/notices", { method: "POST", body: { body: noticeInput.value } }); if (!r.ok) { noticeErr.textContent = r.data.error || "Something went wrong"; return; } data = r.data; renderOrganiser(); toast("Posted"); }))] : null,
        d.notices.length ? h("div", { style: "margin-top:16px" }, d.notices.map((n) => h("div", { class: "notice" }, n.body, h("span", { class: "small", style: "display:block;opacity:.7;margin-top:4px" }, fmtTime(n.created_at))))) : h("p", { class: "muted small" }, "None yet."),
      ),
      h("section", { class: "card" },
        h("h2", {}, "Private thread"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, "Recipients and moderators. No gifts are discussed here."),
        threadBox({ me: d.me, thread: d.thread }, (t) => { data.thread = t.thread; renderOrganiser(); }),
      ),
    );
  }

  // ---------- blocked / not yours ----------
  function showBlocked(info) {
    const when = info?.unlockText || me?.event?.unlockText;
    mount(h("section", { class: "card blocked" },
      h("div", { class: "mark" }, "✕"),
      h("h1", {}, "Not for you"),
      h("p", {}, "This list is what people are bringing you. Everything past here is a surprise someone went to trouble over."),
      h("p", {}, "There's no way through from this page. Not a locked door with a spare key. A wall.", when ? ` It opens for you at ${when}.` : ""),
      h("div", { class: "actions" }, btn("Go to your own page", "secondary block", () => nav("organiser", true))),
    ));
  }
  function showNotYours() {
    mount(h("section", { class: "card blocked" },
      h("div", { class: "mark" }, "·"),
      h("h1", {}, "That's the organiser page"),
      h("p", {}, "Your code opens the gift list, not this."),
      h("div", { class: "actions" }, btn("Back to the list", "secondary block", () => nav("list", true))),
    ));
  }

  render();
})();
