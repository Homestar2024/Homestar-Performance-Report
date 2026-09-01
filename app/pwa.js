/**
 * Installable offline app: connection notice and service-worker updates.
 */

/* ======================= Installable / offline app =======================
 *
 * Registering the worker is what makes the app usable with no signal. The
 * update path is deliberately opt-in: a new version installs and then WAITS,
 * and the tech reloads when it suits them. Reloading someone out of a
 * half-finished report to ship a CSS tweak is not a trade worth making.
 */

function showOffline(){
  $('offlineStrip').hidden = navigator.onLine;
}
window.addEventListener('online', showOffline);
window.addEventListener('offline', showOffline);
showOffline();

if ('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('./sw.js').then(reg=>{
      const offer = worker => {
        if (!worker) return;
        $('updateStrip').hidden = false;
        $('updateNow').onclick = ()=>{
          $('updateNow').disabled = true;
          worker.postMessage({type:'SKIP_WAITING'});
        };
      };
      // Already waiting from a previous visit.
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', ()=>{
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', ()=>{
          // A first install has no controller — that is not an update, it is
          // the app becoming available offline for the first time.
          if (incoming.state === 'installed' && navigator.serviceWorker.controller) offer(reg.waiting || incoming);
        });
      });
    }).catch(err=>console.warn('offline mode unavailable:', err));

    // The first install claims the page, which also fires controllerchange —
    // that is the app becoming available offline, not a new version taking
    // over, and reloading there would bounce the page on every first visit.
    let hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{
      if (!hadController){ hadController = true; return; }
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });
}
