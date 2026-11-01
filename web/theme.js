// Wygląd: motyw (jasny / ciemny / jak w telefonie) i zestaw kolorów. Ładowany w <head>, żeby nie mignęło.
(function () {
  var P = {
    niebieski: { n: 'Niebieski + fiolet', l: ['#2F5BEA', '#6D3FE0'], d: ['#7D9BFF', '#A58BFF'] },
    fiolet: { n: 'Fiolet + niebieski', l: ['#6D3FE0', '#2F5BEA'], d: ['#A58BFF', '#7D9BFF'] },
    indygo: { n: 'Indygo + śliwka', l: ['#4338CA', '#9333EA'], d: ['#8B85FF', '#C084FC'] },
    lazur: { n: 'Lazur + lawenda', l: ['#0B6BCB', '#7048E8'], d: ['#6CB4FF', '#B197FC'] },
  };
  function get(k, d) { try { var v = localStorage.getItem('onz_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    var t = get('theme', 'light'), p = P[get('accent', 'niebieski')] || P.niebieski;
    var dark = t === 'dark' || (t === 'auto' && mq && mq.matches), r = document.documentElement;
    r.dataset.theme = dark ? 'dark' : 'light';
    var c = dark ? p.d : p.l;
    r.style.setProperty('--accent', c[0]); r.style.setProperty('--violet', c[1]); r.style.setProperty('--vbtn', p.l[1]);
    r.style.setProperty('--promo', c[1]); r.style.setProperty('--s-l', c[0]);
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.THEME = { presets: P, apply: apply };
  apply();
})();
