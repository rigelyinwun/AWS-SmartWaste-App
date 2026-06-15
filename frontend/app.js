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

    // --- Rendering: Waste Details as Table ---
    function renderWasteDetailsTable(text) {
        var lines = text.split('\n');
        var rows = [];
        var currentLabel = '';
        var currentValue = '';

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith('##') || line.startsWith('#')) continue;

            // Check for "Label: Value" pattern
            var colonIndex = line.indexOf(':');
            if (colonIndex > 0 && colonIndex < 30 && !line.startsWith('-') && !line.startsWith('*')) {
                if (currentLabel) {
                    rows.push({ label: currentLabel, value: currentValue.trim() });
                }
                currentLabel = line.substring(0, colonIndex).trim();
                currentValue = line.substring(colonIndex + 1).trim();
            } else if (line.startsWith('-') || line.startsWith('*')) {
                currentValue += '<br>\u2022 ' + escapeHtml(line.substring(1).trim());
            } else {
                currentValue += ' ' + escapeHtml(line);
            }
        }
        if (currentLabel) {
            rows.push({ label: currentLabel, value: currentValue.trim() });
        }

        if (rows.length === 0) return '<div class="md-line">' + escapeHtml(text) + '</div>';

        var html = '<table class="waste-table">';
        for (var j = 0; j < rows.length; j++) {
            html += '<tr><td>' + escapeHtml(rows[j].label) + '</td><td>' + rows[j].value + '</td></tr>';
        }
        html += '</table>';
        return html;
    }

    // --- Rendering: Further Actions as Flowchart + Cards ---
    function renderFurtherActions(text) {
        var sections = parseSections(text);
        var disposalSteps = [];
        var cards = [];

        for (var i = 0; i < sections.length; i++) {
            var sec = sections[i];
            if (sec.title.toLowerCase().indexOf('disposal method') !== -1) {
                disposalSteps = sec.bullets;
            } else {
                cards.push(sec);
            }
        }

        var html = '<div class="further-actions-layout">';

        // Flowchart (left)
        html += '<div class="flowchart">';
        html += '<div class="flowchart-title">Disposal Method</div>';
        for (var s = 0; s < disposalSteps.length; s++) {
            if (s > 0) {
                html += '<div class="flow-arrow"></div>';
            }
            html += '<div class="flow-step">' + escapeHtml(disposalSteps[s]) + '</div>';
        }
        if (disposalSteps.length === 0) {
            html += '<div class="flow-step">Upload an image to see disposal steps</div>';
        }
        html += '</div>';

        // Text cards (right)
        html += '<div class="text-cards">';
        for (var c = 0; c < cards.length; c++) {
            html += '<div class="text-card">';
            html += '<div class="text-card-title">' + escapeHtml(cards[c].title) + '</div>';
            if (cards[c].bullets.length > 0) {
                html += '<ul>';
                for (var b = 0; b < cards[c].bullets.length; b++) {
                    html += '<li>' + escapeHtml(cards[c].bullets[b]) + '</li>';
                }
                html += '</ul>';
            }
            html += '</div>';
        }
        html += '</div>';

        html += '</div>';
        return html;
    }

    // --- Rendering: Environmental Impact (Rich Layout) ---
    function renderEnvironmentalImpact(text) {
        var sections = parseSections(text);
        var html = '<div class="env-impact-layout">';

        // Try to extract key data from sections
        var identification = findSection(sections, 'identification');
        var decomposition = extractDecomposition(text);
        var lifecycle = findSection(sections, 'lifecycle');
        var landImpact = findSection(sections, 'land');
        var waterImpact = findSection(sections, 'water');
        var wildlifeImpact = findSection(sections, 'wildlife');
        var climateImpact = findSection(sections, 'climate');
        var futureImpact = findSection(sections, 'future');
        var healthImpact = findSection(sections, 'health');
        var recommendation = findSection(sections, 'recommendation');
        var educational = findSection(sections, 'educational');

        // Row 1: Identification + Decomposition Time
        html += '<div class="env-row env-row-top">';
        html += '<div class="env-card">';
        html += '<div class="env-card-title">Waste Item Identification</div>';
        if (identification) {
            html += '<ul class="env-list">';
            for (var i = 0; i < identification.bullets.length; i++) {
                html += '<li>' + escapeHtml(identification.bullets[i]) + '</li>';
            }
            html += '</ul>';
        }
        html += '</div>';
        if (decomposition) {
            var decompUnit = extractDecompositionUnit(text);
            html += '<div class="env-card env-decomp-card">';
            html += '<div class="env-card-title">Estimated Decomposition Time</div>';
            html += '<div class="env-decomp-number">' + escapeHtml(decomposition) + '</div>';
            html += '<div class="env-decomp-label">' + escapeHtml(decompUnit) + '</div>';
            html += '</div>';
        }
        html += '</div>';

        // Row 2: Material & Lifecycle (process chart)
        if (lifecycle) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Material & Lifecycle Overview</div>';
            html += '<div class="env-lifecycle-chart">';
            for (var l = 0; l < lifecycle.bullets.length && l < 4; l++) {
                if (l > 0) html += '<div class="env-lifecycle-arrow">→</div>';
                html += '<div class="env-lifecycle-step">' + escapeHtml(lifecycle.bullets[l]) + '</div>';
            }
            html += '</div>';
            if (lifecycle.bullets.length > 4) {
                html += '<ul class="env-list">';
                for (var lb = 4; lb < lifecycle.bullets.length; lb++) {
                    html += '<li>' + escapeHtml(lifecycle.bullets[lb]) + '</li>';
                }
                html += '</ul>';
            }
            html += '</div>';
        }

        // Row 3: Land / Water / Wildlife impact with images
        var hasAnyImpact = landImpact || waterImpact || wildlifeImpact;
        if (hasAnyImpact) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Environmental Impact</div>';
            html += '<div class="env-impact-grid">';

            // Land
            if (landImpact) {
                html += '<div class="env-impact-card">';
                html += '<img src="images/landfill.jpg" alt="Land impact" class="env-impact-img">';
                html += '<div class="env-impact-card-title">Land Impact</div>';
                html += '<ul class="env-list-sm">';
                for (var li = 0; li < landImpact.bullets.length; li++) {
                    html += '<li>' + escapeHtml(landImpact.bullets[li]) + '</li>';
                }
                html += '</ul>';
                html += '</div>';
            }

            // Water
            if (waterImpact) {
                html += '<div class="env-impact-card">';
                html += '<img src="images/water.jpeg" alt="Water impact" class="env-impact-img">';
                html += '<div class="env-impact-card-title">Water Impact</div>';
                html += '<ul class="env-list-sm">';
                for (var wi = 0; wi < waterImpact.bullets.length; wi++) {
                    html += '<li>' + escapeHtml(waterImpact.bullets[wi]) + '</li>';
                }
                html += '</ul>';
                html += '</div>';
            }

            // Wildlife
            if (wildlifeImpact) {
                html += '<div class="env-impact-card">';
                html += '<img src="images/wildlife.jpg" alt="Wildlife impact" class="env-impact-img">';
                html += '<div class="env-impact-card-title">Wildlife Impact</div>';
                html += '<ul class="env-list-sm">';
                for (var wli = 0; wli < wildlifeImpact.bullets.length; wli++) {
                    html += '<li>' + escapeHtml(wildlifeImpact.bullets[wli]) + '</li>';
                }
                html += '</ul>';
                html += '</div>';
            }

            html += '</div>'; // end env-impact-grid
            html += '</div>'; // end section-block
        }

        // Row 4: Climate Impact
        if (climateImpact) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Climate Impact</div>';
            html += '<div class="env-climate-grid">';
            for (var ci = 0; ci < climateImpact.bullets.length; ci++) {
                html += '<div class="env-climate-item">' + escapeHtml(climateImpact.bullets[ci]) + '</div>';
            }
            html += '</div>';
            html += '</div>';
        }

        // Row 5: Future Impact
        if (futureImpact) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Future Impact Insight</div>';
            html += '<ul class="env-list">';
            for (var fi = 0; fi < futureImpact.bullets.length; fi++) {
                html += '<li>' + escapeHtml(futureImpact.bullets[fi]) + '</li>';
            }
            html += '</ul>';
            html += '</div>';
        }

        // Row 6: Human Health
        if (healthImpact) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Human Health Impact</div>';
            html += '<ul class="env-list">';
            for (var hi = 0; hi < healthImpact.bullets.length; hi++) {
                html += '<li>' + escapeHtml(healthImpact.bullets[hi]) + '</li>';
            }
            html += '</ul>';
            html += '</div>';
        }

        // Row 7: Recommendation
        if (recommendation) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Waste Management Recommendation</div>';
            html += '<ul class="env-list">';
            for (var ri = 0; ri < recommendation.bullets.length; ri++) {
                html += '<li>' + escapeHtml(recommendation.bullets[ri]) + '</li>';
            }
            html += '</ul>';
            html += '</div>';
        }

        // Row 8: Educational
        if (educational) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Educational Insight</div>';
            html += '<ul class="env-list">';
            for (var ei = 0; ei < educational.bullets.length; ei++) {
                html += '<li>' + escapeHtml(educational.bullets[ei]) + '</li>';
            }
            html += '</ul>';
            html += '</div>';
        }

        // Fallback: any sections not matched
        var matched = [identification, lifecycle, landImpact, waterImpact, wildlifeImpact, climateImpact, futureImpact, healthImpact, recommendation, educational];
        for (var si = 0; si < sections.length; si++) {
            if (matched.indexOf(sections[si]) === -1) {
                html += '<div class="env-section-block">';
                html += '<div class="env-section-heading">' + escapeHtml(sections[si].title) + '</div>';
                html += '<ul class="env-list">';
                for (var sb = 0; sb < sections[si].bullets.length; sb++) {
                    html += '<li>' + escapeHtml(sections[si].bullets[sb]) + '</li>';
                }
                html += '</ul>';
                html += '</div>';
            }
        }

        html += '</div>';
        return html;
    }

    function findSection(sections, keyword) {
        for (var i = 0; i < sections.length; i++) {
            if (sections[i].title.toLowerCase().indexOf(keyword) !== -1) {
                return sections[i];
            }
        }
        return null;
    }

    function extractDecomposition(text) {
        // Try various patterns the AI might use
        var patterns = [
            // "450-1,000 years" or "450 to 1000 years"
            /(\d[\d,.\-–\s]*(?:to\s*)?\d*[\d,.]*)[\s]*(?:years|months|decades|centuries|millennium|millennia)/i,
            // "Decomposition time: 450 years"
            /decomposition[^:]*:\s*([^\n]+)/i,
            // "Estimated decomposition: ..."
            /estimated[^:]*decomposition[^:]*:\s*([^\n]+)/i,
            // "breaks? down in X years"
            /breaks?\s*down\s*in\s*([^\n.]+)/i,
            // "takes X years to decompose"
            /takes?\s*([^\n.]*?\d[^\n.]*?)\s*to\s*decompos/i,
            // "X years to break down"
            /(\d[\d,.\-–\s]*(?:to\s*)?\d*[\d,.]*\s*(?:years|months|decades|centuries))\s*to\s*(?:break|decompos)/i,
            // Any line with a number followed by years
            /(\d[\d,.\-–\s]*(?:to\s*)?\d*[\d,.]*)\s*(?:years|months)/i
        ];

        for (var i = 0; i < patterns.length; i++) {
            var match = text.match(patterns[i]);
            if (match) {
                var val = match[1].trim();
                // Clean up: remove trailing words that aren't part of the number
                val = val.replace(/\s*(years|months|decades|centuries).*$/i, '').trim();
                if (val) return val;
            }
        }
        return null;
    }

    function extractDecompositionUnit(text) {
        var match = text.match(/\d[\d,.\-–\s]*(?:to\s*)?\d*[\d,.]*\s*(years|months|decades|centuries|millennium|millennia)/i);
        if (match) return match[1].toLowerCase();
        return 'years';
    }

    // --- Parse sections from markdown ---
    function parseSections(text) {
        var lines = text.split('\n');
        var sections = [];
        var currentSection = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('##') || line.startsWith('# ')) {
                if (currentSection) sections.push(currentSection);
                currentSection = {
                    title: line.replace(/^#+\s*/, ''),
                    bullets: []
                };
            } else if (line.startsWith('-') || line.startsWith('*')) {
                if (!currentSection) {
                    currentSection = { title: 'Details', bullets: [] };
                }
                currentSection.bullets.push(line.replace(/^[\-\*]\s*/, ''));
            } else if (line.indexOf(':') > 0 && currentSection) {
                currentSection.bullets.push(line);
            } else if (currentSection) {
                currentSection.bullets.push(line);
            }
        }
        if (currentSection) sections.push(currentSection);
        return sections;
    }

    // --- Markdown rendering (for chat) ---
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

    // --- Streaming fetch with post-render ---
    function streamToPanel(url, body, panelId, renderFn) {
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

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var fullText = '';

            // Show streaming text first
            panel.innerHTML = '';
            var streamDiv = document.createElement('div');
            streamDiv.style.whiteSpace = 'pre-wrap';
            streamDiv.style.fontSize = '0.85rem';
            streamDiv.style.color = '#555';
            panel.appendChild(streamDiv);
            var cursor = document.createElement('span');
            cursor.className = 'streaming-cursor';
            panel.appendChild(cursor);

            function read() {
                return reader.read().then(function(result) {
                    if (result.done) {
                        cursor.remove();
                        // Replace with structured render
                        if (renderFn) {
                            panel.innerHTML = renderFn(fullText);
                        }
                        return;
                    }

                    var chunk = decoder.decode(result.value, { stream: true });
                    fullText += chunk;
                    streamDiv.textContent = fullText;
                    panel.scrollTop = panel.scrollHeight;
                    return read();
                });
            }

            return read();
        }).catch(function(err) {
            panel.innerHTML = '<div class="error-message">\u26a0\ufe0f Error: ' + err.message + '</div>';
        });
    }

    // --- Run All ---
    runAllBtn.addEventListener('click', function() {
        if (!fileData) {
            alert('Please upload a waste image first.');
            return;
        }

        // Show output section
        document.getElementById('outputSection').hidden = false;

        runAllBtn.disabled = true;
        runAllBtn.textContent = '\u23f3 Analyzing...';

        var baseBody = {
            file_data: fileData,
            file_mime: fileMime,
            description: descriptionInput.value.trim(),
        };

        var promises = [
            streamToPanel(STREAM_URLS.waste_details, baseBody, 'wasteDetailsPanel', renderWasteDetailsTable),
            streamToPanel(STREAM_URLS.further_actions, {
                file_data: fileData,
                file_mime: fileMime,
                description: descriptionInput.value.trim(),
                location: locationInput.value.trim(),
            }, 'furtherActionsPanel', renderFurtherActions),
            streamToPanel(STREAM_URLS.environmental_impact, baseBody, 'environmentalImpactPanel', renderEnvironmentalImpact),
        ];

        Promise.all(promises.map(function(p) { return p.catch(function() {}); })).then(function() {
            runAllBtn.disabled = false;
            runAllBtn.textContent = '\ud83d\udd0d Analyze Waste';
        });
    });

    // --- Chat Toggle ---
    var chatFab = document.getElementById('chatFab');
    var chatPopup = document.getElementById('chatPopup');
    var chatPopupClose = document.getElementById('chatPopupClose');
    var chatBubbleHint = document.getElementById('chatBubbleHint');
    var closeBubbleHint = document.getElementById('closeBubbleHint');

    chatFab.addEventListener('click', function() {
        chatPopup.classList.toggle('open');
        chatBubbleHint.classList.add('hidden');
    });

    chatPopupClose.addEventListener('click', function() {
        chatPopup.classList.remove('open');
    });

    closeBubbleHint.addEventListener('click', function(e) {
        e.stopPropagation();
        chatBubbleHint.classList.add('hidden');
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
            contentDiv.innerHTML = '<span class="error-message">\u26a0\ufe0f Error: ' + err.message + '</span>';
            chatSendBtn.disabled = false;
            chatInput.disabled = false;
            chatInput.focus();
        });
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

})();
