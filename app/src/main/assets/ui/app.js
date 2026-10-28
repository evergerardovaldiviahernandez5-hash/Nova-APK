(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const DEFAULT_SETTINGS = Object.freeze({
    context: 2048,
    threads: 2,
    batch: 64,
    temperature: 0.7,
    systemPrompt: 'Eres Nova, un asistente útil, preciso y claro. Responde en el idioma del usuario y reconoce cuando no tienes información suficiente.',
    rpcEnabled: false,
    rpcEndpoints: [],
    reduceMotion: false
  });
  const MAX_ATTACHMENTS = 4;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_DOCUMENT_BYTES = 512 * 1024;
  const MAX_DOCUMENT_CHARS = 180000;
  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'log', 'yaml', 'yml', 'py', 'js', 'ts', 'java', 'kt', 'cpp', 'c', 'h', 'css', 'html']);

  const state = {
    conversations: [],
    current: null,
    settings: { ...DEFAULT_SETTINGS },
    bootstrap: { ready: false, platform: 'browser', modelName: 'Sin modelo cargado', mmprojReady: false },
    serverOnline: false,
    generating: false,
    abortController: null,
    draftAttachments: [],
    forwardMessageId: null,
    confirmAction: null,
    streamRenderTimer: null,
    healthTimer: null,
    lastMetrics: { tokens: 0, elapsed: 0 }
  };

  class NativeAdapter {
    constructor() {
      this.android = typeof window.NovaBridge !== 'undefined';
      this.python = null;
      this.platform = this.android ? 'android' : 'browser';
      if (!this.android) {
        window.addEventListener('pywebviewready', () => {
          this.python = window.pywebview?.api || null;
          if (this.python) this.platform = 'windows';
        }, { once: true });
      }
    }

    async invoke(method, ...args) {
      if (this.android) {
        const result = window.NovaBridge[method](...args);
        return this.parse(result);
      }
      if (this.python) {
        const names = {
          getBootstrap: 'get_bootstrap', selectModel: 'select_model', selectProjector: 'select_projector',
          applySettings: 'apply_settings', exportText: 'export_text', shareText: 'share_text', getLogs: 'get_logs', openExternal: 'open_external'
        };
        const result = await this.python[names[method]](...args);
        return this.parse(result);
      }
      return this.browserFallback(method, args);
    }

    parse(value) {
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    }

    async browserFallback(method, args) {
      if (method === 'getBootstrap') {
        try {
          const response = await fetch('/nova/status', { cache: 'no-store' });
          if (response.ok) return { ...(await response.json()), platform: 'browser' };
        } catch { /* La vista estática sigue disponible para diagnóstico. */ }
        return { ready: false, platform: 'browser', modelName: 'Vista de interfaz', mmprojReady: false, settings: {} };
      }
      if (method === 'exportText') {
        const [filename, content] = args;
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return { accepted: true };
      }
      if (method === 'openExternal') {
        const url = new URL(args[0]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enlace no permitido.');
        window.open(url.href, '_blank', 'noopener,noreferrer');
        return { accepted: true };
      }
      if (method === 'shareText') {
        if (navigator.share) return navigator.share({ title: 'Nova', text: args[0] });
        await copyText(args[0]);
        return { accepted: true, copied: true };
      }
      if (method === 'getLogs') return 'El diagnóstico nativo está disponible en las aplicaciones Android y Windows.';
      throw new Error('Esta acción requiere la aplicación Nova para Android o Windows.');
    }

    getBootstrap() { return this.invoke('getBootstrap'); }
    selectModel() { return this.invoke('selectModel'); }
    selectProjector() { return this.invoke('selectProjector'); }
    applySettings(settings) { return this.invoke('applySettings', this.android ? JSON.stringify(settings) : settings); }
    exportText(filename, content) { return this.invoke('exportText', filename, content); }
    shareText(text) { return this.invoke('shareText', text); }
    getLogs() { return this.invoke('getLogs'); }
    openExternal(url) { return this.invoke('openExternal', url); }
  }

  const native = new NativeAdapter();

  function createConversation() {
    const now = Date.now();
    return { id: window.novaId(), title: 'Nueva conversación', createdAt: now, updatedAt: now, messages: [] };
  }

  function formatTime(timestamp) {
    return new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
  }

  function formatListDate(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return formatTime(timestamp);
    return new Intl.DateTimeFormat('es', { day: '2-digit', month: 'short' }).format(date).replace('.', '').toUpperCase();
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${name}`);
    svg.appendChild(use);
    return svg;
  }

  function toast(message, error = false) {
    const region = $('toastRegion');
    while (region.children.length >= 3) region.firstElementChild.remove();
    const element = document.createElement('div');
    element.className = `toast${error ? ' is-error' : ''}`;
    element.append(icon(error ? 'i-warning' : 'i-check'), document.createElement('span'));
    element.lastElementChild.textContent = message;
    region.appendChild(element);
    setTimeout(() => element.remove(), error ? 6000 : 3600);
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return; } catch { /* Usa el método compatible. */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('No se pudo acceder al portapapeles.');
  }

  function showDialog(id) {
    const dialog = $(id);
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
  }

  function closeDialog(id) {
    const dialog = $(id);
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function configureMarkdown() {
    if (!window.marked || !window.DOMPurify) return;
    window.marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
  }

  function renderMarkdown(target, text) {
    if (!window.marked || !window.DOMPurify) {
      target.textContent = text;
      return;
    }
    const html = window.marked.parse(text || '');
    target.innerHTML = window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'srcset']
    });
    target.querySelectorAll('a').forEach(link => {
      link.rel = 'noopener noreferrer nofollow';
    });
  }

  function renderConversationList() {
    const list = $('conversationList');
    const query = $('searchInput').value.trim().toLocaleLowerCase('es');
    list.replaceChildren();
    const filtered = state.conversations.filter(conversation => {
      if (!query) return true;
      if (conversation.title.toLocaleLowerCase('es').includes(query)) return true;
      return conversation.messages.some(message => message.content.toLocaleLowerCase('es').includes(query));
    });
    $('conversationCount').textContent = String(state.conversations.length).padStart(2, '0');
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'conversation-empty';
      empty.textContent = query ? 'No hay coincidencias en el archivo.' : 'Aún no hay conversaciones guardadas.';
      list.appendChild(empty);
      return;
    }
    for (const conversation of filtered) {
      const item = document.createElement('div');
      item.className = `conversation-item${state.current?.id === conversation.id ? ' is-active' : ''}`;
      const open = document.createElement('button');
      open.className = 'conversation-open';
      open.dataset.conversationId = conversation.id;
      const name = document.createElement('span');
      name.className = 'conversation-name';
      name.textContent = conversation.title;
      const date = document.createElement('span');
      date.className = 'conversation-date';
      date.textContent = formatListDate(conversation.updatedAt);
      open.append(name, date);
      const remove = document.createElement('button');
      remove.className = 'conversation-delete';
      remove.dataset.deleteConversation = conversation.id;
      remove.setAttribute('aria-label', `Eliminar ${conversation.title}`);
      remove.title = 'Eliminar conversación';
      remove.appendChild(icon('i-trash'));
      item.append(open, remove);
      list.appendChild(item);
    }
  }

  function renderCurrent({ scroll = false } = {}) {
    const conversation = state.current;
    $('conversationTitle').textContent = conversation?.title || 'Nueva conversación';
    const messages = $('messages');
    messages.replaceChildren();
    const hasMessages = Boolean(conversation?.messages.length);
    $('welcome').hidden = hasMessages;
    window.NovaMatrix.setActive(!hasMessages);
    if (hasMessages) {
      for (const message of conversation.messages) messages.appendChild(buildMessageElement(message));
    }
    renderConversationList();
    if (scroll) requestAnimationFrame(() => scrollToBottom(false));
  }

  function buildMessageElement(message) {
    const article = document.createElement('article');
    article.className = `message ${message.role}${message.error ? ' is-error' : ''}`;
    article.dataset.messageId = message.id;
    const header = document.createElement('header');
    header.className = 'message-header';
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.appendChild(icon(message.role === 'assistant' ? 'nova-symbol' : 'i-terminal'));
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = message.role === 'assistant' ? 'NOVA' : 'TÚ';
    const time = document.createElement('time');
    time.className = 'message-time';
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = formatTime(message.createdAt);
    header.append(avatar, author, time);

    const content = document.createElement('div');
    if (message.attachments?.length) {
      const attachments = document.createElement('div');
      attachments.className = 'message-attachments';
      for (const attachment of message.attachments) {
        if (attachment.kind === 'image' && attachment.dataUrl) {
          const image = document.createElement('img');
          image.className = 'message-image';
          image.src = attachment.dataUrl;
          image.alt = attachment.name;
          image.loading = 'lazy';
          image.dataset.fullImage = attachment.dataUrl;
          attachments.appendChild(image);
        } else {
          const chip = document.createElement('span');
          chip.className = 'message-attachment';
          chip.appendChild(icon('i-file'));
          const label = document.createElement('span');
          label.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
          chip.appendChild(label);
          attachments.appendChild(chip);
        }
      }
      content.appendChild(attachments);
    }
    const body = document.createElement('div');
    body.className = 'message-body';
    if (message.role === 'assistant') renderMarkdown(body, message.content);
    else body.textContent = message.content;
    if (message.pending && !message.content) {
      body.replaceChildren();
      const thinking = document.createElement('span');
      thinking.className = 'thinking';
      thinking.setAttribute('aria-label', 'Nova está pensando');
      thinking.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      body.appendChild(thinking);
    }
    content.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (!message.pending && message.content) {
      actions.append(
        messageAction('copy', 'i-copy', 'Copiar', 'Copiar mensaje'),
        messageAction('forward', 'i-forward', 'Reenviar', 'Reenviar mensaje')
      );
      if (message.role === 'assistant' && isLastAssistant(message.id) && !state.generating) {
        actions.appendChild(messageAction('regenerate', 'i-refresh', 'Regenerar', 'Regenerar respuesta'));
      }
      actions.appendChild(messageAction('delete-message', 'i-trash', '', 'Eliminar mensaje'));
    }
    article.append(header, content, actions);
    return article;
  }

  function messageAction(action, iconName, label, ariaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.setAttribute('aria-label', ariaLabel);
    button.title = ariaLabel;
    button.appendChild(icon(iconName));
    if (label) button.appendChild(document.createTextNode(label));
    return button;
  }

  function isLastAssistant(messageId) {
    const messages = state.current?.messages || [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant' && !messages[index].error) return messages[index].id === messageId;
    }
    return false;
  }

  async function saveCurrent() {
    if (!state.current) return;
    state.current.updatedAt = Date.now();
    await window.NovaStore.saveConversation(state.current);
    const index = state.conversations.findIndex(item => item.id === state.current.id);
    if (index >= 0) state.conversations[index] = state.current;
    state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    renderConversationList();
  }

  async function selectConversation(id) {
    if (state.generating) {
      toast('Detén la generación antes de cambiar de conversación.', true);
      return;
    }
    const conversation = await window.NovaStore.getConversation(id);
    if (!conversation) return;
    state.current = conversation;
    renderCurrent({ scroll: true });
    closeDrawers();
  }

  async function newConversation() {
    if (state.generating) stopGeneration();
    const conversation = createConversation();
    state.conversations.unshift(conversation);
    state.current = conversation;
    await window.NovaStore.saveConversation(conversation);
    renderCurrent();
    closeDrawers();
    $('promptInput').focus();
  }

  function scrollToBottom(smooth = true) {
    const scroller = $('messageScroll');
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function setGenerating(generating) {
    state.generating = generating;
    $('sendBtn').hidden = generating;
    $('stopBtn').hidden = !generating;
    $('promptInput').readOnly = generating;
    updateConnectionUI();
  }

  function buildApiMessages() {
    const apiMessages = [];
    if (state.settings.systemPrompt.trim()) apiMessages.push({ role: 'system', content: state.settings.systemPrompt.trim() });
    const candidates = state.current.messages.filter(message => !message.error && !message.pending && (message.content || message.attachments?.length));
    const selected = [];
    let budget = Math.max(1800, state.settings.context * 3);
    for (let index = candidates.length - 1; index >= 0 && selected.length < 24; index -= 1) {
      const message = candidates[index];
      const cost = (message.content?.length || 0) + (message.contextText?.length || 0) + 40;
      if (selected.length && cost > budget) break;
      selected.unshift(message);
      budget -= cost;
      if (budget <= 0) break;
    }
    for (const message of selected) {
      if (message.role === 'user') {
        let text = message.content || 'Analiza los archivos adjuntos.';
        if (message.contextText) text += `\n\n${message.contextText}`;
        const images = (message.attachments || []).filter(item => item.kind === 'image' && item.dataUrl);
        if (images.length && state.bootstrap.mmprojReady) {
          const content = [{ type: 'text', text }];
          for (const image of images) content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
          apiMessages.push({ role: 'user', content });
        } else {
          apiMessages.push({ role: 'user', content: text });
        }
      } else {
        apiMessages.push({ role: 'assistant', content: message.content });
      }
    }
    return apiMessages;
  }

  async function sendCurrentMessage() {
    if (state.generating) return;
    const input = $('promptInput');
    const text = input.value.trim();
    if (!text && !state.draftAttachments.length) return;
    if (!state.serverOnline && native.platform !== 'browser') {
      toast('El núcleo no está listo. Revisa el modelo y el diagnóstico.', true);
      openSettings();
      return;
    }
    const hasImages = state.draftAttachments.some(item => item.kind === 'image');
    if (hasImages && !state.bootstrap.mmprojReady) {
      toast('Para interpretar imágenes debes configurar un proyector mmproj compatible.', true);
      openSettings();
      return;
    }

    const attachments = state.draftAttachments;
    const documents = attachments.filter(item => item.kind === 'document');
    const contextText = documents.map(item => `<archivo nombre="${item.name.replace(/["<>]/g, '')}">\n${item.text}\n</archivo>`).join('\n\n');
    const message = {
      id: window.novaId(), role: 'user', content: text || 'Archivos adjuntos para analizar.', createdAt: Date.now(), attachments, contextText
    };
    state.current.messages.push(message);
    if (state.current.title === 'Nueva conversación') {
      const source = text || attachments[0]?.name || 'Conversación local';
      state.current.title = source.length > 52 ? `${source.slice(0, 52)}…` : source;
    }
    input.value = '';
    input.style.height = 'auto';
    state.draftAttachments = [];
    renderAttachmentPreview();
    updatePromptCounter();
    await saveCurrent();
    renderCurrent({ scroll: true });
    await generateAssistantReply();
  }

  async function generateAssistantReply() {
    if (state.generating) return;
    const assistant = { id: window.novaId(), role: 'assistant', content: '', createdAt: Date.now(), pending: true };
    state.current.messages.push(assistant);
    renderCurrent({ scroll: true });
    setGenerating(true);
    const controller = new AbortController();
    state.abortController = controller;
    const startedAt = performance.now();
    let receivedTokens = 0;
    let lastPaint = 0;

    const paint = (force = false) => {
      const now = performance.now();
      if (!force && now - lastPaint < 85) return;
      lastPaint = now;
      const article = $('messages').querySelector(`[data-message-id="${assistant.id}"]`);
      const body = article?.querySelector('.message-body');
      if (body) renderMarkdown(body, assistant.content);
      if (assistant.content) article?.querySelector('.message-actions')?.replaceChildren();
      if (isNearBottom()) scrollToBottom(false);
    };

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: 'nova-local', messages: buildApiMessages(), stream: true,
          temperature: Number(state.settings.temperature), top_p: 0.9,
          max_tokens: Math.min(1024, Math.max(128, Math.floor(state.settings.context / 2)))
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail.slice(0, 500) || `El núcleo respondió HTTP ${response.status}.`);
      }
      if (!response.body) {
        const data = await response.json();
        assistant.content = data.choices?.[0]?.message?.content || '';
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !streamDone });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') { done = true; break; }
            if (!payload) continue;
            try {
              const event = JSON.parse(payload);
              if (event.error) throw new Error(event.error.message || String(event.error));
              const delta = event.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta) {
                assistant.content += delta;
                receivedTokens += 1;
                paint();
              }
            } catch (error) {
              if (error instanceof SyntaxError) continue;
              throw error;
            }
          }
          if (streamDone) break;
        }
        reader.releaseLock();
      }
      if (!assistant.content.trim() && !controller.signal.aborted) throw new Error('El modelo devolvió una respuesta vacía.');
    } catch (error) {
      if (error.name === 'AbortError') {
        if (!assistant.content) assistant.content = '*Generación detenida por el usuario.*';
        toast('Generación detenida.');
      } else {
        assistant.error = true;
        assistant.content = `No se pudo completar la respuesta.\n\n${friendlyError(error)}`;
        toast('Error de inferencia. Revisa el diagnóstico del núcleo.', true);
      }
    } finally {
      assistant.pending = false;
      paint(true);
      const elapsed = (performance.now() - startedAt) / 1000;
      state.lastMetrics = { tokens: receivedTokens, elapsed };
      $('tokensPerSecond').textContent = receivedTokens && elapsed > 0 ? `${(receivedTokens / elapsed).toFixed(1)} t/s` : '— t/s';
      state.abortController = null;
      setGenerating(false);
      await saveCurrent();
      renderCurrent();
      $('promptInput').focus();
    }
  }

  function friendlyError(error) {
    const message = String(error?.message || error);
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Se perdió la conexión con el núcleo local. Es posible que el modelo se haya quedado sin memoria.';
    return message;
  }

  function stopGeneration() {
    state.abortController?.abort();
  }

  function isNearBottom() {
    const scroller = $('messageScroll');
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180;
  }

  function renderAttachmentPreview() {
    const preview = $('attachmentPreview');
    preview.replaceChildren();
    state.draftAttachments.forEach(attachment => {
      const item = document.createElement('div');
      item.className = 'pending-attachment';
      if (attachment.kind === 'image') {
        const image = document.createElement('img');
        image.src = attachment.dataUrl;
        image.alt = '';
        item.appendChild(image);
      } else item.appendChild(icon('i-file'));
      const label = document.createElement('span');
      label.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.removeAttachment = attachment.id;
      remove.setAttribute('aria-label', `Quitar ${attachment.name}`);
      remove.appendChild(icon('i-close'));
      item.append(label, remove);
      preview.appendChild(item);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    for (const file of files) {
      if (state.draftAttachments.length >= MAX_ATTACHMENTS) {
        toast(`Puedes adjuntar un máximo de ${MAX_ATTACHMENTS} archivos por mensaje.`, true);
        break;
      }
      try {
        const isImage = file.type.startsWith('image/');
        const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
        if (!isImage && !TEXT_EXTENSIONS.has(extension)) throw new Error('Formato no admitido. Usa una imagen o un archivo de texto/código.');
        if (isImage && file.size > MAX_IMAGE_BYTES) throw new Error('La imagen supera el límite de 12 MB.');
        if (!isImage && file.size > MAX_DOCUMENT_BYTES) throw new Error('El documento supera el límite de 512 KB.');
        const attachment = isImage ? await processImage(file) : await processDocument(file);
        state.draftAttachments.push(attachment);
      } catch (error) {
        toast(`${file.name}: ${error.message}`, true);
      }
    }
    $('fileInput').value = '';
    renderAttachmentPreview();
  }

  async function processDocument(file) {
    let text = await file.text();
    if (text.includes('\0')) throw new Error('El archivo parece binario, no texto.');
    if (text.length > MAX_DOCUMENT_CHARS) text = `${text.slice(0, MAX_DOCUMENT_CHARS)}\n\n[Contenido recortado para proteger la memoria]`;
    return { id: window.novaId(), kind: 'document', name: file.name, type: file.type || 'text/plain', size: file.size, text };
  }

  async function processImage(file) {
    const dataUrl = await readAsDataURL(file);
    const image = await loadImage(dataUrl);
    const maxSide = 1400;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#050a08';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const optimized = canvas.toDataURL('image/jpeg', 0.82);
    canvas.width = 1;
    canvas.height = 1;
    return { id: window.novaId(), kind: 'image', name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg', size: Math.round(optimized.length * 0.75), dataUrl: optimized };
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('El formato de imagen no se puede procesar.'));
      image.src = url;
    });
  }

  function updatePromptCounter() {
    $('promptCounter').textContent = `${$('promptInput').value.length} / 32k`;
  }

  function openForward(messageId) {
    state.forwardMessageId = messageId;
    const select = $('forwardTarget');
    select.replaceChildren();
    const newOption = document.createElement('option');
    newOption.value = '__new__';
    newOption.textContent = 'Nueva conversación';
    select.appendChild(newOption);
    for (const conversation of state.conversations.filter(item => item.id !== state.current.id)) {
      const option = document.createElement('option');
      option.value = conversation.id;
      option.textContent = conversation.title;
      select.appendChild(option);
    }
    showDialog('forwardDialog');
  }

  async function forwardMessage(event) {
    event.preventDefault();
    const source = state.current.messages.find(item => item.id === state.forwardMessageId);
    if (!source) { closeDialog('forwardDialog'); return; }
    let target;
    if ($('forwardTarget').value === '__new__') {
      target = createConversation();
      target.title = 'Mensaje reenviado';
      state.conversations.unshift(target);
    } else {
      target = state.conversations.find(item => item.id === $('forwardTarget').value);
    }
    if (!target) return;
    const copy = { ...source, id: window.novaId(), createdAt: Date.now(), pending: false, forwarded: true };
    target.messages.push(copy);
    target.updatedAt = Date.now();
    await window.NovaStore.saveConversation(target);
    closeDialog('forwardDialog');
    state.current = target;
    renderCurrent({ scroll: true });
    toast('Mensaje reenviado sin enviarlo al modelo.');
  }

  function confirmAction(title, message, action) {
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    state.confirmAction = action;
    showDialog('confirmDialog');
  }

  async function deleteConversation(id) {
    if (state.generating && id === state.current.id) stopGeneration();
    await window.NovaStore.deleteConversation(id);
    state.conversations = state.conversations.filter(item => item.id !== id);
    if (state.current.id === id) {
      state.current = state.conversations[0] || createConversation();
      if (!state.conversations.length) state.conversations = [state.current];
      await window.NovaStore.saveConversation(state.current);
    }
    renderCurrent();
    toast('Conversación eliminada.');
  }

  function exportConversation() {
    if (!state.current?.messages.length) {
      toast('La conversación todavía no tiene mensajes.', true);
      return;
    }
    const lines = [`# ${state.current.title}`, '', `Exportado desde Nova: ${new Date().toLocaleString('es')}`, ''];
    for (const message of state.current.messages) {
      if (message.error) continue;
      lines.push(`## ${message.role === 'assistant' ? 'Nova' : 'Tú'} · ${formatTime(message.createdAt)}`, '', message.content, '');
      for (const attachment of message.attachments || []) lines.push(`Adjunto: ${attachment.name}`, '');
    }
    const filename = `${state.current.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'conversacion'}.md`;
    Promise.resolve(native.exportText(filename, lines.join('\n')))
      .then(() => toast('Conversación preparada para exportar.'))
      .catch(error => toast(error.message, true));
  }

  async function refreshBootstrap() {
    try {
      const bootstrap = await native.getBootstrap();
      if (bootstrap && typeof bootstrap === 'object') {
        state.bootstrap = { ...state.bootstrap, ...bootstrap };
        state.settings = { ...state.settings, ...(bootstrap.settings || {}) };
        state.serverOnline = bootstrap.ready !== false;
      }
    } catch (error) {
      console.warn('Bootstrap nativo no disponible:', error);
    }
    updateTelemetry();
    updateSettingsForm();
  }

  async function checkHealth() {
    try {
      const response = await fetch('/nova/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('offline');
      const status = await response.json();
      state.bootstrap = { ...state.bootstrap, ...status };
      state.serverOnline = status.ready !== false;
    } catch {
      if (native.platform === 'browser') state.serverOnline = false;
      else {
        try {
          const response = await fetch('/health', { cache: 'no-store' });
          state.serverOnline = response.ok;
        } catch { state.serverOnline = false; }
      }
    }
    updateTelemetry();
  }

  function updateConnectionUI() {
    const online = state.serverOnline;
    $('connectionBadge').classList.toggle('is-offline', !online);
    $('connectionText').textContent = state.generating ? 'GENERANDO' : online ? 'EN LÍNEA' : 'SIN NÚCLEO';
    $('coreState').textContent = state.generating ? 'NÚCLEO PROCESANDO' : online ? 'NÚCLEO OPERATIVO' : 'NÚCLEO EN ESPERA';
  }

  function updateTelemetry() {
    const data = state.bootstrap;
    $('modelName').textContent = data.modelName || 'Sin modelo cargado';
    $('modelName').title = data.modelName || '';
    $('contextMetric').textContent = String(state.settings.context);
    $('threadsMetric').textContent = String(state.settings.threads);
    $('memoryMetric').textContent = Number.isFinite(data.memoryAvailableMB) ? `${Math.round(data.memoryAvailableMB)} MB` : '—';
    $('clusterMode').textContent = state.settings.rpcEnabled ? 'Clúster RPC activo' : 'Nodo local';
    const nodes = state.settings.rpcEndpoints?.length || 0;
    $('clusterDetail').textContent = state.settings.rpcEnabled ? `${nodes} worker${nodes === 1 ? '' : 's'} configurado${nodes === 1 ? '' : 's'}` : 'RPC desactivado';
    updateConnectionUI();
  }

  function updateSettingsForm() {
    $('settingsModelName').textContent = state.bootstrap.modelName || 'Ningún modelo seleccionado';
    $('settingsModelMeta').textContent = state.bootstrap.modelSize ? `${state.bootstrap.modelSize} · GGUF local` : 'Selecciona un archivo GGUF válido';
    $('settingsProjectorName').textContent = state.bootstrap.mmprojName || 'Proyector multimodal no configurado';
    $('contextSelect').value = String(state.settings.context);
    $('threadsInput').value = String(state.settings.threads);
    $('batchSelect').value = String(state.settings.batch);
    $('temperatureInput').value = String(state.settings.temperature);
    $('temperatureValue').textContent = Number(state.settings.temperature).toFixed(2);
    $('systemPromptInput').value = state.settings.systemPrompt;
    $('motionToggle').checked = Boolean(state.settings.reduceMotion);
    $('rpcEnabledToggle').checked = Boolean(state.settings.rpcEnabled);
    $('rpcEndpointsInput').value = (state.settings.rpcEndpoints || []).join('\n');
  }

  function openSettings(section = null) {
    updateSettingsForm();
    showDialog('settingsDialog');
    if (section) requestAnimationFrame(() => $(section).scrollIntoView({ block: 'start' }));
  }

  function parseRpcEndpoints(text) {
    const endpoints = text.split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
    if (endpoints.length > 8) throw new Error('El límite es de 8 nodos RPC.');
    for (const endpoint of endpoints) {
      if (!/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(endpoint)) throw new Error(`Nodo RPC no válido: ${endpoint}`);
      const port = Number(endpoint.split(':').pop());
      if (port < 1 || port > 65535) throw new Error(`Puerto RPC no válido: ${endpoint}`);
    }
    return Array.from(new Set(endpoints));
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      const rpcEndpoints = parseRpcEndpoints($('rpcEndpointsInput').value);
      const rpcEnabled = $('rpcEnabledToggle').checked;
      if (rpcEnabled && !rpcEndpoints.length) throw new Error('Añade al menos un worker RPC o desactiva el clúster.');
      const next = {
        context: Number($('contextSelect').value),
        threads: Number($('threadsInput').value),
        batch: Number($('batchSelect').value),
        temperature: Number($('temperatureInput').value),
        systemPrompt: $('systemPromptInput').value.trim(),
        reduceMotion: $('motionToggle').checked,
        rpcEnabled,
        rpcEndpoints
      };
      if (!Number.isInteger(next.threads) || next.threads < 1 || next.threads > 16) throw new Error('Los hilos deben estar entre 1 y 16.');
      $('saveSettingsBtn').disabled = true;
      const result = await native.applySettings(next);
      if (result?.accepted === false) throw new Error(result.error || 'El núcleo rechazó la configuración.');
      state.settings = next;
      document.body.classList.toggle('reduce-motion', next.reduceMotion);
      await window.NovaStore.setSetting('preferences', {
        temperature: next.temperature, systemPrompt: next.systemPrompt, reduceMotion: next.reduceMotion
      });
      updateTelemetry();
      closeDialog('settingsDialog');
      state.serverOnline = false;
      updateConnectionUI();
      toast('Configuración guardada. El núcleo se está reiniciando.');
      setTimeout(async () => { await refreshBootstrap(); await checkHealth(); }, 2500);
    } catch (error) {
      $('settingsFeedback').textContent = error.message;
      toast(error.message, true);
    } finally {
      $('saveSettingsBtn').disabled = false;
    }
  }

  async function selectNativeFile(kind) {
    try {
      const result = kind === 'model' ? await native.selectModel() : await native.selectProjector();
      if (result && typeof result === 'object' && result.modelName) state.bootstrap = { ...state.bootstrap, ...result };
      if (native.platform !== 'android') await refreshBootstrap();
      if (native.platform === 'android') closeDialog('settingsDialog');
      const message = native.platform === 'android'
        ? (kind === 'model' ? 'Selecciona el archivo GGUF en el diálogo del sistema.' : 'Selecciona el proyector multimodal.')
        : 'Archivo configurado. El núcleo se está reiniciando.';
      toast(message);
    } catch (error) { toast(error.message, true); }
  }

  async function showLogs() {
    showDialog('logsDialog');
    $('logsOutput').textContent = 'Cargando registros…';
    try {
      const logs = await native.getLogs();
      $('logsOutput').textContent = typeof logs === 'string' ? logs : logs.logs || JSON.stringify(logs, null, 2);
    } catch (error) { $('logsOutput').textContent = error.message; }
  }

  function openDrawer(id) {
    closeDrawers();
    $(id).classList.add('is-open');
    $('drawerBackdrop').hidden = false;
  }

  function closeDrawers() {
    $('conversationPanel').classList.remove('is-open');
    $('telemetryPanel').classList.remove('is-open');
    $('drawerBackdrop').hidden = true;
  }

  function bindEvents() {
    $('newChatBtn').addEventListener('click', newConversation);
    $('brandHome').addEventListener('click', event => { event.preventDefault(); newConversation(); });
    $('openSidebarBtn').addEventListener('click', () => openDrawer('conversationPanel'));
    $('closeSidebarBtn').addEventListener('click', closeDrawers);
    $('drawerBackdrop').addEventListener('click', closeDrawers);
    $('searchInput').addEventListener('input', renderConversationList);
    $('conversationList').addEventListener('click', event => {
      const remove = event.target.closest('[data-delete-conversation]');
      if (remove) {
        const conversation = state.conversations.find(item => item.id === remove.dataset.deleteConversation);
        confirmAction('Eliminar conversación', `Se eliminará “${conversation.title}” de este dispositivo. Esta acción no se puede deshacer.`, () => deleteConversation(conversation.id));
        return;
      }
      const open = event.target.closest('[data-conversation-id]');
      if (open) selectConversation(open.dataset.conversationId);
    });
    document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
      $('promptInput').value = button.dataset.prompt;
      updatePromptCounter();
      $('promptInput').focus();
      $('promptInput').dispatchEvent(new Event('input'));
    }));
    $('chatForm').addEventListener('submit', event => { event.preventDefault(); sendCurrentMessage(); });
    $('stopBtn').addEventListener('click', stopGeneration);
    $('promptInput').addEventListener('input', event => {
      updatePromptCounter();
      const input = event.currentTarget;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
    $('promptInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        $('chatForm').requestSubmit();
      }
    });
    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', event => handleFiles(event.target.files));
    $('attachmentPreview').addEventListener('click', event => {
      const button = event.target.closest('[data-remove-attachment]');
      if (!button) return;
      state.draftAttachments = state.draftAttachments.filter(item => item.id !== button.dataset.removeAttachment);
      renderAttachmentPreview();
    });
    $('messages').addEventListener('click', async event => {
      const link = event.target.closest('a[href]');
      if (link) {
        event.preventDefault();
        try { await native.openExternal(link.href); } catch (error) { toast(error.message, true); }
        return;
      }
      const image = event.target.closest('[data-full-image]');
      if (image) {
        $('viewerImage').src = image.dataset.fullImage;
        $('viewerImage').alt = image.alt;
        showDialog('imageViewer');
        return;
      }
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const article = button.closest('[data-message-id]');
      const message = state.current.messages.find(item => item.id === article.dataset.messageId);
      if (!message) return;
      if (button.dataset.action === 'copy') {
        try { await copyText(message.content); toast('Mensaje copiado.'); } catch (error) { toast(error.message, true); }
      } else if (button.dataset.action === 'forward') openForward(message.id);
      else if (button.dataset.action === 'regenerate') {
        const index = state.current.messages.findIndex(item => item.id === message.id);
        state.current.messages.splice(index, 1);
        await saveCurrent();
        renderCurrent();
        await generateAssistantReply();
      } else if (button.dataset.action === 'delete-message') {
        confirmAction('Eliminar mensaje', 'El mensaje se quitará de esta conversación.', async () => {
          state.current.messages = state.current.messages.filter(item => item.id !== message.id);
          await saveCurrent();
          renderCurrent();
        });
      }
    });
    $('forwardForm').addEventListener('submit', forwardMessage);
    $('confirmForm').addEventListener('submit', async event => {
      event.preventDefault();
      const action = state.confirmAction;
      state.confirmAction = null;
      closeDialog('confirmDialog');
      if (action) await action();
    });
    $('renameChatBtn').addEventListener('click', () => {
      $('inputDialogField').value = state.current.title;
      showDialog('inputDialog');
      requestAnimationFrame(() => { $('inputDialogField').focus(); $('inputDialogField').select(); });
    });
    $('inputForm').addEventListener('submit', async event => {
      event.preventDefault();
      const title = $('inputDialogField').value.trim();
      if (!title) return;
      state.current.title = title;
      await saveCurrent();
      closeDialog('inputDialog');
      renderCurrent();
      toast('Nombre actualizado.');
    });
    $('exportChatBtn').addEventListener('click', exportConversation);
    $('openSettingsBtn').addEventListener('click', () => openSettings());
    $('telemetrySettingsBtn').addEventListener('click', () => openSettings());
    $('configureClusterBtn').addEventListener('click', () => openSettings('clusterSettings'));
    $('settingsForm').addEventListener('submit', saveSettings);
    $('temperatureInput').addEventListener('input', event => { $('temperatureValue').textContent = Number(event.target.value).toFixed(2); });
    $('selectModelBtn').addEventListener('click', () => selectNativeFile('model'));
    $('selectProjectorBtn').addEventListener('click', () => selectNativeFile('projector'));
    $('viewLogsBtn').addEventListener('click', showLogs);
    $('refreshLogsBtn').addEventListener('click', showLogs);
    $('copyLogsBtn').addEventListener('click', async () => {
      try { await copyText($('logsOutput').textContent); toast('Diagnóstico copiado.'); } catch (error) { toast(error.message, true); }
    });
    $('telemetryToggleBtn').addEventListener('click', () => {
      if (window.innerWidth >= 1180) $('appShell').classList.toggle('telemetry-collapsed');
      else openDrawer('telemetryPanel');
    });
    $('closeTelemetryBtn').addEventListener('click', () => {
      if (window.innerWidth >= 1180) $('appShell').classList.add('telemetry-collapsed');
      else closeDrawers();
    });
    $('messageScroll').addEventListener('scroll', () => { $('scrollBottomBtn').hidden = isNearBottom(); }, { passive: true });
    $('scrollBottomBtn').addEventListener('click', () => scrollToBottom());
    document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.close)));
    document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
      if (event.target === dialog && dialog.id !== 'confirmDialog') closeDialog(dialog.id);
    }));
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newConversation(); }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); openSettings(); }
      if (event.key === 'Escape') closeDrawers();
    });
  }

  async function initialize() {
    configureMarkdown();
    bindEvents();
    try {
      const preferences = await window.NovaStore.getSetting('preferences', {});
      state.settings = { ...state.settings, ...preferences };
      document.body.classList.toggle('reduce-motion', state.settings.reduceMotion);
      state.conversations = await window.NovaStore.listConversations();
      if (!state.conversations.length) {
        state.current = createConversation();
        state.conversations = [state.current];
        await window.NovaStore.saveConversation(state.current);
      } else state.current = state.conversations[0];
      renderCurrent();
    } catch (error) {
      state.current = createConversation();
      state.conversations = [state.current];
      renderCurrent();
      toast(`El almacenamiento local no está disponible: ${error.message}`, true);
    }
    await refreshBootstrap();
    await checkHealth();
    state.healthTimer = setInterval(checkHealth, 8000);
  }

  initialize().catch(error => {
    console.error(error);
    toast(`No se pudo iniciar Nova: ${error.message}`, true);
  });
})();
