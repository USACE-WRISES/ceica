// CEICA browser behavior.
//
// 1. One event channel: any element with data-ev posts {type, ...data-*, n} to input "ce_event"
//    (clicks; change for inputs and selects; change/blur for text). The server has ONE dispatcher
//    and re-rendered markup never needs its own Shiny inputs.
// 2. A shared tooltip for [data-tip] (charts and tables), and cross-highlighting: hovering or
//    focusing anything with data-key lights up every mark and row with the same key inside the
//    same [data-link] group; a click pins it.
// 3. Focus survives re-renders: the focused field (by id) and its caret come back.
// 4. Ctrl+Z / Ctrl+Y outside text fields undo and redo.
// 5. Autosave: the server sends the project JSON after edits; it is kept in this browser only
//    (localStorage), with a small index for "Continue where you left off".
// 6. Input grids: paste a block from Excel, move like a spreadsheet.
// 7. Two-click confirm for destructive buttons.
(function () {
  "use strict";

  function nonce() { return Date.now() + Math.random(); }
  function shinyReady() { return !!(window.Shiny && Shiny.setInputValue); }

  function post(type, data) {
    if (!shinyReady()) return;
    var msg = { type: type, n: nonce() };
    for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k]; }
    Shiny.setInputValue("ce_event", msg, { priority: "event" });
  }

  function payload(el) {
    var d = {};
    for (var k in el.dataset) {
      if (k === "ev") continue;
      d[k] = el.dataset[k];
    }
    return d;
  }

  // ---- 1. events -----------------------------------------------------------------------
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-ev]") : null;
    if (!el) return;
    var tag = el.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "OPTION") return;
    e.preventDefault();
    post(el.dataset.ev, payload(el));
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.dataset || !el.dataset.ev) return;
    var d = payload(el);
    if (el.type === "checkbox") d.value = el.checked;
    else d.value = el.value;
    post(el.dataset.ev, d);
  });
  // Enter commits a single-line text field
  document.addEventListener("keydown", function (e) {
    var el = e.target;
    if (e.key === "Enter" && el && el.tagName === "INPUT" && el.dataset && el.dataset.ev &&
        (el.type === "text" || el.type === "number")) {
      el.blur();
    }
  });

  // ---- 2. tooltip and cross-highlight ----------------------------------------------------
  var tip = null;
  function tipEl() {
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "ce-tip";
      tip.setAttribute("role", "tooltip");
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(text, x, y) {
    var t = tipEl();
    t.textContent = text;
    t.hidden = false;
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = Math.min(x + 14, window.innerWidth - w - 8);
    var top = y + 16;
    if (top + h > window.innerHeight - 8) top = y - h - 12;
    t.style.left = left + "px";
    t.style.top = top + "px";
  }
  function hideTip() { if (tip) tip.hidden = true; }

  var pinned = {};   // link group -> key
  function group(el) {
    var g = el.closest ? el.closest("[data-link]") : null;
    return g ? g.getAttribute("data-link") : null;
  }
  function highlight(g, key) {
    var nodes = document.querySelectorAll('[data-link="' + g + '"] [data-key]');
    for (var i = 0; i < nodes.length; i++) {
      var on = key !== null && nodes[i].getAttribute("data-key") === key;
      if (nodes[i].classList) nodes[i].classList.toggle("is-hl", on);
    }
  }
  document.addEventListener("mouseover", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-key],[data-tip]") : null;
    if (!el) return;
    var text = el.getAttribute("data-tip");
    if (text) showTip(text, e.clientX, e.clientY);
    var key = el.getAttribute("data-key");
    var g = group(el);
    if (g && key) highlight(g, key);
  });
  document.addEventListener("mousemove", function (e) {
    if (tip && !tip.hidden) {
      var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
      if (el) showTip(el.getAttribute("data-tip"), e.clientX, e.clientY);
    }
  });
  document.addEventListener("mouseout", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-key],[data-tip]") : null;
    if (!el) return;
    var to = e.relatedTarget && e.relatedTarget.closest ?
      e.relatedTarget.closest("[data-key],[data-tip]") : null;
    if (to === el) return;
    hideTip();
    var g = group(el);
    if (g) highlight(g, pinned[g] || null);
  });
  document.addEventListener("focusin", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("tr[data-key]") : null;
    if (!el) return;
    var g = group(el);
    if (g) highlight(g, el.getAttribute("data-key"));
  });
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("svg [data-key]") : null;
    if (!el) return;
    var g = group(el);
    if (!g) return;
    var key = el.getAttribute("data-key");
    pinned[g] = pinned[g] === key ? null : key;
    highlight(g, pinned[g]);
    if (pinned[g]) {
      var row = document.querySelector('[data-link="' + g + '"] tr[data-key="' + key + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { hideTip(); pinned = {}; }
  });

  // ---- 3. focus survives re-renders -------------------------------------------------------
  var remembered = null;
  document.addEventListener("focusin", function (e) {
    var el = e.target;
    if (el && el.id && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) {
      remembered = { id: el.id, start: el.selectionStart, end: el.selectionEnd, dirty: false };
    }
  });
  document.addEventListener("focusout", function (e) {
    var el = e.target;
    setTimeout(function () {
      // Still in the page but no longer focused: the person left the field on purpose, so a
      // later re-render must not pull focus back. A re-render removes the field instead.
      if (remembered && el && el.id === remembered.id && el.isConnected &&
          document.activeElement !== el) {
        remembered = null;
      }
    }, 0);
  });
  if (window.jQuery) {
    jQuery(document).on("shiny:value", function () {
      if (!remembered) return;
      var r = remembered;
      setTimeout(function () {
        var el = document.getElementById(r.id);
        if (el && document.activeElement !== el &&
            (document.activeElement === document.body || !document.activeElement)) {
          el.focus();
          try {
            if (r.dirty) {
              // typing that started before the re-render arrived is kept, caret and all
              el.value = r.value;
              el.setSelectionRange(r.start, r.end);
              remembered = r;
            } else if (el.classList.contains("ce-cell")) {
              el.select();
            } else if (r.start != null) {
              el.setSelectionRange(r.start, r.end);
            }
          } catch (err) { /* */ }
        }
      }, 0);
    });
  }
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (remembered && el && el.id === remembered.id) {
      remembered.start = el.selectionStart;
      remembered.end = el.selectionEnd;
      remembered.dirty = true;
      remembered.value = el.value;
    }
  });

  // ---- 4. undo and redo keys --------------------------------------------------------------
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
              t.isContentEditable)) return;
    if (document.querySelector(".modal.show")) return;
    var k = (e.key || "").toLowerCase();
    if (k === "z" && !e.shiftKey) { e.preventDefault(); post("undo", {}); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); post("redo", {}); }
  });

  // ---- 5. server messages: title, scroll, autosave -----------------------------------------
  var AKEY = "ceica.autosave.";
  var IKEY = "ceica.autosave.index";
  function readIndex() {
    try { return JSON.parse(localStorage.getItem(IKEY) || "[]"); } catch (err) { return []; }
  }
  function writeIndex(ix) {
    try { localStorage.setItem(IKEY, JSON.stringify(ix.slice(0, 10))); } catch (err) { /* */ }
  }
  function sendRecents() {
    if (shinyReady()) Shiny.setInputValue("ce_recents", { items: readIndex(), n: nonce() });
  }
  // A new row's first cell gets focus once the re-render puts it on the page.
  var pendingFocus = null;
  function byPath(path) {
    var all = document.querySelectorAll("[data-path]");
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-path") === path) return all[i];
    }
    return null;
  }
  function focusPending() {
    if (!pendingFocus) return;
    var el = byPath(pendingFocus);
    if (!el) return;
    pendingFocus = null;
    el.scrollIntoView({ block: "center" });
    el.focus();
    try { el.select(); } catch (err) { /* */ }
  }
  // Scroll to an element (by id) and focus it once the named output has rendered again: a
  // message arrives before the new page, so acting at once would find the old element. `now`
  // means nothing will re-render (the page is already showing). Gives up after 3 seconds.
  var pendingScroll = null;
  function scrollPending(name) {
    var ps = pendingScroll;
    if (!ps) return;
    if (Date.now() > ps.until) { pendingScroll = null; return; }
    if (name !== null && ps.output && name !== ps.output) return;
    var el = document.getElementById(ps.id);
    if (!el) return;
    pendingScroll = null;
    el.scrollIntoView({ block: ps.block || "start" });
    try { el.focus({ preventScroll: true }); } catch (err) { /* */ }
  }
  if (window.jQuery) {
    jQuery(document).on("shiny:value", function (e) {
      var name = e.name || "";
      setTimeout(focusPending, 0);
      setTimeout(function () { scrollPending(name); }, 0);
    });
  }

  // Shiny requires every handler to take exactly one argument, and throws otherwise; each is
  // registered on its own so one failure cannot silently drop the rest.
  var handlers = {
    ce_title: function (m) {
      document.title = (m && m.title) ? m.title + " - CEICA" : "CEICA";
    },
    ce_scroll_top: function (m) {
      var c = document.getElementById("ce-content");
      if (c) c.scrollTop = 0;
    },
    ce_autosave: function (m) {
      try {
        localStorage.setItem(AKEY + m.id, m.json);
        var ix = readIndex().filter(function (x) { return x.id !== m.id; });
        ix.unshift({ id: m.id, name: m.name, at: m.at });
        writeIndex(ix);
      } catch (err) { /* storage full or blocked: the download is the durable copy */ }
    },
    ce_restore: function (m) {
      var json = null;
      try { json = localStorage.getItem(AKEY + m.id); } catch (err) { /* */ }
      Shiny.setInputValue("ce_restore_json", { json: json, n: nonce() }, { priority: "event" });
    },
    ce_forget: function (m) {
      try {
        localStorage.removeItem(AKEY + m.id);
        writeIndex(readIndex().filter(function (x) { return x.id !== m.id; }));
      } catch (err) { /* */ }
      sendRecents();
    },
    ce_recents_request: function (m) { sendRecents(); },
    ce_focus: function (m) {
      pendingFocus = m.path;
      setTimeout(focusPending, 0);
    },
    ce_scroll_to: function (m) {
      pendingScroll = { id: m.id, output: m.output || "", block: m.block || "start",
                        until: Date.now() + 3000 };
      if (m.now) setTimeout(function () { scrollPending(null); }, 0);
    },
    ce_cell_error: function (m) {
      var el = byPath(m.path);
      if (!el) return;
      el.value = el.defaultValue;
      el.setAttribute("aria-invalid", "true");
      el.title = m.message || "";
      setTimeout(function () { el.removeAttribute("aria-invalid"); el.title = ""; }, 2500);
    }
  };
  function register() {
    if (!(window.Shiny && Shiny.addCustomMessageHandler)) return false;
    Object.keys(handlers).forEach(function (name) {
      try {
        Shiny.addCustomMessageHandler(name, handlers[name]);
      } catch (err) {
        if (window.console) console.error("CEICA: could not register " + name, err);
      }
    });
    return true;
  }
  if (!register()) {
    var tries = 0;
    var t = setInterval(function () { if (register() || ++tries > 200) clearInterval(t); }, 100);
  }

  // ---- 6. input grids: paste a block, move like a spreadsheet ----------------------------
  function gridCell(grid, r, c) {
    return document.getElementById("cell-" + grid + "-" + r + "-" + c);
  }
  document.addEventListener("paste", function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains("ce-cell")) return;
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (!text || (text.indexOf("\t") < 0 && text.indexOf("\n") < 0)) return;
    e.preventDefault();
    post("paste", { grid: el.dataset.grid, r: el.dataset.r, c: el.dataset.c, text: text });
  });
  document.addEventListener("keydown", function (e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains("ce-cell")) return;
    var r = parseInt(el.dataset.r, 10), c = parseInt(el.dataset.c, 10), g = el.dataset.grid;
    var next = null;
    if (e.key === "Enter" || e.key === "ArrowDown") next = gridCell(g, r + 1, c);
    else if (e.key === "ArrowUp") next = gridCell(g, r - 1, c);
    else if (e.key === "Escape") { el.value = el.defaultValue; el.blur(); return; }
    if (next) {
      e.preventDefault();
      next.focus();
      next.select();
    } else if (e.key === "Enter") {
      e.preventDefault();
      el.blur();
    }
  });
  // A cell selects its text when it gains focus, so typing replaces the value as in Excel.
  // The mouseup that ends the focusing click would drop the selection; swallow that one only,
  // so a second click still places the caret.
  document.addEventListener("focusin", function (e) {
    var el = e.target;
    if (el && el.classList && el.classList.contains("ce-cell")) {
      el.dataset.fresh = "1";
      try { el.select(); } catch (err) { /* */ }
    }
  });
  document.addEventListener("mouseup", function (e) {
    var el = e.target;
    if (el && el.classList && el.classList.contains("ce-cell") && el.dataset.fresh === "1") {
      e.preventDefault();
    }
    if (el && el.dataset) el.dataset.fresh = "";
  });
  document.addEventListener("keydown", function (e) {
    var el = e.target;
    if (el && el.dataset && el.dataset.fresh === "1") el.dataset.fresh = "";
  }, true);

  // ---- 7. two-click confirm for destructive buttons ---------------------------------------
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-confirm]") : null;
    if (!el) return;
    if (el.dataset.armed === "1") return;   // second click: the event handler posts it
    e.preventDefault();
    e.stopImmediatePropagation();
    el.dataset.armed = "1";
    el.dataset.label = el.textContent;
    el.textContent = el.dataset.confirm;
    setTimeout(function () {
      if (el.dataset.armed === "1") { el.dataset.armed = ""; el.textContent = el.dataset.label; }
    }, 3000);
  }, true);

  if (window.jQuery) {
    jQuery(document).on("shiny:connected", function () { sendRecents(); });
  }
})();
