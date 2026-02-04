// message-pool.js
// MessagePool: deterministic-ish message generator with timeline support, LRU dedupe, generator view and stream API.
// Public API (global MessagePool):
//   generatePool(opts)
//   regenerateAndInject(opts)             // generate and optionally inject into UI using window.renderMessage
//   preGenerateTemplates(n)               // (optional) pre-generate or load template fragments
//   createGeneratorView(opts)             // memory-light generator view for paging
//   streamToUI(opts) -> returns { stop() } // fast streaming helper (uses renderMessage internally)
//   getRange(start, count)
//   getMessageByIndex(i)
//   messages[], meta, _idIndex
//
// Options overview (common):
//  size, seedBase, startTimestamp, endTimestamp, spanDays, jitterMs, replyFraction, attachmentFraction, templates, templateFragments
//

(function MessagePoolIIFE(){
  if(window.MessagePool) return;

  // ---------- helpers ----------
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

  function isNumber(n){ return typeof n === 'number' && !isNaN(n); }

  // simple seeded xorshift32
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

  // DJB2 style content hash (fast, non-crypto)
  function contentHash(str){
    let h = 5381;
    for(let i=0;i<str.length;i++){ h = ((h << 5) + h) ^ str.charCodeAt(i); }
    return (h >>> 0).toString(36);
  }

  // small LRU stack helper (array-based, efficient for modest sizes)
  function makeLRU(cap){
    cap = Math.max(32, Number(cap) || 4096);
    const set = new Map();
    return {
      has(k){ return set.has(k); },
      push(k){
        if(set.has(k)){ set.delete(k); }
        set.set(k, true);
        if(set.size > cap){
          // remove first inserted
          const it = set.keys();
          const first = it.next().value;
          set.delete(first);
        }
      },
      clear(){ set.clear(); },
      size(){ return set.size; }
    };
  }

  // default small template fragments (can be expanded by preGenerateTemplates)
  const DEFAULT_PHRASES = [
    "Anyone watching the market?",
    "I'll wait for the retracement.",
    "Bought more on the dip 🚀",
    "Stop loss set.",
    "TP hit, taking profit.",
    "Can someone share the signal?",
    "Nice call on that last trade.",
    "That candle was wild 😅",
    "Holding long, strong fundamentals.",
    "What level are you watching?",
    "See you in the green.",
    "Avoid FOMO, set a plan.",
    "News just popped — check it out.",
    "Looking for entry around here.",
    "Testing strategy — ignore my trades."
  ];

  // tiny emoji list for noise
  const EMOJI = ['✨','🔥','💎','🦊','🐳','🚀','😅','🔒','🎯','💰','📈','⭐','😊','😎'];

  // small attachments sample (filenames) to simulate attachments optionally
  const SAMPLE_ATTACHMENTS = [
    'chart-1.png','screenshot-01.png','trade-report.pdf','voice-msg-12.mp3','screenshot-02.jpg'
  ];

  // ---------- MessagePool core ----------
  const MessagePool = {
    messages: [],
    meta: { size: 1000, seedBase: 4000, spanDays: 365, replyFraction: 0.03, attachmentFraction: 0.04 },
    _idIndex: {},

    // allow loading or pre-generating template fragments for increased variety
    templateFragments: Array.from(DEFAULT_PHRASES),

    preGenerateTemplates(n){
      // trivial filler: if user didn't provide a large pool, expand by synthetic permutations
      n = Math.max(50, Number(n) || 100);
      const base = this.templateFragments.slice();
      const rnd = xorshift32(this.meta.seedBase || 4000);
      while(this.templateFragments.length < n){
        const a = base[Math.floor(rnd()*base.length)] || DEFAULT_PHRASES[Math.floor(rnd()*DEFAULT_PHRASES.length)];
        const b = base[Math.floor(rnd()*base.length)] || DEFAULT_PHRASES[Math.floor(rnd()*DEFAULT_PHRASES.length)];
        const joiner = (rnd() < 0.5) ? ' — ' : ' ';
        const cand = (a + joiner + b).slice(0,280);
        this.templateFragments.push(cand);
      }
      return this.templateFragments;
    },

    // Core: generate a single message for index i using given opts (seed determinism per-index)
    _generateMessageForIndex(i, opts){
      opts = opts || {};
      const seedBase = Number(opts.seedBase || this.meta.seedBase || 4000);
      const rnd = xorshift32(seedBase + (i * 15721)); // per-index variance

      // pick sender from sampleMembers (if available) or fallback to synthetic name
      let sender = null;
      try{
        if(Array.isArray(window.sampleMembers) && window.sampleMembers.length){
          sender = window.sampleMembers[Math.floor(rnd() * window.sampleMembers.length)];
        } else if(window.SyntheticPeople && Array.isArray(window.SyntheticPeople.people) && window.SyntheticPeople.people.length){
          sender = window.SyntheticPeople.people[Math.floor(rnd() * window.SyntheticPeople.people.length)];
        }
      }catch(e){ sender = null; }

      // fallback basic sender
      if(!sender){
        sender = { id: 'sp_' + (i%1000), displayName: 'Member ' + ((i%500)+1), role: 'VERIFIED', avatar: '' };
      }

      // text generation: pick a few template fragments and optionally insert numeric tokens & emoji
      const templates = opts.templates && Array.isArray(opts.templates) ? opts.templates : this.templateFragments;
      const fragCount = (rnd() < 0.12) ? 2 : 1;
      let text = '';
      for(let t=0;t<fragCount;t++){
        const frag = templates[Math.floor(rnd()*templates.length)] || DEFAULT_PHRASES[Math.floor(rnd()*DEFAULT_PHRASES.length)];
        text += (t ? ' ' : '') + frag;
      }

      // small token substitutions: percent chance to insert a price / numeric token
      if(rnd() < 0.18){
        const val = (Math.round((rnd()*980 + 20) * 100) / 100).toFixed(2);
        text += ' — $' + val;
      } else if(rnd() < 0.12){
        text += ' ' + pickFrom(EMOJI, rnd);
      }

      // sometimes append a small exclamation or ellipsis to vary endings
      if(rnd() < 0.12){ text = text + (rnd() < 0.5 ? '!' : '...'); }

      // decide if has attachment
      let attachment = null;
      if(rnd() < (opts.attachmentFraction || this.meta.attachmentFraction || 0.04)){
        const pick = SAMPLE_ATTACHMENTS[Math.floor(rnd()*SAMPLE_ATTACHMENTS.length)];
        attachment = { filename: pick, url: '/assets/' + pick }; // consumer can override url logic
      }

      // reply/pinned flags (rare)
      let replyTo = null;
      if(rnd() < (opts.replyFraction || this.meta.replyFraction || 0.03) && this.messages && this.messages.length){
        const idx = Math.floor(rnd() * Math.min(this.messages.length, 100));
        const msgRef = this.messages[idx];
        if(msgRef) replyTo = msgRef.id;
      }

      // TIMESTAMP distribution: if explicit startTimestamp / endTimestamp provided use linear distribution
      const now = Date.now();
      let startTs = null;
      let endTs = null;

      if(opts.startTimestamp !== undefined || opts.endTimestamp !== undefined){
        if(opts.startTimestamp !== undefined){
          startTs = isNumber(opts.startTimestamp) ? Number(opts.startTimestamp) : new Date(opts.startTimestamp).getTime();
        }
        if(opts.endTimestamp !== undefined){
          endTs = isNumber(opts.endTimestamp) ? Number(opts.endTimestamp) : new Date(opts.endTimestamp).getTime();
        }
        if(!startTs) startTs = now - (365*24*60*60*1000);
        if(!endTs) endTs = now;
      } else {
        const spanDays = Number(opts.spanDays || this.meta.spanDays || 365);
        endTs = now;
        startTs = now - spanDays * 86400000;
      }

      const poolSize = Number(opts.size || this.meta.size || 1) || 1;
      const frac = poolSize > 1 ? (i / Math.max(1, poolSize - 1)) : 0;
      const baseTime = Math.round(startTs + Math.round(frac * (endTs - startTs)));

      const jitterMs = Math.round(Number(opts.jitterMs || 1000 * 60 * 30)); // default 30 min
      const localJitter = Math.round((rnd() - 0.5) * 2 * jitterMs);

      const time = Math.max(0, baseTime + localJitter);

      const msg = {
        id: 'msg_' + (i + 1) + '_' + hashCode((text || '').slice(0,80)),
        name: (sender && (sender.name || sender.displayName)) || ('Member_' + ((i%500)+1)),
        displayName: (sender && (sender.displayName || sender.name)) || ('Member ' + ((i%500)+1)),
        role: (sender && sender.role) || 'VERIFIED',
        avatar: (sender && sender.avatar) || '',
        text: text,
        out: false,
        time: time,
        replyTo: replyTo,
        pinned: false,
        attachment: attachment
      };

      return msg;
    },

    // ----- primary pool generation -----
    generatePool(opts){
      opts = opts || {};
      const size = clamp(Number(opts.size || this.meta.size || 1000), 10, 200000);
      const seedBase = Number(opts.seedBase || this.meta.seedBase || 4000);
      this.meta.size = size;
      this.meta.seedBase = seedBase;

      // allow user to pass in templates or ensure we have enough
      if(opts.templates && Array.isArray(opts.templates)){
        this.templateFragments = opts.templates.slice();
      } else {
        // ensure minimum fragment pool
        if(this.templateFragments.length < 200) this.preGenerateTemplates(Math.max(200, this.templateFragments.length));
      }

      const lru = makeLRU(opts.dedupeLRU || 4096);
      const arr = new Array(size);

      for(let i=0;i<size;i++){
        let m = this._generateMessageForIndex(i, { size, seedBase, startTimestamp: opts.startTimestamp, endTimestamp: opts.endTimestamp, spanDays: opts.spanDays, jitterMs: opts.jitterMs, templates: this.templateFragments, replyFraction: opts.replyFraction, attachmentFraction: opts.attachmentFraction });
        // dedupe check
        let attempts = 0;
        let h = contentHash((m.text||'').slice(0,240));
        while(lru.has(h) && attempts < 8){
          // regenerate with tweaked seed and slight emoji injection
          const alt = this._generateMessageForIndex(i + attempts + 1, { size, seedBase: seedBase + attempts + 1, startTimestamp: opts.startTimestamp, endTimestamp: opts.endTimestamp, jitterMs: opts.jitterMs, templates: this.templateFragments });
          m.text = alt.text + ((attempts % 2 === 0) ? (' ' + pickFrom(EMOJI, xorshift32(seedBase + attempts + i))) : '');
          m.attachment = m.attachment || alt.attachment;
          m.replyTo = m.replyTo || alt.replyTo;
          h = contentHash((m.text||'').slice(0,240));
          attempts++;
        }
        lru.push(h);
        arr[i] = m;
      }

      // sort chronologically and ensure strict monotonic increase (>=1s apart)
      arr.sort((a,b) => (a.time - b.time));
      for(let i=1;i<arr.length;i++){
        if(arr[i].time <= arr[i-1].time) arr[i].time = arr[i-1].time + 1000;
      }

      this.messages = arr;
      this._idIndex = {};
      for(let i=0;i<this.messages.length;i++) this._idIndex[this.messages[i].id] = i;

      // Signal ready for UI handshake if present
      try{ if(window._abrox && typeof window._abrox.moduleReady === 'function') window._abrox.moduleReady('MessagePool'); }catch(e){}

      return this.messages;
    },

    // regenerate with optional inject into UI (render last n)
    regenerateAndInject(opts){
      opts = opts || {};
      const size = Number(opts.size || this.meta.size || 1000);
      const seedBase = Number(opts.seedBase || this.meta.seedBase || 4000);
      this.generatePool(Object.assign({}, opts, { size, seedBase }));
      if(opts.inject && typeof window.renderMessage === 'function'){
        const initialCount = Math.min(Number(opts.initialCount || 40), this.messages.length);
        for(let i=Math.max(0, this.messages.length - initialCount); i < this.messages.length; i++){
          try{ window.renderMessage(this.messages[i], false); }catch(e){ console.warn('renderMessage inject failed', e); }
        }
      }
      return this.messages;
    },

    // lightweight accessor helpers
    getRange(start, count){
      start = Math.max(0, Number(start) || 0);
      count = Math.max(0, Number(count) || 0);
      if(!this.messages || !this.messages.length) return [];
      const end = Math.min(this.messages.length, start + count);
      return this.messages.slice(start, end);
    },

    getMessageByIndex(i){
      if(!this.messages || !this.messages.length) return null;
      i = Number(i) || 0;
      if(i < 0 || i >= this.messages.length) return null;
      return this.messages[i];
    },

    // generator view for memory-light paging (returns view object with pageSize, nextPage(start), get(idx))
    createGeneratorView(opts){
      opts = opts || {};
      const pageSize = Math.max(10, Number(opts.pageSize || 200));
      // If full messages exist in memory we can use them, else fallback to generating on demand
      if(Array.isArray(this.messages) && this.messages.length){
        const view = {
          pageSize,
          totalSize: this.messages.length,
          nextPage: function(start){
            start = Math.max(0, Number(start) || 0);
            return MessagePool.getRange(start, pageSize);
          },
          get: function(i){ return MessagePool.getMessageByIndex(i); }
        };
        return view;
      }

      // If messages not pre-generated, provide on-demand generator view backed by the generator function
      const self = this;
      const view = {
        pageSize,
        totalSize: null,
        nextPage: function(start){
          // generate a deterministic page of items using the internal _generateMessageForIndex
          start = Math.max(0, Number(start) || 0);
          const arr = [];
          for(let j=0;j<pageSize;j++){
            const idx = start + j;
            const m = self._generateMessageForIndex(idx, { size: opts.size || self.meta.size, seedBase: opts.seedBase || self.meta.seedBase, startTimestamp: opts.startTimestamp, endTimestamp: opts.endTimestamp, spanDays: opts.spanDays, jitterMs: opts.jitterMs, templates: self.templateFragments });
            arr.push(m);
          }
          // sort by time just in case
          arr.sort((a,b) => a.time - b.time);
          return arr;
        },
        get: function(i){ return self._generateMessageForIndex(i, { size: opts.size || self.meta.size, seedBase: opts.seedBase || self.meta.seedBase, startTimestamp: opts.startTimestamp, endTimestamp: opts.endTimestamp, spanDays: opts.spanDays, jitterMs: opts.jitterMs, templates: self.templateFragments }); }
      };
      return view;
    },

    // streamToUI: emits messages to UI at a given rate. Returns an object with stop() method.
    // opts: { startIndex, ratePerMin, jitterMs, onEmit } ; onEmit(m, idx) called after each render
    streamToUI(opts){
      opts = opts || {};
      const ratePerMin = Math.max(1, Number(opts.ratePerMin || 45));
      const baseIntervalMs = Math.round(60000 / ratePerMin);
      const jitterMs = Math.round(Number(opts.jitterMs || Math.round(baseIntervalMs * 0.25)));
      let idx = Number(opts.startIndex || 0);
      let stopped = false;
      let timerId = null;

      const emitOne = () => {
        if(stopped) return;
        // if messages available in memory use them; otherwise generate on the fly via generator view
        let m = null;
        if(Array.isArray(MessagePool.messages) && MessagePool.messages.length && idx < MessagePool.messages.length){
          m = MessagePool.getMessageByIndex(idx);
        } else {
          // generate on demand
          m = MessagePool._generateMessageForIndex(idx, { size: MessagePool.meta.size, seedBase: MessagePool.meta.seedBase, startTimestamp: opts.startTimestamp, endTimestamp: opts.endTimestamp, jitterMs: opts.jitterMs, templates: MessagePool.templateFragments });
        }
        if(m){
          try{ if(typeof window.renderMessage === 'function'){ window.renderMessage(m, true); } }catch(e){ console.warn('streamToUI render failed', e); }
          try{ if(typeof opts.onEmit === 'function') opts.onEmit(m, idx); }catch(e){}
        }
        idx++;
        // schedule next with jitter
        const j = Math.round((Math.random() - 0.5) * 2 * jitterMs);
        const delay = Math.max(20, baseIntervalMs + j);
        timerId = setTimeout(emitOne, delay);
      };

      // kick off
      timerId = setTimeout(emitOne, Math.max(0, opts.initialDelay || 0));
      return {
        stop: function(){ stopped = true; if(timerId) clearTimeout(timerId); }
      };
    }
  };

  // expose globally
  window.MessagePool = MessagePool;

  // convenience alias
  function hashCode(s){
    let h = 0;
    for(let i=0;i<s.length;i++){ h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
    return Math.abs(h >>> 0);
  }

  // mark module ready (handshake)
  try{ window._abrox = window._abrox || {}; window._abrox.moduleReady = window._abrox.moduleReady || function(name){ window._abrox._ready = window._abrox._ready || new Set(); window._abrox._ready.add(name); // ui-adapter may listen for this
  }; if(typeof window._abrox.moduleReady === 'function') window._abrox.moduleReady('MessagePool'); }catch(e){}

  console.info('MessagePool loaded — generatePool({size, seedBase, startTimestamp, endTimestamp}) available.');
})();
