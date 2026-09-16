(function () {
  "use strict";

  const H = window.Hunt;
  const { h } = H;
  const app = document.getElementById("app");
  const ADMIN_KEY = "utnc-hunt-admin-code";

  let adminCode = H.store.get(ADMIN_KEY, true);
  let data = null;
  let tab = "photos";
  let filters = { team: "", item: "", status: "all" };
  let refreshTimer = null;
  let lastSeenCount = 0;

  const byId = (list) => Object.fromEntries((list || []).map((x) => [x.id, x]));

  // ---- Login ----------------------------------------------------------

  function renderLogin(message) {
    clearInterval(refreshTimer);
    const input = h("input", { type: "password", id: "admin-code", autocomplete: "off", required: true });
    const msg = h("p", { class: message ? "error-text" : "muted" }, message || "The admin code is printed at the end of the setup script.");
    const button = h("button", { class: "btn", type: "submit" }, "Open dashboard");
    app.replaceChildren(
      h(
        "main",
        { class: "narrow login" },
        h("h1", null, "Organizer"),
        h(
          "form",
          {
            onsubmit: async (event) => {
              event.preventDefault();
              button.disabled = true;
              adminCode = input.value.trim().toUpperCase();
              const ok = await load(true);
              if (ok) H.store.set(ADMIN_KEY, adminCode, true);
              else button.disabled = false;
            }
          },
          h("div", { class: "field" }, h("label", { for: "admin-code" }, "Admin code"), input),
          msg,
          button
        )
      )
    );
    input.focus();
  }

  // ---- Data -----------------------------------------------------------

  async function load(first) {
    try {
      data = await H.withRetry(() => H.rpc("admin_dashboard", { p_admin: adminCode }));
      if (first) {
        lastSeenCount = data.submissions.length;
        renderShell();
        startRefresh();
      } else {
        renderTab(false);
      }
      return true;
    } catch (err) {
      if (String(err && err.message).includes("bad_admin")) {
        H.store.remove(ADMIN_KEY, true);
        adminCode = null;
        renderLogin(H.friendlyError(err));
      } else if (first) {
        renderLogin(H.friendlyError(err));
      } else {
        H.toast(H.friendlyError(err), "error");
      }
      return false;
    }
  }

  function startRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (document.visibilityState === "visible" && tab !== "settings" && !typing) load(false);
    }, 20000);
  }

  async function act(fn, successMessage) {
    try {
      await fn();
      if (successMessage) H.toast(successMessage);
      await load(false);
      if (tab === "settings") renderTab(true);
    } catch (err) {
      H.toast(H.friendlyError(err), "error");
    }
  }

  // ---- Shell ----------------------------------------------------------

  function renderShell() {
    const tabs = [
      ["photos", "Photos"],
      ["scores", "Scores"],
      ["items", "Items"],
      ["settings", "Settings"]
    ];
    app.replaceChildren(
      h(
        "header",
        { class: "admin-top" },
        h(
          "div",
          { class: "admin-top-inner" },
          h("h1", null, (H.cfg.title || "Scavenger Hunt") + ": organizer", h("span", { class: "muted", style: "font-weight: 400; font-size: 0.8rem; margin-left: 0.6rem" }, "v" + H.VERSION)),
          h(
            "nav",
            { class: "tabs", "aria-label": "Sections" },
            tabs.map(([key, label]) =>
              h(
                "button",
                {
                  class: "chip",
                  id: "tab-" + key,
                  "aria-pressed": String(tab === key),
                  onclick: () => {
                    tab = key;
                    document.querySelectorAll(".tabs .chip").forEach((b) => b.setAttribute("aria-pressed", String(b.id === "tab-" + key)));
                    renderTab(true);
                  }
                },
                label
              )
            )
          ),
          h("button", { class: "btn ghost small", onclick: () => load(false).then(() => H.toast("Refreshed")) }, "Refresh")
        )
      ),
      h("main", { class: "admin-main", id: "tab-body" })
    );
    renderTab(true);
  }

  function renderTab(force) {
    const body = document.getElementById("tab-body");
    if (!body) return;
    if (tab === "settings" && !force) return; // don't wipe a half-edited form
    const views = { photos: viewPhotos, scores: viewScores, items: viewItems, settings: viewSettings };
    body.replaceChildren(views[tab]());
    const photosTab = document.getElementById("tab-photos");
    if (photosTab) {
      const fresh = data.submissions.length - lastSeenCount;
      photosTab.textContent = fresh > 0 && tab !== "photos" ? "Photos (" + fresh + " new)" : "Photos";
      if (tab === "photos") lastSeenCount = data.submissions.length;
    }
  }

  // ---- Photos ---------------------------------------------------------

  function viewPhotos() {
    const teams = byId(data.teams);
    const items = byId(data.items);

    const list = data.submissions.filter(
      (s) =>
        (!filters.team || s.team_id === filters.team) &&
        (!filters.item || s.item_id === filters.item) &&
        (filters.status === "all" || s.status === filters.status || (filters.status === "bonus" && s.bonus_claimed))
    );

    const select = (id, label, value, options, onChange) =>
      h(
        "div",
        { class: "field" },
        h("label", { for: id }, label),
        h(
          "select",
          { id, onchange: (e) => onChange(e.target.value) },
          options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))
        )
      );

    const toolbar = h(
      "div",
      { class: "toolbar" },
      select("f-team", "Team", filters.team, [["", "All teams"], ...data.teams.map((t) => [t.id, t.name])], (v) => {
        filters.team = v;
        renderTab(true);
      }),
      select("f-item", "Checkpoint", filters.item, [["", "All items"], ...data.items.map((i) => [i.id, i.name])], (v) => {
        filters.item = v;
        renderTab(true);
      }),
      select(
        "f-status",
        "Show",
        filters.status,
        [
          ["all", "Everything"],
          ["ok", "Accepted"],
          ["rejected", "Rejected"],
          ["bonus", "Bonus claims"]
        ],
        (v) => {
          filters.status = v;
          renderTab(true);
        }
      ),
      h("p", { class: "muted" }, list.length + " of " + data.submissions.length + " submissions")
    );

    if (!list.length) {
      return h("div", null, toolbar, h("p", { class: "empty" }, data.submissions.length ? "Nothing matches these filters." : "No photos yet. They'll appear here as teams submit."));
    }

    return h(
      "div",
      null,
      toolbar,
      h(
        "div",
        { class: "grid" },
        list.map((s) => {
          const item = items[s.item_id] || { name: s.item_id, zone: "Anywhere" };
          const team = teams[s.team_id] || { name: s.team_id };
          const url = H.photoUrl(s.photo_path);
          const rejected = s.status === "rejected";
          return h(
            "figure",
            { class: "photo-card zone-" + item.zone + (rejected ? " rejected" : "") },
            h("a", { href: url, target: "_blank", rel: "noopener" }, h("img", { src: url, alt: team.name + " at " + item.name, loading: "lazy" })),
            h(
              "figcaption",
              null,
              h("div", { class: "row" }, h("strong", null, team.name), h("time", { class: "muted", datetime: s.created_at }, H.formatTime(s.created_at))),
              h("div", { class: "row" }, h("span", null, item.name), rejected ? h("span", { class: "badge bad" }, "Rejected") : null),
              s.note ? h("p", { class: "muted" }, "\u201c" + s.note + "\u201d") : null,
              s.bonus_claimed
                ? h(
                    "div",
                    { class: "answer-box" },
                    h("div", null, h("strong", null, "Bonus answer: "), s.bonus_answer || "(none given)"),
                    item.answer ? h("div", { class: "muted" }, "Expected: " + item.answer) : null,
                    h(
                      "label",
                      { class: "check", style: "margin-top: 0.35rem" },
                      h("input", {
                        type: "checkbox",
                        checked: s.bonus_ok,
                        onchange: (e) =>
                          act(() => H.rpc("admin_set_submission", { p_admin: adminCode, p_id: s.id, p_status: null, p_bonus_ok: e.target.checked }), e.target.checked ? "Bonus accepted" : "Bonus removed")
                      }),
                      "Bonus counts (+" + item.bonus_points + ")"
                    )
                  )
                : null,
              h(
                "div",
                { class: "actions" },
                rejected
                  ? h("button", { class: "btn small", onclick: () => act(() => H.rpc("admin_set_submission", { p_admin: adminCode, p_id: s.id, p_status: "ok", p_bonus_ok: null }), "Restored") }, "Restore")
                  : h("button", { class: "btn ghost small", onclick: () => act(() => H.rpc("admin_set_submission", { p_admin: adminCode, p_id: s.id, p_status: "rejected", p_bonus_ok: null }), "Rejected") }, "Reject")
              )
            )
          );
        })
      )
    );
  }

  // ---- Scores ---------------------------------------------------------

  function viewScores() {
    const teams = byId(data.teams);
    const cap = data.config.campus_cap;

    const table = h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, "#"),
            h("th", null, "Team"),
            h("th", { class: "num" }, "Checkpoints"),
            h("th", { class: "num" }, "Anywhere"),
            h("th", { class: "num" }, "Bonuses"),
            h("th", { class: "num" }, "Adjustments"),
            h("th", { class: "num" }, "Campus"),
            h("th", { class: "num" }, "Total")
          )
        ),
        h(
          "tbody",
          null,
          data.scores.map((row, index) =>
            h(
              "tr",
              null,
              h("td", null, index + 1),
              h("td", null, row.team_name),
              h("td", { class: "num" }, row.checkpoint_pts),
              h("td", { class: "num" }, row.anywhere_pts),
              h("td", { class: "num" }, row.bonus_pts),
              h("td", { class: "num" }, row.adjust_pts),
              h("td", { class: "num" }, row.campus_counted + "/" + cap),
              h("td", { class: "num total-cell" }, row.total)
            )
          )
        )
      )
    );

    // Adjustment form
    const teamSelect = h("select", { id: "adj-team" }, data.teams.map((t) => h("option", { value: t.id }, t.name)));
    const pointsInput = h("input", { type: "number", id: "adj-points", step: "1", value: "40" });
    const reasonInput = h("input", { type: "text", id: "adj-reason", maxlength: "120", value: "Snack swap winner" });
    const presets = [
      ["Snack swap winner", 40],
      ["Snack swap runner-up", 20],
      ["Teammate quiz answer", 5],
      ["Late to finish (per minute)", -10]
    ];

    const form = h(
      "form",
      {
        class: "panel",
        onsubmit: (event) => {
          event.preventDefault();
          const points = parseInt(pointsInput.value, 10);
          if (Number.isNaN(points)) return H.toast("Points must be a whole number.", "error");
          act(
            () => H.rpc("admin_add_adjustment", { p_admin: adminCode, p_team: teamSelect.value, p_points: points, p_reason: reasonInput.value }),
            "Added " + (points > 0 ? "+" : "") + points + " for " + teams[teamSelect.value].name
          );
        }
      },
      h("h2", null, "Add points at the finish"),
      h(
        "div",
        { class: "quick" },
        presets.map(([reason, pts]) =>
          h(
            "button",
            {
              type: "button",
              class: "chip",
              onclick: () => {
                reasonInput.value = reason;
                pointsInput.value = pts;
              }
            },
            reason + " " + (pts > 0 ? "+" : "") + pts
          )
        )
      ),
      h("div", { class: "field" }, h("label", { for: "adj-team" }, "Team"), teamSelect),
      h("div", { class: "field" }, h("label", { for: "adj-points" }, "Points (negative for penalties)"), pointsInput),
      h("div", { class: "field" }, h("label", { for: "adj-reason" }, "Reason"), reasonInput),
      h("button", { class: "btn", type: "submit" }, "Add adjustment"),
      data.adjustments.length
        ? h(
            "div",
            { class: "table-wrap" },
            h(
              "table",
              null,
              h(
                "tbody",
                null,
                data.adjustments.map((a) =>
                  h(
                    "tr",
                    null,
                    h("td", null, (teams[a.team_id] || {}).name || a.team_id),
                    h("td", null, a.reason),
                    h("td", { class: "num" }, (a.points > 0 ? "+" : "") + a.points),
                    h(
                      "td",
                      null,
                      h("button", { type: "button", class: "btn ghost small", onclick: () => act(() => H.rpc("admin_delete_adjustment", { p_admin: adminCode, p_id: a.id }), "Removed") }, "Remove")
                    )
                  )
                )
              )
            )
          )
        : h("p", { class: "muted" }, "No adjustments yet.")
    );

    return h(
      "div",
      { class: "two-col" },
      h(
        "section",
        null,
        h("h2", { class: "section-title" }, "Scores"),
        table,
        h("p", { class: "muted", style: "margin-top: 0.75rem; font-size: 0.9rem" }, (data.config.crowd_mode === "order" ? "Later teams at a checkpoint earn less than earlier ones." : "Checkpoint values shrink as more teams claim a spot.") + " Only each team's best " + cap + " campus stops count.")
      ),
      form
    );
  }

  // ---- Items ----------------------------------------------------------

  function viewItems() {
    return h(
      "section",
      null,
      h("h2", { class: "section-title" }, "Items and live values"),
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          null,
          h(
            "thead",
            null,
            h("tr", null, h("th", null, "Zone"), h("th", null, "Item"), h("th", { class: "num" }, "Base"), h("th", { class: "num" }, "Teams"), h("th", { class: "num" }, "Next team gets"), h("th", null, "Bonus"), h("th", null, "Answer"))
          ),
          h(
            "tbody",
            null,
            data.items.map((i) =>
              h(
                "tr",
                null,
                h("td", null, i.zone),
                h("td", null, i.name),
                h("td", { class: "num" }, i.base + (i.max_claims > 1 ? " \u00d7" + i.max_claims : "")),
                h("td", { class: "num" }, i.teams_claimed),
                h("td", { class: "num" }, i.value_if_new),
                h("td", null, i.bonus_points ? "+" + i.bonus_points + " " + i.bonus_label : ""),
                h("td", { class: "muted" }, i.answer || "")
              )
            )
          )
        )
      ),
      h("p", { class: "muted", style: "margin-top: 0.75rem; font-size: 0.9rem" }, "To change items or points, edit the seed list in supabase/setup.sql and run it again. Existing photos are kept.")
    );
  }

  // ---- Settings -------------------------------------------------------

  function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function fromLocalInput(value) {
    return value ? new Date(value).toISOString() : null;
  }

  function viewSettings() {
    const c = data.config;
    const start = h("input", { type: "datetime-local", id: "s-start", value: toLocalInput(c.hunt_start) });
    const end = h("input", { type: "datetime-local", id: "s-end", value: toLocalInput(c.hunt_end) });
    const cap = h("input", { type: "number", id: "s-cap", min: "0", step: "1", value: String(c.campus_cap) });
    const lb = h("input", { type: "checkbox", id: "s-lb", checked: c.show_leaderboard });
    const crowd = h("input", { type: "checkbox", id: "s-crowd", checked: c.crowd_scaled });
    const mode = h(
      "select",
      { id: "s-mode" },
      h("option", { value: "order", selected: c.crowd_mode === "order" }, "First come, first served"),
      h("option", { value: "shared", selected: c.crowd_mode === "shared" }, "Shared (everyone at a spot gets the same)")
    );
    const resetInput = h("input", { type: "text", id: "s-reset", placeholder: "Type RESET", autocomplete: "off" });

    const base = location.href.replace(/admin\.html.*$/, "");

    return h(
      "div",
      { class: "two-col" },
      h(
        "div",
        { class: "stack" },
        h(
          "form",
          {
            class: "panel",
            onsubmit: (event) => {
              event.preventDefault();
              act(
                () =>
                  H.rpc("admin_update_config", {
                    p_admin: adminCode,
                    p_hunt_start: fromLocalInput(start.value),
                    p_hunt_end: fromLocalInput(end.value),
                    p_show_leaderboard: lb.checked,
                    p_campus_cap: parseInt(cap.value, 10),
                    p_crowd_scaled: crowd.checked,
                    p_crowd_mode: mode.value
                  }),
                "Settings saved"
              );
            }
          },
          h("h2", null, "Hunt settings"),
          h("div", { class: "field" }, h("label", { for: "s-start" }, "Submissions open at"), start, h("span", { class: "muted" }, "Leave empty to accept photos any time.")),
          h("div", { class: "field" }, h("label", { for: "s-end" }, "Hard stop"), end, h("span", { class: "muted" }, "Photos submitted after this are refused.")),
          h("div", { class: "field" }, h("label", { for: "s-cap" }, "Campus stops that count per team"), cap),
          h("label", { class: "check", for: "s-lb" }, lb, "Show the live leaderboard to teams"),
          h("div", { class: "field" }, h("label", { for: "s-mode" }, "How crowded checkpoints score"), mode),
          h("label", { class: "check", for: "s-crowd" }, crowd, "Scale the steps to the number of teams"),
          h("span", { class: "muted" }, crowdExplainer(c, data.teams.length)),
          h("button", { class: "btn", type: "submit" }, "Save settings")
        ),
        h(
          "div",
          { class: "panel" },
          h("h2", null, "Reset after a test run"),
          h("p", null, "Deletes every submission and adjustment. Photos stay in storage (clear the bucket in Supabase if you want)."),
          resetInput,
          h(
            "button",
            {
              class: "btn red",
              type: "button",
              onclick: () => act(() => H.rpc("admin_reset_hunt", { p_admin: adminCode, p_confirm: resetInput.value.trim() }), "Hunt reset")
            },
            "Delete all submissions"
          )
        )
      ),
      viewTeams(base)
    );
  }

  function crowdExplainer(c, teamCount) {
    const floor = Math.round(c.floor_mult * 100);
    const ordered = c.crowd_mode === "order";
    const who = ordered ? "each later team gets " : "each extra team at a spot takes off ";
    if (c.crowd_scaled) {
      if (teamCount < 2) return "With one team there's no crowd penalty.";
      const step = Math.round(((1 - c.floor_mult) / (teamCount - 1)) * 1000) / 10;
      return ordered
        ? "With " + teamCount + " teams, the first team at a spot gets full points, " + who + step + "% less, and the last team gets " + floor + "%."
        : "With " + teamCount + " teams, " + who + step + "% for everyone, and a spot every team visits is worth " + floor + "%.";
    }
    return (ordered ? "Each later team gets " + Math.round(c.decay * 100) + "% less" : "Each extra team takes off " + Math.round(c.decay * 100) + "%") + ", never below " + floor + "%. This doesn't adjust when teams change.";
  }

  const pendingRemove = {};

  function viewTeams(base) {
    const nameInput = h("input", { type: "text", id: "new-team", maxlength: "40", placeholder: "Team name" });

    const rows = data.teams.map((t) => {
      const rename = h("input", { type: "text", value: t.name, maxlength: "40", "aria-label": "Name for " + t.name });
      const armed = pendingRemove[t.id];
      return h(
        "tr",
        null,
        h(
          "td",
          null,
          h(
            "form",
            {
              style: "display: flex; gap: 0.4rem",
              onsubmit: (e) => {
                e.preventDefault();
                if (rename.value.trim() === t.name) return;
                act(() => H.rpc("admin_rename_team", { p_admin: adminCode, p_id: t.id, p_name: rename.value }), "Renamed");
              }
            },
            rename,
            h("button", { class: "btn ghost small", type: "submit" }, "Save")
          ),
          h("span", { class: "muted", style: "font-size: 0.85rem" }, t.photos + (t.photos === 1 ? " photo" : " photos"))
        ),
        h("td", { class: "num" }, h("strong", { style: "letter-spacing: 0.15em; font-size: 1.1rem" }, t.code)),
        h(
          "td",
          null,
          h(
            "div",
            { style: "display: grid; gap: 0.35rem; justify-items: end" },
            h(
              "button",
              {
                class: "btn ghost small",
                type: "button",
                onclick: () => act(() => H.rpc("admin_regenerate_code", { p_admin: adminCode, p_id: t.id }), "New code for " + t.name + ". The old one no longer works.")
              },
              "New code"
            ),
            h(
              "button",
              {
                class: armed ? "btn red small" : "btn ghost small",
                type: "button",
                onclick: () => {
                  if (!armed) {
                    pendingRemove[t.id] = true;
                    // refresh first so the photo count in the warning is current
                    load(false).then(() => renderTab(true));
                    setTimeout(() => {
                      if (pendingRemove[t.id]) {
                        delete pendingRemove[t.id];
                        if (tab === "settings") renderTab(true);
                      }
                    }, 5000);
                    return;
                  }
                  delete pendingRemove[t.id];
                  act(() => H.rpc("admin_delete_team", { p_admin: adminCode, p_id: t.id, p_force: true }), t.name + " removed");
                }
              },
              armed ? (t.photos ? "Delete team + " + t.photos + (t.photos === 1 ? " photo?" : " photos?") : "Tap to confirm") : "Remove"
            )
          )
        )
      );
    });

    return h(
      "div",
      { class: "panel" },
      h("h2", null, "Teams (" + data.teams.length + ")"),
      h("p", null, "Players go to ", h("a", { href: base, target: "_blank", rel: "noopener" }, base), " and enter their code. Crowd values rebalance automatically when you add or remove teams."),
      h(
        "form",
        {
          style: "display: flex; gap: 0.5rem",
          onsubmit: (e) => {
            e.preventDefault();
            const name = nameInput.value;
            act(() => H.rpc("admin_add_team", { p_admin: adminCode, p_name: name }), "Added " + name.trim());
          }
        },
        nameInput,
        h("button", { class: "btn small", type: "submit" }, "Add team")
      ),
      data.teams.length
        ? h("div", { class: "table-wrap" }, h("table", null, h("tbody", null, rows)))
        : h("p", { class: "muted" }, "No teams yet. Add one above."),
      h("p", { class: "muted" }, "Photo storage uses the free Supabase tier. Open this page the day before so the project is awake."),
      h(
        "button",
        {
          class: "btn ghost small",
          type: "button",
          onclick: () => {
            H.store.remove(ADMIN_KEY, true);
            adminCode = null;
            renderLogin();
          }
        },
        "Log out"
      )
    );
  }

  // ---- Start ----------------------------------------------------------

  if (!H.client) H.renderSetupNeeded(app);
  else if (adminCode) load(true);
  else renderLogin();
})();
