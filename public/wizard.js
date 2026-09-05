(() => {
  const $ = (id) => document.getElementById(id);
  const state = { step: 1, categories: [] };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ----- options from the server -----
  fetch("/api/options").then((r) => r.json()).then(({ occasions, suggested, timezones }) => {
    $("occasion").innerHTML = occasions.map((o) => `<option>${esc(o)}</option>`).join("");
    $("suggested").innerHTML = suggested.map((s) => `<option${s === "$75 to $100" ? " selected" : ""}>${esc(s)}</option>`).join("");
    $("timezone").innerHTML = timezones.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join("");
    updateNote();
  });

  // ----- the unlock note, computed by the server from date + zone -----
  let noteTimer;
  async function updateNote() {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      const date = $("date").value, tz = $("timezone").value;
      const note = $("unlock-note");
      if (!date || !tz) { note.hidden = true; return; }
      const r = await fetch(`/api/unlock-preview?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(tz)}`);
      if (!r.ok) { note.hidden = true; return; }
      const { text } = await r.json();
      const who = recipients();
      note.textContent = `The list unlocks for ${who.length ? names(who) : "the recipients"} at ${text}. Until then ${who.length === 1 ? "they" : "neither of them"} can open it, on any device.`;
      note.hidden = false;
    }, 150);
  }
  ["date", "timezone", "recipients"].forEach((id) => $(id).addEventListener("input", updateNote));
  const names = (arr) => arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];

  // ----- steps -----
  function go(n) {
    state.step = n;
    document.querySelectorAll(".step").forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
    $("steps").textContent = n <= 4 ? `Step ${n} of 4` : "";
    $("back").hidden = n === 5;
    window.scrollTo({ top: 0 });
    history.replaceState({ step: n }, "", `#${n}`);
  }
  $("back").addEventListener("click", () => (state.step === 1 ? (location.href = "/") : go(state.step - 1)));
  document.querySelectorAll(".next").forEach((b) => b.addEventListener("click", () => {
    if (state.step === 1 && !validateStep1()) return;
    go(state.step + 1);
  }));
  window.addEventListener("popstate", () => { const n = Number(location.hash.slice(1)) || 1; if (n < 5) go(n); });

  function validateStep1() {
    const err = $("err1"); err.textContent = "";
    if (!$("title").value.trim()) { err.textContent = "Give it a title."; return false; }
    if (!$("date").value) { err.textContent = "Pick the date. The unlock is worked out from it."; return false; }
    if (!recipients().length) { err.textContent = "Name at least one person receiving the gifts."; return false; }
    return true;
  }
  const recipients = () => $("recipients").value.split(",").map((s) => s.trim()).filter(Boolean);

  // ----- categories -----
  function drawTags() {
    const t = $("tags"); t.textContent = "";
    state.categories.forEach((name, i) => {
      const s = document.createElement("span"); s.className = "tag"; s.textContent = name;
      const x = document.createElement("button"); x.type = "button"; x.textContent = "✕"; x.setAttribute("aria-label", `Remove ${name}`);
      x.onclick = () => { state.categories.splice(i, 1); drawTags(); };
      s.append(x); t.append(s);
    });
    const n = state.categories.length;
    $("catcount").textContent = n === 0 ? "Nothing picked yet." : `${n} picked.`;
  }
  function addCategory(name) {
    name = name.trim();
    if (!name) return;
    if (state.categories.some((c) => c.toLowerCase() === name.toLowerCase())) { $("catcount").textContent = "That one's already on the list."; return; }
    state.categories.push(name); drawTags();
  }
  $("catpick").addEventListener("change", (e) => {
    const v = e.target.value; e.target.value = "";
    if (v === "__other") { $("otherwrap").hidden = false; $("other").focus(); return; }
    addCategory(v);
  });
  $("addother").addEventListener("click", () => { addCategory($("other").value); $("other").value = ""; $("other").focus(); });
  $("other").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("addother").click(); } });
  drawTags();

  // ----- create -----
  $("create").addEventListener("click", async () => {
    const err = $("err4"); err.textContent = "";
    const guests = $("guests").value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!guests.length) { err.textContent = "Add at least one guest."; return; }
    $("create").disabled = true;
    const res = await fetch("/api/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        occasion: $("occasion").value, title: $("title").value, date: $("date").value, timezone: $("timezone").value,
        recipients: recipients(), categories: state.categories, suggestedMin: $("suggested").value, guests,
      }),
    });
    const data = await res.json().catch(() => ({}));
    $("create").disabled = false;
    if (!res.ok) { err.textContent = data.error || "Something went wrong"; return; }
    showSheet(data);
  });

  function showSheet(d) {
    const ng = d.guests.length, nr = d.recipients.length;
    $("out-lede").textContent = `These ${ng} guest code${ng === 1 ? "" : "s"} go on your invitations; the last ${nr === 1 ? "one is yours" : nr + " are yours"} to keep. This is the last screen that shows them — the organiser page never will, and there is no email to fall back on. If a guest loses theirs, you can look up that one code on the organiser page.`;
    $("out-warn").textContent = "You're receiving gifts at this event, so you're seeing codes you could use to read the list. Once you leave this page that stops being possible.";
    const rows = d.guests.map((g) => `<tr><td>${esc(g.name)}</td><td class="mono">${esc(g.code)}</td><td class="small muted">Guest</td></tr>`)
      .concat(d.recipients.map((r, i) => `<tr${i === 0 ? ' class="keep"' : ""}><td>${esc(r.name)}</td><td class="mono">${esc(r.code)}</td><td class="small muted">Yours — keep it</td></tr>`));
    $("out-table").innerHTML = `<tr><th style="width:45%">Guest</th><th>Code</th><th style="width:22%">Role</th></tr>` + rows.join("");
    $("out-url").textContent = d.url; $("out-url").href = d.url;
    $("out-go").href = `/e/${d.slug}`;
    document.title = `${d.title} · codes`;
    go(5);
  }
})();
