// synthetic-people.js
// Lightweight synthetic people generator with mixed avatar providers and realistic name variation.
// Exposes: SyntheticPeople.generatePool(opts), .exportForSimulation(), .simulatePresenceStep(opts), .injectToUI()
// Calls window._abrox.moduleReady('SyntheticPeople') when ready.
//
// Options supported in generatePool:
//   { size, seedBase, uniqueAvatars, preferPhotos, localeMix } 
//
// Example:
//   SyntheticPeople.generatePool({ size: 2000, seedBase: 4000, uniqueAvatars: true });
//   window._abrox.setSampleMembers(SyntheticPeople.exportForSimulation());

(function SyntheticPeopleIIFE(){
  if(window.SyntheticPeople) return;

  // ---------- tiny helpers ----------
  function uid(prefix){
    return (prefix || 'p_') + Math.random().toString(36).slice(2,10);
  }

  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

  // seeded xorshift32 RNG factory
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

  function pickFrom(arr, rnd){
    if(!arr || !arr.length) return null;
    return arr[Math.floor(rnd()*arr.length)];
  }

  // quick lightweight hash for strings (non-crypto)
  function hashCode(s){
    let h = 2166136261;
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h += (h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24); }
    return Math.abs(h >>> 0);
  }

  // ---------- avatar generation (expanded) ----------
  function makeAvatar(name, idx, opts){
    opts = opts || {};
    const size = Number(opts.size) || 120;
    const preferSvg = !!opts.preferSvg;
    const preferPhotos = !!opts.preferPhotos;
    const enforceUnique = !!opts.unique;

    // "random" name forces non-deterministic seed
    const randomize = (String(name || '').toLowerCase() === 'random');

    const seedRaw = randomize ? ('rnd_' + Date.now() + '_' + Math.random().toString(36).slice(2,8)) : ((name || ('user' + idx)) + '_' + idx);
    const enc = encodeURIComponent(seedRaw);

    // scatter index to vary provider selection beyond modulo
    let h = 0;
    for(let i=0;i<seedRaw.length;i++){ h = ((h << 5) - h) + seedRaw.charCodeAt(i); h |= 0; }
    const scatter = Math.abs(h) + idx;

    // provider functions returning a URL (some accept size, some prefer svg)
    const providers = [
      // DiceBear 6.x SVG variants
      s => `https://api.dicebear.com/6.x/miniavs/svg?seed=${s}&scale=90`,
      s => `https://api.dicebear.com/6.x/pixel-art/svg?seed=${s}&scale=90`,
      s => `https://api.dicebear.com/6.x/identicon/svg?seed=${s}`,
      s => `https://api.dicebear.com/6.x/adventurer/svg?seed=${s}`,
      s => `https://api.dicebear.com/6.x/bottts/svg?seed=${s}`,
      s => `https://api.dicebear.com/6.x/initials/svg?seed=${s}&scale=90`,

      // Avataaars / other DiceBear
      s => `https://api.dicebear.com/6.x/avataaars/svg?seed=${s}&scale=90`,

      // Multiavatar (PNG)
      s => `https://api.multiavatar.com/${s}.png`,

      // Picsum.photos (photo-like)
      s => `https://picsum.photos/seed/${s}/${Math.max(40, Math.min(512, size))}`,

      // LoremFlickr face photos (lock param ensures stable image for a seed)
      s => `https://loremflickr.com/${Math.max(40,Math.min(512, size))}/${Math.max(40,Math.min(512, size))}/face?lock=${encodeURIComponent(s)}`,

      // Pravatar (random portrait)
      s => `https://i.pravatar.cc/${Math.max(32,Math.min(512, size))}?u=${s}`,

      // UI Avatars - initials
      s => `https://ui-avatars.com/api/?name=${encodeURIComponent(name || s)}&size=${Math.max(32,Math.min(512, size))}&background=random`,

      // Robohash
      s => `https://robohash.org/${s}.png?size=${Math.max(64,Math.min(512, size))}x${Math.max(64,Math.min(512, size))}`,

      // Libravatar fallback / identicon
      s => {
        let x = 0;
        for(let i=0;i<s.length;i++){ x = (x * 31 + s.charCodeAt(i)) & 0xffffffff; }
        return `https://seccdn.libravatar.org/avatar/${Math.abs(x)}?s=${Math.max(32,Math.min(512, size))}&d=identicon`;
      },

      // PlaceKitten (fun variation)
      s => `https://placekitten.com/${Math.max(40, Math.min(512, size))}/${Math.max(40, Math.min(512, size))}?image=${(Math.abs(h) % 16)}`,

      // Fallback legacy identicon
      s => `https://avatars.dicebear.com/api/identicon/${s}.svg`
    ];

    // provider index sets
    const svgProviders = [0,1,2,3,4,5,6,12].filter(i => i < providers.length);
    const photoProviders = [7,8,9,10,11].filter(i => i < providers.length);
    const total = providers.length;

    // choose start index deterministically but scattered
    let providerIndex;
    if(preferSvg){
      providerIndex = svgProviders[ scatter % svgProviders.length ];
    } else if(preferPhotos){
      providerIndex = photoProviders[ scatter % photoProviders.length ];
    } else {
      providerIndex = scatter % total;
    }

    // ensure runtime avatar registry exists
    try{ window._abrox = window._abrox || {}; window._abrox._avatarRegistry = window._abrox._avatarRegistry || new Set(); }catch(e){ /* ignore */ }

    // attempt to find a provider URL that avoids duplicates if enforceUnique
    let chosen = null;
    for(let attempt=0; attempt < total; attempt++){
      const idxPick = (providerIndex + attempt) % total;
      try{
        const url = providers[idxPick](enc);
        if(enforceUnique && window._abrox && window._abrox._avatarRegistry){
          if(window._abrox._avatarRegistry.has(url)) continue;
          chosen = url;
          window._abrox._avatarRegistry.add(url);
          break;
        } else {
          chosen = url;
          break;
        }
      }catch(e){
        continue;
      }
    }

    // fallback ensure unique query if still nothing
    if(!chosen){
      const base = providers[providerIndex](enc);
      const suffix = `uniq=${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      chosen = base + (base.indexOf('?') === -1 ? ('?' + suffix) : ('&' + suffix));
      try{ window._abrox._avatarRegistry.add(chosen); }catch(e){}
    }

    return chosen;
  }

  // ---------- realistic name generator ----------
  // small curated name fragments & emoji pool; can be expanded
  const FIRSTS = [
    'Ava','Noah','Liam','Olivia','Maya','Rex','Zed','Nina','Omar','Kofi','Sage','Luna','Kai','Zara','Sam','Amara','Diego','Hana','Yuki','Léa'
  ];
  const LASTS = [
    'Okoro','Smith','Nguyen','Khan','Silva','Ivanov','Garcia','Adams','Kouame','Kim','Osei','Popov','Fernández','Brown','O\'Neil'
  ];
  const EMOJI = ['✨','🔥','💎','🦊','🐳','🚀','😅','🔒','🎯','💰','📈','⭐','😊','😎','🤝'];

  // produce "human-imperfect" displayName variations
  function makeDisplayName(rnd){
    // choose first & last
    const first = pickFrom(FIRSTS, rnd) || ('User' + Math.floor(rnd()*999));
    const last = pickFrom(LASTS, rnd) || ('Member' + Math.floor(rnd()*999));
    let name = first + ' ' + last;

    // random capitalization variants
    const p = rnd();
    if(p < 0.06) name = name.toLowerCase();
    else if(p < 0.12) name = name.toUpperCase();
    else if(p < 0.25) {
      // occasional single name or nickname
      name = first;
      if(rnd() < 0.15) name = name + (Math.random() < 0.5 ? ' ' + last.charAt(0) + '.' : ' #' + Math.floor(rnd()*99 + 1));
    }

    // maybe insert emoji in 12% of names
    if(rnd() < 0.12){
      const e = pickFrom(EMOJI, rnd);
      if(rnd() < 0.5) name = `${e} ${name}`; else name = `${name} ${e}`;
    }

    // small chance to introduce spacing/typo or special char
    if(rnd() < 0.07){
      if(rnd() < 0.5) name = name.replace(' ', '  ');
      else name = name.replace('a','@');
    }

    // small chance to append country code
    if(rnd() < 0.05){
      const cc = ['🇳🇬','🇬🇭','🇿🇦','🇺🇸','🇬🇧','🇧🇷','🇮🇳','🇪🇸','🇵🇭'];
      name = name + ' ' + pickFrom(cc, rnd);
    }

    return name;
  }

  // ---------- main SyntheticPeople object ----------
  const SyntheticPeople = {
    people: [],
    meta: { size: 1000, seedBase: 2026, uniqueAvatars: true, preferPhotos: false },

    // generate a new pool (synchronous). Keep it efficient for sizes up to a few thousand.
    generatePool(opts){
      opts = opts || {};
      const size = clamp(Number(opts.size || this.meta.size || 1000), 10, 20000);
      const seedBase = Number(opts.seedBase || this.meta.seedBase || 2026);
      const uniqueAvatars = opts.uniqueAvatars !== undefined ? !!opts.uniqueAvatars : !!this.meta.uniqueAvatars;
      const preferPhotos = !!opts.preferPhotos;

      this.meta.size = size;
      this.meta.seedBase = seedBase;
      this.meta.uniqueAvatars = uniqueAvatars;
      this.meta.preferPhotos = preferPhotos;

      const rnd = xorshift32(seedBase);
      const arr = [];
      // decide number of admins/mods roughly
      const adminCount = Math.max(1, Math.round(size * 0.004)); // ~0.4%
      const modCount = Math.max(1, Math.round(size * 0.03)); // ~3%
      // pick admin/mod indices deterministically
      const adminIndices = new Set();
      const modIndices = new Set();
      for(let i=0;i<adminCount;i++){ adminIndices.add(Math.floor(rnd()*size)); }
      for(let i=0;i<modCount;i++){ modIndices.add(Math.floor(rnd()*size)); }

      // fill registry if needed
      try{ window._abrox = window._abrox || {}; window._abrox._avatarRegistry = window._abrox._avatarRegistry || new Set(); }catch(e){}

      for(let i=0;i<size;i++){
        const subRnd = xorshift32(seedBase + i*137);
        const displayName = makeDisplayName(subRnd);
        const role = adminIndices.has(i) ? 'ADMIN' : (modIndices.has(i) ? 'MOD' : (subRnd() < 0.01 ? 'MOD' : 'VERIFIED'));
        const verified = role === 'VERIFIED' || role === 'YOU' || role === 'ADMIN' || role === 'MOD' ? true : false;
        const avatar = makeAvatar(displayName, i, { size: 120, preferSvg: false, preferPhotos: preferPhotos, unique: uniqueAvatars });

        // lastActive seeded to within last 48 hours (more recent for some)
        const lastActive = Date.now() - Math.round(subRnd() * 1000 * 60 * 60 * 48);
        const countryHints = ['NG','GH','ZA','US','GB','BR','IN','ES','PH'];
        const country = pickFrom(countryHints, subRnd);

        const p = {
          id: uid('person_'),
          name: displayName.replace(/\s+/g,'_').replace(/[^\w\-\u0080-\uFFFF]/g,'').slice(0,32),
          displayName: displayName,
          role: role,
          verified: !!verified,
          avatar: avatar,
          lastActive: lastActive,
          country: country
        };
        arr.push(p);
      }

      this.people = arr;
      // expose a small sample for UI consumption
      try{
        const sample = this.exportForSimulation();
        if(window._abrox && typeof window._abrox.setSampleMembers === 'function'){
          try{ window._abrox.setSampleMembers(sample); }catch(e){}
        }
      }catch(e){}

      // signal ready for UI handshake
      try{ if(window._abrox && typeof window._abrox.moduleReady === 'function') window._abrox.moduleReady('SyntheticPeople'); }catch(e){}

      return this.people;
    },

    exportForSimulation(){
      // export a modest slice for UI (avoid shipping entire pool to DOM)
      const list = (this.people || []).slice(0, 800).map(p => ({
        id: p.id,
        displayName: p.displayName,
        avatar: p.avatar,
        role: p.role,
        verified: p.verified,
        lastActive: p.lastActive,
        country: p.country
      }));
      return list;
    },

    // simulate a presence "tick" — nudge a percent of members' lastActive to be recent
    simulatePresenceStep(opts){
      opts = opts || {};
      const pct = Math.max(0, Math.min(1, Number(opts.percent || 0.01)));
      if(!this.people || !this.people.length) return;
      const count = Math.max(1, Math.round(this.people.length * pct));
      for(let i=0;i<count;i++){
        const idx = Math.floor(Math.random()*this.people.length);
        this.people[idx].lastActive = Date.now() - Math.round(Math.random()*1000*60*5); // last 0-5 mins
      }
    },

    // small helper to inject the sample members into UI explicitly
    injectToUI(){
      try{
        if(window._abrox && typeof window._abrox.setSampleMembers === 'function'){
          window._abrox.setSampleMembers(this.exportForSimulation());
        }
      }catch(e){ console.warn('SyntheticPeople.injectToUI failed', e); }
    }
  };

  // auto-generate a modest preview pool to make UI feel alive right away
  setTimeout(()=>{ try{ SyntheticPeople.generatePool({ size: Math.min(800, SyntheticPeople.meta.size), seedBase: SyntheticPeople.meta.seedBase || 2026 }); }catch(e){} }, 60);

  // expose globally
  window.SyntheticPeople = SyntheticPeople;

  console.info('SyntheticPeople loaded — ready to generate realistic member pools.');
})();
