(function() {
    'use strict';

    // STREAM_URLS is defined in index.html (injected by CI/CD)

    // State
    var fileData = null;
    var fileMime = null;
    var chatHistory = [];

    // DOM elements
    var uploadZone = document.getElementById('uploadZone');
    var fileInput = document.getElementById('fileInput');
    var uploadPreview = document.getElementById('uploadPreview');
    var previewImg = document.getElementById('previewImg');
    var removeFileBtn = document.getElementById('removeFile');
    var descriptionInput = document.getElementById('description');
    var locationInput = document.getElementById('locationInput');
    var runAllBtn = document.getElementById('runAll');
    var chatInput = document.getElementById('chatInput');
    var chatSendBtn = document.getElementById('chatSend');
    var chatContainer = document.getElementById('chatContainer');

    // --- File Upload ---
    uploadZone.addEventListener('click', function() {
        fileInput.click();
    });

    uploadZone.addEventListener('dragover', function(e) {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });

    uploadZone.addEventListener('dragleave', function() {
        uploadZone.classList.remove('dragover');
    });

    uploadZone.addEventListener('drop', function(e) {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files[0]) {
            handleFile(fileInput.files[0]);
        }
    });

    removeFileBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        fileData = null;
        fileMime = null;
        uploadPreview.hidden = true;
        uploadZone.style.display = '';
        fileInput.value = '';
    });

    function handleFile(file) {
        var validTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (validTypes.indexOf(file.type) === -1) {
            alert('Please upload a JPG, PNG, or WEBP image.');
            return;
        }

        var reader = new FileReader();
        reader.onload = function(e) {
            var dataUrl = e.target.result;
            var base64 = dataUrl.split(',')[1];
            fileData = base64;
            fileMime = file.type;

            previewImg.src = dataUrl;
            uploadPreview.hidden = false;
            uploadZone.style.display = 'none';
        };
        reader.readAsDataURL(file);
    }

    // --- Markdown Rendering ---
    function renderMarkdownLine(text) {
        if (!text.trim()) return '';

        if (/^---+$/.test(text.trim())) {
            return '<span class="md-line md-hr"></span>';
        }
        if (text.startsWith('### ')) {
            return '<span class="md-line md-h3">' + inlineFormat(text.slice(4)) + '</span>';
        }
        if (text.startsWith('## ')) {
            return '<span class="md-line md-h2">' + inlineFormat(text.slice(3)) + '</span>';
        }
        if (text.startsWith('# ')) {
            return '<span class="md-line md-h1">' + inlineFormat(text.slice(2)) + '</span>';
        }
        if (/^[\-\*]\s/.test(text)) {
            return '<span class="md-line md-bullet">' + inlineFormat(text.slice(2)) + '</span>';
        }
        if (/^\d+\.\s/.test(text)) {
            return '<span class="md-line md-numbered">' + inlineFormat(text) + '</span>';
        }
        return '<span class="md-line">' + inlineFormat(text) + '</span>';
    }

    function inlineFormat(text) {
        text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
        text = text.replace(/`(.+?)`/g, '<code>$1</code>');
        return text;
    }

    // --- Streaming Fetch ---
    function streamToPanel(url, body, panelId) {
        var panel = document.getElementById(panelId);
        panel.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><div class="loading-text">Analyzing...</div></div>';

        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ': ' + response.statusText);
            }

            panel.innerHTML = '';
            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            var cursor = document.createElement('span');
            cursor.className = 'streaming-cursor';
            panel.appendChild(cursor);

            function read() {
                return reader.read().then(function(result) {
                    if (result.done) {
                        if (buffer.trim()) {
                            var html = renderMarkdownLine(buffer);
                            if (html) cursor.insertAdjacentHTML('beforebegin', html);
                        }
                        cursor.remove();
                        panel.scrollTop = panel.scrollHeight;
                        return;
                    }

                    buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (var i = 0; i < lines.length; i++) {
                        var html = renderMarkdownLine(lines[i]);
                        if (html) cursor.insertAdjacentHTML('beforebegin', html);
                    }
                    panel.scrollTop = panel.scrollHeight;
                    return read();
                });
            }

            return read();
        }).catch(function(err) {
            panel.innerHTML = '<div class="error-message">⚠️ Error: ' + err.message + '</div>';
        });
    }

    // --- Run All ---
    runAllBtn.addEventListener('click', function() {
        if (!fileData) {
            alert('Please upload a waste image first.');
            return;
        }

        runAllBtn.disabled = true;
        runAllBtn.textContent = '⏳ Analyzing...';

        var baseBody = {
            file_data: fileData,
            file_mime: fileMime,
            description: descriptionInput.value.trim(),
        };

        var promises = [
            streamToPanel(STREAM_URLS.waste_details, baseBody, 'wasteDetailsPanel'),
            streamToPanel(STREAM_URLS.further_actions, {
                file_data: fileData,
                file_mime: fileMime,
                description: descriptionInput.value.trim(),
                location: locationInput.value.trim(),
            }, 'furtherActionsPanel'),
            streamToPanel(STREAM_URLS.environmental_impact, baseBody, 'environmentalImpactPanel'),
        ];

        Promise.all(promises.map(function(p) { return p.catch(function() {}); })).then(function() {
            runAllBtn.disabled = false;
            runAllBtn.textContent = '🔍 Analyze Waste';
        });
    });

    // --- Chat ---
    chatSendBtn.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });

    function sendChatMessage() {
        var message = chatInput.value.trim();
        if (!message) return;

        var userBubble = document.createElement('div');
        userBubble.className = 'chat-message user';
        userBubble.innerHTML = '<div class="message-content">' + escapeHtml(message) + '</div>';
        chatContainer.appendChild(userBubble);

        chatInput.value = '';
        chatSendBtn.disabled = true;
        chatInput.disabled = true;

        var assistantBubble = document.createElement('div');
        assistantBubble.className = 'chat-message assistant';
        var contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        assistantBubble.appendChild(contentDiv);
        chatContainer.appendChild(assistantBubble);
        chatContainer.scrollTop = chatContainer.scrollHeight;

        var body = {
            message: message,
            history: chatHistory,
            description: descriptionInput.value.trim(),
            location: locationInput.value.trim(),
        };

        if (fileData) {
            body.file_data = fileData;
            body.file_mime = fileMime;
        }

        fetch(STREAM_URLS.smartwaste_assistant, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ': ' + response.statusText);
            }

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            var fullReply = '';
            var cursor = document.createElement('span');
            cursor.className = 'streaming-cursor';
            contentDiv.appendChild(cursor);

            function read() {
                return reader.read().then(function(result) {
                    if (result.done) {
                        if (buffer.trim()) {
                            var html = renderMarkdownLine(buffer);
                            if (html) cursor.insertAdjacentHTML('beforebegin', html);
                        }
                        cursor.remove();
                        chatHistory.push({ role: 'user', content: message });
                        chatHistory.push({ role: 'assistant', content: fullReply });
                        chatSendBtn.disabled = false;
                        chatInput.disabled = false;
                        chatInput.focus();
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                        return;
                    }

                    var chunk = decoder.decode(result.value, { stream: true });
                    fullReply += chunk;
                    buffer += chunk;
                    var lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (var i = 0; i < lines.length; i++) {
                        var html = renderMarkdownLine(lines[i]);
                        if (html) cursor.insertAdjacentHTML('beforebegin', html);
                    }
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    return read();
                });
            }

            return read();
        }).catch(function(err) {
            contentDiv.innerHTML = '<span class="error-message">⚠️ Error: ' + err.message + '</span>';
            chatSendBtn.disabled = false;
            chatInput.disabled = false;
            chatInput.focus();
        });
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

})();
