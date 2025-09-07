// Enhanced Node server with WebSocket support for real-time transcription
// - Serves static files from ../meeting-app
// - Provides POST /api/transcribe that proxies to OpenAI
// - WebSocket endpoint for real-time transcription streaming
// Usage:
//   set OPENAI_API_KEY=...  (Windows CMD)
//   $Env:OPENAI_API_KEY="..."  (PowerShell)
//   node server/server.js

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..', 'meeting-app');

const PORT = process.env.PORT || 5173;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Store active transcription sessions
const transcriptionSessions = new Map();

// Simple FormData implementation for Node.js
class SimpleFormData {
  constructor() {
    this.boundary = '----formdata-' + Math.random().toString(36);
    this.data = [];
  }
  
  append(name, value, filename) {
    let header = `--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (filename) {
      header += `; filename="${filename}"\r\nContent-Type: application/octet-stream`;
    }
    header += '\r\n\r\n';
    
    this.data.push(Buffer.from(header, 'utf8'));
    this.data.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    this.data.push(Buffer.from('\r\n', 'utf8'));
  }
  
  getBuffer() {
    this.data.push(Buffer.from(`--${this.boundary}--\r\n`, 'utf8'));
    return Buffer.concat(this.data);
  }
  
  getContentType() {
    return `multipart/form-data; boundary=${this.boundary}`;
  }
}

// WebSocket implementation
const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function generateAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_STRING)
    .digest('base64');
}

function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  
  const fin = (firstByte & 0x80) === 0x80;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) === 0x80;
  let payloadLength = secondByte & 0x7f;
  
  let offset = 2;
  
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    payloadLength = buffer.readBigUInt64BE(offset);
    offset += 8;
  }
  
  if (masked) {
    if (buffer.length < offset + 4) return null;
    const maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
    
    if (buffer.length < offset + Number(payloadLength)) return null;
    const payload = buffer.slice(offset, offset + Number(payloadLength));
    const frameLength = offset + Number(payloadLength);
    
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
    
    return { fin, opcode, payload, frameLength };
  }
  
  if (buffer.length < offset + Number(payloadLength)) return null;
  const payload = buffer.slice(offset, offset + Number(payloadLength));
  const frameLength = offset + Number(payloadLength);
  
  return { fin, opcode, payload, frameLength };
}

function createWebSocketFrame(opcode, payload) {
  const payloadLength = payload.length;
  let frame;
  
  if (payloadLength < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLength);
    frame[0] = 0x80 | opcode; // FIN = 1
    frame[1] = payloadLength;
    payload.copy(frame, 2);
  } else if (payloadLength < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLength);
    frame[0] = 0x80 | opcode;
    frame[1] = 126;
    frame.writeUInt16BE(payloadLength, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLength);
    frame[0] = 0x80 | opcode;
    frame[1] = 127;
    const lenBig = BigInt(payloadLength);
    frame.writeBigUInt64BE(lenBig, 2);
    payload.copy(frame, 10);
  }
  return frame;
}

class TranscriptionSession {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.id = crypto.randomUUID();
    this.language = options.language || 'en';
    this.template = options.template || 'general';
    this.audioChunks = [];
    this.transcript = '';
    this.interimTranscript = '';
    this.isActive = true;
    this.lastProcessTime = Date.now();
    this.confidenceThreshold = 0.7;
    this.chunkDuration = 3000; // Process every 3 seconds
    this.processingTimer = null;
    this.maxChunks = 20; // Limit memory usage
    this.totalProcessedChunks = 0;
    this.sessionStartTime = Date.now();
    
    this.startProcessing();
  }
  
  addAudioChunk(audioData) {
    if (!this.isActive) return;
    
    // Limit memory usage by keeping only recent chunks
    if (this.audioChunks.length >= this.maxChunks) {
      this.audioChunks.shift(); // Remove oldest chunk
    }
    
    this.audioChunks.push({
      data: audioData,
      timestamp: Date.now(),
      processed: false
    });
    
    // Process chunks periodically for real-time transcription
    if (!this.processingTimer) {
      this.processingTimer = setTimeout(() => {
        this.processAudioChunks();
      }, this.chunkDuration);
    }
  }
  
  async processAudioChunks() {
    if (!this.isActive || this.audioChunks.length === 0) {
      // Reschedule if still active
      if (this.isActive) {
        this.processingTimer = setTimeout(() => {
          this.processAudioChunks();
        }, this.chunkDuration);
      }
      return;
    }
    
    try {
      // Get unprocessed chunks
      const unprocessedChunks = this.audioChunks.filter(chunk => !chunk.processed);
      if (unprocessedChunks.length === 0) {
        this.scheduleNextProcessing();
        return;
      }
      
      // Combine recent unprocessed audio chunks (limit to avoid API limits)
      const chunksToProcess = unprocessedChunks.slice(0, Math.min(3, unprocessedChunks.length));
      const combinedAudio = Buffer.concat(chunksToProcess.map(chunk => chunk.data));
      
      // Skip if audio chunk is too small (less than 1 second of audio)
      if (combinedAudio.length < 8000) { // Rough estimate for 1 second at 8kHz
        this.scheduleNextProcessing();
        return;
      }
      
      // Convert to base64 for OpenAI API
      const audioB64 = combinedAudio.toString('base64');
      
      // Send to OpenAI for transcription
      const transcript = await this.transcribeChunk(audioB64);
      
      if (transcript && transcript.trim()) {
        // Mark chunks as processed
        chunksToProcess.forEach(chunk => chunk.processed = true);
        this.totalProcessedChunks += chunksToProcess.length;
        
        // Update transcript (avoid duplicates)
        const newText = transcript.trim();
        if (!this.transcript.includes(newText)) {
          this.interimTranscript = newText;
          this.transcript += (this.transcript ? ' ' : '') + newText;
          
          // Limit transcript length to prevent memory issues
          const maxTranscriptLength = 50000; // ~50KB
          if (this.transcript.length > maxTranscriptLength) {
            this.transcript = this.transcript.slice(-maxTranscriptLength * 0.8); // Keep last 80%
          }
          
          // Send real-time update to client
          this.sendTranscriptUpdate({
            type: 'transcript_update',
            transcript: this.transcript,
            interimTranscript: this.interimTranscript,
            confidence: this.calculateConfidence(newText),
            timestamp: Date.now(),
            sessionDuration: Date.now() - this.sessionStartTime,
            processedChunks: this.totalProcessedChunks
          });
        }
      }
      
      this.scheduleNextProcessing();
      
    } catch (error) {
      console.error('Error processing audio chunks:', error);
      this.sendError('Transcription processing error: ' + error.message);
      this.scheduleNextProcessing();
    }
  }
  
  scheduleNextProcessing() {
    this.processingTimer = setTimeout(() => {
      this.processAudioChunks();
    }, this.chunkDuration);
  }
  
  calculateConfidence(text) {
    // Simple confidence calculation based on text characteristics
    let confidence = 0.8;
    
    // Longer text generally has higher confidence
    if (text.length > 50) confidence += 0.1;
    if (text.length < 10) confidence -= 0.2;
    
    // Check for common words (higher confidence)
    const commonWords = ['the', 'and', 'is', 'to', 'a', 'in', 'that', 'have', 'for', 'not'];
    const words = text.toLowerCase().split(' ');
    const commonWordCount = words.filter(word => commonWords.includes(word)).length;
    confidence += (commonWordCount / words.length) * 0.2;
    
    // Penalize for special characters or numbers (might indicate transcription errors)
    const specialCharCount = (text.match(/[^a-zA-Z0-9\s.,!?]/g) || []).length;
    confidence -= (specialCharCount / text.length) * 0.3;
    
    return Math.max(0.3, Math.min(1.0, confidence));
  }
  
  async transcribeChunk(audioB64) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured');
    }
    try {
      const audioBuf = Buffer.from(audioB64, 'base64');
      // Skip if audio is too small
      if (audioBuf.length < 1000) {
        return '';
      }
      const form = new SimpleFormData();
      form.append('file', audioBuf, 'chunk.webm');
      form.append('model', 'whisper-1');
      // Force English output regardless of spoken language
      form.append('translate', 'true');
      form.append('language', 'en');
      // Add timeout for API requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": form.getContentType()
        },
        body: form.getBuffer(),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Rate limited, please try again');
        }
        throw new Error(`OpenAI API error: ${response.status}`);
      }
      const result = await response.json();
      return result.text || '';
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('Transcription request timed out');
        return '';
      }
      console.error('Transcription error:', error);
      return '';
    }
  }
  
  sendTranscriptUpdate(data) {
    if (!this.isActive || this.ws.readyState !== 1) return;
    
    try {
      const message = JSON.stringify(data);
      const frame = createWebSocketFrame(0x01, Buffer.from(message, 'utf8'));
      this.ws.write(frame);
    } catch (error) {
      console.error('Error sending transcript update:', error);
    }
  }
  
  sendError(message) {
    if (!this.isActive || this.ws.readyState !== 1) return;
    
    try {
      const errorData = JSON.stringify({
        type: 'error',
        message: message,
        timestamp: Date.now()
      });
      const frame = createWebSocketFrame(0x01, Buffer.from(errorData, 'utf8'));
      this.ws.write(frame);
    } catch (error) {
      console.error('Error sending error message:', error);
    }
  }
  
  startProcessing() {
    // Send initial connection confirmation
    this.sendTranscriptUpdate({
      type: 'connection_established',
      sessionId: this.id,
      message: 'Real-time transcription started',
      timestamp: Date.now(),
      language: this.language,
      template: this.template
    });
  }
  
  async finalize() {
    this.isActive = false;
    
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
    
    // Process any remaining unprocessed chunks
    const unprocessedChunks = this.audioChunks.filter(chunk => !chunk.processed);
    if (unprocessedChunks.length > 0) {
      try {
        await this.processAudioChunks();
      } catch (error) {
        console.error('Error processing final chunks:', error);
      }
    }
    
    // Generate final summary if we have transcript
    if (this.transcript.trim()) {
      try {
        const summary = await this.generateSummary();
        this.sendTranscriptUpdate({
          type: 'session_complete',
          finalTranscript: this.transcript.trim(),
          summary: summary,
          timestamp: Date.now(),
          sessionDuration: Date.now() - this.sessionStartTime,
          totalProcessedChunks: this.totalProcessedChunks,
          wordCount: this.transcript.split(' ').filter(word => word.trim()).length
        });
      } catch (error) {
        console.error('Error generating final summary:', error);
      }
    }
    
    // Clean up
    this.audioChunks = [];
    transcriptionSessions.delete(this.id);
    
    console.log(`Transcription session ${this.id} finalized. Processed ${this.totalProcessedChunks} chunks.`);
  }
  
  async generateSummary() {
    if (!this.transcript.trim()) return '';
    
    try {
      const summary = await summarizeOne({
        template: this.template,
        language: this.language,
        durationSec: Math.floor((Date.now() - this.sessionStartTime) / 1000),
        transcript: this.transcript
      });
      return summary;
    } catch (error) {
      console.error('Error generating summary:', error);
      return '';
    }
  }
}

// WebSocket upgrade handler
function handleWebSocketUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  
  const acceptKey = generateAcceptKey(key);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    'Sec-WebSocket-Protocol: transcription',
    '\r\n'
  ].join('\r\n');
  
  socket.write(responseHeaders);
  
  // Parse query parameters for session options
  const url = new URL(req.url, 'http://localhost');
  const language = url.searchParams.get('language') || 'en';
  const template = url.searchParams.get('template') || 'general';
  
  // Create transcription session
  const session = new TranscriptionSession(socket, { language, template });
  transcriptionSessions.set(session.id, session);
  
  let buffer = Buffer.alloc(0);
  
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    
    while (buffer.length > 0) {
      const frame = parseWebSocketFrame(buffer);
      if (!frame) break;
      
      buffer = buffer.slice(frame.frameLength);
      
      if (frame.opcode === 0x08) { // Close frame
        session.finalize();
        socket.end();
        return;
      }
      
      if (frame.opcode === 0x01 || frame.opcode === 0x02) { // Text or binary frame
        try {
          if (frame.opcode === 0x01) { // Text frame - control messages
            const message = JSON.parse(frame.payload.toString('utf8'));
            handleWebSocketMessage(session, message);
          } else { // Binary frame - audio data
            session.addAudioChunk(frame.payload);
          }
        } catch (error) {
          console.error('Error processing WebSocket frame:', error);
          session.sendError('Invalid message format');
        }
      }
    }
  });
  
  socket.on('close', () => {
    session.finalize();
  });
  
  socket.on('error', (error) => {
    console.error('WebSocket error:', error);
    session.finalize();
  });
}

function handleWebSocketMessage(session, message) {
  switch (message.type) {
    case 'config_update':
      if (message.language) session.language = message.language;
      if (message.template) session.template = message.template;
      if (message.confidenceThreshold) session.confidenceThreshold = message.confidenceThreshold;
      break;
      
    case 'ping':
      session.sendTranscriptUpdate({ type: 'pong', timestamp: Date.now() });
      break;
      
    case 'get_transcript':
      session.sendTranscriptUpdate({
        type: 'current_transcript',
        transcript: session.transcript,
        timestamp: Date.now()
      });
      break;
      
    default:
      session.sendError('Unknown message type: ' + message.type);
  }
}

// Basic MIME types for static serving
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'audio/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

function serveStatic(req, res) {
  let reqPath = new URL(req.url, 'http://localhost').pathname;
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(root, reqPath);
  if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleTranscribe(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method Not Allowed'); }
  try {
    if (!process.env.OPENAI_API_KEY) { res.writeHead(500); return res.end('Missing OPENAI_API_KEY'); }
    const body = await readJson(req);
    const audioB64 = (body && body.audioB64) || '';
    const durationSec = Number(body?.durationSec || 0);
    const template = body?.template || 'general';
    const language = body?.language || 'auto';

    // Use provided transcript if any; otherwise transcribe
    let transcript = (body?.transcript || '').trim();
    if (!transcript && audioB64) {
      transcript = await transcribeToText({ audioB64, mimeType: body?.mimeType || 'audio/webm', language: language === 'auto' ? 'en' : language });
    }

    // Detect language only for display; keep summary in English unless user overrides
    let detectedLanguage = '';
    if ((!language || language === 'auto') && transcript) {
      detectedLanguage = await detectLanguage(transcript).catch(() => '');
    }
    const summaryLanguage = (language && language !== 'auto') ? language : 'en';

    const summary = await summarizeOne({ template, language: summaryLanguage, durationSec, transcript });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ transcript, summary, detectedLanguage }));
  } catch (err) {
    res.writeHead(500); res.end(String(err.stack || err.message || err));
  }
}

function buildPrompt(template, language, durationSec, transcript) {
  const templates = {
    general: `Summarize the meeting transcript into:
    - Summary (3–5 bullets)
    - Decisions
    - Action Items (owner • task • due)
    Keep it concise.`,
    standup: `Create a standup report grouped by person with: Yesterday, Today, Blockers. Then list risks.`,
    oneonone: `Summarize key discussion points, feedback, and follow-ups for each attendee.`,
    interview: `Provide candidate strengths/concerns mapped to role requirements and a hire/no-hire recommendation.`,
    brainstorm: `Cluster ideas by theme, capture pros/cons, and next experiments.`
  };
  const tpl = templates[template] || templates.general;
  return `Language: ${language}
Duration: ${durationSec}s
Instruction: ${tpl}

Transcript:
${transcript}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const MAX = parseInt(process.env.JSON_LIMIT_BYTES || '100000000', 10); // default 100MB
    let data = '';
    let received = 0;
    req.on('data', (c) => {
      received += c.length || 0;
      if (received > MAX) { try { req.destroy(); } catch {} return reject(new Error('Payload too large')); }
      data += c;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers + API routing
  if (req.url.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url.startsWith('/api/transcribe')) {
      return handleTranscribe(req, res);
    }

    if (req.url.startsWith('/api/summary-all')) {
      return handleSummaryAll(req, res);
    }

    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        timestamp: Date.now(),
        activeSessions: transcriptionSessions.size,
        openaiConfigured: !!process.env.OPENAI_API_KEY
      }));
    }

    res.writeHead(404);
    return res.end('Not found');
  }

  // Static content
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end('Not found');
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ws/transcribe')) {
    handleWebSocketUpgrade(req, socket, head);
  } else {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  }
});

server.listen(PORT, () => {
  console.log(`🎙️  Meeting app server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws/transcribe`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️  Set OPENAI_API_KEY environment variable to enable transcription');
  } else {
    console.log('✅ OpenAI API configured for transcription');
  }
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  
  // Close all active transcription sessions
  for (const session of transcriptionSessions.values()) {
    session.finalize();
  }
  
  server.close(() => {
    console.log('✅ Server closed gracefully');
    process.exit(0);
  });
});

// ---------- OpenAI helpers ----------

async function transcribeToText({ audioB64, mimeType, language }) {
  const audioBuf = Buffer.from(audioB64, 'base64');
  const form = new SimpleFormData();
  form.append('file', audioBuf, 'meeting.webm');
  form.append('model', 'whisper-1');
  // Force English transcript even for multi-language audio
  form.append('translate', 'true');
  form.append('language', 'en');
  
  const tResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": form.getContentType()
    },
    body: form.getBuffer()
  });
  if (!tResp.ok) throw new Error(await tResp.text());
  const tJson = await tResp.json();
  return tJson.text || '';
}

async function summarizeOne({ template, language, durationSec, transcript }) {
  const prompt = buildPrompt(template, language, durationSec, transcript);
  const cResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a diligent meeting scribe. Produce clean, actionable notes.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
    })
  });
  if (!cResp.ok) throw new Error(await cResp.text());
  const cJson = await cResp.json();
  return cJson.choices?.[0]?.message?.content || '';
}

async function handleSummaryAll(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('Method Not Allowed'); }
  try {
    if (!process.env.OPENAI_API_KEY) { res.writeHead(500); return res.end('Missing OPENAI_API_KEY'); }
    const body = await readJson(req);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) { res.writeHead(400); return res.end('No items provided'); }

    // Ensure transcripts exist; limit per-item transcript size to avoid token blowup
    const transcripts = [];
    for (const it of items) {
      let t = (it.transcript || '').trim();
      if (!t) {
        t = await transcribeToText({ audioB64: it.audioB64, mimeType: it.mimeType || 'audio/webm', language: it.language || 'en' });
      }
      // keep first ~8k chars per transcript
      transcripts.push({
        title: it.title || it.meta?.title || `Meeting ${it.meta?.createdAt || ''}`,
        language: it.language || it.meta?.language || 'en',
        template: it.template || it.meta?.template || 'general',
        durationSec: it.durationSec || it.meta?.durationSec || 0,
        text: (t || '').slice(0, 8000)
      });
    }

    const overall = await summarizeAll(transcripts);
    const cats = await categorizeAll(transcripts);
    // Build item -> categories mapping from indices
    const itemCategories = Array.from({ length: transcripts.length }, () => []);
    for (const c of (cats.categories || [])) {
      for (const it of (c.items || [])) {
        const idx = typeof it.index === 'number' ? it.index : it.idx;
        if (idx != null && itemCategories[idx]) itemCategories[idx].push(c.name);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...overall, ...cats, itemCategories }));
  } catch (err) {
    res.writeHead(500); res.end(String(err.stack || err.message || err));
  }
}

async function summarizeAll(transcripts) {
  const sections = transcripts.map((t, i) => (
    `# Meeting ${i + 1}
Language: ${t.language}
Template: ${t.template}
Duration: ${t.durationSec}s
Transcript:\n${t.text}`
  )).join('\n\n');

  const prompt = `You are an operations chief compiling notes across multiple meetings.\n\n` +
`For ALL meetings combined, produce: \n` +
`1) Overall Summary (5-10 bullets)\n` +
`2) Consolidated Decisions (deduplicate similar ones)\n` +
`3) Consolidated Action Plan: table-like list with fields -> Owner • Task • Context/Meeting • Due (if stated) • Priority. Merge duplicates and resolve conflicts.\n` +
`4) Risks/Blockers\n` +
`Keep it concise and actionable.\n\n` + sections;

  const cResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You synthesize multiple meetings into a single, de-duplicated briefing with clear action items.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
    })
  });
  if (!cResp.ok) throw new Error(await cResp.text());
  const cJson = await cResp.json();
  const combined = cJson.choices?.[0]?.message?.content || '';
  return { combined };
}

async function detectLanguage(transcript) {
  if (!transcript) return '';
  const prompt = `Detect the primary spoken language/variant for this transcript. Choose exactly one of: Cantonese, Hokkien, Mandarin Chinese, English, Malay, Other. Respond with JSON {"language":"..."}. Transcript:\n${transcript.slice(0, 4000)}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    })
  });
  if (!r.ok) return '';
  const j = await r.json();
  try { return JSON.parse(j.choices?.[0]?.message?.content || '{}').language || ''; } catch { return ''; }
}

async function categorizeAll(transcripts) {
  const items = transcripts.map((t, i) => ({ index: i, language: t.language, template: t.template, durationSec: t.durationSec, text: t.text.slice(0, 4000) }));
  const prompt = {
    instruction: 'Group these meetings into a small set of consistent projects/modules based on recurring topics, teams, or goals. Return strict JSON.',
    schema: {
      categories: [
        {
          name: 'string',
          rationale: 'string',
          items: [ { index: 0, title: 'string (optional)' } ],
          summary: 'string',
          actions: [ { owner: 'string?', task: 'string', due: 'string?', priority: 'Low|Medium|High|Critical?' } ]
        }
      ]
    },
    items
  };

  const cResp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return valid JSON only. Categorize meetings into coherent projects/modules with summaries and actions.' },
        { role: 'user', content: JSON.stringify(prompt) }
      ],
      temperature: 0.2
    })
  });
  if (!cResp.ok) {
    const txt = await cResp.text();
    // fallback: return empty structure but include error message in a pseudo category
    return { categories: [{ name: 'Uncategorized', rationale: txt.slice(0, 500), items: [], summary: '', actions: [] }] };
  }
  const json = await cResp.json();
  try {
    const parsed = JSON.parse(json.choices?.[0]?.message?.content || '{}');
    const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
    return { categories };
  } catch {
    return { categories: [] };
  }
}
