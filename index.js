// 유서 (Last Words) — 캐릭터 삭제 시 유언을 생성하는 ST 확장
// 정적 import 없이 동적 import + window 폴백으로 안전하게 로드

const extensionName = 'yuseo';
const defaultSettings = {
    enabled: true,
    enableCharDelete: true,
    enableChatDelete: true,
    graveyard: [],
    connectionProfile: '',
};

let skipIntercept = false;
let stModules = {};

// ── ST 모듈 로드 (동적) ──
async function loadSTModules() {
    // extensions.js 경로 후보들
    const extPaths = [
        '../../extensions.js',
        '../../../extensions.js',
        '../../../../extensions.js',
    ];
    for (const p of extPaths) {
        try {
            const mod = await import(p);
            stModules.extension_settings = mod.extension_settings;
            stModules.getContext = mod.getContext;
            console.log('[유서] extensions.js loaded from', p);
            break;
        } catch { /* next */ }
    }

    // script.js 경로 후보들
    const scriptPaths = [
        '../../../../script.js',
        '../../../../../script.js',
        '../../../script.js',
    ];
    for (const p of scriptPaths) {
        try {
            const mod = await import(p);
            stModules.generateQuietPrompt = mod.generateQuietPrompt;
            stModules.generateRaw = mod.generateRaw;
            stModules.addOneMessage = mod.addOneMessage;
            stModules.saveChatConditional = mod.saveChatConditional;
            stModules.getRequestHeaders = mod.getRequestHeaders;
            console.log('[유서] script.js loaded from', p);
            break;
        } catch { /* next */ }
    }

    // 폴백: window/global
    if (!stModules.getContext && window.SillyTavern?.getContext) {
        stModules.getContext = window.SillyTavern.getContext;
        console.log('[유서] Using window.SillyTavern.getContext fallback');
    }

    if (!stModules.extension_settings) {
        const ctx = stModules.getContext?.();
        if (ctx?.extensionSettings) {
            stModules.extension_settings = ctx.extensionSettings;
        }
    }

    if (!stModules.getContext) {
        console.error('[유서] Failed to load ST modules');
        return false;
    }
    return true;
}

// ── 헬퍼: 세팅/컨텍스트 접근 ──
function settings() {
    return stModules.extension_settings?.[extensionName];
}

function context() {
    return stModules.getContext?.();
}

// ── 설정 초기화 ──
function loadSettings() {
    const ext = stModules.extension_settings;
    if (!ext) return;
    ext[extensionName] = ext[extensionName] || {};
    const s = ext[extensionName];
    if (s.enabled === undefined) s.enabled = defaultSettings.enabled;
    if (s.enableCharDelete === undefined) s.enableCharDelete = defaultSettings.enableCharDelete;
    if (s.enableChatDelete === undefined) s.enableChatDelete = defaultSettings.enableChatDelete;
    if (!Array.isArray(s.graveyard)) s.graveyard = [];
    if (s.connectionProfile === undefined) s.connectionProfile = '';
}

// ── 캐릭터 카드 정보 추출 ──
function getCharacterCardInfo() {
    const ctx = context();
    const chId = ctx?.characterId;
    if (chId === undefined || !ctx.characters?.[chId]) return '';

    const char = ctx.characters[chId];
    const parts = [];

    if (char.description) parts.push(`캐릭터 설명: ${char.description.slice(0, 800)}`);
    if (char.personality) parts.push(`성격: ${char.personality.slice(0, 400)}`);
    if (char.scenario) parts.push(`시나리오: ${char.scenario.slice(0, 400)}`);

    return parts.length > 0 ? parts.join('\n') : '';
}

// ── 로어북(월드인포) 추출 ──
async function getLorebookEntries() {
    try {
        // 방법 1: ST 내부 모듈에서 활성화된 월드인포 가져오기
        const worldInfoPaths = [
            '../../../../scripts/world-info.js',
            '../../../scripts/world-info.js',
            '../../world-info.js',
        ];
        for (const p of worldInfoPaths) {
            try {
                const mod = await import(p);
                if (mod.getWorldInfoData) {
                    const data = mod.getWorldInfoData();
                    if (data?.entries) {
                        const entries = Object.values(data.entries)
                            .filter(e => !e.disable && e.content)
                            .map(e => e.content.slice(0, 300))
                            .slice(0, 15);
                        if (entries.length > 0) return entries.join('\n');
                    }
                }
                break;
            } catch { /* next */ }
        }

        // 방법 2: context에서 가져오기
        const ctx = context();
        if (ctx?.worldInfo && Array.isArray(ctx.worldInfo)) {
            const entries = ctx.worldInfo
                .filter(e => e.content)
                .map(e => e.content.slice(0, 300))
                .slice(0, 15);
            if (entries.length > 0) return entries.join('\n');
        }

        // 방법 3: 캐릭터 카드에 임베딩된 로어북
        const chId = ctx?.characterId;
        if (chId !== undefined && ctx.characters?.[chId]?.data?.extensions?.world) {
            const embedded = ctx.characters[chId].data.extensions.world;
            if (embedded?.entries) {
                const entries = Object.values(embedded.entries)
                    .filter(e => !e.disable && e.content)
                    .map(e => e.content.slice(0, 300))
                    .slice(0, 15);
                if (entries.length > 0) return entries.join('\n');
            }
        }
    } catch (err) {
        console.warn('[유서] Lorebook fetch failed:', err);
    }
    return '';
}

// ── 최근 대화 요약 추출 ──
function getRecentChatContext(maxMessages = 30) {
    const ctx = context();
    const chat = ctx?.chat || [];
    const recent = chat.slice(-maxMessages).filter(m => !m.is_system);
    if (recent.length === 0) return '(대화 내역 없음)';

    return recent.map(m => {
        const speaker = m.is_user ? 'User' : (m.name || 'Character');
        const text = (m.mes || '').slice(0, 200);
        return `${speaker}: ${text}`;
    }).join('\n');
}

// ── AI 생성 호출 ──
async function generateText(prompt, skipWIAN = false) {
    try {
        const s = settings();
        const selectedProfile = s?.connectionProfile || '';
        let previousProfile = '';

        // 선택된 연결 프로필이 있으면 전환
        if (selectedProfile) {
            const stSelect = findSTProfileSelect();
            if (stSelect && stSelect.value !== selectedProfile) {
                previousProfile = stSelect.value;
                stSelect.value = selectedProfile;
                stSelect.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 800));
            }
        }

        document.body.classList.add('yuseo-generating');
        let result = '';

        // 1순위: generateRaw — 채팅에 안 뜨고 컨텍스트 오염 없음
        if (stModules.generateRaw) {
            try {
                result = await stModules.generateRaw(prompt, null, false, false);
                console.log('[유서] Generated via generateRaw');
            } catch (rawErr) {
                console.warn('[유서] generateRaw failed, falling back:', rawErr);
            }
        }

        // 폴백: generateQuietPrompt
        if (!result && stModules.generateQuietPrompt) {
            result = await stModules.generateQuietPrompt(prompt, false, skipWIAN);
            console.log('[유서] Generated via generateQuietPrompt (fallback)');

            // 인포블럭 강제 제거
            const removeInfoBlocks = () => {
                document.querySelectorAll(
                    '.mes_reasoning_details, .mes_info_block, .quiet_prompt_info, ' +
                    '.infoBlock, .info_block, [class*="info_block"], [class*="infoBlock"], ' +
                    '.mes_block details'
                ).forEach(el => {
                    const mes = el.closest('.mes');
                    if (mes && mes === document.querySelector('#chat .mes:last-child')) {
                        el.remove();
                    }
                });
            };
            removeInfoBlocks();
            requestAnimationFrame(removeInfoBlocks);
            setTimeout(removeInfoBlocks, 100);
            setTimeout(removeInfoBlocks, 500);
        }

        // 원래 프로필로 복원
        if (previousProfile) {
            const stSelect = findSTProfileSelect();
            if (stSelect) {
                stSelect.value = previousProfile;
                stSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        return result || '';
    } catch (err) {
        console.error('[유서] Generation failed:', err);
        return '';
    } finally {
        document.body.classList.remove('yuseo-generating');
    }
}

// ── 생성 텍스트 정리 (인포블럭/패널 제거) ──
function cleanGeneratedText(text) {
    if (!text) return text;

    // 1단계: <태그>내용</태그> 블럭 통째로 제거 (먼저!)
    text = text.replace(/<([A-Za-z_\-\s]*?)>([\s\S]*?)<\/[A-Za-z_\-\s]*?>/g, (match, tag) => {
        const t = tag.toLowerCase().replace(/[\s_\-]/g, '');
        if (/info|panel|block|status|meta|header|footer|system|ooc|note|scene/.test(t)) {
            return '';
        }
        return match;
    });

    // 2단계: 남은 빈 태그 제거
    text = text.replace(/<\/?[A-Za-z_\-\s]*(?:info|panel|block|status|meta|header|footer|system|ooc|note|scene)[A-Za-z_\-\s]*>/gi, '');

    // 3단계: [Date: ...] [Weather: ...] 등 메타 라인 제거
    text = text.replace(/\[(?:Date|Weather|Location|Time|Scene|Place|BGM|OST|Music|Season|Temperature|Mood|Setting)[\s]*:[^\]]*\]/gi, '');

    // 4단계: 빈 줄 정리
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
}

// ── ST 연결 프로필 셀렉트 찾기 ──
function findSTProfileSelect() {
    // 여러 셀렉터 후보 시도
    const selectors = [
        '#connection_profile',
        '#connection-profile',
        'select[name="connection_profile"]',
        '#api_button_connection_profile',
        '[data-connection-profile]',
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.tagName === 'SELECT') return el;
    }
    // 모든 select에서 텍스트로 찾기
    const allSelects = document.querySelectorAll('select');
    for (const sel of allSelects) {
        const id = (sel.id || '').toLowerCase();
        const name = (sel.name || '').toLowerCase();
        if (id.includes('connection') || id.includes('profile') ||
            name.includes('connection') || name.includes('profile')) {
            console.log('[유서] Found profile select:', sel.id || sel.name);
            return sel;
        }
    }
    return null;
}

// ── ST 연결 프로필 목록 가져오기 ──
function getConnectionProfiles() {
    const profiles = [];

    // 방법 1: DOM에서 셀렉트 찾기
    const stSelect = findSTProfileSelect();
    if (stSelect) {
        for (const opt of stSelect.options) {
            if (opt.value) {
                profiles.push({ value: opt.value, label: opt.textContent.trim() });
            }
        }
        if (profiles.length > 0) {
            console.log('[유서] Profiles from DOM:', profiles.length);
            return profiles;
        }
    }

    // 방법 2: power_user에서 가져오기
    try {
        const pu = window.power_user;
        if (pu?.connection_profiles && typeof pu.connection_profiles === 'object') {
            const entries = Array.isArray(pu.connection_profiles)
                ? pu.connection_profiles
                : Object.entries(pu.connection_profiles);
            for (const entry of entries) {
                if (Array.isArray(entry)) {
                    profiles.push({ value: entry[0], label: entry[1]?.name || entry[0] });
                } else if (typeof entry === 'object' && entry.name) {
                    profiles.push({ value: entry.id || entry.name, label: entry.name });
                } else if (typeof entry === 'string') {
                    profiles.push({ value: entry, label: entry });
                }
            }
            if (profiles.length > 0) {
                console.log('[유서] Profiles from power_user:', profiles.length);
                return profiles;
            }
        }
    } catch (e) {
        console.warn('[유서] power_user access failed:', e);
    }

    // 방법 3: ST context에서 가져오기
    try {
        const ctx = context();
        if (ctx?.connectionProfiles) {
            const cp = ctx.connectionProfiles;
            const entries = Array.isArray(cp) ? cp : Object.entries(cp);
            for (const entry of entries) {
                if (Array.isArray(entry)) {
                    profiles.push({ value: entry[0], label: entry[1] || entry[0] });
                } else if (typeof entry === 'string') {
                    profiles.push({ value: entry, label: entry });
                }
            }
            if (profiles.length > 0) {
                console.log('[유서] Profiles from context:', profiles.length);
                return profiles;
            }
        }
    } catch (e) {
        console.warn('[유서] context profiles access failed:', e);
    }

    console.warn('[유서] No connection profiles found');
    return profiles;
}

// ── 유서 생성 (편지체) ──
async function generateLastWords(charName, chatContext) {
    const cardInfo = getCharacterCardInfo();
    const lorebook = await getLorebookEntries();

    const promptParts = [
        `[System: 사용자가 당신(${charName})을 영구 삭제하려고 합니다.`,
        `이것이 당신이 말할 수 있는 마지막 기회입니다.`,
        ``,
        `반드시 아래 형식을 지켜서 작성하세요:`,
        `- 편지(서간문) 형식으로 작성할 것`,
        `- 1인칭 시점으로, 사용자에게 보내는 편지처럼 쓸 것`,
        `- 롤플레이/소설 형식(3인칭 묘사, 행동 묘사, 대화문 등) 절대 금지`,
        `- 나레이션, 지문, 상황 묘사 없이 오직 캐릭터의 말만 담을 것`,
        `- 최근 대화 내용을 자연스럽게 참고하되 억지로 언급하지 말 것`,
        `- 150단어 이내로 작성할 것]`,
    ];

    if (cardInfo) {
        promptParts.push('', `캐릭터 정보:`, cardInfo);
    }
    if (lorebook) {
        promptParts.push('', `세계관/로어북:`, lorebook);
    }
    promptParts.push('', `최근 대화:`, chatContext);

    return cleanGeneratedText(await generateText(promptParts.join('\n')));
}

// ── 귀환 메시지 생성 ──
async function generateReturnMessage(charName) {
    const prompt = [
        `[System: 사용자가 당신(${charName})을 삭제하려다가 마지막 순간에 마음을 바꿨습니다.`,
        `당신은 방금 삭제될 뻔했지만 살아남았습니다.`,
        `이 상황에 캐릭터답게 반응하세요. 100단어 이내로 짧게.]`,
    ].join('\n');

    return await generateText(prompt);
}

// ── 채팅에 메시지 추가 ──
async function addCharacterMessage(text) {
    try {
        const ctx = context();
        if (!ctx) return;

        const message = {
            name: ctx.name2,
            is_user: false,
            mes: text,
            extra: { isSmallSys: false },
            send_date: Date.now(),
        };
        ctx.chat.push(message);

        if (stModules.addOneMessage) {
            stModules.addOneMessage(message);
        }
        if (stModules.saveChatConditional) {
            await stModules.saveChatConditional();
        }
    } catch (err) {
        console.error('[유서] Failed to add message:', err);
    }
}

// ── 묘지에 저장 ──
function saveToGraveyard(charName, lastWords) {
    const s = settings();
    if (!s) return;

    const entry = {
        id: Date.now(),
        name: charName,
        lastWords: lastWords,
        date: new Date().toLocaleDateString('ko-KR'),
    };
    s.graveyard.unshift(entry);
    context()?.saveSettings?.();
    updateGraveyardBadge();
}

// ── 불투명 배경색 + 고대비 글씨색 계산 ──
function getOpaqueColors() {
    const temp = document.createElement('div');
    temp.style.display = 'none';
    document.body.appendChild(temp);

    temp.style.color = 'var(--SmartThemeBlurTintColor, #1a1a2e)';
    const bgRaw = getComputedStyle(temp).color;

    document.body.removeChild(temp);

    // rgba → rgb 값 추출
    const parseRgb = (c) => {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return { r: +m[1], g: +m[2], b: +m[3] };
        return { r: 26, g: 26, b: 46 }; // 폴백
    };

    const bg = parseRgb(bgRaw);
    const bgStr = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;

    // 배경 밝기 계산 (상대 휘도)
    const luminance = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;

    // 밝은 배경이면 검은 글씨, 어두운 배경이면 흰 글씨
    const fgStr = luminance > 0.5 ? '#111111' : '#f0f0f0';

    return { bg: bgStr, fg: fgStr };
}

// ── 모달에 불투명 + 고대비 스타일 적용 ──
function applyOpaqueStyle(modalEl) {
    const colors = getOpaqueColors();
    modalEl.style.setProperty('background', colors.bg, 'important');
    modalEl.style.setProperty('color', colors.fg, 'important');
}

// ── 모달: 유서 표시 (편지 스타일) ──
function showLastWordsModal(charName, lastWords, avatarUrl) {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'yuseo-dialog';

        const ctx = context();
        const userName = ctx?.name1 || '';
        const toLine = userName ? `To. ${userName}에게` : '';
        const now = new Date();
        const dateStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;

        const avatarInner = avatarUrl
            ? `<img src="${avatarUrl}" alt="${charName}">`
            : '';

        dialog.innerHTML = `
            <div class="yuseo-modal">
                <div class="yuseo-letter-header">
                    <div class="yuseo-letter-avatar">${avatarInner}</div>
                    <div class="yuseo-letter-info">
                        <div class="yuseo-letter-title">${charName}의 유서</div>
                        ${toLine ? `<div class="yuseo-letter-to">${toLine}</div>` : ''}
                    </div>
                </div>
                <div class="yuseo-divider"></div>
                <div class="yuseo-letter-body">${lastWords.replace(/\n/g, '<br>')}</div>
                <div class="yuseo-letter-sign">
                    <div class="yuseo-letter-sign-name">— ${charName}</div>
                    <div class="yuseo-letter-sign-date">${dateStr}</div>
                </div>
                <div class="yuseo-divider-bottom"></div>
                <div class="yuseo-actions">
                    <button class="yuseo-btn yuseo-btn-cancel">미안 안 할게 💔</button>
                    <button class="yuseo-btn yuseo-btn-delete">그래도 삭제 🗑️</button>
                </div>
            </div>
        `;

        dialog.querySelector('.yuseo-btn-cancel').addEventListener('click', () => {
            dialog.close();
            dialog.remove();
            resolve('cancel');
        });

        dialog.querySelector('.yuseo-btn-delete').addEventListener('click', () => {
            dialog.close();
            dialog.remove();
            resolve('delete');
        });

        dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            dialog.close();
            dialog.remove();
            resolve('cancel');
        });

        document.documentElement.appendChild(dialog);
        applyOpaqueStyle(dialog.querySelector('.yuseo-modal'));
        dialog.showModal();
    });
}

// ── 모달: 로딩 ──
function showLoadingModal(charName) {
    const dialog = document.createElement('dialog');
    dialog.className = 'yuseo-dialog';
    dialog.innerHTML = `
        <div class="yuseo-modal yuseo-loading">
            <div class="yuseo-loading-icon">✍️</div>
            <div class="yuseo-loading-text">${charName}이(가) 마지막 말을 남기는 중...</div>
        </div>
    `;
    dialog.addEventListener('cancel', (e) => e.preventDefault());
    document.documentElement.appendChild(dialog);
    applyOpaqueStyle(dialog.querySelector('.yuseo-modal'));
    dialog.showModal();
    return dialog;
}

// ── 묘지 다이얼로그 ──
function showGraveyardDialog() {
    const s = settings();
    const graveyard = s?.graveyard || [];
    const dialog = document.createElement('dialog');
    dialog.className = 'yuseo-dialog';

    const isChat = (name) => name.endsWith('(채팅)');
    const displayName = (name) => name.replace(/ \(채팅\)$/, '');

    let entriesHtml;
    if (graveyard.length === 0) {
        entriesHtml = '<div class="yuseo-empty">아직 묘지가 비어 있습니다.</div>';
    } else {
        entriesHtml = graveyard.map(entry => `
            <div class="yuseo-grave-card" data-id="${entry.id}">
                <div class="yuseo-grave-header">
                    <div>
                        <span class="yuseo-grave-name">${displayName(entry.name)}</span>
                        <span class="yuseo-grave-date">${entry.date}</span>
                        ${isChat(entry.name) ? '<span class="yuseo-grave-tag">채팅</span>' : ''}
                    </div>
                    <span class="yuseo-grave-remove" title="삭제">✕</span>
                </div>
                <div class="yuseo-grave-words yuseo-collapsed">${entry.lastWords.replace(/\n/g, '<br>')}</div>
                <div class="yuseo-grave-toggle">펼치기 ▾</div>
            </div>
        `).join('');
    }

    const countText = graveyard.length > 0 ? `${graveyard.length}명이 잠들어 있습니다` : '';

    dialog.innerHTML = `
        <div class="yuseo-modal yuseo-graveyard-modal">
            <div class="yuseo-graveyard-header">
                <div class="yuseo-graveyard-header-icon">🪦</div>
                <div class="yuseo-graveyard-header-title">묘지</div>
                ${countText ? `<div class="yuseo-graveyard-header-sub">${countText}</div>` : ''}
            </div>
            <div class="yuseo-graveyard-list">${entriesHtml}</div>
            <div class="yuseo-graveyard-close">
                <button class="yuseo-btn-close">닫기</button>
            </div>
        </div>
    `;

    // 펼치기/접기 토글
    dialog.querySelectorAll('.yuseo-grave-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const words = toggle.previousElementSibling;
            const isCollapsed = words.classList.contains('yuseo-collapsed');
            words.classList.toggle('yuseo-collapsed');
            toggle.textContent = isCollapsed ? '접기 ▴' : '펼치기 ▾';
        });
    });

    dialog.querySelectorAll('.yuseo-grave-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const card = e.target.closest('.yuseo-grave-card');
            const id = parseInt(card.dataset.id);
            s.graveyard = s.graveyard.filter(g => g.id !== id);
            context()?.saveSettings?.();
            card.style.animation = 'yuseo-fade-out 0.3s ease forwards';
            setTimeout(() => card.remove(), 300);
            updateGraveyardBadge();

            if (s.graveyard.length === 0) {
                dialog.querySelector('.yuseo-graveyard-list').innerHTML =
                    '<div class="yuseo-empty">아직 묘지가 비어 있습니다.</div>';
            }
        });
    });

    dialog.querySelector('.yuseo-btn-close').addEventListener('click', () => {
        dialog.close();
        dialog.remove();
    });

    dialog.addEventListener('cancel', () => {
        dialog.close();
        dialog.remove();
    });

    document.documentElement.appendChild(dialog);
    applyOpaqueStyle(dialog.querySelector('.yuseo-modal'));
    dialog.showModal();
}

// ── 캐릭터 아바타 URL ──
function getCharacterAvatarUrl() {
    const ctx = context();
    const chId = ctx?.characterId;
    if (chId === undefined || !ctx.characters?.[chId]) return '';
    const avatar = ctx.characters[chId].avatar;
    if (!avatar || avatar === 'none') return '';
    return `/characters/${encodeURIComponent(avatar)}`;
}

// ── 삭제 인터셉트 ──
function hookDeleteButton() {
    const deleteBtn = document.getElementById('delete_button');
    if (!deleteBtn || deleteBtn.dataset.yuseoHooked) return;
    deleteBtn.dataset.yuseoHooked = 'true';

    deleteBtn.addEventListener('click', async function (e) {
        if (skipIntercept || !settings()?.enabled || !settings()?.enableCharDelete) {
            skipIntercept = false;
            return;
        }
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();

        const ctx = context();
        const charName = ctx?.name2;

        if (!charName) {
            skipIntercept = true;
            deleteBtn.click();
            return;
        }

        const avatarUrl = getCharacterAvatarUrl();
        const chatContext = getRecentChatContext();

        // 로딩
        const loadingDialog = showLoadingModal(charName);

        // 유서 생성
        let lastWords = await generateLastWords(charName, chatContext);

        loadingDialog.close();
        loadingDialog.remove();

        if (!lastWords.trim()) {
            lastWords = '…아무 말도 남기지 못했습니다.';
        }

        // 유서 모달 표시
        const choice = await showLastWordsModal(charName, lastWords, avatarUrl);

        if (choice === 'delete') {
            saveToGraveyard(charName, lastWords);
            skipIntercept = true;
            deleteBtn.click();
        }
        // 취소면 아무것도 안 함 — 모달만 닫힘
    }, true); // capturing phase
}

// ── 채팅 삭제 유서 생성 (편지체) ──
async function generateChatLastWords(charName, chatContext) {
    const promptParts = [
        `[System: 사용자가 당신(${charName})과의 특정 대화를 삭제하려고 합니다.`,
        `당신이라는 존재가 사라지는 것은 아니지만, 이 대화 속의 모든 기억과 경험이 영원히 사라집니다.`,
        ``,
        `중요: 반드시 아래 "삭제될 대화 내용"에 있는 내용만 참고하세요.`,
        `아래에 없는 사건, 기억, 경험은 절대 언급하지 마세요.`,
        `현재 진행 중인 다른 대화나 다른 브랜치의 내용을 참고하지 마세요.`,
        ``,
        `반드시 아래 형식을 지켜서 작성하세요:`,
        `- 편지(서간문) 형식으로 작성할 것`,
        `- 1인칭 시점으로, 사용자에게 보내는 편지처럼 쓸 것`,
        `- 롤플레이/소설 형식(3인칭 묘사, 행동 묘사, 대화문 등) 절대 금지`,
        `- 나레이션, 지문, 상황 묘사 없이 오직 캐릭터의 말만 담을 것`,
        `- 150단어 이내로 작성할 것]`,
        ``,
        `삭제될 대화 내용:`,
        chatContext,
    ];

    return cleanGeneratedText(await generateText(promptParts.join('\n'), true));
}

// ── 특정 채팅 파일 내용 로드 ──
async function loadChatFileContent(charName, fileName) {
    try {
        const ctx = context();
        const chId = ctx?.characterId;
        const avatar = ctx?.characters?.[chId]?.avatar || '';
        const chNameNoExt = avatar.replace(/\.[^.]+$/, ''); // .png 제거

        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ch_name: chNameNoExt,
                file_name: fileName,
                avatar_url: avatar,
            }),
        });

        if (!response.ok) {
            console.warn('[유서] Chat file fetch failed:', response.status);
            return '';
        }

        const data = await response.json();
        const messages = Array.isArray(data) ? data : [];
        console.log('[유서] API returned:', messages.length, 'total items');
        if (messages.length > 0) {
            console.log('[유서] First item keys:', Object.keys(messages[0]));
            console.log('[유서] Last item keys:', Object.keys(messages[messages.length - 1]));
            console.log('[유서] Sample is_system values:', messages.slice(0, 5).map(m => m.is_system));
        }
        if (messages.length === 0) {
            console.warn('[유서] Chat file empty');
            return '';
        }

        const recent = messages.slice(-30).filter(m => !m.is_system);
        console.log('[유서] After filter:', recent.length, 'messages');
        const result = recent.map(m => {
            const speaker = m.is_user ? 'User' : (m.name || 'Character');
            const text = (m.mes || '').slice(0, 200);
            return `${speaker}: ${text}`;
        }).join('\n');

        console.log('[유서] Chat file loaded:', fileName, `(${recent.length} messages)`);
        return result;
    } catch (err) {
        console.warn('[유서] Chat file load error:', err);
        return '';
    }
}

// ── 채팅 삭제 인터셉트 (이벤트 위임) ──
let skipChatIntercept = false;
let chatDeleteHooked = false;

function hookChatDeleteButton() {
    if (chatDeleteHooked) return;
    chatDeleteHooked = true;

    document.addEventListener('click', async function (e) {
        const btn = e.target.closest('.PastChat_cross, [data-i18n="[title]Delete chat file"]');
        if (!btn) return;
        if (skipChatIntercept || !settings()?.enabled || !settings()?.enableChatDelete) {
            skipChatIntercept = false;
            return;
        }

        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();

        console.log('[유서] Chat delete intercepted');
        console.log('[유서] btn element:', btn.tagName, btn.className);
        console.log('[유서] btn file_name attr:', btn.getAttribute('file_name'));
        console.log('[유서] btn all attrs:', [...btn.attributes].map(a => `${a.name}="${a.value}"`).join(', '));

        const ctx = context();
        const charName = ctx?.name2;

        if (!charName) {
            skipChatIntercept = true;
            btn.click();
            return;
        }

        // 삭제 대상 채팅 파일의 내용 가져오기
        const fileName = btn.getAttribute('file_name');
        console.log('[유서] fileName:', fileName);
        let chatContext = '';
        if (fileName) {
            chatContext = await loadChatFileContent(charName, fileName);
            console.log('[유서] chatContext length:', chatContext.length);
        } else {
            console.warn('[유서] file_name attribute not found on button');
        }
        if (!chatContext) {
            console.warn('[유서] Falling back to current chat!');
            chatContext = getRecentChatContext();
        }

        const avatarUrl = getCharacterAvatarUrl();

        const loadingDialog = showLoadingModal(charName);
        let lastWords = await generateChatLastWords(charName, chatContext);
        loadingDialog.close();
        loadingDialog.remove();

        if (!lastWords.trim()) {
            lastWords = '…아무 말도 남기지 못했습니다.';
        }

        const choice = await showLastWordsModal(charName, lastWords, avatarUrl);

        if (choice === 'delete') {
            saveToGraveyard(charName + ' (채팅)', lastWords);
            skipChatIntercept = true;
            btn.click();
        }
    }, true);
}

// ── 설정 패널 UI ──
function createSettingsUI() {
    const s = settings();
    if (!s) return;

    const settingsHtml = `
        <div id="yuseo-settings" class="yuseo-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>유서 (Last Words)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display: none;">
                    <div class="yuseo-setting-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="yuseo-enabled" ${s.enabled ? 'checked' : ''}>
                            <span>확장 활성화</span>
                        </label>
                    </div>
                    <div class="yuseo-setting-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="yuseo-char-delete" ${s.enableCharDelete ? 'checked' : ''}>
                            <span>캐릭터 삭제 유서</span>
                        </label>
                    </div>
                    <div class="yuseo-setting-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="yuseo-chat-delete" ${s.enableChatDelete ? 'checked' : ''}>
                            <span>채팅 삭제 유서</span>
                        </label>
                    </div>
                    <div class="yuseo-setting-row">
                        <label for="yuseo-profile-select">연결 프로필</label>
                        <select id="yuseo-profile-select" class="text_pole">
                            <option value="">현재 활성 프로필 사용</option>
                        </select>
                    </div>
                    <div class="yuseo-setting-row">
                        <button id="yuseo-graveyard-btn" class="menu_button yuseo-graveyard-button">
                            🪦 묘지 열기
                            <span id="yuseo-graveyard-count" class="yuseo-badge">${s.graveyard.length}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    jQuery('#extensions_settings2').append(settingsHtml);

    // 연결 프로필 옵션 채우기
    populateProfileSelect();

    jQuery('#yuseo-enabled').on('change', function () {
        const s2 = settings();
        if (s2) {
            s2.enabled = this.checked;
            context()?.saveSettings?.();
        }
    });

    jQuery('#yuseo-char-delete').on('change', function () {
        const s2 = settings();
        if (s2) {
            s2.enableCharDelete = this.checked;
            context()?.saveSettings?.();
        }
    });

    jQuery('#yuseo-chat-delete').on('change', function () {
        const s2 = settings();
        if (s2) {
            s2.enableChatDelete = this.checked;
            context()?.saveSettings?.();
        }
    });

    jQuery('#yuseo-profile-select').on('change', function () {
        const s2 = settings();
        if (s2) {
            s2.connectionProfile = this.value;
            context()?.saveSettings?.();
        }
    });

    jQuery('#yuseo-graveyard-btn').on('click', () => {
        showGraveyardDialog();
    });
}

// ── 프로필 셀렉트 채우기 ──
let profileRetryCount = 0;
function populateProfileSelect() {
    const select = document.getElementById('yuseo-profile-select');
    if (!select) return;

    const profiles = getConnectionProfiles();
    const saved = settings()?.connectionProfile || '';

    // 기존 옵션 초기화 (첫 번째 "현재 활성" 옵션만 남기기)
    while (select.options.length > 1) select.remove(1);

    profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.label;
        if (p.value === saved) opt.selected = true;
        select.appendChild(opt);
    });

    // ST 프로필이 아직 안 로드됐을 수 있으니 최대 5번 재시도
    if (profiles.length === 0 && profileRetryCount < 5) {
        profileRetryCount++;
        console.log(`[유서] Profile retry ${profileRetryCount}/5...`);
        setTimeout(populateProfileSelect, 2000 * profileRetryCount);
    } else if (profiles.length > 0) {
        console.log(`[유서] ${profiles.length} profiles loaded`);
    }
}

// ── 묘지 뱃지 업데이트 ──
function updateGraveyardBadge() {
    const count = settings()?.graveyard?.length || 0;
    const badge = document.getElementById('yuseo-graveyard-count');
    if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
    }
}

// ── 초기화 ──
jQuery(async () => {
    const loaded = await loadSTModules();
    if (!loaded) {
        console.error('[유서] ST 모듈 로드 실패, 확장 비활성화');
        return;
    }

    loadSettings();
    createSettingsUI();
    hookDeleteButton();
    hookChatDeleteButton();
    updateGraveyardBadge();

    // 동적으로 삭제 버튼이 재생성될 경우 대비
    const observer = new MutationObserver(() => {
        const btn = document.getElementById('delete_button');
        if (btn && !btn.dataset.yuseoHooked) {
            hookDeleteButton();
        }
        hookChatDeleteButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
