# Meeting Recorder with Real-Time Transcription

A modern, AI-powered meeting recording application with real-time transcription capabilities. Features a beautiful, accessible UI and WebSocket-based live transcription that shows text as you speak.

## 🚀 New Features

### ✨ Real-Time Transcription
- **Live Transcription**: See your words appear as you speak with WebSocket streaming
- **Confidence Indicators**: Visual feedback showing transcription accuracy
- **Multiple Languages**: Support for 10+ languages with auto-detection
- **Connection Status**: Real-time connection monitoring with auto-reconnection
- **Performance Optimized**: Memory-efficient processing for long recordings

### 🎨 Enhanced UI (2024 Design Trends)
- **Glassmorphism Effects**: Modern translucent cards with backdrop blur
- **Smooth Animations**: Fluid micro-interactions and transitions
- **Accessibility First**: Full screen reader support and keyboard navigation
- **Dark Mode**: Automatic dark theme support
- **Mobile Responsive**: Optimized for all device sizes

## 📋 Features

### Core Functionality
- 🎙️ **High-Quality Recording**: Multi-format audio recording (WebM, MP4, OGG)
- 🤖 **AI Transcription**: OpenAI Whisper-powered speech-to-text
- 📝 **Smart Summaries**: Context-aware meeting summaries by template
- 🔄 **Real-Time Display**: Live transcription with confidence scoring
- 💾 **Local Storage**: Automatic saving with browser storage
- 📤 **Easy Sharing**: WhatsApp, Email, and clipboard integration

### Meeting Templates
- **General Meeting**: Standard meeting notes and action items
- **Daily Standup**: Yesterday/Today/Blockers format
- **1:1 Meeting**: Personal discussion points and feedback
- **Interview**: Candidate evaluation and recommendations
- **Brainstorming**: Idea clustering and next steps
- **Performance Review**: Structured feedback sessions
- **Training Session**: Learning objectives and outcomes
- **Client Meeting**: Professional client interaction notes

### Language Support
- English (US)
- Cantonese/Hokkien/Chinese (Auto-detect)
- Malay (Malaysia)
- Spanish (Spain)
- French (France)
- German (Germany)
- Japanese
- Korean
- Thai
- Vietnamese

## 🛠️ Setup Instructions

### Prerequisites
- Node.js 18+ 
- OpenAI API key for transcription
- Modern browser with WebSocket support
- HTTPS connection (required for microphone access)

### Installation

1. **Clone or download the project**
   ```bash
   git clone <repository-url>
   cd meeting-app
   ```

2. **Set up OpenAI API Key**
   
   **Windows (Command Prompt):**
   ```cmd
   set OPENAI_API_KEY=your_openai_api_key_here
   ```
   
   **Windows (PowerShell):**
   ```powershell
   $Env:OPENAI_API_KEY="your_openai_api_key_here"
   ```
   
   **macOS/Linux:**
   ```bash
   export OPENAI_API_KEY="your_openai_api_key_here"
   ```

3. **Start the server**
   ```bash
   npm start
   ```
   
   Or directly:
   ```bash
   node server/server.js
   ```

4. **Open in browser**
   ```
   http://localhost:5173
   ```

### Getting an OpenAI API Key

1. Visit [OpenAI API Platform](https://platform.openai.com/)
2. Sign up or log in to your account
3. Navigate to API Keys section
4. Create a new API key
5. Copy the key and set it as an environment variable

## 🔧 Configuration

### Environment Variables
- `OPENAI_API_KEY`: Required for transcription functionality
- `PORT`: Server port (default: 5173)
- `JSON_LIMIT_BYTES`: Max request size (default: 100MB)

### Real-Time Transcription Settings
- **Chunk Duration**: 3 seconds (configurable in server)
- **Max Chunks**: 20 chunks in memory (prevents memory leaks)
- **Confidence Threshold**: 0.7 (adjustable per session)
- **Reconnection**: Auto-retry with exponential backoff

## 🌐 API Endpoints

### HTTP Endpoints
- `GET /` - Main application
- `POST /api/transcribe` - Single audio transcription
- `POST /api/summary-all` - Batch meeting summarization
- `GET /api/health` - Server health check

### WebSocket Endpoints
- `ws://localhost:5173/ws/transcribe` - Real-time transcription stream

### WebSocket Protocol
```javascript
// Connect with parameters
ws://localhost:5173/ws/transcribe?language=en&template=general

// Send configuration updates
{
  "type": "config_update",
  "language": "en",
  "template": "standup"
}

// Receive transcript updates
{
  "type": "transcript_update",
  "transcript": "Full transcript text...",
  "interimTranscript": "Current partial text...",
  "confidence": 0.85,
  "timestamp": 1699123456789
}
```

## 🎯 Usage Guide

### Basic Recording
1. **Select Language**: Choose your primary language or use auto-detect
2. **Choose Template**: Pick the meeting type for optimized summaries
3. **Enable Real-Time** (Optional): Click "Enable Real-time" for live transcription
4. **Start Recording**: Click the large RECORD button
5. **Stop Recording**: Click STOP when finished
6. **Review & Share**: Download, transcribe, or share your recording

### Real-Time Transcription
1. **Enable Feature**: Click "Enable Real-time" button
2. **Check Connection**: Green indicator shows successful connection
3. **Start Recording**: Begin speaking - text appears live
4. **Monitor Confidence**: Color-coded words show transcription accuracy
   - 🟢 Green: High confidence (80%+)
   - 🟡 Yellow: Medium confidence (60-80%)
   - 🔴 Red: Low confidence (<60%)
5. **View Statistics**: Track word count, duration, and last update

### Advanced Features
- **Batch Processing**: Summarize multiple meetings together
- **Export Options**: Download as Markdown or CSV
- **Category Organization**: Auto-group related meetings
- **Action Item Tracking**: Extract and organize tasks

## 🔒 Privacy & Security

- **Local Storage**: Recordings stored in browser, not on server
- **Secure Transmission**: HTTPS required for microphone access
- **API Security**: OpenAI API calls use secure authentication
- **No Data Persistence**: Server doesn't store audio or transcripts
- **User Control**: Complete control over data sharing and deletion

## 🐛 Troubleshooting

### Common Issues

**Microphone Access Denied**
- Ensure HTTPS connection
- Check browser permissions
- Try refreshing the page

**Real-Time Transcription Not Working**
- Verify OpenAI API key is set
- Check WebSocket connection status
- Ensure stable internet connection

**Poor Transcription Quality**
- Use a good quality microphone
- Minimize background noise
- Speak clearly and at moderate pace
- Check language selection

**Connection Errors**
- Verify server is running on correct port
- Check firewall settings
- Ensure WebSocket support in browser

### Browser Compatibility
- ✅ Chrome 60+
- ✅ Firefox 55+
- ✅ Safari 14+
- ✅ Edge 79+
- ❌ Internet Explorer (not supported)

## 📊 Performance

### Optimizations
- **Memory Management**: Automatic cleanup of old audio chunks
- **Rate Limiting**: Intelligent API request throttling
- **Connection Pooling**: Efficient WebSocket connection reuse
- **Lazy Loading**: On-demand feature activation
- **Compression**: Optimized audio data transmission

### Limits
- **Max Recording**: 2 hours per session
- **Concurrent Sessions**: 10 active WebSocket connections
- **File Size**: 100MB per audio file
- **Transcript Length**: 50KB per session (auto-truncated)

## 🤝 Contributing

We welcome contributions! Please see our contributing guidelines for:
- Code style and standards
- Testing requirements
- Pull request process
- Issue reporting

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:
- Check the troubleshooting section above
- Review browser console for error messages
- Ensure all prerequisites are met
- Verify OpenAI API key is valid and has credits

## 🔮 Roadmap

### Upcoming Features
- **Speaker Identification**: Multi-speaker recognition
- **Live Collaboration**: Real-time shared transcription
- **Advanced Analytics**: Meeting insights and trends
- **Integration APIs**: Slack, Teams, Zoom integration
- **Custom Models**: Fine-tuned transcription models
- **Offline Mode**: Local transcription capabilities

---

**Built with ❤️ using modern web technologies and AI**