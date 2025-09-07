(() => {
  const $ = (q) => document.querySelector(q);
  const fmt = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  };

  async function blobToBase64(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        resolve(String(dataUrl).split(',')[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Realtime streaming via WebSocket. Sends MediaRecorder chunks to server.
  const realtime = (() => {
    const ui = {
      card: $('#realtimeCard'),
      toggleBtn: $('#toggleRealtimeBtn'),
      statusIndicator: $('#statusIndicator'),
      statusText: $('#statusText'),
      transcript: $('#realtimeTranscript'),
      interim: $('#interimTranscript'),
      confFill: $('#confidenceFill'),
      confVal: $('#confidenceValue'),
      wordCount: $('#wordCount'),
      duration: $('#transcriptDuration'),
      lastUpdate: $('#lastUpdate'),
    };
    let ws = null;
    let enabled = false;
    let connected = false;
    let startTs = 0;

    function setStatus(kind, text){
      if (!ui.statusIndicator || !ui.statusText) return;
      ui.statusIndicator.classList.remove('connected','connecting','error');
      if (kind) ui.statusIndicator.classList.add(kind);
      ui.statusText.textContent = text || '';
    }
    function openSocket(){
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const lang = (document.querySelector('#languageSelect')?.value || 'en');
      const tpl = (document.querySelector('#templateSelect')?.value || 'general');
      const url = `${scheme}://${location.host}/ws/transcribe?language=${encodeURIComponent(lang)}&template=${encodeURIComponent(tpl)}`;
      try { ws = new WebSocket(url, 'transcription'); } catch { setStatus('error','WebSocket unsupported'); return; }
      setStatus('connecting','Connecting...');
      ws.onopen = () => { connected = true; startTs = Date.now(); setStatus('connected','Connected'); };
      ws.onclose = () => { connected = false; setStatus(enabled ? 'error' : '', enabled ? 'Disconnected' : ''); };
      ws.onerror = () => { connected = false; setStatus('error', 'Connection error'); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'transcript_update') {
            const t = String(msg.transcript || '').trim();
            const interim = String(msg.interimTranscript || '').trim();
            if (ui.transcript && t) ui.transcript.innerText = t;
            if (ui.interim) {
              if (interim) { ui.interim.textContent = interim; ui.interim.classList.add('visible'); }
              else { ui.interim.textContent = ''; ui.interim.classList.remove('visible'); }
            }
            const conf = Math.max(0, Math.min(1, Number(msg.confidence || 0)));
            if (ui.confFill) ui.confFill.style.width = `${Math.round(conf*100)}%`;
            if (ui.confVal) ui.confVal.textContent = `${Math.round(conf*100)}%`;
            if (ui.wordCount) ui.wordCount.textContent = t ? t.split(/\s+/).filter(Boolean).length : 0;
            if (ui.duration) {
              const dur = Math.floor((Number(msg.sessionDuration || (Date.now()-startTs))) / 1000);
              const mm = String(Math.floor(dur/60)).padStart(2,'0');
              const ss = String(dur%60).padStart(2,'0');
              ui.duration.textContent = `${mm}:${ss}`;
            }
            if (ui.lastUpdate) ui.lastUpdate.textContent = new Date().toLocaleTimeString();
          }
          if (msg.type === 'error') setStatus('error', msg.message || 'Server error');
        } catch {}
      };
    }
    async function sendBlob(blob){ if (connected && ws?.readyState === WebSocket.OPEN) { try { ws.send(await blob.arrayBuffer()); } catch {} } }
    function close(){ try { ws?.close(); } catch{} ws=null; connected=false; }

    return {
      get isEnabled(){ return enabled; },
      get isConnected(){ return connected; },
      enable(){ enabled = true; ui.card?.classList.remove('hidden'); openSocket(); },
      disable(){ enabled = false; close(); ui.card?.classList.add('hidden'); },
      toggle(){ enabled ? this.disable() : this.enable(); },
      hook(rec){ if (!rec) return; const prev = rec.ondataavailable; rec.ondataavailable = (e)=>{ if (e?.data && e.data.size) sendBlob(e.data); if (typeof prev==='function') prev(e); }; },
      ui,
    };
  })();

  const state = {
    recording: false,
    media: null,
    recorder: null,
    chunks: [],
    startedAt: 0,
    tick: null,
    seconds: 0,
    currentBlob: null,
    currentMeta: null,
    currentTranscript: '',
    currentSummary: '',
    currentDetectedLanguage: ''
  };

  const timerEl = $('#timer');
  const recordBtn = $('#recordBtn');
  const sessionCard = $('#sessionCard');
  const sessionMeta = $('#sessionMeta');
  const downloadBtn = $('#downloadBtn');
  const transcribeBtn = $('#transcribeBtn');
  const copyBtn = $('#copyBtn');
  const shareWABtn = $('#shareWABtn');
  const shareEmailBtn = $('#shareEmailBtn');
  const transcriptEl = $('#transcript');
  const summaryEl = $('#summary');
  const languageSelect = $('#languageSelect');
  const templateSelect = $('#templateSelect');
  const contentMain = document.querySelector('main.content');
  const panes = $('#panes');
  const STORAGE_KEY = 'meeting-app.recordings.v1';

  function loadRecordings(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
  function saveRecordings(list){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch {} }

  function updateTimer(){ const elapsed = (Date.now() - state.startedAt) / 1000; state.seconds = elapsed; if (timerEl) timerEl.textContent = fmt(elapsed); }

  async function start(){
    if (state.recording) return;
    try { state.media = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { alert('Microphone permission is required to record.'); return; }

    state.chunks = [];
    try {
      const preferred = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4','audio/wav'];
      let mime = '';
      for (const t of preferred) if (window.MediaRecorder?.isTypeSupported?.(t) && !mime) mime = t;
      state.recorder = new MediaRecorder(state.media, mime ? { mimeType: mime } : undefined);
    } catch { alert('Your browser does not support audio recording.'); return; }

    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
    state.recorder.onstop = onStop;
    state.recorder.onerror = () => { alert('Recording error occurred.'); stop(); };

    // Stream chunks to server if realtime enabled
    realtime.hook(state.recorder);

    state.recorder.start(1000);
    state.startedAt = Date.now();
    state.tick = setInterval(updateTimer, 200);

    if (recordBtn) { recordBtn.textContent = 'STOP'; recordBtn.classList.add('recording'); }
    state.recording = true;
    sessionCard?.classList.add('hidden');

    if (realtime.isEnabled) { realtime.ui?.card?.classList.remove('hidden'); }
  }

  function stop(){
    if (!state.recording) return;
    try { state.recorder && state.recorder.state !== 'inactive' && state.recorder.stop(); } catch {}
    try { state.media?.getTracks()?.forEach(t => t.stop()); } catch {}
    try { state.tick && clearInterval(state.tick); } catch {}
    state.tick = null;
    if (recordBtn) { recordBtn.textContent = 'RECORD'; recordBtn.classList.remove('recording'); }
    state.recording = false;
  }

  function onStop(){
    if (!state.chunks.length) { alert('No audio was recorded.'); return; }
    const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
    state.currentBlob = blob;
    const meta = {
      id: (crypto?.randomUUID?.() || String(Date.now())),
      createdAt: new Date().toISOString(),
      durationSec: Math.round(state.seconds),
      language: languageSelect?.value || 'auto',
      template: templateSelect?.value || 'general',
      size: blob.size,
      mimeType: blob.type
    };
    state.currentMeta = meta;

    sessionCard?.classList.remove('hidden');
    if (downloadBtn) downloadBtn.disabled = false;
    if (transcribeBtn) transcribeBtn.disabled = false;
    if (transcriptEl) transcriptEl.textContent = '';
    if (summaryEl) summaryEl.textContent = '';
    if (sessionMeta) {
      const langLabelInit = (meta.language || 'auto').toUpperCase();
      sessionMeta.innerHTML = `${fmt(meta.durationSec)} • <span class="badge">${langLabelInit}</span> • ${meta.template}`;
    }

    blobToBase64(blob).then((b64) => {
      const list = loadRecordings();
      const row = { meta, audioB64: b64 };
      if (realtime.ui?.transcript?.innerText) {
        row.transcript = realtime.ui.transcript.innerText;
        if (transcriptEl) transcriptEl.textContent = row.transcript;
        if (copyBtn) copyBtn.disabled = false;
        if (shareWABtn) shareWABtn.disabled = false;
        if (shareEmailBtn) shareEmailBtn.disabled = false;
        if (sessionMeta) sessionMeta.innerHTML += ' • <span class="badge" style="background:#10b981;color:#fff">Live Transcript</span>';
      }
      list.unshift(row);
      saveRecordings(list);
      renderLists();
    }).catch(() => alert('Failed to save recording.'));
  }

  // UI events
  recordBtn?.addEventListener('click', () => state.recording ? stop() : start());
  realtime.ui.toggleBtn?.addEventListener('click', () => {
    realtime.toggle();
    if (realtime.isEnabled) {
      realtime.ui.toggleBtn.innerHTML = realtime.ui.toggleBtn.innerHTML.replace('Enable Real-time','Disable Real-time');
    } else {
      realtime.ui.toggleBtn.innerHTML = realtime.ui.toggleBtn.innerHTML.replace('Disable Real-time','Enable Real-time');
    }
  });

  downloadBtn?.addEventListener('click', () => {
    if (!state.currentBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(state.currentBlob);
    a.download = `meeting-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.webm`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  });

  transcribeBtn?.addEventListener('click', async () => {
    if (!state.currentBlob) return;
    transcribeBtn.disabled = true;
    transcribeBtn.textContent = 'Transcribing...';
    transcriptEl.textContent = 'Sending audio to server for transcription...';
    summaryEl.textContent = '';
    try {
      const b64 = await blobToBase64(state.currentBlob);
      const res = await fetch('/api/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioB64: b64,
          mimeType: state.currentBlob.type || 'audio/webm',
          language: languageSelect?.value || 'auto',
          template: templateSelect?.value || 'general',
          durationSec: state.currentMeta?.durationSec || 0,
        })
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      transcriptEl.textContent = data.transcript || '(no transcript)';
      summaryEl.textContent = data.summary || '';
      state.currentTranscript = data.transcript || '';
      state.currentSummary = data.summary || '';
      state.currentDetectedLanguage = data.detectedLanguage || '';
      if (data.detectedLanguage && sessionMeta) {
        const langLabel = data.detectedLanguage.toUpperCase();
        sessionMeta.innerHTML = `${fmt(state.currentMeta?.durationSec || 0)} • <span class="badge">${langLabel}</span> • ${state.currentMeta?.template || ''}`;
      }
      const list = loadRecordings();
      if (list[0]?.meta?.id === state.currentMeta?.id) {
        list[0].transcript = data.transcript;
        list[0].summary = data.summary;
        if (data.detectedLanguage) list[0].meta.detectedLanguage = data.detectedLanguage;
        saveRecordings(list);
        renderLists();
      }
      if (shareWABtn) shareWABtn.disabled = false;
      if (shareEmailBtn) shareEmailBtn.disabled = false;
      if (copyBtn) copyBtn.disabled = false;
    } catch (err) {
      transcriptEl.textContent = `Transcription failed: ${err.message}`;
    } finally {
      transcribeBtn.disabled = false;
      transcribeBtn.textContent = 'Transcribe';
    }
  });

  function buildShareText(meta, summary, transcript) {
    const d = meta?.createdAt ? new Date(meta.createdAt).toLocaleString() : new Date().toLocaleString();
    const lang = (state.currentDetectedLanguage || meta?.detectedLanguage || meta?.language || languageSelect?.value || 'en');
    const header = `Meeting Notes • ${d}\nLanguage: ${String(lang).toUpperCase()} • Template: ${(meta?.template || templateSelect?.value)} • Duration: ${fmt(meta?.durationSec || 0)}`;
    const parts = [header];
    if (summary) parts.push('\nSummary:\n' + summary.trim());
    if (transcript) parts.push('\nTranscript:\n' + transcript.trim());
    return parts.join('\n\n');
  }
  function shareWA(text){ window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); }
  function shareEmail(subject, text){ window.location.href = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(text); }
  async function copyToClipboard(text){ try { if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text); } catch {} const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } finally { document.body.removeChild(ta); } }

  shareWABtn?.addEventListener('click', () => { if (shareWABtn.disabled) return; const text = buildShareText(state.currentMeta, state.currentSummary, state.currentTranscript); shareWA(text); });
  copyBtn?.addEventListener('click', async () => { if (copyBtn.disabled) return; const text = buildShareText(state.currentMeta, state.currentSummary, state.currentTranscript); await copyToClipboard(text); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); });
  shareEmailBtn?.addEventListener('click', () => { if (shareEmailBtn.disabled) return; const subject = 'Meeting Notes'; const text = buildShareText(state.currentMeta, state.currentSummary, state.currentTranscript); shareEmail(subject, text); });

  function renderLists(){
    const pastPane = document.querySelector('.pane[data-pane="past"]');
    const filesPane = document.querySelector('.pane[data-pane="files"]');
    const upPane = document.querySelector('.pane[data-pane="upcoming"]');
    const list = loadRecordings();
    if (!pastPane || !filesPane || !upPane) return;

    pastPane.innerHTML = '<div class="card" id="allSummaryCard">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">'
      +   '<div>'
      +     '<div class="session-title">Summarize All Meetings</div>'
      +     '<div class="session-sub">Creates an overall brief, action plan, and folders</div>'
      +   '</div>'
      +   '<div class="session-actions">'
      +     '<button id="summarizeAllBtn" class="primary">Summarize All</button>'
      +     '<button id="exportAllMdBtn" class="secondary" disabled>Export All .md</button>'
      +     '<button id="exportAllCsvBtn" class="secondary" disabled>Export All .csv</button>'
      +     '<button id="shareAllWABtn" class="secondary" disabled>Share Brief</button>'
      +     '<button id="shareAllEmailBtn" class="secondary" disabled>Email Brief</button>'
      +   '</div>'
      + '</div>'
      + '<div id="allSummaryOut" class="transcript" style="display:none"></div>'
      + '<div id="foldersOut" class="summary" style="display:none"></div>'
      + '</div>'
      + '<div class="list"></div>';
    filesPane.innerHTML = '<div class="list"></div>';
    upPane.innerHTML = '<div class="card">Add upcoming meetings to your calendar and sync notes later.</div>';

    const pastList = pastPane.querySelector('.list');
    const fileList = filesPane.querySelector('.list');

    if (!list.length) { pastList.innerHTML = '<div class="card">No past recordings yet.</div>'; fileList.innerHTML = '<div class="card">No files yet.</div>'; return; }

    list.forEach((row, idx) => {
      const d = new Date(row.meta.createdAt);
      const title = `Meeting • ${d.toLocaleString()}`;
      const sub = `${fmt(row.meta.durationSec)} • ${row.meta.language.toUpperCase()} • ${row.meta.template}`;
      const el = document.createElement('div');
      el.className = 'item';
      const displayLang = (row.meta.detectedLanguage || row.meta.language || '').toUpperCase();
      const tags = `<div class="meta-extras">${displayLang ? `<span class=\"badge\">${displayLang}</span>` : ''}</div>`;
      el.innerHTML = `
        <div class="meta">
          <div class="title">${title}</div>
          <div class="sub">${sub}</div>
          ${tags}
        </div>
        <div class="actions">
          <button class="secondary" data-act="play">Play</button>
          <button class="secondary" data-act="download">Download</button>
          <button class="primary" data-act="transcribe">Transcribe</button>
          <button class="secondary" data-act="copy" ${row.transcript ? '' : 'disabled'}>Copy</button>
          <button class="secondary" data-act="wa" ${row.transcript ? '' : 'disabled'}>WA</button>
          <button class="secondary" data-act="email" ${row.transcript ? '' : 'disabled'}>Email</button>
        </div>`;
      el.addEventListener('click', async (e) => {
        const act = e.target.closest('button')?.dataset?.act;
        if (!act) return;
        if (act === 'play') {
          const audio = new Audio('data:audio/webm;base64,' + row.audioB64); audio.play();
        } else if (act === 'download') {
          const a = document.createElement('a'); a.href = 'data:audio/webm;base64,' + row.audioB64; a.download = `meeting-${idx + 1}.webm`; a.click();
        } else if (act === 'transcribe') {
          try {
            const res = await fetch('/api/transcribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ audioB64: row.audioB64, mimeType: 'audio/webm', language: row.meta.language, template: row.meta.template, durationSec: row.meta.durationSec }) });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json(); row.transcript = data.transcript; row.summary = data.summary; if (data.detectedLanguage) row.meta.detectedLanguage = data.detectedLanguage; saveRecordings(list); renderLists();
          } catch (err) { alert('Transcription failed: ' + err.message); }
        } else if (act === 'copy') {
          try { const text = buildShareText(row.meta, row.summary, row.transcript); await copyToClipboard(text); alert('Copied to clipboard'); } catch {}
        } else if (act === 'wa') { const text = buildShareText(row.meta, row.summary, row.transcript); shareWA(text); }
        else if (act === 'email') { const subject='Meeting Notes'; const text = buildShareText(row.meta, row.summary, row.transcript); shareEmail(subject, text); }
      });
      pastList.appendChild(el);
    });
  }

  // Bottom navigation tabs
  function switchTab(tab){
    document.querySelectorAll('.tabbar .tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    document.querySelectorAll('#panes .pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
    if (tab === 'record') { contentMain?.classList.remove('hidden'); panes?.classList.add('hidden'); }
    else { contentMain?.classList.add('hidden'); panes?.classList.remove('hidden'); if (tab === 'past' || tab === 'files') renderLists(); }
  }
  document.querySelectorAll('.tabbar .tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // Init
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.MediaRecorder) { alert('Your browser does not support audio recording. Please use a modern browser.'); recordBtn && (recordBtn.disabled = true); return; }
    if (!navigator.mediaDevices?.getUserMedia) { alert('Microphone access not supported. Use HTTPS in a modern browser.'); recordBtn && (recordBtn.disabled = true); return; }
    renderLists();
    switchTab('record');
  });
})();

