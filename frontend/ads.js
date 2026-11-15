// Loads Google AdSense only when you have filled in config.js.
// Ads stay outside the game area so nobody taps one by accident while playing.
(() => {
  const c = window.RR_CONFIG || {};
  const slots = document.querySelectorAll('.ad');

  if (!c.ADSENSE_CLIENT) {
    slots.forEach((el) => {
      if (c.SHOW_AD_PLACEHOLDER) {
        el.textContent = 'Ad space. Add your AdSense IDs in config.js.';
        el.classList.add('ad-empty');
      } else {
        el.hidden = true;
      }
    });
    return;
  }

  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(c.ADSENSE_CLIENT);
  document.head.appendChild(s);

  slots.forEach((el) => {
    const slot = c['ADSENSE_SLOT_' + el.dataset.slot];
    if (!slot) { el.hidden = true; return; }
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.dataset.adClient = c.ADSENSE_CLIENT;
    ins.dataset.adSlot = slot;
    ins.dataset.adFormat = 'auto';
    ins.dataset.fullWidthResponsive = 'true';
    el.appendChild(ins);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) { /* ad blocked */ }
  });
})();
