// ui-adapter.js
// UI glue & presence / prefill handshake for Abrox demo.
// - Waits for both MessagePool & SyntheticPeople readiness via window._abrox._ready set
// - Prefills chat using generator view or getRange (memory-light)
// - Renders member sidebar with admin/mod pills + verified dot
// - Exposes window._abrox.prefillFromMessagePool, .setSampleMembers, .renderMemberWindow, .setReplyTo, .pinMessage
// - WebSocket stub: window._abrox.initWS(url) + window._abrox.onExternalJoin(event)
// - Does NOT implement renderMessage (unified renderer provided in message.js)

(function uiAdapter(){
  if(window._abrox && window._abrox._uiAdapterLoaded) return;
  window._abrox = window._abrox || {};
  window._abrox._uiAdapterLoaded = true;

  // ---------- Utilities ----------
  function escapeHtml(s){ return (''+s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
  function formatTime(ts){ const d = new Date(ts || Date.now()); return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
  function isFunction(f){ return typeof f === 'function'; }

  // Wait for module ready handshake set — MessagePool and SyntheticPeople call window._abrox.moduleReady(name)
  function waitForModules(names, cb, timeoutMs = 8000){
    const start = Date.now();
    function check(){
      try{
        const ready = (window._abrox && window._abrox._ready) ? window._abrox._ready : new Set();
        let ok = true;
        for(const n of names){ if(!ready.has(n)) { ok = false; break; } }
        if(ok){ try{ cb(); } catch(e){ console.warn('waitForModules cb failed', e); } return; }
        if(Date.now() - start > timeoutMs){
          // give up quietly — still call cb so UI can decide fallback
          try{ cb(); }catch(e){ console.warn('waitForModules timeout callback failed', e); }
          return;
        }
        setTimeout(check, 120);
      }catch(e){
        try{ cb(); }catch(err){ console.warn('waitForModules fallback cb failed', err); }
      }
    }
    check();
  }

  // ---------- Member list rendering ----------
  function renderMemberWindow(){
    const memberListEl = document.getElementById('memberList');
    if(!memberListEl) return;
    memberListEl.innerHTML = '';

    // prefer window.sampleMembers; fallback to SyntheticPeople.people
    const list = (Array.isArray(window.sampleMembers) && window.sampleMembers.length) ? window.sampleMembers : (window.SyntheticPeople && Array.isArray(window.SyntheticPeople.people) ? window.SyntheticPeople.people.slice(0,120) : []);
    // sort: admins/mods first, then verified, then others — but preserve some randomness for realism
    const sorted = list.slice().sort((a,b) => {
      const r = (a.role === 'ADMIN' ? 3 : (a.role === 'MOD' ? 2 : (a.verified ? 1 : 0))) - (b.role === 'ADMIN' ? 3 : (b.role === 'MOD' ? 2 : (b.verified ? 1 : 0)));
      return -r;
    });

    sorted.slice(0, 400).forEach(p => {
      const div = document.createElement('div');
      div.className = 'member-row';
      div.setAttribute('role','listitem');
      // presence small dot
      const presence = (typeof window.presenceOf === 'function') ? window.presenceOf(p) : (Date.now() - (p.lastActive || 0) < 90*1000 ? 'online' : 'offline');
      const presenceColor = presence === 'online' ? '#22c55e' : (presence === 'idle' ? '#f59e0b' : '#94a3b8');

      // badges: show role-pill only for ADMIN/MOD; otherwise show tiny verified dot/icon
      const roleHtml = (p.role === 'ADMIN') ? '<span class="role-pill admin">ADMIN</span>' : (p.role === 'MOD' ? '<span class="role-pill mod">MOD</span>' : (p.verified ? '<i data-lucide="check-circle" style="width:14px;height:14px;color:#22c55e" title="Verified"></i>' : ''));

      const avatarSrc = p.avatar || '';
      div.innerHTML = `<div style="display:flex;gap:8px;align-items:center">
        <div style="position:relative">
          <img src="${escapeHtml(avatarSrc)}" class="w-10 h-10 rounded-full avatar" alt="${escapeHtml(p.displayName||p.name||'')}" loading="lazy" width="40" height="40">
          <span style="position:absolute;right:-2px;bottom:-2px;width:10px;height:10px;border-radius:999px;background:${presenceColor};border:2px solid #1c1f26"></span>
        </div>
        <div style="min-width:0;flex:1">
          <div style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;gap:6px;align-items:center">
            <span class="member-name" style="flex:1;min-width:0">${escapeHtml(p.displayName||p.name||'')}</span>
            <span style="flex-shrink:0">${roleHtml}</span>
          </div>
          <div style="font-size:11px;color:var(--muted)">${escapeHtml(p.country || '')} · ${presence}</div>
        </div>
      </div>`;
      memberListEl.appendChild(div);
    });

    try{ if(window._abrox && typeof window._abrox.iconify === 'function') window._abrox.iconify(); }catch(e){}
  }

  // Expose setter API for other modules
  window._abrox.setSampleMembers = function(members){
    try{
      window.sampleMembers = members || [];
      const pc = document.getElementById('memberCount');
      if(pc) pc.textContent = (members.length || 0).toLocaleString();
      renderMemberWindow();
    }catch(e){ console.warn('setSampleMembers failed', e); }
  };

  window._abrox.renderMemberWindow = renderMemberWindow;

  // ---------- Prefill from MessagePool (generator view preferred) ----------
  // window._abrox.prefillFromMessagePool(start = 0, count = 40)
  window._abrox.prefillFromMessagePool = function(start = 0, count = 40){
    try{
      if(!window.MessagePool){
        console.warn('prefillFromMessagePool: MessagePool not ready');
        return [];
      }
      const pageSize = Math.max(1, Number(count) || 40);

      // prefer generator view (memory-light)
      if(typeof window.MessagePool.createGeneratorView === 'function'){
        try{
          const gv = window.MessagePool.createGeneratorView({ pageSize, seedBase: window.MessagePool.meta.seedBase });
          window._abrox._messagePoolView = gv;
          // find last page index if MessagePool has messages
          let total = (window.MessagePool && Array.isArray(window.MessagePool.messages) && window.MessagePool.messages.length) ? window.MessagePool.messages.length : null;
          // if total known, compute startIndex to fetch last page; else use provided start
          const startIndex = total ? Math.max(0, (total - pageSize)) : Number(start) || 0;
          const page = gv.nextPage(startIndex);
          const chat = document.getElementById('chat'); if(chat) chat.innerHTML = '';
          page.forEach(m => { try{ if(typeof window.renderMessage === 'function') window.renderMessage(m, false); }catch(e){} });
          // set SimulationEngine start index to next message after last rendered if SimulationEngine exposes setStartIndex
          if(window.SimulationEngine && typeof window.SimulationEngine.setStartIndex === 'function' && total) window.SimulationEngine.setStartIndex(total);
          return page;
        }catch(e){
          console.warn('prefillFromMessagePool generatorView failed', e);
        }
      }

      // fallback to getRange if generator view not present
      if(typeof window.MessagePool.getRange === 'function'){
        const total = (window.MessagePool && Array.isArray(window.MessagePool.messages) && window.MessagePool.messages.length) ? window.MessagePool.messages.length : null;
        const startIdx = total ? Math.max(0, total - pageSize) : Number(start) || 0;
        const msgs = window.MessagePool.getRange(startIdx, pageSize) || [];
        const chat = document.getElementById('chat'); if(chat) chat.innerHTML = '';
        for(let i=0;i<msgs.length;i++){ try{ if(typeof window.renderMessage === 'function') window.renderMessage(msgs[i], false); }catch(e){} }
        if(window.SimulationEngine && typeof window.SimulationEngine.setStartIndex === 'function' && total) window.SimulationEngine.setStartIndex(total);
        return msgs;
      }

      console.warn('prefillFromMessagePool: MessagePool view not available');
      return [];
    }catch(e){
      console.warn('prefillFromMessagePool error', e);
      return [];
    }
  };

  // Auto-run once when both MessagePool & SyntheticPeople are ready (handshake)
  waitForModules(['MessagePool','SyntheticPeople'], function(){
    try{
      if(window._abrox && window._abrox.disableAutoPrefill) return;
      // conservative default: prefill last 40 messages
      try{
        window._abrox.prefillFromMessagePool(0, 40);
      }catch(e){ console.warn('auto prefill failed', e); }
    }catch(e){}
  }, 12000);

  // ---------- Context menu, reply & pin UX ----------
  window._abrox.showContextMenu = function(x,y,msg,anchorEl){
    try{
      document.querySelectorAll('.context-menu').forEach(n=>n.remove());
      const menu = document.createElement('div');
      menu.className = 'context-menu';
      menu.style.position = 'fixed';
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      menu.style.zIndex = 99999;
      menu.innerHTML = `<div class="menu-item" data-action="reply">Reply</div><div class="menu-item" data-action="pin">Pin</div><div class="menu-item" data-action="copy">Copy</div>`;
      document.body.appendChild(menu);
      const rect = menu.getBoundingClientRect();
      if(rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if(rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
      menu.querySelector('[data-action="reply"]').addEventListener('click', ()=>{ menu.remove(); window._abrox.setReplyTo(msg.id); });
      menu.querySelector('[data-action="pin"]').addEventListener('click', ()=>{ menu.remove(); window._abrox.pinMessage(msg.id); });
      menu.querySelector('[data-action="copy"]').addEventListener('click', ()=>{ menu.remove(); try{ navigator.clipboard.writeText(msg.text || ''); }catch(e){} });
      setTimeout(()=>{ document.addEventListener('click', function closer(e){ if(!menu.contains(e.target)){ menu.remove(); document.removeEventListener('click', closer); } }); }, 10);
    }catch(e){ console.warn('showContextMenu', e); }
  };

  // Reply preview UI
  let _replyTargetId = null;
  window._abrox.setReplyTo = function(msgId){
    try{
      const target = document.querySelector(`[data-id="${msgId}"]`);
      if(!target) return;
      const senderText = target.querySelector('.sender') ? target.querySelector('.sender').textContent : 'Message';
      const snippet = target.querySelector('.content') ? (target.querySelector('.content').textContent || '').slice(0,120) : '';
      const container = document.getElementById('replyPreviewContainer');
      if(!container) return;
      container.innerHTML = `<div class="reply-preview" id="replyPreview">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:700">${escapeHtml(senderText)}</div>
          <div style="font-size:11px;opacity:.65;cursor:pointer" id="replyCancelBtn">Cancel</div>
        </div>
        <div class="snippet">${escapeHtml(snippet)}</div>
      </div>`;
      const cancel = document.getElementById('replyCancelBtn');
      if(cancel) cancel.addEventListener('click', ()=>{ window._abrox.clearReplyPreview(); });
      _replyTargetId = msgId;
      const input = document.getElementById('input'); if(input) input.focus();
    }catch(e){ console.warn('setReplyTo failed', e); }
  };

  window._abrox.clearReplyPreview = function(){
    const container = document.getElementById('replyPreviewContainer');
    if(container) container.innerHTML = '';
    _replyTargetId = null;
  };

  // Pin behavior
  window._abrox.pinMessage = function(id){
    try{
      const el = document.querySelector(`[data-id="${id}"]`);
      let txt = 'Pinned message';
      if(el && el.querySelector('.content')) txt = el.querySelector('.content').textContent;
      const pinnedTextEl = document.getElementById('pinnedText');
      if(pinnedTextEl) pinnedTextEl.textContent = txt.length > 160 ? txt.slice(0,157) + '...' : txt;
      const banner = document.getElementById('pinnedBanner');
      if(banner) banner.classList.remove('hidden');
      try{ localStorage.setItem('pinned_message_id', id); localStorage.setItem('pinned_message_text', txt); }catch(e){}
    }catch(e){ console.warn('pinMessage error', e); }
  };

  // wire unpin button if present
  (function wireUnpin(){
    const unpinBtn = document.getElementById('unpinBtn');
    if(unpinBtn){
      unpinBtn.addEventListener('click', ()=>{ const banner = document.getElementById('pinnedBanner'); if(banner) banner.classList.add('hidden'); try{ localStorage.removeItem('pinned_message_id'); localStorage.removeItem('pinned_message_text'); }catch(e){} });
    }
  })();

  // expose small debugging / helper for external injection
  window._abrox.injectMessage = function(msg){
    try{ if(typeof window.renderMessage === 'function') window.renderMessage(msg, true); }catch(e){}
  };

  // ---------- WebSocket stub / external join handling ----------
  (function wsStub(){
    let ws = null;
    window._abrox.initWS = function(url){
      try{
        if(!url) throw new Error('ws url required');
        ws = new WebSocket(url);
        ws.addEventListener('open', ()=>{ console.info('WS connected to', url); });
        ws.addEventListener('message', (ev)=>{ try{ const data = JSON.parse(ev.data); handleExternalEvent(data); }catch(e){ console.warn('ws message parse failed', e); }});
        ws.addEventListener('close', ()=>{ console.info('WS closed'); ws = null; });
        return ws;
      }catch(e){ console.warn('initWS failed', e); return null; }
    };

    function handleExternalEvent(data){
      try{
        if(!data || !data.type) return;
        if(data.type === 'join'){
          // system-style join message
          const sys = { id: 'sys_' + Date.now(), system: true, subtype: 'join', text: (data.name ? (data.name + ' joined') : 'Someone joined'), time: Date.now() };
          window._abrox.injectMessage(sys);
          // also add to members list if provided
          if(data.member && typeof window._abrox.setSampleMembers === 'function'){
            try{
              const existing = window.sampleMembers || [];
              existing.unshift(data.member);
              window._abrox.setSampleMembers(existing.slice(0, 2000));
            }catch(e){}
          }
          // nudge presence manager if present
          if(window._abrox && window._abrox.PresenceManager && typeof window._abrox.PresenceManager.tickNow === 'function'){
            try{ window._abrox.PresenceManager.tickNow(); }catch(e){}
          }
        } else if(data.type === 'message' && data.message){
          window._abrox.injectMessage(data.message);
        } else if(data.type === 'ping'){
          // keepalive
        }
      }catch(e){ console.warn('handleExternalEvent failed', e); }
    }

    // convenient onExternalJoin for manual testing: window._abrox.onExternalJoin({name:'Sarah', member:{...}})
    window._abrox.onExternalJoin = function(ev){
      try{ handleExternalEvent(Object.assign({ type:'join' }, ev)); }catch(e){ console.warn('onExternalJoin failed', e); }
    };
  })();

  // ---------- Expose prefill control for debug/testing ----------
  window._abrox.prefillLastN = function(n){
    try{
      const total = (window.MessagePool && window.MessagePool.messages && window.MessagePool.messages.length) ? window.MessagePool.messages.length : null;
      if(total){
        const start = Math.max(0, total - Number(n || 40));
        const msgs = window.MessagePool.getRange(start, Number(n || 40));
        const chat = document.getElementById('chat');
        if(chat) chat.innerHTML = '';
        msgs.forEach(m => { try{ window.renderMessage && window.renderMessage(m, false); }catch(e){} });
        if(window.SimulationEngine && typeof window.SimulationEngine.setStartIndex === 'function') window.SimulationEngine.setStartIndex(total);
        return msgs;
      }
      // else fallback to prefilling via generator view
      return window._abrox.prefillFromMessagePool(0, n || 40);
    }catch(e){ console.warn('prefillLastN failed', e); return []; }
  };

  // friendly log
  console.info('ui-adapter loaded — prefill handshake + member sidebar wired.');
})();
