// precache.js
// Robust service-worker registration helper for Abrox.
// - Registers /sw.js on window load (if supported)
// - Logs install/update lifecycle events
// - Exposes window._abrox._sw { ready, registration, update, sendMessage } for runtime control
(function PrecacheIIFE(){
  if (!('serviceWorker' in navigator)) {
    console.info('[Abrox] Service workers not supported in this browser — skipping SW registration.');
    return;
  }

  // simple config
  const SW_URL = '/sw.js';
  const SW_SCOPE = '/';
  const LOG_PREFIX = '[Abrox SW]';

  // ensure abrox namespace
  window._abrox = window._abrox || {};
  window._abrox._sw = window._abrox._sw || {};

  // helper to send a postMessage to the active worker
  function sendMessageToWorker(msg){
    try{
      const controller = navigator.serviceWorker.controller;
      if(controller && controller.postMessage){
        controller.postMessage(msg);
        return true;
      }
      // if no controller, try to send to registration.waiting or .active
      if(window._abrox._sw && window._abrox._sw.registration){
        const reg = window._abrox._sw.registration;
        if(reg.waiting && reg.waiting.postMessage){
          reg.waiting.postMessage(msg); return true;
        }
        if(reg.active && reg.active.postMessage){
          reg.active.postMessage(msg); return true;
        }
      }
    }catch(e){
      console.warn(`${LOG_PREFIX} sendMessageToWorker error`, e);
    }
    return false;
  }

  // Expose a Promise that resolves when registration completes (or rejects)
  const readyPromise = new Promise((resolve, reject) => {
    // register on window load to avoid blocking render
    window.addEventListener('load', async () => {
      try{
        console.info(`${LOG_PREFIX} registering service worker: ${SW_URL} (scope: ${SW_SCOPE})`);
        const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        console.info(`${LOG_PREFIX} registration succeeded. scope=${reg.scope}`);

        // store registration
        window._abrox._sw.registration = reg;
        window._abrox._sw.ready = true;
        window._abrox._sw.lastRegisteredAt = Date.now();

        // listen for updatefound on registration
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          console.info(`${LOG_PREFIX} updatefound — new worker state:`, newWorker && newWorker.state);
          if(!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            console.info(`${LOG_PREFIX} new worker state changed:`, newWorker.state);
            // when installed and there's already a controller, it's an update (waiting)
            if(newWorker.state === 'installed'){
              if(navigator.serviceWorker.controller){
                console.info(`${LOG_PREFIX} new service worker installed and waiting — call update() to activate it.`);
                // store waiting worker for possible skipWaiting
                window._abrox._sw.waitingWorker = reg.waiting;
              } else {
                console.info(`${LOG_PREFIX} service worker installed for first time (control will take effect on next navigation).`);
              }
            }
            if(newWorker.state === 'activated'){
              console.info(`${LOG_PREFIX} new worker activated.`);
            }
          });
        });

        // controllerchange -> when the active worker controlling the page changes
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          console.info(`${LOG_PREFIX} controllerchange event — a new SW is now controlling the page.`);
          // optionally, we could reload the page if we want to apply new assets immediately:
          // window.location.reload();
        });

        // message events from service worker
        navigator.serviceWorker.addEventListener('message', (ev) => {
          try{
            // re-broadcast on window for app code to listen
            window.dispatchEvent(new CustomEvent('abrox:sw:message', { detail: ev.data }));
            // also store last message
            window._abrox._sw.lastMessage = ev.data;
            console.debug(`${LOG_PREFIX} message from SW:`, ev.data);
          }catch(e){
            console.warn(`${LOG_PREFIX} message handling failed`, e);
          }
        });

        // expose update helper to skip waiting (activate new SW immediately)
        window._abrox._sw.update = async function skipWaiting(){
          try{
            const r = window._abrox._sw.registration;
            if(r && r.waiting){
              console.info(`${LOG_PREFIX} requesting waiting worker to skipWaiting()`);
              r.waiting.postMessage({ type: 'SKIP_WAITING' });
              return true;
            }
            console.info(`${LOG_PREFIX} no waiting worker to update.`);
            return false;
          }catch(e){
            console.warn(`${LOG_PREFIX} update() failed`, e);
            return false;
          }
        };

        // expose sendMessage helper
        window._abrox._sw.sendMessage = function(msg){
          return sendMessageToWorker(msg);
        };

        // resolve ready promise
        resolve(reg);
      }catch(err){
        console.error(`${LOG_PREFIX} registration failed:`, err);
        window._abrox._sw.ready = false;
        reject(err);
      }
    });
  });

  // store promise and convenience wrapper
  window._abrox._sw.readyPromise = readyPromise;

  // small convenience: if we already have a controlling worker (e.g. page reload), store it
  try{
    if(navigator.serviceWorker.controller){
      window._abrox._sw.controller = navigator.serviceWorker.controller;
    }
  }catch(e){}

  // helpful log for manual use
  console.info(`${LOG_PREFIX} precache helper initialized. Will attempt registration on window.load.`);

})();
