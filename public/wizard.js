(() => {
  const $ = (id) => document.getElementById(id);
  const state = { step: 1, categories: [] };

  // ----- options from the server -----
  fetch("/api/options").then((r) => r.json()).then(({ occasions, suggested }) => {
    $("occasion").innerHTML = occasions.map((o) => `<option>${o}</option>`).join("");
    $("suggested").innerHTML = suggested.map((s) => `<option${s === "$75 to $100" ? " selected" : ""}>${s}</option>`).join("");
  });

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
  // Browser back button works too.
  window.addEventListener("popstate", () => { const n = Number(location.hash.slice(1)) || 1; if (n < 5) go(n); });

  function validateStep1() {
    const err = $("err1"); err.textContent = "";
    if (!$("title").value.trim()) { err.textContent = "Give it a title."; return false; }
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
    const guests = $("guests").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const parts = l.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
      const email = parts.find((p) => p.includes("@")) || "";
      const name = parts.filter((p) => p !== email).join(" ") || email.split("@")[0];
      return { name, email };
    });
    if (!guests.length) { err.textContent = "Add at least one guest."; return; }
    $("create").disabled = true;
    const res = await fetch("/api/events", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        occasion: $("occasion").value, title: $("title").value, date: $("date").value,
        recipients: recipients(), categories: state.categories, suggestedMin: $("suggested").value, guests,
      }),
    });
    const data = await res.json().catch(() => ({}));
    $("create").disabled = false;
    if (!res.ok) { err.textContent = data.error || "Something went wrong"; return; }
    showResult(data);
  });

  function showResult(d) {
    $("out-url").value = d.url;
    $("out-recipients").innerHTML = `<tr><th>Name</th><th>Code</th></tr>` + d.recipients.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${r.code}</td></tr>`).join("");
    $("out-organiser").textContent = d.organiserCode;
    $("out-mail").textContent = d.mailerConfigured ? "Codes have been emailed to everyone with an address." : "Email isn't set up on this server yet, so nothing has been sent. Pass these along yourself.";
    $("out-guests").innerHTML = `<tr><th>Name</th><th>Email</th><th>Code</th></tr>` + d.guests.map((g) => `<tr><td>${esc(g.name)}</td><td class="email">${esc(g.email) || "—"}</td><td class="mono">${g.code}</td></tr>`).join("");
    $("out-go").href = `/e/${d.slug}`;
    go(5);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
