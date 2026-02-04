// icons.js
// Centralized lucide icon helper for Abrox UI.
// Exposes:
//   window._abrox.iconify(options)        -> debounced icon render (safe)
//   window._abrox.iconifyNow(options)     -> immediate render (safe)
//   window._abrox.iconify.cancel()        -> cancel pending scheduled render
//
// options forwarded to lucide.createIcons(options) if provided.

(function iconsHelperIIFE(){
  if(window._abrox && window._abrox._iconsLoaded) return;
  window._abrox = window._abrox || {};
  window._abrox._iconsLoaded = true;

  // debounce schedule handle
  let scheduled = null;
  let lastOpts = null;

  // small scheduler using requestIdleCallback when available, falling back to setTimeout
  function scheduleRun(fn, delay = 60){
    if(typeof window.requestIdleCallback === 'function'){
      return window.requestIdleCallback(fn, { timeout: delay });
    }
    return setTimeout(fn, delay);
  }

  function cancelRun(handle){
    try{
      if(typeof handle === 'number'){
        if(typeof window.cancelIdleCallback === 'function') { try{ window.cancelIdleCallback(handle); return; }catch(e){} }
        clearTimeout(handle);
      } else if(handle && typeof handle === 'object' && typeof handle.cancel === 'function'){
        try{ handle.cancel(); }catch(e){}
      }
    }catch(e){}
  }

  // safe invocation wrapper around lucide.createIcons
  function createIconsSafe(opts){
    try{
      // lucide might not be loaded yet; guard
      if(typeof lucide === 'undefined' || !lucide || typeof lucide.createIcons !== 'function'){
        // try a best-effort load fallback: if lucide script not present, do nothing
        return;
      }
      // call lucide createIcons with options (if provided)
      lucide.createIcons(opts || {});
    }catch(e){
      // don't let icon errors bubble out and break UI scripts
      console.warn('iconify createIcons failed', e);
    }
  }

  // debounced public iconify
  function iconify(opts){
    lastOpts = opts || lastOpts;
    // if there is an existing scheduled run, cancel it and schedule again
    if(scheduled){
      try{ cancelRun(scheduled); }catch(e){}
      scheduled = null;
    }
    scheduled = scheduleRun(function(){
      scheduled = null;
      createIconsSafe(lastOpts);
    }, 40);
  }

  // immediate (synchronous-ish) render: run now (but still safe)
  function iconifyNow(opts){
    // if pending scheduled run exists, cancel it to avoid double work
    if(scheduled){
      try{ cancelRun(scheduled); }catch(e){}
      scheduled = null;
    }
    createIconsSafe(opts || lastOpts);
  }

  // cancel pending scheduled iconify
  iconify.cancel = function(){ if(scheduled) { try{ cancelRun(scheduled); }catch(e){} scheduled = null; } };

  // expose to window._abrox
  window._abrox.iconify = iconify;
  window._abrox.iconifyNow = iconifyNow;
  window._abrox.iconify.cancel = iconify.cancel;

  // auto-run a safe first iconify after a short delay so static icons render nicely
  setTimeout(function(){
    try{ iconify({}); }catch(e){}
  }, 200);

  console.info('icons.js loaded — centralized lucide helper available as window._abrox.iconify');
})();
