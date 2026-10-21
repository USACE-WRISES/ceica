// CEICA's page boot: the two globals www/ceica.js expects from the Shiny page, as stand-ins.
//
// ceica.js runs unchanged (page/ceica.js is a copy of www/ceica.js). It posts to the server with
// Shiny.setInputValue(id, value, opts) and hears it through handlers it registers with
// Shiny.addCustomMessageHandler(type, fn); and it listens with jQuery(document).on(...) for
// shiny:value (an output drawn) and shiny:connected. It looks for both globals once, as it loads,
// so this script runs just before it (site.ts). The page's controller (src/app/client.ts) takes
// the inputs and answers through window.ceicaBoot; inputs posted before it listens wait here.
//
// The jQuery stand-in offers jQuery(document).on only, and leaves window once ceica.js has run (the
// script after it), so Bootstrap never takes it for jQuery.
(function () {
  "use strict";
  var boot = { listener: null, queued: [], handlers: {}, listeners: {} };
  window.Shiny = {
    setInputValue: function (id, value, opts) {
      if (boot.listener) boot.listener(id, value, opts || {});
      else boot.queued.push([id, value, opts || {}]);
    },
    // shiny.js refuses a handler that does not take exactly one argument (CONTRIBUTING.md, rule 10)
    addCustomMessageHandler: function (type, handler) {
      if (typeof handler !== "function") throw "handler must be a function.";
      if (handler.length !== 1) throw "handler must be a function that takes one argument.";
      boot.handlers[type] = handler;
    }
  };
  window.jQuery = function (target) {
    if (target !== document) throw new Error("CEICA's page offers jQuery(document) only");
    return {
      on: function (events, handler) {
        String(events).split(/\s+/).forEach(function (name) {
          if (name) (boot.listeners[name] = boot.listeners[name] || []).push(handler);
        });
        return this;
      }
    };
  };
  window.ceicaBoot = boot;
})();
