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

            // Skip markdown headers but use them as context
            if (line.startsWith('#')) continue;

            // Bullet points - append to current value
            if (line.startsWith('-') || line.startsWith('*') || line.startsWith('•')) {
                var bulletText = line.replace(/^[\-\*•]\s*/, '').trim();
                if (bulletText) {
                    currentValue += (currentValue ? '<br>' : '') + '\u2022 ' + escapeHtml(bulletText);
                }
                continue;
            }

            // Check for "Label: Value" pattern (colon within first 40 chars)
            var colonIndex = line.indexOf(':');
            if (colonIndex > 0 && colonIndex < 40) {
                // Save previous row
                if (currentLabel) {
                    rows.push({ label: currentLabel, value: currentValue.trim() });
                }
                currentLabel = line.substring(0, colonIndex).trim().replace(/^\*\*|\*\*$/g, '');
                currentValue = escapeHtml(line.substring(colonIndex + 1).trim());
            } else if (currentLabel) {
                // Continuation of previous value
                currentValue += (currentValue ? ' ' : '') + escapeHtml(line);
            }
        }
        // Push last row
        if (currentLabel) {
            rows.push({ label: currentLabel, value: currentValue.trim() });
        }

        if (rows.length === 0) {
            // Fallback: just render as markdown
            var fallback = '';
            for (var f = 0; f < lines.length; f++) {
                var html = renderMarkdownLine(lines[f]);
                if (html) fallback += html;
            }
            return fallback || escapeHtml(text);
        }

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
        var sections = parseEnvSections(text);
        var html = '<div class="env-impact-layout">';

        // Try to extract key data
        var identification = findEnvSection(sections, 'identification');
        var decomposition = extractDecomposition(text);

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

        // Row 2: Impact images (land/water/wildlife) if they have actual content
        var landImpact = findEnvSection(sections, 'land');
        var waterImpact = findEnvSection(sections, 'water');
        var wildlifeImpact = findEnvSection(sections, 'wildlife');

        // Only show cards that have actual bullet content
        var impactCards = [];
        if (landImpact && landImpact.bullets.length > 0) impactCards.push({ data: landImpact, img: 'images/landfill.jpg', alt: 'Land impact', title: 'Land Impact' });
        if (waterImpact && waterImpact.bullets.length > 0) impactCards.push({ data: waterImpact, img: 'images/water.jpeg', alt: 'Water impact', title: 'Water Impact' });
        if (wildlifeImpact && wildlifeImpact.bullets.length > 0) impactCards.push({ data: wildlifeImpact, img: 'images/wildlife.jpg', alt: 'Wildlife impact', title: 'Wildlife Impact' });

        if (impactCards.length > 0) {
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">Environmental Impact</div>';
            html += '<div class="env-impact-grid">';

            for (var ic = 0; ic < impactCards.length; ic++) {
                var card = impactCards[ic];
                html += '<div class="env-impact-card">';
                html += '<img src="' + card.img + '" alt="' + card.alt + '" class="env-impact-img">';
                html += '<div class="env-impact-card-title">' + card.title + '</div>';
                html += '<ul class="env-list-sm">';
                for (var cb = 0; cb < card.data.bullets.length; cb++) {
                    html += '<li>' + escapeHtml(card.data.bullets[cb]) + '</li>';
                }
                html += '</ul>';
                html += '</div>';
            }

            html += '</div>';
            html += '</div>';
        }

        // Remaining sections: simple text cards with nested sub-headings
        var handledTitles = [];
        if (identification) handledTitles.push(identification.title);
        if (landImpact) handledTitles.push(landImpact.title);
        if (waterImpact) handledTitles.push(waterImpact.title);
        if (wildlifeImpact) handledTitles.push(wildlifeImpact.title);

        for (var si = 0; si < sections.length; si++) {
            if (handledTitles.indexOf(sections[si].title) !== -1) continue;
            if (sections[si].bullets.length === 0) continue;
            html += '<div class="env-section-block">';
            html += '<div class="env-section-heading">' + escapeHtml(sections[si].title) + '</div>';
            html += renderNestedBullets(sections[si].bullets);
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    // Render bullets with nested sub-headings (items ending with :* or numbered items become bold parents)
    function renderNestedBullets(bullets) {
        var html = '';
        var i = 0;

        // First check if there's a markdown table in the bullets
        var tableStart = -1;
        for (var t = 0; t < bullets.length; t++) {
            if (bullets[t].indexOf('|') !== -1 && bullets[t].trim().startsWith('|')) {
                tableStart = t;
                break;
            }
        }

        // Render any bullets before the table
        var preBullets = tableStart === -1 ? bullets : bullets.slice(0, tableStart);
        var postBullets = tableStart === -1 ? [] : bullets.slice(tableStart);

        if (preBullets.length > 0) {
            html += renderNestedList(preBullets);
        }

        // Render markdown table if found
        if (postBullets.length > 0) {
            var tableRows = [];
            var afterTable = [];
            var inTable = true;
            for (var tb = 0; tb < postBullets.length; tb++) {
                var row = postBullets[tb].trim();
                if (inTable && row.indexOf('|') !== -1 && row.startsWith('|')) {
                    // Skip separator rows like |---|---|
                    if (/^\|[\s\-:|]+\|$/.test(row)) continue;
                    tableRows.push(row);
                } else {
                    inTable = false;
                    afterTable.push(postBullets[tb]);
                }
            }

            if (tableRows.length > 0) {
                html += '<table class="env-table">';
                for (var tr = 0; tr < tableRows.length; tr++) {
                    var cells = tableRows[tr].split('|').filter(function(c) { return c.trim() !== ''; });
                    var tag = tr === 0 ? 'th' : 'td';
                    html += '<tr>';
                    for (var tc = 0; tc < cells.length; tc++) {
                        html += '<' + tag + '>' + escapeHtml(cells[tc].trim()) + '</' + tag + '>';
                    }
                    html += '</tr>';
                }
                html += '</table>';
            }

            if (afterTable.length > 0) {
                html += renderNestedList(afterTable);
            }
        }

        return html;
    }

    // Render a list with parent/child nesting
    function renderNestedList(bullets) {
        var html = '<ul class="env-list">';
        var i = 0;
        while (i < bullets.length) {
            var bullet = bullets[i];

            // Check if this bullet ends with :* (sub-heading)
            var isColonParent = /:\s*\*?\s*$/.test(bullet);

            // Check if this is a numbered parent — only if next item is NOT numbered
            var isNumberedParent = false;
            if (/^\d+\.\s+[A-Z]/.test(bullet)) {
                // Look ahead: if next bullet exists and is NOT numbered, this is a parent
                var nextIdx = i + 1;
                if (nextIdx < bullets.length && !/^\d+\.\s/.test(bullets[nextIdx])) {
                    isNumberedParent = true;
                }
            }

            if (isNumberedParent || isColonParent) {
                var label = bullet;
                if (isColonParent) {
                    label = bullet.replace(/:\s*\*?\s*$/, '');
                }
                html += '<li><strong>' + escapeHtml(label) + '</strong>';

                // Collect child bullets until next parent
                var children = [];
                i++;
                while (i < bullets.length) {
                    var next = bullets[i];
                    // Stop if we hit another numbered parent or colon parent
                    if (/^\d+\.\s+[A-Z]/.test(next)) break;
                    if (/:\s*\*?\s*$/.test(next)) break;
                    children.push(next);
                    i++;
                }
                if (children.length > 0) {
                    html += '<ul class="env-list-nested">';
                    for (var c = 0; c < children.length; c++) {
                        html += '<li>' + escapeHtml(children[c]) + '</li>';
                    }
                    html += '</ul>';
                }
                html += '</li>';
            } else {
                html += '<li>' + escapeHtml(bullet) + '</li>';
                i++;
            }
        }
        html += '</ul>';
        return html;
    }

    // Parse env impact text into sections, handling nested sub-headings like "Land Degradation:*"
    function parseEnvSections(text) {
        var lines = text.split('\n');
        var sections = [];
        var currentSection = null;
        // Keywords that indicate a top-level environmental sub-section to split on
        var splitKeywords = ['land', 'water', 'wildlife'];

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            if (/^-{2,}$/.test(line)) continue;

            // Markdown headers always start new sections
            if (line.startsWith('#')) {
                if (currentSection) sections.push(currentSection);
                currentSection = {
                    title: cleanMarkdown(line.replace(/^#+\s*/, '')),
                    bullets: []
                };
                continue;
            }

            // Check if it's a bullet
            var isBullet = /^[\-\*•]/.test(line);
            var bulletText = isBullet ? line.replace(/^[\-\*•]\s*/, '').trim() : line;

            // Check if this bullet is a top-level split keyword (like "Land Degradation:*")
            if (isBullet && /^[A-Z]/.test(bulletText) && /:\s*\*?\s*$/.test(bulletText)) {
                var label = bulletText.replace(/:\s*\*?\s*$/, '').toLowerCase();
                var shouldSplit = false;
                for (var k = 0; k < splitKeywords.length; k++) {
                    if (label.indexOf(splitKeywords[k]) !== -1) {
                        shouldSplit = true;
                        break;
                    }
                }
                if (shouldSplit) {
                    if (currentSection) sections.push(currentSection);
                    currentSection = {
                        title: cleanMarkdown(bulletText.replace(/:\s*\*?\s*$/, '')),
                        bullets: []
                    };
                    continue;
                }
            }

            // Regular content — add to current section
            if (!currentSection) {
                currentSection = { title: 'Details', bullets: [] };
            }

            if (isBullet) {
                var cleaned = cleanMarkdown(bulletText);
                if (cleaned && cleaned !== '--' && cleaned !== '-') {
                    currentSection.bullets.push(cleaned);
                }
            } else {
                var cleanedLine = cleanMarkdown(line);
                if (cleanedLine) currentSection.bullets.push(cleanedLine);
            }
        }
        if (currentSection) sections.push(currentSection);
        return sections;
    }

    function findEnvSection(sections, keyword) {
        for (var i = 0; i < sections.length; i++) {
            if (sections[i].title.toLowerCase().indexOf(keyword) !== -1) {
                return sections[i];
            }
        }
        return null;
    }

    function findSection(sections, keyword) {
        for (var i = 0; i < sections.length; i++) {
            if (sections[i].title.toLowerCase().indexOf(keyword) !== -1) {
                return sections[i];
            }
        }
        return null;
    }

    function cleanMarkdown(text) {
        // Remove ** bold markers
        text = text.replace(/\*\*(.+?)\*\*/g, '$1');
        // Remove * italic markers
        text = text.replace(/\*(.+?)\*/g, '$1');
        // Remove standalone -- or ---
        text = text.replace(/^-{2,}$/g, '').trim();
        return text;
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

            // Skip standalone dashes
            if (/^-{2,}$/.test(line)) continue;

            if (line.startsWith('##') || line.startsWith('# ')) {
                if (currentSection) sections.push(currentSection);
                currentSection = {
                    title: cleanMarkdown(line.replace(/^#+\s*/, '')),
                    bullets: []
                };
            } else if (line.startsWith('-') || line.startsWith('*') || line.startsWith('•')) {
                if (!currentSection) {
                    currentSection = { title: 'Details', bullets: [] };
                }
                var bullet = cleanMarkdown(line.replace(/^[\-\*•]\s*/, ''));
                if (bullet && bullet !== '--' && bullet !== '-') {
                    currentSection.bullets.push(bullet);
                }
            } else if (line.indexOf(':') > 0 && currentSection) {
                currentSection.bullets.push(cleanMarkdown(line));
            } else if (currentSection) {
                currentSection.bullets.push(cleanMarkdown(line));
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
