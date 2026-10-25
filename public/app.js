// Gemini 实时双语同传客户端业务逻辑 (生产正式版)

const DEFAULT_BACKEND_WS = 'wss://live-translator-backend.chinanetysj.workers.dev';

const state = {
  isStreaming: false,
  ws: null,
  audioContext: null,
  mediaStream: null,
  processorNode: null,
  analyserNode: null,
  animFrameId: null,
  playbackContext: null,
  nextPlaybackTime: 0,
  lastAudioSentTime: 0,
  firstTokenReceived: false,
  currentOriginalText: '',
  currentTranslationText: '',
  allSubtitles: []
};

// DOM 元素引用
const elements = {
  translationDirection: document.getElementById('translationDirection'),
  voiceSelect: document.getElementById('voiceSelect'),
  customServerInput: document.getElementById('customServerInput'),
  toggleStreamBtn: document.getElementById('toggleStreamBtn'),
  btnText: document.getElementById('btnText'),
  enableAudioPlayback: document.getElementById('enableAudioPlayback'),
  statusBadge: document.getElementById('statusBadge'),
  statusText: document.getElementById('statusText'),
  latencyValue: document.getElementById('latencyValue'),
  audioVisualizer: document.getElementById('audioVisualizer'),
  subtitlesViewport: document.getElementById('subtitlesViewport'),
  subtitlesList: document.getElementById('subtitlesList'),
  welcomeHint: document.getElementById('welcomeHint'),
  currentTurnCard: document.getElementById('currentTurnCard'),
  currentCardTag: document.getElementById('currentCardTag'),
  currentOriginalText: document.getElementById('currentOriginalText'),
  currentTranslationText: document.getElementById('currentTranslationText'),
  clearBtn: document.getElementById('clearBtn'),
  copyBtn: document.getElementById('copyBtn')
};

// 1. 初始化配置与本地存储
function initConfig() {
  // 记住用户选择的音色
  const savedVoice = localStorage.getItem('gemini_live_voice');
  if (savedVoice && elements.voiceSelect) {
    elements.voiceSelect.value = savedVoice;
  }
  if (elements.voiceSelect) {
    elements.voiceSelect.addEventListener('change', () => {
      localStorage.setItem('gemini_live_voice', elements.voiceSelect.value);
    });
  }

  // 记住用户选择的翻译方向
  const savedDirection = localStorage.getItem('gemini_live_direction');
  if (savedDirection && elements.translationDirection) {
    elements.translationDirection.value = savedDirection;
  }
  if (elements.translationDirection) {
    elements.translationDirection.addEventListener('change', () => {
      localStorage.setItem('gemini_live_direction', elements.translationDirection.value);
    });
  }

  // 记住语音播放开关
  const savedAudioPlayback = localStorage.getItem('gemini_live_audio_playback');
  if (savedAudioPlayback !== null && elements.enableAudioPlayback) {
    elements.enableAudioPlayback.checked = savedAudioPlayback === 'true';
  }
  if (elements.enableAudioPlayback) {
    elements.enableAudioPlayback.addEventListener('change', () => {
      localStorage.setItem('gemini_live_audio_playback', elements.enableAudioPlayback.checked);
    });
  }

  // 记住自定义中继地址（若有）
  const savedServer = localStorage.getItem('gemini_live_server');
  if (savedServer && elements.customServerInput) {
    elements.customServerInput.value = savedServer;
  }
  if (elements.customServerInput) {
    elements.customServerInput.addEventListener('input', () => {
      localStorage.setItem('gemini_live_server', elements.customServerInput.value.trim());
    });
  }

  elements.toggleStreamBtn.addEventListener('click', toggleStreaming);
  elements.clearBtn.addEventListener('click', clearSubtitles);
  elements.copyBtn.addEventListener('click', copyAllSubtitles);
}

// 2. 状态更新
function updateStatus(status, text) {
  elements.statusBadge.className = `status-indicator ${status}`;
  elements.statusText.textContent = text;
}

// 3. 构建 System Prompt 指令
function getSystemPrompt(direction) {
  switch (direction) {
    case 'en_to_zh':
      return "You are an ultra-low-latency professional simultaneous interpreter. When you hear English speech, translate it immediately into clear, natural Chinese. Speak the translation. Output both translation text and speech.";
    case 'zh_to_en':
      return "You are an ultra-low-latency professional simultaneous interpreter. When you hear Chinese speech, translate it immediately into fluent English. Speak the translation. Output both translation text and speech.";
    case 'bidirectional':
    default:
      return "You are an ultra-low-latency professional simultaneous interpreter. When you hear English, immediately translate to Chinese. When you hear Chinese, immediately translate to English. Speak the translation. Output translation text and speech.";
  }
}

// 4. 切换同传开关
async function toggleStreaming() {
  if (state.isStreaming) {
    stopStreaming();
  } else {
    await startStreaming();
  }
}

// 5. 启动流式同传
async function startStreaming() {
  try {
    updateStatus('connecting', '连接中...');
    elements.btnText.textContent = '正在启动...';
    elements.toggleStreamBtn.disabled = true;

    // 1. 初始化输入音频捕获（兼容移动端 iOS / Android 的 Web Audio 触摸解锁）
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextClass({
      sampleRate: 16000
    });

    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }

    // 预热音频播放上下文（iOS 移动端必须在手势触摸回调中提前解锁音频输出）
    if (!state.playbackContext) {
      state.playbackContext = new AudioContextClass({
        sampleRate: 24000
      });
      state.nextPlaybackTime = state.playbackContext.currentTime;
    }
    if (state.playbackContext.state === 'suspended') {
      await state.playbackContext.resume();
    }

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 2. 建立 Cloudflare 边缘 WebSocket 安全连接（自动由 Worker 托管注入密钥）
    const wsUrl = (elements.customServerInput?.value.trim()) || DEFAULT_BACKEND_WS;
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('Cloudflare Live Gateway 连接已建立，发送配置...');
      const voice = elements.voiceSelect?.value || 'Aoede';
      const setupMessage = {
        setup: {
          model: "models/gemini-3.8-live",
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice
                }
              }
            }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [
              {
                text: getSystemPrompt(elements.translationDirection.value)
              }
            ]
          }
        }
      };
      state.ws.send(JSON.stringify(setupMessage));
    };

    state.ws.onmessage = async (event) => {
      let data;
      if (event.data instanceof Blob) {
        data = JSON.parse(await event.data.text());
      } else {
        data = JSON.parse(event.data);
      }
      handleServerMessage(data);
    };

    state.ws.onerror = (err) => {
      console.error('WebSocket 错误:', err);
      updateStatus('error', '连接异常');
    };

    state.ws.onclose = (event) => {
      console.log('WebSocket 连接关闭:', event);
      if (state.isStreaming) {
        stopStreaming();
      }
      if (event.code !== 1000) {
        updateStatus('error', `已断开 [${event.code}]`);
      } else {
        updateStatus('', '已断开');
      }
    };

    // 3. 设置音频流水线与可视化
    setupAudioPipeline();

    state.isStreaming = true;
    elements.btnText.textContent = '停止同传';
    elements.toggleStreamBtn.classList.add('recording');
    elements.toggleStreamBtn.disabled = false;
    updateStatus('connected', '实时同传中');

    if (elements.welcomeHint) {
      elements.welcomeHint.style.display = 'none';
    }

  } catch (error) {
    console.error('启动实时同传失败:', error);
    alert('启动失败: ' + (error.message || error));
    stopStreaming();
  }
}

// 6. 音频输入管道（16000Hz 16-bit PCM）
function setupAudioPipeline() {
  const source = state.audioContext.createMediaStreamSource(state.mediaStream);

  // 设置 Analyser 用于波形可视化
  state.analyserNode = state.audioContext.createAnalyser();
  state.analyserNode.fftSize = 64;
  source.connect(state.analyserNode);
  startVisualizer();

  // 音频处理节点（每次抓取 2048 样本，约 128ms）
  const bufferSize = 2048;
  const scriptNode = state.audioContext.createScriptProcessor(bufferSize, 1, 1);
  source.connect(scriptNode);
  scriptNode.connect(state.audioContext.destination);

  scriptNode.onaudioprocess = (e) => {
    if (!state.isStreaming || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const inputData = e.inputBuffer.getChannelData(0);
    
    // 检查是否有有效音量
    let sum = 0;
    for (let i = 0; i < inputData.length; i++) {
      sum += Math.abs(inputData[i]);
    }
    const rms = Math.sqrt(sum / inputData.length);
    
    // 转换为 16 位小端 PCM
    const pcmBuffer = floatTo16BitPCM(inputData);
    const base64Data = arrayBufferToBase64(pcmBuffer);

    if (rms > 0.01 && !state.firstTokenReceived) {
      state.lastAudioSentTime = performance.now();
    }

    // 官方规范的 realtimeInput.audio 格式
    const message = {
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: base64Data
        }
      }
    };

    state.ws.send(JSON.stringify(message));
  };

  state.processorNode = scriptNode;
}

// 7. 处理服务端下发的事件
function handleServerMessage(data) {
  if (data.setupComplete) {
    console.log('Gemini 3.8 Live 引擎已就绪');
    return;
  }

  // 语音活动检测 (VAD) 事件
  if (data.voiceActivity) {
    if (data.voiceActivity.type === 'ACTIVITY_START') {
      elements.currentCardTag.textContent = '🎙️ 正在聆听发言...';
      elements.currentTurnCard.classList.remove('hidden');
    } else if (data.voiceActivity.type === 'ACTIVITY_END') {
      elements.currentCardTag.textContent = '⚡ 正在实时同传输出...';
    }
  }

  // 接收模型识别的用户原文 (Input Transcription)
  if (data.serverContent?.inputTranscription?.text) {
    state.currentOriginalText += data.serverContent.inputTranscription.text;
    elements.currentOriginalText.textContent = state.currentOriginalText;
    elements.currentTurnCard.classList.remove('hidden');
    scrollToTop();
  }

  // 接收模型翻译的目标语言流 (Output Transcription)
  if (data.serverContent?.outputTranscription?.text) {
    const textChunk = data.serverContent.outputTranscription.text;
    if (!state.firstTokenReceived && state.lastAudioSentTime > 0) {
      const latency = Math.round(performance.now() - state.lastAudioSentTime);
      if (latency > 0 && latency < 5000) {
        elements.latencyValue.textContent = `${latency} ms`;
      }
      state.firstTokenReceived = true;
    }

    state.currentTranslationText += textChunk;
    elements.currentTranslationText.textContent = state.currentTranslationText;
    elements.currentTurnCard.classList.remove('hidden');
    scrollToTop();
  }

  // 处理返回的语音音频流 (24000Hz PCM)
  if (data.serverContent?.modelTurn?.parts) {
    for (const part of data.serverContent.modelTurn.parts) {
      if (part.text && !state.currentTranslationText) {
        state.currentTranslationText += part.text;
        elements.currentTranslationText.textContent = state.currentTranslationText;
      }
      if (part.inlineData?.data && elements.enableAudioPlayback.checked) {
        playPcmChunk(part.inlineData.data);
      }
    }
  }

  // 句子结束或说话打断 -> 归档保存
  if (data.serverContent?.turnComplete || data.serverContent?.interrupted) {
    finalizeCurrentTurn();
    state.firstTokenReceived = false;
  }
}

// 8. 播放 24000Hz PCM 音频流
function playPcmChunk(base64Audio) {
  try {
    if (!state.playbackContext) {
      state.playbackContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 24000
      });
      state.nextPlaybackTime = state.playbackContext.currentTime;
    }

    const binaryString = window.atob(base64Audio);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const numSamples = len / 2;
    const float32 = new Float32Array(numSamples);
    const dataView = new DataView(bytes.buffer);

    for (let i = 0; i < numSamples; i++) {
      const int16 = dataView.getInt16(i * 2, true);
      float32[i] = int16 < 0 ? int16 / 32768 : int16 / 32767;
    }

    const audioBuffer = state.playbackContext.createBuffer(1, numSamples, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = state.playbackContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(state.playbackContext.destination);

    const startTime = Math.max(state.nextPlaybackTime, state.playbackContext.currentTime);
    source.start(startTime);
    state.nextPlaybackTime = startTime + audioBuffer.duration;

  } catch (err) {
    console.error('音频播放出错:', err);
  }
}

// 9. 句子定稿（锁定为双语历史卡片）
function finalizeCurrentTurn() {
  const orig = state.currentOriginalText.trim();
  const trans = state.currentTranslationText.trim();

  if (orig || trans) {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    
    const card = document.createElement('div');
    card.className = 'subtitle-item';

    const header = document.createElement('div');
    header.className = 'item-header';
    header.innerHTML = `<span>${timeStr}</span><span>已同传</span>`;
    card.appendChild(header);

    if (orig) {
      const origEl = document.createElement('div');
      origEl.className = 'item-original';
      origEl.textContent = `🗣️ ${orig}`;
      card.appendChild(origEl);
    }

    if (trans) {
      const transEl = document.createElement('div');
      transEl.className = 'item-translation';
      transEl.textContent = `🌐 ${trans}`;
      card.appendChild(transEl);
    }

    const hint = document.getElementById('welcomeHint');
    if (hint) {
      hint.remove();
    }

    // 倒序插入：最新完成的句子插入在最上方
    elements.subtitlesList.prepend(card);
    state.allSubtitles.unshift(`[${timeStr}] 原文: ${orig} | 译文: ${trans}`);
  }

  // 重置临时流式卡片
  state.currentOriginalText = '';
  state.currentTranslationText = '';
  elements.currentOriginalText.textContent = '等待说话...';
  elements.currentTranslationText.textContent = '';
  elements.currentCardTag.textContent = '⚡ 正在聆听与同传中...';
  elements.currentTurnCard.classList.add('hidden');
  scrollToTop();
}

// 10. 停止同传
function stopStreaming() {
  state.isStreaming = false;

  if (state.processorNode) {
    state.processorNode.disconnect();
    state.processorNode = null;
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(track => track.stop());
    state.mediaStream = null;
  }

  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }

  if (state.playbackContext) {
    state.playbackContext.close();
    state.playbackContext = null;
  }

  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }

  // 清空波形绘制
  const canvas = elements.audioVisualizer;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  finalizeCurrentTurn();

  elements.btnText.textContent = '开始实时同传';
  elements.toggleStreamBtn.classList.remove('recording');
  elements.toggleStreamBtn.disabled = false;
  updateStatus('', '已就绪');
}

// 11. 实用工具函数
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function scrollToTop() {
  elements.subtitlesViewport.scrollTop = 0;
}

function clearSubtitles() {
  elements.subtitlesList.innerHTML = `
    <div class="welcome-hint" id="welcomeHint">
      <p>🎙️ 点击上方 <strong>“开始实时同传”</strong> 开启麦克风，发言将实时以双语字幕呈现在此处。</p>
    </div>
  `;
  state.allSubtitles = [];
  state.currentOriginalText = '';
  state.currentTranslationText = '';
  elements.currentOriginalText.textContent = '等待说话...';
  elements.currentTranslationText.textContent = '';
  elements.currentTurnCard.classList.add('hidden');
}

function copyAllSubtitles() {
  if (state.allSubtitles.length === 0) {
    alert('暂无字幕内容');
    return;
  }
  const content = state.allSubtitles.join('\n');
  navigator.clipboard.writeText(content).then(() => {
    elements.copyBtn.textContent = '已复制！';
    setTimeout(() => {
      elements.copyBtn.textContent = '复制全部';
    }, 1500);
  });
}

// 麦克风波形动态可视化
function startVisualizer() {
  const canvas = elements.audioVisualizer;
  const ctx = canvas.getContext('2d');
  const bufferLength = state.analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    state.animFrameId = requestAnimationFrame(draw);
    state.analyserNode.getByteTimeDomainData(dataArray);

    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#38bdf8';
    ctx.beginPath();

    const sliceWidth = canvas.width * 1.0 / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * canvas.height / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  draw();
}

// 页面加载运行
document.addEventListener('DOMContentLoaded', initConfig);
