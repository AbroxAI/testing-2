// message.js
// Unified message renderer for Abrox chat UI.
// Single global: window.renderMessage(message, autoScroll = true)
// message shape (recommended):
// { id, displayName, name, role, verified, avatar, text, time, out, replyTo, pinned, attachment, system, subtype }
// - attachment: { filename, url }
// - system: true for join/system rows
// - role: 'ADMIN'|'MOD'|'VERIFIED'|'YOU' etc.
// - verified: boolean
// - time: timestamp in ms
// - text: raw text (HTML-escaped by renderer)
//
// NOTE: this file assumes icons.js exposes window._abrox.iconify() and ui-adapter exposes window.attachMessageInteractions()

(function unifiedMessageRenderer(){
  if(window.renderMessage) return;

  // ---------- helpers ----------
  function escapeHTML(str){
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatTime(ts){
    try{
      const d = new Date(Number(ts) || Date.now());
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }catch(e){
      return '';
    }
  }

  function dayKey(ts){
    try{ return new Date(Number(ts)).toDateString(); }catch(e){ return ''; }
  }

  function isImageUrl(url){
    return typeof url === 'string' && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
  }

  // determine whether the chat is near bottom (so auto-scroll should run)
  function isChatNearBottom(chatEl, threshold = 80){
    if(!chatEl) return true;
    return (chatEl.scrollTop + chatEl.clientHeight) >= (chatEl.scrollHeight - threshold);
  }

  // ensure date pill (only when day changes)
  function maybeInsertDatePill(chatEl, ts){
    if(!chatEl) return;
    const key = dayKey(ts);
    if(!key) return;
    if(chatEl._lastDateKey === key) return;

    const pill = document.createElement('div');
    pill.className = 'date-pill';
    pill.textContent = (key === (new Date()).toDateString()) ? 'Today' : key;
    // style adjustments handled by CSS; just append
    chatEl.appendChild(pill);
    chatEl._lastDateKey = key;
  }

  // compute grouped: same sender and within GROUP_WINDOW_MS of previous message
  const GROUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

  function computeGrouping(chatEl, message){
    try{
      const lastMsgEl = chatEl && chatEl.querySelector && chatEl.querySelector('.msg:last-of-type');
      if(!lastMsgEl) return false;
      const lastSender = lastMsgEl.dataset && lastMsgEl.dataset.sender;
      const lastTs = lastMsgEl.dataset && Number(lastMsgEl.dataset.ts);
      const thisSender = (message.displayName || message.name || '').toString();
      if(!lastSender || !thisSender) return false;
      if(lastSender !== thisSender) return false;
      if(!lastTs || !message.time) return false;
      return Math.abs(message.time - lastTs) <= GROUP_WINDOW_MS;
    }catch(e){ return false; }
  }

  // create badge HTML for a sender
  function makeBadgeHTML(m){
    if(!m) return '';
    if(m.role === 'ADMIN') return '<span class="role-pill admin" aria-hidden="true">ADMIN</span>';
    if(m.role === 'MOD') return '<span class="role-pill mod" aria-hidden="true">MOD</span>';
    if(m.verified) return '<span class="verified-dot" title="Verified" aria-hidden="true"></span>';
    return '';
  }

  // create attachment node
  function createAttachmentNode(attachment){
    const wrap = document.createElement('div');
    wrap.className = 'attachment';
    if(!attachment) return wrap;
    const url = attachment.url || attachment.filename || '';
    const name = attachment.filename || url.split('/').pop() || 'file';
    if(isImageUrl(url)){
      const img = document.createElement('img');
      img.className = 'attachment-image';
      img.src = url;
      img.alt = escapeHTML(name);
      img.loading = 'lazy';
      img.style.maxWidth = '320px';
      img.style.display = 'block';
      img.style.borderRadius = '8px';
      img.style.marginTop = '8px';
      img.addEventListener('error', ()=>{ img.style.opacity = '0.6'; });
      wrap.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'attachment-link';
      a.textContent = name;
      a.style.display = 'inline-block';
      a.style.marginTop = '8px';
      a.style.fontSize = '13px';
      a.style.color = 'var(--muted)';
      wrap.appendChild(a);
    }
    return wrap;
  }

  // highlight and scroll to an element briefly (for reply highlight or pinned jump)
  function highlightAndScroll(el){
    if(!el) return;
    try{
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background-color .9s ease';
      const orig = el.style.backgroundColor;
      el.style.backgroundColor = 'rgba(107,219,167,0.12)';
      setTimeout(()=>{ el.style.backgroundColor = orig; }, 950);
    }catch(e){}
  }

  // find reply target snippet (if present)
  function makeReplySnippet(replyToId){
    if(!replyToId) return null;
    const target = document.querySelector(`[data-id="${replyToId}"]`);
    if(!target) return null;
    const senderNode = target.querySelector('.sender');
    const contentNode = target.querySelector('.content');
    const senderText = senderNode ? senderNode.textContent.trim() : '';
    const snippet = contentNode ? (contentNode.textContent || '').slice(0,120) : '';
    return { senderText, snippet, targetEl: target };
  }

  // main renderer
  function renderMessage(message, autoScroll = true){
    if(!message) return;
    // normalize time field names
    if(message.timestamp && !message.time) message.time = message.timestamp;
    if(!message.time) message.time = Date.now();

    const chat = document.getElementById('chat');
    if(!chat) return;

    // insert date pill if day changed
    maybeInsertDatePill(chat, message.time);

    const grouped = computeGrouping(chat, message);

    // build message container
    const row = document.createElement('div');
    row.className = 'msg ' + (message.out ? 'out ' : 'in ') + (grouped ? 'grouped' : '');
    row.setAttribute('role','listitem');

    // data attrs for external lookups
    row.dataset.id = message.id || ('id_' + Math.random().toString(36).slice(2,9));
    row.dataset.ts = Number(message.time || Date.now());
    row.dataset.sender = (message.displayName || message.name) || '';

    // system messages (join/leave) are displayed centered and differently
    if(message.system || message.type === 'system'){
      const sys = document.createElement('div');
      sys.className = 'bubble system';
      sys.style.background = 'transparent';
      sys.style.textAlign = 'center';
      sys.style.maxWidth = '100%';
      sys.style.padding = '8px 0';
      sys.innerHTML = `<div style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,0.03);font-size:13px;color:var(--muted)">${escapeHTML(message.text || (message.name ? (message.name + ' joined') : 'joined'))}</div>`;
      row.appendChild(sys);
      chat.appendChild(row);
      // auto-scroll decisions
      if(autoScroll && isChatNearBottom(chat)){
        chat.scrollTop = chat.scrollHeight;
      } else {
        const ub = document.getElementById('unreadBtn');
        if(ub) ub.style.display = 'block';
      }
      // interactions and return
      try{ if(typeof window.attachMessageInteractions === 'function') window.attachMessageInteractions(row, message); }catch(e){}
      return;
    }

    // avatar (hide for grouped messages)
    const avatarNode = document.createElement('div');
    avatarNode.className = 'avatar-wrap';
    avatarNode.style.minWidth = '44px';
    avatarNode.style.display = grouped ? 'none' : 'block';

    if(!grouped){
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = escapeHTML(message.displayName || message.name || 'Member');
      img.src = message.avatar || '';
      img.loading = 'lazy';
      // defensive onerror hide
      img.addEventListener('error', ()=>{ img.style.opacity = '0.6'; });
      avatarNode.appendChild(img);
      row.appendChild(avatarNode);
    } else {
      // keep structural spacing for grouped messages
      avatarNode.style.width = '42px';
      avatarNode.style.height = '1px';
      row.appendChild(avatarNode);
    }

    // bubble
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if(message.out) bubble.setAttribute('aria-label','You');

    // sender line (only show for non-outgoing and non-grouped first message)
    if(!message.out && !grouped){
      const senderLine = document.createElement('div');
      senderLine.className = 'sender';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sender-name';
      nameSpan.textContent = message.displayName || message.name || 'Unknown';
      senderLine.appendChild(nameSpan);

      // append badge
      const badgeHTML = makeBadgeHTML(message);
      if(badgeHTML){
        const tmp = document.createElement('span');
        tmp.className = 'sender-badge';
        tmp.style.marginLeft = '6px';
        tmp.innerHTML = badgeHTML;
        senderLine.appendChild(tmp);
      }

      // right-aligned small time (inlined)
      const right = document.createElement('div');
      right.style.marginLeft = '8px';
      right.style.marginRight = '0';
      right.style.opacity = '0.9';
      right.style.fontSize = '11px';
      right.style.color = 'var(--muted)';
      right.textContent = formatTime(message.time);
      right.className = 'time';
      senderLine.appendChild(right);

      bubble.appendChild(senderLine);
    }

    // content
    const content = document.createElement('div');
    content.className = 'content';
    content.style.whiteSpace = 'pre-wrap';
    content.style.wordBreak = 'break-word';
    // text may contain user-provided content; escape to avoid XSS
    content.innerHTML = escapeHTML(message.text || '');

    bubble.appendChild(content);

    // reply snippet if applicable
    if(message.replyTo){
      const reply = makeReplySnippet(message.replyTo);
      if(reply){
        const repEl = document.createElement('div');
        repEl.className = 'reply-preview';
        repEl.innerHTML = `<div style="font-weight:700">${escapeHTML(reply.senderText)}</div><div class="snippet">${escapeHTML(reply.snippet)}</div>`;
        repEl.style.marginBottom = '8px';
        repEl.addEventListener('click', ()=>{
          highlightAndScroll(reply.targetEl);
        });
        // place reply above content
        bubble.insertBefore(repEl, content);
      }
    }

    // attachment support
    if(message.attachment){
      try{
        const attNode = createAttachmentNode(message.attachment);
        bubble.appendChild(attNode);
      }catch(e){}
    }

    // time row for grouped/out messages (if not shown above)
    if(grouped || message.out){
      const timeRow = document.createElement('div');
      timeRow.className = 'time';
      timeRow.textContent = formatTime(message.time);
      bubble.appendChild(timeRow);
    }

    // pinned indicator (visual)
    if(message.pinned){
      const pinEl = document.createElement('div');
      pinEl.style.fontSize = '11px';
      pinEl.style.opacity = '0.8';
      pinEl.style.marginTop = '6px';
      pinEl.textContent = '📌 Pinned';
      bubble.appendChild(pinEl);
    }

    // append bubble to row
    row.appendChild(bubble);

    // append to chat
    chat.appendChild(row);

    // attach interactions (context menu / longpress)
    try{ if(typeof window.attachMessageInteractions === 'function') window.attachMessageInteractions(row, message); }catch(e){}

    // call centralized icons helper if present (icons.js will expose this)
    try{ if(window._abrox && typeof window._abrox.iconify === 'function') window._abrox.iconify(); }catch(e){}

    // auto-scroll vs unread button logic
    try{
      if(autoScroll && isChatNearBottom(chat)){
        chat.scrollTop = chat.scrollHeight;
      } else {
        const unreadBtn = document.getElementById('unreadBtn');
        if(unreadBtn) unreadBtn.style.display = 'block';
      }
    }catch(e){}

    // expose ID to external index map (if MessagePool exists it's responsible for mapping ids)
    try{ if(window.MessagePool && window.MessagePool._idIndex && message.id) window.MessagePool._idIndex[message.id] = (window.MessagePool._idIndex[message.id] || 0); }catch(e){}

    return row;
  }

  // expose globally
  window.renderMessage = renderMessage;

  console.info('message.js loaded — unified renderMessage ready.');
})();
