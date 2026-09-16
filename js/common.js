(function () {
  "use strict";

  const cfg = window.HUNT_CONFIG || {};
  const bucket = cfg.bucket || "hunt-photos";

  const configured =
    typeof cfg.supabaseUrl === "string" &&
    typeof cfg.supabaseKey === "string" &&
    cfg.supabaseUrl.startsWith("https://") &&
    !cfg.supabaseUrl.includes("YOUR-PROJECT") &&
    !cfg.supabaseKey.includes("YOUR-");

  const client =
    configured && window.supabase
      ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
          auth: { persistSession: false, autoRefreshToken: false }
        })
      : null;

  // ---- Errors ---------------------------------------------------------

  const ERRORS = {
    bad_code: "That team code didn't work. Double-check it with your organizer.",
    bad_admin: "That organizer code didn't work.",
    not_started: "The hunt hasn't started yet. Hang tight!",
    hunt_over: "Time's up, the hunt is over. Head to the finish!",
    already_claimed: "Your team has already claimed this one.",
    bad_item: "That item isn't on the board anymore. Refresh the page.",
    bad_photo: "The photo didn't upload properly. Try again.",
    bad_status: "Unknown status.",
    reason_required: "Add a reason for the adjustment.",
    confirm_required: "Type RESET to confirm.",
    name_required: "Give the team a name.",
    bad_mode: "Unknown scoring mode.",
    team_has_photos: "That team has photos. Tap again to remove it anyway."
  };

  function rawMessage(err) {
    if (!err) return "Something went wrong.";
    return err.message || err.error_description || err.error || String(err);
  }

  function isBusinessError(err) {
    const msg = rawMessage(err);
    return Object.keys(ERRORS).some((key) => msg.includes(key));
  }

  function friendlyError(err) {
    const msg = rawMessage(err);
    for (const key of Object.keys(ERRORS)) {
      if (msg.includes(key)) return ERRORS[key];
    }
    if (/failed to fetch|networkerror|network request|load failed/i.test(msg)) {
      return "No connection right now. Check your signal and try again.";
    }
    return msg;
  }

  // ---- Network --------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function withRetry(fn, attempts = 3) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (isBusinessError(err)) throw err;
        if (i < attempts - 1) await sleep(800 * Math.pow(2, i));
      }
    }
    throw lastError;
  }

  async function rpc(name, params) {
    const { data, error } = await client.rpc(name, params);
    if (error) throw error;
    return data;
  }

  // ---- Photos ---------------------------------------------------------

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn't read that image. Try another photo, or take a new one."));
      };
      img.src = url;
    });
  }

  // Shrinks a phone photo (often 3 to 8 MB) to roughly 200 to 400 KB.
  async function resizeImage(file, maxSide = 1600, quality = 0.8) {
    const img = await loadImage(file);
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
    const scale = Math.min(1, maxSide / longest);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("Couldn't process that photo. Try another one.");
    return blob;
  }

  async function uploadPhoto(path, blob) {
    return withRetry(async () => {
      const { error } = await client.storage
        .from(bucket)
        .upload(path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" });
      if (error) {
        // A retry after a lost response can find the file already there.
        const msg = rawMessage(error);
        if (/exists|duplicate/i.test(msg) || String(error.statusCode) === "409") return;
        throw error;
      }
    });
  }

  function photoUrl(path) {
    return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  // ---- DOM ------------------------------------------------------------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "dataset") Object.assign(el.dataset, value);
        else if (key.startsWith("on") && typeof value === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "value") el.value = value;
        else if (value === true) el.setAttribute(key, "");
        else el.setAttribute(key, value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  let toastTimer = null;
  function toast(message, kind = "info") {
    let el = document.getElementById("toast");
    if (!el) {
      el = h("div", { id: "toast", role: "status", "aria-live": "polite" });
      document.body.append(el);
    }
    el.textContent = message;
    el.className = "toast show " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3800);
  }

  const store = {
    get(key, session = false) {
      try {
        return (session ? sessionStorage : localStorage).getItem(key);
      } catch (e) {
        return null;
      }
    },
    set(key, value, session = false) {
      try {
        (session ? sessionStorage : localStorage).setItem(key, value);
      } catch (e) {
        /* storage unavailable: the user just logs in again next time */
      }
    },
    remove(key, session = false) {
      try {
        (session ? sessionStorage : localStorage).removeItem(key);
      } catch (e) {
        /* ignore */
      }
    }
  };

  function formatTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  function renderSetupNeeded(root) {
    root.replaceChildren(
      h(
        "main",
        { class: "narrow setup" },
        h("h1", null, "Almost there"),
        h(
          "p",
          null,
          "This page isn't connected to a database yet. Open ",
          h("code", null, "js/config.js"),
          " and paste in your Supabase project URL and public key. The README walks through it step by step."
        )
      )
    );
  }

  window.Hunt = {
    cfg,
    client,
    configured,
    rpc,
    withRetry,
    friendlyError,
    uuid,
    resizeImage,
    uploadPhoto,
    photoUrl,
    h,
    toast,
    store,
    formatTime,
    formatDuration,
    renderSetupNeeded
  };
})();
