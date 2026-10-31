// News pages only. Set these public settings in config.js after Google approves
// the site and supplies its own publisher ID. No ad requests are made by default.
// window.OBIT_ADSENSE = { approved: true, client: 'ca-pub-<your 16-digit ID>' };
(() => {
  const settings = window.OBIT_ADSENSE;
  if (!settings || settings.approved !== true || !/^ca-pub-\d{16}$/.test(settings.client)) return;
  if (document.querySelector('script[data-obit-adsense]')) return;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.dataset.obitAdsense = '';
  script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + settings.client;
  document.head.append(script);
})();
