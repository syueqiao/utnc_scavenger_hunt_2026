(function () {
  "use strict";

  const H = window.Hunt;
  const { h } = H;
  const app = document.getElementById("app");
  const CODE_KEY = "utnc-hunt-team-code";
  const FILTER_KEY = "utnc-hunt-filter";
  const ZONES = ["Campus", "Near", "Mid", "Far", "Legendary", "Anywhere"];
  const ZONE_BLURBS = {
    Campus: "10 each, only your best 8 count",
    Near: "about 15 to 25 minutes away",
    Mid: "about 25 to 40 minutes away",
    Far: "40+ minutes or a big climb",
    Legendary: "needs the TTC or a ferry",
    Anywhere: "do these on the way, no crowd penalty"
  };

  let code = H.store.get(CODE_KEY);
  let board = null;
  let filter = H.store.get(FILTER_KEY) || "all";
  let clockOffset = 0;
  let pollTimer = null;
  let tickTimer = null;
  let dialogOpen = false;

  // ---- Login ----------------------------------------------------------

  function renderLogin(message) {
    stopTimers();
    const input = h("input", {
      type: "text",
      class: "code-input",
      id: "code",
      inputmode: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      maxlength: "12",
      required: true,
      "aria-describedby": "login-msg"
    });
    const msg = h("p", { id: "login-msg", class: message ? "error-text" : "muted" }, message || "Your organizer will give your team a code.");
    const button = h("button", { class: "btn red", type: "submit" }, "Join the hunt");

    const form = h(
      "form",
      {
        onsubmit: async (event) => {
          event.preventDefault();
          const value = input.value.trim().toUpperCase();
          if (!value) return;
          button.disabled = true;
          button.textContent = "Checking…";
          try {
            const team = await H.withRetry(() => H.rpc("team_login", { p_code: value }));
            if (!team) throw new Error("bad_code");
            code = value;
            H.store.set(CODE_KEY, code);
            await loadBoard(true);
          } catch (err) {
            msg.textContent = H.friendlyError(err);
            msg.className = "error-text";
            button.disabled = false;
            button.textContent = "Join the hunt";
          }
        }
      },
      h("div", { class: "field" }, h("label", { for: "code" }, "Team code"), input),
      msg,
      button
    );

    app.replaceChildren(
      h(
        "main",
        { class: "narrow login" },
        h("div", { class: "noodle", "aria-hidden": "true" }),
        h("h1", null, H.cfg.title || "Scavenger Hunt"),
        h("p", null, "Snap photos at checkpoints around Toronto, rack up points, and meet your team."),
        H.cfg.finishLine ? h("p", { class: "muted" }, "Finish: " + H.cfg.finishLine) : null,
        form
      )
    );
    input.focus();
  }

  // ---- Data -----------------------------------------------------------

  async function loadBoard(first) {
    try {
      board = await H.withRetry(() => H.rpc("team_board", { p_code: code }));
      clockOffset = Date.parse(board.now) - Date.now();
      renderBoard();
      startTimers();
    } catch (err) {
      const text = H.friendlyError(err);
      if (String(err && err.message).includes("bad_code")) {
        H.store.remove(CODE_KEY);
        code = null;
        renderLogin(text);
      } else if (first || !board) {
        app.replaceChildren(
          h(
            "main",
            { class: "narrow" },
            h("h1", null, "Couldn't load the board"),
            h("p", { class: "error-text", style: "margin: 1rem 0" }, text),
            h("button", { class: "btn", onclick: () => loadBoard(true) }, "Try again")
          )
        );
      }
      // During polling, a failed refresh just keeps the last board on screen.
    }
  }

  function startTimers() {
    stopTimers();
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible" && !dialogOpen) loadBoard(false);
    }, 30000);
    tickTimer = setInterval(updateClock, 1000);
    updateClock();
  }

  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && code && board && !dialogOpen) loadBoard(false);
  });

  // ---- Board ----------------------------------------------------------

  function updateClock() {
    const el = document.getElementById("clock");
    if (!el || !board) return;
    const now = Date.now() + clockOffset;
    const start = board.hunt_start ? Date.parse(board.hunt_start) : null;
    const end = board.hunt_end ? Date.parse(board.hunt_end) : null;
    el.classList.remove("urgent");
    if (start && now < start) {
      el.textContent = "Starts in " + H.formatDuration(start - now);
    } else if (end && now > end) {
      el.textContent = "Time's up! Head to the finish.";
      el.classList.add("urgent");
    } else if (end) {
      const left = end - now;
      el.textContent = H.formatDuration(left) + " left";
      if (left < 15 * 60 * 1000) el.classList.add("urgent");
    } else {
      el.textContent = "Hunt is open";
    }
  }

  function isDone(item) {
    return item.mine_ok >= item.max_claims;
  }

  function matchesFilter(item) {
    if (filter === "all") return true;
    if (filter === "todo") return !isDone(item);
    if (filter === "done") return item.mine_ok > 0;
    return item.zone === filter;
  }

  // Turns https links inside task text into tappable links (text stays escaped).
  function linkify(text) {
    return String(text || "")
      .split(/(https?:\/\/[^\s)]+)/g)
      .map((part, i) => {
        if (i % 2 === 0) return part;
        const clean = part.replace(/[.,!?]+$/, "");
        const trailing = part.slice(clean.length);
        return [h("a", { href: clean, target: "_blank", rel: "noopener noreferrer" }, "example photo"), trailing];
      });
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function renderPoints(item) {
    const mine = item.mine_ok > 0;
    if (item.kind === "anywhere") {
      return h(
        "div",
        { class: "pts" },
        h("span", { class: "pts-num" }, item.base),
        h("span", { class: "pts-label" }, item.max_claims > 1 ? "each" : "points")
      );
    }
    const shown = mine ? item.mine_value : item.value_if_new;
    return h(
      "div",
      { class: "pts" },
      h("span", { class: "pts-num" }, shown),
      shown < item.base ? h("s", null, item.base) : null,
      h("span", { class: "pts-label" }, mine ? "you're earning" : "if you go")
    );
  }

  function renderItem(item, score) {
    const done = isDone(item);
    const campusFull = item.campus && !item.mine_ok && score && score.campus_counted >= board.campus_cap;
    const meta = [];

    if (item.bonus_points > 0) meta.push(h("span", null, "Bonus +" + item.bonus_points + ": " + item.bonus_label));
    if (item.popularity && item.teams_claimed > 0) {
      const ordered = board.crowd_mode === "order";
      if (item.mine_ok > 0 && ordered && item.mine_rank) {
        meta.push(h("span", null, "You were team #" + item.mine_rank + " here"));
      } else {
        const others = item.teams_claimed - (item.mine_ok > 0 ? 1 : 0);
        if (others > 0) meta.push(h("span", null, (item.mine_ok ? "Shared with " : "Claimed by ") + plural(others, "other team")));
      }
    }
    if (item.max_claims > 1) meta.push(h("span", null, item.mine_ok + " of " + item.max_claims + " done"));
    if (item.mine_rejected > 0 && !done) {
      meta.push(h("span", { class: "warn" }, plural(item.mine_rejected, "photo") + " rejected, try again"));
    }
    if (campusFull) meta.push(h("span", { class: "warn" }, "Campus cap reached: only counts if it beats one you have"));

    return h(
      "article",
      { class: "item zone-" + item.zone + (item.mine_ok > 0 ? " claimed" : "") },
      h(
        "div",
        { class: "item-main" },
        h("h3", null, item.name),
        h("p", { class: "task" }, linkify(item.task)),
        item.note ? h("p", { class: "note" }, item.note) : null,
        meta.length ? h("p", { class: "meta" }, meta) : null
      ),
      h(
        "div",
        { class: "item-side" },
        renderPoints(item),
        done
          ? h("span", { class: "done" }, "Claimed")
          : h("button", { class: "btn small", onclick: () => openSubmit(item) }, item.mine_ok > 0 ? "Add another" : "Submit")
      )
    );
  }

  function renderBoard() {
    const scrollY = window.scrollY;
    const score = board.my_score || { total: 0, campus_counted: 0 };
    const items = board.items || [];
    const visible = items.filter(matchesFilter);

    const filters = [
      ["all", "All"],
      ["todo", "To do"],
      ...ZONES.map((z) => [z, z]),
      ["done", "Done"]
    ];

    const chips = h(
      "nav",
      { class: "chips", "aria-label": "Filter the board" },
      filters.map(([key, label]) =>
        h(
          "button",
          {
            class: "chip",
            "aria-pressed": String(filter === key),
            onclick: () => {
              filter = key;
              H.store.set(FILTER_KEY, filter);
              renderBoard();
              window.scrollTo(0, 0);
            }
          },
          label
        )
      )
    );

    const claimedCount = items.filter((i) => i.kind === "checkpoint" && i.mine_ok > 0).length;

    const sections = [];
    for (const zone of ZONES) {
      const zoneItems = visible.filter((i) => i.zone === zone);
      if (!zoneItems.length) continue;
      sections.push(
        h("h2", { class: "zone-title" }, zone, h("span", { class: "muted" }, ZONE_BLURBS[zone])),
        zoneItems.map((item) => renderItem(item, score))
      );
    }

    const leaderboard =
      board.show_leaderboard && Array.isArray(board.leaderboard)
        ? h(
            "section",
            { class: "leaderboard", "aria-labelledby": "lb-title" },
            h("h2", { id: "lb-title", class: "section-title" }, "Leaderboard"),
            h(
              "ol",
              null,
              board.leaderboard.map((row) =>
                h("li", { class: row.team_id === board.team.id ? "me" : null }, h("span", null, row.team_name), h("span", null, row.total))
              )
            ),
            h("p", { class: "muted", style: "margin-top: 0.5rem; font-size: 0.88rem" }, board.crowd_mode === "order"
                ? "Scores update as teams submit. The first team at a checkpoint gets full points, and each team after gets a little less."
                : "Scores update as teams submit. Crowded spots lose value for everyone who claimed them.")
          )
        : null;

    app.replaceChildren(
      h(
        "header",
        { class: "topbar" },
        h(
          "div",
          { class: "topbar-inner" },
          h("div", null, h("p", { class: "team-name" }, board.team.name), h("p", { class: "clock", id: "clock", "aria-live": "off" })),
          h("div", { class: "score" }, h("span", { class: "score-num" }, score.total), h("span", { class: "score-label" }, "points"))
        ),
        chips
      ),
      h(
        "main",
        { class: "board" },
        h(
          "p",
          { class: "summary" },
          h("span", null, h("strong", null, claimedCount), " checkpoints claimed"),
          h("span", null, "Campus counting: ", h("strong", null, score.campus_counted + " of " + board.campus_cap)),
          H.cfg.finishLine ? h("span", null, "Finish: ", h("strong", null, H.cfg.finishLine)) : null
        ),
        sections.length ? sections : h("p", { class: "empty" }, filter === "done" ? "Nothing claimed yet. Go find something!" : "Nothing here."),
        leaderboard,
        h(
          "div",
          { class: "footer-actions" },
          h("button", { class: "btn ghost small", onclick: () => loadBoard(false).then(() => H.toast("Board refreshed")) }, "Refresh"),
          h(
            "button",
            {
              class: "btn ghost small",
              onclick: () => {
                H.store.remove(CODE_KEY);
                code = null;
                board = null;
                renderLogin();
              }
            },
            "Switch team"
          )
        )
      )
    );

    updateClock();
    window.scrollTo(0, scrollY);
  }

  // ---- Submit ---------------------------------------------------------

  function openSubmit(item) {
    let file = null;
    let busy = false;

    const preview = h("div", { class: "photo-pick-inner" }, h("strong", null, "Take or choose a photo"), h("span", { class: "muted" }, "Whole team plus the noodle"));
    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      onchange: () => {
        file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        const img = h("img", { src: url, alt: "Selected photo preview" });
        img.onload = () => URL.revokeObjectURL(url);
        preview.replaceChildren(img, h("span", { class: "muted" }, "Tap to change"));
        submitBtn.disabled = false;
      }
    });

    const bonusCheck = h("input", { type: "checkbox", id: "bonus" });
    const bonusAnswer = h("input", { type: "text", id: "bonus-answer", maxlength: "200", placeholder: "Your answer" });
    const noteInput = h("textarea", {
      id: "note",
      rows: "2",
      maxlength: "300",
      placeholder: item.id === "kamae" ? "Which kamae? Which checkpoint?" : "Anything the organizer should know (optional)"
    });
    const progress = h("p", { class: "progress", role: "status", "aria-live": "polite" });
    const submitBtn = h("button", { class: "btn red", type: "submit", disabled: true }, "Submit photo");

    const dialog = h(
      "dialog",
      { class: "zone-" + item.zone, "aria-labelledby": "dlg-title" },
      h(
        "form",
        {
          class: "dialog-body",
          onsubmit: async (event) => {
            event.preventDefault();
            if (!file || busy) return;
            busy = true;
            submitBtn.disabled = true;
            try {
              progress.textContent = "Shrinking photo…";
              const blob = await H.resizeImage(file);
              progress.textContent = "Uploading…";
              const path = board.team.id + "/" + item.id + "/" + H.uuid() + ".jpg";
              await H.uploadPhoto(path, blob);
              progress.textContent = "Saving…";
              await H.withRetry(() =>
                H.rpc("team_submit", {
                  p_code: code,
                  p_item: item.id,
                  p_photo_path: path,
                  p_bonus: item.bonus_points > 0 && bonusCheck.checked,
                  p_bonus_answer: bonusCheck.checked ? bonusAnswer.value.trim() || null : null,
                  p_note: noteInput.value.trim() || null
                })
              );
              close();
              H.toast("Submitted! " + item.name + " is on the board.");
              await loadBoard(false);
            } catch (err) {
              progress.textContent = "";
              H.toast(H.friendlyError(err), "error");
              busy = false;
              submitBtn.disabled = false;
              if (String(err && err.message).includes("already_claimed")) {
                close();
                loadBoard(false);
              }
            }
          }
        },
        h(
          "div",
          { class: "dialog-head" },
          h("div", null, h("h2", { id: "dlg-title" }, item.name), h("p", { class: "muted" }, linkify(item.task))),
          h("button", { class: "close-x", type: "button", "aria-label": "Close", onclick: () => !busy && close() }, "\u00d7")
        ),
        h("label", { class: "photo-pick" }, fileInput, preview),
        item.bonus_points > 0
          ? h(
              "div",
              { class: "field" },
              h("label", { class: "check", for: "bonus" }, bonusCheck, "Bonus +" + item.bonus_points + ": " + item.bonus_label),
              bonusAnswer
            )
          : null,
        h("div", { class: "field" }, h("label", { for: "note" }, "Note"), noteInput),
        progress,
        submitBtn
      )
    );

    function close() {
      dialogOpen = false;
      if (dialog.open) dialog.close();
      dialog.remove();
    }

    dialog.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
      else setTimeout(close, 0);
    });

    document.body.append(dialog);
    dialogOpen = true;
    dialog.showModal();
  }

  // ---- Start ----------------------------------------------------------

  if (!H.client) {
    H.renderSetupNeeded(app);
  } else if (code) {
    loadBoard(true);
  } else {
    renderLogin();
  }
})();
