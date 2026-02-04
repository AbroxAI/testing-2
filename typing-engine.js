// typing-engine.js
// Passive typing indicator engine for Abrox chat UI.
// Driven explicitly by SimulationEngine or manual calls.
// Public API:
//   TypingEngine.configure(opts)
//   TypingEngine.triggerTyping(names, durationMs)
//   TypingEngine.clear()
//   TypingEngine.isActive()
//   TypingEngine.simulateOnce(count)
//
// Behavior notes:
// - Prefers window._abrox.showTyping(names) if provided by ui-adapter
// - Falls back to #typingRow / #typingText UI elements
// - When names omitted, samples from window.sampleMembers or window.SyntheticPeople.people
// - Deterministic sampling if configured with seedBase

(function globalTypingEngine(){
  if (window.TypingEngine) return;

  /* ---------------- seeded RNG (optional) ---------------- */
  function xorshift32(seed){
    let x = (seed >>> 0) || 0x811c9dc5;
    return function(){
      x |= 0;
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17; x >>>= 0;
      x ^= x << 5;  x >>>= 0;
      return (x >>> 0) / 4294967296;
    };
  }

  /* ---------------- helpers ---------------- */
  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
  function ensureArray(v){ if(!v) return []; if(Array.isArray(v)) return v; return [v]; }
  function pickRandomFrom(arr, rnd){ if(!arr || !arr.length) return null; return arr[Math.floor(rnd()*arr.length)]; }
  function safeCall(fn, ...args){ try{ if(typeof fn === 'function') return fn(...args); }catch(e){ console.warn('TypingEngine safeCall error', e); } }

  /* ---------------- defaults ---------------- */
  const DEFAULTS = {
    seedBase: null,
    minDurationMs: 300,
    maxNames: 6,
    autoDurationPerNameMs: 900,
    autoDurationMinMs: 700,
    autoDurationMaxMs: 6000
  };

  let cfg = Object.assign({}, DEFAULTS);
  let rnd = Math.random;
  let active = false;
  let clearTimer = null;

  /* ---------------- UI hook ---------------- */
  function showTypingUI(names){
    try{
      // Prefer global UI adapter if exposed
      if (window._abrox && typeof window._abrox.showTyping === 'function'){
        window._abrox.showTyping(names || []);
        return;
      }

      const row  = document.getElementById('typingRow');
      const text = document.getElementById('typingText');
      const membersRow = document.getElementById('membersRow');

      if (!row || !text) return;

      if (!names || !names.length){
        row.classList.remove('active');
        if (membersRow) membersRow.classList.remove('hidden');
        text.textContent = '';
        return;
      }

      // Format the typing text (1,2 or n people)
      if (names.length === 1){
        text.textContent = `${names[0]} is typing…`;
      } else if (names.length === 2){
        text.textContent = `${names[0]} and ${names[1]} are typing…`;
      } else {
        text.textContent = `${names.length} people are typing…`;
      }

      row.classList.add('active');
      if (membersRow) membersRow.classList.add('hidden');
    } catch (e){
      console.warn('TypingEngine showTypingUI error', e);
    }
  }

  function clearTypingUI(){
    try{
      if (window._abrox && typeof window._abrox.showTyping === 'function'){
        window._abrox.showTyping([]);
      }
    } catch (e){ /* ignore */ }

    const row = document.getElementById('typingRow');
    const text = document.getElementById('typingText');
    const membersRow = document.getElementById('membersRow');

    if (row) row.classList.remove('active');
    if (text) text.textContent = '';
    if (membersRow) membersRow.classList.remove('hidden');

    active = false;
  }

  /* ---------------- public API ---------------- */
  const TypingEngine = {
    configure(opts = {}){
      if (opts.seedBase !== undefined){
        cfg.seedBase = opts.seedBase === null ? null : Number(opts.seedBase);
        rnd = cfg.seedBase != null ? xorshift32(cfg.seedBase) : Math.random;
      }
      if (opts.minDurationMs !== undefined) cfg.minDurationMs = Math.max(20, Number(opts.minDurationMs));
      if (opts.maxNames !== undefined) cfg.maxNames = clamp(Number(opts.maxNames), 1, 20);
      if (opts.autoDurationPerNameMs !== undefined) cfg.autoDurationPerNameMs = Math.max(50, Number(opts.autoDurationPerNameMs));
      if (opts.autoDurationMinMs !== undefined) cfg.autoDurationMinMs = Math.max(20, Number(opts.autoDurationMinMs));
      if (opts.autoDurationMaxMs !== undefined) cfg.autoDurationMaxMs = Math.max(cfg.autoDurationMinMs, Number(opts.autoDurationMaxMs));
      cfg = Object.assign({}, cfg, opts || {});
      return Object.assign({}, cfg);
    },

    /**
     * Trigger typing UI.
     * names: array|string|null -> names to show; if falsy, will attempt to pick random names from sampleMembers/SyntheticPeople.
     * durationMs: number|null -> explicit duration to show typing. If omitted, auto compute based on names count.
     */
    triggerTyping(names, durationMs){
      // normalize names
      let provided = ensureArray(names).filter(Boolean);

      // if no names provided, attempt to sample from available members for realism
      if (!provided.length){
        try{
          // try window.sampleMembers first (UI glue populates this)
          if (Array.isArray(window.sampleMembers) && window.sampleMembers.length){
            const maxPick = Math.min(cfg.maxNames, Math.max(1, Math.floor(rnd()*Math.min(4, window.sampleMembers.length)) + 1));
            const pick = [];
            for(let i=0;i<maxPick;i++){
              const choice = window.sampleMembers[Math.floor(rnd()*window.sampleMembers.length)];
              if(choice && choice.displayName) pick.push(choice.displayName);
            }
            provided = pick.length ? pick : provided;
          }
          // fallback to SyntheticPeople
          if (!provided.length && window.SyntheticPeople && Array.isArray(window.SyntheticPeople.people) && window.SyntheticPeople.people.length){
            const maxPick = Math.min(cfg.maxNames, Math.max(1, Math.floor(rnd()*Math.min(4, window.SyntheticPeople.people.length)) + 1));
            const pick = [];
            for(let i=0;i<maxPick;i++){
              const p = pickRandomFrom(window.SyntheticPeople.people, rnd);
              if(p) pick.push(p.displayName || p.name);
            }
            provided = pick.length ? pick : provided;
          }
        }catch(e){
          // ignore sampling errors
        }
      }

      // as last resort, if still empty, use generic label
      if (!provided.length) provided = ['Someone'];

      // clamp max names
      provided = provided.slice(0, cfg.maxNames);

      // compute duration
      let dur = cfg.minDurationMs;
      if (typeof durationMs === 'number' && !isNaN(durationMs)){
        dur = Math.max(cfg.minDurationMs, Number(durationMs));
      } else {
        // auto: base per name, clamped
        dur = Math.round(provided.length * cfg.autoDurationPerNameMs);
        dur = clamp(dur, cfg.autoDurationMinMs, cfg.autoDurationMaxMs);
      }

      // clear existing timer
      if (clearTimer){
        clearTimeout(clearTimer);
        clearTimer = null;
      }

      active = true;
      showTypingUI(provided);

      clearTimer = setTimeout(() => {
        clearTypingUI();
        clearTimer = null;
      }, dur);
    },

    clear(){
      if (clearTimer){
        clearTimeout(clearTimer);
        clearTimer = null;
      }
      clearTypingUI();
    },

    isActive(){
      return !!active;
    },

    /**
     * Convenience helper: pick a small random group and trigger typing once.
     * count: optional number of names to show (default random 1..3)
     */
    simulateOnce(count){
      try{
        let n = Number(count) || 0;
        if (!n || n <= 0) n = 1 + Math.floor(rnd()*3);
        const names = [];
        if (Array.isArray(window.sampleMembers) && window.sampleMembers.length){
          for(let i=0;i<n;i++){
            const p = window.sampleMembers[Math.floor(rnd()*window.sampleMembers.length)];
            if(p && p.displayName) names.push(p.displayName);
          }
        } else if (window.SyntheticPeople && Array.isArray(window.SyntheticPeople.people) && window.SyntheticPeople.people.length){
          for(let i=0;i<n;i++){
            const p = pickRandomFrom(window.SyntheticPeople.people, rnd);
            if(p) names.push(p.displayName || p.name);
          }
        } else {
          for(let i=0;i<n;i++) names.push('Member ' + (1 + Math.floor(rnd()*999)));
        }
        this.triggerTyping(names);
      }catch(e){
        console.warn('TypingEngine.simulateOnce failed', e);
      }
    }
  };

  // expose globally
  window.TypingEngine = TypingEngine;
  // convenience alias on _abrox
  window._abrox = window._abrox || {};
  window._abrox.TypingEngine = TypingEngine;

  // initialize default RNG (honor default seedBase if present)
  if (cfg.seedBase != null) rnd = xorshift32(cfg.seedBase);

  console.info('TypingEngine loaded (passive; driven by SimulationEngine or manual calls).');
})();
