(function() {
    'use strict';

    // STREAM_URLS and COGNITO_CONFIG are defined in index.html (injected by CI/CD)

    // Register the Web Push service worker (progressive enhancement).
    var _swRegistration = null;
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').then(function(reg) {
            _swRegistration = reg;
        }).catch(function(e) {
            console.warn('Service worker registration failed:', e);
        });
    }

    // ===================== Cognito Auth module =====================
    // Thin wrapper around amazon-cognito-identity-js. Exposes promise-based
    // signup/confirm/login/logout plus session accessors used across the app.
    var _userPool = null;

    function userPool() {
        if (_userPool) return _userPool;
        if (typeof AmazonCognitoIdentity === 'undefined') return null;
        if (!COGNITO_CONFIG.userPoolId || COGNITO_CONFIG.userPoolId.indexOf('__COGNITO_') === 0) return null;
        _userPool = new AmazonCognitoIdentity.CognitoUserPool({
            UserPoolId: COGNITO_CONFIG.userPoolId,
            ClientId: COGNITO_CONFIG.clientId,
        });
        return _userPool;
    }

    function cognitoUser(email) {
        return new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool() });
    }

    var Auth = {
        signup: function(email, password, name) {
            return new Promise(function(resolve, reject) {
                var pool = userPool();
                if (!pool) return reject(new Error('Auth is not configured yet.'));
                var attrs = [
                    new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'email', Value: email }),
                    new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'name', Value: name }),
                ];
                pool.signUp(email, password, attrs, null, function(err, result) {
                    if (err) return reject(err);
                    resolve(result);
                });
            });
        },

        confirm: function(email, code) {
            return new Promise(function(resolve, reject) {
                cognitoUser(email).confirmRegistration(code, true, function(err, result) {
                    if (err) return reject(err);
                    resolve(result);
                });
            });
        },

        resend: function(email) {
            return new Promise(function(resolve, reject) {
                cognitoUser(email).resendConfirmationCode(function(err, result) {
                    if (err) return reject(err);
                    resolve(result);
                });
            });
        },

        login: function(email, password) {
            return new Promise(function(resolve, reject) {
                var pool = userPool();
                if (!pool) return reject(new Error('Auth is not configured yet.'));
                var user = cognitoUser(email);
                var details = new AmazonCognitoIdentity.AuthenticationDetails({
                    Username: email, Password: password,
                });
                user.authenticateUser(details, {
                    onSuccess: function(session) { resolve(session); },
                    onFailure: function(err) { reject(err); },
                });
            });
        },

        logout: function() {
            var user = userPool() && userPool().getCurrentUser();
            if (user) user.signOut();
        },

        currentUser: function() {
            return userPool() ? userPool().getCurrentUser() : null;
        },

        // Resolves the valid session (refreshing if needed) or rejects if not logged in.
        session: function() {
            return new Promise(function(resolve, reject) {
                var user = Auth.currentUser();
                if (!user) return reject(new Error('Not signed in'));
                user.getSession(function(err, session) {
                    if (err || !session || !session.isValid()) {
                        return reject(err || new Error('Session invalid'));
                    }
                    resolve(session);
                });
            });
        },

        isLoggedIn: function() {
            var user = Auth.currentUser();
            return !!user;
        },

        // Returns {email, name, sub} from the current ID token payload, or null.
        profile: function() {
            var user = Auth.currentUser();
            if (!user) return null;
            // Prefer the live in-memory session (available right after login).
            try {
                var session = user.signInUserSession;
                if (session) {
                    var payload = session.getIdToken().decodePayload();
                    return { email: payload.email, name: payload.name, sub: payload.sub,
                             groups: payload['cognito:groups'] || [] };
                }
            } catch (e) { /* fall through to cached token */ }
            // Fallback: decode the ID token the SDK cached in localStorage
            // (populated on a persisted session before getSession() runs).
            try {
                var prefix = 'CognitoIdentityServiceProvider.' + COGNITO_CONFIG.clientId + '.';
                var lastUser = localStorage.getItem(prefix + 'LastAuthUser');
                if (!lastUser) return null;
                var idToken = localStorage.getItem(prefix + lastUser + '.idToken');
                if (!idToken) return null;
                var claims = JSON.parse(atob(idToken.split('.')[1]));
                return { email: claims.email, name: claims.name, sub: claims.sub,
                         groups: claims['cognito:groups'] || [] };
            } catch (e2) {
                return null;
            }
        },

        // Returns a promise of the raw ID token JWT (for authorizing API calls later).
        idToken: function() {
            return Auth.session().then(function(session) {
                return session.getIdToken().getJwtToken();
            });
        },
    };

    // Expose for later stages / debugging.
    window.SmartWasteAuth = Auth;

    // State
    var fileData = null;
    var fileMime = null;
    var chatHistory = [];
    var lastWasteDetails = null;  // most recent analysis, for public-collect reports

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
        resetAnalysisState();
    });

    // Clear any prior analysis so a stale result can't be listed/reported
    // against a changed or removed image.
    function resetAnalysisState() {
        lastWasteDetails = null;
        var allowWrap = document.getElementById('allowCollectWrap');
        if (allowWrap) allowWrap.hidden = true;
        setAllowCollectInline(false);
        var outputSection = document.getElementById('outputSection');
        if (outputSection) outputSection.hidden = true;
    }

    // Keep the Future Actions inline "Allow Public Collect" prompt in sync with
    // the Waste Details button: visible only for a valid, collectable item.
    function setAllowCollectInline(show) {
        var el = document.getElementById('allowCollectInline');
        if (el) el.hidden = !show;
    }

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
            // New image = previous analysis no longer applies.
            resetAnalysisState();
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
                // Invalid item: never allow listing it. Clear any prior analysis
                // and hide the "Allow Public Collect" button.
                lastWasteDetails = null;
                var allowWrapRej = document.getElementById('allowCollectWrap');
                if (allowWrapRej) allowWrapRej.hidden = true;
                setAllowCollectInline(false);
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

            // Capture the analysis so it can be carried into a public-collect report,
            // and reveal the "Allow Public Collect" button.
            lastWasteDetails = wasteDetailsData || {};
            var allowWrap = document.getElementById('allowCollectWrap');
            if (allowWrap) allowWrap.hidden = false;
            setAllowCollectInline(true);

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
        // Header chat icon opens the peer-to-peer Messages page (the floating
        // FAB remains the AI assistant).
        chatHeaderBtn.addEventListener('click', function() {
            openChatPage();
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
    var codeField = document.getElementById('codeField');
    var authError = document.getElementById('authError');
    var authSuccessEl = document.getElementById('authSuccess');
    var authEmail = document.getElementById('authEmail');
    var authPassword = document.getElementById('authPassword');
    var authName = document.getElementById('authName');
    var authConfirm = document.getElementById('authConfirm');
    var authCode = document.getElementById('authCode');
    var authResendBtn = document.getElementById('authResendBtn');

    // Auth modal state machine: 'login' | 'signup' | 'confirm'
    var authMode = 'login';
    // Holds credentials across the signup -> confirm step so we can auto-login.
    var pendingSignup = null;

    function setAuthMode(mode) {
        authMode = mode;
        var isSignup = mode === 'signup';
        var isConfirm = mode === 'confirm';
        var isLogin = mode === 'login';

        if (isConfirm) {
            authTitle.textContent = 'Verify your email';
            authSubtitle.textContent = 'Enter the code we emailed you';
            authSubmit.textContent = 'Verify';
        } else if (isSignup) {
            authTitle.textContent = 'Create account';
            authSubtitle.textContent = 'Sign up for a SmartWaste account';
            authSubmit.textContent = 'Sign Up';
        } else {
            authTitle.textContent = 'Welcome back';
            authSubtitle.textContent = 'Log in to your SmartWaste account';
            authSubmit.textContent = 'Login';
        }

        authSwitchText.textContent = isSignup ? 'Already have an account?' : "Don't have an account?";
        authSwitchBtn.textContent = isSignup ? 'Login' : 'Sign Up';
        authSwitchBtn.parentElement.hidden = isConfirm;

        // Field visibility per state
        nameField.hidden = !isSignup;
        confirmField.hidden = !isSignup;
        codeField.hidden = !isConfirm;
        // Email/password only shown in login/signup, hidden during confirm
        authEmail.closest('.auth-field').hidden = isConfirm;
        authPassword.closest('.auth-field').hidden = isConfirm;

        authName.required = isSignup;
        authConfirm.required = isSignup;
        authCode.required = isConfirm;
        authPassword.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');

        hideAuthError();
        hideAuthSuccess();
    }

    function openAuth(mode) {
        setAuthMode(mode);
        authOverlay.classList.add('show');
        setTimeout(function() {
            (mode === 'confirm' ? authCode : authEmail).focus();
        }, 50);
    }

    function closeAuth() {
        authOverlay.classList.remove('show');
        authForm.reset();
        pendingSignup = null;
        hideAuthError();
        hideAuthSuccess();
    }

    function showAuthError(msg) {
        authError.textContent = msg;
        authError.hidden = false;
        hideAuthSuccess();
    }

    function hideAuthError() {
        authError.hidden = true;
        authError.textContent = '';
    }

    function showAuthSuccess(msg) {
        authSuccessEl.textContent = msg;
        authSuccessEl.hidden = false;
    }

    function hideAuthSuccess() {
        authSuccessEl.hidden = true;
        authSuccessEl.textContent = '';
    }

    function setAuthBusy(busy, label) {
        authSubmit.disabled = busy;
        if (busy) authSubmit.textContent = label;
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

    authResendBtn.addEventListener('click', function() {
        if (!pendingSignup) return;
        hideAuthError();
        var user = cognitoUser(pendingSignup.email);
        user.resendConfirmationCode(function(err) {
            if (err) { showAuthError(cognitoMessage(err)); return; }
            showAuthSuccess('A new code has been sent to your email.');
        });
    });

    authForm.addEventListener('submit', function(e) {
        e.preventDefault();
        hideAuthError();
        hideAuthSuccess();

        if (authMode === 'confirm') return handleConfirm();
        if (authMode === 'signup') return handleSignup();
        return handleLogin();
    });

    function handleLogin() {
        var email = authEmail.value.trim();
        var password = authPassword.value;
        if (!validEmail(email)) { showAuthError('Please enter a valid email address.'); return; }
        if (!password) { showAuthError('Please enter your password.'); return; }

        setAuthBusy(true, 'Logging in...');
        Auth.login(email, password).then(function() {
            setAuthBusy(false);
            closeAuth();
            onAuthChanged();
        }).catch(function(err) {
            setAuthBusy(false);
            setAuthMode('login');
            // If the account exists but isn't confirmed, jump to the confirm step.
            if (err && err.code === 'UserNotConfirmedException') {
                pendingSignup = { email: email, password: password };
                setAuthMode('confirm');
                showAuthSuccess('Please verify your email. Enter the code we sent you.');
                return;
            }
            showAuthError(cognitoMessage(err));
        });
    }

    function handleSignup() {
        var email = authEmail.value.trim();
        var password = authPassword.value;
        var name = authName.value.trim();
        if (!name) { showAuthError('Please enter your full name.'); return; }
        if (!validEmail(email)) { showAuthError('Please enter a valid email address.'); return; }
        if (!strongPassword(password)) {
            showAuthError('Password needs 8+ characters with upper, lower, and a number.');
            return;
        }
        if (password !== authConfirm.value) { showAuthError('Passwords do not match.'); return; }

        setAuthBusy(true, 'Signing up...');
        Auth.signup(email, password, name).then(function() {
            setAuthBusy(false);
            pendingSignup = { email: email, password: password };
            setAuthMode('confirm');
            showAuthSuccess('Account created! Enter the 6-digit code we emailed to ' + email + '.');
        }).catch(function(err) {
            setAuthBusy(false);
            showAuthError(cognitoMessage(err));
        });
    }

    function handleConfirm() {
        if (!pendingSignup) { setAuthMode('login'); return; }
        var code = authCode.value.trim();
        if (!code) { showAuthError('Please enter the verification code.'); return; }

        setAuthBusy(true, 'Verifying...');
        Auth.confirm(pendingSignup.email, code).then(function() {
            // Auto-login after confirmation using the stored password.
            return Auth.login(pendingSignup.email, pendingSignup.password);
        }).then(function() {
            setAuthBusy(false);
            pendingSignup = null;
            closeAuth();
            onAuthChanged();
        }).catch(function(err) {
            setAuthBusy(false);
            setAuthMode('confirm');
            showAuthError(cognitoMessage(err));
        });
    }

    function validEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function strongPassword(pw) {
        return typeof pw === 'string' && pw.length >= 8 &&
            /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw);
    }

    // Map Cognito error objects to friendly messages.
    function cognitoMessage(err) {
        if (!err) return 'Something went wrong. Please try again.';
        var code = err.code || '';
        var map = {
            'NotAuthorizedException': 'Incorrect email or password.',
            'UserNotFoundException': 'Incorrect email or password.',
            'UsernameExistsException': 'An account with this email already exists.',
            'CodeMismatchException': 'That verification code is incorrect.',
            'ExpiredCodeException': 'That code has expired. Request a new one.',
            'InvalidPasswordException': 'Password does not meet the requirements.',
            'LimitExceededException': 'Too many attempts. Please wait and try again.',
            'InvalidParameterException': 'Please check your details and try again.'
        };
        return map[code] || err.message || 'Something went wrong. Please try again.';
    }

    // --- Header auth state ---
    // Reflects login state in the header: hide Login/Sign Up when authenticated,
    // show a greeting + Logout. (Full profile page comes in a later stage.)
    var headerActions = document.querySelector('.header-actions');

    function onAuthChanged() {
        var loggedIn = Auth.isLoggedIn();
        var profile = Auth.profile();

        if (loginBtn) loginBtn.hidden = loggedIn;
        if (signupBtn) signupBtn.hidden = loggedIn;

        var greeting = document.getElementById('authGreeting');
        var logoutBtn = document.getElementById('logoutBtn');

        if (loggedIn) {
            if (!greeting) {
                greeting = document.createElement('span');
                greeting.id = 'authGreeting';
                greeting.className = 'auth-greeting';
                headerActions.appendChild(greeting);
            }
            var displayName = '';
            if (profile) {
                displayName = (profile.name && profile.name.trim()) ||
                    (profile.email ? profile.email.split('@')[0] : '');
            }
            greeting.textContent = displayName ? ('Hi, ' + displayName) : 'Hi there';
            greeting.hidden = false;

            if (!logoutBtn) {
                logoutBtn = document.createElement('button');
                logoutBtn.id = 'logoutBtn';
                logoutBtn.type = 'button';
                logoutBtn.className = 'btn-auth btn-login';
                logoutBtn.textContent = 'Logout';
                logoutBtn.addEventListener('click', function() {
                    // Stop device pushes for this account first (needs the token).
                    disablePush().then(function() {
                        Auth.logout();
                        clearUserState();
                        navigate('');
                        onAuthChanged();
                    });
                });
                headerActions.appendChild(logoutBtn);
            }
            logoutBtn.hidden = false;
        } else {
            if (greeting) greeting.hidden = true;
            if (logoutBtn) logoutBtn.hidden = true;
        }

        // Show the Admin nav only when the ID token's cognito:groups contains
        // 'admins'. This is a convenience gate — the server re-verifies via
        // _is_admin on every /admin call.
        var adminNavBtn = document.getElementById('adminNavBtn');
        if (adminNavBtn) {
            var isAdmin = loggedIn && profile &&
                (profile.groups || []).indexOf('admins') !== -1;
            adminNavBtn.hidden = !isAdmin;
        }

        // Refresh the notification badge whenever auth state changes.
        if (typeof refreshNotifBadge === 'function') refreshNotifBadge();
        // Re-resolve the current route so gated pages redirect on logout / allow on login.
        if (typeof router === 'function' && _routerReady) router();
    }

    // Clear all per-user state so a different account doesn't inherit the
    // previous user's inputs, analysis, or cached data. Called on logout.
    function clearUserState() {
        // Analyzer inputs + uploaded file + last analysis
        if (descriptionInput) descriptionInput.value = '';
        if (locationInput) locationInput.value = '';
        fileData = null;
        fileMime = null;
        lastWasteDetails = null;
        if (fileInput) fileInput.value = '';
        if (uploadPreview) uploadPreview.hidden = true;
        if (uploadZone) uploadZone.style.display = '';
        var outputSection = document.getElementById('outputSection');
        if (outputSection) outputSection.hidden = true;
        var allowWrap = document.getElementById('allowCollectWrap');
        if (allowWrap) allowWrap.hidden = true;
        setAllowCollectInline(false);

        // Chat history (AI assistant)
        chatHistory = [];

        // Cached collect/portal/chat/notification data
        if (typeof portalRequests === 'object') { portalRequests.list = []; portalRequests.history = []; }
        if (typeof lifecycleRequests === 'object') { lifecycleRequests.incoming = []; lifecycleRequests.outgoing = []; }
        if (typeof notifData !== 'undefined') notifData = [];
        if (typeof chatConvos !== 'undefined') chatConvos = [];
        if (typeof currentProfile !== 'undefined') currentProfile = null;

        // Tear down any live chat connection + badge
        if (typeof window.leaveChatPage === 'function') window.leaveChatPage();
        if (notifBadge) notifBadge.hidden = true;
    }
    window.clearUserState = clearUserState;

    var _routerReady = false;

    // Initialize header to reflect any persisted session (SDK uses localStorage).
    onAuthChanged();

    // ===================== Hash router =====================
    // Full-page views are routed by URL hash: #/, #/profile, #/chat,
    // #/notifications, #/portal. Each page is a .app-page section; home is #viewHome.
    var ROUTES = {
        '': { view: 'viewHome', gated: false },
        'profile': { view: 'profileOverlay', gated: true, enter: function() { onEnterProfile(); } },
        'chat': { view: 'chatPageOverlay', gated: true, enter: function(arg) { onEnterChat(arg); } },
        'notifications': { view: 'notifOverlay', gated: true, enter: function() { onEnterNotifications(); } },
        'portal': { view: 'portalOverlay', gated: true, enter: function(arg) { onEnterPortal(arg); } },
        'admin': { view: 'adminOverlay', gated: true, enter: function() { onEnterAdmin(); } },
    };

    function parseHash() {
        // Formats: '', '#/', '#/profile', '#/portal/history', '#/chat/<id>'
        var raw = (location.hash || '').replace(/^#\/?/, '');
        var parts = raw.split('/');
        return { name: parts[0] || '', arg: parts[1] || '' };
    }

    var _currentView = null;
    function showView(viewId) {
        // Leaving the chat page: tear down its live socket/polling.
        if (_currentView === 'chatPageOverlay' && viewId !== 'chatPageOverlay' &&
            typeof window.leaveChatPage === 'function') {
            window.leaveChatPage();
        }
        var pages = document.querySelectorAll('.app-view, .app-page');
        for (var i = 0; i < pages.length; i++) {
            pages[i].hidden = (pages[i].id !== viewId);
        }
        // Hide the home footer when on a sub-page.
        document.body.classList.toggle('on-subpage', viewId !== 'viewHome');
        _currentView = viewId;
        window.scrollTo(0, 0);
    }

    function navigate(route) {
        // route like 'profile' or 'portal/history'; '' = home.
        var target = route ? ('#/' + route) : '#/';
        if (location.hash === target) {
            router();  // same hash: re-run (e.g. refresh data)
        } else {
            location.hash = target;  // triggers hashchange -> router
        }
    }

    function router() {
        var h = parseHash();
        var def = ROUTES[h.name] || ROUTES[''];

        // Login-gate: bounce protected routes to home + open login modal.
        if (def.gated && !Auth.isLoggedIn()) {
            showView('viewHome');
            if (location.hash && location.hash !== '#/') {
                history.replaceState(null, '', '#/');
            }
            openAuth('login');
            return;
        }

        showView(def.view);
        if (typeof def.enter === 'function') def.enter(h.arg);
    }

    window.addEventListener('hashchange', router);
    _routerReady = true;

    // Home link + all back-to-home arrows.
    var homeLink = document.getElementById('homeLink');
    if (homeLink) homeLink.addEventListener('click', function(e) {
        e.preventDefault();
        navigate('');
    });
    var backBtns = document.querySelectorAll('[data-home]');
    for (var bi = 0; bi < backBtns.length; bi++) {
        backBtns[bi].addEventListener('click', function() { navigate(''); });
    }

    // ===================== Profile page =====================
    var profileBtn = document.getElementById('profileBtn');
    var profileOverlay = document.getElementById('profileOverlay');
    var profileView = document.getElementById('profileView');
    var profileEdit = document.getElementById('profileEdit');
    var editProfileBtn = document.getElementById('editProfileBtn');
    var cancelEditBtn = document.getElementById('cancelEditBtn');
    var saveProfileBtn = document.getElementById('saveProfileBtn');
    var sendFeedbackBtn = document.getElementById('sendFeedbackBtn');
    var profileLogoutBtn = document.getElementById('profileLogoutBtn');
    var deleteAccountBtn = document.getElementById('deleteAccountBtn');
    var deleteConfirmOverlay = document.getElementById('deleteConfirmOverlay');
    var deleteCancelBtn = document.getElementById('deleteCancelBtn');
    var deleteConfirmBtn = document.getElementById('deleteConfirmBtn');

    var currentProfile = null;
    var feedbackRating = 0;

    function profileConfigured() {
        return STREAM_URLS.profile && STREAM_URLS.profile.indexOf('__URL_') !== 0;
    }

    // Authorized fetch against the profile API using the Cognito ID token.
    function profileFetch(method, body, pathSuffix) {
        return Auth.idToken().then(function(token) {
            return fetch(STREAM_URLS.profile + (pathSuffix || ''), {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: body ? JSON.stringify(body) : undefined,
            });
        }).then(function(resp) {
            if (resp.status === 401) throw new Error('Your session expired. Please log in again.');
            if (!resp.ok) throw new Error('Request failed (' + resp.status + ')');
            return resp.json();
        });
    }

    // Router entry: profile view just became visible — load its data.
    function onEnterProfile() {
        showProfileView();
        loadProfile();
        if (typeof updatePushUI === 'function') updatePushUI();
        if (typeof loadCollectorStatus === 'function') loadCollectorStatus();
    }

    function showProfileView() {
        profileView.hidden = false;
        profileEdit.hidden = true;
    }

    function showProfileEdit() {
        profileView.hidden = true;
        profileEdit.hidden = false;
        if (currentProfile) {
            document.getElementById('peName').value = currentProfile.name || '';
            document.getElementById('pePhone').value = currentProfile.phone || '';
            document.getElementById('peAddress').value = currentProfile.address || '';
        }
        hideEl('profileEditMsg');
    }

    function renderProfile(p) {
        currentProfile = p;
        var name = p.name || p.email || 'User';
        document.getElementById('profileNameText').textContent = name;
        document.getElementById('profileEmailText').textContent = p.email || '';
        document.getElementById('profileAvatar').textContent =
            (name.charAt(0) || '?').toUpperCase();

        document.getElementById('pvName').textContent = p.name || '—';
        document.getElementById('pvEmail').textContent = p.email || '—';
        document.getElementById('pvPhone').textContent = p.phone || '—';
        document.getElementById('pvAddress').textContent = p.address || '—';

        var s = p.settings || {};
        document.getElementById('setEmailNotif').checked = !!s.emailNotif;
        document.getElementById('setShareContact').checked = !!s.shareContact;
    }

    function loadProfile() {
        if (!profileConfigured()) return;
        profileFetch('GET').then(renderProfile).catch(function(err) {
            // Fall back to showing token claims if the API isn't reachable.
            var claims = Auth.profile() || {};
            renderProfile({ name: claims.name, email: claims.email, phone: '', address: '', settings: {} });
            console.warn('Profile load failed:', err.message);
        });
    }

    function showMsg(id, text, isError) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.hidden = false;
        el.classList.toggle('is-error', !!isError);
    }

    function hideEl(id) {
        var el = document.getElementById(id);
        if (el) el.hidden = true;
    }

    if (profileBtn) profileBtn.addEventListener('click', function() { navigate('profile'); });

    if (editProfileBtn) editProfileBtn.addEventListener('click', showProfileEdit);
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', showProfileView);

    if (saveProfileBtn) saveProfileBtn.addEventListener('click', function() {
        var body = {
            name: document.getElementById('peName').value.trim(),
            phone: document.getElementById('pePhone').value.trim(),
            address: document.getElementById('peAddress').value.trim(),
            settings: {
                emailNotif: document.getElementById('setEmailNotif').checked,
                shareContact: document.getElementById('setShareContact').checked,
            },
        };
        saveProfileBtn.disabled = true;
        profileFetch('PUT', body).then(function(p) {
            saveProfileBtn.disabled = false;
            renderProfile(p);
            showProfileView();
            onAuthChanged();  // refresh header greeting if name changed
        }).catch(function(err) {
            saveProfileBtn.disabled = false;
            showMsg('profileEditMsg', err.message, true);
        });
    });

    // Settings toggles save immediately (reuse the profile PUT).
    function persistSettings() {
        if (!currentProfile) return;
        var body = {
            name: currentProfile.name || '',
            phone: currentProfile.phone || '',
            address: currentProfile.address || '',
            settings: {
                emailNotif: document.getElementById('setEmailNotif').checked,
                shareContact: document.getElementById('setShareContact').checked,
            },
        };
        profileFetch('PUT', body).then(renderProfile).catch(function() {});
    }
    var setEmailNotif = document.getElementById('setEmailNotif');
    var setShareContact = document.getElementById('setShareContact');
    if (setEmailNotif) setEmailNotif.addEventListener('change', persistSettings);
    if (setShareContact) setShareContact.addEventListener('change', persistSettings);

    // Feedback stars
    var starEls = document.querySelectorAll('#feedbackStars .star');
    function paintStars(n) {
        for (var i = 0; i < starEls.length; i++) {
            starEls[i].classList.toggle('filled', i < n);
        }
    }
    for (var si = 0; si < starEls.length; si++) {
        starEls[si].addEventListener('click', function() {
            feedbackRating = parseInt(this.getAttribute('data-value'), 10);
            paintStars(feedbackRating);
        });
    }

    if (sendFeedbackBtn) sendFeedbackBtn.addEventListener('click', function() {
        var message = document.getElementById('feedbackText').value.trim();
        if (!feedbackRating && !message) {
            showMsg('feedbackMsg', 'Add a rating or a comment first.', true);
            return;
        }
        sendFeedbackBtn.disabled = true;
        profileFetch('POST', { rating: feedbackRating, message: message }, 'feedback').then(function() {
            sendFeedbackBtn.disabled = false;
            document.getElementById('feedbackText').value = '';
            feedbackRating = 0;
            paintStars(0);
            showMsg('feedbackMsg', 'Thanks for your feedback!', false);
        }).catch(function(err) {
            sendFeedbackBtn.disabled = false;
            showMsg('feedbackMsg', err.message, true);
        });
    });

    if (profileLogoutBtn) profileLogoutBtn.addEventListener('click', function() {
        disablePush().then(function() {
            Auth.logout();
            clearUserState();
            navigate('');
            onAuthChanged();
        });
    });

    // Delete account -> confirm modal -> DELETE
    if (deleteAccountBtn) deleteAccountBtn.addEventListener('click', function() {
        hideEl('deleteConfirmMsg');
        deleteConfirmOverlay.classList.add('show');
    });
    if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', function() {
        deleteConfirmOverlay.classList.remove('show');
    });
    deleteConfirmOverlay.addEventListener('click', function(e) {
        if (e.target === deleteConfirmOverlay) deleteConfirmOverlay.classList.remove('show');
    });
    if (deleteConfirmBtn) deleteConfirmBtn.addEventListener('click', function() {
        deleteConfirmBtn.disabled = true;
        // Drop this device's push subscription (token still valid) before
        // deleting the account, so no orphaned subscription keeps pushing.
        disablePush().then(function() {
            return profileFetch('DELETE');
        }).then(function() {
            deleteConfirmBtn.disabled = false;
            deleteConfirmOverlay.classList.remove('show');
            Auth.logout();
            clearUserState();
            navigate('');
            onAuthChanged();
            alert('Your account has been deleted.');
        }).catch(function(err) {
            deleteConfirmBtn.disabled = false;
            showMsg('deleteConfirmMsg', err.message, true);
        });
    });

    // ===================== Collector account (Profile) =====================
    var COLLECTOR_DOCS = [
        { type: 'registration', input: 'colDocRegistration', status: 'colDocRegistrationStatus' },
        { type: 'license', input: 'colDocLicense', status: 'colDocLicenseStatus' },
        { type: 'insurance', input: 'colDocInsurance', status: 'colDocInsuranceStatus' },
    ];
    var COLLECTOR_STATUS_LABELS = {
        none: 'Not applied', draft: 'Draft (not submitted)', pending: 'Pending review',
        approved: 'Approved', rejected: 'Rejected', suspended: 'Suspended',
    };

    function loadCollectorStatus() {
        var box = document.getElementById('collectorStatusBox');
        var becomeBtn = document.getElementById('becomeCollectorBtn');
        var form = document.getElementById('collectorForm');
        if (!box || !becomeBtn || !form) return;
        if (!collectConfigured()) { box.innerHTML = ''; return; }

        box.innerHTML = '<p class="placeholder-text">Loading...</p>';
        becomeBtn.hidden = true;
        form.hidden = true;

        collectFetch('GET', null, '/collector/me').then(function(me) {
            var status = (me && me.status) || 'none';
            var label = COLLECTOR_STATUS_LABELS[status] || status;
            var html = '<div class="report-summary-row"><span>Status</span>' +
                '<strong>' + escapeHtml(label) + '</strong></div>';
            if (status === 'rejected' && me.rejectionReason) {
                html += '<div class="report-summary-row"><span>Reason</span><strong>' +
                    escapeHtml(me.rejectionReason) + '</strong></div>';
            }
            box.innerHTML = '<div class="report-summary">' + html + '</div>';

            // 'none' and 'draft' can apply/submit; approved/pending/rejected/
            // suspended just show status (re-apply flows are a later phase).
            if (status === 'none' || status === 'draft') {
                becomeBtn.hidden = false;
            }
            // Prefill the form from an existing draft so a re-open keeps data.
            if (me && status !== 'none') prefillCollectorForm(me);
        }).catch(function() {
            box.innerHTML = '';
        });
    }

    function prefillCollectorForm(me) {
        setVal('colBusinessName', me.businessName);
        setVal('colRegistrationNumber', me.registrationNumber);
        setVal('colLicense', me.wasteCarrierLicense);
        setVal('colServiceAreas', (me.serviceAreas || []).join(', '));
        setVal('colWasteCategories', (me.wasteCategories || []).join(', '));
        setVal('colContactPhone', me.contactPhone);
        setVal('colContactEmail', me.contactEmail);
    }

    function setVal(id, v) {
        var el = document.getElementById(id);
        if (el) el.value = v || '';
    }

    (function wireCollectorForm() {
        var becomeBtn = document.getElementById('becomeCollectorBtn');
        var form = document.getElementById('collectorForm');
        var cancelBtn = document.getElementById('collectorCancelBtn');
        var submitBtn = document.getElementById('collectorSubmitBtn');
        if (!becomeBtn || !form) return;

        becomeBtn.addEventListener('click', function() {
            becomeBtn.hidden = true;
            form.hidden = false;
            hideEl('collectorFormMsg');
        });
        if (cancelBtn) cancelBtn.addEventListener('click', function() {
            form.hidden = true;
            loadCollectorStatus();
        });

        function splitList(id) {
            return (document.getElementById(id).value || '').split(',')
                .map(function(s) { return s.trim(); })
                .filter(function(s) { return s; });
        }

        // Upload one document via presigned PUT. The signed ContentType must
        // equal the browser PUT Content-Type, and the PUT carries NO bearer.
        function uploadDoc(cfg) {
            var input = document.getElementById(cfg.input);
            var statusEl = document.getElementById(cfg.status);
            if (!input || !input.files || !input.files[0]) return Promise.resolve();
            var file = input.files[0];
            if (statusEl) statusEl.textContent = 'Uploading...';
            return collectFetch('POST', { docType: cfg.type, contentType: file.type }, '/collector/upload-url')
                .then(function(res) {
                    return fetch(res.url, {
                        method: 'PUT',
                        headers: { 'Content-Type': file.type },
                        body: file,
                    });
                }).then(function(putResp) {
                    if (!putResp.ok) throw new Error('Upload failed (' + putResp.status + ')');
                    if (statusEl) statusEl.textContent = 'Uploaded.';
                }).catch(function(err) {
                    if (statusEl) statusEl.textContent = 'Upload failed.';
                    throw err;
                });
        }

        if (submitBtn) submitBtn.addEventListener('click', function() {
            hideEl('collectorFormMsg');
            var apply = {
                businessName: document.getElementById('colBusinessName').value.trim(),
                registrationNumber: document.getElementById('colRegistrationNumber').value.trim(),
                wasteCarrierLicense: document.getElementById('colLicense').value.trim(),
                serviceAreas: splitList('colServiceAreas'),
                wasteCategories: splitList('colWasteCategories'),
                contactPhone: document.getElementById('colContactPhone').value.trim(),
                contactEmail: document.getElementById('colContactEmail').value.trim(),
            };
            submitBtn.disabled = true;

            // Upload any selected documents first, then apply -> submit.
            var uploads = COLLECTOR_DOCS.map(uploadDoc);
            Promise.all(uploads).then(function() {
                return collectFetch('POST', apply, '/collector/apply');
            }).then(function() {
                return collectFetch('POST', null, '/collector/submit');
            }).then(function(res) {
                submitBtn.disabled = false;
                form.hidden = true;
                showMsg('collectorFormMsg', 'Application submitted. Status: ' +
                    ((res && res.status) || 'pending'), false);
                loadCollectorStatus();
            }).catch(function(err) {
                submitBtn.disabled = false;
                showMsg('collectorFormMsg', err.message, true);
            });
        });
    })();

    // ===================== Collect: report + portal =====================
    var allowCollectBtn = document.getElementById('allowCollectBtn');
    var reportOverlay = document.getElementById('reportOverlay');
    var reportClose = document.getElementById('reportClose');
    var reportForm = document.getElementById('reportForm');
    var reportSubmit = document.getElementById('reportSubmit');
    var reportSummary = document.getElementById('reportSummary');
    var portalOverlay = document.getElementById('portalOverlay');
    var sideLegend = document.querySelector('.side-legend');

    function collectConfigured() {
        return STREAM_URLS.collect && STREAM_URLS.collect.indexOf('__URL_') !== 0;
    }

    function collectFetch(method, body, pathSuffix) {
        return Auth.idToken().then(function(token) {
            return fetch(STREAM_URLS.collect + (pathSuffix || ''), {
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: body ? JSON.stringify(body) : undefined,
            });
        }).then(function(resp) {
            if (resp.status === 401) throw new Error('Your session expired. Please log in again.');
            if (!resp.ok) {
                // Surface the server's error text verbatim when present (e.g. the
                // 400 validation / 409 'no longer available' messages); fall back
                // to a generic line. Attach the HTTP status for callers to branch on.
                return resp.text().then(function(text) {
                    var msg = '';
                    if (text) {
                        try { msg = (JSON.parse(text).error) || ''; } catch (e) { msg = text; }
                    }
                    var err = new Error(msg || ('Request failed (' + resp.status + ')'));
                    err.status = resp.status;
                    throw err;
                });
            }
            return resp.json();
        });
    }

    // ===================== Web Push subscription =====================
    function pushSupported() {
        return ('serviceWorker' in navigator) && ('PushManager' in window) &&
            ('Notification' in window) &&
            VAPID_PUBLIC_KEY && VAPID_PUBLIC_KEY.indexOf('__VAPID_') !== 0;
    }

    function urlB64ToUint8Array(base64String) {
        var padding = '='.repeat((4 - base64String.length % 4) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(base64);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    // Reflect current push state in the profile Settings UI.
    function updatePushUI() {
        var btn = document.getElementById('enablePushBtn');
        var status = document.getElementById('pushStatus');
        var wrap = document.getElementById('pushOptin');
        if (!btn || !wrap) return;
        if (!pushSupported()) {
            wrap.hidden = true;
            return;
        }
        wrap.hidden = false;
        if (Notification.permission === 'denied') {
            btn.disabled = true;
            btn.textContent = 'Blocked';
            if (status) status.textContent = 'Notifications are blocked in your browser settings.';
            return;
        }
        if (Notification.permission === 'granted') {
            btn.disabled = false;
            btn.textContent = 'Enabled';
            if (status) status.textContent = 'You\'ll be notified on this device even when the app is closed.';
            return;
        }
        btn.disabled = false;
        btn.textContent = 'Enable';
        if (status) status.textContent = 'Get notified on this device even when the app is closed.';
    }

    function enablePush() {
        if (!pushSupported()) {
            alert('Device notifications are not supported in this browser.');
            return;
        }
        var btn = document.getElementById('enablePushBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Requesting...'; }

        Notification.requestPermission().then(function(perm) {
            if (perm !== 'granted') { updatePushUI(); return; }
            return (_swRegistration ? Promise.resolve(_swRegistration)
                                    : navigator.serviceWorker.ready)
                .then(function(reg) {
                    return reg.pushManager.getSubscription().then(function(existing) {
                        if (existing) return existing;
                        return reg.pushManager.subscribe({
                            userVisibleOnly: true,
                            applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
                        });
                    });
                })
                .then(function(sub) {
                    return collectFetch('POST', { subscription: sub.toJSON() }, 'subscribe');
                })
                .then(function() { updatePushUI(); })
                .catch(function(err) {
                    console.warn('Push subscribe failed:', err);
                    updatePushUI();
                });
        }).catch(function() { updatePushUI(); });
    }

    // Unsubscribe this device from Web Push and drop it from the backend.
    // Called on logout / delete account so a logged-out user stops receiving
    // device notifications. Best-effort: returns a promise that always resolves.
    // When requireAuth is true the backend row is removed while the user is
    // still authenticated (call this BEFORE Auth.logout()).
    function disablePush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            return Promise.resolve();
        }
        var ready = _swRegistration ? Promise.resolve(_swRegistration)
                                    : navigator.serviceWorker.ready;
        return ready.then(function(reg) {
            if (!reg) return;
            return reg.pushManager.getSubscription().then(function(sub) {
                if (!sub) return;
                var endpoint = sub.endpoint;
                // Tell the backend to forget this device (needs a valid token,
                // so this must run before the session is cleared).
                var backend = collectFetch('POST', { endpoint: endpoint }, 'unsubscribe')
                    .catch(function () {});
                // Remove the browser-side subscription regardless.
                var local = sub.unsubscribe().catch(function () {});
                return Promise.all([backend, local]);
            });
        }).catch(function () {});
    }
    window.disablePush = disablePush;

    (function wirePushButton() {
        var btn = document.getElementById('enablePushBtn');
        if (btn) btn.addEventListener('click', enablePush);
    })();

    // Pull friendly values from the fixed waste-details JSON for the report.
    function wasteSummaryFromAnalysis() {
        var d = lastWasteDetails || {};
        return {
            wasteType: d.description || d.category || 'Waste item',
            category: d.category || '',
            description: d.description || '',
            weight: d.estimated_weight || '',
        };
    }

    function openReportForm() {
        if (!Auth.isLoggedIn()) { openAuth('login'); return; }
        if (!lastWasteDetails) { alert('Please analyze a waste item first.'); return; }

        var w = wasteSummaryFromAnalysis();
        reportSummary.innerHTML =
            '<div class="report-summary-row"><span>Item</span><strong>' +
            escapeHtml(w.wasteType) + '</strong></div>' +
            (w.category ? '<div class="report-summary-row"><span>Category</span><strong>' +
                escapeHtml(w.category) + '</strong></div>' : '') +
            (w.weight ? '<div class="report-summary-row"><span>Est. weight</span><strong>' +
                escapeHtml(w.weight) + '</strong></div>' : '');

        // Prefill contact from profile (token first, then API for phone/address).
        var claims = Auth.profile() || {};
        document.getElementById('rfName').value = claims.name || '';
        document.getElementById('rfPhone').value = '';
        document.getElementById('rfAddress').value = '';
        document.getElementById('rfArea').value = locationInput.value.trim() || '';
        document.getElementById('rfMaxPrice').value = '';
        document.getElementById('rfCurrency').value = 'MYR';
        var rfPriceTypeEl = document.getElementById('rfPriceType');
        if (rfPriceTypeEl) rfPriceTypeEl.value = 'user_pays';
        updatePriceTypeFields();
        document.getElementById('rfPickup').value = '';
        document.getElementById('rfNotes').value = '';
        hideEl('reportError'); hideEl('reportSuccess');

        if (collectConfigured()) {
            profileFetch('GET').then(function(p) {
                if (p.name && !document.getElementById('rfName').value) document.getElementById('rfName').value = p.name;
                if (p.phone) document.getElementById('rfPhone').value = p.phone;
                if (p.address) document.getElementById('rfAddress').value = p.address;
            }).catch(function() {});
        }

        reportOverlay.classList.add('show');
    }

    function closeReportForm() {
        reportOverlay.classList.remove('show');
    }

    // Toggle the price fields based on the chosen listing type. A free giveaway
    // has no price, so hide/disable max-price + currency; a paid pickup keeps them.
    function updatePriceTypeFields() {
        var sel = document.getElementById('rfPriceType');
        var isFree = sel && sel.value === 'free';
        var maxField = document.getElementById('rfMaxPriceField');
        var curField = document.getElementById('rfCurrencyField');
        var maxInput = document.getElementById('rfMaxPrice');
        if (maxField) maxField.style.display = isFree ? 'none' : '';
        if (curField) curField.style.display = isFree ? 'none' : '';
        if (maxInput) {
            maxInput.disabled = !!isFree;
            if (isFree) maxInput.value = '';
        }
    }

    var rfPriceTypeInput = document.getElementById('rfPriceType');
    if (rfPriceTypeInput) rfPriceTypeInput.addEventListener('change', updatePriceTypeFields);

    if (allowCollectBtn) allowCollectBtn.addEventListener('click', openReportForm);
    var allowCollectBtnActions = document.getElementById('allowCollectBtnActions');
    if (allowCollectBtnActions) allowCollectBtnActions.addEventListener('click', openReportForm);
    if (reportClose) reportClose.addEventListener('click', closeReportForm);
    reportOverlay.addEventListener('click', function(e) {
        if (e.target === reportOverlay) closeReportForm();
    });

    if (reportForm) reportForm.addEventListener('submit', function(e) {
        e.preventDefault();
        hideEl('reportError'); hideEl('reportSuccess');

        // Guard: never allow listing without a current valid analysis.
        if (!lastWasteDetails) {
            showMsg('reportError', 'Please analyze a valid waste item first.', true);
            return;
        }

        var name = document.getElementById('rfName').value.trim();
        var phone = document.getElementById('rfPhone').value.trim();
        var address = document.getElementById('rfAddress').value.trim();
        if (!name || !phone || !address) {
            showMsg('reportError', 'Name, phone, and pickup address are required.', true);
            return;
        }
        // Basic phone sanity: 7-15 digits, optional leading + and spaces/dashes.
        if (!/^\+?[0-9][0-9\s\-]{6,18}$/.test(phone)) {
            showMsg('reportError', 'Please enter a valid phone number.', true);
            return;
        }
        if (address.length < 5) {
            showMsg('reportError', 'Please enter a complete pickup address.', true);
            return;
        }

        // Listing type: 'free' (any user collects, no price) vs 'user_pays' (a
        // verified business collects, owner pays). Default to paid.
        var priceTypeEl = document.getElementById('rfPriceType');
        var priceType = (priceTypeEl && priceTypeEl.value === 'free') ? 'free' : 'user_pays';

        // Optional max price the owner is willing to pay for removal — paid only.
        var maxPrice = null;
        if (priceType !== 'free') {
            var maxPriceRaw = document.getElementById('rfMaxPrice').value.trim();
            if (maxPriceRaw) {
                maxPrice = parseFloat(maxPriceRaw);
                if (isNaN(maxPrice) || maxPrice <= 0) {
                    showMsg('reportError', 'Maximum price must be a number greater than 0.', true);
                    return;
                }
            }
        }

        var w = wasteSummaryFromAnalysis();
        var body = {
            wasteType: w.wasteType,
            category: w.category,
            description: w.description,
            weight: w.weight,
            contactName: name,
            phone: phone,
            fullAddress: address,
            area: document.getElementById('rfArea').value.trim(),
            pickupTime: document.getElementById('rfPickup').value.trim(),
            notes: document.getElementById('rfNotes').value.trim(),
            // 'free' = give away (any user collects); 'user_pays' = owner pays a
            // verified business to remove it.
            priceType: priceType,
            // Sent so the server can re-validate the image before listing.
            file_data: fileData,
            file_mime: fileMime,
        };
        // Currency + maxPrice only apply to the paid lane.
        if (priceType !== 'free') {
            body.currency = document.getElementById('rfCurrency').value;
            if (maxPrice !== null) body.maxPrice = maxPrice;
        }

        reportSubmit.disabled = true;
        collectFetch('POST', body, 'report').then(function() {
            reportSubmit.disabled = false;
            closeReportForm();
            document.getElementById('reportDoneOverlay').classList.add('show');
        }).catch(function(err) {
            reportSubmit.disabled = false;
            showMsg('reportError', err.message, true);
        });
    });

    // Report success confirmation -> OK opens the portal.
    var reportDoneOverlay = document.getElementById('reportDoneOverlay');
    var reportDoneOk = document.getElementById('reportDoneOk');
    if (reportDoneOk) reportDoneOk.addEventListener('click', function() {
        reportDoneOverlay.classList.remove('show');
        navigate('portal');
    });
    if (reportDoneOverlay) reportDoneOverlay.addEventListener('click', function(e) {
        if (e.target === reportDoneOverlay) reportDoneOverlay.classList.remove('show');
    });

    // --- Portal page ---
    var portalRequests = { list: [], history: [] };
    // Chart.js instances for the analytics dashboard — destroyed before
    // re-creating so repeated History tab switches don't leak/double-render.
    var lineChartInstance = null;
    var pieChartInstance = null;

    // Router entry: portal view visible — arg is optional tab ('list'|'history').
    function onEnterPortal(which) {
        switchPortalTab(which || 'list');
    }

    function switchPortalTab(which) {
        var tabs = document.querySelectorAll('.portal-tab');
        for (var i = 0; i < tabs.length; i++) {
            var active = tabs[i].getAttribute('data-portal-tab') === which;
            tabs[i].classList.toggle('active', active);
            tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
        }
        document.getElementById('portalListPanel').hidden = (which !== 'list');
        document.getElementById('portalHistoryPanel').hidden = (which !== 'history');
        if (which === 'list') loadPortalList();
        else loadPortalHistory();
    }

    function loadPortalList() {
        var cards = document.getElementById('portalListCards');
        cards.innerHTML = '<div class="placeholder-text">Loading requests...</div>';
        updateDistanceAvailability();
        collectFetch('GET', null, 'list').then(function(data) {
            portalRequests.list = (data && data.requests) || [];
            applyListFilters();
        }).catch(function(err) {
            cards.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
        });
    }

    // History tab: posted (my own reports) + collected (my outgoing requests
    // that reached 'collected').
    function loadPortalHistory() {
        var postedEl = document.getElementById('historyPostedCards');
        var collectedEl = document.getElementById('historyCollectedCards');
        postedEl.innerHTML = '<div class="placeholder-text">Loading your posts...</div>';
        collectedEl.innerHTML = '<div class="placeholder-text">Loading your collections...</div>';

        collectFetch('GET', null, 'mine').then(function(data) {
            var mine = (data && data.requests) || [];
            portalRequests.history = mine;
            renderPortalCards(postedEl, mine, 'posted');
        }).catch(function(err) {
            postedEl.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
        });

        collectFetch('GET', null, 'requests').then(function(data) {
            var outgoing = (data && data.outgoing) || [];
            var collected = outgoing.filter(function(r) {
                return (r.status === 'collected' || r.status === 'done');
            });
            renderCollectedCards(collectedEl, collected);
        }).catch(function(err) {
            collectedEl.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
        });

        loadAnalytics();
    }

    // Analytics dashboard: deterministic numbers computed server-side; here we
    // just render stat cards, a line + pie chart, and two conic-gradient rings.
    // Non-fatal: a failure leaves the History cards above fully working.
    function loadAnalytics() {
        var dash = document.getElementById('analyticsDash');
        var empty = document.getElementById('analyticsEmpty');
        if (!dash || !empty) return;

        collectFetch('GET', null, 'analytics').then(function(data) {
            data = data || {};
            var total = data.totalCollected || 0;

            // Empty/zero state: hide charts, show a friendly message.
            if (total <= 0) {
                dash.hidden = true;
                empty.hidden = false;
                destroyAnalyticsCharts();
                return;
            }
            empty.hidden = true;
            dash.hidden = false;

            document.getElementById('statTotalCollected').textContent = total;
            document.getElementById('statTotalWeight').textContent =
                (data.totalWeightKg || 0) + ' kg';

            // Circular widgets: set --pct and center text.
            setRing('landfillSavedWidget', 'landfillSavedPct', data.landfillSavedPct || 0);
            setRing('climateSavedWidget', 'climateSavedPct', data.climateSavedPct || 0);

            renderAnalyticsCharts(data);
        }).catch(function(err) {
            // Non-fatal — surface a small inline note, keep History working.
            dash.hidden = true;
            empty.hidden = false;
            empty.innerHTML = '<span class="error-message">\u26a0\ufe0f Analytics unavailable: ' +
                escapeHtml(err.message) + '</span>';
            destroyAnalyticsCharts();
        });
    }

    function setRing(widgetId, pctId, pct) {
        var w = document.getElementById(widgetId);
        var label = document.getElementById(pctId);
        var val = Math.max(0, Math.min(100, Math.round(pct)));
        if (w) w.style.setProperty('--pct', val);
        if (label) label.textContent = val + '%';
    }

    function destroyAnalyticsCharts() {
        if (lineChartInstance) { lineChartInstance.destroy(); lineChartInstance = null; }
        if (pieChartInstance) { pieChartInstance.destroy(); pieChartInstance = null; }
    }

    function renderAnalyticsCharts(data) {
        // Guard: CDN not loaded (e.g. offline local preview) — skip charts but
        // keep the stat cards and rings rendered.
        if (typeof Chart === 'undefined') return;
        destroyAnalyticsCharts();

        var ts = data.timeSeries || { points: [] };
        var points = ts.points || [];
        var lineCanvas = document.getElementById('collectionLineChart');
        if (lineCanvas) {
            lineChartInstance = new Chart(lineCanvas, {
                type: 'line',
                data: {
                    labels: points.map(function(p) { return p.label; }),
                    datasets: [{
                        label: 'Items collected',
                        data: points.map(function(p) { return p.count; }),
                        borderColor: '#2e7d32',
                        backgroundColor: 'rgba(46, 125, 50, 0.12)',
                        fill: true,
                        tension: 0.3,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                },
            });
        }

        var byType = data.byType || [];
        var pieCanvas = document.getElementById('wasteTypePie');
        if (pieCanvas) {
            var palette = ['#2e7d32', '#43a047', '#66bb6a', '#26c6da',
                           '#f0a84b', '#b85ccf', '#8e39ab', '#d9822b'];
            pieChartInstance = new Chart(pieCanvas, {
                type: 'pie',
                data: {
                    labels: byType.map(function(t) { return t.type; }),
                    datasets: [{
                        data: byType.map(function(t) { return t.count; }),
                        backgroundColor: byType.map(function(_, i) {
                            return palette[i % palette.length];
                        }),
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom' } },
                },
            });
        }
    }

    // Collected items come from collect-requests, which have a slightly
    // different shape than waste reports — render a compact variant.
    function renderCollectedCards(container, items) {
        if (!items.length) {
            container.innerHTML = '<div class="placeholder-text">You haven\'t collected anything yet.</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var r = items[i];
            html += '<div class="request-card">';
            html += '<div class="request-card-head">';
            html += '<div class="request-title">' + escapeHtml(r.wasteType || 'Waste item') + '</div>';
            html += statusBadge(r.status);
            html += '</div>';
            html += '<div class="request-submitted">Collected from ' +
                escapeHtml(r.ownerName || 'owner') + '</div>';
            html += '<div class="request-meta">';
            if (r.area) html += '<div><i class="fa-solid fa-location-dot"></i> ' + escapeHtml(r.area) + '</div>';
            html += '<div><i class="fa-solid fa-box"></i> ' +
                escapeHtml((r.category || 'Waste') + (r.weight ? ' • ' + r.weight : '')) + '</div>';
            html += '</div></div>';
        }
        container.innerHTML = html;
    }

    // --- Waste Collect List filters (client-side) ---
    function viewerCenter() {
        // Prefer the live facilities map center (from the user's analyzed
        // location); it exists only after an analysis with a location.
        if (facilitiesMap && typeof facilitiesMap.getCenter === 'function') {
            try {
                var c = facilitiesMap.getCenter();
                if (c && typeof c.lat === 'number') return { lat: c.lat, lng: c.lng };
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    function updateDistanceAvailability() {
        var note = document.getElementById('distanceNote');
        var sel = document.getElementById('filterDistance');
        var hasCenter = !!viewerCenter();
        if (note) note.hidden = hasCenter;
        if (sel) sel.disabled = !hasCenter;
    }

    function applyListFilters() {
        var cards = document.getElementById('portalListCards');
        var q = (document.getElementById('portalSearch').value || '').trim().toLowerCase();
        var cat = document.getElementById('filterCategory').value;
        var days = parseInt(document.getElementById('filterDate').value, 10);
        var maxKm = parseInt(document.getElementById('filterDistance').value, 10);
        var center = viewerCenter();
        var nowSec = Date.now() / 1000;

        var filtered = portalRequests.list.filter(function(r) {
            // Search across type / category / area
            if (q) {
                var hay = ((r.wasteType || '') + ' ' + (r.category || '') + ' ' + (r.area || '')).toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            // Category (match "Others" to anything not in the known list)
            if (cat) {
                var rc = (r.category || '').toLowerCase();
                if (cat === 'Others') {
                    var known = ['plastic', 'paper', 'metal', 'glass', 'e-waste', 'textile', 'organic'];
                    if (known.indexOf(rc) !== -1) return false;
                } else if (rc !== cat.toLowerCase()) {
                    return false;
                }
            }
            // Date window
            if (days && r.createdAt) {
                if (r.createdAt < nowSec - days * 86400) return false;
            }
            // Distance (only when we know the viewer's center and item coords)
            if (maxKm && center && typeof r.lat === 'number' && typeof r.lng === 'number') {
                var d = haversineKm(center.lat, center.lng, r.lat, r.lng);
                if (d > maxKm) return false;
            }
            return true;
        });

        renderPortalCards(cards, filtered, 'list');
    }

    // Local haversine (km) for client-side distance filtering.
    function haversineKm(lat1, lng1, lat2, lng2) {
        var R = 6371, toRad = Math.PI / 180;
        var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    function statusBadge(status) {
        var s = (status || 'open').toLowerCase();
        var label = { open: 'Pending', requested: 'Requested', accepted: 'Accepted',
                      confirmed: 'Confirmed', collecting: 'Collecting',
                      rejected: 'Rejected', collected: 'Collected', done: 'Collected',
                      cancelled: 'Cancelled', closed: 'Not selected', disputed: 'Disputed' }[s] || s;
        return '<span class="status-badge status-' + s + '">' + escapeHtml(label) + '</span>';
    }

    // fmtTime expects epoch SECONDS. New Phase-1 fields (confirmedAt/disputedAt/
    // cancelledAt/verifiedAt, collector createdAt/updatedAt) are seconds. Any
    // collect-request/message createdAt is microseconds — divide by 1e6 before
    // passing it here. As a safety net, a microsecond-scale value (far beyond
    // any plausible seconds epoch) is scaled down so it never renders as a
    // year-50000+ date.
    function fmtTime(ts) {
        if (!ts) return '';
        // Seconds epochs are ~1e9-1e10; microseconds are ~1e15. Guard the gap.
        if (ts > 1e13) ts = ts / 1e6;
        try { return new Date(ts * 1000).toLocaleString(); } catch (e) { return ''; }
    }

    function renderPortalCards(container, requests, mode) {
        if (!requests.length) {
            var emptyMsg = 'No open requests right now.';
            if (mode === 'posted') emptyMsg = 'You haven\'t listed any waste yet.';
            else if (mode === 'list') emptyMsg = 'No requests match your filters.';
            container.innerHTML = '<div class="placeholder-text">' + emptyMsg + '</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < requests.length; i++) {
            var r = requests[i];
            var loc = r.area || (r.addressMasked ? 'Location on request' : (r.fullAddress || '—'));
            html += '<div class="request-card">';
            html += '<div class="request-card-head">';
            html += '<div class="request-title">' + escapeHtml(r.wasteType || 'Waste item') + '</div>';
            html += statusBadge(r.status);
            html += '</div>';
            html += '<div class="request-submitted">Submitted ' + escapeHtml(fmtTime(r.createdAt)) + '</div>';
            html += '<div class="request-meta">';
            html += '<div><i class="fa-solid fa-location-dot"></i> ' + escapeHtml(loc) + '</div>';
            if (r.pickupTime) html += '<div><i class="fa-solid fa-clock"></i> ' + escapeHtml(r.pickupTime) + '</div>';
            html += '<div><i class="fa-solid fa-box"></i> ' +
                escapeHtml((r.category || 'Waste') + (r.weight ? ' • ' + r.weight : '')) + '</div>';
            if (r.priceType === 'free') {
                html += '<div><i class="fa-solid fa-gift"></i> Free giveaway</div>';
            } else if (r.maxPrice != null) {
                html += '<div><i class="fa-solid fa-tag"></i> Up to ' +
                    escapeHtml(String(r.maxPrice) + ' ' + (r.currency || 'MYR')) + '</div>';
            }
            html += '</div>';
            html += '<div class="request-actions">';
            html += '<button type="button" class="btn-request-view" data-req="' + escapeHtml(r.requestId) + '">View Details</button>';
            html += '<button type="button" class="btn-request-track" data-req="' + escapeHtml(r.requestId) + '">Track Request</button>';
            html += '</div>';
            html += '</div>';
        }
        container.innerHTML = html;
    }

    // Portal tab buttons
    var portalTabs = document.querySelectorAll('.portal-tab');
    for (var pt = 0; pt < portalTabs.length; pt++) {
        portalTabs[pt].addEventListener('click', function() {
            switchPortalTab(this.getAttribute('data-portal-tab'));
        });
    }

    // Search filter on the public list
    var portalSearch = document.getElementById('portalSearch');
    if (portalSearch) portalSearch.addEventListener('input', applyListFilters);
    ['filterCategory', 'filterDate', 'filterDistance'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('change', applyListFilters);
    });

    if (sideLegend) {
        sideLegend.style.cursor = 'pointer';
        sideLegend.setAttribute('role', 'button');
        sideLegend.setAttribute('tabindex', '0');
        sideLegend.addEventListener('click', function() { navigate('portal'); });
        sideLegend.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('portal'); }
        });
    }

    // Portal card actions (event delegation for View Details / Track)
    function findRequest(id) {
        var all = portalRequests.list.concat(portalRequests.history);
        for (var i = 0; i < all.length; i++) {
            if (all[i].requestId === id) return all[i];
        }
        return null;
    }

    ['portalListCards', 'historyPostedCards', 'historyCollectedCards'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('click', onPortalCardClick);
    });
    function onPortalCardClick(e) {
        var btn = e.target.closest('button[data-req]');
        if (!btn) return;
        var r = findRequest(btn.getAttribute('data-req'));
        if (!r) return;
        if (btn.classList.contains('btn-request-view')) {
            openReqDetail(r);
        } else if (btn.classList.contains('btn-request-track')) {
            // Track -> go to Notifications. For the owner's own item, open the
            // pending collect-request so they can approve/reject it there.
            var mine = Auth.profile() && Auth.profile().sub === r.ownerId;
            if (mine) {
                navigate('notifications');
                openRequestInNotifications(r.requestId);
            } else {
                openReqDetail(r);
            }
        }
    }

    // After navigating to notifications, find the pending collect-request for
    // the given waste item and show its detail (approve/reject) panel.
    function openRequestInNotifications(wasteId) {
        var attempts = 0;
        (function tryShow() {
            attempts++;
            var all = lifecycleRequests.incoming.concat(lifecycleRequests.outgoing);
            var match = null;
            for (var i = 0; i < all.length; i++) {
                if (all[i].wasteId === wasteId) {
                    // Prefer a still-actionable (requested) one.
                    if (all[i].status === 'requested') { match = all[i]; break; }
                    if (!match) match = all[i];
                }
            }
            if (match) {
                // Multiple collectors may quote the same item — show them all so
                // the owner can compare and pick one.
                renderIncomingQuotesForWaste(wasteId);
            } else if (attempts < 15) {
                setTimeout(tryShow, 200);  // wait for loadLifecycleRequests()
            }
        })();
    }

    // ===================== Request detail + lifecycle actions =====================
    var reqDetailOverlay = document.getElementById('reqDetailOverlay');
    var reqDetailClose = document.getElementById('reqDetailClose');
    var reqDetailBody = document.getElementById('reqDetailBody');
    var reqDetailActions = document.getElementById('reqDetailActions');

    function openReqDetail(r) {
        var mine = Auth.profile() && Auth.profile().sub === r.ownerId;
        var rows = '';
        rows += detailRow('Item', r.wasteType || 'Waste item');
        if (r.category) rows += detailRow('Category', r.category);
        if (r.weight) rows += detailRow('Est. weight', r.weight);
        rows += detailRow('Status', (r.status || 'open'));
        rows += detailRow('Area', r.area || 'Location on request');
        if (r.pickupTime) rows += detailRow('Pickup time', r.pickupTime);
        if (mine && r.fullAddress) rows += detailRow('Full address', r.fullAddress);
        if (r.notes) rows += detailRow('Notes', r.notes);
        reqDetailBody.innerHTML = '<div class="report-summary">' + rows + '</div>';

        hideEl('reqDetailError'); hideEl('reqDetailSuccess');

        // Actions depend on viewer + status.
        if (mine) {
            reqDetailActions.innerHTML =
                '<span class="req-detail-note">This is your listing. Manage requests in Notifications.</span>';
        } else if (r.status === 'open' || r.status === 'requested') {
            // Free giveaway: ANY logged-in user can collect, so skip the
            // collector-status gate and show the (price-less) collect form.
            if (r.priceType === 'free') {
                renderQuoteForm(r);
                reqDetailOverlay.classList.add('show');
                return;
            }
            // Paid pickup: submit a priced quote. Gate the amount form on
            // /collector/me — only an approved collector sees it; everyone else
            // sees the apply CTA. The server still re-checks on submit.
            reqDetailActions.innerHTML =
                '<span class="req-detail-note">Checking your collector status...</span>';
            collectFetch('GET', null, '/collector/me').then(function(me) {
                if (me && me.status === 'approved') {
                    renderQuoteForm(r);
                } else {
                    reqDetailActions.innerHTML =
                        '<span class="req-detail-note">You need to be a verified collector to quote — ' +
                        'apply from your Profile.</span>' +
                        '<button type="button" class="btn-profile-secondary" id="reqGotoProfileBtn">Go to Profile</button>';
                    var gp = document.getElementById('reqGotoProfileBtn');
                    if (gp) gp.addEventListener('click', function() {
                        closeReqDetail();
                        navigate('profile');
                    });
                }
            }).catch(function() {
                // If the status check fails, offer the apply CTA (safe default).
                reqDetailActions.innerHTML =
                    '<span class="req-detail-note">You need to be a verified collector to quote — ' +
                    'apply from your Profile.</span>';
            });
        } else {
            reqDetailActions.innerHTML =
                '<span class="req-detail-note">This item is already ' + escapeHtml(r.status) + '.</span>';
        }

        reqDetailOverlay.classList.add('show');
    }

    // Render the collect/"Submit Quote" form inside the request-detail overlay.
    // Free giveaways ask for no price; paid pickups keep the quote-amount input.
    function renderQuoteForm(r) {
        var isFree = r.priceType === 'free';
        var hint = '';
        if (isFree) {
            hint = '<p class="req-detail-note">Free giveaway — no payment. Send a request to collect it.</p>';
        } else if (r.maxPrice) {
            hint = '<p class="req-detail-note">Owner\'s max: ' + escapeHtml(String(r.maxPrice)) +
                ' ' + escapeHtml(r.currency || 'MYR') + '</p>';
        }
        var amountField = isFree ? '' :
            '<div class="auth-field"><label for="quoteAmount">Your quote amount</label>' +
            '<input type="number" id="quoteAmount" step="0.01" min="0" placeholder="e.g. 15.00"></div>';
        reqDetailActions.innerHTML =
            hint +
            amountField +
            '<div class="auth-field"><label for="quoteMessage">Message (optional)</label>' +
            '<textarea id="quoteMessage" rows="2" placeholder="Add a note for the owner"></textarea></div>' +
            '<button type="button" class="btn-profile-primary" id="reqQuoteBtn">' +
            (isFree ? 'Request to Collect' : 'Submit Quote') + '</button>';

        var quoteBtn = document.getElementById('reqQuoteBtn');
        if (quoteBtn) quoteBtn.addEventListener('click', function() {
            hideEl('reqDetailError'); hideEl('reqDetailSuccess');
            var body = {
                wasteId: r.requestId,
                message: document.getElementById('quoteMessage').value.trim(),
            };
            if (!isFree) {
                var amtRaw = document.getElementById('quoteAmount').value.trim();
                var amt = parseFloat(amtRaw);
                if (!amtRaw || isNaN(amt) || amt <= 0) {
                    showMsg('reqDetailError', 'Enter a quote amount greater than 0.', true);
                    return;
                }
                body.quoteAmount = amt;
            }
            quoteBtn.disabled = true;
            collectFetch('POST', body, 'request').then(function() {
                showMsg('reqDetailSuccess', 'Quote sent! The owner will review it.', false);
                reqDetailActions.innerHTML = '';
                loadPortalList();
            }).catch(function(err) {
                quoteBtn.disabled = false;
                // 403 -> not a verified collector; 400/409 -> surface server text verbatim.
                if (err.status === 403) {
                    showMsg('reqDetailError',
                        'You need to be a verified collector to quote — apply from your Profile.', true);
                } else {
                    showMsg('reqDetailError', err.message, true);
                }
            });
        });
    }

    function detailRow(label, value) {
        return '<div class="report-summary-row"><span>' + escapeHtml(label) +
            '</span><strong>' + escapeHtml(String(value)) + '</strong></div>';
    }

    function closeReqDetail() { reqDetailOverlay.classList.remove('show'); }
    if (reqDetailClose) reqDetailClose.addEventListener('click', closeReqDetail);
    reqDetailOverlay.addEventListener('click', function(e) {
        if (e.target === reqDetailOverlay) closeReqDetail();
    });

    // ===================== Notifications =====================
    var notifBtn = document.getElementById('notificationsBtn');
    var notifOverlay = document.getElementById('notifOverlay');
    var notifFeedEl = document.getElementById('notifFeed');
    var notifDetailEl = document.getElementById('notifDetail');
    var notifBadge = document.getElementById('notifBadge');
    var notifData = [];
    var lifecycleRequests = { incoming: [], outgoing: [] };

    // Router entry: notifications view visible — load feed + lifecycle data.
    function onEnterNotifications() {
        loadNotifications();
        loadLifecycleRequests();
    }

    if (notifBtn) notifBtn.addEventListener('click', function() { navigate('notifications'); });

    function refreshNotifBadge() {
        if (!collectConfigured() || !Auth.isLoggedIn()) {
            if (notifBadge) notifBadge.hidden = true;
            return;
        }
        collectFetch('GET', null, 'notifications').then(function(data) {
            var unread = (data && data.unread) || 0;
            if (notifBadge) {
                notifBadge.textContent = unread > 9 ? '9+' : String(unread);
                notifBadge.hidden = unread === 0;
            }
        }).catch(function() {});
    }

    function loadNotifications() {
        notifFeedEl.innerHTML = '<div class="placeholder-text">Loading...</div>';
        // Clear the badge immediately on viewing (don't wait for the network).
        if (notifBadge) notifBadge.hidden = true;
        collectFetch('GET', null, 'notifications').then(function(data) {
            notifData = (data && data.notifications) || [];
            renderNotifFeed();
            // Persist read state server-side (best effort).
            collectFetch('POST', null, 'notifications/read').catch(function() {});
        }).catch(function(err) {
            notifFeedEl.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
        });
    }

    function notifIcon(type) {
        return { request: 'fa-bell', approved: 'fa-circle-check', rejected: 'fa-circle-xmark',
                 done: 'fa-box-open' }[type] || 'fa-circle-info';
    }

    function renderNotifFeed() {
        if (!notifData.length) {
            notifFeedEl.innerHTML = '<div class="placeholder-text">No notifications yet.</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < notifData.length; i++) {
            var n = notifData[i];
            html += '<div class="notif-item' + (n.read ? '' : ' unread') + '" data-idx="' + i + '">';
            html += '<div class="notif-item-icon notif-' + escapeHtml(n.type || 'info') + '">' +
                '<i class="fa-solid ' + notifIcon(n.type) + '"></i></div>';
            html += '<div class="notif-item-body">';
            html += '<div class="notif-item-title">' + escapeHtml(n.title || '') + '</div>';
            html += '<div class="notif-item-text">' + escapeHtml(n.body || '') + '</div>';
            html += '</div>';
            html += '<i class="fa-solid fa-chevron-right notif-item-arrow"></i>';
            html += '</div>';
        }
        notifFeedEl.innerHTML = html;
        var items = notifFeedEl.querySelectorAll('.notif-item');
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener('click', function() {
                var n = notifData[parseInt(this.getAttribute('data-idx'), 10)];
                showNotifDetail(n);
            });
        }
    }

    function loadLifecycleRequests() {
        collectFetch('GET', null, 'requests').then(function(data) {
            lifecycleRequests.incoming = (data && data.incoming) || [];
            lifecycleRequests.outgoing = (data && data.outgoing) || [];
        }).catch(function() {});
    }

    function findCollectRequest(id) {
        var all = lifecycleRequests.incoming.concat(lifecycleRequests.outgoing);
        for (var i = 0; i < all.length; i++) {
            if (all[i].collectRequestId === id) return all[i];
        }
        return null;
    }

    function showNotifDetail(n) {
        var meta = n.meta || {};
        var cr = meta.collectRequestId ? findCollectRequest(meta.collectRequestId) : null;
        showNotifDetailForCollectRequest(cr, n.title || n.type || '');
    }

    // Owner view: list every incoming quote for one waste item so the owner can
    // compare amounts and pick one. Cards are sorted cheapest-first. Actions are
    // staged: requested->Accept, accepted->Confirm deal + Cancel, unlocked->View
    // details, terminal (rejected/closed/cancelled)->status only.
    function renderIncomingQuotesForWaste(wasteId) {
        var quotes = lifecycleRequests.incoming.filter(function(cr) {
            return cr.wasteId === wasteId && cr.role === 'owner';
        });
        quotes.sort(function(a, b) {
            return (a.quoteAmount || 0) - (b.quoteAmount || 0);
        });

        if (!quotes.length) {
            notifDetailEl.innerHTML = '<div class="placeholder-text">No quotes for this item yet.</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < quotes.length; i++) {
            var cr = quotes[i];
            var crId = escapeHtml(cr.collectRequestId);
            html += '<div class="report-summary quote-card">';
            html += detailRow('Collector', cr.collectorName || 'Collector');
            html += detailRow('Quote', (cr.quoteAmount != null ? cr.quoteAmount : '—') +
                ' ' + (cr.currency || 'MYR'));
            if (cr.maxPrice != null) html += detailRow('Your max', cr.maxPrice + ' ' + (cr.currency || 'MYR'));
            if (cr.message) html += '<div class="report-summary-row"><span>Message</span><strong>' +
                escapeHtml(cr.message) + '</strong></div>';
            html += '<div class="report-summary-row"><span>Status</span>' + statusBadge(cr.status) + '</div>';

            var actions = '';
            if (cr.status === 'requested') {
                actions = '<button type="button" class="btn-profile-primary" data-approve="' + crId + '"><i class="fa-solid fa-check"></i> Accept</button>';
            } else if (cr.status === 'accepted') {
                actions = '<button type="button" class="btn-profile-primary" data-confirm="' + crId + '"' + payAttrs(cr) + '><i class="fa-solid fa-handshake"></i> Confirm deal</button>' +
                          '<button type="button" class="btn-profile-secondary" data-cancel="' + crId + '"><i class="fa-solid fa-xmark"></i> Cancel</button>';
            } else if (cr.unlocked === true) {
                actions = '<button type="button" class="btn-profile-secondary" data-open="' + crId + '"><i class="fa-solid fa-eye"></i> View details</button>';
            }
            // Terminal (rejected/closed/cancelled/disputed): status only, no actions.
            html += '<div class="notif-detail-actions">' + actions + '</div>';
            html += '</div>';
        }

        notifDetailEl.innerHTML = html;
        wireNotifDetailActions();
    }

    // Render the detail panel for a collect request (owner: approve/reject;
    // collector: unlocked info + chat/done). Shared by notifications + Track.
    function showNotifDetailForCollectRequest(cr, typeLabel) {
        var html = '';
        html += '<div class="report-summary">';
        if (typeLabel) html += detailRow('Type', typeLabel);
        if (cr) {
            html += detailRow('Item', cr.wasteType || 'Waste item');
            html += detailRow('Status', cr.status || '');
            if (cr.role === 'owner') html += detailRow('Collector', cr.collectorName || '');
            else html += detailRow('Owner', cr.ownerName || '');
        } else {
            html += '<div class="placeholder-text">No pending request for this item yet.</div>';
        }
        html += '</div>';

        var actions = '';
        var crId = cr ? escapeHtml(cr.collectRequestId) : '';
        if (cr && cr.role === 'owner' && cr.status === 'requested') {
            actions = '<button type="button" class="btn-profile-primary" data-approve="' + crId + '"><i class="fa-solid fa-check"></i> Approve</button>' +
                      '<button type="button" class="btn-profile-delete" data-reject="' + crId + '"><i class="fa-solid fa-xmark"></i> Reject</button>';
        } else if (cr && cr.role === 'owner' && cr.status === 'accepted') {
            // Owner picked this quote but has NOT yet confirmed. No address or
            // phone is shown — the unlock point is strictly server-driven and
            // only opens after Confirm deal flips cr.unlocked server-side.
            html += '<p class="unlock-note">You picked this quote. Confirm to share your address and open chat.</p>';
            actions = '<button type="button" class="btn-profile-primary" data-confirm="' + crId + '"' + payAttrs(cr) + '><i class="fa-solid fa-handshake"></i> Confirm deal</button>' +
                      '<button type="button" class="btn-profile-secondary" data-cancel="' + crId + '"><i class="fa-solid fa-xmark"></i> Cancel</button>';
        } else if (cr && cr.unlocked === true) {
            // Server-driven unlock: cr.unlocked is true only for statuses in
            // UNLOCK_STATUSES (confirmed/collected/disputed). The frontend never
            // infers unlock from anything but the server's cr.unlocked/status.
            html += '<div class="unlock-card">';
            html += '<div class="unlock-title"><i class="fa-solid fa-lock-open"></i> Deal confirmed</div>';
            if (cr.role === 'collector') {
                if (cr.fullAddress) html += detailRow('Full address', cr.fullAddress);
                if (cr.ownerPhone) html += detailRow('Owner phone', cr.ownerPhone);
                if (cr.pickupTime) html += detailRow('Pickup time', cr.pickupTime);
                if (cr.notes) html += detailRow('Notes', cr.notes);
            }
            html += '<p class="unlock-note">Address &amp; contact unlocked. You can now chat.</p>';
            html += '</div>';
            actions = '<button type="button" class="btn-profile-primary" data-chat="' + crId + '"><i class="fa-solid fa-comments"></i> Open Chat</button>' +
                      '<button type="button" class="btn-profile-secondary" data-done="' + crId + '"><i class="fa-solid fa-flag-checkered"></i> Mark as Collected</button>';
            // Report a problem is available while confirmed/collected.
            if (cr.status === 'confirmed' || cr.status === 'collected') {
                actions += '<button type="button" class="btn-profile-secondary" data-dispute="' + crId + '"><i class="fa-solid fa-triangle-exclamation"></i> Report a problem</button>';
            }
            // The owner may still cancel a confirmed job.
            if (cr.role === 'owner' && cr.status === 'confirmed') {
                actions += '<button type="button" class="btn-profile-delete" data-cancel="' + crId + '"><i class="fa-solid fa-xmark"></i> Cancel job</button>';
            }
        }

        notifDetailEl.innerHTML = html + '<div class="notif-detail-actions">' + actions + '</div>';
        wireNotifDetailActions();
    }

    // Build the data-pay-* attributes for a Confirm-deal button. A paid item
    // carries its quote amount + currency so the confirm handler can show the
    // mock payment screen; a free item (no quoteAmount) carries nothing, so it
    // confirms with no payment step.
    function payAttrs(cr) {
        if (!cr || cr.quoteAmount == null) return '';
        return ' data-pay-amount="' + escapeHtml(String(cr.quoteAmount)) +
               '" data-pay-currency="' + escapeHtml(cr.currency || 'MYR') + '"';
    }

    // ---- Mock payment screen (DEMO ONLY — no real money, no payment processor) ----
    // Shows a fake "pay" dialog at the point where the real Stripe payment will
    // live in Phase 2. On "Pay now" it simply invokes onPaid(); it NEVER contacts
    // a payment service and moves no money. Built dynamically so it needs no
    // index.html markup, reusing the app's .overlay/.show convention.
    var _mockPayOverlay = null;
    function showMockPayment(amount, currency, onPaid) {
        if (!_mockPayOverlay) {
            _mockPayOverlay = document.createElement('div');
            _mockPayOverlay.className = 'overlay mock-pay-overlay';
            _mockPayOverlay.innerHTML =
                '<div class="overlay-card mock-pay-card">' +
                  '<div class="mock-pay-demo-tag">DEMO — no real payment is taken</div>' +
                  '<h3 class="mock-pay-title"><i class="fa-solid fa-credit-card"></i> Pay for collection</h3>' +
                  '<div class="mock-pay-amount" id="mockPayAmount"></div>' +
                  '<label class="mock-pay-label">Card number</label>' +
                  '<input class="mock-pay-input" id="mockPayCard" value="4242 4242 4242 4242" readonly>' +
                  '<div class="mock-pay-row">' +
                    '<div><label class="mock-pay-label">Expiry</label>' +
                      '<input class="mock-pay-input" value="12 / 34" readonly></div>' +
                    '<div><label class="mock-pay-label">CVC</label>' +
                      '<input class="mock-pay-input" value="123" readonly></div>' +
                  '</div>' +
                  '<div class="mock-pay-actions">' +
                    '<button type="button" class="btn-profile-secondary" id="mockPayCancel">Cancel</button>' +
                    '<button type="button" class="btn-profile-primary" id="mockPayNow"><i class="fa-solid fa-lock"></i> Pay now</button>' +
                  '</div>' +
                  '<p class="mock-pay-note">Placeholder for the Phase 2 Stripe payment. No card is charged.</p>' +
                '</div>';
            document.body.appendChild(_mockPayOverlay);
            _mockPayOverlay.addEventListener('click', function(e) {
                if (e.target === _mockPayOverlay) closeMockPayment();
            });
        }
        var amtEl = _mockPayOverlay.querySelector('#mockPayAmount');
        amtEl.textContent = (currency || 'MYR') + ' ' + amount;

        var payBtn = _mockPayOverlay.querySelector('#mockPayNow');
        var cancelBtn = _mockPayOverlay.querySelector('#mockPayCancel');
        // Replace handlers each open so a stale callback never fires.
        var newPay = payBtn.cloneNode(true);
        payBtn.parentNode.replaceChild(newPay, payBtn);
        var newCancel = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
        newPay.addEventListener('click', function() {
            closeMockPayment();
            if (typeof onPaid === 'function') onPaid();
        });
        newCancel.addEventListener('click', closeMockPayment);

        _mockPayOverlay.classList.add('show');
    }
    function closeMockPayment() {
        if (_mockPayOverlay) _mockPayOverlay.classList.remove('show');
    }

    function wireNotifDetailActions() {
        function act(suffix, id, btn) {
            btn.disabled = true;
            collectFetch('POST', { collectRequestId: id }, suffix).then(function() {
                // Refresh everything affected.
                loadNotifications();
                loadLifecycleRequests();
                refreshNotifBadge();
                notifDetailEl.innerHTML = '<div class="placeholder-text">Done. Updated.</div>';
            }).catch(function(err) {
                btn.disabled = false;
                notifDetailEl.insertAdjacentHTML('beforeend',
                    '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>');
            });
        }

        // Approve / reject / done / cancel post {collectRequestId} and refresh.
        // Multiple quote cards can be present, so wire every matching button.
        bindAll('[data-approve]', 'approve');
        bindAll('[data-reject]', 'reject');
        bindAll('[data-done]', 'done');
        bindAll('[data-cancel]', 'cancel');

        // Confirm deal: for a PAID item (the button carries a pay amount) show a
        // mock payment screen first, and only run the real 'confirm' action after
        // "Pay". A free item (no amount) confirms directly. The mock screen moves
        // NO money and has no payment processor — it is a demo placeholder that
        // marks exactly where the Phase 2 Stripe payment will later slot in.
        (function() {
            var confirmBtns = notifDetailEl.querySelectorAll('[data-confirm]');
            for (var i = 0; i < confirmBtns.length; i++) {
                (function(btn) {
                    btn.addEventListener('click', function() {
                        var id = btn.getAttribute('data-confirm');
                        var amount = btn.getAttribute('data-pay-amount');
                        var currency = btn.getAttribute('data-pay-currency') || 'MYR';
                        if (amount) {
                            // Paid item: run the mock payment screen, then confirm.
                            showMockPayment(amount, currency, function() {
                                act('confirm', id, btn);
                            });
                        } else {
                            // Free item: no payment, confirm directly.
                            act('confirm', id, btn);
                        }
                    });
                })(confirmBtns[i]);
            }
        })();

        function bindAll(selector, suffix) {
            var attr = selector.replace(/[\[\]]/g, '');  // 'data-approve'
            var btns = notifDetailEl.querySelectorAll(selector);
            for (var i = 0; i < btns.length; i++) {
                (function(btn) {
                    btn.addEventListener('click', function() {
                        act(suffix, btn.getAttribute(attr), btn);
                    });
                })(btns[i]);
            }
        }

        // Dispute: collect a reason, then POST {collectRequestId, reason} to 'dispute'.
        var disputeBtns = notifDetailEl.querySelectorAll('[data-dispute]');
        for (var d = 0; d < disputeBtns.length; d++) {
            (function(btn) {
                btn.addEventListener('click', function() {
                    var id = btn.getAttribute('data-dispute');
                    var reason = window.prompt('Describe the problem (this opens a dispute):', '');
                    if (reason === null) return;  // cancelled
                    btn.disabled = true;
                    collectFetch('POST', { collectRequestId: id, reason: reason }, 'dispute').then(function() {
                        loadNotifications();
                        loadLifecycleRequests();
                        refreshNotifBadge();
                        notifDetailEl.innerHTML = '<div class="placeholder-text">Problem reported.</div>';
                    }).catch(function(err) {
                        btn.disabled = false;
                        notifDetailEl.insertAdjacentHTML('beforeend',
                            '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>');
                    });
                });
            })(disputeBtns[d]);
        }

        // View details: re-open the single-request detail for that quote.
        var openBtns = notifDetailEl.querySelectorAll('[data-open]');
        for (var o = 0; o < openBtns.length; o++) {
            (function(btn) {
                btn.addEventListener('click', function() {
                    showNotifDetailForCollectRequest(findCollectRequest(btn.getAttribute('data-open')));
                });
            })(openBtns[o]);
        }

        var chatBtns = notifDetailEl.querySelectorAll('[data-chat]');
        for (var c = 0; c < chatBtns.length; c++) {
            (function(btn) {
                btn.addEventListener('click', function() {
                    openChatPage(btn.getAttribute('data-chat'));
                });
            })(chatBtns[c]);
        }
    }

    // ===================== P2P Chat (AppSync Events + polling fallback) =====================
    var chatPageOverlay = document.getElementById('chatPageOverlay');
    var chatConvosEl = document.getElementById('chatConvos');
    var chatThreadEl = document.getElementById('chatThread');
    var chatThreadHead = document.getElementById('chatThreadHead');
    var chatComposer = document.getElementById('chatComposer');
    var chatMsgInput = document.getElementById('chatMsgInput');
    var chatMsgSend = document.getElementById('chatMsgSend');

    var chatConvos = [];
    var activeConvo = null;        // conversationId currently open
    var chatMessages = [];         // messages for the active conversation
    var chatSocket = null;         // AppSync WebSocket
    var chatPollTimer = null;      // polling fallback timer
    var lastMsgTs = 0;             // newest message createdAt seen

    function appsyncConfigured() {
        return APPSYNC_CONFIG.realtime && APPSYNC_CONFIG.realtime.indexOf('__APPSYNC_') !== 0 &&
               APPSYNC_CONFIG.apiKey && APPSYNC_CONFIG.apiKey.indexOf('__APPSYNC_') !== 0;
    }

    // Navigate to the chat page, optionally opening a specific conversation.
    function openChatPage(conversationId) {
        navigate(conversationId ? ('chat/' + conversationId) : 'chat');
    }

    // Router entry: chat view visible — arg is optional conversationId.
    function onEnterChat(conversationId) {
        loadConversations(conversationId);
    }

    // Called by the router when leaving the chat page — tear down live connections.
    function leaveChatPage() {
        teardownRealtime();
        stopPolling();
        activeConvo = null;
    }
    window.leaveChatPage = leaveChatPage;

    function loadConversations(openId) {
        chatConvosEl.innerHTML = '<div class="placeholder-text">Loading chats...</div>';
        collectFetch('GET', null, 'conversations').then(function(data) {
            chatConvos = (data && data.conversations) || [];
            renderConvos();
            if (openId) openConversation(openId);
            else if (chatConvos.length) openConversation(chatConvos[0].conversationId);
        }).catch(function(err) {
            chatConvosEl.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
        });
    }

    function renderConvos() {
        if (!chatConvos.length) {
            chatConvosEl.innerHTML = '<div class="placeholder-text">No chats yet. Chats open after a request is approved.</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < chatConvos.length; i++) {
            var c = chatConvos[i];
            var initials = (c.otherName || '?').trim().charAt(0).toUpperCase() || '?';
            html += '<button type="button" class="chat-convo' +
                (c.conversationId === activeConvo ? ' active' : '') +
                '" data-cid="' + escapeHtml(c.conversationId) + '">';
            html += '<span class="chat-convo-avatar">' + escapeHtml(initials) + '</span>';
            html += '<span class="chat-convo-info">';
            html += '<span class="chat-convo-name">' + escapeHtml(c.otherName || 'User') + '</span>';
            html += '<span class="chat-convo-sub">' + escapeHtml(c.wasteType || '') + '</span>';
            html += '</span></button>';
        }
        chatConvosEl.innerHTML = html;
        var btns = chatConvosEl.querySelectorAll('.chat-convo');
        for (var j = 0; j < btns.length; j++) {
            btns[j].addEventListener('click', function() {
                openConversation(this.getAttribute('data-cid'));
            });
        }
    }

    function openConversation(cid) {
        activeConvo = cid;
        var convo = null;
        for (var i = 0; i < chatConvos.length; i++) {
            if (chatConvos[i].conversationId === cid) convo = chatConvos[i];
        }
        renderConvos();  // refresh active highlight
        chatThreadHead.textContent = convo
            ? ('Chat with ' + (convo.otherName || 'User') +
               (convo.wasteType ? ' (' + convo.wasteType + ')' : ''))
            : 'Conversation';
        chatComposer.hidden = false;
        chatThreadEl.innerHTML = '<div class="placeholder-text">Loading messages...</div>';
        lastMsgTs = 0;

        loadMessages(cid, true);

        // Set up realtime (or polling fallback) for the active conversation.
        teardownRealtime();
        stopPolling();
        if (appsyncConfigured()) {
            setupRealtime(cid);
        } else {
            startPolling(cid);
        }
    }

    function loadMessages(cid, scroll) {
        collectFetch('GET', null, 'messages?cr=' + encodeURIComponent(cid)).then(function(data) {
            if (cid !== activeConvo) return;  // user switched
            chatMessages = (data && data.messages) || [];
            renderMessages();
            if (scroll) scrollThread();
        }).catch(function(err) {
            chatThreadEl.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
        });
    }

    function renderMessages() {
        var me = Auth.profile() && Auth.profile().sub;
        if (!chatMessages.length) {
            chatThreadEl.innerHTML = '<div class="placeholder-text chat-empty">No messages yet. Say hello!</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < chatMessages.length; i++) {
            var m = chatMessages[i];
            var mine = m.senderId === me;
            if (m.createdAt && m.createdAt > lastMsgTs) lastMsgTs = m.createdAt;
            html += '<div class="chat-bubble ' + (mine ? 'me' : 'them') + '">';
            html += '<div class="chat-bubble-text">' + escapeHtml(m.text || '') + '</div>';
            html += '<div class="chat-bubble-time">' + escapeHtml(fmtMsgTime(m.createdAt)) + '</div>';
            html += '</div>';
        }
        chatThreadEl.innerHTML = html;
    }

    function fmtMsgTime(ts) {
        if (!ts) return '';
        try { return new Date(ts / 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return ''; }
    }

    function scrollThread() {
        chatThreadEl.scrollTop = chatThreadEl.scrollHeight;
    }

    function appendMessage(m) {
        // Avoid duplicates (realtime echo of our own send).
        for (var i = 0; i < chatMessages.length; i++) {
            if (chatMessages[i].messageId === m.messageId) return;
        }
        chatMessages.push(m);
        renderMessages();
        scrollThread();
    }

    function sendChat() {
        var text = chatMsgInput.value.trim();
        if (!text || !activeConvo) return;
        chatMsgInput.value = '';
        collectFetch('POST', { collectRequestId: activeConvo, text: text }, 'message').then(function(m) {
            appendMessage(m);
        }).catch(function(err) {
            chatMsgInput.value = text;  // restore on failure
            alert(err.message);
        });
    }

    if (chatMsgSend) chatMsgSend.addEventListener('click', sendChat);
    if (chatMsgInput) chatMsgInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    // --- Realtime via AppSync Events WebSocket ---
    function b64(obj) {
        return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function setupRealtime(cid) {
        try {
            var authObj = { host: APPSYNC_CONFIG.http, 'x-api-key': APPSYNC_CONFIG.apiKey };
            var header = b64(authObj);
            var protocols = ['aws-appsync-event-ws', 'header-' + header];
            chatSocket = new WebSocket('wss://' + APPSYNC_CONFIG.realtime + '/event/realtime', protocols);

            chatSocket.onopen = function() {
                chatSocket.send(JSON.stringify({ type: 'connection_init' }));
            };
            chatSocket.onmessage = function(evt) {
                var msg;
                try { msg = JSON.parse(evt.data); } catch (e) { return; }
                if (msg.type === 'connection_ack') {
                    var subId = 'sub-' + cid;
                    chatSocket.send(JSON.stringify({
                        type: 'subscribe',
                        id: subId,
                        channel: '/chat/' + cid,
                        authorization: { host: APPSYNC_CONFIG.http, 'x-api-key': APPSYNC_CONFIG.apiKey },
                    }));
                } else if (msg.type === 'data' && msg.event) {
                    if (cid !== activeConvo) return;
                    try {
                        var payload = JSON.parse(msg.event);
                        appendMessage(payload);
                    } catch (e) { /* ignore */ }
                }
            };
            chatSocket.onerror = function() {
                // Fall back to polling if the socket errors.
                teardownRealtime();
                startPolling(cid);
            };
            chatSocket.onclose = function() {
                // If the active conversation is still open and we have no socket,
                // ensure polling keeps messages flowing.
                if (activeConvo === cid && !chatPollTimer) startPolling(cid);
            };
        } catch (e) {
            startPolling(cid);
        }
    }

    function teardownRealtime() {
        if (chatSocket) {
            try { chatSocket.close(); } catch (e) { /* ignore */ }
            chatSocket = null;
        }
    }

    // --- Polling fallback ---
    function startPolling(cid) {
        stopPolling();
        chatPollTimer = setInterval(function() {
            if (cid !== activeConvo) { stopPolling(); return; }
            loadMessages(cid, false);
        }, 4000);
    }

    function stopPolling() {
        if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    }

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

    // ===================== Admin: collector verification queue =====================
    (function wireAdminNav() {
        var btn = document.getElementById('adminNavBtn');
        if (btn) btn.addEventListener('click', function() { navigate('admin'); });
        var sel = document.getElementById('adminStatusFilter');
        if (sel) sel.addEventListener('change', loadAdminQueue);
    })();

    // Router entry: admin view visible — load the verification queue.
    function onEnterAdmin() {
        loadAdminQueue();
    }

    function loadAdminQueue() {
        var cards = document.getElementById('adminQueueCards');
        var sel = document.getElementById('adminStatusFilter');
        if (!cards) return;
        var status = (sel && sel.value) || 'pending';
        cards.innerHTML = '<div class="placeholder-text">Loading...</div>';

        collectFetch('GET', null, '/admin/collectors?status=' + encodeURIComponent(status))
            .then(function(data) {
                renderAdminQueue(cards, (data && data.collectors) || []);
            }).catch(function(err) {
                cards.innerHTML = '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>';
            });
    }

    function renderAdminQueue(container, collectors) {
        if (!collectors.length) {
            container.innerHTML = '<div class="placeholder-text">Nothing in this queue.</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < collectors.length; i++) {
            var c = collectors[i];
            var id = escapeHtml(c.userId);
            html += '<div class="report-summary admin-collector-card" data-collector="' + id + '">';
            html += detailRow('Business', c.businessName || '—');
            html += detailRow('Registration', c.registrationNumber || '—');
            html += detailRow('License', c.wasteCarrierLicense || '—');
            html += detailRow('Service areas', (c.serviceAreas || []).join(', ') || '—');
            html += detailRow('Waste categories', (c.wasteCategories || []).join(', ') || '—');
            html += detailRow('Contact', (c.contactPhone || '') + (c.contactEmail ? ' / ' + c.contactEmail : ''));
            html += '<div class="report-summary-row"><span>Status</span>' + statusBadge(c.status) + '</div>';

            // Document View links from the presigned GET URLs the server returned.
            var docUrls = c.docUrls || {};
            var docKeys = Object.keys(docUrls);
            if (docKeys.length) {
                html += '<div class="report-summary-row"><span>Documents</span><strong>';
                for (var d = 0; d < docKeys.length; d++) {
                    var u = docUrls[docKeys[d]];
                    if (!u || !/^https?:\/\//i.test(u)) continue;
                    html += '<a href="' + escapeHtml(u) + '" target="_blank" rel="noopener noreferrer" ' +
                        'class="admin-doc-link">' + escapeHtml(docKeys[d]) + '</a> ';
                }
                html += '</strong></div>';
            }

            var actions = '';
            if (c.status === 'pending') {
                actions = '<button type="button" class="btn-profile-primary" data-admin-approve="' + id + '">Approve</button>' +
                          '<button type="button" class="btn-profile-delete" data-admin-reject="' + id + '">Reject</button>';
            } else if (c.status === 'approved') {
                actions = '<button type="button" class="btn-profile-secondary" data-admin-suspend="' + id + '">Suspend</button>';
            }
            html += '<div class="notif-detail-actions">' + actions + '</div>';
            html += '</div>';
        }
        container.innerHTML = html;
        wireAdminQueueActions(container);
    }

    function wireAdminQueueActions(container) {
        function adminAct(id, action, body, btn) {
            btn.disabled = true;
            collectFetch('POST', body || null, '/admin/collectors/' + encodeURIComponent(id) + '/' + action)
                .then(function() { loadAdminQueue(); })
                .catch(function(err) {
                    btn.disabled = false;
                    container.insertAdjacentHTML('beforeend',
                        '<div class="error-message">\u26a0\ufe0f ' + escapeHtml(err.message) + '</div>');
                });
        }

        bindAdmin('[data-admin-approve]', 'approve', null);
        bindAdmin('[data-admin-suspend]', 'suspend', null);

        function bindAdmin(selector, action, bodyFn) {
            var attr = selector.replace(/[\[\]]/g, '');
            var btns = container.querySelectorAll(selector);
            for (var i = 0; i < btns.length; i++) {
                (function(btn) {
                    btn.addEventListener('click', function() {
                        adminAct(btn.getAttribute(attr), action, bodyFn ? bodyFn() : null, btn);
                    });
                })(btns[i]);
            }
        }

        // Reject needs a reason.
        var rejectBtns = container.querySelectorAll('[data-admin-reject]');
        for (var r = 0; r < rejectBtns.length; r++) {
            (function(btn) {
                btn.addEventListener('click', function() {
                    var reason = window.prompt('Reason for rejection:', '');
                    if (reason === null) return;
                    adminAct(btn.getAttribute('data-admin-reject'), 'reject', { reason: reason }, btn);
                });
            })(rejectBtns[r]);
        }
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

    // Facility type -> label, icon, css class.
    function facilityTypeInfo(t) {
        var map = {
            recycling_center: { label: 'recycling center', icon: 'fa-recycle', cls: 'ftype-recycle' },
            disposal_station: { label: 'disposal station', icon: 'fa-dumpster', cls: 'ftype-disposal' },
            collect_company: { label: 'waste collect company', icon: 'fa-industry', cls: 'ftype-company' },
        };
        return map[t] || map.recycling_center;
    }

    // Render the "Online Trading Platforms" panel for the analyzed item.
    function renderTradingPlatforms(platforms) {
        var panel = document.getElementById('tradingPlatforms');
        if (!panel) return;
        if (!Array.isArray(platforms) || !platforms.length) {
            panel.hidden = true;
            return;
        }
        var html = '<h3 class="trading-title"><i class="fa-solid fa-tags"></i> Online Trading Platforms</h3>';
        html += '<p class="trading-sub">Search live listings to resell, donate, or trade this item \u2014 in multiple languages.</p>';
        html += '<div class="trading-list">';
        for (var i = 0; i < platforms.length; i++) {
            var p = platforms[i];
            var queries = Array.isArray(p.queries) ? p.queries : [];
            html += '<div class="trading-card">';
            html += '<div class="trading-card-head">';
            html += '<span class="trading-name">' + escapeHtml(p.name) + '</span>';
            html += '<span class="trading-type">' + escapeHtml(p.type || 'Marketplace') + '</span>';
            html += '</div>';
            if (queries.length) {
                html += '<div class="trading-queries">';
                for (var q = 0; q < queries.length; q++) {
                    var qq = queries[q];
                    if (!qq.url || !/^https?:\/\//i.test(qq.url)) continue;
                    // qq.url is already a valid, fully-encoded URL from the
                    // Lambda — only HTML-escape it for the attribute (do NOT
                    // re-encode, or %20 becomes %2520).
                    html += '<a class="trading-chip" href="' + escapeHtml(qq.url) +
                        '" target="_blank" rel="noopener noreferrer" ' +
                        'title="Search ' + escapeHtml(qq.term || '') + '">' +
                        '<span class="chip-lang">' + escapeHtml(qq.lang || '') + '</span>' +
                        escapeHtml(qq.term || 'Search') +
                        ' <i class="fa-solid fa-magnifying-glass"></i></a>';
                }
                html += '</div>';
            }
            html += '</div>';
        }
        html += '</div>';
        panel.innerHTML = html;
        panel.hidden = false;
    }

    function renderFacilities(data) {
        var listEl = document.getElementById('facilitiesList');
        var subheading = document.getElementById('facilitiesSubheading');
        // Trading platforms are a non-critical add-on — never let a problem there
        // break the facilities map/list.
        try {
            renderTradingPlatforms(data && data.trading_platforms);
        } catch (e) {
            console.error('Trading platforms render failed:', e);
            var tp = document.getElementById('tradingPlatforms');
            if (tp) tp.hidden = true;
        }

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

                var ftype = facilityTypeInfo(f.facilityType);

                // Icon (varies by facility type)
                var icon = document.createElement('div');
                icon.className = 'facility-icon ' + ftype.cls;
                icon.innerHTML = '<i class="fa-solid ' + ftype.icon + '"></i>';
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
                    '<div class="facility-name-row">' +
                        '<span class="facility-name">' + escapeHtml(f.name || 'Unknown facility') + '</span>' +
                        '<span class="facility-type-pill ' + ftype.cls + '">' + escapeHtml(ftype.label) + '</span>' +
                    '</div>' +
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

    // Resolve the initial route on load (handles deep links / refresh on a page).
    router();

})();
