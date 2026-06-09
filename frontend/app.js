// Stream URLs injected by GitHub Actions during deployment
const STREAM_URLS = {
    waste_details: '__URL_WASTE_DETAILS__',
    further_actions: '__URL_FURTHER_ACTIONS__',
    environmental_impact: '__URL_ENVIRONMENTAL_IMPACT__',
    smartwaste_assistant: '__URL_SMARTWASTE_ASSISTANT__',
};

// State
let fileData = null;
let fileMime = null;
let chatHistory = [];

// DOM elements
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const uploadPreview = document.getElementById('uploadPreview');
const previewImg = document.getElementById('previewImg');
const removeFile = document.getElementById('removeFile');
const description = document.getElementById('description');
const location = document.getElementById('location');
const runAllBtn = document.getElementById('runAll');
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatContainer = document.getElementById('chatContainer');

// File upload handling
uploadZone.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
});

uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
});

removeFile.addEventListener('click', () => {
    fileData = null;
    fileMime = null;
    uploadPreview.hidden = true;
    uploadZone.style.display = '';
    fileInput.value = '';
});

function handleFile(file) {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        alert('Please upload a JPG, PNG, or WEBP image.');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target.result;
        // Strip "data:<mime>;base64," prefix
        const base64 = dataUrl.split(',')[1];
        fileData = base64;
        fileMime = file.type;

        previewImg.src = dataUrl;
        uploadPreview.hidden = false;
        uploadZone.style.display = 'none';
    };
    reader.readAsDataURL(file);
}

// Markdown rendering
function renderMarkdownLine(text) {
    if (!text.trim()) return '';

    // Horizontal rule
    if (/^---+$/.test(text.trim())) {
        return '<span class="md-line md-hr"></span>';
    }

    // Headers
    if (text.startsWith('### ')) {
        return `<span class="md-line md-h3">${inlineFormat(text.slice(4))}</span>`;
    }
    if (text.startsWith('## ')) {
        return `<span class="md-line md-h2">${inlineFormat(text.slice(3))}</span>`;
    }
    if (text.startsWith('# ')) {
        return `<span class="md-line md-h1">${inlineFormat(text.slice(2))}</span>`;
    }

    // Bullet lists
    if (/^[\-\*]\s/.test(text)) {
        return `<span class="md-line md-bullet">${inlineFormat(text.slice(2))}</span>`;
    }

    // Numbered lists
    if (/^\d+\.\s/.test(text)) {
        return `<span class="md-line md-numbered">${inlineFormat(text)}</span>`;
    }

    return `<span class="md-line">${inlineFormat(text)}</span>`;
}

function inlineFormat(text) {
    // Escape HTML
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Inline code
    text = text.replace(/`(.+?)`/g, '<code>$1</code>');
    return text;
}

// Streaming fetch
async function streamToPanel(url, body, panelId) {
    const panel = document.getElementById(panelId);
    panel.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><div class="loading-text">Analyzing...</div></div>';

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        panel.innerHTML = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        panel.appendChild(cursor);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete last line

            for (const line of lines) {
                const html = renderMarkdownLine(line);
                if (html) {
                    cursor.insertAdjacentHTML('beforebegin', html);
                }
            }
            panel.scrollTop = panel.scrollHeight;
        }

        // Flush remaining buffer
        if (buffer.trim()) {
            const html = renderMarkdownLine(buffer);
            if (html) {
                cursor.insertAdjacentHTML('beforebegin', html);
            }
        }

        cursor.remove();
        panel.scrollTop = panel.scrollHeight;
    } catch (err) {
        panel.innerHTML = `<div class="error-message">⚠️ Error: ${err.message}</div>`;
    }
}

// Run All analysis
runAllBtn.addEventListener('click', () => {
    if (!fileData) {
        alert('Please upload a waste image first.');
        return;
    }

    runAllBtn.disabled = true;
    runAllBtn.textContent = '⏳ Analyzing...';

    const baseBody = {
        file_data: fileData,
        file_mime: fileMime,
        description: description.value.trim(),
    };

    const promises = [
        streamToPanel(STREAM_URLS.waste_details, baseBody, 'wasteDetailsPanel'),
        streamToPanel(STREAM_URLS.further_actions, {
            ...baseBody,
            location: location.value.trim(),
        }, 'furtherActionsPanel'),
        streamToPanel(STREAM_URLS.environmental_impact, baseBody, 'environmentalImpactPanel'),
    ];

    Promise.allSettled(promises).then(() => {
        runAllBtn.disabled = false;
        runAllBtn.textContent = '🔍 Analyze Waste';
    });
});

// Chat functionality
chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
});

async function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message) return;

    // Add user message to UI
    const userBubble = document.createElement('div');
    userBubble.className = 'chat-message user';
    userBubble.innerHTML = `<div class="message-content">${escapeHtml(message)}</div>`;
    chatContainer.appendChild(userBubble);

    chatInput.value = '';
    chatSend.disabled = true;
    chatInput.disabled = true;

    // Add assistant bubble
    const assistantBubble = document.createElement('div');
    assistantBubble.className = 'chat-message assistant';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    assistantBubble.appendChild(contentDiv);
    chatContainer.appendChild(assistantBubble);

    chatContainer.scrollTop = chatContainer.scrollHeight;

    const body = {
        message: message,
        history: chatHistory,
        description: description.value.trim(),
        location: location.value.trim(),
    };

    // Include image if available
    if (fileData) {
        body.file_data = fileData;
        body.file_mime = fileMime;
    }

    try {
        const response = await fetch(STREAM_URLS.smartwaste_assistant, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullReply = '';
        let cursor = document.createElement('span');
        cursor.className = 'streaming-cursor';
        contentDiv.appendChild(cursor);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            fullReply += chunk;
            buffer += chunk;

            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const html = renderMarkdownLine(line);
                if (html) {
                    cursor.insertAdjacentHTML('beforebegin', html);
                }
            }
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        // Flush remaining
        if (buffer.trim()) {
            const html = renderMarkdownLine(buffer);
            if (html) {
                cursor.insertAdjacentHTML('beforebegin', html);
            }
        }

        cursor.remove();

        // Update history
        chatHistory.push({ role: 'user', content: message });
        chatHistory.push({ role: 'assistant', content: fullReply });

    } catch (err) {
        contentDiv.innerHTML = `<span class="error-message">⚠️ Error: ${err.message}</span>`;
    }

    chatSend.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
