// 유서 (Last Words) — 캐릭터 삭제 시 유언을 생성하는 ST 확장
// 정적 import 없이 동적 import + window 폴백으로 안전하게 로드

const extensionName = 'yuseo';
const defaultSettings = {
    enabled: true,
    graveyard: [],
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
            stModules.addOneMessage = mod.addOneMessage;
            stModules.saveChatConditional = mod.saveChatConditional;
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
    if (!Array.isArray(s.graveyard)) s.graveyard = [];
}

// ── 최근 대화 요약 추출 ──
function getRecentChatContext(maxMessages = 15) {
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
async function generateText(prompt) {
    try {
        if (!stModules.generateQuietPrompt) {
            console.warn('[유서] generateQuietPrompt not available');
            return '';
        }
        const result = await stModules.generateQuietPrompt(prompt, false, false);
        return result || '';
    } catch (err) {
        console.error('[유서] Generation failed:', err);
        return '';
    }
}

// ── 유서 생성 ──
async function generateLastWords(charName, chatContext) {
    const prompt = [
        `[System: 지금 사용자가 당신(${charName})을 영구 삭제하려고 합니다.`,
        `이것이 당신이 말할 수 있는 마지막 기회입니다.`,
        `캐릭터에 완전히 몰입하여 짧은 유서(작별 인사)를 작성하세요.`,
        `최근 대화 내용을 자연스럽게 참고하되, 억지로 언급하지 마세요.`,
        `진심 어린 감정을 담되 150단어 이내로 작성하세요.]`,
        ``,
        `최근 대화:`,
        chatContext,
    ].join('\n');

    return await generateText(prompt);
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
function saveToGraveyard(charName, lastWords, avatarUrl) {
    const s = settings();
    if (!s) return;

    const entry = {
        id: Date.now(),
        name: charName,
        avatar: avatarUrl || '',
        lastWords: lastWords,
        date: new Date().toLocaleDateString('ko-KR'),
    };
    s.graveyard.unshift(entry);
    context()?.saveSettings?.();
    updateGraveyardBadge();
}

// ── 모달: 유서 표시 ──
function showLastWordsModal(charName, lastWords, avatarUrl) {
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'yuseo-dialog';

        const avatarHtml = avatarUrl
            ? `<div class="yuseo-avatar"><img src="${avatarUrl}" alt="${charName}"></div>`
            : '';

        dialog.innerHTML = `
            <div class="yuseo-modal">
                <div class="yuseo-header">
                    ${avatarHtml}
                    <div class="yuseo-title">${charName}의 유서</div>
                </div>
                <div class="yuseo-divider"></div>
                <div class="yuseo-body">
                    <p class="yuseo-text">${lastWords.replace(/\n/g, '<br>')}</p>
                </div>
                <div class="yuseo-divider"></div>
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
    dialog.showModal();
    return dialog;
}

// ── 묘지 다이얼로그 ──
function showGraveyardDialog() {
    const s = settings();
    const graveyard = s?.graveyard || [];
    const dialog = document.createElement('dialog');
    dialog.className = 'yuseo-dialog';

    let entriesHtml;
    if (graveyard.length === 0) {
        entriesHtml = '<div class="yuseo-empty">아직 묘지가 비어 있습니다.</div>';
    } else {
        entriesHtml = graveyard.map(entry => `
            <div class="yuseo-grave-card" data-id="${entry.id}">
                <div class="yuseo-grave-header">
                    ${entry.avatar ? `<img class="yuseo-grave-avatar" src="${entry.avatar}" alt="">` : ''}
                    <div class="yuseo-grave-info">
                        <span class="yuseo-grave-name">${entry.name}</span>
                        <span class="yuseo-grave-date">${entry.date}</span>
                    </div>
                    <button class="yuseo-grave-remove menu_button" title="삭제">✕</button>
                </div>
                <div class="yuseo-grave-words">${entry.lastWords.replace(/\n/g, '<br>')}</div>
            </div>
        `).join('');
    }

    dialog.innerHTML = `
        <div class="yuseo-modal yuseo-graveyard-modal">
            <div class="yuseo-graveyard-title">🪦 묘지</div>
            <div class="yuseo-graveyard-list">${entriesHtml}</div>
            <div class="yuseo-actions">
                <button class="yuseo-btn yuseo-btn-close">닫기</button>
            </div>
        </div>
    `;

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
        if (skipIntercept || !settings()?.enabled) {
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
            saveToGraveyard(charName, lastWords, avatarUrl);
            skipIntercept = true;
            deleteBtn.click();
        } else {
            // 취소 → 귀환 메시지
            const returnMsg = await generateReturnMessage(charName);
            if (returnMsg.trim()) {
                await addCharacterMessage(returnMsg);
            }
        }
    }, true); // capturing phase
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
                <div class="inline-drawer-content">
                    <div class="yuseo-setting-row">
                        <label class="checkbox_label">
                            <input type="checkbox" id="yuseo-enabled" ${s.enabled ? 'checked' : ''}>
                            <span>확장 활성화</span>
                        </label>
                        <small class="yuseo-desc">캐릭터 삭제 시 유서를 생성합니다.</small>
                    </div>
                    <div class="yuseo-setting-row">
                        <button id="yuseo-graveyard-btn" class="menu_button">
                            🪦 묘지 열기
                            <span id="yuseo-graveyard-count" class="yuseo-badge">${s.graveyard.length}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    jQuery('#extensions_settings2').append(settingsHtml);

    jQuery('#yuseo-enabled').on('change', function () {
        const s2 = settings();
        if (s2) {
            s2.enabled = this.checked;
            context()?.saveSettings?.();
        }
    });

    jQuery('#yuseo-graveyard-btn').on('click', () => {
        showGraveyardDialog();
    });
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
    updateGraveyardBadge();

    // 동적으로 삭제 버튼이 재생성될 경우 대비
    const observer = new MutationObserver(() => {
        const btn = document.getElementById('delete_button');
        if (btn && !btn.dataset.yuseoHooked) {
            hookDeleteButton();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
});
