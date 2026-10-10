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

    // --- Rendering: Waste Details as Table (fixed JSON schema) ---
    // Fields rendered, in display order, with human-readable labels.
    var WASTE_DETAIL_FIELDS = [
        { key: 'category', label: 'Category' },
        { key: 'confidence_level', label: 'Confidence Level' },
        { key: 'description', label: 'Description' },
        { key: 'estimated_weight', label: 'Estimated Weight' },
        { key: 'recyclability', label: 'Recyclability' },
        { key: 'material_composition', label: 'Material Composition' }
    ];

    function renderWasteDetailsTable(data) {
        // Accept either a parsed object or a raw JSON string.
        var obj = data;
        if (typeof data === 'string') {
            try {
                obj = JSON.parse(data);
            } catch (e) {
                obj = {};
            }
        }
        if (!obj || typeof obj !== 'object') obj = {};

        var html = '<table class="waste-table">';
        for (var i = 0; i < WASTE_DETAIL_FIELDS.length; i++) {
            var field = WASTE_DETAIL_FIELDS[i];
            var value = obj[field.key];
            if (value === undefined || value === null || String(value).trim() === '') {
                value = 'N/A';
            }
            html += '<tr><td>' + escapeHtml(field.label) + '</td><td>' +
                    escapeHtml(String(value)) + '</td></tr>';
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
    // Fixed flip-card config: key -> label, icon, color theme, and back-face image.
    // Only three images exist; each is reused for the most thematically related cards.
    // Each card has a themed background image shown on its flip-back.
    var ENV_CARDS = [
        { key: 'land_impact',          title: 'Land Impact',     icon: 'fa-mountain-sun',   theme: 'orange', img: 'images/landfill.jpg' },
        { key: 'water_impact',         title: 'Water Impact',    icon: 'fa-droplet',        theme: 'teal',   img: 'images/water.jpeg' },
        { key: 'wildlife_impact',      title: 'Wildlife Impact', icon: 'fa-paw',            theme: 'purple', img: 'images/wildlife.jpg' },
        { key: 'climate_impact',       title: 'Climate Impact',  icon: 'fa-earth-asia',     theme: 'teal',   img: 'images/climate.jpg' },
        { key: 'health_impact',        title: 'Health Impact',   icon: 'fa-heart-pulse',    theme: 'purple', img: 'images/health.jpg' },
        { key: 'recycle_value',        title: 'Circular Value',  icon: 'fa-recycle',        theme: 'orange', img: 'images/recycle.png' },
        { key: 'future_impact',        title: 'Future Impact',   icon: 'fa-hourglass-half', theme: 'purple', img: 'images/future.jpg' },
        { key: 'best_practices',       title: 'Best Practices',  icon: 'fa-lightbulb',      theme: 'orange', img: 'images/best.png' },
        { key: 'educational_insights', title: 'Edu Insights',    icon: 'fa-book-open',      theme: 'teal',   img: 'images/education.jpg' }
    ];

    function envSectionData(obj, key) {
        var s = obj[key];
        if (!s || typeof s !== 'object') s = {};
        var details = Array.isArray(s.details) ? s.details : [];
        return { summary: s.summary || '', details: details };
    }

    // Build the Environmental Impacts tab from the fixed JSON schema.
    function renderEnvironmentalImpact(data) {
        var obj = data;
        if (typeof data === 'string') {
            try { obj = JSON.parse(data); } catch (e) { obj = {}; }
        }
        if (!obj || typeof obj !== 'object') obj = {};

        var wi = (obj.waste_identification && typeof obj.waste_identification === 'object')
            ? obj.waste_identification : {};
        var decomposition = obj.estimated_decomposition_time || 'N/A';
        var landfillPct = (typeof obj.landfill_percentage === 'number') ? obj.landfill_percentage : null;
        var landfillNote = obj.landfill_percentage_note || '';

        var html = '<div class="env-layout">';

        // --- Top row: identification + decomposition + landfill gauge ---
        html += '<div class="env-top">';

        // Identification card
        html += '<div class="env-id-card">';
        html += '<div class="env-id-title">Waste Item Identification</div>';
        html += '<ul class="env-id-list">';
        html += '<li><span>Item Type</span><strong>' + escapeHtml(wi.item_type || 'N/A') + '</strong></li>';
        html += '<li><span>Material</span><strong>' + escapeHtml(wi.material || 'N/A') + '</strong></li>';
        html += '<li><span>Hazard Level</span><strong>' + escapeHtml(wi.hazard_level || 'N/A') + '</strong></li>';
        html += '</ul>';
        html += '</div>';

        // Right column: decomposition + gauge stacked
        html += '<div class="env-top-right">';
        html += '<div class="env-decomp-card">';
        html += '<div class="env-decomp-title">Estimated Decomposition Time</div>';
        html += '<div class="env-decomp-value">' + escapeHtml(decomposition) + '</div>';
        html += '</div>';

        html += '<div class="env-gauge-card">';
        html += '<div class="env-gauge-label">Percentage of same type of waste on landfill</div>';
        if (landfillPct !== null) {
            html += '<div class="env-gauge" style="--pct:' + landfillPct + '">';
            html += '<div class="env-gauge-center">' + landfillPct + '%</div>';
            html += '</div>';
        } else {
            html += '<div class="env-gauge-na">N/A</div>';
        }
        if (landfillNote) {
            html += '<div class="env-gauge-note">' + escapeHtml(landfillNote) + '</div>';
        }
        html += '</div>';
        html += '</div>';  // env-top-right

        html += '</div>';  // env-top

        // --- Flip cards grid ---
        html += '<div class="env-cards-heading">Environmental Impact ' +
                '<span class="env-cards-hint">(click a card to flip)</span></div>';
        html += '<div class="env-cards-grid">';
        for (var i = 0; i < ENV_CARDS.length; i++) {
            var cfg = ENV_CARDS[i];
            var sec = envSectionData(obj, cfg.key);

            var backHtml = '';
            if (sec.summary) {
                backHtml += '<div class="env-card-summary">' + escapeHtml(sec.summary) + '</div>';
            }
            if (sec.details.length) {
                backHtml += '<ul class="env-card-details">';
                for (var d = 0; d < sec.details.length; d++) {
                    backHtml += '<li>' + escapeHtml(sec.details[d]) + '</li>';
                }
                backHtml += '</ul>';
            }
            if (!backHtml) backHtml = '<div class="env-card-summary">No data available.</div>';

            html += '<div class="env-flip-card theme-' + cfg.theme + '" tabindex="0" role="button" ' +
                    'aria-label="' + escapeHtml(cfg.title) + ' — click to flip">';
            html += '<div class="env-flip-inner">';
            // Front
            html += '<div class="env-flip-front">';
            html += '<div class="env-card-icon"><i class="fa-solid ' + cfg.icon + '"></i></div>';
            html += '<div class="env-card-title">' + escapeHtml(cfg.title) + '</div>';
            html += '</div>';
            // Back
            html += '<div class="env-flip-back">';
            html += '<div class="env-flip-back-header" style="background-image:url(\'' + cfg.img + '\')">';
            html += '<span class="env-flip-back-title">' + escapeHtml(cfg.title) + '</span>';
            html += '</div>';
            html += '<div class="env-flip-back-body">';
            html += backHtml;
            html += '</div>';
            html += '</div>';
            html += '</div></div>';
        }
        html += '</div>';  // env-cards-grid

        html += '</div>';  // env-layout
        return html;
    }

    // Fetch the environmental impact JSON and render the cards. Returns a promise.
    function loadEnvironmentalImpact(payload) {
        var panel = document.getElementById('environmentalImpactPanel');
        panel.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>' +
            '<div class="loading-text">Assessing environmental impact...</div></div>';

        return fetch(STREAM_URLS.environmental_impact, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(function(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.text();
        }).then(function(text) {
            if (isRejectedResponse(text)) {
                // Validation handled by waste_details; just clear here.
                panel.innerHTML = '<div class="placeholder-text">Not available for this item.</div>';
                return;
            }
            var parsed;
            try { parsed = JSON.parse(text); }
            catch (e) {
                panel.innerHTML = '<div class="error-message">\u26a0\ufe0f Could not read impact result.</div>';
                return;
            }
            panel.innerHTML = renderEnvironmentalImpact(parsed);
            bindEnvFlipCards(panel);
        }).catch(function(err) {
            panel.innerHTML = '<div class="error-message">\u26a0\ufe0f Error: ' + escapeHtml(err.message) + '</div>';
        });
    }

    // Wire click/keyboard flipping on the env cards within a container.
    function bindEnvFlipCards(container) {
        var cards = container.querySelectorAll('.env-flip-card');
        for (var i = 0; i < cards.length; i++) {
            cards[i].addEventListener('click', function() {
                this.classList.toggle('flipped');
            });
            cards[i].addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.classList.toggle('flipped');
                }
            });
        }
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

                        // Check for rejection message
                        if (fullText.indexOf('\u26a0\ufe0f') === 0 && fullText.indexOf('not suitable') !== -1) {
                            showInvalidPopup();
                            panel.innerHTML = '';
                            document.getElementById('outputSection').hidden = true;
                            return;
                        }

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

        runAllBtn.disabled = true;
        runAllBtn.textContent = '\u23f3 Analyzing...';

        // Reveal the output section on the Waste Details tab and show a spinner
        // right away so there's visible feedback while the request is in flight.
        document.getElementById('outputSection').hidden = false;
        activateTab('wasteDetailsPanel');
        document.getElementById('wasteDetailsPanel').innerHTML =
            '<div class="loading-spinner"><div class="spinner"></div>' +
            '<div class="loading-text">Analyzing waste details...</div></div>';

        var baseBody = {
            file_data: fileData,
            file_mime: fileMime,
            description: descriptionInput.value.trim(),
        };

        // First call waste_details — it does validation
        // Read full response to check if rejected before showing output
        fetch(STREAM_URLS.waste_details, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(baseBody),
        }).then(function(response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.text();
        }).then(function(wasteDetailsText) {
            // Check for rejection (reject message is plain text, not JSON)
            if (isRejectedResponse(wasteDetailsText)) {
                showInvalidPopup();
                document.getElementById('wasteDetailsPanel').innerHTML =
                    '<div class="placeholder-text">Upload an image and click Analyze to see results</div>';
                document.getElementById('outputSection').hidden = true;
                runAllBtn.disabled = false;
                runAllBtn.textContent = '\ud83d\udd0d Analyze Waste';
                return;
            }

            // Parse the fixed JSON schema returned by the lambda.
            var wasteDetailsData;
            try {
                wasteDetailsData = JSON.parse(wasteDetailsText);
            } catch (e) {
                document.getElementById('outputSection').hidden = false;
                document.getElementById('wasteDetailsPanel').innerHTML =
                    '<div class="error-message">\u26a0\ufe0f Could not read analysis result.</div>';
                runAllBtn.disabled = false;
                runAllBtn.textContent = '\ud83d\udd0d Analyze Waste';
                return;
            }

            // Valid — show output section and render waste details
            document.getElementById('outputSection').hidden = false;
            var wastePanel = document.getElementById('wasteDetailsPanel');
            wastePanel.innerHTML = renderWasteDetailsTable(wasteDetailsData);

            // Kick off the nearby-facilities lookup (renders its own map + list).
            loadNearbyFacilities({
                file_data: fileData,
                file_mime: fileMime,
                description: descriptionInput.value.trim(),
                location: locationInput.value.trim(),
            });

            // Now run further_actions (streamed) and environmental_impact (JSON)
            var promises = [
                streamToPanel(STREAM_URLS.further_actions, {
                    file_data: fileData,
                    file_mime: fileMime,
                    description: descriptionInput.value.trim(),
                    location: locationInput.value.trim(),
                }, 'furtherActionsPanel', renderFurtherActions),
                loadEnvironmentalImpact(baseBody),
            ];

            Promise.all(promises.map(function(p) { return p.catch(function() {}); })).then(function() {
                runAllBtn.disabled = false;
                runAllBtn.textContent = '\ud83d\udd0d Analyze Waste';
            });
        }).catch(function(err) {
            document.getElementById('outputSection').hidden = false;
            document.getElementById('wasteDetailsPanel').innerHTML = '<div class="error-message">\u26a0\ufe0f Error: ' + err.message + '</div>';
            runAllBtn.disabled = false;
            runAllBtn.textContent = '\ud83d\udd0d Analyze Waste';
        });
    });

    // --- Tab switching ---
    var tabButtons = document.querySelectorAll('.tab-btn');

    function activateTab(targetId) {
        // Toggle button active state
        for (var i = 0; i < tabButtons.length; i++) {
            var isActive = tabButtons[i].getAttribute('data-tab') === targetId;
            tabButtons[i].classList.toggle('active', isActive);
            tabButtons[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
        }

        // Toggle panel visibility
        var panels = document.querySelectorAll('.tab-panel');
        for (var p = 0; p < panels.length; p++) {
            var panelContent = panels[p].querySelector('.output-panel');
            var matches = panelContent && panelContent.id === targetId;
            panels[p].hidden = !matches;
            panels[p].classList.toggle('active', matches);
        }

        // MapLibre renders at zero size inside a hidden tab; recalc when the
        // Future Actions tab (which hosts the map) becomes visible.
        if (targetId === 'furtherActionsPanel' && facilitiesMap) {
            setTimeout(function() { facilitiesMap.resize(); }, 50);
        }
    }

    for (var tb = 0; tb < tabButtons.length; tb++) {
        tabButtons[tb].addEventListener('click', function() {
            activateTab(this.getAttribute('data-tab'));
        });
    }

    // --- Chat Toggle ---
    var chatFab = document.getElementById('chatFab');
    var chatPopup = document.getElementById('chatPopup');
    var chatPopupClose = document.getElementById('chatPopupClose');
    var chatBubbleHint = document.getElementById('chatBubbleHint');
    var closeBubbleHint = document.getElementById('closeBubbleHint');
    var chatHeaderBtn = document.getElementById('chatHeaderBtn');

    chatFab.addEventListener('click', function() {
        chatPopup.classList.toggle('open');
        chatBubbleHint.classList.add('hidden');
    });

    if (chatHeaderBtn) {
        chatHeaderBtn.addEventListener('click', function() {
            chatPopup.classList.toggle('open');
            chatBubbleHint.classList.add('hidden');
        });
    }

    // --- Auth Modal (Login / Sign Up) ---
    var authOverlay = document.getElementById('authOverlay');
    var authClose = document.getElementById('authClose');
    var loginBtn = document.getElementById('loginBtn');
    var signupBtn = document.getElementById('signupBtn');
    var authForm = document.getElementById('authForm');
    var authTitle = document.getElementById('authTitle');
    var authSubtitle = document.getElementById('authSubtitle');
    var authSubmit = document.getElementById('authSubmit');
    var authSwitchText = document.getElementById('authSwitchText');
    var authSwitchBtn = document.getElementById('authSwitchBtn');
    var nameField = document.getElementById('nameField');
    var confirmField = document.getElementById('confirmField');
    var authError = document.getElementById('authError');
    var authEmail = document.getElementById('authEmail');
    var authPassword = document.getElementById('authPassword');
    var authName = document.getElementById('authName');
    var authConfirm = document.getElementById('authConfirm');

    var authMode = 'login'; // 'login' | 'signup'

    function setAuthMode(mode) {
        authMode = mode;
        var isSignup = mode === 'signup';

        authTitle.textContent = isSignup ? 'Create account' : 'Welcome back';
        authSubtitle.textContent = isSignup
            ? 'Sign up for a SmartWaste account'
            : 'Log in to your SmartWaste account';
        authSubmit.textContent = isSignup ? 'Sign Up' : 'Login';
        authSwitchText.textContent = isSignup
            ? 'Already have an account?'
            : "Don't have an account?";
        authSwitchBtn.textContent = isSignup ? 'Login' : 'Sign Up';

        nameField.hidden = !isSignup;
        confirmField.hidden = !isSignup;
        authName.required = isSignup;
        authConfirm.required = isSignup;
        authPassword.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');

        hideAuthError();
    }

    function openAuth(mode) {
        setAuthMode(mode);
        authOverlay.classList.add('show');
        setTimeout(function() { authEmail.focus(); }, 50);
    }

    function closeAuth() {
        authOverlay.classList.remove('show');
        authForm.reset();
        hideAuthError();
    }

    function showAuthError(msg) {
        authError.textContent = msg;
        authError.hidden = false;
    }

    function hideAuthError() {
        authError.hidden = true;
        authError.textContent = '';
    }

    if (loginBtn) loginBtn.addEventListener('click', function() { openAuth('login'); });
    if (signupBtn) signupBtn.addEventListener('click', function() { openAuth('signup'); });
    if (authClose) authClose.addEventListener('click', closeAuth);

    authOverlay.addEventListener('click', function(e) {
        if (e.target === authOverlay) closeAuth();
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && authOverlay.classList.contains('show')) {
            closeAuth();
        }
    });

    authSwitchBtn.addEventListener('click', function() {
        setAuthMode(authMode === 'login' ? 'signup' : 'login');
    });

    authForm.addEventListener('submit', function(e) {
        e.preventDefault();
        hideAuthError();

        var email = authEmail.value.trim();
        var password = authPassword.value;

        if (!email || !password) {
            showAuthError('Please enter your email and password.');
            return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            showAuthError('Please enter a valid email address.');
            return;
        }
        if (password.length < 6) {
            showAuthError('Password must be at least 6 characters.');
            return;
        }

        if (authMode === 'signup') {
            if (!authName.value.trim()) {
                showAuthError('Please enter your full name.');
                return;
            }
            if (password !== authConfirm.value) {
                showAuthError('Passwords do not match.');
                return;
            }
        }

        // No auth backend yet — acknowledge and close.
        authSubmit.disabled = true;
        authSubmit.textContent = authMode === 'signup' ? 'Signing up...' : 'Logging in...';
        setTimeout(function() {
            authSubmit.disabled = false;
            setAuthMode(authMode);
            closeAuth();
            alert(authMode === 'signup'
                ? 'Account created! (demo — no backend connected yet)'
                : 'Logged in! (demo — no backend connected yet)');
        }, 600);
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
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // === Nearby Facilities: map + list ===
    var facilitiesMap = null;        // MapLibre GL map instance
    var facilityMarkers = [];        // MapLibre markers, index-aligned with list items
    var facilityItemEls = [];        // list <li> elements, index-aligned with markers

    function loadNearbyFacilities(payload) {
        var block = document.getElementById('facilitiesBlock');
        var listEl = document.getElementById('facilitiesList');
        var subheading = document.getElementById('facilitiesSubheading');
        var mapLoading = document.getElementById('facilitiesMapLoading');

        if (!block) return;

        // Reset state and show the block with a loading map.
        block.hidden = false;
        if (mapLoading) mapLoading.hidden = false;
        listEl.innerHTML = '';
        subheading.textContent = 'Searching for nearby facilities...';

        if (!STREAM_URLS.nearby_facilities || STREAM_URLS.nearby_facilities.indexOf('__URL_') === 0) {
            // URL not injected (e.g. local preview) — hide gracefully.
            block.hidden = true;
            return;
        }

        fetch(STREAM_URLS.nearby_facilities, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(function(response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        }).then(function(data) {
            if (mapLoading) mapLoading.hidden = true;
            renderFacilities(data);
        }).catch(function(err) {
            if (mapLoading) mapLoading.hidden = true;
            subheading.textContent = '';
            listEl.innerHTML = '<div class="error-message">\u26a0\ufe0f Could not load nearby facilities: ' +
                escapeHtml(err.message) + '</div>';
        });
    }

    function renderFacilities(data) {
        var listEl = document.getElementById('facilitiesList');
        var subheading = document.getElementById('facilitiesSubheading');

        var center = (data && data.center) || { lat: 3.139, lng: 101.6869, label: 'Malaysia' };
        var facilities = (data && Array.isArray(data.facilities)) ? data.facilities : [];
        var locationProvided = !!(data && data.location_provided);

        if (locationProvided) {
            subheading.className = 'facilities-subheading hint-located';
            subheading.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> ' +
                'Showing nearby stations based on your location' +
                (center.label ? ' (' + escapeHtml(center.label) + ')' : '') + '.';
        } else {
            subheading.className = 'facilities-subheading hint-default';
            var reason = data && data.fallback_reason;
            var msg;
            if (reason === 'geocode_failed') {
                msg = 'We couldn\'t pinpoint that location, so these are common recycling ' +
                    'stations in Malaysia. Try a more specific location (e.g. city or area).';
            } else if (reason === 'no_results') {
                msg = 'No facilities found right near you, so these are common recycling ' +
                    'stations in Malaysia.';
            } else {
                msg = 'No location provided, so these are common recycling stations in Malaysia. ' +
                    'Enter your location above and re-analyze to see stations near you.';
            }
            subheading.innerHTML = '<i class="fa-solid fa-circle-info"></i> ' + msg;
        }

        // --- Map ---
        initFacilitiesMap(center, facilities);

        // --- List ---
        listEl.innerHTML = '';
        facilityItemEls = [];

        if (facilities.length === 0) {
            listEl.innerHTML = '<div class="placeholder-text">No facilities found.</div>';
            return;
        }

        for (var i = 0; i < facilities.length; i++) {
            (function(index) {
                var f = facilities[index];
                var li = document.createElement('li');
                li.className = 'facility-item';
                li.setAttribute('data-index', index);

                // Icon
                var icon = document.createElement('div');
                icon.className = 'facility-icon';
                icon.innerHTML = '<i class="fa-solid fa-recycle"></i>';
                li.appendChild(icon);

                // Body (name, meta, type tags)
                var body = document.createElement('div');
                body.className = 'facility-body';

                var types = Array.isArray(f.waste_types) ? f.waste_types : [];
                var distanceText = f.distance && String(f.distance).trim()
                    ? String(f.distance).trim()
                    : 'Unavailable';

                var metaParts = '<span class="facility-distance">' + escapeHtml(distanceText) + '</span>';
                if (f.address) {
                    metaParts += '<span class="dot">\u2022</span><span>' + escapeHtml(f.address) + '</span>';
                }

                var tagsHtml = '';
                if (types.length) {
                    tagsHtml = '<div class="facility-types">';
                    for (var t = 0; t < types.length; t++) {
                        tagsHtml += '<span class="facility-type-tag">' + escapeHtml(types[t]) + '</span>';
                    }
                    tagsHtml += '</div>';
                }

                var email = f.email && String(f.email).trim() ? String(f.email).trim() : '';
                var phone = f.phone && String(f.phone).trim() ? String(f.phone).trim() : '';
                var isGeneralLine = !!f.general_line;

                // Surface the raw contact text in the card body so the info is
                // always visible/copyable, and note general enquiry lines.
                var contactTextHtml = '';
                if (email || phone) {
                    contactTextHtml = '<div class="facility-contact-text">';
                    if (phone) {
                        contactTextHtml += '<span><i class="fa-solid fa-phone"></i> ' + escapeHtml(phone) +
                            (isGeneralLine ? ' <em class="contact-note">(general enquiry line)</em>' : '') + '</span>';
                    }
                    if (email) {
                        contactTextHtml += '<span><i class="fa-solid fa-envelope"></i> ' + escapeHtml(email) + '</span>';
                    }
                    contactTextHtml += '</div>';
                }

                body.innerHTML =
                    '<div class="facility-name">' + escapeHtml(f.name || 'Unknown facility') + '</div>' +
                    '<div class="facility-meta">' + metaParts + '</div>' +
                    tagsHtml +
                    contactTextHtml;
                li.appendChild(body);

                // Contacts (email / phone) action buttons — clickable on any device.
                var contacts = document.createElement('div');
                contacts.className = 'facility-contacts';

                var emailBtn = buildContactButton('email', email);
                var phoneBtn = buildContactButton('phone', phone);
                contacts.appendChild(emailBtn);
                contacts.appendChild(phoneBtn);
                li.appendChild(contacts);

                // Click the item (but not a contact button) focuses it on the map.
                li.addEventListener('click', function(e) {
                    if (e.target.closest('.contact-btn')) return;
                    focusFacility(index);
                });

                listEl.appendChild(li);
                facilityItemEls.push(li);
            })(i);
        }
    }

    // Build an email or phone button. Clickable on any device when a value
    // exists (mailto: opens a compose window; tel: starts a call on phones).
    // When no value exists, renders disabled and labeled "not listed".
    function buildContactButton(kind, value) {
        var hasValue = !!(value && String(value).trim());
        var iconClass = kind === 'email' ? 'fa-envelope' : 'fa-phone';
        var label = kind === 'email' ? 'Email' : 'Call';

        if (hasValue) {
            var a = document.createElement('a');
            a.className = 'contact-btn';
            a.href = (kind === 'email' ? 'mailto:' : 'tel:') + String(value).trim();
            a.title = label + ': ' + String(value).trim();
            a.setAttribute('aria-label', label + ' ' + String(value).trim());
            a.innerHTML = '<i class="fa-solid ' + iconClass + '"></i>';
            // Don't trigger the list-item map focus when using a contact button.
            a.addEventListener('click', function(e) { e.stopPropagation(); });
            return a;
        }

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'contact-btn disabled';
        btn.disabled = true;
        btn.setAttribute('aria-label', label + ' not listed');
        btn.title = label + ' not listed';
        btn.innerHTML = '<i class="fa-solid ' + iconClass + '"></i>';
        return btn;
    }

    function amazonLocationStyleUrl() {
        // Amazon Location Maps v2 standalone style descriptor (managed "Standard"
        // style), authenticated with the browser API key.
        return 'https://maps.geo.' + MAP_CONFIG.region +
            '.amazonaws.com/v2/styles/Standard/descriptor?key=' +
            encodeURIComponent(MAP_CONFIG.apiKey) + '&color-scheme=Light';
    }

    function initFacilitiesMap(center, facilities) {
        if (typeof maplibregl === 'undefined') {
            // MapLibre not loaded yet; retry shortly.
            setTimeout(function() { initFacilitiesMap(center, facilities); }, 200);
            return;
        }

        var mapEl = document.getElementById('facilitiesMap');
        if (!mapEl) return;

        // Guard: map config must be injected (not available in local preview).
        if (!MAP_CONFIG.apiKey || MAP_CONFIG.apiKey.indexOf('__MAP_') === 0 ||
            !MAP_CONFIG.region || MAP_CONFIG.region.indexOf('__AWS_') === 0) {
            mapEl.innerHTML = '<div class="placeholder-text">Map unavailable in preview.</div>';
            return;
        }

        // Create the map once; reuse it on subsequent analyses.
        if (!facilitiesMap) {
            facilitiesMap = new maplibregl.Map({
                container: mapEl,
                style: amazonLocationStyleUrl(),
                center: [center.lng, center.lat],
                zoom: 11,
            });
            facilitiesMap.addControl(new maplibregl.NavigationControl(), 'top-right');
            facilitiesMap.scrollZoom.disable();
        }

        // Clear previous markers.
        for (var m = 0; m < facilityMarkers.length; m++) {
            facilityMarkers[m].remove();
        }
        facilityMarkers = [];

        function addMarkers() {
            var bounds = null;
            for (var i = 0; i < facilities.length; i++) {
                (function(index) {
                    var f = facilities[index];
                    if (typeof f.lat !== 'number' || typeof f.lng !== 'number') return;

                    var distanceText = f.distance && String(f.distance).trim()
                        ? String(f.distance).trim() : 'Unavailable';
                    var popup = new maplibregl.Popup({ offset: 25 }).setHTML(
                        '<strong>' + escapeHtml(f.name || 'Facility') + '</strong><br>' +
                        escapeHtml(Array.isArray(f.waste_types) ? f.waste_types.join(', ') : '') + '<br>' +
                        'Distance: ' + escapeHtml(distanceText)
                    );

                    var marker = new maplibregl.Marker({ color: '#2e7d32' })
                        .setLngLat([f.lng, f.lat])
                        .setPopup(popup)
                        .addTo(facilitiesMap);

                    marker.getElement().style.cursor = 'pointer';
                    marker.getElement().addEventListener('click', function() {
                        focusFacility(index, true);
                    });

                    facilityMarkers.push(marker);

                    if (!bounds) {
                        bounds = new maplibregl.LngLatBounds([f.lng, f.lat], [f.lng, f.lat]);
                    } else {
                        bounds.extend([f.lng, f.lat]);
                    }
                })(i);
            }

            // Fit to all markers, or center on the provided point.
            if (bounds && facilityMarkers.length > 1) {
                facilitiesMap.fitBounds(bounds, { padding: 50, maxZoom: 15 });
            } else if (facilityMarkers.length === 1) {
                facilitiesMap.setCenter([facilities[0].lng, facilities[0].lat]);
                facilitiesMap.setZoom(14);
            } else {
                facilitiesMap.setCenter([center.lng, center.lat]);
                facilitiesMap.setZoom(11);
            }
        }

        // Markers can only be added once the style has loaded.
        if (facilitiesMap.isStyleLoaded()) {
            addMarkers();
        } else {
            facilitiesMap.once('load', addMarkers);
        }

        // Recalculate size (map lives inside a tab that may have been hidden).
        setTimeout(function() { facilitiesMap.resize(); }, 100);
    }

    // Highlight a facility: pan the map, open its popup, and mark the list item.
    function focusFacility(index, fromMarker) {
        for (var i = 0; i < facilityItemEls.length; i++) {
            facilityItemEls[i].classList.toggle('active', i === index);
        }

        var marker = facilityMarkers[index];
        if (marker && facilitiesMap) {
            var lngLat = marker.getLngLat();
            facilitiesMap.flyTo({
                center: lngLat,
                zoom: Math.max(facilitiesMap.getZoom(), 14),
            });
            // Open the popup (close others first).
            for (var p = 0; p < facilityMarkers.length; p++) {
                var pop = facilityMarkers[p].getPopup();
                if (pop && pop.isOpen() && p !== index) facilityMarkers[p].togglePopup();
            }
            if (!marker.getPopup().isOpen()) marker.togglePopup();
        }

        // When triggered from the list, scroll the item into view.
        if (!fromMarker && facilityItemEls[index]) {
            facilityItemEls[index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // --- Invalid input popup ---
    function isRejectedResponse(text) {
        var lower = text.toLowerCase();
        var rejectPhrases = [
            'not suitable',
            'not a physical waste',
            'cannot be analyzed as waste',
            'not appropriate',
            'clarification required',
            'not a waste item',
            'cannot analyze',
            'not physical waste',
            'digital icon',
            'digital graphic',
            'digital image',
            'cannot be classified as waste',
            'not related to waste',
            'inappropriate',
            'please provide an image of an actual',
            'not a genuine waste',
            'please upload',
            'cannot identify a waste item'
        ];
        for (var i = 0; i < rejectPhrases.length; i++) {
            if (lower.indexOf(rejectPhrases[i]) !== -1) return true;
        }
        return false;
    }

    function showInvalidPopup() {
        var overlay = document.getElementById('invalidOverlay');
        overlay.classList.add('show');
    }

    document.getElementById('invalidCloseBtn').addEventListener('click', function() {
        document.getElementById('invalidOverlay').classList.remove('show');
    });

    document.getElementById('invalidOverlay').addEventListener('click', function(e) {
        if (e.target === this) {
            this.classList.remove('show');
        }
    });

})();
