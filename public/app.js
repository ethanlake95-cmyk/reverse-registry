// Event pages. This file never decides who may see gifts; it asks the API and
// renders whatever comes back (a list, a 401, or a 403 "blocked").
(() => {
  const slug = location.pathname.split("/")[2];
  const view = document.getElementById("view");
  const barRight = document.getElementById("bar-right");
  let me = null;      // { id, name, role, isModerator, event }
  let data = null;    // last list or organiser payload

  // ---------- tiny DOM helper ----------
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "hidden") el.hidden = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const mount = (...kids) => view.replaceChildren(...kids.flat().filter(Boolean));
  const btn = (label, cls, on, attrs = {}) => h("button", { class: `btn ${cls}`, type: "button", onclick: on, ...attrs }, label);
  const fmtDate = (s) => { if (!s) return ""; const d = new Date(s.length === 10 ? s + "T12:00:00" : s); return isNaN(d) ? s : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };
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

  // ---------- routing ----------
  const route = () => location.pathname.split("/")[3] || "";
  function nav(name, replace) { history[replace ? "replaceState" : "pushState"]({}, "", `/e/${slug}/${name}`); render(); }
  window.addEventListener("popstate", render);

  async function render() {
    barRight.textContent = "";
    if (!me) {
      const r = await ev("/me");
      if (r.status === 401) return showCode();
      if (r.status === 404) return showMissing();
      me = r.data;
      document.documentElement.dataset.occasion = (me.event.occasion || "").toLowerCase().replace(/\s+/g, "-");
    }
    document.title = `${me.event.title} · Reverse Registry`;
    barRight.append(btn("Leave", "ghost sm", leave));
    const r = route();
    if (me.role !== "guest") {
      // Recipients and the organiser. Any attempt at the list is answered by the server.
      if (r === "list" || r === "post" || r === "hoping" || r === "blocked") return showBlocked();
      return showOrganiser();
    }
    if (r === "organiser") return showNotYours();
    if (r === "post") return showPost();
    if (r === "thread") return showThread();
    if (r === "hoping" || (r !== "list" && !sessionStorage.getItem(`rr_seen_${slug}`))) return showHoping();
    return showList();
  }

  async function leave() { await api("/api/leave", { method: "POST" }); me = null; data = null; sessionStorage.removeItem(`rr_seen_${slug}`); location.href = "/"; }

  // ---------- code ----------
  async function showCode() {
    const pub = await api(`/api/e/${slug}`);
    if (pub.status === 404) return showMissing();
    const e = pub.data;
    const err = h("p", { class: "err" });
    const input = h("input", { name: "code", class: "code", placeholder: "XXXX-XXXX", maxlength: 9, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", required: true });
    const form = h("form", { onsubmit: async (evt) => {
      evt.preventDefault(); err.textContent = "";
      const r = await api("/api/enter", { method: "POST", body: { code: input.value, slug } });
      if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; }
      me = null; sessionStorage.removeItem(`rr_seen_${slug}`);
      nav(r.data.role === "guest" ? "hoping" : "organiser", true);
    } },
      h("label", { class: "field" }, h("span", {}, "Your code ", h("em", {}, "from your invitation")), input),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn primary block", type: "submit" }, "Continue")),
    );
    mount(
      h("section", { class: "card" },
        h("p", { class: "eyebrow" }, "You've been invited"),
        h("h1", {}, e.title),
        h("p", { class: "lede" }, [e.occasion, fmtDate(e.date)].filter(Boolean).join(" · "), ". Everyone can see what's already claimed, so nobody turns up with the same thing twice."),
        form,
      ),
    );
    input.focus();
  }

  function showMissing() {
    mount(h("section", { class: "card blocked" }, h("h1", {}, "No such list"), h("p", {}, "Check the link you were sent.")));
  }

  // ---------- guest: hoping ----------
  async function showHoping() {
    const r = await ev("/list");
    if (r.status === 403 && r.data.blocked) return showBlocked();
    if (!r.ok) return showCode();
    data = r.data;
    const e = data.event, c = copy(e);
    sessionStorage.setItem(`rr_seen_${slug}`, "1");
    mount(
      h("section", { class: "card" },
        h("h1", {}, "What they're hoping for"),
        h("p", { class: "lede" }, c.hoping),
        e.categories.length
          ? h("div", { class: "tags", style: "margin:0 0 20px" }, e.categories.map((cat) => h("span", { class: "tag" }, cat.name)))
          : h("p", { class: "muted", style: "margin-bottom:20px" }, "No categories set. Bring what you think is right."),
        h("div", { class: "stat" }, h("span", {}, "Suggested minimum"), h("strong", {}, e.suggestedMin || "No suggestion")),
        h("p", { class: "hint" }, "Giving less is fine. Join someone else's gift and put in whatever you can, or make something. Nothing here is a price of entry."),
        h("div", { class: "actions" }, btn("See the list", "primary block", () => nav("list"))),
      ),
    );
  }

  // ---------- guest: list ----------
  async function showList() {
    const r = await ev("/list");
    if (r.status === 403 && r.data.blocked) return showBlocked();
    if (!r.ok) return showCode();
    data = r.data;
    renderList();
  }

  function renderList() {
    const e = data.event;
    const live = data.gifts.filter((g) => !g.removed).length;
    const askInput = h("input", { placeholder: "Ask everyone something", maxlength: 500 });
    const askErr = h("p", { class: "err" });

    mount(
      h("section", { class: "card" },
        h("p", { class: "eyebrow" }, [e.occasion, fmtDate(e.date)].filter(Boolean).join(" · ")),
        h("h1", {}, live === 0 ? "Nothing claimed yet" : `${live} ${live === 1 ? "gift" : "gifts"} claimed`),
        h("p", { class: "lede" }, live === 0 ? "You're first. Post yours and everyone after you will see it." : "Post yours and everyone after you will see it."),
        data.notices.length ? h("div", { style: "margin-bottom:20px" }, data.notices.map((n) => h("div", { class: "notice" }, n.body))) : null,
        h("div", { class: "actions", style: "margin:0 0 20px" }, btn("Add what you're bringing", "primary block", () => nav("post"))),
        data.gifts.length ? h("div", {}, data.gifts.map(giftRow)) : null,
      ),
      h("section", { class: "card" },
        h("h2", {}, "Questions"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, "Anything asked here is public to every guest. ", copy(e).they(e), " can't see it."),
        h("form", { onsubmit: async (evt) => { evt.preventDefault(); askErr.textContent = ""; const rr = await ev("/questions", { method: "POST", body: { body: askInput.value } }); if (!rr.ok) { askErr.textContent = rr.data.error || "Something went wrong"; return; } data = rr.data; renderList(); }, style: "display:flex;gap:8px" },
          askInput, h("button", { class: "btn secondary", type: "submit" }, "Ask")),
        askErr,
        data.questions.length ? h("div", { style: "margin-top:16px" }, data.questions.map(questionRow)) : null,
      ),
      data.me.isModerator ? h("p", { class: "muted small", style: "text-align:center;margin-top:16px" }, "You're a moderator. ", h("a", { href: `/e/${slug}/thread`, onclick: (evt) => { evt.preventDefault(); nav("thread"); } }, "Open the private thread")) : null,
    );
  }

  function giftRow(g) {
    const who = g.proxy ? `from ${g.giverName}, posted by ${g.posterName}` : `from ${g.giverName}`;
    const kids = [
      h("div", { class: "item" }, g.item),
      h("div", { class: "meta" }, g.category ? h("span", { class: "cat" }, g.category) : null, h("span", {}, who), g.link ? h("a", { href: g.link, target: "_blank", rel: "noopener" }, "Link ↗") : null),
    ];
    if (g.removed) {
      kids.push(h("div", { class: "reason" }, "Removed by the moderators: ", g.removedReason || "no reason given"));
      return h("div", { class: "gift gone" }, kids);
    }
    if (g.openToJoin) {
      const n = g.joinedBy.length;
      kids.push(h("div", { class: "sub" }, "Open for others to chip in. ", n === 0 ? "Nobody has joined yet." : `${names(g.joinedBy)} ${n === 1 ? "has" : "have"} joined.`));
    }
    const actions = [];
    if (g.openToJoin && !g.mine) {
      actions.push(g.youJoined ? btn("You joined", "secondary sm", null, { disabled: true }) : btn("Join this gift", "secondary sm", async () => { const r = await ev(`/gifts/${g.id}/join`, { method: "POST" }); if (r.ok) { data = r.data; renderList(); toast("You're in"); } }));
    }
    if (data.me.isModerator && g.removal) {
      if (g.removal.proposed && !g.removal.youVoted) {
        kids.push(h("div", { class: "pending" }, "Another moderator wants this removed: ", g.removal.reason));
        actions.push(btn("Agree and remove", "danger sm", async () => { const r = await ev(`/gifts/${g.id}/remove-vote`, { method: "POST", body: {} }); if (r.ok) { data = r.data; renderList(); } }));
      } else if (g.removal.youVoted) {
        kids.push(h("div", { class: "pending" }, "You proposed removing this. It comes off once the other moderator agrees."));
      } else {
        actions.push(btn("Propose removal", "ghost sm", () => proposeRemoval(g)));
      }
    }
    if (actions.length) kids.push(h("div", { class: "row-actions" }, actions));
    return h("div", { class: "gift" }, kids);
  }

  function proposeRemoval(g) {
    const input = h("input", { placeholder: "Reason, shown to everyone", maxlength: 300 });
    const err = h("p", { class: "err" });
    mount(
      h("section", { class: "card" },
        h("button", { class: "back", type: "button", onclick: renderList }, "Back"),
        h("h1", { style: "margin-top:12px" }, "Propose removing a gift"),
        h("p", { class: "lede" }, "“", g.item, "” stays on the list, struck through, with your reason. The other moderator has to agree before it comes off."),
        h("label", { class: "field" }, h("span", {}, "Reason"), input), err,
        h("div", { class: "actions" },
          btn("Propose removal", "primary block", async () => { const r = await ev(`/gifts/${g.id}/remove-vote`, { method: "POST", body: { reason: input.value } }); if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; } data = r.data; renderList(); }),
          btn("Cancel", "ghost block", renderList)),
      ),
    );
    input.focus();
  }

  function questionRow(qu) {
    const input = h("input", { placeholder: "Reply", maxlength: 500 });
    return h("div", { class: "q" },
      h("div", { class: "who" }, qu.asker, " · ", fmtTime(qu.created_at)),
      h("div", { class: "body" }, qu.body),
      qu.replies.map((r) => h("div", { class: "reply" }, h("div", { class: "who" }, r.author), h("div", {}, r.body))),
      h("form", { onsubmit: async (evt) => { evt.preventDefault(); const r = await ev(`/questions/${qu.id}/replies`, { method: "POST", body: { body: input.value } }); if (r.ok) { data = r.data; renderList(); } } },
        input, h("button", { class: "btn secondary sm", type: "submit" }, "Reply")),
    );
  }

  // ---------- guest: post ----------
  async function showPost() {
    if (!data) { const r = await ev("/list"); if (r.status === 403 && r.data.blocked) return showBlocked(); if (!r.ok) return showCode(); data = r.data; }
    const e = data.event;
    const item = h("input", { placeholder: "Describe it plainly", maxlength: 200, required: true });
    const cat = h("select", {}, h("option", { value: "" }, e.categories.length ? "Choose one" : "No categories set"), e.categories.map((c) => h("option", { value: c.id }, c.name)));
    const link = h("input", { placeholder: "https://", inputmode: "url", maxlength: 500 });
    const giver = h("select", {}, h("option", { value: "" }, "It's from me"), data.guests.map((g) => h("option", { value: g.id }, g.name)));
    const open = h("input", { type: "checkbox" });
    const err = h("p", { class: "err" });
    const form = h("form", { onsubmit: async (evt) => {
      evt.preventDefault(); err.textContent = "";
      const r = await ev("/gifts", { method: "POST", body: { item: item.value, categoryId: cat.value || null, link: link.value, giverId: giver.value || null, openToJoin: open.checked } });
      if (!r.ok) { err.textContent = r.data.error || "Something went wrong"; return; }
      data = r.data; nav("list", true); toast("Posted");
    } },
      h("label", { class: "field" }, h("span", {}, "What is it"), item),
      h("label", { class: "field" }, h("span", {}, "Category"), cat),
      h("label", { class: "field" }, h("span", {}, "Link ", h("em", {}, "if there is one")), link),
      h("label", { class: "field" }, h("span", {}, "Posting for someone else?"), giver, h("p", { class: "hint" }, "Pick them from the guest list. The gift is recorded as theirs.")),
      h("label", { class: "check" }, open, h("span", {}, "Open for others to chip in", h("small", {}, "Other guests can join this gift. Money is sorted between you, not here."))),
      err,
      h("div", { class: "actions" }, h("button", { class: "btn primary block", type: "submit" }, "Post it"), btn("Cancel", "ghost block", () => nav("list", true))),
    );
    mount(h("section", { class: "card" }, h("button", { class: "back", type: "button", onclick: () => nav("list", true) }, "Back"), h("h1", { style: "margin-top:12px" }, "Add a gift"), form));
    item.focus();
  }

  // ---------- thread (moderators reach it from the list; recipients from their page) ----------
  async function showThread() {
    const r = await ev("/thread");
    if (!r.ok) return nav("list", true);
    mount(h("section", { class: "card" },
      h("button", { class: "back", type: "button", onclick: () => nav("list", true) }, "Back"),
      h("h1", { style: "margin-top:12px" }, "Private thread"),
      h("p", { class: "lede" }, "Recipients and both moderators. Don't mention gifts here; the recipients read this."),
      threadBox(r.data, (d) => showThread()),
    ));
  }

  function threadBox(t, onUpdate) {
    const box = h("div", { class: "thread" }, t.thread.length ? t.thread.map((m) => h("div", { class: `msg${m.personId === t.me.id ? " me" : ""}` }, h("span", { class: "who" }, m.personId === t.me.id ? "You" : `${m.name} · ${m.role}`), m.body)) : h("p", { class: "muted small" }, "Nothing yet."));
    const input = h("input", { placeholder: "Message", maxlength: 2000 });
    const form = h("form", { class: "composer", onsubmit: async (evt) => { evt.preventDefault(); if (!input.value.trim()) return; const r = await ev("/thread", { method: "POST", body: { body: input.value } }); if (r.ok) onUpdate(r.data); } }, input, h("button", { class: "btn secondary", type: "submit" }, "Send"));
    setTimeout(() => (box.scrollTop = box.scrollHeight));
    return h("div", {}, box, form);
  }

  // ---------- recipients / organiser page ----------
  async function showOrganiser() {
    const r = await ev("/organiser");
    if (!r.ok) return showCode();
    data = r.data;
    renderOrganiser();
  }

  function renderOrganiser() {
    const d = data, e = d.event;
    document.getElementById("app").classList.add("wide");
    const noticeInput = h("textarea", { placeholder: "Anything your guests should know", maxlength: 2000, rows: 3 });
    const noticeErr = h("p", { class: "err" });

    mount(
      h("section", { class: "card" },
        h("p", { class: "eyebrow" }, "Only recipients see this"),
        h("h1", {}, e.title),
        h("p", { class: "lede" }, [e.occasion, fmtDate(e.date)].filter(Boolean).join(" · "), " · for ", names(e.recipients)),
        h("div", { class: "stat" }, h("span", {}, "Gifts claimed"), h("strong", {}, String(d.giftCount)), h("span", {}, "How many, never what.")),
        h("hr", { class: "divider" }),
        h("h2", {}, "Who's joined"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, d.moderatorCount >= 2 ? "Both moderators are set." : `Pick ${2 - d.moderatorCount} more moderator${2 - d.moderatorCount === 1 ? "" : "s"} from the people who've joined. Both have to agree before a gift comes off the list.`),
        d.joined.length
          ? h("ul", { class: "rows" }, d.joined.map((p) => h("li", {}, h("div", {}, h("div", { class: "name" }, p.name), h("div", { class: "sub" }, "Joined ", fmtTime(p.joinedAt))),
              p.isModerator ? h("span", { class: "tag" }, "Moderator") : (d.moderatorCount < 2 ? btn("Make moderator", "secondary sm", async () => { const r = await ev("/moderators", { method: "POST", body: { personId: p.id } }); if (r.ok) { data = r.data; renderOrganiser(); } else toast(r.data.error); }) : null))))
          : h("p", { class: "muted small" }, "Nobody has used their code yet."),
      ),
      h("section", { class: "card" },
        h("h2", {}, "Post a notice"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, "Goes out by email to every guest with an address and sits at the top of the list. Replies are switched off, so nothing comes back to you by accident."),
        noticeInput, noticeErr,
        h("div", { class: "actions", style: "margin-top:12px" }, btn("Send notice", "primary", async () => { noticeErr.textContent = ""; const r = await ev("/notices", { method: "POST", body: { body: noticeInput.value } }); if (!r.ok) { noticeErr.textContent = r.data.error || "Something went wrong"; return; } data = r.data; renderOrganiser(); toast("Notice sent"); })),
        d.notices.length ? h("div", { style: "margin-top:16px" }, d.notices.map((n) => h("div", { class: "notice" }, n.body, h("span", { class: "small", style: "display:block;opacity:.7;margin-top:4px" }, fmtTime(n.created_at))))) : null,
      ),
      h("section", { class: "card" },
        h("h2", {}, "Private thread"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, "You, the other recipients, and both moderators. No gifts are discussed here."),
        threadBox({ me: d.me, thread: d.thread }, (t) => { data.thread = t.thread; renderOrganiser(); }),
      ),
      h("section", { class: "card" },
        h("h2", {}, "Codes"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, "Link for everyone: ", h("a", { href: d.url }, d.url), ". ", d.mailerConfigured ? "Guest codes were emailed to everyone with an address." : "Email isn't set up on this server, so pass codes along yourself."),
        h("div", { class: "tablewrap" }, h("table", { class: "codes" },
          h("tr", {}, h("th", {}, "Name"), h("th", {}, "Role"), h("th", {}, "Code"), h("th", {}, "Joined")),
          d.people.map((p) => h("tr", {}, h("td", {}, h("div", {}, p.name), p.email ? h("div", { class: "email" }, p.email) : null), h("td", { class: "small muted" }, p.role), h("td", { class: "mono" }, p.code), h("td", {}, h("span", { class: `dot${p.joined ? " on" : ""}` }), h("span", { class: "small muted" }, p.joined ? "yes" : "not yet")))),
        )),
      ),
      !d.mailerConfigured || d.outbox.some((m) => m.status !== "sent") ? h("section", { class: "card" },
        h("h2", {}, "Outbox"),
        h("p", { class: "hint", style: "margin:0 0 12px" }, d.mailerConfigured ? "Emails that didn't go out." : "Email isn't set up, so these were written but not sent. Copy what you need."),
        d.outbox.length ? h("ul", { class: "rows" }, d.outbox.filter((m) => !d.mailerConfigured || m.status !== "sent").slice(0, 50).map((m) => h("li", {}, h("div", {}, h("div", { class: "name" }, m.subject, " → ", m.to_email), h("div", { class: "sub" }, m.status, m.detail ? ` · ${m.detail}` : "")), btn("Copy", "ghost sm", () => { navigator.clipboard?.writeText(m.body); toast("Copied"); })))) : h("p", { class: "muted small" }, "Nothing here."),
      ) : null,
    );
  }

  // ---------- blocked / not yours ----------
  function showBlocked() {
    mount(h("section", { class: "card blocked" },
      h("div", { class: "mark" }, "✕"),
      h("h1", {}, "Not for you"),
      h("p", {}, "This list is what people are bringing you. Everything past here is a surprise someone went to trouble over."),
      h("p", {}, "There's no way through from this page. Not a locked door with a spare key. A wall."),
      h("div", { class: "actions" }, btn("Go to your own page", "secondary block", () => nav("organiser", true))),
    ));
  }
  function showNotYours() {
    mount(h("section", { class: "card blocked" },
      h("div", { class: "mark" }, "·"),
      h("h1", {}, "That's the recipients' page"),
      h("p", {}, "Your code opens the gift list, not this."),
      h("div", { class: "actions" }, btn("Back to the list", "secondary block", () => nav("list", true))),
    ));
  }

  render();
})();
