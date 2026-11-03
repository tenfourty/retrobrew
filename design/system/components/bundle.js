/* @ds-bundle: {"format":4,"namespace":"Retrobrew","components":[{"name":"ModeSwitch"},{"name":"Button"},{"name":"StateChip"},{"name":"Column"},{"name":"TopicCard"},{"name":"VoteDots"},{"name":"VoteBudget"},{"name":"DialTimer"},{"name":"TimeUpVote"},{"name":"TopicInput"},{"name":"AttendeeChip"},{"name":"Badge"},{"name":"Sheet"},{"name":"ConfirmDialog"},{"name":"QrPanel"},{"name":"Banner"},{"name":"Switch"},{"name":"Segmented"},{"name":"OutcomeLine"},{"name":"ActionBar"},{"name":"ActionList"},{"name":"ColumnGroup"},{"name":"Tabs"},{"name":"StatusStrip"},{"name":"EndedSummary"},{"name":"Select"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(" "); }

  var STATE_LABEL = { ideas: "Ideas", todiscuss: "To discuss", discussing: "Discussing", discussed: "Discussed" };

  /* ---- mode helpers: Business at the front, Party at the back ---- */
  function getMode() {
    var t = document.documentElement.getAttribute("data-theme") || "business-light";
    return t.indexOf("party") === 0 ? "party" : "business";
  }
  function getShade() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t) return /dark$/.test(t) ? "dark" : "light";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setMode(mode) {
    var root = document.documentElement;
    root.setAttribute("data-theme", mode + "-" + getShade());
    var cls = mode === "party" ? "rb-party-burst" : "rb-business-settle";
    root.classList.remove("rb-party-burst", "rb-business-settle");
    void root.offsetWidth;
    root.classList.add(cls);
    setTimeout(function () { root.classList.remove(cls); }, 700);
    try { window.dispatchEvent(new CustomEvent("rb-mode", { detail: mode })); } catch (e) {}
  }
  function useMode() {
    var s = useState(getMode()), mode = s[0], set = s[1];
    useEffect(function () {
      function on() { set(getMode()); }
      window.addEventListener("rb-mode", on);
      var mo = new MutationObserver(on);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return function () { window.removeEventListener("rb-mode", on); mo.disconnect(); };
    }, []);
    return mode;
  }

  function ModeSwitch(props) {
    var live = useMode();
    var mode = props.mode || live;
    var party = mode === "party";
    return h("button", {
      type: "button", role: "switch", "aria-checked": party ? "true" : "false",
      "aria-label": "Party mode", className: cx("rb-switch", props.className),
      onClick: function () {
        var next = party ? "business" : "party";
        if (props.onChange) props.onChange(next);
        if (props.applyToPage !== false) setMode(next);
      }
    }, h("span", { className: "rb-sw-biz" }, "Business"), h("span", { className: "rb-sw-party" }, "Party"));
  }

  function Button(props) {
    var variant = props.variant || "primary";
    var rest = Object.assign({}, props); delete rest.variant; delete rest.size;
    rest.className = cx("rb-btn", "rb-btn-" + variant, props.size === "sm" && "rb-btn-sm", props.className);
    if (!rest.type) rest.type = "button";
    return h("button", rest, props.children);
  }

  function StateChip(props) {
    var state = props.state || "ideas";
    return h("span", { className: cx("rb-chip", "rb-st-" + state, props.className) },
      props.children || STATE_LABEL[state],
      props.count != null ? h("span", { className: "rb-chip-count" }, props.count) : null);
  }

  function Column(props) {
    var state = props.state || "ideas";
    var kids = React.Children.toArray(props.children);
    return h("section", { className: cx("rb-col", "rb-st-" + state, props.className), "aria-label": props.title || STATE_LABEL[state] },
      h("header", { className: "rb-col-head" }, h(StateChip, { state: state, count: props.count === null ? undefined : props.count != null ? props.count : kids.length }, props.title), props.action || null),
      props.note ? h("p", { className: "rb-col-note" }, props.note) : null,
      kids.length ? kids : h("div", { className: "rb-col-empty" }, props.empty || "Nothing here yet"));
  }

  /* hidden: Show votes is off before the discussion, so only the viewer's own dots show, with "Votes hidden". */
  function VoteDots(props) {
    var n = props.count || 0, mine = props.mine || 0, dots = [];
    if (props.hidden) {
      for (var j = 0; j < Math.min(mine, props.max || 6); j++) dots.push(h("span", { key: j, className: "rb-dot rb-dot-mine" }));
      return h("span", { className: "rb-dots", role: "img", "aria-label": "Votes hidden" + (mine ? ", " + mine + " yours" : "") },
        dots, h("span", { className: "rb-dots-hidden", "aria-hidden": "true" }, "Votes hidden"));
    }
    var shown = Math.min(n, props.max || 6);
    for (var i = 0; i < shown; i++) dots.push(h("span", { key: i, className: cx("rb-dot", i < mine && "rb-dot-mine", props.fresh && i === shown - 1 && "rb-dot-new") }));
    return h("span", { className: "rb-dots", role: "img", "aria-label": n + (n === 1 ? " vote" : " votes") + (mine ? ", " + mine + " yours" : "") },
      dots, n > shown || props.showCount ? h("span", { className: "rb-dots-count" }, n) : null);
  }

  function VoteBudget(props) {
    var total = props.total || 3, used = props.used || 0, dots = [];
    for (var i = 0; i < total; i++) dots.push(h("span", { key: i, className: cx("rb-dot", i >= total - used && "rb-dot-spent") }));
    var left = total - used;
    var words = left === 0 ? "No votes left" : left === 1 ? "1 vote left" : left + " votes left";
    return h("span", { className: "rb-budget" }, h("span", null, words), h("span", { className: "rb-dots", "aria-hidden": "true" }, dots));
  }

  /* actions: the row of small buttons. editing: { label, value, onInput, onSave, onCancel } turns the text into a field
     (Enter saves, Escape cancels). votesHidden: the viewer's own dots only. alert: a refusal from the last action on it. */
  function TopicCard(props) {
    var state = props.state || "ideas";
    var e = props.editing;
    var dots = props.votesHidden ? h(VoteDots, { count: 0, mine: props.mine, hidden: true })
      : props.votes != null ? h(VoteDots, { count: props.votes, mine: props.mine, fresh: props.fresh }) : null;
    var body = e ? h("form", { className: "rb-card-edit", onSubmit: function (ev) { ev.preventDefault(); e.onSave(); } },
        h("label", { className: "rb-visually-hidden", htmlFor: "edit-" + props.number }, e.label),
        h("input", { id: "edit-" + props.number, className: "rb-input", value: e.value, autoFocus: true,
          onChange: function (ev) { e.onInput(capTopic(ev.target.value)); },
          onKeyDown: function (ev) { if (ev.key === "Escape") { ev.preventDefault(); e.onCancel(); } } }),
        h("div", { className: "rb-card-actions" },
          h(Button, { type: "submit", size: "sm", variant: "primary" }, "Save"),
          h(Button, { size: "sm", variant: "ghost", onClick: e.onCancel }, "Cancel")))
      : h("p", { className: "rb-card-text" }, props.text);
    return h("article", { className: cx("rb-card", "rb-st-" + state, props.live && "rb-card-live", props.className) },
      body,
      props.children || null,
      h("div", { className: "rb-card-foot" },
        h("span", null, props.author || "", props.number != null ? h("span", { className: "rb-card-num" }, " \u00b7 #" + props.number) : null),
        h("span", { className: "rb-dots" }, dots)),
      props.alert ? h("p", { className: "rb-card-alert" }, props.alert) : null,
      props.actions && !e ? h("div", { className: "rb-card-actions" }, props.actions) : null);
  }

  /* m:ss in both modes, in tabular numerals. */
  function fmt(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ":" + (r < 10 ? "0" + r : r);
  }
  /* warnAt is one timebox minute in seconds: 60, or 10 on a rehearsal timer. No live region of its own:
     the page's single polite live region announces the countdown. */
  function DialTimer(props) {
    var total = props.total || 300, rem = props.remaining != null ? props.remaining : total;
    var warnAt = props.warnAt != null ? props.warnAt : 60;
    var up = rem <= 0, warn = !up && rem <= warnAt;
    var p = up ? 1 : Math.max(0, Math.min(1, rem / total));
    return h("div", { className: cx("rb-timer", warn && "rb-timer-warn", up && "rb-timer-up", props.className), role: "timer" },
      h("div", { className: "rb-dial", style: { "--p": p }, "aria-hidden": "true" }),
      h("div", null,
        h("span", { className: "rb-timer-num" }, up ? "Time's up" : fmt(rem)),
        props.sub ? h("span", { className: "rb-timer-sub" }, props.sub) : null));
  }

  /* Three choices: extend (Keep going), none (No preference), end (Move on). After voting the buttons are disabled and
     the choice shows pressed; voted without a choice (after a reload) says "You've voted". Children: the facilitator's decision. */
  function TimeUpVote(props) {
    var c = props.choice;
    var choices = [["extend", "Keep going"], ["none", "No preference"], ["end", "Move on"]];
    var t = props.totals;
    return h("section", { className: cx("rb-timeup", props.className), "aria-label": "Time-up vote" },
      props.title ? h("h3", null, props.title) : null,
      h("p", { className: "rb-timeup-topic" }, props.topic),
      h("div", { className: "rb-choices", role: "group", "aria-label": "Your vote" }, choices.map(function (x) {
        return h("button", { key: x[0], type: "button", className: "rb-choice", "aria-pressed": c === x[0] ? "true" : "false",
          disabled: props.voted || c !== undefined || props.disabled, onClick: function () { if (props.onChoose) props.onChoose(x[0]); } }, x[1]);
      })),
      props.voted && !c ? h("p", null, "You've voted") : null,
      props.hint && !(props.voted || c !== undefined || props.disabled) ? h("p", null, props.hint) : null,
      t ? h("p", { className: "rb-timeup-totals" }, "Keep going " + t.extend + " \u00b7 No preference " + t.none + " \u00b7 Move on " + t.end) : null,
      props.turnout ? h("p", null, props.turnout) : null,
      props.children ? h("div", { className: "rb-timeup-decision" }, props.children) : null);
  }

  /* A single choice from a row of buttons marked with aria-pressed. options: [{ value, label, disabled }]. */
  function Segmented(props) {
    var labelId = "rb-seg-" + String(props.label).replace(/\W+/g, "-");
    return h("div", { className: "rb-segmented-field", role: "group", "aria-labelledby": labelId },
      h("span", { className: "rb-label", id: labelId }, props.label),
      h("div", { className: "rb-segmented" }, (props.options || []).map(function (o) {
        return h("button", { key: String(o.value), type: "button", className: "rb-segment", "aria-pressed": o.value === props.value ? "true" : "false",
          disabled: o.disabled, onClick: function () { if (props.onChange) props.onChange(o.value); } }, o.label);
      })),
      props.hint ? h("p", { className: "rb-hint" }, props.hint) : null);
  }

  function OutcomeLine(props) {
    return h("p", { className: cx("rb-outcome", props.className) }, props.children);
  }

  /* Topics are 1 to 280 characters, counted as code points, on one line. */
  var TOPIC_MAX = 280, COUNTER_FROM = 240;
  function oneLine(text) { return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " "); }
  function capTopic(text) { return Array.from(oneLine(text)).slice(0, TOPIC_MAX).join(""); }
  /* The value after an edit that left the caret at `caret`: the text the field already had and everything after the caret
     stay, and only what overflowed from the inserted text is cut. Returns the text and the caret to restore. */
  function capAtCaret(previous, next, caret) {
    var at = Math.min(Math.max(caret, 0), next.length), prefix = 0;
    while (prefix < at && prefix < previous.length && previous[prefix] === next[prefix]) prefix++;
    var kept = capTopic(next.slice(0, prefix)), inserted = capTopic(next.slice(prefix, at)), tail = capTopic(next.slice(at));
    var room = TOPIC_MAX - Array.from(kept).length - Array.from(tail).length;
    if (room < 0) { var all = capTopic(next); return { text: all, caret: Math.min(at, all.length) }; }
    var cut = Array.from(inserted).slice(0, room).join("");
    return { text: kept + cut + tail, caret: (kept + cut).length };
  }
  function TopicInput(props) {
    var s = useState(""), own = s[0], setOwn = s[1];
    var v = props.value != null ? props.value : own;
    function set(next) { if (props.onValueChange) props.onValueChange(next); if (props.value == null) setOwn(next); }
    var length = Array.from(v).length;
    function take(input) {
      var r = capAtCaret(v, input.value, input.selectionStart != null ? input.selectionStart : input.value.length);
      if (r.text !== input.value) { input.value = r.text; input.setSelectionRange(r.caret, r.caret); }
      set(r.text);
    }
    function submit(e) { e.preventDefault(); var t = v.trim(); if (!t) return; if (props.onAdd) props.onAdd(t); set(""); }
    return h("form", { className: cx("rb-add", props.className), onSubmit: submit },
      h("label", { htmlFor: props.id || "rb-topic", className: "rb-visually-hidden" }, "New topic"),
      h("input", { id: props.id || "rb-topic", className: "rb-input", value: v, placeholder: props.placeholder || "Add a topic", "aria-describedby": length >= COUNTER_FROM ? (props.id || "rb-topic") + "-count" : undefined, enterKeyHint: "send",
        onInput: function (e) { if (e.nativeEvent && e.nativeEvent.isComposing) set(e.target.value); else take(e.target); }, onCompositionEnd: function (e) { take(e.target); }, onFocus: props.onFocus, onBlur: props.onBlur }),
      h(Button, { type: "submit", variant: "primary", onMouseDown: function (e) { e.preventDefault(); } }, props.cta || "Add topic"),
      length >= COUNTER_FROM ? h("p", { className: "rb-add-count", id: (props.id || "rb-topic") + "-count" }, TOPIC_MAX - length === 1 ? "1 character left" : Math.max(0, TOPIC_MAX - length) + " characters left") : null,
      props.hint ? h("p", { className: "rb-add-hint" }, props.hint) : null);
  }

  function AttendeeChip(props) {
    var initials = (props.name || "?").split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    return h("span", { className: cx("rb-person", props.className) },
      h("span", { className: "rb-avatar", "data-presence": props.online ? "online" : "away", "aria-hidden": "true" }, initials),
      h("span", null, h("span", { className: "rb-person-name" }, props.name), props.role ? h("span", { className: "rb-person-role" }, " · " + props.role) : null),
      props.handRaised ? h("span", { className: "rb-hand" }, "Hand up" + (props.queue ? " · " + props.queue : "")) : null);
  }

  function Badge(props) {
    return h("span", { className: cx("rb-badge", props.className) }, props.children);
  }

  /* A native modal <dialog>: the page behind is inert and Escape closes it. Phones: from the bottom; wide: centred. */
  function Sheet(props) {
    var ref = React.useRef(null);
    useEffect(function () {
      var d = ref.current;
      if (!d) return;
      if (props.open && !d.open) d.showModal();
      if (!props.open && d.open) d.close();
    }, [props.open]);
    return h("dialog", { ref: ref, className: cx("rb-sheet", props.className), "aria-label": props.title,
        onCancel: function (e) { e.preventDefault(); if (props.onClose) props.onClose(); } },
      h("div", { className: "rb-sheet-head" }, h("h2", { className: "rb-sheet-title" }, props.title),
        props.noClose ? null : h(Button, { variant: "ghost", size: "sm", onClick: props.onClose }, "Close")),
      h("div", { className: "rb-sheet-body" }, props.children));
  }

  /* Other actions first, the danger action last but one, Cancel last. */
  function ConfirmDialog(props) {
    var actions = (props.actions || []).filter(function (a) { return a.variant !== "danger"; })
      .concat((props.actions || []).filter(function (a) { return a.variant === "danger"; }));
    return h(Sheet, { open: props.open, title: props.title, onClose: props.onCancel, noClose: true, className: "rb-confirm" },
      h("div", { className: "rb-confirm-body" }, props.body),
      h("div", { className: "rb-confirm-actions" },
        actions.map(function (a) { return h(Button, { key: a.label, variant: a.variant, onClick: a.onClick }, a.label); }),
        h(Button, { variant: "ghost", onClick: props.onCancel }, props.cancelLabel || "Cancel")));
  }

  /* The light ground for a QR code; pass the code (an <svg role="img" aria-label=…>) as children. */
  function QrPanel(props) {
    return h("div", { className: cx("rb-qr", props.className) }, props.children);
  }

  /* tone: info, warning or error. action: { label, onClick } adds a small secondary button. */
  function Banner(props) {
    return h("div", { className: cx("rb-banner", "rb-banner-" + (props.tone || "info"), props.className) },
      h("p", { className: "rb-banner-text" }, props.children),
      props.action ? h(Button, { variant: "secondary", size: "sm", onClick: props.action.onClick }, props.action.label) : null);
  }

  /* An on/off control. The label is the button's own text, so the whole row is the tap target. */
  function Switch(props) {
    var hints = [].concat(props.hint || []);
    var base = "rb-switch-hint-" + String(props.label).replace(/\W+/g, "-");
    return h("div", { className: "rb-toggle-field" },
      h("button", { type: "button", role: "switch", className: "rb-toggle", "aria-checked": props.checked ? "true" : "false", disabled: props.disabled,
          "aria-describedby": hints.length ? hints.map(function (_, i) { return base + "-" + i; }).join(" ") : undefined,
          onClick: function () { if (props.onChange) props.onChange(!props.checked); } },
        h("span", { className: "rb-toggle-track", "aria-hidden": "true" }, h("span", { className: "rb-toggle-thumb" })),
        h("span", null, props.label)),
      hints.map(function (hint, i) { return h("p", { key: hint, className: "rb-hint", id: base + "-" + i }, hint); }));
  }

  /* stacked: the wide side-panel block; otherwise the phone bar (pass the primary last, so it sits on the right). */
  function ActionBar(props) {
    return h("div", { className: cx(props.stacked ? "rb-actionbar-stack" : "rb-actionbar", props.className), role: "group", "aria-label": props.label }, props.children);
  }

  /* actions: [{ label, onClick, variant, disabled }], full width, one per row. */
  function ActionList(props) {
    return h("ul", { className: "rb-action-list" }, (props.actions || []).map(function (a) {
      return h("li", { key: a.label }, h(Button, { variant: a.variant || "secondary", disabled: a.disabled, onClick: a.onClick }, a.label));
    }));
  }

  function ColumnGroup(props) {
    return h("h2", { className: "rb-col-group" }, props.children);
  }

  /* tabs: [{ id, label, count, state }]. Arrow keys, Home and End move and select; panels are role="tabpanel"
     elements with id base + "-panel-" + tab id. */
  function Tabs(props) {
    var tabs = props.tabs || [];
    function tid(id) { return props.base + "-tab-" + id; }
    function move(e, i) {
      var last = tabs.length - 1;
      var next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
        : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
      if (next === -1) return;
      e.preventDefault();
      props.onSelect(tabs[next].id);
      var el = document.getElementById(tid(tabs[next].id));
      if (el) el.focus();
    }
    return h("div", { className: "rb-tabs", role: "tablist", "aria-label": props.label }, tabs.map(function (t, i) {
      var on = t.id === props.selected;
      return h("button", { key: t.id, type: "button", role: "tab", id: tid(t.id), className: cx("rb-tab", t.state && "rb-st-" + t.state),
        "aria-selected": on ? "true" : "false", "aria-controls": props.base + "-panel-" + t.id, tabIndex: on ? 0 : -1,
        onClick: function () { props.onSelect(t.id); }, onKeyDown: function (e) { move(e, i); } },
        t.label, t.count != null ? " " : null, t.count != null ? h("span", { className: "rb-tab-count" }, t.count) : null);
    }));
  }

  /* number, text (already cut to 24 characters and "…"), end (countdown, "No timer" or "Time's up"); idleText when
     nothing is being discussed; chip shows the Vote button. label is the accessible name, with the full topic and no countdown. onChip receives the chip button. */
  function StatusStrip(props) {
    return h("div", { className: cx("rb-strip", props.up && "rb-strip-up") },
      h("button", { type: "button", className: "rb-strip-main", "aria-label": props.label, onClick: props.onOpen },
        props.number == null ? h("span", { className: "rb-strip-text" }, props.idleText)
          : [h("span", { key: "n", className: "rb-strip-num" }, "#" + props.number), h("span", { key: "t", className: "rb-strip-text" }, props.text),
            h("span", { key: "e", className: "rb-strip-end" }, props.end)]),
      props.chip ? h(Button, { variant: "secondary", size: "sm", onClick: function (e) { props.onChip(e.currentTarget); } }, "Vote") : null);
  }

  /* discussed: the finished topics (as TopicCards), numbered 1, 2, 3; notDiscussed: the rest, left out when empty. */
  function EndedSummary(props) {
    var d = props.discussed || [], n = props.notDiscussed || [];
    function li(item, i) { return h("li", { key: i }, item); }
    return h("section", { className: "rb-summary", "aria-label": "Final board" },
      h("h2", { className: "rb-summary-title" }, "Discussed"),
      d.length ? h("ol", { className: "rb-summary-list" }, d.map(li)) : h("p", { className: "rb-summary-none" }, "None"),
      n.length ? h("h2", { className: "rb-summary-title" }, "Not discussed") : null,
      n.length ? h("ul", { className: "rb-summary-list" }, n.map(li)) : null);
  }

  /* options: [{ value, label }], with the label above. */
  function Select(props) {
    var id = "rb-select-" + String(props.label).replace(/\W+/g, "-");
    return h("div", { className: "rb-field" },
      h("label", { className: "rb-label", htmlFor: id }, props.label),
      h("select", { id: id, className: "rb-input rb-select", value: props.value, disabled: props.disabled,
        onChange: function (e) { if (props.onChange) props.onChange(e.target.value); } },
        (props.options || []).map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); })));
  }

  var api = { Select: Select, EndedSummary: EndedSummary, ColumnGroup: ColumnGroup, Tabs: Tabs, StatusStrip: StatusStrip, ActionBar: ActionBar, ActionList: ActionList, Segmented: Segmented, OutcomeLine: OutcomeLine, Banner: Banner, Switch: Switch, Sheet: Sheet, ConfirmDialog: ConfirmDialog, QrPanel: QrPanel, Badge: Badge, ModeSwitch: ModeSwitch, Button: Button, StateChip: StateChip, Column: Column, TopicCard: TopicCard, VoteDots: VoteDots, VoteBudget: VoteBudget, DialTimer: DialTimer, TimeUpVote: TimeUpVote, TopicInput: TopicInput, AttendeeChip: AttendeeChip, setMode: setMode, getMode: getMode, useMode: useMode };
  window.Retrobrew = Object.assign(window.Retrobrew || {}, api);
})();
