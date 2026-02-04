// presence-manager.js
// PresenceManager: drives a realistic online-count and small presence nudges.
// Exposes window._abrox.PresenceManager with start/stop/config/tickNow/getVisibleOnline
(function PresenceManagerIIFE(){
  // avoid double-load
  if(window._abrox && window._abrox.PresenceManager) return;

  const DEFAULTS = {
    baselineOnline: 76,     // visible baseline starting online count
    minOnline: 60,          // never drop below this
    maxOnline: 250,         // maximum plausible online
    tickMs: 15_000,         // how often to update presence (ms)
    nudgePercent: 0.02,     // percent of members nudged each tick if below baseline
    simulateStepPercent: 0.01, // percent used if calling SyntheticPeople.simulatePresenceStep
    jitterMs: 90 * 1000     // lastActive threshold for "online" (90s)
  };

  function xorshift32(seed){
    let x = (seed>>>0) || 0x811c9dc5;
    return function(){ x |= 0; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0; return (x >>> 0) / 4294967296; };
  }

  // state
  const state = {
    opts: Object.assign({}, DEFAULTS),
    running: false,
    timerId: null,
    rnd: Math.random
  };

  // helper: canonical member list
  function getMemberList(){
    if(Array.isArray(window.sampleMembers) && window.sampleMembers.length) return window.sampleMembers;
    if(window.SyntheticPeople && Array.isArray(window.SyntheticPeople.people) && window.SyntheticPeople.people.length) return window.SyntheticPeople.people;
    return [];
  }

  // compute how many are currently "online" based on lastActive
  function computeRealOnline(list){
    if(!list || !list.length) return 0;
    const now = Date.now();
    const thresh = state.opts.jitterMs;
    let c = 0;
    for(let i=0;i<list.length;i++){
      try{
        if(now - (list[i].lastActive || 0) < thresh) c++;
      }catch(e){}
    }
    return c;
  }

  // nudge some members to be "online" (update lastActive) to hit baseline
  function nudgeToBaseline(list, need){
    if(!list || !list.length || need <= 0) return 0;
    const rnd = state.rnd;
    const chosen = new Set();
    const available = list.length;
    let attempts = 0;
    // ensure at least one nudged when need > 0
    const toNudge = Math.min(need, Math.max(1, Math.round(state.opts.nudgePercent * available)));
    while(chosen.size < toNudge && attempts < toNudge * 8){
      const idx = Math.floor(rnd() * available);
      const p = list[idx];
      if(!p) { attempts++; continue; }
      if(Date.now() - (p.lastActive || 0) < state.opts.jitterMs) { attempts++; continue; } // already online
      // set lastActive to now minus a small jitter (fresh)
      p.lastActive = Date.now() - Math.floor((rnd()*0.8 + 0.1) * 60 * 1000); // ~6s..48s
      chosen.add(idx);
      attempts++;
    }
    return chosen.size;
  }

  // softly reduce online count if it's unrealistically high
  function decaySomeToIdle(list, excess){
    if(!list || !list.length || excess <= 0) return 0;
    const rnd = state.rnd;
    let decayed = 0;
    for(let i=0;i<list.length && decayed < excess;i++){
      const p = list[i];
      if(!p) continue;
      if(Date.now() - (p.lastActive || 0) < state.opts.jitterMs){
        if(rnd() < 0.5){
          p.lastActive = Date.now() - (5*60*1000) - Math.round(rnd()*25*60*1000);
          decayed++;
        }
      }
    }
    return decayed;
  }

  // compute visible online (real + nudges) then clamp
  function computeVisibleOnline(){
    const list = getMemberList();
    let visible = computeRealOnline(list);
    if(visible < state.opts.baselineOnline){
      const need = state.opts.baselineOnline - visible;
      const nudged = nudgeToBaseline(list, need);
      visible += nudged;
    }
    visible = Math.max(state.opts.minOnline, Math.min(state.opts.maxOnline, visible));
    return visible;
  }

  // update UI elements (#onlineCount and #memberCount)
  function updateUICounts(){
    const list = getMemberList();
    const total = (list && list.length) ? list.length : (document.getElementById('memberCount') ? Number(document.getElementById('memberCount').textContent.replace(/[, ]/g,'')) || 0 : 0);
    const pc = document.getElementById('memberCount');
    if(pc && total) pc.textContent = total.toLocaleString();

    const onlineEl = document.getElementById('onlineCount');
    if(!onlineEl) return;
    let visible = computeVisibleOnline();
    // organic jitter ± up to 6 people
    const jitter = Math.round((state.rnd() - 0.5) * 12);
    visible = Math.max(state.opts.minOnline, Math.min(state.opts.maxOnline, visible + jitter));
    onlineEl.textContent = visible.toLocaleString();
  }

  // single tick
  function tick(){
    try{
      try{ if(window.SyntheticPeople && typeof window.SyntheticPeople.simulatePresenceStep === 'function'){ window.SyntheticPeople.simulatePresenceStep({ percent: state.opts.simulateStepPercent }); } }catch(e){}
      const list = getMemberList();
      const real = computeRealOnline(list);
      if(real < state.opts.baselineOnline){
        const need = state.opts.baselineOnline - real;
        nudgeToBaseline(list, need);
      } else if(real > state.opts.maxOnline){
        decaySomeToIdle(list, real - state.opts.maxOnline);
      }
      updateUICounts();
    }catch(e){
      console.warn('PresenceManager tick error', e);
    }
  }

  // API
  const PresenceManager = {
    configure(opts = {}){
      Object.assign(state.opts, opts || {});
      if(opts.seedBase !== undefined){
        const sb = opts.seedBase;
        state.rnd = (sb === null || sb === undefined) ? Math.random : xorshift32(Number(sb));
      }
      return Object.assign({}, state.opts);
    },

    start(){
      if(state.running) return;
      state.running = true;
      updateUICounts();
      tick(); // initial
      state.timerId = setInterval(tick, state.opts.tickMs);
    },

    stop(){
      state.running = false;
      if(state.timerId){ clearInterval(state.timerId); state.timerId = null; }
    },

    tickNow(){
      tick();
    },

    setBaseline(n){
      state.opts.baselineOnline = Math.max(0, Number(n)||0);
      updateUICounts();
    },

    getVisibleOnline(){
      const el = document.getElementById('onlineCount');
      return el ? Number(el.textContent.replace(/,/g,'')) : computeVisibleOnline();
    },

    _state(){ return Object.assign({}, state); }
  };

  // expose to window._abrox
  window._abrox = window._abrox || {};
  window._abrox.PresenceManager = PresenceManager;

  // auto-start after a short delay unless disabled
  setTimeout(()=>{
    try{
      if(!window._abrox || !window._abrox.disablePresenceAutoStart) PresenceManager.start();
    }catch(e){}
  }, 800);

  console.info('PresenceManager loaded — baselineOnline:', state.opts.baselineOnline);
})();
