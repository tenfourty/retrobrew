// The Business / Party switch on the public pages. It loads in <head>, so a viewer who chose
// Party in the app sees Party here before the page paints. It shares the app's stored choice.
(function () {
  var KEY = 'rb-mode';
  var root = document.documentElement;
  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function storedMode() {
    try { return localStorage.getItem(KEY) === 'party' ? 'party' : 'business'; } catch (e) { return 'business'; }
  }
  function currentMode() {
    return (root.getAttribute('data-theme') || '').indexOf('party') === 0 ? 'party' : 'business';
  }
  function apply(mode) {
    root.setAttribute('data-theme', mode + '-' + (dark && dark.matches ? 'dark' : 'light'));
    var switches = document.querySelectorAll('[data-mode-switch]');
    for (var i = 0; i < switches.length; i++) switches[i].setAttribute('aria-checked', mode === 'party' ? 'true' : 'false');
  }
  function flip() {
    var next = currentMode() === 'party' ? 'business' : 'party';
    apply(next);
    var cls = next === 'party' ? 'rb-party-burst' : 'rb-business-settle';
    root.classList.remove('rb-party-burst', 'rb-business-settle');
    void root.offsetWidth;
    root.classList.add(cls);
    setTimeout(function () { root.classList.remove(cls); }, 700);
    try { localStorage.setItem(KEY, next); } catch (e) { /* storage may be blocked */ }
  }

  apply(storedMode());
  if (dark && dark.addEventListener) dark.addEventListener('change', function () { apply(currentMode()); });
  document.addEventListener('DOMContentLoaded', function () {
    var switches = document.querySelectorAll('[data-mode-switch]');
    for (var i = 0; i < switches.length; i++) {
      switches[i].addEventListener('click', flip);
      switches[i].hidden = false;
    }
    apply(currentMode());
  });
})();
