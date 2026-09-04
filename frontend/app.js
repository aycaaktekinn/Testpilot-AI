console.log('TESTPILOT AI APP LOADED');


/* =========================================================
   GLOBAL ELEMENTS
========================================================= */

const pageContent = document.getElementById('pageContent');
const pageSubtitle = document.getElementById('pageSubtitle');

const dashboardMenu = document.getElementById('dashboardMenu');
const suitesMenu = document.getElementById('suitesMenu');
const createTestMenu = document.getElementById('createTestMenu');
const suggestionsMenu = document.getElementById('suggestionsMenu');
const generatedTestsMenu = document.getElementById('generatedTestsMenu');
const testRunsMenu = document.getElementById('testRunsMenu');
const reportsMenu = document.getElementById('reportsMenu');
const adminPanelMenu = document.getElementById('adminPanelMenu');
const adminPanelMenuItem = document.getElementById('adminPanelMenuItem');

// v3.0 Faz 5.2 — sidebar'daki gerçek kullanıcı kartı (bkz. index.html USER CARD NOT'u) — eskiden
// sabit "Dev User" placeholder'dı, artık gerçek giriş yapmış kullanıcıyı ve TEK global Logout
// butonunu barındırıyor.
const sidebarUserInitial = document.getElementById('sidebarUserInitial');
const sidebarUsername = document.getElementById('sidebarUsername');
const sidebarUserRole = document.getElementById('sidebarUserRole');
const sidebarLogoutButton = document.getElementById('sidebarLogoutButton');

const settingsMenu = document.getElementById('settingsMenu');
const helpButton = document.getElementById('helpButton');

// v3.0 Faz 5.2 — normal (MEMBER) kullanıcılar Admin Panel'i GÖRMEMELİ (bkz. sohbet notu). Giriş
// yapan kullanıcının rolü burada tutulur; hem sayfa yüklenirken (checkAppAuth) hem login sonrası
// dolduruluyor — applyLoggedInUser() ADMIN değilse sidebar'daki linki gizler, navigateTo() da
// 'admin' sayfasına DOĞRUDAN URL/fonksiyon çağrısıyla gidilmeye çalışılırsa (link zaten gizli
// olsa da) ikinci bir savunma katmanı olarak engeller. Gerçek güvenlik sınırı YİNE DE backend'deki
// requireAdmin middleware'idir (bkz. adminUsers.ts/adminProjects.ts vs.) — bu SADECE arayüz/UX.
let currentAppUserRole = null;

/** user: { username, displayName, role } — hem checkAppAuth() (GET /api/auth/me) hem login submit
 * (POST /api/auth/login) sonrasında BURADAN çağrılır, ikisinin de döndürdüğü user şekli aynı. */
function applyLoggedInUser(user) {
    currentAppUserRole = user?.role ?? null;

    // NOT — 'hidden' BİLİNÇLİ OLARAK <li id="adminPanelMenuItem"> üzerinde toggle'lanıyor, <a
    // id="adminPanelMenu"> üzerinde DEĞİL — <a>'nın kendi class'ında zaten kalıcı "flex" var, aynı
    // elemana hem "flex" hem "hidden" eklemek Tailwind'in CSS çıktı SIRASINA bağlı kalır (kırılgan).
    // <li>'de hiç çakışan bir display class'ı yok, bu yüzden güvenli.
    adminPanelMenuItem.classList.toggle('hidden', currentAppUserRole !== 'ADMIN');

    const label = user?.displayName || user?.username || '';
    sidebarUsername.textContent = label || '—';
    sidebarUserRole.textContent = currentAppUserRole === 'ADMIN' ? 'Admin' : 'Member';
    sidebarUserInitial.textContent = label ? label.trim().charAt(0).toUpperCase() : '?';
}

// v3.0 Faz 2.1 — SİTE GENELİ login gate elemanları (bkz. index.html #appLoginGate ve dosya
// sonundaki checkAppAuth()/wireAppLoginForm()).
const appLoginGate = document.getElementById('appLoginGate');
const appLoginForm = document.getElementById('appLoginForm');
const appLoginUsernameInput = document.getElementById('appLoginUsername');
const appLoginPasswordInput = document.getElementById('appLoginPassword');
const appLoginError = document.getElementById('appLoginError');
const appLoginSubmitButton = document.getElementById('appLoginSubmitButton');

// v3.0 Faz 2.1 — GLOBAL 401 GÜVENLİK AĞI: uygulamanın HER YERİNDEKİ (onlarca farklı sayfa/
// fonksiyondaki) fetch() çağrısını tek tek "401 gelirse login gate'i göster" diye değiştirmek
// yerine, window.fetch'in KENDİSİNİ bir kez sarmalıyoruz — session süresi dolduğunda/cookie
// geçersizleştiğinde HANGİ sayfada olursa olsun kullanıcı otomatik olarak login ekranına
// döner. showAppLoginGate() BİLİNÇLİ OLARAK idempotent (zaten görünürken tekrar çağrılması
// zararsız) — bu yüzden /api/auth/me veya /api/auth/login'in kendi 401'lerinde de güvenle çalışır.
// Orijinal response AYNEN döndürülür — çağıran kodun kendi hata işleme mantığı bozulmaz.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (response.status === 401 && typeof showAppLoginGate === 'function') {
        showAppLoginGate();
    }
    return response;
};

// Mobil navigasyon (hamburger menü / kayar sidebar) için — bkz. dosya sonundaki
// "MOBILE NAVIGATION" bölümü.
const sidebarNav = document.getElementById('sidebarNav');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const mobileMenuButton = document.getElementById('mobileMenuButton');
const closeSidebarButton = document.getElementById('closeSidebarButton');


/* =========================================================
   UTILITIES
========================================================= */

// v3.1 — bir adımın kararının NEREDEN geldiğini gösteren kısa etiket (bkz. backend
// AgentDecision.decisionSource dosya başı NOT'u). Modül-seviyesinde tanımlı — hem Create Test
// sayfasının canlı Execution Log'u (formatLiveStepLine) HEM Generated Tests sayfasının adım listesi
// AYNI etiketi kullansın diye (bkz. sohbet notu: "execution logta vector db den mi yoksa llmden
// mi onu da görelim").
const DECISION_SOURCE_LABELS = {
    llm: 'LLM',
    vector_cache: 'Cache',
    replay: 'Replay',
};

// LLM'den ya da kullanıcıdan gelen metni innerHTML ile basarken kullanılıyor — detached bir div'e
// .textContent atayıp .innerHTML olarak geri okumak, tarayıcının kendi HTML escape mantığını
// kullanmanın en güvenilir yolu (XSS'e karşı).
function escapeHtml(text) {

    const div =
        document.createElement('div');

    div.textContent =
        text;

    return div.innerHTML;
}

// v3.2 — "gece test koşumu" zamanlaması (bkz. sohbet notu). Modül-seviyesinde tanımlı — hem
// Create Test sayfası (initCreateTestPage) hem Generated Tests sayfasının zamanlama modalı
// (initGeneratedTestsPage) AYNI gün-toggle UI'ını ve backend sözleşmesini paylaşsın diye
// (bkz. backend GeneratedTestSchedule: days 0=Pazar..6=Cumartesi, cron'un day-of-week alanıyla AYNI).
const SCHEDULE_DAY_LABELS = [
    { value: 1, label: 'Mon' },
    { value: 2, label: 'Tue' },
    { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' },
    { value: 5, label: 'Fri' },
    { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' },
];

/** 7 gün toggle butonunu verilen container'a doldurur (boş halde başlar, seçili günler için
 * bkz. setSelectedScheduleDays). Her buton `data-day` özniteliğinde cron gün numarasını taşır. */
function createScheduleDayToggles(container) {
    container.innerHTML = SCHEDULE_DAY_LABELS.map(({ value, label }) => `
        <button
            type="button"
            data-day="${value}"
            class="scheduleDayToggle font-body-sm text-[12px] w-9 h-9 rounded-full
                   border border-outline-variant text-on-surface-variant
                   hover:bg-surface-variant transition-colors"
        >${label}</button>
    `).join('');

    container.querySelectorAll('.scheduleDayToggle').forEach((button) => {
        button.addEventListener('click', () => {
            button.classList.toggle('bg-primary');
            button.classList.toggle('text-on-primary');
            button.classList.toggle('border-primary');
        });
    });
}

/** Verilen cron gün numaraları (0-6) dışındaki her toggle'ı temizler, verilenleri işaretler. */
function setSelectedScheduleDays(container, days) {
    const daySet = new Set(days);
    container.querySelectorAll('.scheduleDayToggle').forEach((button) => {
        const isSelected = daySet.has(Number(button.dataset.day));
        button.classList.toggle('bg-primary', isSelected);
        button.classList.toggle('text-on-primary', isSelected);
        button.classList.toggle('border-primary', isSelected);
    });
}

/** Şu an işaretli toggle'ların cron gün numaralarını (sırasız) döner. */
function getSelectedScheduleDays(container) {
    return Array.from(container.querySelectorAll('.scheduleDayToggle.bg-primary'))
        .map((button) => Number(button.dataset.day));
}

/** Bir schedule'ı "23:00 · Mon, Tue, Fri" gibi kısa, okunur bir özete çevirir (satır ikonunun
 * title'ında ve Generated Tests zamanlama modalının başlığında kullanılır). */
function formatScheduleSummary(schedule) {
    if (!schedule?.enabled) return 'Not scheduled';

    const dayOrder = SCHEDULE_DAY_LABELS.map((d) => d.value);
    const labelByValue = new Map(SCHEDULE_DAY_LABELS.map((d) => [d.value, d.label]));
    const days = [...(schedule.days || [])]
        .sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b))
        .map((value) => labelByValue.get(value) || '?')
        .join(', ');

    return `${schedule.time} · ${days || 'no days'}`;
}

/**
 * Bir generated test için zamanlamayı kaydeder/günceller. `schedule: null` zamanlamayı komple
 * kaldırır (bkz. backend GeneratedTestStore.setSchedule dosya başı NOT). Best-effort: hata
 * olursa bir toast gösterir ama çağıran taraf akışı BLOKLAMAZ — testin kendisi (generate-and-run
 * ya da düzenleme) zaten tamamlanmış/kaydedilmiş olur, sadece zamanlama eklenememiş olur.
 */
async function saveGeneratedTestSchedule(fileName, schedule) {
    try {
        const response = await fetch(
            `/api/generated-tests/${encodeURIComponent(fileName)}/schedule`,
            schedule
                ? {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(schedule),
                }
                : { method: 'DELETE' },
        );

        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.message || 'Failed to save schedule.');
        }

        return await response.json();
    } catch (error) {
        console.error('Failed to save generated test schedule', error);
        showToast(
            error instanceof Error ? error.message : 'Failed to save schedule.',
            'error',
        );
        return null;
    }
}


/* =========================================================
   TOAST NOTIFICATIONS
   ------------------------------------------------------
   DÜZELTME: Uygulamanın her yerinde native alert() kullanılıyordu — sayfayı TAMAMEN bloke eden,
   markaya/temaya hiç uymayan, eski usül tarayıcı diyalog kutuları. Artık tek, tutarlı, sayfayı
   bloklamayan bir toast bileşeni var; her alert() çağrısı buna yönlendirildi. confirm() (silme
   onayları) BİLİNÇLİ olarak dokunulmadı — kullanıcıdan senkron bir evet/hayır cevabı almamız
   gerekiyor, bunu bir toast karşılayamaz; o ayrı bir iyileştirme konusu (özel bir onay modalı).
========================================================= */

const TOAST_ICONS = {
    success: 'check_circle',
    error: 'error',
    info: 'info',
};

const TOAST_STYLES = {
    success: 'border-secondary/40 bg-secondary/10 text-secondary',
    error: 'border-error/40 bg-error/10 text-error',
    info: 'border-primary/40 bg-primary/10 text-primary',
};

function showToast(message, type = 'info') {

    const container =
        document.getElementById('toastContainer');

    if (!container) {
        // Konteyner bir sebeple yoksa mesajı sessizce kaybetmek yerine en azından console'a yaz.
        console.warn('Toast container not found:', message);
        return;
    }

    const toast =
        document.createElement('div');

    toast.className =
        'pointer-events-auto flex items-start gap-2 px-4 py-3 rounded-lg border shadow-lg ' +
        'bg-surface-container-high font-body-sm text-body-sm max-w-sm transition-opacity ' +
        'duration-200 ' +
        (TOAST_STYLES[type] || TOAST_STYLES.info);

    toast.innerHTML = `
        <span class="material-symbols-outlined text-[18px] shrink-0">
            ${TOAST_ICONS[type] || TOAST_ICONS.info}
        </span>
        <span class="text-on-surface flex-1">${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(
        () => {

            toast.style.opacity =
                '0';

            setTimeout(
                () => toast.remove(),
                200,
            );
        },
        4000,
    );
}

/**
 * Maskelenmiş şifre girişi için özel modal prompt.
 * window.prompt() şifreyi açık metin olarak gösterdiği için,
 * şifre girişi gerektiren durumlarda bu fonksiyon kullanılır.
 * @param {string} message - Kullanıcıya gösterilecek mesaj
 * @param {string} placeholder - Input placeholder metni
 * @returns {Promise<string|null>} Girilen şifre veya iptal edilirse null
 */
async function promptPassword(message, placeholder = 'Şifre') {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.id = 'passwordPromptModal';
        modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]';

        modal.innerHTML = `
            <div class="bg-surface-container p-6 rounded-lg shadow-xl w-full max-w-md border border-outline-variant">
                <h3 class="font-headline-md text-on-surface mb-4">${escapeHtml(message)}</h3>
                <input
                    type="password"
                    id="passwordPromptInput"
                    class="w-full bg-surface-container-low border border-outline-variant rounded-md px-3 py-2 text-on-surface focus:ring-2 focus:ring-primary focus:border-transparent mb-4"
                    placeholder="${escapeHtml(placeholder)}"
                    autocomplete="off"
                />
                <div class="flex justify-end gap-2">
                    <button
                        id="passwordPromptCancel"
                        class="px-4 py-2 rounded-md border border-outline-variant text-on-surface-variant hover:bg-surface-container-high transition-colors"
                    >
                        İptal
                    </button>
                    <button
                        id="passwordPromptOk"
                        class="px-4 py-2 rounded-md bg-primary-container text-on-primary-container hover:bg-inverse-primary transition-colors font-bold"
                    >
                        Tamam
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const input = modal.querySelector('#passwordPromptInput');
        const cancelBtn = modal.querySelector('#passwordPromptCancel');
        const okBtn = modal.querySelector('#passwordPromptOk');

        setTimeout(() => input?.focus(), 10);

        function cleanup() {
            cancelBtn?.removeEventListener('click', cancelHandler);
            okBtn?.removeEventListener('click', okHandler);
            modal.removeEventListener('keydown', keyHandler);
            modal.remove();
        }

        function cancelHandler() {
            cleanup();
            resolve(null);
        }

        function okHandler() {
            const value = input?.value || '';
            cleanup();
            resolve(value || null);
        }

        function keyHandler(e) {
            if (e.key === 'Escape') {
                cancelHandler();
            } else if (e.key === 'Enter') {
                okHandler();
            }
        }

        cancelBtn?.addEventListener('click', cancelHandler);
        okBtn?.addEventListener('click', okHandler);
        modal.addEventListener('keydown', keyHandler);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                cancelHandler();
            }
        });
    });
}

/**
 * Kullanıcı adı girişi için özel modal prompt.
 * window.prompt() yerine tutarlı UI sağlamak için kullanılır.
 * @param {string} message - Kullanıcıya gösterilecek mesaj
 * @param {string} placeholder - Input placeholder metni
 * @param {string} defaultValue - Varsayılan değer
 * @returns {Promise<string|null>} Girilen kullanıcı adı veya iptal edilirse null
 */
async function promptUsername(message, placeholder = 'Kullanıcı Adı', defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.id = 'usernamePromptModal';
        modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]';

        modal.innerHTML = `
            <div class="bg-surface-container p-6 rounded-lg shadow-xl w-full max-w-md border border-outline-variant">
                <h3 class="font-headline-md text-on-surface mb-4">${escapeHtml(message)}</h3>
                <input
                    type="text"
                    id="usernamePromptInput"
                    class="w-full bg-surface-container-low border border-outline-variant rounded-md px-3 py-2 text-on-surface focus:ring-2 focus:ring-primary focus:border-transparent mb-4"
                    placeholder="${escapeHtml(placeholder)}"
                    value="${escapeHtml(defaultValue)}"
                    autocomplete="off"
                />
                <div class="flex justify-end gap-2">
                    <button
                        id="usernamePromptCancel"
                        class="px-4 py-2 rounded-md border border-outline-variant text-on-surface-variant hover:bg-surface-container-high transition-colors"
                    >
                        İptal
                    </button>
                    <button
                        id="usernamePromptOk"
                        class="px-4 py-2 rounded-md bg-primary-container text-on-primary-container hover:bg-inverse-primary transition-colors font-bold"
                    >
                        Tamam
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const input = modal.querySelector('#usernamePromptInput');
        const cancelBtn = modal.querySelector('#usernamePromptCancel');
        const okBtn = modal.querySelector('#usernamePromptOk');

        setTimeout(() => input?.focus(), 10);

        function cleanup() {
            cancelBtn?.removeEventListener('click', cancelHandler);
            okBtn?.removeEventListener('click', okHandler);
            modal.removeEventListener('keydown', keyHandler);
            modal.remove();
        }

        function cancelHandler() {
            cleanup();
            resolve(null);
        }

        function okHandler() {
            const value = input?.value || '';
            cleanup();
            resolve(value || null);
        }

        function keyHandler(e) {
            if (e.key === 'Escape') {
                cancelHandler();
            } else if (e.key === 'Enter') {
                okHandler();
            }
        }

        cancelBtn?.addEventListener('click', cancelHandler);
        okBtn?.addEventListener('click', okHandler);
        modal.addEventListener('keydown', keyHandler);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                cancelHandler();
            }
        });
    });
}

/* =========================================================
   APPLICATION STATE
========================================================= */

const EXECUTION_SETTINGS_STORAGE_KEY =
    'testpilot.executionSettings';

const DEFAULT_EXECUTION_SETTINGS = {
    browser: 'chromium',
    headed: true,
    screenshot: true,
    video: false,
    trace: true,
    // v2.0 — Selenium Grid tercihi diğerleriyle aynı şekilde tarayıcıda hatırlanır, ANCAK
    // Settings sayfasının "Execution Defaults" bölümünde AYRI bir checkbox olarak GÖSTERİLMEZ
    // (bkz. Create Test sayfasındaki updateSeleniumGridAvailability) — çünkü kullanılabilirliği
    // her zaman o anki browser seçimine ve hub'ın yapılandırılmış olmasına bağlıdır, statik bir
    // "varsayılan" gibi sunmak yanıltıcı olurdu.
    useSeleniumGrid: false,
};


// Sayfa yenilendiğinde (tam tarayıcı yenilemesi) daha önce Settings sayfasından kaydedilmiş
// varsayılanları geri yükler. localStorage burada UYGUNDUR: bu, Claude.ai'da render edilen bir
// "artifact" DEĞİL, kullanıcının kendi backend'i üzerinden sunulan gerçek, bağımsız bir web
// uygulaması — tarayıcıda kalıcı tercih saklamak standart ve doğru yaklaşımdır.
function loadStoredExecutionSettings() {

    try {

        const raw =
            window.localStorage.getItem(
                EXECUTION_SETTINGS_STORAGE_KEY,
            );

        if (!raw) {
            return { ...DEFAULT_EXECUTION_SETTINGS };
        }

        return {
            ...DEFAULT_EXECUTION_SETTINGS,
            ...JSON.parse(raw),
        };

    } catch (error) {

        console.error(
            'Failed to read saved execution settings:',
            error,
        );

        return { ...DEFAULT_EXECUTION_SETTINGS };
    }
}


function persistExecutionSettings(settings) {

    try {

        window.localStorage.setItem(
            EXECUTION_SETTINGS_STORAGE_KEY,
            JSON.stringify(settings),
        );

    } catch (error) {

        console.error(
            'Failed to save execution settings:',
            error,
        );
    }
}


const appState = {
    currentPage: null,

    latestArtifacts: {
        screenshot: null,
        video: null,
        trace: null,
    },

    executionSettings:
        loadStoredExecutionSettings(),

    lastGeneratedFile: null,

    pendingGeneratedCode: null,
    pendingGeneratedFile: null,
    pendingTestResult: null,

    // v3.10 — "BDD" paneli: Save butonunun PATCH /api/test-runs/:id/bdd-description isteğini
    // hangi run'a göndereceğini bilmesi için, EKRANDA GÖSTERİLEN sonucun runId'sini tutar (bkz.
    // LegacyTestResultResponse.runId dosya başı açıklaması). Bir run hiç başlamadıysa (ör. sayfa
    // yeni açıldı) ya da runId'siz eski/hatalı bir yanıt geldiyse `null` kalır — bu durumda Save
    // butonu tıklanınca kullanıcıya "önce bir test çalıştır" uyarısı gösterilir.
    currentRunId: null,

    // v3.12 — bkz. sohbet notu: "tıklıyım burdan bdd ye yine create test panelinde bdd kısmına
    // götürsün ordan edit yapabileyim". Generated Tests sayfasındaki "BDD" butonuna tıklanınca
    // (bkz. openBddEditorForGeneratedTest) buraya {bddDescription, runId} yazılır, sonra Create
    // Test sayfasına navigateTo('create') edilir; initCreateTestPage() açılışta bu alanı kontrol
    // edip DOLUYSA panel metnini/appState.currentRunId'yi bununla doldurup BDD sekmesini otomatik
    // açar ve bu alanı `null`'a döndürür (bir sonraki normal navigasyonu ETKİLEMESİN diye — bkz.
    // initCreateTestPage dosya başı NOT'u).
    pendingBddEdit: null,

    // v3.12 — bkz. sohbet notu: "generated testten test koştuğumda create test sayfasında olan
    // panelden yine göreyim istiyorum". runExistingTest/replayExistingTest, run'ı BAŞLATTIKLARI
    // AN (sonucu beklemeden) buraya `true` yazıp navigateTo('create') çağırır — initCreateTestPage
    // açılışta bunu görüp "PENDING LIVE RUN" bloğunda canlı takibi başlatır ve bu alanı `null`'a
    // döndürür (bkz. o bloğun dosya başı NOT'u).
    pendingLiveRun: null,
};


/* =========================================================
   PAGE CONFIGURATION
========================================================= */

const pageConfig = {
    dashboard: {
        file: 'dashboard.html',
        menu: dashboardMenu,
        subtitle: 'Test automation workspace overview',
    },

    // v3.11 — bkz. sohbet notu: "Suit adında bir panel daha yapacağız bu dashboardın altında yer
    // alsın". Generated Tests'ten "Add to Suite" ile taşınan testler burada, suite'lere göre
    // gruplanmış olarak görünür ve checkbox ile toplu (regresyon gibi) çalıştırılabilir.
    suites: {
        file: 'suites.html',
        menu: suitesMenu,
        subtitle: 'Test Suites',
    },

    create: {
        file: 'create-test.html',
        menu: createTestMenu,
        subtitle: 'Create New Scenario',
    },

    suggestions: {
        file: 'scenario-suggestions.html',
        menu: suggestionsMenu,
        subtitle: 'AI Scenario Suggestions',
    },

    generated: {
        file: 'generated-tests.html',
        menu: generatedTestsMenu,
        subtitle: 'AI Generated Playwright Tests',
    },

    runs: {
        file: 'test-runs.html',
        menu: testRunsMenu,
        subtitle: 'Test Execution History',
    },

    reports: {
        file: 'reports.html',
        menu: reportsMenu,
        subtitle: 'Test Reports & Analytics',
    },

    admin: {
        file: 'admin-panel.html',
        menu: adminPanelMenu,
        subtitle: 'Projects, Grid URL & LLM configuration',
    },

    // v3.1 — Admin Panel'deki "Members" butonunun artık açtığı ayrı detay sayfası (eskiden
    // küçük bir modaldı, bkz. app.js dosya içindeki "PROJECT MEMBERS PAGE" bölümü). Sidebar'da
    // kendi menü öğesi YOK — adminPanelMenu'yü aktif göstermeye devam ediyoruz ki kullanıcı hâlâ
    // "Admin Panel" içinde olduğunu hissetsin (bkz. goToProjectMembersPage()).
    projectMembers: {
        file: 'project-members.html',
        menu: adminPanelMenu,
        subtitle: 'Project Members',
    },

    settings: {
        file: 'settings.html',
        menu: settingsMenu,
        subtitle: 'Application Settings',
    },
};


/* =========================================================
   SIDEBAR
========================================================= */

function setActiveSidebarMenu(activeMenu) {

    const menus = [
        dashboardMenu,
        suitesMenu,
        createTestMenu,
        suggestionsMenu,
        generatedTestsMenu,
        testRunsMenu,
        reportsMenu,
        adminPanelMenu,
        settingsMenu,
    ];

    menus.forEach((menu) => {

        if (!menu) {
            return;
        }

        menu.classList.remove(
            'bg-primary-container',
            'text-on-primary-container',
            'font-bold',
            'shadow-[0_0_8px_rgba(79,70,229,0.3)]',
        );

        menu.classList.add(
            'text-on-surface-variant',
        );
    });

    if (!activeMenu) {
        return;
    }

    activeMenu.classList.remove(
        'text-on-surface-variant',
    );

    activeMenu.classList.add(
        'bg-primary-container',
        'text-on-primary-container',
        'font-bold',
        'shadow-[0_0_8px_rgba(79,70,229,0.3)]',
    );
}


/* =========================================================
   MOBILE NAVIGATION
   ------------------------------------------------------
   DÜZELTME: sidebar (nav) VE masaüstü header'ı ikisi de sadece "hidden md:flex" idi — md
   breakpoint'in (768px) altında navigasyonun HİÇBİR YEDEĞİ yoktu, uygulama telefonda tamamen
   kullanılamaz haldeydi. Artık sidebar bir "drawer" (kayar panel): her zaman DOM'da/flex, ama
   CSS transform ile (-translate-x-full) ekran dışına kaydırılmış duruyor; bu üç fonksiyon o
   transform'u ve arkadaki karartma katmanını (sidebarBackdrop) açıp kapatıyor. md ve üzerinde
   sidebar zaten `md:translate-x-0` ile sabit göründüğü için bu fonksiyonlar orada etkisiz
   (no-op gibi) kalır — mobil-özel elementler md:hidden olduğundan hiçbir masaüstü davranışını
   bozmaz.
========================================================= */

function openMobileSidebar() {

    if (!sidebarNav || !sidebarBackdrop) {
        return;
    }

    sidebarNav.classList.remove('-translate-x-full');
    sidebarBackdrop.classList.remove('hidden');

    if (mobileMenuButton) {
        mobileMenuButton.setAttribute('aria-expanded', 'true');
    }
}


function closeMobileSidebar() {

    if (!sidebarNav || !sidebarBackdrop) {
        return;
    }

    sidebarNav.classList.add('-translate-x-full');
    sidebarBackdrop.classList.add('hidden');

    if (mobileMenuButton) {
        mobileMenuButton.setAttribute('aria-expanded', 'false');
    }
}


function toggleMobileSidebar() {

    if (!sidebarNav) {
        return;
    }

    if (sidebarNav.classList.contains('-translate-x-full')) {
        openMobileSidebar();
    } else {
        closeMobileSidebar();
    }
}


/* =========================================================
   PAGE LOADER
========================================================= */

async function navigateTo(pageName) {

    const config =
        pageConfig[pageName];

    if (!config) {

        console.error(
            'Bilinmeyen sayfa:',
            pageName,
        );

        return;
    }

    // v3.0 Faz 5.2 — 'admin' sayfasına SADECE ADMIN rolü geçebilir. Sidebar'daki link zaten
    // ADMIN olmayanlardan gizli (bkz. applyLoggedInUser), ama navigateTo() BÜTÜN sayfa
    // geçişlerinin TEK giriş noktası olduğu için (link tıklaması / hash / ileride eklenecek başka
    // bir tetikleyici fark etmeksizin) gerçek engel BURADA — link'i gizlemek sadece UX, buradaki
    // kontrol MEMBER bir kullanıcının admin panel fragment'ını hiç ÇEKMEMESİNİ garanti eder
    // (aksi halde /api/admin/* çağrıları 403 dönerdi ama sayfa yarım yamalak/hatalı yüklenirdi).
    if ((pageName === 'admin' || pageName === 'projectMembers') && currentAppUserRole !== 'ADMIN') {
        showToast('Bu sayfaya erişim için admin yetkisi gerekiyor.', 'error');
        return;
    }

    // Mobilde bir menü öğesine dokunmak hem sayfayı değiştirmeli hem de artık gereksiz olan
    // kayar sidebar'ı kapatmalı — kapanmasa kullanıcı yeni sayfanın üzerinde açık bir drawer'la
    // kalır. Masaüstünde bu no-op'tur (closeMobileSidebar zaten md:'de anlamsız sınıfları toggler).
    closeMobileSidebar();

    try {

        pageContent.innerHTML = `
            <div
                class="
                    p-gutter
                    lg:p-margin-desktop
                    text-on-surface-variant
                "
            >
                Loading page...
            </div>
        `;

        const response =
            await fetch(
                `/pages/${config.file}`,
            );

        if (!response.ok) {

            throw new Error(
                `Failed to load ${config.file}.`,
            );
        }

        const html =
            await response.text();

        pageContent.innerHTML =
            html;

        appState.currentPage =
            pageName;

        pageSubtitle.textContent =
            config.subtitle;

        setActiveSidebarMenu(
            config.menu,
        );

        await initializePage(
            pageName,
        );

    } catch (error) {

        console.error(error);

        pageContent.innerHTML = `
            <div class="p-8 text-error">
                Failed to load page.
            </div>
        `;
    }
}


/* =========================================================
   PAGE INITIALIZER
========================================================= */

async function initializePage(pageName) {

    if (pageName === 'dashboard') {
        await initDashboardPage();
        return;
    }

    if (pageName === 'suites') {
        await initSuitesPage();
        return;
    }

    if (pageName === 'create') {
        initCreateTestPage();
        return;
    }

    if (pageName === 'suggestions') {
        initScenarioSuggestionsPage();
        return;
    }

    if (pageName === 'generated') {
        await initGeneratedTestsPage();
        return;
    }

    if (pageName === 'runs') {
        await initTestRunsPage();
        return;
    }

    if (pageName === 'reports') {
        await initReportsPage();
        return;
    }

    if (pageName === 'admin') {
        await initAdminPanelPage();
        return;
    }

    if (pageName === 'projectMembers') {
        await initProjectMembersPage();
        return;
    }

    if (pageName === 'settings') {
        await initSettingsPage();
    }
}


/* =========================================================
   CREATE TEST PAGE
========================================================= */

// v3.21 — bkz. asagidaki PENDING BDD EDIT blogundaki `await projectsLoadPromise` NOT'u.
// ESKIDEN sync'ti; caller (navigateTo) zaten sonucunu await ETMIYOR (satirici degismedi,
// fire-and-forget) — async yapmak sayfanin acilis davranisini DEGISTIRMEZ.
async function initCreateTestPage() {

    const targetUrlInput =
        document.getElementById('targetUrl');

    const testScenarioInput =
        document.getElementById('testScenario');

    // v2.4 — kullanıcının verdiği isteğe bağlı test adı (bkz. create-test.html "TEST NAME" NOT).
    // Backend'e LegacyGenerateAndRunInput.testName olarak gönderilir; Generated Tests listesinde
    // otomatik üretilen dosya adı yerine görünen isim olarak kullanılır (bkz. LegacyTestService.
    // generateAndRun / finalizeResult dosya başı açıklaması).
    const testNameInput =
        document.getElementById('testName');

    // v3.0 Faz 6 — bkz. create-test.html "PROJECT" NOT: kullanıcı burada bir proje seçerse,
    // backend'e LegacyGenerateAndRunInput.projectId olarak gönderilir ve bu run AYRICA (best-effort)
    // Oracle veritabanına da (SCENARIOS + RUNS) yazılır. Boş bırakılırsa davranış eskisiyle aynıdır
    // (sadece JSON dosyalarına kaydedilir).
    const projectSelectInput =
        document.getElementById('projectSelect');

    // v3.0 Faz 6 — proje listesini bir kez, sayfa açılırken doldurur. Hata olursa sadece loglanır
    // (bu alan OPSİYONEL — proje listesi yüklenemese bile Create Test sayfasının geri kalanı
    // normal şekilde çalışmaya devam eder, bkz. GET /api/projects dosya başı NOT).
    async function loadProjectsIntoSelect() {
        if (!projectSelectInput) return;

        try {
            const response = await fetch('/api/projects');
            if (!response.ok) return;

            const result = await response.json();
            const projects = result.projects || [];

            for (const project of projects) {
                const option = document.createElement('option');
                option.value = String(project.id);
                option.textContent = project.name;
                projectSelectInput.appendChild(option);
            }
        } catch (error) {
            console.error('Failed to load projects for Create Test page', error);
        }
    }

    // v3.21 — bkz. asagidaki PENDING BDD EDIT blogu: proje secimini dogru doldurabilmek icin
    // bu fetch'in <option>'lari EKLEMIS olmasi lazim; promise'i saklayip SADECE o blokta await
    // ediyoruz (sayfanin geri kalani ESKISI GIBI bunu beklemeden acilmaya devam eder).
    const projectsLoadPromise = loadProjectsIntoSelect();


    /* -----------------------------------------------------
       SCHEDULE (v3.2 — bkz. sohbet notu: "gece test koşumu yapabilmemiz için zamanlayıcı".
       Burada sadece FORM state'i toplanır; asıl kayıt generate-and-run BAŞARIYLA sonuçlanıp bir
       fileName elde edildikten SONRA, aşağıdaki generateRunButton click handler'ının içinde
       ayrı bir PUT /api/generated-tests/:fileName/schedule isteğiyle yapılır (bkz.
       scheduleGeneratedTestFromCreatePage). Aynı gün-toggle deseni (0=Pazar..6=Cumartesi, cron'un
       day-of-week alanıyla AYNI) Generated Tests sayfasındaki zamanlama modalıyla PAYLAŞILIR
       (bkz. createScheduleDayToggles / collectSelectedScheduleDays, initGeneratedTestsPage).
    ----------------------------------------------------- */
    const scheduleEnabledInput =
        document.getElementById('scheduleEnabled');

    const scheduleOptionsContainer =
        document.getElementById('scheduleOptions');

    const scheduleTimeInput =
        document.getElementById('scheduleTime');

    const scheduleDaysContainer =
        document.getElementById('scheduleDaysContainer');

    const scheduleQuickWeekdaysButton =
        document.getElementById('scheduleQuickWeekdays');

    const scheduleQuickEveryDayButton =
        document.getElementById('scheduleQuickEveryDay');

    // v3.2 — bkz. sohbet notu: "hiç çalıştırmadan girdiğimiz senaryoyu gece çalıştırsa mesela
    // generate and runa basmadan nasıl olur o kısım". "Generate & Run"ın AKSİNE bu buton
    // AgentLoop'u HİÇ çalıştırmaz — senaryoyu POST /api/generated-tests/schedule-only ile
    // sadece kaydedip zamanlar; ilk gerçek koşum TestScheduler tarafından zamanlanan saatte
    // tetiklenir (bkz. saveScheduledScenario dosya başı açıklaması, backend).
    const saveScheduleOnlyButton =
        document.getElementById('saveScheduleOnlyButton');

    if (scheduleDaysContainer) {
        createScheduleDayToggles(scheduleDaysContainer);
    }

    if (scheduleEnabledInput && scheduleOptionsContainer) {
        scheduleEnabledInput.addEventListener('change', () => {
            scheduleOptionsContainer.classList.toggle('hidden', !scheduleEnabledInput.checked);
            scheduleOptionsContainer.classList.toggle('flex', scheduleEnabledInput.checked);
        });
    }

    if (scheduleQuickWeekdaysButton && scheduleDaysContainer) {
        scheduleQuickWeekdaysButton.addEventListener('click', () => {
            setSelectedScheduleDays(scheduleDaysContainer, [1, 2, 3, 4, 5]);
        });
    }

    if (scheduleQuickEveryDayButton && scheduleDaysContainer) {
        scheduleQuickEveryDayButton.addEventListener('click', () => {
            setSelectedScheduleDays(scheduleDaysContainer, [0, 1, 2, 3, 4, 5, 6]);
        });
    }


    /* -----------------------------------------------------
       PENDING SUGGESTION HANDOFF (from the Scenario Suggestions page)
       ------------------------------------------------------
       Scenario Suggestions sayfasında bir kartın "Use in Create Test" butonuna basıldığında,
       url+scenario burada okunacak şekilde sessionStorage'a (bkz. initScenarioSuggestionsPage())
       TEK SEFERLİK yazılır, sonra bu sayfaya geçilir. localStorage DEĞİL sessionStorage kasıtlı:
       bu kalıcı bir tercih değil, tek seferlik bir "aktarım" verisi — okunur okunmaz hemen silinir
       ki sayfa yenilenince veya tekrar bu sayfaya dönülünce eski bir öneri sessizce geri gelmesin.
    ----------------------------------------------------- */
    try {
        const pendingRaw = window.sessionStorage.getItem('testpilot.pendingSuggestion');
        if (pendingRaw) {
            window.sessionStorage.removeItem('testpilot.pendingSuggestion');
            const pending = JSON.parse(pendingRaw);
            if (pending && typeof pending.url === 'string') targetUrlInput.value = pending.url;
            if (pending && typeof pending.scenario === 'string') testScenarioInput.value = pending.scenario;
            if (pending) showToast('Scenario filled in from your suggestion.', 'success');
        }
    } catch (error) {
        console.error(error);
    }


    const suggestScenariosButton =
        document.getElementById('suggestScenariosButton');

    const scenarioSuggestionsModal =
        document.getElementById('scenarioSuggestionsModal');

    const scenarioSuggestionsModalBody =
        document.getElementById('scenarioSuggestionsModalBody');

    const closeScenarioSuggestionsModalButton =
        document.getElementById('closeScenarioSuggestionsModal');

    const generateRunButton =
        document.getElementById('generateRunButton');

    const stopTestButton =
        document.getElementById('stopTestButton');


    const generatedCodeTab =
        document.getElementById('generatedCodeTab');

    const executionLogTab =
        document.getElementById('executionLogTab');

    const testResultTab =
        document.getElementById('testResultTab');

    const bddTab =
        document.getElementById('bddTab');


    const generatedCodePanel =
        document.getElementById('generatedCodePanel');

    const executionLogPanel =
        document.getElementById('executionLogPanel');

    const testResultPanel =
        document.getElementById('testResultPanel');

    const bddPanel =
        document.getElementById('bddPanel');


    const bddDescriptionOutput =
        document.getElementById('bddDescriptionOutput');

    const saveBddButton =
        document.getElementById('saveBddButton');

    const copyBddButton =
        document.getElementById('copyBddButton');

    const bddSaveStatus =
        document.getElementById('bddSaveStatus');


    const headedModeInput =
        document.getElementById('headedMode');

    const screenshotOption =
        document.getElementById('screenshotOption');

    const videoOption =
        document.getElementById('videoOption');

    const traceOption =
        document.getElementById('traceOption');

    const useSeleniumGridOption =
        document.getElementById('useSeleniumGridOption');

    const seleniumGridHint =
        document.getElementById('seleniumGridHint');


    const generatedCodeOutput =
        document.getElementById('generatedCodeOutput');

    const executionLogOutput =
        document.getElementById('executionLogOutput');

    // v2.2 — bkz. app.js "LIVE EXECUTION LOG" bölümündeki showGridLiveViewLink/hideGridLiveViewLink.
    const gridLiveViewLink =
        document.getElementById('gridLiveViewLink');

    const generatedFileName =
        document.getElementById('generatedFileName');


    const testStatus =
        document.getElementById('testStatus');

    const testDuration =
        document.getElementById('testDuration');

    const testBrowser =
        document.getElementById('testBrowser');

    const testExitCode =
        document.getElementById('testExitCode');

    const testFileResult =
        document.getElementById('testFileResult');

    const testStatusBadge =
        document.getElementById('testStatusBadge');


    const copyCodeButton =
        document.getElementById('copyCodeButton');

    const saveCodeButton =
        document.getElementById('saveCodeButton');

    const downloadCodeButton =
        document.getElementById('downloadCodeButton');


    const screenshotArtifactButton =
        document.getElementById(
            'screenshotArtifactButton',
        );

    const videoArtifactButton =
        document.getElementById(
            'videoArtifactButton',
        );

    const traceArtifactButton =
        document.getElementById(
            'traceArtifactButton',
        );

    // İndirme ("indir" ikonu) butonları ana buton (görüntüle) butonlarından AYRI: ana butona
    // basınca eskisi gibi yeni sekmede AÇILSIN, indirme SADECE bu ayrı ikona basılınca tetiklensin.
    const screenshotDownloadButton =
        document.getElementById(
            'screenshotDownloadButton',
        );

    const videoDownloadButton =
        document.getElementById(
            'videoDownloadButton',
        );

    const traceDownloadButton =
        document.getElementById(
            'traceDownloadButton',
        );


    /* -----------------------------------------------------
       VARIABLES & SECRETS
    ----------------------------------------------------- */

    const addVariableButton =
        document.getElementById(
            'addVariableButton',
        );

    const variablesContainer =
        document.getElementById(
            'variablesContainer',
        );


    function createVariableRow(
        key = '',
        value = '',
        variableType = 'text',
    ) {

        const row =
            document.createElement('div');

        row.className =
            'variableRow grid grid-cols-12 gap-2 items-center';


        row.innerHTML = `

            <!-- KEY -->
            <div
                class="
                    col-span-3
                    input-well
                    rounded-md
                "
            >

                <input
                    class="
                        variableKey
                        w-full
                        bg-transparent
                        border-none
                        text-on-surface
                        font-mono
                        text-sm
                        p-2
                        focus:ring-0
                    "
                    type="text"
                    placeholder="KEY Name"
                />

            </div>


            <!-- TYPE -->
            <div class="col-span-2">

                <select
                    class="
                        variableType
                        w-full
                        bg-[#0F172A]
                        border
                        border-outline-variant
                        text-on-surface
                        text-sm
                        rounded-md
                        px-2
                        py-2
                        focus:ring-1
                        focus:ring-primary
                    "
                >

                    <option value="text">
                        Text
                    </option>

                    <option value="secret">
                        Secret
                    </option>

                </select>

            </div>


            <!-- VALUE -->
            <div
                class="
                    col-span-6
                    input-well
                    rounded-md
                    relative
                    flex
                    items-center
                "
            >

                <input
                    class="
                        variableValue
                        w-full
                        bg-transparent
                        border-none
                        text-on-surface
                        font-mono
                        text-sm
                        p-2
                        pr-9
                        focus:ring-0
                    "
                    type="text"
                    placeholder="Value"
                />


                <button
                    class="
                        toggleVariableVisibility
                        material-symbols-outlined
                        text-[16px]
                        text-outline
                        absolute
                        right-2
                        hidden
                    "
                    type="button"
                    title="Show / Hide"
                    aria-label="Show or hide secret value"
                >
                    visibility
                </button>

            </div>


            <!-- DELETE -->
            <div
                class="
                    col-span-1
                    flex
                    justify-center
                "
            >

                <button
                    class="
                        deleteVariableButton
                        text-on-surface-variant
                        hover:text-error
                    "
                    type="button"
                    title="Delete Variable"
                    aria-label="Delete variable"
                >

                    <span
                        class="
                            material-symbols-outlined
                            text-[18px]
                        "
                    >
                        delete
                    </span>

                </button>

            </div>
        `;


        variablesContainer.appendChild(
            row,
        );


        const keyInput =
            row.querySelector(
                '.variableKey',
            );

        const typeSelect =
            row.querySelector(
                '.variableType',
            );

        const valueInput =
            row.querySelector(
                '.variableValue',
            );

        const visibilityButton =
            row.querySelector(
                '.toggleVariableVisibility',
            );

        const deleteButton =
            row.querySelector(
                '.deleteVariableButton',
            );


        keyInput.value =
            key;

        valueInput.value =
            value;

        typeSelect.value =
            variableType;


        if (
            variableType ===
            'secret'
        ) {

            valueInput.type =
                'password';

            visibilityButton.classList.remove(
                'hidden',
            );
        }


        typeSelect.addEventListener(
            'change',
            () => {

                if (
                    typeSelect.value ===
                    'secret'
                ) {

                    valueInput.type =
                        'password';

                    visibilityButton.classList.remove(
                        'hidden',
                    );

                    visibilityButton.textContent =
                        'visibility';

                } else {

                    valueInput.type =
                        'text';

                    visibilityButton.classList.add(
                        'hidden',
                    );

                    visibilityButton.textContent =
                        'visibility';
                }
            },
        );


        visibilityButton.addEventListener(
            'click',
            () => {

                if (
                    typeSelect.value !==
                    'secret'
                ) {
                    return;
                }


                const isHidden =
                    valueInput.type ===
                    'password';


                valueInput.type =
                    isHidden
                        ? 'text'
                        : 'password';


                visibilityButton.textContent =
                    isHidden
                        ? 'visibility_off'
                        : 'visibility';
            },
        );


        deleteButton.addEventListener(
            'click',
            () => {

                row.remove();
            },
        );
    }


    // DÜZELTME: Önceden bu fonksiyon, satırın "Text"/"Secret" tipini HİÇ dikkate almadan her
    // satırı tek bir "variables" nesnesine topluyordu. Bu, "Secret" seçilen bir satırın (ör.
    // şifre) backend'e sıradan bir "variable" olarak gitmesine yol açıyordu — backend variable
    // DEĞERLERİNİ LLM prompt'una doğrudan yazdığı için (secrets'ın aksine), "Secret" olarak
    // işaretlenmiş gerçek bir şifre böylece LLM sağlayıcısına (OpenRouter/Gemini) düz metin
    // olarak gönderiliyordu — arayüzdeki "Secret" etiketi sadece görsel bir maskeydi, gerçek bir
    // koruma sağlamıyordu. Şimdi satırın .variableType değerine göre variables/secrets olarak
    // İKİYE AYRIYORUZ; secrets, backend'in ayrı ve güvenli "secrets" alanına gönderiliyor.
    function collectVariablesAndSecrets() {

        const variables = {};
        const secrets = {};


        document
            .querySelectorAll(
                '.variableRow',
            )
            .forEach((row) => {

                const key =
                    row
                        .querySelector(
                            '.variableKey',
                        )
                        ?.value
                        .trim();


                const value =
                    row
                        .querySelector(
                            '.variableValue',
                        )
                        ?.value;


                const type =
                    row
                        .querySelector(
                            '.variableType',
                        )
                        ?.value;


                if (key) {

                    if (type === 'secret') {

                        secrets[key] =
                            value || '';

                    } else {

                        variables[key] =
                            value || '';
                    }
                }
            });


        return { variables, secrets };
    }


    if (
        addVariableButton &&
        variablesContainer
    ) {

        addVariableButton.addEventListener(
            'click',
            () => {

                createVariableRow();
            },
        );
    }


    /* -----------------------------------------------------
       EXECUTION SETTINGS
    ----------------------------------------------------- */

    const rememberedBrowser =
        document.querySelector(
            `input[name="browser"][value="${appState.executionSettings.browser}"]`,
        );


    if (rememberedBrowser) {

        rememberedBrowser.checked =
            true;
    }


    headedModeInput.checked =
        appState.executionSettings.headed;

    screenshotOption.checked =
        appState.executionSettings.screenshot;

    videoOption.checked =
        appState.executionSettings.video;

    traceOption.checked =
        appState.executionSettings.trace;


    function saveExecutionSettings() {

        appState.executionSettings.browser =
            document.querySelector(
                'input[name="browser"]:checked',
            )?.value || 'chromium';


        appState.executionSettings.headed =
            headedModeInput.checked;

        appState.executionSettings.screenshot =
            screenshotOption.checked;

        appState.executionSettings.video =
            videoOption.checked;

        appState.executionSettings.trace =
            traceOption.checked;

        appState.executionSettings.useSeleniumGrid =
            useSeleniumGridOption.checked;


        persistExecutionSettings(
            appState.executionSettings,
        );
    }


    /* -----------------------------------------------------
       SELENIUM GRID AVAILABILITY (v2.0)
       ------------------------------------------------------
       Checkbox SADECE şu iki koşul birden sağlandığında tıklanabilir: (1) seçili motor "chromium",
       (2) backend'de SELENIUM_GRID_URL yapılandırılmış (bkz. GET /api/settings → seleniumGrid.configured).
       Koşullardan biri sağlanmazsa checkbox devre dışı bırakılır VE işareti kaldırılır — aksi halde
       kullanıcı "Grid kullanıyorum" sanıp aslında yerelde çalışan bir test oluşturabilir. Kaldırma
       işlemi appState'e YAZILMAZ (saveExecutionSettings burada çağrılmaz) — bu sayede kullanıcı
       motoru geri Chromium'a alırsa önceki tercihi (işaretliyse) geri gelir.
    ----------------------------------------------------- */

    let seleniumGridConfigured = false;

    function updateSeleniumGridAvailability() {

        const selectedBrowser =
            document.querySelector(
                'input[name="browser"]:checked',
            )?.value || 'chromium';

        const available =
            selectedBrowser === 'chromium' &&
            seleniumGridConfigured;

        useSeleniumGridOption.disabled =
            !available;

        useSeleniumGridOption.checked =
            available &&
            appState.executionSettings.useSeleniumGrid;

        if (!seleniumGridConfigured) {
            seleniumGridHint.textContent =
                'Selenium Grid is not configured on the backend (SELENIUM_GRID_URL missing).';
        } else if (selectedBrowser !== 'chromium') {
            seleniumGridHint.textContent =
                'Selenium Grid is only supported with the Chromium engine.';
        } else {
            seleniumGridHint.textContent = '';
        }
    }


    updateSeleniumGridAvailability();


    (async () => {

        try {

            const response =
                await fetch('/api/settings');

            if (!response.ok) {
                return;
            }

            const data =
                await response.json();

            seleniumGridConfigured =
                Boolean(data?.seleniumGrid?.configured);

        } catch (error) {

            console.error(
                'Failed to fetch Selenium Grid availability:',
                error,
            );

        } finally {

            updateSeleniumGridAvailability();
        }
    })();


    document
        .querySelectorAll(
            'input[name="browser"]',
        )
        .forEach((input) => {

            input.addEventListener(
                'change',
                () => {
                    saveExecutionSettings();
                    updateSeleniumGridAvailability();
                },
            );
        });


    [
        headedModeInput,
        screenshotOption,
        videoOption,
        traceOption,
        useSeleniumGridOption,
    ].forEach((input) => {

        input.addEventListener(
            'change',
            saveExecutionSettings,
        );
    });


    /* -----------------------------------------------------
       TAB FUNCTIONS
    ----------------------------------------------------- */

    function setActiveTab(activeTab) {

        const tabs = [
            generatedCodeTab,
            executionLogTab,
            testResultTab,
            bddTab,
        ];


        tabs.forEach((tab) => {

            tab.classList.remove(
                'text-primary',
                'border-primary',
                'bg-surface-variant/30',
                'font-semibold',
            );

            tab.classList.add(
                'text-on-surface-variant',
                'border-transparent',
            );
        });


        activeTab.classList.remove(
            'text-on-surface-variant',
            'border-transparent',
        );

        activeTab.classList.add(
            'text-primary',
            'border-primary',
            'bg-surface-variant/30',
            'font-semibold',
        );
    }


    function showPanel(panelName) {

        const panels = [
            generatedCodePanel,
            executionLogPanel,
            testResultPanel,
            bddPanel,
        ];


        panels.forEach((panel) => {

            panel.classList.add(
                'hidden',
            );

            panel.classList.remove(
                'flex',
            );
        });


        if (panelName === 'code') {

            generatedCodePanel.classList.remove(
                'hidden',
            );

            generatedCodePanel.classList.add(
                'flex',
            );

            setActiveTab(
                generatedCodeTab,
            );
        }


        if (panelName === 'log') {

            executionLogPanel.classList.remove(
                'hidden',
            );

            executionLogPanel.classList.add(
                'flex',
            );

            setActiveTab(
                executionLogTab,
            );
        }


        if (panelName === 'result') {

            testResultPanel.classList.remove(
                'hidden',
            );

            testResultPanel.classList.add(
                'flex',
            );

            setActiveTab(
                testResultTab,
            );
        }


        if (panelName === 'bdd') {

            bddPanel.classList.remove(
                'hidden',
            );

            bddPanel.classList.add(
                'flex',
            );

            setActiveTab(
                bddTab,
            );
        }
    }


    generatedCodeTab.addEventListener(
        'click',
        () => {

            showPanel('code');
        },
    );


    executionLogTab.addEventListener(
        'click',
        () => {

            showPanel('log');
        },
    );


    testResultTab.addEventListener(
        'click',
        () => {

            showPanel('result');
        },
    );


    bddTab.addEventListener(
        'click',
        () => {

            showPanel('bdd');
        },
    );


    /* -----------------------------------------------------
       STATUS
    ----------------------------------------------------- */

    function updateStatusBadge(status) {

        if (status === 'passed') {

            testStatusBadge.className =
                'text-secondary bg-secondary/10 px-2 py-1 rounded';

            testStatusBadge.textContent =
                'Passed';

            testStatus.textContent =
                'Passed';

            testStatus.className =
                'text-secondary font-semibold';

            return;
        }


        if (status === 'failed') {

            testStatusBadge.className =
                'text-error bg-error/10 px-2 py-1 rounded';

            testStatusBadge.textContent =
                'Failed';

            testStatus.textContent =
                'Failed';

            testStatus.className =
                'text-error font-semibold';

            return;
        }


        if (status === 'stopped') {

            testStatusBadge.className =
                'text-yellow-400 bg-yellow-400/10 px-2 py-1 rounded';

            testStatusBadge.textContent =
                'Stopped';

            testStatus.textContent =
                'Stopped';

            return;
        }


        testStatusBadge.className =
            'text-primary bg-primary/10 px-2 py-1 rounded';

        testStatusBadge.textContent =
            'Running';

        testStatus.textContent =
            'Running';
    }


    /* -----------------------------------------------------
       ARTIFACTS
    ----------------------------------------------------- */

    function updateArtifactButtons() {

        screenshotArtifactButton.disabled =
            !appState.latestArtifacts.screenshot;

        videoArtifactButton.disabled =
            !appState.latestArtifacts.video;

        traceArtifactButton.disabled =
            !appState.latestArtifacts.trace;

        if (screenshotDownloadButton) {
            screenshotDownloadButton.disabled =
                !appState.latestArtifacts.screenshot;
        }

        if (videoDownloadButton) {
            videoDownloadButton.disabled =
                !appState.latestArtifacts.video;
        }

        if (traceDownloadButton) {
            traceDownloadButton.disabled =
                !appState.latestArtifacts.trace;
        }


        [
            screenshotArtifactButton,
            videoArtifactButton,
            traceArtifactButton,
            screenshotDownloadButton,
            videoDownloadButton,
            traceDownloadButton,
        ].filter(Boolean).forEach((button) => {

            if (button.disabled) {

                button.classList.add(
                    'opacity-40',
                    'cursor-not-allowed',
                );

            } else {

                button.classList.remove(
                    'opacity-40',
                    'cursor-not-allowed',
                );
            }
        });
    }


    /* -----------------------------------------------------
       RESULT UI
    ----------------------------------------------------- */

    function updateTestResultUI(
        result,
        selectedBrowser,
        duration,
    ) {

        const passed =
            result.status ===
            'passed';


        updateStatusBadge(
            passed
                ? 'passed'
                : 'failed',
        );


        testDuration.textContent =
            `${duration}s`;

        testBrowser.textContent =
            selectedBrowser;

        testExitCode.textContent =
            result.result?.exitCode ??
            '-';

        testFileResult.textContent =
            result.testFile ||
            '-';


        appState.latestArtifacts = {

            screenshot:
                result.result
                    ?.artifacts
                    ?.screenshot ||
                null,

            video:
                result.result
                    ?.artifacts
                    ?.video ||
                null,

            trace:
                result.result
                    ?.artifacts
                    ?.trace ||
                null,
        };


        updateArtifactButtons();
    }


    /* -----------------------------------------------------
       RESTORE GENERATED CODE
    ----------------------------------------------------- */

    if (
        appState.pendingGeneratedCode
    ) {

        generatedCodeOutput.textContent =
            appState.pendingGeneratedCode;


        generatedFileName.value =
            appState.pendingGeneratedFile ||
            'generated-test.spec.ts';


        showPanel('code');


        appState.pendingGeneratedCode =
            null;

        appState.pendingGeneratedFile =
            null;
    }


    /* -----------------------------------------------------
       RESTORE TEST RESULT
    ----------------------------------------------------- */

    if (
        appState.pendingTestResult
    ) {

        const pending =
            appState.pendingTestResult;


        generatedFileName.value =
            pending.result.testFile ||
            'generated-test.spec.ts';


        executionLogOutput.textContent =
            `${
                pending.result.result?.output ||
                ''
            }\n${
                pending.result.result?.errorOutput ||
                ''
            }`.trim() ||
            pending.result.message ||
            'Run output not found.';


        bddDescriptionOutput.value =
            pending.result.bddDescription ||
            '';

        appState.currentRunId =
            pending.result.runId ||
            null;

        bddSaveStatus.textContent =
            '';


        updateTestResultUI(
            pending.result,
            pending.browser,
            pending.duration,
        );


        if (
            pending.result.status ===
            'passed'
        ) {

            showPanel('result');

        } else {

            showPanel('log');
        }


        appState.pendingTestResult =
            null;
    }


    /* -----------------------------------------------------
       LIVE EXECUTION LOG (WebSocket)
       ------------------------------------------------------
       Backend, generate-and-run isteği HENÜZ sonuçlanmadan (test daha bitmeden) runId'yi
       GET /api/tests/current-run-id üzerinden açığa çıkarır. Bunu kısa aralıklarla yoklayıp
       runId'yi öğrenir öğrenmez /ws/runs/:runId WebSocket'ine bağlanıyoruz; her "step" olayını
       CANLI olarak Execution Log paneline ekliyoruz. Asıl/nihai sonuç YİNE ana fetch() isteğinin
       cevabından gelir — bu mekanizma sadece bekleme sırasında ekstra, canlı bilgi ekler, mevcut
       sözleşmeyi (generate-and-run'ın döndürdüğü veri) hiç değiştirmez. Best-effort: WS her
       nedenle başarısız olursa sessizce yok sayılır, test akışını asla etkilemez.
    ----------------------------------------------------- */

    let liveLogSocket = null;
    let liveLogPollTimer = null;
    let liveLogConnected = false;


    // v3.1 — BDD-stil, insan-okunur satır (bkz. backend BddStepView/buildBddSteps.ts dosya başı
    // açıklaması ve trackBatchRuns()'taki AYNI alan seçimi — "Aynı şekil buildBddSteps() ile
    // birebir eşleşsin diye" notu burada da geçerli). ÖNCEDEN ham/teknik bir format kullanılıyordu
    // (ör. "[Step 1] click -> e12 | OK: ..."), artık AI'nın o adım için verdiği doğal dil
    // gerekçesi/özeti gösteriliyor (ör. "Step 1: Arama kısmına tıklandı") — sohbet notu: "step 1
    // arama kısmına tıklandı ... gibi stepler olsun istiyorum".
    //
    // [LLM]/[Cache]/[Replay] etiketi için bkz. dosya başındaki GLOBAL ELEMENTS bölümünde tanımlı
    // DECISION_SOURCE_LABELS (Generated Tests sayfasının adım listesiyle AYNI etiketi kullansın
    // diye modül-seviyesinde, bu closure'a özel DEĞİL).
    function formatLiveStepLine(step) {

        const description =
            step.decision?.summary?.trim() ||
            step.decision?.reasoning ||
            step.decision?.action ||
            '';

        const sourceLabel =
            DECISION_SOURCE_LABELS[step.decision?.decisionSource] || '';

        const sourceSuffix =
            sourceLabel
                ? ` [${sourceLabel}]`
                : '';

        const failSuffix =
            step.actionResult?.ok === false
                ? ' — BAŞARISIZ'
                : '';

        return `Step ${step.stepIndex + 1}: ${description}${sourceSuffix}${failSuffix}`;
    }


    function appendLiveLogLine(line) {

        const isPlaceholder =
            executionLogOutput.textContent === 'Preparing test...' ||
            executionLogOutput.textContent === 'No test has been run yet.';

        executionLogOutput.textContent =
            isPlaceholder
                ? line
                : `${executionLogOutput.textContent}\n${line}`;

        executionLogOutput.scrollTop =
            executionLogOutput.scrollHeight;
    }


    // v2.2 — SADECE Selenium Grid ile çalışan, noVNC eşlemesi olan run'larda backend bir
    // 'grid_live_view' olayı (veya geç bağlanan bir istemci için 'run_snapshot'ın
    // summary.seleniumGridLiveViewUrl alanı) gönderir — bu iki fonksiyon o linki
    // Execution Log başlığındaki gizli <a> öğesinde gösterir/gizler. Best-effort: bu link hiç
    // gelmeyebilir (Grid kullanılmıyorsa, ya da .env'de SELENIUM_GRID_NODE_VNC_MAP tanımsızsa) —
    // bu durumda link basitçe hep gizli kalır, testin kendisini hiç etkilemez.
    function showGridLiveViewLink(url) {

        gridLiveViewLink.href = url;
        gridLiveViewLink.classList.remove('hidden');
        gridLiveViewLink.classList.add('flex');
    }


    function hideGridLiveViewLink() {

        gridLiveViewLink.classList.add('hidden');
        gridLiveViewLink.classList.remove('flex');
        gridLiveViewLink.href = '#';
    }


    function disconnectLiveLog() {

        if (liveLogPollTimer) {

            clearTimeout(liveLogPollTimer);
            liveLogPollTimer = null;
        }

        if (liveLogSocket) {

            liveLogSocket.close();
            liveLogSocket = null;
        }

        liveLogConnected = false;
    }


    function openLiveLogSocket(runId) {

        liveLogConnected = true;

        const protocol =
            window.location.protocol === 'https:'
                ? 'wss:'
                : 'ws:';

        const socket = new WebSocket(
            `${protocol}//${window.location.host}/ws/runs/${runId}`,
        );

        liveLogSocket = socket;

        socket.addEventListener(
            'message',
            (event) => {

                try {

                    const data =
                        JSON.parse(event.data);

                    if (data.type === 'step') {

                        appendLiveLogLine(
                            formatLiveStepLine(data.step),
                        );

                    } else if (data.type === 'grid_live_view') {

                        showGridLiveViewLink(data.url);

                    } else if (
                        data.type === 'run_snapshot' &&
                        data.summary?.seleniumGridLiveViewUrl
                    ) {

                        // Geç bağlanan bir istemci — session zaten açılmışsa (grid_live_view olayı
                        // kaçırılmış olabilir) summary üzerinden yine de yakalıyoruz.
                        showGridLiveViewLink(
                            data.summary.seleniumGridLiveViewUrl,
                        );
                    }

                } catch (error) {

                    console.error(
                        'Failed to process live log message:',
                        error,
                    );
                }
            },
        );

        socket.addEventListener(
            'error',
            () => {
                // Sessizce yok say — canlı log best-effort'tur; WS başarısız olsa bile asıl
                // sonuç yine de ana fetch() isteğinden gelecektir.
            },
        );
    }


    async function connectLiveExecutionLog() {

        disconnectLiveLog();

        const deadline =
            performance.now() + 5000;


        const poll = async () => {

            if (
                liveLogConnected ||
                performance.now() > deadline
            ) {
                return;
            }

            try {

                const response =
                    await fetch('/api/tests/current-run-id');

                const data =
                    await response.json();

                if (data.runId) {

                    openLiveLogSocket(data.runId);
                    return;
                }

            } catch (error) {

                console.error(
                    'Failed to query current-run-id:',
                    error,
                );
            }

            liveLogPollTimer =
                setTimeout(poll, 150);
        };


        await poll();
    }


    /* -----------------------------------------------------
       PENDING LIVE RUN
       ------------------------------------------------------
       v3.12 — bkz. sohbet notu: "generated testten test koştuğumda create test sayfasında olan
       panelden yine göreyim istiyorum". Generated Tests sayfasındaki "Run"/"Replay" butonları
       (bkz. runExistingTest/replayExistingTest) artık run'ı BAŞLATTIKLARI AN bu sayfaya
       yönlendiriyor (sonucu BEKLEMEDEN) — appState.pendingLiveRun BURADA true bulunursa, tıpkı
       "Generate & Run" butonuna basılmış gibi Execution Log paneline geçip canlı takibi
       (connectLiveExecutionLog — YUKARIDAKİ bölüm, bu yüzden bu blok ONDAN SONRA olmalı: aksi
       halde liveLogSocket/liveLogPollTimer henüz TDZ'de olur) başlatıyoruz. Asıl/nihai sonuç,
       runExistingTest/replayExistingTest arka planda beklemeye devam ettiği fetch tamamlanınca
       AYNI appState.pendingTestResult köprüsüyle (yukarıdaki "RESTORE TEST RESULT" bloğu) ikinci
       bir navigateTo('create') ile gelir — burada SADECE "running" ara durumunu kuruyoruz.
    ----------------------------------------------------- */

    if (appState.pendingLiveRun) {

        const pendingRun = appState.pendingLiveRun;
        appState.pendingLiveRun = null;

        // v3.22 — bkz. sohbet notu: "Run butonuna tıklandığı zaman aynı BDD deki gibi açılan
        // ekranda bilgiler gelsin ve bdd deki bilgiler ile koşum yapılsın". `pendingRun` bir
        // nesneyse (bkz. runExistingTest içindeki buildScenarioSnapshotFromTest ataması), koşum
        // başlamadan ÖNCE soldaki Scenario Definition alanlarını (url/isim/değişkenler/tarayıcı
        // ayarları + Test Scenario Instructions'ta BDD metni) "BDD" butonuyla (bkz. "PENDING BDD
        // EDIT" bloğu) AYNI şekilde dolduruyoruz — kullanıcı hangi veriyle koşum yapıldığını
        // görsün (backend zaten HER ZAMAN bu veriyle çalışıyordu, bkz. LegacyTestService.
        // runGeneratedTest — burada eksik olan sadece ekranda GÖRÜNMESİYDİ). Eski çağrı
        // yollarında (ör. replayExistingTest) hâlâ `true` (boolean) gelir — bu durumda alanlara
        // DOKUNULMAZ, davranış tamamen ESKİSİ GİBİ kalır.
        if (pendingRun && typeof pendingRun === 'object') {

            targetUrlInput.value = pendingRun.url || '';
            testNameInput.value = pendingRun.testName || '';
            testScenarioInput.value = pendingRun.bddDescription || '';

            if (projectSelectInput) {
                // bkz. yukarıdaki projectsLoadPromise dosya başı NOT'u — <option>'lar hazır
                // olmadan .value ataması sessizce hiçbir şey seçmez.
                await projectsLoadPromise;
                projectSelectInput.value = pendingRun.projectId != null ? String(pendingRun.projectId) : '';
            }

            const runBrowserRadio = document.querySelector(
                `input[name="browser"][value="${pendingRun.browser || 'chromium'}"]`,
            );
            if (runBrowserRadio) runBrowserRadio.checked = true;

            if (headedModeInput) headedModeInput.checked = Boolean(pendingRun.headed);
            if (screenshotOption) screenshotOption.checked = Boolean(pendingRun.screenshot);
            if (videoOption) videoOption.checked = Boolean(pendingRun.video);
            if (traceOption) traceOption.checked = Boolean(pendingRun.trace);
            if (useSeleniumGridOption) useSeleniumGridOption.checked = Boolean(pendingRun.useSeleniumGrid);

            if (variablesContainer) {
                variablesContainer.querySelectorAll('.variableRow').forEach((row) => row.remove());
                const variableEntries = Object.entries(pendingRun.variables || {});
                if (variableEntries.length > 0) {
                    variableEntries.forEach(([key, value]) => createVariableRow(key, value, 'text'));
                } else {
                    createVariableRow();
                }
            }

            bddDescriptionOutput.value = pendingRun.bddDescription || '';
        }

        generateRunButton.disabled = true;

        generateRunButton.innerHTML = `
            <span class="spinner"></span>
            Running...
        `;

        stopTestButton.disabled = false;

        appState.currentRunId = null;
        bddSaveStatus.textContent = '';

        hideGridLiveViewLink();

        updateStatusBadge('running');
        showPanel('log');

        void connectLiveExecutionLog();
    }


    /* -----------------------------------------------------
       AI SCENARIO SUGGESTIONS
       ------------------------------------------------------
       Backend, verilen URL'yi GERÇEKTEN ziyaret edip (tek seferlik, salt-okunur bir DOM
       taraması) sayfaya özgü senaryo önerileri üretir. Bu, "Load Template" gibi statik/sahte bir
       liste DEĞİL — her URL için farklı, o sayfanın gerçek yapısına göre üretilmiş önerilerdir.
    ----------------------------------------------------- */

    if (
        suggestScenariosButton &&
        scenarioSuggestionsModal &&
        scenarioSuggestionsModalBody
    ) {

        // escapeHtml() artık global (bkz. dosya başındaki UTILITIES bölümü) — burada yerel bir
        // kopyası tutulmuyor.


        // Not: eskiden öneriler URL alanının hemen altına inline açılıyordu; bu hem sayfayı
        // aşağı itiyordu (reflow) hem de mantıksal olarak yanlış alana bağlıydı (öneriler
        // URL'den değil, "hangi senaryoyu yazayım" ihtiyacından doğuyor). Artık odaklı bir
        // modal içinde gösteriliyor — sayfa düzeni hiç bozulmuyor, seç-kapat akışı net.
        function openScenarioSuggestionsModal() {

            scenarioSuggestionsModal.classList.remove('hidden');
            scenarioSuggestionsModal.classList.add('flex');

            document.addEventListener('keydown', onSuggestionsModalKeydown);
        }


        function closeScenarioSuggestionsModal() {

            scenarioSuggestionsModal.classList.add('hidden');
            scenarioSuggestionsModal.classList.remove('flex');

            document.removeEventListener('keydown', onSuggestionsModalKeydown);
        }


        function onSuggestionsModalKeydown(event) {

            if (event.key === 'Escape') {
                closeScenarioSuggestionsModal();
            }
        }


        function renderSuggestionsLoading() {

            scenarioSuggestionsModalBody.innerHTML = `
                <div class="flex flex-col items-center justify-center gap-3 py-10 text-on-surface-variant">
                    <span class="spinner"></span>
                    <span class="font-body-sm text-body-sm">Analyzing page, preparing suggestions...</span>
                </div>
            `;
        }


        function renderSuggestionsError(message) {

            scenarioSuggestionsModalBody.innerHTML = `
                <div class="flex flex-col items-center justify-center gap-2 py-10 text-center">
                    <span class="material-symbols-outlined text-error text-[32px]">error</span>
                    <span class="font-body-sm text-body-sm text-on-surface">${escapeHtml(message)}</span>
                </div>
            `;
        }


        function renderScenarioSuggestions(suggestions) {

            if (!suggestions.length) {
                renderSuggestionsError('No suggestions could be generated for this page.');
                return;
            }

            scenarioSuggestionsModalBody.innerHTML =
                suggestions
                    .map(
                        (suggestion, index) => `
                            <button
                                type="button"
                                class="suggestionCard text-left p-2.5
                                       bg-surface-container
                                       hover:bg-surface-variant
                                       hover:border-primary/50
                                       border border-outline-variant
                                       rounded-md transition-colors"
                                data-index="${index}"
                            >
                                <div class="font-body-sm text-body-sm font-semibold text-on-surface">
                                    ${escapeHtml(suggestion.title)}
                                </div>
                                <div class="font-body-sm text-[12px] text-on-surface-variant mt-1">
                                    ${escapeHtml(suggestion.scenario)}
                                </div>
                            </button>
                        `,
                    )
                    .join('');

            scenarioSuggestionsModalBody
                .querySelectorAll('.suggestionCard')
                .forEach((card) => {

                    card.addEventListener(
                        'click',
                        () => {

                            const index =
                                Number(card.getAttribute('data-index'));

                            const suggestion =
                                suggestions[index];

                            if (!suggestion) {
                                return;
                            }

                            testScenarioInput.value =
                                suggestion.scenario;

                            testScenarioInput.focus();

                            closeScenarioSuggestionsModal();
                        },
                    );
                });
        }


        // Modal, sadece arka plana (backdrop) tıklanınca kapansın — panel içine tıklamak
        // kapatmamalı, bu yüzden tıklamanın hedefi doğrudan overlay'in kendisi mi diye bakıyoruz.
        scenarioSuggestionsModal.addEventListener(
            'click',
            (event) => {

                if (event.target === scenarioSuggestionsModal) {
                    closeScenarioSuggestionsModal();
                }
            },
        );

        if (closeScenarioSuggestionsModalButton) {

            closeScenarioSuggestionsModalButton.addEventListener(
                'click',
                closeScenarioSuggestionsModal,
            );
        }


        suggestScenariosButton.addEventListener(
            'click',
            async () => {

                const url =
                    targetUrlInput.value.trim();

                if (!url) {
                    showToast('Please enter a Target Application URL first.', 'info');
                    return;
                }

                try {
                    new URL(url);
                } catch {
                    showToast('Please enter a valid URL.', 'info');
                    return;
                }

                openScenarioSuggestionsModal();
                renderSuggestionsLoading();

                try {

                    const response =
                        await fetch('/api/scenarios/suggest', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                url,
                                // hepsiburada.com gibi siteler headless Chromium'u bot-koruması ile
                                // tespit edip boş sayfa döndürebiliyor — bu yüzden burada da,
                                // Execution Settings'teki AYNI Headed Mode tercihi kullanılıyor.
                                headed: headedModeInput.checked,
                            }),
                        });

                    const result =
                        await response.json();

                    if (!response.ok) {
                        throw new Error(
                            result.error?.message ||
                            'Failed to get scenario suggestions.',
                        );
                    }

                    renderScenarioSuggestions(
                        result.suggestions || [],
                    );

                } catch (error) {

                    console.error(error);

                    renderSuggestionsError(
                        error instanceof Error
                            ? error.message
                            : 'Failed to get scenario suggestions.',
                    );
                }
            },
        );
    }


    /* -----------------------------------------------------
       GENERATE & RUN
    ----------------------------------------------------- */

    generateRunButton.addEventListener(
        'click',
        async () => {

            const url =
                targetUrlInput
                    .value
                    .trim();


            const scenario =
                testScenarioInput
                    .value
                    .trim();

            const testName =
                testNameInput
                    ?.value
                    .trim() ||
                '';

            // v3.0 Faz 6 — bkz. initCreateTestPage() "PROJECT" NOT. Boşsa `undefined` gönderilir
            // (backend'deki projectId alanı OPSİYONEL — bkz. generateAndRunSchema).
            const selectedProjectId =
                projectSelectInput?.value
                    ? Number(projectSelectInput.value)
                    : undefined;


            const selectedBrowser =
                document.querySelector(
                    'input[name="browser"]:checked',
                )?.value ||
                'chromium';


            if (
                !url ||
                !scenario
            ) {

                showToast(
                    'You must fill in the URL and test scenario fields.',
                    'info',
                );

                return;
            }


            try {

                new URL(url);

            } catch {

                showToast(
                    'Please enter a valid URL.',
                    'info',
                );

                return;
            }


            saveExecutionSettings();


            generateRunButton.disabled =
                true;

            stopTestButton.disabled =
                false;


            generateRunButton.innerHTML = `
                <span class="spinner"></span>
                Generating & Running...
            `;


            generatedCodeOutput.textContent =
                'AI is generating test code...';

            executionLogOutput.textContent =
                'Preparing test...';

            // Önceki run'ın BDD özeti/kimliği bu yeni run'a ait değil — Save butonunun yanlış
            // (eski) bir run'ın üzerine yazmasını önlemek için temizleniyor.
            bddDescriptionOutput.value =
                '';

            appState.currentRunId =
                null;

            bddSaveStatus.textContent =
                '';

            // Önceki bir Grid koşusundan kalmış olabilecek linki temizle — bu run Grid kullanmıyorsa
            // ya da henüz session açılmadıysa yanlışlıkla eski/geçersiz bir linkin görünmesini önler.
            hideGridLiveViewLink();


            updateStatusBadge(
                'running',
            );

            showPanel('log');


            // Fire-and-forget: fetch() ile YARIŞ HALİNDE (paralel) başlatılıyor, onu bloklamaz.
            void connectLiveExecutionLog();


            const startTime =
                performance.now();


            try {

                const {
                    variables:
                        collectedVariables,
                    secrets:
                        collectedSecrets,
                } =
                    collectVariablesAndSecrets();

                const response =
                    await fetch(
                        '/api/tests/generate-and-run',
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/json',
                            },

                            body:
                                JSON.stringify({
                                    url,
                                    scenario,
                                    testName,

                                    headed:
                                    headedModeInput.checked,

                                    browser:
                                    selectedBrowser,

                                    screenshot:
                                    screenshotOption.checked,

                                    video:
                                    videoOption.checked,

                                    trace:
                                    traceOption.checked,

                                    useSeleniumGrid:
                                    useSeleniumGridOption.checked,

                                    variables:
                                    collectedVariables,

                                    secrets:
                                    collectedSecrets,

                                    projectId:
                                    selectedProjectId,
                                }),
                        },
                    );


                const result =
                    await response.json();


                const elapsedSeconds =
                    (
                        (
                            performance.now() -
                            startTime
                        ) /
                        1000
                    ).toFixed(2);


                generatedCodeOutput.textContent =
                    result.generatedCode ||
                    'No code returned.';


                generatedFileName.value =
                    result.testFile ||
                    'generated-test.spec.ts';


                appState.lastGeneratedFile =
                    result.testFile ||
                    null;


                // v3.2 — "gece test koşumu" zamanlaması (bkz. sohbet notu). generate-and-run
                // BAŞARIYLA bir fileName döndürdüyse (pass/fail farketmeksizin — backend her
                // durumda dosyayı kaydeder, bkz. LegacyTestService.finalizeResult) VE kullanıcı
                // "Run automatically" kutusunu işaretlediyse, ayrı bir PUT isteğiyle zamanlamayı
                // kaydeder. Bloklamaz (await YOK) — zamanlama kaydı testin kendi akışını GECİKTİRMEZ.
                if (
                    result.testFile &&
                    scheduleEnabledInput?.checked
                ) {
                    const selectedDays = getSelectedScheduleDays(scheduleDaysContainer);
                    if (selectedDays.length === 0) {
                        showToast('Schedule not saved: pick at least one day.', 'error');
                    } else {
                        void saveGeneratedTestSchedule(result.testFile, {
                            enabled: true,
                            time: scheduleTimeInput.value || '23:00',
                            days: selectedDays,
                        }).then((saved) => {
                            if (saved) showToast('Schedule saved.', 'success');
                        });
                    }
                }


                executionLogOutput.textContent =
                    `${
                        result.result?.output ||
                        ''
                    }\n${
                        result.result?.errorOutput ||
                        ''
                    }`.trim() ||
                    result.message ||
                    'Run output not found.';


                bddDescriptionOutput.value =
                    result.bddDescription ||
                    '';

                appState.currentRunId =
                    result.runId ||
                    null;

                bddSaveStatus.textContent =
                    '';


                updateTestResultUI(
                    result,
                    selectedBrowser,
                    elapsedSeconds,
                );


                if (
                    result.status ===
                    'passed'
                ) {

                    showPanel('result');

                } else {

                    showPanel('log');
                }


                if (!response.ok) {

                    throw new Error(
                        result.message ||
                        'Failed to run test.',
                    );
                }

            } catch (error) {

                console.error(error);


                updateStatusBadge(
                    'failed',
                );


                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);


                executionLogOutput.textContent +=
                    `\n\nTEST FAILED\n${message}`;


                showPanel('log');

            } finally {

                disconnectLiveLog();

                generateRunButton.disabled =
                    false;

                stopTestButton.disabled =
                    true;


                generateRunButton.innerHTML = `
                    <span
                        class="
                            material-symbols-outlined
                        "
                    >
                        smart_toy
                    </span>

                    Generate & Run Test
                `;
            }
        },
    );


    /* -----------------------------------------------------
       SAVE & SCHEDULE — ÇALIŞTIRMADAN KAYDET (v3.2, bkz. sohbet notu yukarıda)
       generate-and-run'ın çoğu alan/validasyonunu tekrar eder ama AgentLoop'u hiç tetiklemez.
    ----------------------------------------------------- */
    if (saveScheduleOnlyButton) {
        saveScheduleOnlyButton.addEventListener('click', async () => {
            const url = targetUrlInput.value.trim();
            const scenario = testScenarioInput.value.trim();
            const testName = testNameInput?.value.trim() || '';
            const selectedProjectId = projectSelectInput?.value ? Number(projectSelectInput.value) : undefined;
            const selectedBrowser = document.querySelector('input[name="browser"]:checked')?.value || 'chromium';

            if (!url || !scenario) {
                showToast('You must fill in the URL and test scenario fields.', 'info');
                return;
            }

            try {
                new URL(url);
            } catch {
                showToast('Please enter a valid URL.', 'info');
                return;
            }

            if (!scheduleEnabledInput?.checked) {
                showToast('Check "Run automatically" first and set a time/days.', 'info');
                return;
            }

            const selectedDays = getSelectedScheduleDays(scheduleDaysContainer);
            if (selectedDays.length === 0) {
                showToast('Pick at least one day for the schedule.', 'error');
                return;
            }

            const { variables: collectedVariables, secrets: collectedSecrets } = collectVariablesAndSecrets();

            // v3.2 — bkz. scheduleOnlySchema dosya başı açıklaması (backend, legacyTests.ts):
            // secrets asla diske yazılmaz, bu yüzden bu uç secrets'ı HİÇ kabul etmez. Kullanıcı bir
            // secret girdiyse burada erkenden, net bir mesajla durdurulur — sessizce yok sayılıp
            // gece başarısız bir koşumla karşılaşmasındansa.
            if (Object.keys(collectedSecrets).length > 0) {
                showToast(
                    'Scenarios with Secrets can\'t be scheduled without a first manual run — use "Generate & Run" with the schedule checked instead.',
                    'error',
                );
                return;
            }

            saveScheduleOnlyButton.disabled = true;
            const originalLabel = saveScheduleOnlyButton.innerHTML;
            saveScheduleOnlyButton.innerHTML = '<span class="spinner"></span> Saving...';

            try {
                const response = await fetch('/api/generated-tests/schedule-only', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url,
                        scenario,
                        testName,
                        headed: headedModeInput.checked,
                        browser: selectedBrowser,
                        screenshot: screenshotOption.checked,
                        video: videoOption.checked,
                        trace: traceOption.checked,
                        useSeleniumGrid: useSeleniumGridOption.checked,
                        variables: collectedVariables,
                        projectId: selectedProjectId,
                        schedule: {
                            enabled: true,
                            time: scheduleTimeInput.value || '23:00',
                            days: selectedDays,
                        },
                    }),
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.message || 'Failed to save the scheduled scenario.');
                }

                appState.lastGeneratedFile = result.fileName || null;
                showToast('Saved — this scenario will run for the first time at the scheduled time.', 'success');
            } catch (error) {
                console.error(error);
                showToast(
                    error instanceof Error ? error.message : 'Failed to save the scheduled scenario.',
                    'error',
                );
            } finally {
                saveScheduleOnlyButton.disabled = false;
                saveScheduleOnlyButton.innerHTML = originalLabel;
            }
        });
    }


    /* -----------------------------------------------------
       STOP
    ----------------------------------------------------- */

    stopTestButton.addEventListener(
        'click',
        async () => {

            // NOT: /api/tests/stop, ajana bir iptal BAYRAĞI göndermekle sınırlıdır — backend
            // ajanın o an sürmekte olan adımını (LLM çağrısı + tarayıcı aksiyonu) YARIDA KESMEZ,
            // sadece bir sonraki güvenli kontrol noktasında durmasını SAĞLAR. Bu yüzden burada
            // hemen "durdu" (tamamlandı) demiyoruz — bu, gerçekte hâlâ süren bir işlemi bitmiş gibi
            // gösterip kullanıcıyı yanıltıyordu ("durdu" yazıyor ama arka planda çalışmaya devam
            // ediyordu). Butonu hemen kilitliyoruz, canlı log akışını hemen kesiyoruz (aksi halde
            // "durduruldu" mesajından SONRA da yeni adım satırları gelmeye devam ediyordu — asıl
            // şikayet buydu), ve GERÇEK nihai durumu (passed/failed/stopped), zaten devam eden
            // generate-and-run isteği sonuçlandığında normal akış (yukarıdaki finally/catch bloğu)
            // belirleyecek.
            stopTestButton.disabled =
                true;

            try {

                const response =
                    await fetch(
                        '/api/tests/stop',
                        {
                            method: 'POST',
                        },
                    );


                const result =
                    await response.json();


                if (!response.ok) {

                    showToast(
                        result.message ||
                        'Failed to stop test.',
                        'error',
                    );

                    stopTestButton.disabled =
                        false;

                    return;
                }


                disconnectLiveLog();


                executionLogOutput.textContent +=
                    '\n\nStop requested — waiting for the agent to reach a safe point to halt...';


                showPanel('log');

            } catch (error) {

                console.error(error);

                showToast(
                    'Failed to stop test.',
                    'error',
                );

                stopTestButton.disabled =
                    false;
            }
        },
    );


    /* -----------------------------------------------------
       COPY
    ----------------------------------------------------- */

    copyCodeButton.addEventListener(
        'click',
        async () => {

            const code =
                generatedCodeOutput
                    .textContent
                    .trim();


            if (
                !code ||
                code ===
                'No test generated yet.'
            ) {

                showToast(
                    'No code available to copy.',
                    'info',
                );

                return;
            }


            try {

                await navigator
                    .clipboard
                    .writeText(code);


                showToast(
                    'Test code copied to clipboard.',
                    'success',
                );

            } catch (error) {

                console.error(error);

                showToast(
                    'Failed to copy code.',
                    'error',
                );
            }
        },
    );


    /* -----------------------------------------------------
       SAVE
    ----------------------------------------------------- */

    saveCodeButton.addEventListener(
        'click',
        () => {

            const code =
                generatedCodeOutput
                    .textContent
                    .trim();


            if (
                !code ||
                code ===
                'No test generated yet.'
            ) {

                showToast(
                    'No code available to save.',
                    'info',
                );

                return;
            }


            showToast(
                `Test is saved as ${generatedFileName.value} in the generated-tests folder.`,
                'success',
            );
        },
    );


    /* -----------------------------------------------------
       COPY BDD DESCRIPTION
       ------------------------------------------------------
       v3.16 — bkz. sohbet notu: "bdd kısmına yazılan cümlecikleri copy kısmımız olsun". Panoya
       kopyalama — kaydetmeden BAĞIMSIZ, `appState.currentRunId` gerektirmez (henüz hiç run
       çalıştırılmamış olsa bile textarea'daki metni — ör. elle yazılmış bir taslağı — kopyalayabilir).
       Diğer "Copy" butonlarıyla (bkz. copySuggestionButton/copyAllButton) AYNI navigator.clipboard
       deseni kullanılır.
    ----------------------------------------------------- */

    if (copyBddButton) {
        copyBddButton.addEventListener(
            'click',
            async () => {

                const text = bddDescriptionOutput.value;

                if (!text.trim()) {
                    showToast('Nothing to copy yet.', 'info');
                    return;
                }

                try {
                    await navigator.clipboard.writeText(text);
                    showToast('BDD description copied to clipboard.', 'success');
                } catch (error) {
                    console.error(error);
                    showToast('Could not copy to clipboard.', 'error');
                }
            },
        );
    }


    /* -----------------------------------------------------
       SAVE BDD DESCRIPTION
       ------------------------------------------------------
       v3.10 — bkz. bddPanel/bddDescriptionOutput dosya başı NOT'ları. Run bitince otomatik dolan
       (ya da kullanıcının elle düzenlediği) metni kalıcı kayda (test-runs-index.json'daki ilgili
       run kaydı) yazar. `appState.currentRunId` YOKSA (henüz hiç run çalıştırılmadıysa) backend'e
       hiç istek atmadan bilgilendirici bir toast gösterir.
    ----------------------------------------------------- */

    saveBddButton.addEventListener(
        'click',
        async () => {

            if (!appState.currentRunId) {

                showToast(
                    'Run a test first, then you can save its BDD description.',
                    'info',
                );

                return;
            }


            saveBddButton.disabled =
                true;

            bddSaveStatus.textContent =
                'Saving...';


            try {

                const response =
                    await fetch(
                        `/api/test-runs/${encodeURIComponent(appState.currentRunId)}/bdd-description`,
                        {
                            method: 'PATCH',

                            headers: {
                                'Content-Type':
                                    'application/json',
                            },

                            body:
                                JSON.stringify({
                                    bddDescription:
                                        bddDescriptionOutput.value,
                                }),
                        },
                    );

                const result =
                    await response.json();

                if (!response.ok) {

                    throw new Error(
                        result.message ||
                        'Failed to save BDD description.',
                    );
                }


                bddSaveStatus.textContent =
                    'Saved';

                showToast(
                    'BDD description saved.',
                    'success',
                );

            } catch (error) {

                console.error(error);

                bddSaveStatus.textContent =
                    '';

                showToast(
                    error instanceof Error
                        ? error.message
                        : 'Failed to save BDD description.',
                    'error',
                );

            } finally {

                saveBddButton.disabled =
                    false;
            }
        },
    );


    /* -----------------------------------------------------
       DOWNLOAD
    ----------------------------------------------------- */

    downloadCodeButton.addEventListener(
        'click',
        () => {

            const code =
                generatedCodeOutput
                    .textContent
                    .trim();


            if (
                !code ||
                code ===
                'No test generated yet.'
            ) {

                showToast(
                    'No code available to download.',
                    'info',
                );

                return;
            }


            const blob =
                new Blob(
                    [code],
                    {
                        type:
                            'text/typescript;charset=utf-8',
                    },
                );


            const url =
                URL.createObjectURL(
                    blob,
                );


            const link =
                document.createElement(
                    'a',
                );


            link.href =
                url;

            link.download =
                generatedFileName.value ||
                'generated-test.spec.ts';


            document.body.appendChild(
                link,
            );

            link.click();

            link.remove();


            URL.revokeObjectURL(
                url,
            );
        },
    );


    /* -----------------------------------------------------
       ARTIFACT BUTTONS
    ----------------------------------------------------- */

    // Ana butonlar (Screenshots/Video/Trace) eskisi gibi yeni sekmede AÇAR — indirme SADECE ayrı
    // "indir" ikonuna basılınca tetiklenir (bkz. downloadArtifact ve *DownloadButton'lar aşağıda).
    // Backend ile aynı origin'den servis edildiği için (bkz. app.ts: /artifacts express.static)
    // <a download> ile gerçek bir indirme tetiklenebiliyor; dosya doğrudan bilgisayara iniyor.
    function downloadArtifact(url) {

        if (!url) {
            return;
        }

        const fileName =
            url.split('/').filter(Boolean).pop() || 'artifact';

        const link =
            document.createElement('a');

        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }


    screenshotArtifactButton.addEventListener(
        'click',
        () => {

            if (
                appState
                    .latestArtifacts
                    .screenshot
            ) {

                window.open(
                    appState
                        .latestArtifacts
                        .screenshot,
                    '_blank',
                );
            }
        },
    );


    videoArtifactButton.addEventListener(
        'click',
        () => {

            if (
                appState
                    .latestArtifacts
                    .video
            ) {

                window.open(
                    appState
                        .latestArtifacts
                        .video,
                    '_blank',
                );
            }
        },
    );


    traceArtifactButton.addEventListener(
        'click',
        () => {

            if (
                appState
                    .latestArtifacts
                    .trace
            ) {

                window.open(
                    appState
                        .latestArtifacts
                        .trace,
                    '_blank',
                );
            }
        },
    );


    if (screenshotDownloadButton) {
        screenshotDownloadButton.addEventListener(
            'click',
            () => {
                downloadArtifact(
                    appState
                        .latestArtifacts
                        .screenshot,
                );
            },
        );
    }


    if (videoDownloadButton) {
        videoDownloadButton.addEventListener(
            'click',
            () => {
                downloadArtifact(
                    appState
                        .latestArtifacts
                        .video,
                );
            },
        );
    }


    if (traceDownloadButton) {
        traceDownloadButton.addEventListener(
            'click',
            () => {
                downloadArtifact(
                    appState
                        .latestArtifacts
                        .trace,
                );
            },
        );
    }


    updateArtifactButtons();


    /* -----------------------------------------------------
       PENDING BDD EDIT — bkz. appState.pendingBddEdit dosya başı NOT'u. Generated Tests
       sayfasından "BDD" butonuyla buraya yönlendirildiysek (bkz. openBddEditorForGeneratedTest),
       normal "code" sekmesi yerine BDD panelini metniyle DOLU açıyoruz — kullanıcı direkt
       düzenlemeye başlayabilsin diye.
    ----------------------------------------------------- */

    if (appState.pendingBddEdit) {

        const pending = appState.pendingBddEdit;
        appState.pendingBddEdit = null;

        // v3.21 — bkz. openBddEditorForGeneratedTest() dosya başı NOT'u. Sağdaki "BDD" sekmesi
        // ESKİSİ GİBİ bu run'ın özetini gösterir/kaydeder (DEĞİŞMEDİ) — ama ARTIK soldaki TÜM giriş
        // alanları da (url/isim/değişkenler/tarayıcı ayarları) bu testten doldurulur, VE "Test
        // Scenario Instructions" KESİNLİKLE orijinal senaryo metni DEĞİL, BDD verisiyle (aynı
        // metin) doldurulur — kullanıcı "Generate & Run" ile doğrudan BDD'yi baz alarak devam
        // edebilsin diye. Secrets BİLEREK doldurulmaz (bkz. openBddEditorForGeneratedTest NOT'u).
        targetUrlInput.value = pending.url || '';
        testNameInput.value = pending.testName || '';
        testScenarioInput.value = pending.bddDescription || '';

        if (projectSelectInput) {
            // bkz. yukarıdaki projectsLoadPromise dosya başı NOT'u — <option>'lar hazır olmadan
            // .value ataması sessizce hiçbir şey seçmez.
            await projectsLoadPromise;
            projectSelectInput.value = pending.projectId != null ? String(pending.projectId) : '';
        }

        const browserRadio = document.querySelector(
            `input[name="browser"][value="${pending.browser || 'chromium'}"]`,
        );
        if (browserRadio) browserRadio.checked = true;

        if (headedModeInput) headedModeInput.checked = Boolean(pending.headed);
        if (screenshotOption) screenshotOption.checked = Boolean(pending.screenshot);
        if (videoOption) videoOption.checked = Boolean(pending.video);
        if (traceOption) traceOption.checked = Boolean(pending.trace);
        if (useSeleniumGridOption) useSeleniumGridOption.checked = Boolean(pending.useSeleniumGrid);

        if (variablesContainer) {
            variablesContainer.querySelectorAll('.variableRow').forEach((row) => row.remove());
            const variableEntries = Object.entries(pending.variables || {});
            if (variableEntries.length > 0) {
                variableEntries.forEach(([key, value]) => createVariableRow(key, value, 'text'));
            } else {
                createVariableRow();
            }
        }

        bddDescriptionOutput.value = pending.bddDescription || '';
        appState.currentRunId = pending.runId || null;
        bddSaveStatus.textContent = '';

        showPanel('bdd');

        if (!pending.runId) {
            // Bu alan eklenmeden ÖNCE üretilmiş eski bir kayıt (bkz. LegacyGeneratedTestMeta.runId
            // dosya başı açıklaması) — metin görüntülenebilir ama Save'e basınca normal "run kimliği
            // yok" uyarısı çıkacak, kullanıcı şaşırmasın diye burada da bilgilendiriyoruz.
            showToast(
                'This is an older record without a linked run — changes here cannot be saved.',
                'info',
            );
        } else {
            showToast(
                'Filled in from this test — Test Scenario Instructions uses the BDD steps.',
                'success',
            );
        }

    } else {

        showPanel('code');
    }
}


/* =========================================================
   SCENARIO SUGGESTIONS PAGE
   ------------------------------------------------------
   Create Test sayfasındaki modal tabanlı öneri özelliğinin (bkz. yukarıdaki "AI SCENARIO
   SUGGESTIONS" bölümü) AYNI backend uç noktasını (/api/scenarios/suggest) kullanan, ama kendi
   başına gezilebilen, daha geniş/odaklı bir sayfa hâli. Modal küçük bir alana sıkışmak zorundaydı;
   bu sayfa sonuçları tam genişlikte kart ızgarası olarak gösterip her karta Kopyala + "Use in
   Create Test" gibi ek işlevler ekleyebiliyor.
========================================================= */

// Öneri listesi ARTIK localStorage'da (sessionStorage DEĞİL) kalıcı — kullanıcı başka bir sayfaya
// geçip geri döndüğünde, tarayıcıyı yenilediğinde ya da backend'i yeniden başlattığında (bu ikisi
// zaten frontend'i etkilemez, ama kullanıcı genelde backend'i yeniden başlatınca sayfayı da elle
// yeniliyor) liste KAYBOLMASIN diye. `testpilot.pendingSuggestion` (yukarıda, initCreateTestPage
// içinde) BİLEREK sessionStorage'da kalmaya devam ediyor — o TEK SEFERLİK bir aktarım verisi,
// burası ise kullanıcının üzerinde çalıştığı, kalıcı olması GEREKEN bir liste.
const SCENARIO_SUGGESTIONS_STORAGE_KEY = 'testpilot.scenarioSuggestions.v1';

function loadPersistedSuggestions() {
    try {
        const raw = window.localStorage.getItem(SCENARIO_SUGGESTIONS_STORAGE_KEY);
        if (!raw) return { suggestions: [], url: '', focus: '' };

        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.suggestions)) return { suggestions: [], url: '', focus: '' };

        return {
            suggestions: parsed.suggestions,
            url: typeof parsed.url === 'string' ? parsed.url : '',
            focus: typeof parsed.focus === 'string' ? parsed.focus : '',
        };
    } catch (error) {
        // Bozuk/eski şekilli veri ya da localStorage'a hiç erişilemiyor olabilir (ör. gizli mod
        // bazı tarayıcılarda kısıtlar) — bu ÖLÜMCÜL bir hata değil, sadece kalıcılık olmadan boş
        // bir listeyle devam ediyoruz.
        console.error(error);
        return { suggestions: [], url: '', focus: '' };
    }
}

function persistSuggestions(suggestions, url, focus) {
    try {
        window.localStorage.setItem(
            SCENARIO_SUGGESTIONS_STORAGE_KEY,
            JSON.stringify({ suggestions, url, focus }),
        );
    } catch (error) {
        // Kota dolu / erişilemiyor olabilir — kalıcılık kaybolur ama uygulama normal çalışmaya
        // devam etmeli, bu yüzden burada kullanıcıya toast GÖSTERMİYORUZ (asıl işlem zaten başarılı
        // oldu, sadece "hatırlama" kısmı başarısız oldu).
        console.error(error);
    }
}

function initScenarioSuggestionsPage() {

    const suggestUrlInput = document.getElementById('suggestUrlInput');
    const suggestHeadedMode = document.getElementById('suggestHeadedMode');
    const suggestFocusInput = document.getElementById('suggestFocusInput');
    const getSuggestionsButton = document.getElementById('getSuggestionsButton');

    // LOGIN-GATED PAGE SUPPORT (bkz. scenario-suggestions.html "LOGIN-GATED PAGE SUPPORT" bloğu) —
    // işaretlenirse, taramadan ÖNCE kısa bir AI destekli giriş adımı çalıştırılır (bkz. backend
    // ScenarioSuggester.performLogin).
    const suggestRequiresLoginCheckbox = document.getElementById('suggestRequiresLoginCheckbox');
    const loginConfigSection = document.getElementById('loginConfigSection');
    const loginUrlInput = document.getElementById('loginUrlInput');
    const loginScenarioInput = document.getElementById('loginScenarioInput');
    const addLoginVariableButton = document.getElementById('addLoginVariableButton');
    const loginVariablesContainer = document.getElementById('loginVariablesContainer');

    const emptyState = document.getElementById('suggestionsEmptyState');
    const loadingState = document.getElementById('suggestionsLoadingState');
    const errorState = document.getElementById('suggestionsErrorState');
    const errorMessage = document.getElementById('suggestionsErrorMessage');
    const retryButton = document.getElementById('retrySuggestionsButton');

    const resultsWrap = document.getElementById('suggestionsResultsWrap');
    const resultsSummary = document.getElementById('suggestionsResultsSummary');
    const resultsGrid = document.getElementById('suggestionsResultsGrid');
    const copyAllButton = document.getElementById('copyAllSuggestionsButton');
    const moreSuggestionsButton = document.getElementById('moreSuggestionsButton');
    const moreSuggestionsButtonLabel = document.getElementById('moreSuggestionsButtonLabel');

    if (
        !suggestUrlInput ||
        !getSuggestionsButton ||
        !emptyState ||
        !loadingState ||
        !errorState ||
        !resultsWrap ||
        !resultsGrid
    ) {
        return;
    }

    /* -----------------------------------------------------
       LOGIN-GATED PAGE SUPPORT
       Create Test sayfasındaki "Variables & Secrets" tablosuyla AYNI desen (bkz.
       initCreateTestPage() içindeki createVariableRow/collectVariablesAndSecrets) — kasıtlı olarak
       AYRI class'lar (.loginVariableRow vb.) ve AYRI fonksiyonlarla, tamamen izole şekilde
       kopyalandı. Sebep: bu sayfadaki değerler backend'e FARKLI bir alanda (login.variables/
       login.secrets) gönderiliyor, Create Test sayfasının koduna dokunmadan burada bağımsız
       kalması hem daha güvenli (yanlışlıkla Create Test'i bozma riski yok) hem daha basit.
    ----------------------------------------------------- */
    if (suggestRequiresLoginCheckbox && loginConfigSection) {
        suggestRequiresLoginCheckbox.addEventListener('change', () => {
            loginConfigSection.classList.toggle('hidden', !suggestRequiresLoginCheckbox.checked);
        });
    }

    function createLoginVariableRow(key = '', value = '', variableType = 'text') {
        const row = document.createElement('div');
        row.className = 'loginVariableRow grid grid-cols-12 gap-2 items-center';

        row.innerHTML = `
            <div class="col-span-3 input-well rounded-md">
                <input
                        class="loginVariableKey w-full bg-transparent border-none text-on-surface font-mono text-sm p-2 focus:ring-0"
                        type="text"
                        placeholder="KEY Name"
                />
            </div>

            <div class="col-span-2">
                <select
                        class="loginVariableType w-full bg-[#0F172A] border border-outline-variant text-on-surface text-sm rounded-md px-2 py-2 focus:ring-1 focus:ring-primary"
                >
                    <option value="text">Text</option>
                    <option value="secret">Secret</option>
                </select>
            </div>

            <div class="col-span-6 input-well rounded-md relative flex items-center">
                <input
                        class="loginVariableValue w-full bg-transparent border-none text-on-surface font-mono text-sm p-2 pr-9 focus:ring-0"
                        type="text"
                        placeholder="Value"
                />
                <button
                        class="toggleLoginVariableVisibility material-symbols-outlined text-[16px] text-outline absolute right-2 hidden"
                        type="button"
                        title="Show / Hide"
                        aria-label="Show or hide secret value"
                >
                    visibility
                </button>
            </div>

            <div class="col-span-1 flex justify-center">
                <button
                        class="deleteLoginVariableButton text-on-surface-variant hover:text-error"
                        type="button"
                        title="Delete Variable"
                        aria-label="Delete variable"
                >
                    <span class="material-symbols-outlined text-[18px]">delete</span>
                </button>
            </div>
        `;

        loginVariablesContainer.appendChild(row);

        const keyInput = row.querySelector('.loginVariableKey');
        const typeSelect = row.querySelector('.loginVariableType');
        const valueInput = row.querySelector('.loginVariableValue');
        const visibilityButton = row.querySelector('.toggleLoginVariableVisibility');
        const deleteButton = row.querySelector('.deleteLoginVariableButton');

        keyInput.value = key;
        valueInput.value = value;
        typeSelect.value = variableType;

        if (variableType === 'secret') {
            valueInput.type = 'password';
            visibilityButton.classList.remove('hidden');
        }

        typeSelect.addEventListener('change', () => {
            if (typeSelect.value === 'secret') {
                valueInput.type = 'password';
                visibilityButton.classList.remove('hidden');
                visibilityButton.textContent = 'visibility';
            } else {
                valueInput.type = 'text';
                visibilityButton.classList.add('hidden');
                visibilityButton.textContent = 'visibility';
            }
        });

        visibilityButton.addEventListener('click', () => {
            if (typeSelect.value !== 'secret') return;
            const isHidden = valueInput.type === 'password';
            valueInput.type = isHidden ? 'text' : 'password';
            visibilityButton.textContent = isHidden ? 'visibility_off' : 'visibility';
        });

        deleteButton.addEventListener('click', () => {
            row.remove();
        });
    }

    function collectLoginVariablesAndSecrets() {
        const variables = {};
        const secrets = {};

        document.querySelectorAll('.loginVariableRow').forEach((row) => {
            const key = row.querySelector('.loginVariableKey')?.value.trim();
            const value = row.querySelector('.loginVariableValue')?.value;
            const type = row.querySelector('.loginVariableType')?.value;

            if (key) {
                if (type === 'secret') {
                    secrets[key] = value || '';
                } else {
                    variables[key] = value || '';
                }
            }
        });

        return { variables, secrets };
    }

    if (addLoginVariableButton && loginVariablesContainer) {
        addLoginVariableButton.addEventListener('click', () => {
            createLoginVariableRow();
        });
    }

    // Son başarılı sonuç kümesi — "Copy All" ve tekrar render için burada tutuluyor. ARTIK
    // localStorage'dan yükleniyor (bkz. loadPersistedSuggestions() dosya başı açıklaması): sayfa
    // her navigateTo() ile yeniden yüklendiğinde ya da tarayıcı yenilendiğinde ARTIK sıfırlanmıyor.
    const persisted = loadPersistedSuggestions();
    let lastSuggestions = persisted.suggestions;
    let lastUrl = persisted.url;
    let lastFocus = persisted.focus;

    function showOnly(stateEl) {
        [emptyState, loadingState, errorState, resultsWrap].forEach((el) => {
            if (el) el.classList.toggle('hidden', el !== stateEl);
        });
    }

    // Kalıcı bir listeyle geldiysek (localStorage'da doluysa), sayfa ilk açıldığında BOŞ bir
    // "empty state" yerine doğrudan o listeyi göster; URL ve "focus" alanlarını da hatırlanan
    // değerlerle doldur (böylece "Get More Suggestions" aynı yönlendirmeyle devam edebilir).
    if (lastSuggestions.length) {
        if (lastUrl) suggestUrlInput.value = lastUrl;
        if (lastFocus && suggestFocusInput) suggestFocusInput.value = lastFocus;
        renderSuggestionsGrid();
        showOnly(resultsWrap);
    } else {
        showOnly(emptyState);
    }

    // Grid'i HER ZAMAN lastSuggestions/lastUrl'den çizer — hem yeni bir AI taramasından hem de
    // elle "Add Your Own Scenario" ile eklenen bir senaryodan sonra tekrar kullanılır, böylece
    // kullanıcı AI'ın önerdiği ~3-6 senaryoyla sınırlı kalmaz, istediği kadar kendi senaryosunu
    // aynı listeye ekleyebilir (silme butonuyla da geri çıkarabilir).
    function renderSuggestionsGrid() {
        resultsSummary.textContent = lastUrl
            ? `${lastSuggestions.length} suggestion(s) for ${lastUrl}`
            : `${lastSuggestions.length} suggestion(s)`;

        resultsGrid.innerHTML = lastSuggestions
            .map(
                (suggestion, index) => `
                    <div
                        class="bg-surface-container-low rounded-lg
                               border border-outline-variant
                               p-md flex flex-col gap-sm
                               hover:border-primary-container/50
                               transition-colors"
                    >
                        <div class="flex items-center justify-between gap-2">
                            <div class="font-body-md text-body-md font-semibold text-on-surface">
                                ${escapeHtml(suggestion.title)}
                            </div>
                            ${
                    suggestion.custom
                        ? '<span class="px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant font-body-sm text-[11px] shrink-0">Custom</span>'
                        : ''
                }
                        </div>

                        <div class="font-body-sm text-body-sm text-on-surface-variant flex-1">
                            ${escapeHtml(suggestion.scenario)}
                        </div>

                        <div class="flex gap-2 pt-sm border-t border-outline-variant/50">
                            <button
                                type="button"
                                data-index="${index}"
                                class="copySuggestionButton flex items-center gap-1.5
                                       px-3 py-1.5 rounded-lg
                                       border border-outline-variant
                                       text-on-surface-variant
                                       hover:text-on-surface
                                       hover:bg-surface-container-high
                                       transition-colors
                                       font-body-sm text-body-sm"
                            >
                                <span class="material-symbols-outlined text-[16px]">content_copy</span>
                                Copy
                            </button>

                            <button
                                type="button"
                                data-index="${index}"
                                class="useSuggestionButton flex items-center gap-1.5
                                       px-3 py-1.5 rounded-lg
                                       bg-primary-container
                                       text-white
                                       hover:bg-inverse-primary
                                       transition-colors
                                       font-body-sm text-body-sm font-bold"
                            >
                                <span class="material-symbols-outlined text-[16px]">add_circle</span>
                                Use in Create Test
                            </button>

                            <button
                                type="button"
                                data-index="${index}"
                                aria-label="Remove scenario"
                                class="removeSuggestionButton flex items-center gap-1.5
                                       px-3 py-1.5 rounded-lg
                                       border border-outline-variant
                                       text-on-surface-variant
                                       hover:text-error
                                       hover:border-error/40
                                       transition-colors
                                       font-body-sm text-body-sm"
                            >
                                <span class="material-symbols-outlined text-[16px]">close</span>
                            </button>
                        </div>
                    </div>
                `,
            )
            .join('');

        // Grid her çizildiğinde (yeni arama, "Get More", elle ekleme, silme sonrası) mevcut
        // lastSuggestions/lastUrl'i localStorage'a yazıyoruz — tek bir merkezî nokta, ayrı ayrı her
        // mutasyon noktasında tekrar tekrar çağırmak yerine (bkz. dosya başı açıklaması).
        persistSuggestions(lastSuggestions, lastUrl, lastFocus);

        resultsGrid.querySelectorAll('.copySuggestionButton').forEach((button) => {
            button.addEventListener('click', async () => {
                const suggestion = lastSuggestions[Number(button.getAttribute('data-index'))];
                if (!suggestion) return;
                try {
                    await navigator.clipboard.writeText(suggestion.scenario);
                    showToast('Scenario copied to clipboard.', 'success');
                } catch (error) {
                    console.error(error);
                    showToast('Could not copy to clipboard.', 'error');
                }
            });
        });

        resultsGrid.querySelectorAll('.useSuggestionButton').forEach((button) => {
            button.addEventListener('click', () => {
                const suggestion = lastSuggestions[Number(button.getAttribute('data-index'))];
                if (!suggestion) return;
                // Bkz. initCreateTestPage() içindeki "PENDING SUGGESTION HANDOFF" bloğu — bu,
                // TEK SEFERLİK bir aktarım verisidir, okunduğu anda karşı tarafta silinir.
                window.sessionStorage.setItem(
                    'testpilot.pendingSuggestion',
                    JSON.stringify({ url: lastUrl, scenario: suggestion.scenario }),
                );
                navigateTo('create');
            });
        });

        resultsGrid.querySelectorAll('.removeSuggestionButton').forEach((button) => {
            button.addEventListener('click', () => {
                const index = Number(button.getAttribute('data-index'));
                lastSuggestions = lastSuggestions.filter((_, i) => i !== index);
                if (lastSuggestions.length) {
                    renderSuggestionsGrid();
                } else {
                    // renderSuggestionsGrid() ÇAĞRILMIYOR (liste boş, çizecek bir şey yok) — bu
                    // yüzden persist'i burada elle yapmazsak, boşaltılmış liste localStorage'da
                    // ESKİ hâliyle kalır ve sayfa bir sonraki açılışta yanlışlıkla geri gelir.
                    persistSuggestions(lastSuggestions, lastUrl, lastFocus);
                    showOnly(emptyState);
                }
            });
        });
    }

    function renderResults(suggestions, url, focus) {
        lastSuggestions = suggestions;
        lastUrl = url;
        lastFocus = focus;

        if (!suggestions.length) {
            // Aynı sebeple: yeni arama 0 sonuç döndürdüyse, ÖNCEKİ (muhtemelen farklı bir URL'e
            // ait) kalıcı listeyi burada elle temizlemezsek sayfa bir sonraki açılışta o eski
            // sonuçları yanlışlıkla geri gösterir.
            persistSuggestions(lastSuggestions, lastUrl, lastFocus);
            errorMessage.textContent = 'No suggestions could be generated for this page.';
            showOnly(errorState);
            return;
        }

        renderSuggestionsGrid();
        showOnly(resultsWrap);
    }

    async function runSuggest() {
        const url = suggestUrlInput.value.trim();

        if (!url) {
            showToast('Please enter a URL first.', 'info');
            return;
        }

        try {
            new URL(url);
        } catch {
            showToast('Please enter a valid URL.', 'info');
            return;
        }

        const focus = suggestFocusInput ? suggestFocusInput.value.trim() : '';

        // LOGIN-GATED PAGE SUPPORT: sadece kutucuk işaretliyse ve bir login senaryosu girilmişse
        // gönderilir (bkz. backend ScenarioSuggester.performLogin) — işaretli değilse `login`
        // hiç gönderilmez, davranış eskisi gibi (anonim tarama) kalır.
        let login;
        if (suggestRequiresLoginCheckbox && suggestRequiresLoginCheckbox.checked) {
            const loginScenario = loginScenarioInput ? loginScenarioInput.value.trim() : '';
            if (!loginScenario) {
                showToast('Please describe the login steps first.', 'info');
                return;
            }
            const { variables: loginVariables, secrets: loginSecrets } = collectLoginVariablesAndSecrets();
            login = {
                url: loginUrlInput && loginUrlInput.value.trim() ? loginUrlInput.value.trim() : undefined,
                scenario: loginScenario,
                variables: loginVariables,
                secrets: loginSecrets,
            };
        }

        const loadingText = document.getElementById('suggestionsLoadingText');
        if (loadingText) {
            loadingText.textContent = login
                ? 'Logging in and analyzing the page, this may take a bit longer...'
                : 'Visiting the page and analyzing it, this may take a moment...';
        }

        showOnly(loadingState);
        getSuggestionsButton.disabled = true;

        try {
            const response = await fetch('/api/scenarios/suggest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    headed: suggestHeadedMode ? suggestHeadedMode.checked : true,
                    focus,
                    login,
                }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to get scenario suggestions.');
            }

            renderResults(result.suggestions || [], url, focus);
        } catch (error) {
            console.error(error);
            errorMessage.textContent =
                error instanceof Error ? error.message : 'Failed to get scenario suggestions.';
            showOnly(errorState);
        } finally {
            getSuggestionsButton.disabled = false;
        }
    }

    getSuggestionsButton.addEventListener('click', runSuggest);

    // Bir arama motoru gibi Enter'a basınca da aramanın tetiklenmesi beklenir.
    suggestUrlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            runSuggest();
        }
    });

    /**
     * "Get More Suggestions" — AYNI URL için AI'dan YENİ öneriler ister ve mevcut listeye
     * EKLER (renderResults gibi ÜZERİNE YAZMAZ). Kullanıcı sadece AI'ın ilk seferde döndürdüğü
     * ~3-6 senaryoyla sınırlı kalmasın diye eklendi. Zaten gösterilmiş senaryo metinlerini
     * `existingScenarios` ile backend'e gönderiyoruz ki LLM aynılarını tekrar önermesin
     * (bkz. ScenarioSuggester.ts kural 4b) — sayfayı yeniden ziyaret etmek/element taramak yine
     * gerekiyor (backend her istekte scanPage() çağırıyor), bu yüzden bu da normal "Get
     * Suggestions" kadar sürebilir.
     */
    async function runGetMore() {
        if (!lastUrl) return;

        if (moreSuggestionsButton) {
            moreSuggestionsButton.disabled = true;
            if (moreSuggestionsButtonLabel) moreSuggestionsButtonLabel.textContent = 'Loading...';
        }

        try {
            const response = await fetch('/api/scenarios/suggest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: lastUrl,
                    headed: suggestHeadedMode ? suggestHeadedMode.checked : true,
                    existingScenarios: lastSuggestions.map((s) => s.scenario),
                    // Aynı yönlendirmeyle devam et — kullanıcı "login sayfasına odaklan" dediyse
                    // "daha fazla öneri" de AYNI odakla gelmeli, genel önerilere dönmemeli.
                    focus: lastFocus,
                }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to get more suggestions.');
            }

            const newSuggestions = result.suggestions || [];

            if (!newSuggestions.length) {
                showToast('AI has no further new suggestions for this page right now.', 'info');
                return;
            }

            lastSuggestions = [...lastSuggestions, ...newSuggestions];
            renderSuggestionsGrid();
            showToast(`${newSuggestions.length} new suggestion(s) added.`, 'success');
        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to get more suggestions.', 'error');
        } finally {
            if (moreSuggestionsButton) {
                moreSuggestionsButton.disabled = false;
                if (moreSuggestionsButtonLabel) moreSuggestionsButtonLabel.textContent = 'Get More Suggestions';
            }
        }
    }

    if (moreSuggestionsButton) {
        moreSuggestionsButton.addEventListener('click', runGetMore);
    }

    if (retryButton) {
        retryButton.addEventListener('click', runSuggest);
    }

    if (copyAllButton) {
        copyAllButton.addEventListener('click', async () => {
            if (!lastSuggestions.length) return;
            const text = lastSuggestions
                .map((s, i) => `${i + 1}. ${s.title}\n${s.scenario}`)
                .join('\n\n');
            try {
                await navigator.clipboard.writeText(text);
                showToast('All suggestions copied to clipboard.', 'success');
            } catch (error) {
                console.error(error);
                showToast('Could not copy to clipboard.', 'error');
            }
        });
    }

    /* -----------------------------------------------------
       MANUAL SCENARIO ADD
       ------------------------------------------------------
       Kullanıcı AI'ın önerdiği (sayfa yapısına göre genelde 3-6 arası) senaryoyla sınırlı
       kalmasın diye eklendi — bu form, AI taraması hiç çalıştırılmamış olsa bile kullanılabilir
       (lastUrl boşsa handoff'ta URL boş gider, kullanıcı Create Test sayfasında kendi girer).
    ----------------------------------------------------- */
    const toggleManualAddButton = document.getElementById('toggleManualAddButton');
    const manualAddForm = document.getElementById('manualAddForm');
    const manualScenarioTitle = document.getElementById('manualScenarioTitle');
    const manualScenarioText = document.getElementById('manualScenarioText');
    const submitManualScenarioButton = document.getElementById('submitManualScenarioButton');
    const cancelManualScenarioButton = document.getElementById('cancelManualScenarioButton');

    if (toggleManualAddButton && manualAddForm) {
        toggleManualAddButton.addEventListener('click', () => {
            manualAddForm.classList.toggle('hidden');
            if (!manualAddForm.classList.contains('hidden') && manualScenarioTitle) {
                manualScenarioTitle.focus();
            }
        });
    }

    if (cancelManualScenarioButton && manualAddForm) {
        cancelManualScenarioButton.addEventListener('click', () => {
            if (manualScenarioTitle) manualScenarioTitle.value = '';
            if (manualScenarioText) manualScenarioText.value = '';
            manualAddForm.classList.add('hidden');
        });
    }

    if (submitManualScenarioButton && manualScenarioText) {
        submitManualScenarioButton.addEventListener('click', () => {
            const scenario = manualScenarioText.value.trim();

            if (!scenario) {
                showToast('Please describe the scenario first.', 'info');
                return;
            }

            const title = (manualScenarioTitle ? manualScenarioTitle.value.trim() : '') || 'Custom Scenario';

            lastSuggestions = [...lastSuggestions, { title, scenario, custom: true }];
            renderSuggestionsGrid();
            showOnly(resultsWrap);

            manualScenarioText.value = '';
            if (manualScenarioTitle) manualScenarioTitle.value = '';
            if (manualAddForm) manualAddForm.classList.add('hidden');

            showToast('Scenario added.', 'success');
        });
    }
}


/* =========================================================
   TEST RUNS
========================================================= */

async function initTestRunsPage() {

    const totalRunsCount =
        document.getElementById(
            'totalRunsCount',
        );

    const passedRunsCount =
        document.getElementById(
            'passedRunsCount',
        );

    const passedRunsPercentage =
        document.getElementById(
            'passedRunsPercentage',
        );

    const failedRunsCount =
        document.getElementById(
            'failedRunsCount',
        );

    const failedRunsPercentage =
        document.getElementById(
            'failedRunsPercentage',
        );


    const testRunsSearchInput =
        document.getElementById(
            'testRunsSearchInput',
        );

    const browserFilter =
        document.getElementById(
            'browserFilter',
        );

    const statusFilter =
        document.getElementById(
            'statusFilter',
        );


    const testRunsTableBody =
        document.getElementById(
            'testRunsTableBody',
        );

    const testRunsEmptyState =
        document.getElementById(
            'testRunsEmptyState',
        );

    const testRunsPagination =
        document.getElementById(
            'testRunsPagination',
        );

    const testRunsPaginationInfo =
        document.getElementById(
            'testRunsPaginationInfo',
        );

    const currentTestRunsPage =
        document.getElementById(
            'currentTestRunsPage',
        );

    const previousTestRunsPage =
        document.getElementById(
            'previousTestRunsPage',
        );

    const nextTestRunsPage =
        document.getElementById(
            'nextTestRunsPage',
        );

    const refreshTestRunsButton =
        document.getElementById(
            'refreshTestRunsButton',
        );

    const clearAllTestRunsButton =
        document.getElementById(
            'clearAllTestRunsButton',
        );


    /* MODAL */

    const testRunDetailsModal =
        document.getElementById(
            'testRunDetailsModal',
        );

    const closeTestRunDetailsModal =
        document.getElementById(
            'closeTestRunDetailsModal',
        );

    const closeTestRunDetailsButton =
        document.getElementById(
            'closeTestRunDetailsButton',
        );

    const runDetailsFile =
        document.getElementById(
            'runDetailsFile',
        );

    const runDetailsStatus =
        document.getElementById(
            'runDetailsStatus',
        );

    const runDetailsBrowser =
        document.getElementById(
            'runDetailsBrowser',
        );

    const runDetailsDuration =
        document.getElementById(
            'runDetailsDuration',
        );

    const runDetailsExitCode =
        document.getElementById(
            'runDetailsExitCode',
        );

    const runDetailsExecuted =
        document.getElementById(
            'runDetailsExecuted',
        );

    const runDetailsId =
        document.getElementById(
            'runDetailsId',
        );

    const runDetailsErrorSection =
        document.getElementById(
            'runDetailsErrorSection',
        );

    const runDetailsError =
        document.getElementById(
            'runDetailsError',
        );

    // v3.1 — bkz. sohbet notu: "test koşumlarında alınan ekran görüntüleri test runs da...
    // gözüksün" (bkz. LegacyRunRecord.artifacts, backend).
    const runDetailsScreenshotSection =
        document.getElementById(
            'runDetailsScreenshotSection',
        );

    const runDetailsScreenshotLink =
        document.getElementById(
            'runDetailsScreenshotLink',
        );

    const runDetailsScreenshotImg =
        document.getElementById(
            'runDetailsScreenshotImg',
        );


    let allRuns = [];

    let currentPage = 1;

    const pageSize = 10;


    function updateStats(runs) {

        const total =
            runs.length;


        const passed =
            runs.filter(
                (run) =>
                    run.status ===
                    'passed',
            ).length;


        const failed =
            runs.filter(
                (run) =>
                    run.status ===
                    'failed',
            ).length;


        const passedPercentage =
            total > 0
                ? (
                    passed /
                    total *
                    100
                ).toFixed(1)
                : '0.0';


        const failedPercentage =
            total > 0
                ? (
                    failed /
                    total *
                    100
                ).toFixed(1)
                : '0.0';


        totalRunsCount.textContent =
            total;

        passedRunsCount.textContent =
            passed;

        failedRunsCount.textContent =
            failed;

        passedRunsPercentage.textContent =
            `${passedPercentage}%`;

        failedRunsPercentage.textContent =
            `${failedPercentage}%`;
    }


    function getFilteredRuns() {

        const searchValue =
            testRunsSearchInput
                .value
                .trim()
                .toLowerCase();


        const selectedBrowser =
            browserFilter.value;


        const selectedStatus =
            statusFilter.value;


        return allRuns.filter((run) => {

            const matchesSearch =
                !searchValue ||
                run.testFile
                    ?.toLowerCase()
                    .includes(
                        searchValue,
                    ) ||
                run.error
                    ?.toLowerCase()
                    .includes(
                        searchValue,
                    ) ||
                run.errorOutput
                    ?.toLowerCase()
                    .includes(
                        searchValue,
                    ) ||
                String(run.id)
                    .toLowerCase()
                    .includes(
                        searchValue,
                    );


            const matchesBrowser =
                !selectedBrowser ||
                run.browser ===
                selectedBrowser;


            const matchesStatus =
                !selectedStatus ||
                run.status ===
                selectedStatus;


            return (
                matchesSearch &&
                matchesBrowser &&
                matchesStatus
            );
        });
    }


    function getRunError(run) {

        if (
            run.status !==
            'failed'
        ) {
            return '';
        }


        const errorText =
            run.error ||
            run.errorOutput ||
            run.message ||
            'Test execution failed.';


        const firstLine =
            String(errorText)
                .split('\n')
                .find(
                    (line) =>
                        line.trim(),
                );


        return firstLine
            ? firstLine.trim()
            : 'Test execution failed.';
    }


    function renderRuns() {

        const filteredRuns =
            getFilteredRuns();


        const totalPages =
            Math.max(
                1,
                Math.ceil(
                    filteredRuns.length /
                    pageSize,
                ),
            );


        if (
            currentPage >
            totalPages
        ) {

            currentPage =
                totalPages;
        }


        const startIndex =
            (
                currentPage -
                1
            ) *
            pageSize;


        const endIndex =
            startIndex +
            pageSize;


        const pageRuns =
            filteredRuns.slice(
                startIndex,
                endIndex,
            );


        if (
            filteredRuns.length ===
            0
        ) {

            testRunsTableBody.innerHTML =
                '';


            testRunsEmptyState.classList.remove(
                'hidden',
            );


            testRunsPagination.classList.add(
                'hidden',
            );

            testRunsPagination.classList.remove(
                'flex',
            );

            return;
        }


        testRunsEmptyState.classList.add(
            'hidden',
        );


        testRunsTableBody.innerHTML =
            pageRuns
                .map((run) => {

                    const passed =
                        run.status ===
                        'passed';


                    const running =
                        run.status ===
                        'running';


                    let statusIcon =
                        '';

                    let statusClass =
                        '';


                    if (passed) {

                        statusIcon =
                            'check_circle';

                        statusClass =
                            'text-secondary';

                    } else if (running) {

                        statusIcon =
                            'progress_activity';

                        statusClass =
                            'text-primary animate-spin';

                    } else {

                        statusIcon =
                            'cancel';

                        statusClass =
                            'text-error';
                    }


                    const date =
                        run.createdAt
                            ? new Date(
                                run.createdAt,
                            ).toLocaleString(
                                'tr-TR',
                            )
                            : '-';


                    const duration =
                        run.duration !==
                        undefined &&
                        run.duration !==
                        null

                            ? `${
                                Number(
                                    run.duration,
                                ).toFixed(2)
                            }s`

                            : '--';


                    const errorMessage =
                        getRunError(
                            run,
                        );


                    return `
                        <tr
                            class="
                                hover:bg-[#334155]/30
                                transition-colors
                                group
                            "
                        >

                            <td
                                class="
                                    px-md
                                    py-sm
                                    text-center
                                    align-middle
                                "
                            >

                                <span
                                    class="
                                        material-symbols-outlined
                                        ${statusClass}
                                        text-[18px]
                                    "
                                >
                                    ${statusIcon}
                                </span>

                            </td>


                            <td
                                class="
                                    px-md
                                    py-sm
                                "
                            >

                                <div
                                    class="
                                        flex
                                        flex-col
                                    "
                                >

                                    <span
                                        class="
                                            font-code-md
                                            text-code-md
                                            text-on-surface
                                            font-medium
                                            break-all
                                        "
                                    >
                                        ${
                        run.testFile ||
                        '-'
                    }
                                    </span>


                                    ${
                        errorMessage
                            ? `
                                                <span
                                                    class="
                                                        font-body-sm
                                                        text-error/80
                                                        truncate
                                                        max-w-md
                                                        mt-1
                                                        text-[11px]
                                                    "
                                                >
                                                    ${errorMessage}
                                                </span>
                                            `
                            : ''
                    }

                                </div>

                            </td>


                            <td
                                class="
                                    px-md
                                    py-sm
                                "
                            >

                                <div
                                    class="
                                        flex
                                        items-center
                                        gap-xs
                                        text-on-surface-variant
                                    "
                                >

                                    <span
                                        class="
                                            material-symbols-outlined
                                            text-[16px]
                                        "
                                    >
                                        public
                                    </span>

                                    ${
                        run.browser ||
                        '-'
                    }

                                </div>

                            </td>


                            <td
                                class="
                                    px-md
                                    py-sm
                                    font-code-md
                                    text-on-surface-variant
                                "
                            >
                                ${duration}
                            </td>


                            <td
                                class="
                                    px-md
                                    py-sm
                                    text-on-surface-variant
                                "
                            >
                                ${date}
                            </td>


                            <td
                                class="
                                    px-md
                                    py-sm
                                    text-right
                                "
                            >

                                <button
                                    class="
                                        viewRunDetailsButton
                                        text-on-surface-variant
                                        hover:text-primary
                                        p-1
                                        rounded
                                        hover:bg-surface-bright
                                        transition-colors
                                    "
                                    data-run-id="${run.id}"
                                    type="button"
                                    title="View Details"
                                    aria-label="View details for ${run.testFile || 'run'}"
                                >

                                    <span
                                        class="
                                            material-symbols-outlined
                                            text-[18px]
                                        "
                                    >
                                        receipt_long
                                    </span>

                                </button>

                                ${
                        run.artifacts?.screenshot
                            ? `
                                <a
                                    href="${run.artifacts.screenshot}"
                                    target="_blank"
                                    rel="noopener"
                                    class="
                                        viewRunScreenshotLink
                                        inline-flex
                                        text-on-surface-variant
                                        hover:text-primary
                                        p-1
                                        rounded
                                        hover:bg-surface-bright
                                        transition-colors
                                    "
                                    title="View Screenshot"
                                    aria-label="View screenshot for ${run.testFile || 'run'}"
                                    onclick="event.stopPropagation()"
                                >

                                    <span
                                        class="
                                            material-symbols-outlined
                                            text-[18px]
                                        "
                                    >
                                        photo_camera
                                    </span>

                                </a>
                                `
                            : ''
                    }

                                <button
                                    class="
                                        deleteTestRunButton
                                        text-on-surface-variant
                                        hover:text-error
                                        p-1
                                        rounded
                                        hover:bg-error/10
                                        transition-colors
                                    "
                                    data-run-id="${run.id}"
                                    type="button"
                                    title="Delete"
                                    aria-label="Delete run ${run.testFile || run.id || ''}"
                                >

                                    <span
                                        class="
                                            material-symbols-outlined
                                            text-[18px]
                                        "
                                    >
                                        delete
                                    </span>

                                </button>

                            </td>

                        </tr>
                    `;
                })
                .join('');


        testRunsPagination.classList.remove(
            'hidden',
        );

        testRunsPagination.classList.add(
            'flex',
        );


        const visibleStart =
            startIndex + 1;


        const visibleEnd =
            Math.min(
                endIndex,
                filteredRuns.length,
            );


        testRunsPaginationInfo.textContent =
            `Showing ${visibleStart} to ${visibleEnd} of ${filteredRuns.length} entries`;


        currentTestRunsPage.textContent =
            currentPage;


        previousTestRunsPage.disabled =
            currentPage ===
            1;


        nextTestRunsPage.disabled =
            currentPage ===
            totalPages;


        document
            .querySelectorAll(
                '.viewRunDetailsButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    () => {

                        const runId =
                            button.getAttribute(
                                'data-run-id',
                            );


                        const selectedRun =
                            allRuns.find(
                                (run) =>
                                    String(
                                        run.id,
                                    ) ===
                                    String(
                                        runId,
                                    ),
                            );


                        if (!selectedRun) {
                            return;
                        }


                        runDetailsFile.textContent =
                            selectedRun.testFile ||
                            '-';


                        runDetailsStatus.textContent =
                            selectedRun.status ||
                            '-';


                        if (
                            selectedRun.status ===
                            'passed'
                        ) {

                            runDetailsStatus.className =
                                'font-semibold text-secondary';

                        } else if (
                            selectedRun.status ===
                            'failed'
                        ) {

                            runDetailsStatus.className =
                                'font-semibold text-error';

                        } else {

                            runDetailsStatus.className =
                                'font-semibold text-primary';
                        }


                        runDetailsBrowser.textContent =
                            selectedRun.browser ||
                            '-';


                        runDetailsDuration.textContent =
                            selectedRun.duration !==
                            undefined

                                ? `${
                                    Number(
                                        selectedRun.duration,
                                    ).toFixed(2)
                                }s`

                                : '-';


                        runDetailsExitCode.textContent =
                            selectedRun.exitCode ??
                            '-';


                        runDetailsExecuted.textContent =
                            selectedRun.createdAt

                                ? new Date(
                                    selectedRun.createdAt,
                                ).toLocaleString(
                                    'tr-TR',
                                )

                                : '-';


                        runDetailsId.textContent =
                            selectedRun.id ??
                            '-';


                        const errorText =
                            selectedRun.error ||
                            selectedRun.errorOutput ||
                            selectedRun.message ||
                            '';


                        if (
                            selectedRun.status ===
                            'failed' &&
                            errorText
                        ) {

                            runDetailsErrorSection.classList.remove(
                                'hidden',
                            );

                            runDetailsError.textContent =
                                errorText;

                        } else {

                            runDetailsErrorSection.classList.add(
                                'hidden',
                            );

                            runDetailsError.textContent =
                                '';
                        }


                        // v3.1 — bkz. sohbet notu: "test koşumlarında alınan ekran görüntüleri
                        // test runs da... gözüksün". Bu koşum screenshot ALARAK çalıştırılmadıysa
                        // (captureScreenshot=false) selectedRun.artifacts?.screenshot hiç yoktur —
                        // bu durumda bölüm tamamen gizli kalır.
                        if (
                            runDetailsScreenshotSection &&
                            selectedRun.artifacts?.screenshot
                        ) {

                            runDetailsScreenshotImg.src =
                                selectedRun.artifacts.screenshot;

                            runDetailsScreenshotLink.href =
                                selectedRun.artifacts.screenshot;

                            runDetailsScreenshotSection.classList.remove(
                                'hidden',
                            );

                        } else if (runDetailsScreenshotSection) {

                            runDetailsScreenshotSection.classList.add(
                                'hidden',
                            );

                            runDetailsScreenshotImg.src =
                                '';

                            runDetailsScreenshotLink.href =
                                '#';
                        }


                        testRunDetailsModal.classList.remove(
                            'hidden',
                        );

                        testRunDetailsModal.classList.add(
                            'flex',
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.deleteTestRunButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    async (event) => {

                        // viewRunDetailsButton ile aynı satırda bitişik duruyor — tıklama satıra
                        // taşıp yanlışlıkla detay modalını açmasın diye event'i durduruyoruz.
                        event.stopPropagation();

                        const runId =
                            button.getAttribute(
                                'data-run-id',
                            );

                        if (!runId) {
                            return;
                        }

                        // Yıkıcı bir işlem — geri alınamaz (koşum özetiyle birlikte adım detayları
                        // ve varsa ekran görüntüsü/video/trace de silinir), bu yüzden
                        // deleteGeneratedTestButton ile aynı sade confirm() deseni kullanılıyor.
                        const confirmed =
                            confirm(
                                'Delete this test run? This cannot be undone.',
                            );

                        if (!confirmed) {
                            return;
                        }

                        button.disabled =
                            true;

                        try {

                            const response =
                                await fetch(
                                    `/api/test-runs/${encodeURIComponent(runId)}`,
                                    {
                                        method: 'DELETE',
                                    },
                                );

                            const result =
                                await response.json();

                            if (!response.ok) {
                                throw new Error(
                                    result.message ||
                                    'Failed to delete test run.',
                                );
                            }

                            // Satırı yerelde manuel çıkarmak yerine loadTestRuns() ile sunucudan
                            // taze listeyi çekiyoruz — istatistik kartları, sayfalama ve toplam
                            // sayı hep tek bir kaynaktan (backend) senkron kalsın diye.
                            await loadTestRuns();

                        } catch (error) {

                            console.error(error);

                            showToast(
                                error instanceof Error
                                    ? error.message
                                    : 'Failed to delete test run.',
                                'error',
                            );

                            button.disabled =
                                false;
                        }
                    },
                );
            });
    }


    async function loadTestRuns() {

        refreshTestRunsButton.disabled =
            true;


        try {

            const response =
                await fetch(
                    '/api/test-runs',
                );


            const result =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    result.message ||
                    'Failed to load test history.',
                );
            }


            allRuns =
                Array.isArray(
                    result.runs,
                )
                    ? result.runs
                    : [];


            currentPage =
                1;


            updateStats(
                allRuns,
            );


            renderRuns();

        } catch (error) {

            console.error(
                'Failed to load test runs:',
                error,
            );


            allRuns =
                [];


            updateStats(
                allRuns,
            );


            testRunsTableBody.innerHTML =
                '';


            testRunsEmptyState.classList.remove(
                'hidden',
            );


            testRunsPagination.classList.add(
                'hidden',
            );

        } finally {

            refreshTestRunsButton.disabled =
                false;
        }
    }


    testRunsSearchInput.addEventListener(
        'input',
        () => {

            currentPage =
                1;

            renderRuns();
        },
    );


    browserFilter.addEventListener(
        'change',
        () => {

            currentPage =
                1;

            renderRuns();
        },
    );


    statusFilter.addEventListener(
        'change',
        () => {

            currentPage =
                1;

            renderRuns();
        },
    );


    previousTestRunsPage.addEventListener(
        'click',
        () => {

            if (
                currentPage >
                1
            ) {

                currentPage--;

                renderRuns();
            }
        },
    );


    nextTestRunsPage.addEventListener(
        'click',
        () => {

            const filteredRuns =
                getFilteredRuns();


            const totalPages =
                Math.ceil(
                    filteredRuns.length /
                    pageSize,
                );


            if (
                currentPage <
                totalPages
            ) {

                currentPage++;

                renderRuns();
            }
        },
    );


    refreshTestRunsButton.addEventListener(
        'click',
        loadTestRuns,
    );


    function closeRunDetailsModal() {

        testRunDetailsModal.classList.add(
            'hidden',
        );

        testRunDetailsModal.classList.remove(
            'flex',
        );
    }


    closeTestRunDetailsModal.addEventListener(
        'click',
        closeRunDetailsModal,
    );


    closeTestRunDetailsButton.addEventListener(
        'click',
        closeRunDetailsModal,
    );


    testRunDetailsModal.addEventListener(
        'click',
        (event) => {

            if (
                event.target ===
                testRunDetailsModal
            ) {

                closeRunDetailsModal();
            }
        },
    );


    if (clearAllTestRunsButton) {

        clearAllTestRunsButton.addEventListener(
            'click',
            async () => {

                if (allRuns.length === 0) {
                    return;
                }

                // Yıkıcı ve TOPLU bir işlem — normal silmeden daha net bir onay metni kullanılıyor
                // (bkz. clearAllGeneratedTestsButton — aynı desen).
                const confirmed =
                    confirm(
                        `Delete all ${allRuns.length} test runs? This cannot be undone.`,
                    );

                if (!confirmed) {
                    return;
                }

                clearAllTestRunsButton.disabled =
                    true;

                try {

                    const response =
                        await fetch(
                            '/api/test-runs',
                            {
                                method: 'DELETE',
                            },
                        );

                    const result =
                        await response.json();

                    if (!response.ok) {
                        throw new Error(
                            result.message ||
                            'Failed to clear test runs.',
                        );
                    }

                    await loadTestRuns();

                } catch (error) {

                    console.error(error);

                    showToast(
                        error instanceof Error
                            ? error.message
                            : 'Failed to clear test runs.',
                        'error',
                    );

                } finally {

                    clearAllTestRunsButton.disabled =
                        false;
                }
            },
        );
    }


    await loadTestRuns();
}


/* =========================================================
   SUITES
   ------------------------------------------------------
   v3.11 — bkz. sohbet notu: "Suit adında bir panel daha yapacağız bu dashboardın altında yer
   alsın". Generated Tests'ten "Add to Suite" ile taşınan testler (bkz. app.js getVisibleTests
   NOT'u ve LegacyGeneratedTestMeta.suiteIds) burada suite'lere göre gruplanır; sol tarafta
   suite listesi, sağ tarafta seçili suite'in üye testleri checkbox'larla görünür ve mevcut
   /api/generated-tests/run-batch mekanizması (initGeneratedTestsPage'deki trackBatchRuns ile
   AYNI backend uç noktası) ile toplu çalıştırılabilir. BİLİNÇLİ TASARIM KARARI: burada
   trackBatchRuns'ın tam canlı-adım-bazlı takibi YOK — sadece nihai durum rozeti (running →
   passed/failed/error/cancelled), ayrıntılı Execution Log için kullanıcı ilgili run'ı Test
   Runs sayfasından açabilir (bkz. sohbet planı: "lean" versiyon, effort kısıtı nedeniyle).
========================================================= */

async function initSuitesPage() {

    const refreshSuitesButton =
        document.getElementById('refreshSuitesButton');
    const newSuiteButton =
        document.getElementById('newSuiteButton');
    const suitesListContainer =
        document.getElementById('suitesListContainer');
    const suitesListEmptyState =
        document.getElementById('suitesListEmptyState');

    const suiteDetailEmptyState =
        document.getElementById('suiteDetailEmptyState');
    const suiteDetailContent =
        document.getElementById('suiteDetailContent');
    const suiteDetailName =
        document.getElementById('suiteDetailName');
    const suiteDetailMeta =
        document.getElementById('suiteDetailMeta');
    const deleteSuiteButton =
        document.getElementById('deleteSuiteButton');

    const suiteSelectionBar =
        document.getElementById('suiteSelectionBar');
    const suiteSelectionCount =
        document.getElementById('suiteSelectionCount');
    const clearSuiteSelectionButton =
        document.getElementById('clearSuiteSelectionButton');
    const runSuiteSelectedButton =
        document.getElementById('runSuiteSelectedButton');

    const selectAllSuiteTestsCheckbox =
        document.getElementById('selectAllSuiteTestsCheckbox');
    const suiteTestsTableBody =
        document.getElementById('suiteTestsTableBody');
    const suiteTestsEmptyState =
        document.getElementById('suiteTestsEmptyState');

    const newSuiteModal =
        document.getElementById('newSuiteModal');
    const closeNewSuiteModalButton =
        document.getElementById('closeNewSuiteModal');
    const cancelNewSuiteButton =
        document.getElementById('cancelNewSuiteButton');
    const confirmNewSuiteButton =
        document.getElementById('confirmNewSuiteButton');
    const newSuiteNameInput =
        document.getElementById('newSuiteNameInput');

    // Sayfa markup'ı henüz DOM'da değilse (ör. çok hızlı ardışık navigasyon) sessizce çık —
    // diğer init*Page fonksiyonlarıyla aynı savunmacı desen.
    if (!suitesListContainer) {
        return;
    }

    let allSuites = [];
    let allTests = [];
    let selectedSuiteId = null;
    let selectedSuiteTestFiles = new Set();

    // v3.11 — dosya başı NOT: lean/nihai-durum-only takip (bkz. trackSuiteBatchRuns).
    let suiteRunStatusByFile = new Map();

    // v3.15 — bkz. sohbet notu: "suite eklediğimiz testlerin stepleri ve bdd kısmı generated
    // testteki gibi olsun biz yine editleyebilelim". Generated Tests sayfasındaki
    // expandedGeneratedTestSteps (bkz. initGeneratedTestsPage) ile AYNI amaç — hangi satırların
    // step listesi açık tutulduğunu render'dan BAĞIMSIZ hatırlar, sadece bu sayfaya özel AYRI bir
    // Set (iki sayfa aynı anda DOM'da olmadığı için paylaşmaya gerek yok, ama state'i karıştırmamak
    // için de bilerek ayrı tutulur).
    let expandedSuiteTestSteps = new Set();


    function getSuiteTests(suiteId) {
        return allTests.filter(
            (test) =>
                typeof test !== 'string' &&
                Array.isArray(test.suiteIds) &&
                test.suiteIds.includes(suiteId),
        );
    }


    function renderSuitesList() {

        suitesListContainer.innerHTML = allSuites
            .map((suite) => {

                const memberCount =
                    getSuiteTests(suite.id).length;

                const isActive =
                    suite.id === selectedSuiteId;

                return `
                    <button
                        class="suiteListItemButton w-full text-left px-md py-sm flex items-center justify-between gap-2 transition-colors ${
                            isActive
                                ? 'bg-primary-container/20 text-on-surface'
                                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
                        }"
                        data-suite-id="${escapeHtml(suite.id)}"
                        type="button"
                    >
                        <span class="font-body-md text-body-md truncate">
                            ${escapeHtml(suite.name)}
                        </span>
                        <span class="font-body-sm text-body-sm text-on-surface-variant/70 shrink-0">
                            ${memberCount}
                        </span>
                    </button>
                `;
            })
            .join('');

        suitesListEmptyState.classList.toggle('hidden', allSuites.length > 0);
        suitesListEmptyState.classList.toggle('flex', allSuites.length === 0);

        suitesListContainer
            .querySelectorAll('.suiteListItemButton')
            .forEach((button) => {
                button.addEventListener('click', () => {
                    const suiteId = button.getAttribute('data-suite-id');
                    if (!suiteId) return;
                    selectSuite(suiteId);
                });
            });
    }


    function updateSuiteSelectionBar() {

        const count =
            selectedSuiteTestFiles.size;

        suiteSelectionBar.classList.toggle('hidden', count === 0);
        suiteSelectionBar.classList.toggle('flex', count > 0);
        suiteSelectionCount.textContent = `${count} selected`;
    }


    // v3.11 — batchStatusBadgeLabel/Classes (initGeneratedTestsPage) ile AYNI durum kümesi,
    // burada 'retrying' YOK (bkz. dosya başı NOT — bu sayfa replay_retry_started event'ini hiç
    // dinlemiyor, sadece nihai durumu takip ediyor).
    function suiteBatchStatusBadgeLabel(status) {
        switch (status) {
            case 'passed': return 'Passed';
            case 'failed': return 'Failed';
            case 'error': return 'Error';
            case 'cancelled': return 'Cancelled';
            default: return 'Running…';
        }
    }

    function suiteBatchStatusBadgeClasses(status) {
        switch (status) {
            case 'passed': return 'bg-secondary/15 text-secondary';
            case 'failed':
            case 'error': return 'bg-error/15 text-error';
            case 'cancelled': return 'bg-surface-container-highest text-on-surface-variant';
            default: return 'bg-primary-container/60 text-on-primary-container animate-pulse';
        }
    }


    function renderSuiteTests() {

        if (!selectedSuiteId) {
            return;
        }

        const tests =
            getSuiteTests(selectedSuiteId);

        // Seçim setinden artık bu suite'te olmayan dosyaları temizle (ör. başka bir sekmeden
        // kaldırılmış olabilir) — checkbox'lar sadece hâlâ görünür satırlar için "checked" olsun.
        Array.from(selectedSuiteTestFiles).forEach((fileName) => {
            if (!tests.some((t) => t.fileName === fileName)) {
                selectedSuiteTestFiles.delete(fileName);
            }
        });

        suiteTestsTableBody.innerHTML = tests
            .map((test) => {

                const fileName = test.fileName;
                const isSelected = selectedSuiteTestFiles.has(fileName);
                const runStatus = suiteRunStatusByFile.get(fileName);

                const createdLabel =
                    test.createdAt
                        ? new Date(test.createdAt).toLocaleString()
                        : '—';

                // v3.15 — bkz. sohbet notu: "suite eklediğimiz testlerin stepleri ve bdd kısmı
                // generated testteki gibi olsun biz yine editleyebilelim". `test` burada Generated
                // Tests sayfasıyla AYNI /api/generated-tests kaydıdır (bkz. loadAll — suite üyeliği
                // sadece bir filtre, ayrı bir veri modeli DEĞİL), yani `.steps`/`.bddDescription`
                // zaten kalıcı meta'da mevcuttur — initGeneratedTestsPage'deki AYNI render/aç-kapa
                // desenini burada da BİREBİR uyguluyoruz (canlı adım takibi HARİÇ — bkz. dosya başı
                // "lean" NOT'u, suite koşumları burada sadece nihai rozetle izlenir).
                const steps =
                    Array.isArray(test.steps) ? test.steps : [];
                const hasSteps = steps.length > 0;
                const isStepsExpanded = expandedSuiteTestSteps.has(fileName);
                const bddDescription = test.bddDescription || null;

                return `
                    <tr class="hover:bg-surface-container-high/40">
                        <td class="py-sm pl-md pr-xs">
                            <input
                                class="suiteTestCheckbox w-[16px] h-[16px] rounded border-outline-variant cursor-pointer"
                                type="checkbox"
                                data-file="${escapeHtml(fileName)}"
                                ${isSelected ? 'checked' : ''}
                            />
                        </td>
                        <td class="py-sm px-md">
                            <div class="flex items-start gap-sm">
                                ${
                                    hasSteps
                                        ? `
                                <button
                                    class="toggleSuiteTestStepsButton text-on-surface-variant hover:text-on-surface flex items-center justify-center w-[20px] h-[20px] shrink-0 mt-[2px]"
                                    data-file="${escapeHtml(fileName)}"
                                    type="button"
                                    aria-label="Toggle steps for ${escapeHtml(fileName)}"
                                    aria-expanded="${isStepsExpanded ? 'true' : 'false'}"
                                >
                                    <span class="material-symbols-outlined text-[18px] transition-transform" style="${isStepsExpanded ? 'transform: rotate(90deg);' : ''}">
                                        chevron_right
                                    </span>
                                </button>
                                `
                                        : `<span class="w-[20px] h-[20px] shrink-0"></span>`
                                }
                                <div class="flex items-center gap-2 flex-wrap">
                                    <span class="font-body-md text-body-md text-on-surface truncate">
                                        ${escapeHtml(fileName)}
                                    </span>
                                    ${
                                        runStatus
                                            ? `<span class="font-body-sm text-[11px] px-2 py-[2px] rounded-full ${suiteBatchStatusBadgeClasses(runStatus.status)}">${suiteBatchStatusBadgeLabel(runStatus.status)}</span>`
                                            : ''
                                    }
                                </div>
                            </div>
                        </td>
                        <td class="py-sm px-md font-body-sm text-body-sm text-on-surface-variant">
                            ${escapeHtml(createdLabel)}
                        </td>
                        <td class="py-sm px-md text-right">
                            <button
                                class="removeFromSuiteButton inline-flex items-center gap-xs text-on-surface-variant hover:text-error px-sm py-[6px] rounded-lg border border-outline-variant"
                                data-file="${escapeHtml(fileName)}"
                                title="Remove from this suite"
                                type="button"
                            >
                                <span class="material-symbols-outlined text-[16px]">
                                    remove_circle_outline
                                </span>
                                Remove
                            </button>
                        </td>
                    </tr>
                    ${
                        hasSteps
                            ? `
                    <tr class="suiteStepsRow ${isStepsExpanded ? '' : 'hidden'}" data-file="${escapeHtml(fileName)}">
                        <td colspan="4" class="pl-[52px] pr-md pb-sm pt-0 bg-surface-container-lowest/40">
                            ${
                                bddDescription
                                    ? `
                            <div class="pt-sm pb-sm border-b border-outline-variant/30 mb-1">
                                <button
                                    class="openSuiteBddButton inline-flex items-center gap-xs font-label-caps text-label-caps text-primary hover:underline"
                                    data-file="${escapeHtml(fileName)}"
                                    type="button"
                                    title="Open in the Create Test BDD tab to view or edit"
                                >
                                    <span class="material-symbols-outlined text-[14px]">
                                        edit_note
                                    </span>
                                    BDD — view / edit
                                </button>
                            </div>
                            `
                                    : ''
                            }
                            <ol class="flex flex-col gap-1 py-sm border-l-2 border-outline-variant/40 pl-md">
                                ${steps
                                    .map(
                                        (step) => `
                                <li class="flex items-start gap-sm">
                                    <span class="material-symbols-outlined text-[16px] mt-[1px] ${step.ok ? 'text-secondary' : 'text-error'}">
                                        ${step.ok ? 'check_circle' : 'cancel'}
                                    </span>
                                    <span class="font-mono text-xs text-on-surface-variant shrink-0">
                                        ${step.index + 1}.
                                    </span>
                                    <span class="font-body-sm text-body-sm text-on-surface flex-1">
                                        ${escapeHtml(step.description)}
                                    </span>
                                    ${
                                        step.decisionSource
                                            ? `
                                    <span
                                        class="inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-bold uppercase tracking-wider shrink-0 mt-[2px] ${
                                            step.decisionSource === 'vector_cache'
                                                ? 'bg-primary/15 text-primary'
                                                : step.decisionSource === 'replay'
                                                    ? 'bg-secondary/15 text-secondary'
                                                    : 'bg-surface-container-high text-on-surface-variant'
                                        }"
                                        title="${
                                            step.decisionSource === 'vector_cache'
                                                ? 'Vector cache — LLM’e hiç danışılmadı'
                                                : step.decisionSource === 'replay'
                                                    ? 'Replay (No AI)'
                                                    : 'Gerçek LLM çağrısı'
                                        }"
                                    >
                                        ${escapeHtml(DECISION_SOURCE_LABELS[step.decisionSource] || step.decisionSource)}
                                    </span>
                                    `
                                            : ''
                                    }
                                    <span class="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant/70 shrink-0 mt-[2px]">
                                        ${escapeHtml(step.action)}
                                    </span>
                                </li>
                                `,
                                    )
                                    .join('')}
                            </ol>
                        </td>
                    </tr>
                    `
                            : ''
                    }
                `;
            })
            .join('');

        suiteTestsEmptyState.classList.toggle('hidden', tests.length > 0);
        suiteTestsEmptyState.classList.toggle('flex', tests.length === 0);

        selectAllSuiteTestsCheckbox.checked =
            tests.length > 0 &&
            tests.every((t) => selectedSuiteTestFiles.has(t.fileName));

        updateSuiteSelectionBar();

        suiteTestsTableBody
            .querySelectorAll('.suiteTestCheckbox')
            .forEach((checkbox) => {
                checkbox.addEventListener('change', () => {

                    const fileName =
                        checkbox.getAttribute('data-file');

                    if (!fileName) return;

                    if (checkbox.checked) {
                        selectedSuiteTestFiles.add(fileName);
                    } else {
                        selectedSuiteTestFiles.delete(fileName);
                    }

                    updateSuiteSelectionBar();

                    selectAllSuiteTestsCheckbox.checked =
                        tests.length > 0 &&
                        tests.every((t) => selectedSuiteTestFiles.has(t.fileName));
                });
            });

        suiteTestsTableBody
            .querySelectorAll('.removeFromSuiteButton')
            .forEach((button) => {
                button.addEventListener('click', async () => {

                    const fileName =
                        button.getAttribute('data-file');

                    if (!fileName || !selectedSuiteId) return;

                    button.disabled = true;

                    try {

                        const response = await fetch(
                            `/api/generated-tests/${encodeURIComponent(fileName)}/suites/${encodeURIComponent(selectedSuiteId)}`,
                            { method: 'DELETE' },
                        );

                        const result = await response.json();

                        if (!response.ok) {
                            throw new Error(result.message || 'Failed to remove test from suite.');
                        }

                        selectedSuiteTestFiles.delete(fileName);
                        await loadAll();

                    } catch (error) {
                        console.error(error);
                        showToast(
                            error instanceof Error ? error.message : 'Failed to remove test from suite.',
                            'error',
                        );
                        button.disabled = false;
                    }
                });
            });

        // v3.15 — bkz. yukarıdaki render bloğu NOT'u: initGeneratedTestsPage'deki
        // .toggleGeneratedTestStepsButton / .openBddFromGeneratedButton delegasyonlarıyla AYNI
        // desen, sadece bu sayfaya özel sınıf adlarıyla (iki sayfa aynı anda DOM'da olmadığı için
        // çakışma riski yok, ama karışıklığı önlemek için bilerek ayrı tutuldu).
        suiteTestsTableBody
            .querySelectorAll('.toggleSuiteTestStepsButton')
            .forEach((button) => {
                button.addEventListener('click', () => {

                    const fileName = button.getAttribute('data-file');
                    if (!fileName) return;

                    const stepsRow = document.querySelector(
                        `.suiteStepsRow[data-file="${CSS.escape(fileName)}"]`,
                    );
                    if (!stepsRow) return;

                    const nowHidden = stepsRow.classList.toggle('hidden');

                    if (nowHidden) {
                        expandedSuiteTestSteps.delete(fileName);
                    } else {
                        expandedSuiteTestSteps.add(fileName);
                    }

                    button.setAttribute('aria-expanded', String(!nowHidden));

                    const chevron = button.querySelector('.material-symbols-outlined');
                    if (chevron) {
                        chevron.style.transform = nowHidden ? '' : 'rotate(90deg)';
                    }
                });
            });

        suiteTestsTableBody
            .querySelectorAll('.openSuiteBddButton')
            .forEach((button) => {
                button.addEventListener('click', async (event) => {

                    event.stopPropagation();

                    const fileName = button.getAttribute('data-file');
                    if (!fileName) return;

                    const test = allTests.find((t) => t.fileName === fileName);
                    if (!test) return;

                    // v3.12'de Generated Tests için tanımlanmış GLOBAL fonksiyon (bkz. dosya başı
                    // NOT'u) — Create Test sayfasına geçip BDD sekmesini bu testin metniyle dolu
                    // açar, aynen Generated Tests sayfasındaki "BDD — view / edit" ile birebir.
                    await openBddEditorForGeneratedTest(test);
                });
            });
    }


    function selectSuite(suiteId) {

        selectedSuiteId = suiteId;
        selectedSuiteTestFiles = new Set();
        suiteRunStatusByFile = new Map();

        const suite =
            allSuites.find((s) => s.id === suiteId);

        if (!suite) {
            selectedSuiteId = null;
            suiteDetailContent.classList.add('hidden');
            suiteDetailContent.classList.remove('flex');
            suiteDetailEmptyState.classList.remove('hidden');
            suiteDetailEmptyState.classList.add('flex');
            renderSuitesList();
            return;
        }

        suiteDetailName.textContent = suite.name;
        suiteDetailMeta.textContent =
            suite.createdAt
                ? `Created ${new Date(suite.createdAt).toLocaleString()}`
                : '';

        suiteDetailEmptyState.classList.add('hidden');
        suiteDetailEmptyState.classList.remove('flex');
        suiteDetailContent.classList.remove('hidden');
        suiteDetailContent.classList.add('flex');

        renderSuitesList();
        renderSuiteTests();
    }


    async function loadAll() {

        try {

            const [suitesResponse, testsResponse] = await Promise.all([
                fetch('/api/suites'),
                fetch('/api/generated-tests'),
            ]);

            const suitesResult = await suitesResponse.json();
            const testsResult = await testsResponse.json();

            if (!suitesResponse.ok) {
                throw new Error(suitesResult.message || 'Failed to load suites.');
            }

            allSuites =
                Array.isArray(suitesResult.suites) ? suitesResult.suites : [];

            allTests =
                testsResponse.ok && Array.isArray(testsResult.tests)
                    ? testsResult.tests
                    : [];

            // Seçili suite bu arada silinmiş olabilir (ör. başka bir sekmeden) — bu durumda
            // seçimi temizle ki "hayalet" bir suite detayı gösterilmesin.
            if (selectedSuiteId && !allSuites.some((s) => s.id === selectedSuiteId)) {
                selectedSuiteId = null;
            }

            if (selectedSuiteId) {
                selectSuite(selectedSuiteId);
            } else {
                renderSuitesList();
            }

        } catch (error) {
            console.error(error);
            showToast(
                error instanceof Error ? error.message : 'Failed to load suites.',
                'error',
            );
        }
    }


    /* -----------------------------------------------------
       NEW SUITE MODAL
    ----------------------------------------------------- */

    function openNewSuiteModal() {
        if (!newSuiteModal) return;
        newSuiteNameInput.value = '';
        newSuiteModal.classList.remove('hidden');
        newSuiteNameInput.focus();
    }

    function closeNewSuiteModal() {
        newSuiteModal?.classList.add('hidden');
    }

    if (newSuiteButton) {
        newSuiteButton.addEventListener('click', openNewSuiteModal);
    }

    if (closeNewSuiteModalButton) {
        closeNewSuiteModalButton.addEventListener('click', closeNewSuiteModal);
    }

    if (cancelNewSuiteButton) {
        cancelNewSuiteButton.addEventListener('click', closeNewSuiteModal);
    }

    if (confirmNewSuiteButton) {
        confirmNewSuiteButton.addEventListener('click', async () => {

            const name =
                newSuiteNameInput.value.trim();

            if (!name) {
                showToast('Enter a suite name.', 'error');
                return;
            }

            confirmNewSuiteButton.disabled = true;

            try {

                const response = await fetch('/api/suites', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.message || 'Failed to create suite.');
                }

                showToast('Suite created.', 'success');
                closeNewSuiteModal();
                await loadAll();
                selectSuite(result.id);

            } catch (error) {
                console.error(error);
                showToast(
                    error instanceof Error ? error.message : 'Failed to create suite.',
                    'error',
                );
            } finally {
                confirmNewSuiteButton.disabled = false;
            }
        });
    }


    /* -----------------------------------------------------
       DELETE SUITE — diğer yıkıcı işlemlerle (ör. deleteGeneratedTestButton) AYNI sade
       confirm() deseni.
    ----------------------------------------------------- */

    if (deleteSuiteButton) {
        deleteSuiteButton.addEventListener('click', async () => {

            if (!selectedSuiteId) return;

            const suite =
                allSuites.find((s) => s.id === selectedSuiteId);

            const confirmed = confirm(
                `Delete suite "${suite?.name || selectedSuiteId}"? Its tests will move back to Generated Tests. This cannot be undone.`,
            );

            if (!confirmed) return;

            deleteSuiteButton.disabled = true;

            try {

                const response = await fetch(
                    `/api/suites/${encodeURIComponent(selectedSuiteId)}`,
                    { method: 'DELETE' },
                );

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.message || 'Failed to delete suite.');
                }

                showToast('Suite deleted.', 'success');
                selectedSuiteId = null;
                await loadAll();

            } catch (error) {
                console.error(error);
                showToast(
                    error instanceof Error ? error.message : 'Failed to delete suite.',
                    'error',
                );
            } finally {
                deleteSuiteButton.disabled = false;
            }
        });
    }


    /* -----------------------------------------------------
       SELECTION / RUN SELECTED
    ----------------------------------------------------- */

    if (selectAllSuiteTestsCheckbox) {
        selectAllSuiteTestsCheckbox.addEventListener('change', () => {

            if (!selectedSuiteId) return;

            const tests =
                getSuiteTests(selectedSuiteId);

            if (selectAllSuiteTestsCheckbox.checked) {
                tests.forEach((t) => selectedSuiteTestFiles.add(t.fileName));
            } else {
                selectedSuiteTestFiles.clear();
            }

            renderSuiteTests();
        });
    }

    if (clearSuiteSelectionButton) {
        clearSuiteSelectionButton.addEventListener('click', () => {
            selectedSuiteTestFiles.clear();
            renderSuiteTests();
        });
    }


    // v3.11 — trackBatchRuns'ın (initGeneratedTestsPage) LEAN karşılığı: aynı /ws/runs/:runId
    // protokolü, ama sadece nihai durum rozeti için dinliyoruz (bkz. dosya başı NOT).
    function trackSuiteBatchRuns(started) {

        let remaining = started.length;

        const protocol =
            window.location.protocol === 'https:' ? 'wss:' : 'ws:';

        const TERMINAL_STATUSES =
            new Set(['passed', 'failed', 'error', 'cancelled']);

        const settle = (fileName, status) => {

            if (status) {
                suiteRunStatusByFile.set(fileName, { status });
            } else {
                // Durum bilinmiyor (ör. WS bağlantı hatası) — run backend'de devam ediyor olabilir,
                // bu yüzden yanlış bir rozet basmak yerine rozeti kaldırıyoruz.
                suiteRunStatusByFile.delete(fileName);
            }

            renderSuiteTests();

            remaining -= 1;

            if (remaining === 0) {
                suiteRunStatusByFile.clear();
                if (runSuiteSelectedButton) runSuiteSelectedButton.disabled = false;
                void loadAll();
            }
        };

        started.forEach(({ fileName, runId }) => {

            suiteRunStatusByFile.set(fileName, { status: 'running' });

            const socket =
                new WebSocket(`${protocol}//${window.location.host}/ws/runs/${runId}`);

            socket.addEventListener('message', (event) => {
                try {

                    const data = JSON.parse(event.data);

                    if (data.type === 'run_finished') {
                        socket.close();
                        settle(fileName, data.status);
                    } else if (data.type === 'run_error') {
                        socket.close();
                        settle(fileName, 'error');
                    } else if (
                        data.type === 'run_snapshot' &&
                        TERMINAL_STATUSES.has(data.summary?.status)
                    ) {
                        // Geç bağlanan istemci için: WS açılana kadar run zaten bitmiş olabilir.
                        socket.close();
                        settle(fileName, data.summary.status);
                    }

                } catch (error) {
                    console.error('Suite toplu çalıştırma WS mesajı işlenemedi:', error);
                }
            });

            socket.addEventListener('error', () => {
                settle(fileName, null);
            });
        });

        renderSuiteTests();
    }

    if (runSuiteSelectedButton) {
        runSuiteSelectedButton.addEventListener('click', async () => {

            const fileNames =
                Array.from(selectedSuiteTestFiles);

            if (fileNames.length === 0) return;

            runSuiteSelectedButton.disabled = true;

            try {

                const response = await fetch('/api/generated-tests/run-batch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // v3.19 fix — LegacyTestService.runGeneratedTestsBatch dosya basi NOT'una
                    // gore Suites sayfasinin bunu gondermesi gerekiyordu ama hic gonderilmiyordu;
                    // bu yuzden 'replay_step_failed' gercek bir senaryo/site sorunu oldugunda bile
                    // sessizce ikinci bir AI denemesine dusuluyordu. Artik TEK deneme yapiliyor.
                    body: JSON.stringify({ fileNames, disableAutoRetry: true }),
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.message || 'Failed to start batch run.');
                }

                const results =
                    Array.isArray(result.results) ? result.results : [];

                const started =
                    results.filter((r) => r.runId);

                const failedToStart =
                    results.filter((r) => r.error);

                if (failedToStart.length > 0) {
                    showToast(
                        `${failedToStart.length} test could not be started: ${failedToStart
                            .map((r) => r.fileName)
                            .join(', ')}`,
                        'error',
                    );
                }

                if (started.length > 0) {
                    trackSuiteBatchRuns(started);
                } else {
                    runSuiteSelectedButton.disabled = false;
                }

            } catch (error) {
                console.error(error);
                showToast(
                    error instanceof Error ? error.message : 'Failed to start batch run.',
                    'error',
                );
                runSuiteSelectedButton.disabled = false;
            }
        });
    }

    if (refreshSuitesButton) {
        refreshSuitesButton.addEventListener('click', async () => {
            refreshSuitesButton.disabled = true;
            await loadAll();
            refreshSuitesButton.disabled = false;
        });
    }

    await loadAll();
}


/**
 * v3.12 — bkz. sohbet notu: "bdd kısmı generated testte böyle gözükmesin... tıklıyım burdan bdd ye
 * yine create test panelinde bdd kısmına götürsün ordan edit yapabileyim". Generated Tests
 * sayfasındaki bir satırın "BDD" butonuna tıklanınca çağrılır (bkz. initGeneratedTestsPage
 * içindeki .openBddFromGeneratedButton delegasyonu) — Create Test sayfasına geçip oradaki BDD
 * sekmesini bu testin metniyle DOLU açar (bkz. initCreateTestPage "PENDING BDD EDIT" bloğu).
 * GLOBAL bir fonksiyon: initCreateTestPage()'in kendi kapsamındaki (closure) DOM referanslarına
 * (bddDescriptionOutput vb.) buradan doğrudan erişilemez — bunun yerine appState.pendingBddEdit
 * üzerinden "bir sonraki initCreateTestPage() çalıştığında bunu uygula" şeklinde bir köprü kurulur.
 */
/**
 * v3.22 — bkz. sohbet notu: "Run butonuna tıklandığı zaman aynı BDD deki gibi açılan ekranda
 * bilgiler gelsin ve bdd deki bilgiler ile koşum yapılsın". Generated Tests satırındaki hem
 * "BDD" hem de "Run" butonu, Create Test sayfasına AYNI şekilde doldurulmuş (url/isim/değişkenler/
 * tarayıcı ayarları + "Test Scenario Instructions" alanında BDD verisi) bir ekran taşımak
 * istiyor — SADECE sağ panelde ne gösterildiği (BDD metni mi, canlı çalıştırma takibi mi)
 * farklı. Bu yüzden ortak "hangi test, hangi giriş verileriyle temsil ediliyor" anlık görüntüsü
 * (snapshot) burada TEK bir yerde kuruluyor; hem openBddEditorForGeneratedTest hem de
 * runExistingTest bunu kullanır — iki yerde birbirinden sapabilecek kopya mantık OLMASIN diye.
 * Secrets BİLEREK dahil edilmez — değerleri şifreli saklanıyor ve tarayıcıya hiç gönderilmiyor
 * (bkz. LegacyGeneratedTestMeta.secretsEncrypted dosya başı açıklaması); kullanıcı tekrar
 * çalıştırmak isterse Secret satırını elle girer (backend zaten kayıtlı secret'ı kendisi otomatik
 * kullanır — bkz. LegacyTestService.runGeneratedTest).
 */
function buildScenarioSnapshotFromTest(test) {

    return {
        bddDescription: test.bddDescription || '',
        runId: test.runId || null,
        url: typeof test.url === 'string' ? test.url : '',
        testName: test.displayName || '',
        variables:
            test.variables && typeof test.variables === 'object'
                ? test.variables
                : {},
        browser: test.browser || 'chromium',
        headed: Boolean(test.headed),
        screenshot: Boolean(test.screenshot),
        video: Boolean(test.video),
        trace: Boolean(test.trace),
        useSeleniumGrid: Boolean(test.useSeleniumGrid),
        projectId: typeof test.projectId === 'number' ? test.projectId : null,
    };
}


/**
 * v3.12 — bkz. sohbet notu: "bdd kısmı generated testte böyle gözükmesin... tıklıyım burdan bdd ye
 * yine create test panelinde bdd kısmına götürsün ordan edit yapabileyim". Generated Tests
 * sayfasındaki bir satırın "BDD" butonuna tıklanınca çağrılır (bkz. initGeneratedTestsPage
 * içindeki .openBddFromGeneratedButton delegasyonu) — Create Test sayfasına geçip oradaki BDD
 * sekmesini bu testin metniyle DOLU açar (bkz. initCreateTestPage "PENDING BDD EDIT" bloğu).
 * GLOBAL bir fonksiyon: initCreateTestPage()'in kendi kapsamındaki (closure) DOM referanslarına
 * (bddDescriptionOutput vb.) buradan doğrudan erişilemez — bunun yerine appState.pendingBddEdit
 * üzerinden "bir sonraki initCreateTestPage() çalıştığında bunu uygula" şeklinde bir köprü kurulur.
 */
async function openBddEditorForGeneratedTest(test) {

    if (!test) {
        return;
    }

    // v3.21 — bkz. sohbet notu: "yönlendirilen sayfada önceki koşumdaki tüm giriş dataları yer
    // alsın... fakat Test Scenario Instructions kısmında bdd verileri yazılmış şekilde ekran
    // açılsın". Önceden SADECE bddDescription+runId taşınıyordu (Test Scenario Instructions ve
    // diğer alanlar bomboş/eski kalıyordu) — artık bu testin ÜRETİLDİĞİ/son çalıştığı run'daki TÜM
    // giriş verileri (url, isim, değişkenler, tarayıcı/koşum ayarları) da taşınıyor; sadece
    // "Test Scenario Instructions" BİLEREK orijinal senaryo metni DEĞİL, BDD verisiyle doldurulacak
    // (bkz. initCreateTestPage "PENDING BDD EDIT" bloğu).
    appState.pendingBddEdit = buildScenarioSnapshotFromTest(test);

    await navigateTo('create');
}


/* =========================================================
   GENERATED TESTS
========================================================= */

async function initGeneratedTestsPage() {

    const refreshGeneratedTestsButton =
        document.getElementById(
            'refreshGeneratedTestsButton',
        );

    const clearAllGeneratedTestsButton =
        document.getElementById(
            'clearAllGeneratedTestsButton',
        );

    const generatedTestsTotal =
        document.getElementById(
            'generatedTestsTotal',
        );

    const generatedTestsLastGenerated =
        document.getElementById(
            'generatedTestsLastGenerated',
        );

    const generatedTestsLastRunStatus =
        document.getElementById(
            'generatedTestsLastRunStatus',
        );

    const generatedTestsSearch =
        document.getElementById(
            'generatedTestsSearch',
        );

    // v2.3 — bkz. renderActiveGeneratedTestRuns() dosya başı açıklaması.
    const generatedTestsActiveRunsPanel =
        document.getElementById(
            'generatedTestsActiveRunsPanel',
        );

    const generatedTestsActiveRunsList =
        document.getElementById(
            'generatedTestsActiveRunsList',
        );

    const generatedTestsSort =
        document.getElementById(
            'generatedTestsSort',
        );

    const generatedTestsTableBody =
        document.getElementById(
            'generatedTestsTableBody',
        );

    const generatedTestsEmptyState =
        document.getElementById(
            'generatedTestsEmptyState',
        );

    const generatedTestsCreateButton =
        document.getElementById(
            'generatedTestsCreateButton',
        );

    const generatedTestsPagination =
        document.getElementById(
            'generatedTestsPagination',
        );

    const generatedTestsPaginationInfo =
        document.getElementById(
            'generatedTestsPaginationInfo',
        );

    const generatedTestsPreviousPage =
        document.getElementById(
            'generatedTestsPreviousPage',
        );

    const generatedTestsCurrentPage =
        document.getElementById(
            'generatedTestsCurrentPage',
        );

    const generatedTestsNextPage =
        document.getElementById(
            'generatedTestsNextPage',
        );

    // v2.0 — toplu/paralel çalıştırma için checkbox seçimi + "Seçilenleri Çalıştır" UI'ı.
    const selectAllGeneratedTestsCheckbox =
        document.getElementById(
            'selectAllGeneratedTestsCheckbox',
        );

    const generatedTestsSelectionBar =
        document.getElementById(
            'generatedTestsSelectionBar',
        );

    const generatedTestsSelectionCount =
        document.getElementById(
            'generatedTestsSelectionCount',
        );

    const clearGeneratedTestsSelectionButton =
        document.getElementById(
            'clearGeneratedTestsSelectionButton',
        );

    const runSelectedGeneratedTestsButton =
        document.getElementById(
            'runSelectedGeneratedTestsButton',
        );

    // v3.2 — "gece test koşumu" zamanlaması (bkz. sohbet notu ve pages/generated-tests.html
    // "SCHEDULE MODAL" NOT'u).
    const generatedTestScheduleModal =
        document.getElementById('generatedTestScheduleModal');
    const generatedTestScheduleModalTitle =
        document.getElementById('generatedTestScheduleModalTitle');
    const closeGeneratedTestScheduleModalButton =
        document.getElementById('closeGeneratedTestScheduleModal');
    const cancelGeneratedTestScheduleButton =
        document.getElementById('cancelGeneratedTestScheduleButton');
    const saveGeneratedTestScheduleButton =
        document.getElementById('saveGeneratedTestScheduleButton');
    const removeGeneratedTestScheduleButton =
        document.getElementById('removeGeneratedTestScheduleButton');
    const generatedTestScheduleEnabledInput =
        document.getElementById('generatedTestScheduleEnabled');
    const generatedTestScheduleOptionsContainer =
        document.getElementById('generatedTestScheduleOptions');
    const generatedTestScheduleTimeInput =
        document.getElementById('generatedTestScheduleTime');
    const generatedTestScheduleDaysContainer =
        document.getElementById('generatedTestScheduleDaysContainer');
    const generatedTestScheduleQuickWeekdaysButton =
        document.getElementById('generatedTestScheduleQuickWeekdays');
    const generatedTestScheduleQuickEveryDayButton =
        document.getElementById('generatedTestScheduleQuickEveryDay');

    let scheduleModalFileName = null;

    // v3.11 — "Add to Suite" modalı (bkz. pages/generated-tests.html "ADD TO SUITE MODAL" NOT'u).
    const addToSuiteModal =
        document.getElementById('addToSuiteModal');
    const closeAddToSuiteModalButton =
        document.getElementById('closeAddToSuiteModal');
    const cancelAddToSuiteButton =
        document.getElementById('cancelAddToSuiteButton');
    const confirmAddToSuiteButton =
        document.getElementById('confirmAddToSuiteButton');
    const addToSuiteExistingSelect =
        document.getElementById('addToSuiteExistingSelect');
    const addToSuiteNewName =
        document.getElementById('addToSuiteNewName');

    let addToSuiteTargetFile = null;

    if (generatedTestScheduleDaysContainer) {
        createScheduleDayToggles(generatedTestScheduleDaysContainer);
    }

    function toggleScheduleOptionsVisibility() {
        const isEnabled = generatedTestScheduleEnabledInput.checked;
        generatedTestScheduleOptionsContainer.classList.toggle('hidden', !isEnabled);
        generatedTestScheduleOptionsContainer.classList.toggle('flex', isEnabled);
    }

    function openScheduleModal(fileName, existingSchedule) {
        scheduleModalFileName = fileName;
        generatedTestScheduleModalTitle.textContent = `Schedule: ${fileName}`;
        generatedTestScheduleEnabledInput.checked = Boolean(existingSchedule?.enabled);
        generatedTestScheduleTimeInput.value = existingSchedule?.time || '23:00';
        setSelectedScheduleDays(generatedTestScheduleDaysContainer, existingSchedule?.days || []);
        removeGeneratedTestScheduleButton.classList.toggle('hidden', !existingSchedule);
        toggleScheduleOptionsVisibility();
        generatedTestScheduleModal.classList.remove('hidden');
    }

    function closeScheduleModal() {
        scheduleModalFileName = null;
        generatedTestScheduleModal.classList.add('hidden');
    }

    if (generatedTestScheduleEnabledInput) {
        generatedTestScheduleEnabledInput.addEventListener('change', toggleScheduleOptionsVisibility);
    }

    if (generatedTestScheduleQuickWeekdaysButton) {
        generatedTestScheduleQuickWeekdaysButton.addEventListener('click', () => {
            setSelectedScheduleDays(generatedTestScheduleDaysContainer, [1, 2, 3, 4, 5]);
        });
    }

    if (generatedTestScheduleQuickEveryDayButton) {
        generatedTestScheduleQuickEveryDayButton.addEventListener('click', () => {
            setSelectedScheduleDays(generatedTestScheduleDaysContainer, [0, 1, 2, 3, 4, 5, 6]);
        });
    }

    if (closeGeneratedTestScheduleModalButton) {
        closeGeneratedTestScheduleModalButton.addEventListener('click', closeScheduleModal);
    }

    if (cancelGeneratedTestScheduleButton) {
        cancelGeneratedTestScheduleButton.addEventListener('click', closeScheduleModal);
    }

    if (removeGeneratedTestScheduleButton) {
        removeGeneratedTestScheduleButton.addEventListener('click', async () => {
            if (!scheduleModalFileName) return;
            const fileName = scheduleModalFileName;
            const saved = await saveGeneratedTestSchedule(fileName, null);
            if (saved) {
                showToast('Schedule removed.', 'success');
                closeScheduleModal();
                await loadGeneratedTests();
            }
        });
    }

    if (saveGeneratedTestScheduleButton) {
        saveGeneratedTestScheduleButton.addEventListener('click', async () => {
            if (!scheduleModalFileName) return;
            const fileName = scheduleModalFileName;
            const enabled = generatedTestScheduleEnabledInput.checked;

            if (!enabled) {
                // Kullanıcı kutuyu işaretlemeden kaydettiyse: zaten var olan bir zamanlama varsa
                // komple kaldır (removeGeneratedTestScheduleButton'ın "Kaldır"ı ile AYNI sonuç,
                // buradan da erişilebilsin diye); hiç yoksa hiçbir şey yapma (modalı kapat yeter).
                const saved = await saveGeneratedTestSchedule(fileName, null);
                if (saved) showToast('Schedule removed.', 'success');
                closeScheduleModal();
                await loadGeneratedTests();
                return;
            }

            const selectedDays = getSelectedScheduleDays(generatedTestScheduleDaysContainer);
            if (selectedDays.length === 0) {
                showToast('Pick at least one day.', 'error');
                return;
            }

            const saved = await saveGeneratedTestSchedule(fileName, {
                enabled: true,
                time: generatedTestScheduleTimeInput.value || '23:00',
                days: selectedDays,
            });

            if (saved) {
                showToast('Schedule saved.', 'success');
                closeScheduleModal();
                await loadGeneratedTests();
            }
        });
    }


    /* -----------------------------------------------------
       ADD TO SUITE MODAL
       ------------------------------------------------------
       v3.11 — bkz. pages/generated-tests.html "ADD TO SUITE MODAL" NOT'u ve
       LegacyGeneratedTestMeta.suiteIds dosya başı açıklaması. Bir test bu modal üzerinden var olan
       bir suite'e eklenebilir YA DA yeni bir isim girilip anında oluşturulup eklenebilir.
    ----------------------------------------------------- */

    async function openAddToSuiteModal(fileName) {
        if (!addToSuiteModal) return;

        addToSuiteTargetFile = fileName;
        addToSuiteNewName.value = '';
        addToSuiteExistingSelect.innerHTML = '<option value="">— Select —</option>';

        try {
            const response = await fetch('/api/suites');
            const result = await response.json();
            const suites = Array.isArray(result.suites) ? result.suites : [];

            for (const suite of suites) {
                const option = document.createElement('option');
                option.value = suite.id;
                option.textContent = suite.name;
                addToSuiteExistingSelect.appendChild(option);
            }
        } catch (error) {
            console.error(error);
            // Sessizce yok say — kullanıcı yine de "New suite name" ile yeni bir suite oluşturabilir.
        }

        addToSuiteModal.classList.remove('hidden');
    }

    function closeAddToSuiteModal() {
        addToSuiteTargetFile = null;
        addToSuiteModal?.classList.add('hidden');
    }

    if (closeAddToSuiteModalButton) {
        closeAddToSuiteModalButton.addEventListener('click', closeAddToSuiteModal);
    }

    if (cancelAddToSuiteButton) {
        cancelAddToSuiteButton.addEventListener('click', closeAddToSuiteModal);
    }

    if (confirmAddToSuiteButton) {
        confirmAddToSuiteButton.addEventListener('click', async () => {
            if (!addToSuiteTargetFile) return;
            const fileName = addToSuiteTargetFile;

            const newName = addToSuiteNewName.value.trim();
            const existingSuiteId = addToSuiteExistingSelect.value;

            if (!newName && !existingSuiteId) {
                showToast('Pick an existing suite or enter a name for a new one.', 'error');
                return;
            }

            confirmAddToSuiteButton.disabled = true;

            try {
                let suiteId = existingSuiteId;

                // Yeni isim girildiyse ÖNCE suite'i oluştur (mevcut seçimden BAĞIMSIZ — kullanıcı
                // ikisini birden doldurursa "yeni oluştur" kazanır, çünkü niyeti daha AÇIK).
                if (newName) {
                    const createResponse = await fetch('/api/suites', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newName }),
                    });
                    const created = await createResponse.json();
                    if (!createResponse.ok) {
                        throw new Error(created.message || 'Failed to create suite.');
                    }
                    suiteId = created.id;
                }

                const addResponse = await fetch(
                    `/api/generated-tests/${encodeURIComponent(fileName)}/suites`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ suiteId }),
                    },
                );
                const addResult = await addResponse.json();
                if (!addResponse.ok) {
                    throw new Error(addResult.message || 'Failed to add test to suite.');
                }

                showToast('Added to suite.', 'success');
                closeAddToSuiteModal();
                await loadGeneratedTests();

            } catch (error) {
                console.error(error);
                showToast(
                    error instanceof Error ? error.message : 'Failed to add test to suite.',
                    'error',
                );
            } finally {
                confirmAddToSuiteButton.disabled = false;
            }
        });
    }


    let allTests = [];

    let currentPage = 1;

    const pageSize = 10;

    // Sayfalar arası (currentPage değişse bile) seçim korunur — dosya adına göre tutuluyor,
    // render'da bu Set'e bakılarak checkbox'ların checked durumu belirlenir.
    let selectedGeneratedTestFiles = new Set();

    // v2.0 — bir toplu çalıştırma başladıktan sonra, HER dosya için canlı durumu tutar (bkz.
    // trackBatchRuns). renderGeneratedTests() bunu okuyup ilgili satıra küçük bir rozet basar.
    // Terminal olmayan (WS henüz açık) girdiler her zaman status:'running'dir.
    let batchRunStatusByFile = new Map();

    // v2.0 — trackBatchRuns sırasında gelen `step` WS event'lerini dosya bazında CANLI biriktirir
    // (bkz. trackBatchRuns). Bir dosya bu Map'te KEY olarak varsa (değeri boş dizi bile olsa) o
    // satırın adımları sunucudan gelen eski `test.steps` yerine BU canlı listeden render edilir.
    // Toplu çalıştırma tamamen bitince (tüm run'lar terminal) temizlenir — bkz. trackBatchRuns
    // içindeki remaining===0 dalı — çünkü o noktada loadGeneratedTests() zaten kalıcı/gerçek
    // `steps` alanını sunucudan getirecektir.
    let liveStepsByFile = new Map();

    // v2.3 — trackBatchRuns sırasında gelen 'grid_live_view' WS event'ini (ve geç bağlanan
    // istemciler için ilk 'run_snapshot'ın seleniumGridLiveViewUrl alanını) dosya bazında tutar —
    // tek koşumdaki gridLiveViewLink'in (bkz. dosya başı açıklaması, satır ~593) toplu koşum
    // karşılığı. Bir dosyanın run'ı bittiğinde (settle) silinir: Grid session zaten kapanmış
    // olacağı için link artık geçersizdir, göstermeye devam etmek kullanıcıyı yanıltır.
    let liveViewUrlByFile = new Map();

    // v2.0 — hangi dosyaların step satırı (stepsRow) açık/kapalı olduğunu tutar. Daha önce bu
    // durum SADECE DOM class'ında tutuluyordu; ama toplu koşum sırasında canlı adımlar geldikçe
    // tabloyu yeniden render etmemiz gerekiyor (bkz. renderGeneratedTests çağrıları) ve tam bir
    // yeniden render, DOM'daki class'ları sıfırlayıp kullanıcının açtığı satırları kapatırdı. Bu
    // yüzden açık/kapalı durumu burada, render'dan BAĞIMSIZ bir state olarak tutuyoruz.
    let expandedGeneratedTestSteps = new Set();


    function formatDate(dateValue) {

        if (!dateValue) {
            return '-';
        }

        return new Date(
            dateValue,
        ).toLocaleString(
            'tr-TR',
        );
    }


    // Generated Tests tablosunda dosya adının altında gösterilecek kısa/okunabilir sayfa etiketi
    // üretir — tam URL yerine sadece host (ör. "www.hepsiburada.com") gösterilir, satırı
    // kalabalıklaştırmadan hangi sayfaya ait olduğunu anlamak için yeterlidir. Geçersiz/boş URL'de
    // sessizce boş döner (o zaman satırda hiç gösterilmez).
    function formatUrlForDisplay(url) {

        if (
            !url ||
            typeof url !==
            'string'
        ) {
            return '';
        }

        try {

            return new URL(
                url,
            ).hostname;

        } catch (error) {
            // Geçersiz/eksik URL — ham metni olduğu gibi göster, sessizce yutmaktansa yine de
            // kullanıcıya bir ipucu vermiş oluruz.
            return url;
        }
    }


    // v2.0 — "Tümünü Seç" checkbox'ının checked/indeterminate durumunu, verilen test listesine
    // (genelde visibleTests — mevcut filtreye uyan TÜM testler, sadece bu sayfadakiler değil)
    // göre günceller. renderGeneratedTests()'ten VE tek tek checkbox değişikliklerinden çağrılır.
    function updateSelectAllGeneratedTestsCheckbox(tests) {

        if (!selectAllGeneratedTestsCheckbox) {
            return;
        }

        const fileNames =
            tests.map((test) =>
                typeof test ===
                'string'

                    ? test

                    : test.fileName,
            );

        const allSelected =
            fileNames.length >
            0 &&
            fileNames.every((fileName) =>
                selectedGeneratedTestFiles.has(
                    fileName,
                ),
            );

        const someSelected =
            fileNames.some((fileName) =>
                selectedGeneratedTestFiles.has(
                    fileName,
                ),
            );

        selectAllGeneratedTestsCheckbox.checked =
            allSelected;

        selectAllGeneratedTestsCheckbox.indeterminate =
            !allSelected &&
            someSelected;
    }


    // v2.0 — seçim çubuğunun (sayı + Run Selected/Clear selection) görünürlüğünü ve metnini
    // günceller. Seçim her değiştiğinde (tekli checkbox, "Tümünü Seç", "Clear selection")
    // çağrılmalıdır.
    function updateGeneratedTestsSelectionBar() {

        if (!generatedTestsSelectionBar) {
            return;
        }

        const count =
            selectedGeneratedTestFiles.size;

        if (count === 0) {

            generatedTestsSelectionBar.classList.add(
                'hidden',
            );

            generatedTestsSelectionBar.classList.remove(
                'flex',
            );

            return;
        }

        generatedTestsSelectionBar.classList.remove(
            'hidden',
        );

        generatedTestsSelectionBar.classList.add(
            'flex',
        );

        generatedTestsSelectionCount.textContent =
            `${count} selected`;
    }


    // v2.0 — batchRunStatusByFile'daki bir durumun rozet metnini/stilini üretir (bkz.
    // trackBatchRuns dosya başı NOT — durumlar RunStatus ile birebir aynıdır: 'running' HARİÇ,
    // o sadece bu frontend state'inin başlangıç değeridir).
    function batchStatusBadgeLabel(status) {

        switch (status) {
            case 'passed':
                return 'Passed';
            case 'failed':
                return 'Failed';
            case 'error':
                return 'Error';
            case 'cancelled':
                return 'Cancelled';
            // v2.4 — kayıtlı adımlar sayfayla eşleşmediği için (replay_mismatch) backend AYNI run'ı
            // otomatik olarak AI ile yeniden deniyor (bkz. runManager.startRunWithAutoRetry) — bu
            // run HENÜZ BİTMEDİ, sadece modu değişti; bu yüzden "Failed" DEĞİL, ayrı bir rozet.
            case 'retrying':
                return 'AI ile yeniden deneniyor…';
            default:
                return 'Running…';
        }
    }

    function batchStatusBadgeClasses(status) {

        switch (status) {
            case 'passed':
                return 'bg-secondary/15 text-secondary';
            case 'failed':
            case 'error':
                return 'bg-error/15 text-error';
            case 'cancelled':
                return 'bg-surface-container-highest text-on-surface-variant';
            case 'retrying':
                return 'bg-tertiary/15 text-tertiary animate-pulse';
            default:
                return 'bg-primary-container/60 text-on-primary-container animate-pulse';
        }
    }


    function getVisibleTests() {

        const searchValue =
            generatedTestsSearch
                .value
                .trim()
                .toLowerCase();


        let tests =
            allTests.filter((test) => {

                const fileName =
                    typeof test ===
                    'string'

                        ? test

                        : test.fileName;

                // v3.11 — bkz. sohbet notu: "Sadece Suit'te görünür, Generated Tests'ten
                // kaybolur". En az bir suite'e eklenmiş testler ana listeden gizlenir — Suites
                // sayfasındaki ilgili suite(ler) içinde görünmeye devam ederler (bkz.
                // initSuitesPage, aynı `allTests`/GET /generated-tests verisini kullanır).
                const inAnySuite =
                    typeof test !==
                    'string' &&
                    Array.isArray(test.suiteIds) &&
                    test.suiteIds.length > 0;

                if (inAnySuite) {
                    return false;
                }

                return (
                    !searchValue ||
                    fileName
                        ?.toLowerCase()
                        .includes(
                            searchValue,
                        )
                );
            });


        const sortValue =
            generatedTestsSort.value;


        tests =
            [...tests].sort(
                (
                    firstTest,
                    secondTest,
                ) => {

                    const firstName =
                        typeof firstTest ===
                        'string'

                            ? firstTest

                            : firstTest.fileName;


                    const secondName =
                        typeof secondTest ===
                        'string'

                            ? secondTest

                            : secondTest.fileName;


                    const firstDate =
                        typeof firstTest ===
                        'string'

                            ? 0

                            : new Date(
                                firstTest.createdAt ||
                                0,
                            ).getTime();


                    const secondDate =
                        typeof secondTest ===
                        'string'

                            ? 0

                            : new Date(
                                secondTest.createdAt ||
                                0,
                            ).getTime();


                    if (
                        sortValue ===
                        'oldest'
                    ) {

                        return (
                            firstDate -
                            secondDate
                        );
                    }


                    if (
                        sortValue ===
                        'name'
                    ) {

                        return firstName.localeCompare(
                            secondName,
                        );
                    }


                    return (
                        secondDate -
                        firstDate
                    );
                },
            );


        return tests;
    }


    function renderGeneratedTests() {

        const visibleTests =
            getVisibleTests();


        if (
            visibleTests.length ===
            0
        ) {

            generatedTestsTableBody.innerHTML =
                '';


            generatedTestsEmptyState.classList.remove(
                'hidden',
            );

            generatedTestsEmptyState.classList.add(
                'flex',
            );


            generatedTestsPagination.classList.add(
                'hidden',
            );

            generatedTestsPagination.classList.remove(
                'flex',
            );

            return;
        }


        generatedTestsEmptyState.classList.add(
            'hidden',
        );

        generatedTestsEmptyState.classList.remove(
            'flex',
        );


        const totalPages =
            Math.max(
                1,
                Math.ceil(
                    visibleTests.length /
                    pageSize,
                ),
            );


        if (
            currentPage >
            totalPages
        ) {

            currentPage =
                totalPages;
        }


        const startIndex =
            (
                currentPage -
                1
            ) *
            pageSize;


        const endIndex =
            startIndex +
            pageSize;


        const pageTests =
            visibleTests.slice(
                startIndex,
                endIndex,
            );


        generatedTestsTableBody.innerHTML =
            pageTests
                .map((test) => {

                    const fileName =
                        typeof test ===
                        'string'

                            ? test

                            : test.fileName;

                    // v2.4 — kullanıcının bu teste verdiği özel isim (bkz. backend
                    // LegacyGeneratedTestMeta.displayName dosya başı açıklaması). Boşsa otomatik
                    // üretilen dosya adı gösterilmeye devam eder — davranış eskisiyle aynıdır.
                    const displayName =
                        typeof test !==
                        'string' &&
                        test.displayName
                            ? test.displayName
                            : null;


                    const createdAt =
                        typeof test ===
                        'string'

                            ? null

                            : test.createdAt;


                    // Dosya adı slug'ı hangi sayfaya ait olduğunu her zaman net göstermiyor (ör.
                    // "formu-doldur-ad-olarak..." adından DemoQA olduğu anlaşılmaz) — bu yüzden
                    // hedef URL'yi dosya adının hemen altında küçük/soluk bir satır olarak da
                    // gösteriyoruz. Bu, özellikle birden fazla test paralel koşarken (bkz.
                    // trackBatchRuns) hangi satırın hangi sayfayla ilgili olduğunu ayırt etmeyi
                    // kolaylaştırır.
                    const testUrl =
                        typeof test !==
                        'string'
                            ? test.url
                            : '';

                    const testUrlLabel =
                        formatUrlForDisplay(
                            testUrl,
                        );



                    // v2.0 BDD/step görüntüleme — bkz. backend BddStepView/buildBddSteps.ts dosya
                    // başı açıklaması. Eski (bu alan eklenmeden ÖNCE üretilmiş) kayıtlarda ve düz
                    // string girdilerde (çok eski format) bulunmaz — o durumda genişletme oku hiç
                    // gösterilmez.
                    // v2.0 — bu dosya şu an bir toplu çalıştırmanın parçasıysa (liveStepsByFile'da
                    // KEY olarak varsa), sunucudan gelen eski `test.steps` yerine WS'ten canlı
                    // biriken adımlar gösterilir (bkz. trackBatchRuns). Aksi halde (koşum yok/bitti)
                    // meta'daki kalıcı `steps` kullanılır.
                    const liveSteps =
                        liveStepsByFile.get(
                            fileName,
                        );

                    const isLive =
                        liveSteps !==
                        undefined;

                    const steps =
                        isLive
                            ? liveSteps
                            : (typeof test !==
                            'string' &&
                            Array.isArray(
                                test.steps,
                            )
                                ? test.steps
                                : []);

                    const hasSteps =
                        steps.length >
                        0 ||
                        isLive;

                    const isStepsExpanded =
                        expandedGeneratedTestSteps.has(
                            fileName,
                        );

                    const isSelected =
                        selectedGeneratedTestFiles.has(
                            fileName,
                        );

                    // v2.0 — bu dosya şu an bir toplu çalıştırmanın parçasıysa (bkz. trackBatchRuns),
                    // dosya adının yanında küçük bir durum rozeti gösterilir.
                    const batchStatus =
                        batchRunStatusByFile.get(
                            fileName,
                        );

                    // v2.3 — bu dosyanın run'ı şu an Grid üzerinden çalışıyorsa ve bir noVNC linki
                    // geldiyse (bkz. liveViewUrlByFile dosya başı açıklaması), rozetin yanında bir
                    // "Watch Live" linki gösterilir.
                    const liveViewUrl =
                        liveViewUrlByFile.get(
                            fileName,
                        );

                    return `
                        <tr
                            class="
                                hover:bg-surface-container/50
                                transition-colors
                            "
                            data-file="${fileName}"
                        >

                            <td
                                class="
                                    py-sm
                                    pl-md
                                    pr-xs
                                "
                            >

                                <input
                                    class="
                                        generatedTestRowCheckbox
                                        w-[16px]
                                        h-[16px]
                                        rounded
                                        border-outline-variant
                                        cursor-pointer
                                    "
                                    data-file="${fileName}"
                                    type="checkbox"
                                    aria-label="Select ${fileName}"
                                    ${isSelected ? 'checked' : ''}
                                />

                            </td>


                            <td
                                class="
                                    py-sm
                                    px-md
                                "
                            >

                                <div
                                    class="
                                        flex
                                        items-start
                                        gap-sm
                                    "
                                >

                                    ${
                        hasSteps
                            ? `
                                    <button
                                        class="
                                            toggleGeneratedTestStepsButton
                                            text-on-surface-variant
                                            hover:text-on-surface
                                            flex items-center justify-center
                                            w-[20px] h-[20px]
                                            shrink-0
                                            mt-[2px]
                                        "
                                        data-file="${fileName}"
                                        type="button"
                                        aria-label="Toggle steps for ${fileName}"
                                        aria-expanded="${isStepsExpanded ? 'true' : 'false'}"
                                    >
                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[18px]
                                                transition-transform
                                            "
                                            style="${isStepsExpanded ? 'transform: rotate(90deg);' : ''}"
                                        >
                                            chevron_right
                                        </span>
                                    </button>
                                    `
                            : `<span class="w-[20px] h-[20px] shrink-0"></span>`
                    }

                                    <span
                                        class="
                                            material-symbols-outlined
                                            text-primary-fixed-dim
                                            text-[20px]
                                            mt-[2px]
                                            shrink-0
                                        "
                                    >
                                        javascript
                                    </span>

                                    <div
                                        class="
                                            flex
                                            flex-col
                                            gap-[2px]
                                            min-w-0
                                        "
                                    >

                                        <div
                                            class="
                                                flex
                                                items-center
                                                flex-wrap
                                                gap-sm
                                            "
                                        >

                                            <span
                                                class="
                                                    ${
                        displayName
                            ? 'font-body-sm'
                            : 'font-mono'
                    }
                                                    text-sm
                                                    text-primary-fixed
                                                    break-all
                                                "
                                                ${
                        displayName
                            ? `title="${escapeHtml(fileName)}"`
                            : ''
                    }
                                            >
                                                ${escapeHtml(displayName || fileName)}
                                            </span>

                                            <button
                                                class="
                                                    renameGeneratedTestButton
                                                    inline-flex
                                                    items-center
                                                    justify-center
                                                    text-on-surface-variant
                                                    hover:text-on-surface
                                                    shrink-0
                                                "
                                                data-file="${fileName}"
                                                data-current-name="${escapeHtml(displayName || '')}"
                                                title="Rename this test"
                                                aria-label="Rename ${fileName}"
                                                type="button"
                                            >
                                                <span
                                                    class="
                                                        material-symbols-outlined
                                                        text-[15px]
                                                    "
                                                >
                                                    edit
                                                </span>
                                            </button>

                                            <button
                                                class="
                                                    scheduleGeneratedTestButton
                                                    inline-flex
                                                    items-center
                                                    justify-center
                                                    ${
                        test.schedule?.enabled
                            ? 'text-primary'
                            : 'text-on-surface-variant hover:text-on-surface'
                    }
                                                    shrink-0
                                                "
                                                data-file="${fileName}"
                                                title="${
                        test.schedule?.enabled
                            ? `Scheduled: ${formatScheduleSummary(test.schedule)}`
                            : 'Schedule this test'
                    }"
                                                aria-label="Schedule ${fileName}"
                                                type="button"
                                            >
                                                <span
                                                    class="
                                                        material-symbols-outlined
                                                        text-[15px]
                                                    "
                                                >
                                                    ${test.schedule?.enabled ? 'alarm_on' : 'alarm_add'}
                                                </span>
                                            </button>

                                            ${
                        batchStatus
                            ? `
                                            <span
                                                class="
                                                    inline-flex items-center gap-1
                                                    px-2 py-[2px]
                                                    rounded-full
                                                    text-[10px] font-bold uppercase tracking-wider
                                                    shrink-0
                                                    ${batchStatusBadgeClasses(batchStatus.status)}
                                                "
                                            >
                                                ${batchStatusBadgeLabel(batchStatus.status)}
                                            </span>
                                            `
                            : ''
                    }

                                            ${
                        liveViewUrl
                            ? `
                                            <a
                                                href="${liveViewUrl}"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="
                                                    inline-flex items-center gap-1
                                                    px-2 py-[2px]
                                                    rounded-full
                                                    text-[10px] font-bold uppercase tracking-wider
                                                    shrink-0
                                                    bg-primary/15 text-primary
                                                    hover:bg-primary/25
                                                    transition-colors
                                                "
                                            >
                                                <span class="material-symbols-outlined text-[12px]">visibility</span>
                                                Watch Live
                                            </a>
                                            `
                            : ''
                    }

                                        </div>

                                        ${
                        testUrlLabel
                            ? `
                                        <span
                                            class="
                                                font-mono
                                                text-[11px]
                                                text-on-surface-variant/70
                                                break-all
                                            "
                                            title="${escapeHtml(testUrl)}"
                                        >
                                            ${escapeHtml(testUrlLabel)}
                                        </span>
                                        `
                            : ''
                    }

                                    </div>

                                </div>

                            </td>


                            <td
                                class="
                                    py-sm
                                    px-md
                                "
                            >

                                <span
                                    class="
                                        inline-flex
                                        items-center
                                        px-2
                                        py-1
                                        rounded-md
                                        bg-surface-container
                                        border
                                        border-outline-variant
                                        text-body-sm
                                        text-on-surface-variant
                                    "
                                >
                                    Playwright TypeScript
                                </span>

                            </td>


                            <td
                                class="
                                    py-sm
                                    px-md
                                    text-on-surface-variant
                                "
                            >
                                ${formatDate(createdAt)}
                            </td>


                            <td
                                class="
                                    py-sm
                                    px-md
                                    text-right
                                "
                            >

                                <div
                                    class="
                                        flex
                                        justify-end
                                        gap-sm
                                    "
                                >

                                    <button
                                        class="
                                            viewGeneratedTestButton
                                            inline-flex
                                            items-center
                                            gap-xs
                                            text-on-surface-variant
                                            hover:text-on-surface
                                            px-sm
                                            py-[6px]
                                            rounded-lg
                                            border
                                            border-outline-variant
                                        "
                                        data-file="${fileName}"
                                        type="button"
                                    >

                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                            "
                                        >
                                            code
                                        </span>

                                        View Code

                                    </button>


                                    <button
                                        class="
                                            openBddFromGeneratedButton
                                            inline-flex
                                            items-center
                                            gap-xs
                                            text-on-surface-variant
                                            hover:text-on-surface
                                            px-sm
                                            py-[6px]
                                            rounded-lg
                                            border
                                            border-outline-variant
                                        "
                                        data-file="${fileName}"
                                        type="button"
                                        title="Open in the Create Test BDD tab to view or edit"
                                    >

                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                            "
                                        >
                                            edit_note
                                        </span>

                                        BDD

                                    </button>


                                    <button
                                        class="
                                            runGeneratedTestButton
                                            inline-flex
                                            items-center
                                            gap-xs
                                            bg-primary-container
                                            text-on-primary-container
                                            rounded-lg
                                            py-[6px]
                                            px-sm
                                            font-bold
                                        "
                                        data-file="${fileName}"
                                        title="Bu testin kayitli BDD senaryosunu ve degiskenlerini kullanarak calisir (view code'daki donuk veriler DEGIL)"
                                        type="button"
                                    >

                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                            "
                                        >
                                            play_arrow
                                        </span>

                                        Run

                                    </button>


                                    <button
                                        class="
                                            addToSuiteButton
                                            inline-flex
                                            items-center
                                            gap-xs
                                            text-on-surface-variant
                                            hover:text-on-surface
                                            px-sm
                                            py-[6px]
                                            rounded-lg
                                            border
                                            border-outline-variant
                                        "
                                        data-file="${fileName}"
                                        title="Bu testi bir Suite'e ekle"
                                        type="button"
                                    >

                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                            "
                                        >
                                            playlist_add
                                        </span>

                                        Add to Suite

                                    </button>


                                    <!-- Kenara, diğer aksiyonlardan ayrı duruyor (ince bir ayraçla)
                                         — yıkıcı bir işlem olduğu için "Run"a yanlışlıkla bitişik
                                         durmasın diye bilinçli olarak görsel bir boşluk bırakıldı. -->
                                    <div class="w-px h-5 bg-outline-variant/50 mx-1 self-center"></div>

                                    <button
                                        class="
                                            deleteGeneratedTestButton
                                            inline-flex
                                            items-center
                                            justify-center
                                            text-on-surface-variant
                                            hover:text-error
                                            hover:bg-error/10
                                            p-[6px]
                                            rounded-lg
                                            border
                                            border-outline-variant
                                            hover:border-error/40
                                            transition-colors
                                        "
                                        data-file="${fileName}"
                                        title="Delete"
                                        aria-label="Delete ${fileName}"
                                        type="button"
                                    >
                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                            "
                                        >
                                            delete
                                        </span>
                                    </button>

                                </div>

                            </td>

                        </tr>

                        ${
                        hasSteps
                            ? `
                        <tr
                            class="stepsRow ${isStepsExpanded ? '' : 'hidden'}"
                            data-file="${fileName}"
                        >
                            <td colspan="5" class="pl-[52px] pr-md pb-sm pt-0 bg-surface-container-lowest/40">
                                ${
                                isLive &&
                                steps.length === 0
                                    ? `
                                <p class="font-body-sm text-body-sm text-on-surface-variant italic py-sm">
                                    Running — waiting for the first step...
                                </p>
                                `
                                    : `
                                <ol class="flex flex-col gap-1 py-sm border-l-2 border-outline-variant/40 pl-md">
                                    ${steps
                                        .map(
                                            (step) => `
                                    <li class="flex items-start gap-sm">
                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                                mt-[1px]
                                                ${step.ok ? 'text-secondary' : 'text-error'}
                                            "
                                        >
                                            ${step.ok ? 'check_circle' : 'cancel'}
                                        </span>
                                        <span class="font-mono text-xs text-on-surface-variant shrink-0">
                                            ${step.index + 1}.
                                        </span>
                                        <span class="font-body-sm text-body-sm text-on-surface flex-1">
                                            ${escapeHtml(step.description)}
                                        </span>
                                        ${
                                        step.decisionSource
                                            ? `
                                        <span
                                                class="inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-bold uppercase tracking-wider shrink-0 mt-[2px] ${
                                            step.decisionSource === 'vector_cache'
                                                ? 'bg-primary/15 text-primary'
                                                : step.decisionSource === 'replay'
                                                    ? 'bg-secondary/15 text-secondary'
                                                    : 'bg-surface-container-high text-on-surface-variant'
                                        }"
                                                title="${
                                            step.decisionSource === 'vector_cache'
                                                ? 'Vector cache — LLM’e hiç danışılmadı'
                                                : step.decisionSource === 'replay'
                                                    ? 'Replay (No AI)'
                                                    : 'Gerçek LLM çağrısı'
                                        }"
                                        >
                                            ${escapeHtml(DECISION_SOURCE_LABELS[step.decisionSource] || step.decisionSource)}
                                        </span>
                                        `
                                            : ''
                                    }
                                        <span
                                            class="
                                                font-mono text-[10px]
                                                uppercase tracking-wider
                                                text-on-surface-variant/70
                                                shrink-0
                                                mt-[2px]
                                            "
                                        >
                                            ${escapeHtml(step.action)}
                                        </span>
                                    </li>
                                    `,
                                        )
                                        .join('')}
                                </ol>
                                `
                            }
                            </td>
                        </tr>
                        `
                            : ''
                    }
                    `;
                })
                .join('');


        generatedTestsPagination.classList.remove(
            'hidden',
        );

        generatedTestsPagination.classList.add(
            'flex',
        );


        generatedTestsPaginationInfo.textContent =
            `Showing ${startIndex + 1} to ${Math.min(
                endIndex,
                visibleTests.length,
            )} of ${visibleTests.length} entries`;


        generatedTestsCurrentPage.textContent =
            currentPage;


        generatedTestsPreviousPage.disabled =
            currentPage ===
            1;


        generatedTestsNextPage.disabled =
            currentPage ===
            totalPages;


        // v2.0 — "Tümünü Seç" checkbox'ının checked/indeterminate durumu, sayfalamadan BAĞIMSIZ
        // olarak mevcut filtreye uyan TÜM testlere (visibleTests, sadece bu sayfadakilere değil)
        // göre hesaplanır — "Tümünü Seç" gerçekten TÜMÜNÜ seçsin/yansıtsın diye.
        updateSelectAllGeneratedTestsCheckbox(
            visibleTests,
        );

        updateGeneratedTestsSelectionBar();


        document
            .querySelectorAll(
                '.generatedTestRowCheckbox',
            )
            .forEach((checkbox) => {

                checkbox.addEventListener(
                    'change',
                    () => {

                        const fileName =
                            checkbox.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        if (checkbox.checked) {
                            selectedGeneratedTestFiles.add(
                                fileName,
                            );
                        } else {
                            selectedGeneratedTestFiles.delete(
                                fileName,
                            );
                        }

                        updateSelectAllGeneratedTestsCheckbox(
                            getVisibleTests(),
                        );

                        updateGeneratedTestsSelectionBar();
                    },
                );
            });


        document
            .querySelectorAll(
                '.toggleGeneratedTestStepsButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        const stepsRow =
                            document.querySelector(
                                `.stepsRow[data-file="${CSS.escape(fileName)}"]`,
                            );

                        if (!stepsRow) {
                            return;
                        }

                        const nowHidden =
                            stepsRow.classList.toggle(
                                'hidden',
                            );

                        // Açık/kapalı durumunu render'dan bağımsız State'e de yaz — canlı adımlar
                        // geldikçe tabloyu yeniden çizsek bile (bkz. trackBatchRuns) kullanıcının
                        // açtığı satır kapanmasın (bkz. expandedGeneratedTestSteps tanımı).
                        if (nowHidden) {
                            expandedGeneratedTestSteps.delete(
                                fileName,
                            );
                        } else {
                            expandedGeneratedTestSteps.add(
                                fileName,
                            );
                        }

                        button.setAttribute(
                            'aria-expanded',
                            String(!nowHidden),
                        );

                        const chevron =
                            button.querySelector(
                                '.material-symbols-outlined',
                            );

                        if (chevron) {
                            chevron.style.transform =
                                nowHidden
                                    ? ''
                                    : 'rotate(90deg)';
                        }
                    },
                );
            });


        document
            .querySelectorAll(
                '.openBddFromGeneratedButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    async (event) => {

                        // stepsRow'un kendisi ayrıca tıklamaya tepki vermiyor ama yine de
                        // toggleGeneratedTestStepsButton ile aynı satırda olduğu için event
                        // taşmasını önlemek adına durduruyoruz (bkz. .stepsRow yapısı).
                        event.stopPropagation();

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        const test =
                            allTests.find(
                                (t) =>
                                    typeof t !== 'string' &&
                                    t.fileName === fileName,
                            );

                        if (!test) {
                            return;
                        }

                        await openBddEditorForGeneratedTest(
                            test,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.viewGeneratedTestButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    async () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );


                        if (!fileName) {
                            return;
                        }


                        await openGeneratedTestCode(
                            fileName,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.runGeneratedTestButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    async () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );


                        if (!fileName) {
                            return;
                        }

                        // v3.22 — bkz. sohbet notu: "Run butonuna tıklandığı zaman aynı BDD deki
                        // gibi açılan ekranda bilgiler gelsin". Create Test sayfasında Scenario
                        // Definition alanlarını (url/isim/değişkenler/BDD metni) doldurabilmek
                        // için testin tam kaydına ihtiyaç var (bkz. runExistingTest içindeki
                        // appState.pendingLiveRun ataması) — sadece fileName yeterli değil.
                        const test =
                            allTests.find(
                                (t) =>
                                    typeof t !== 'string' &&
                                    t.fileName === fileName,
                            );

                        await runExistingTest(
                            fileName,
                            button,
                            test,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.addToSuiteButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        openAddToSuiteModal(
                            fileName,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.renameGeneratedTestButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    async () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        const currentName =
                            button.getAttribute(
                                'data-current-name',
                            ) ||
                            '';

                        await renameGeneratedTest(
                            fileName,
                            currentName,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.scheduleGeneratedTestButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        const test =
                            allTests.find(
                                (t) => t.fileName === fileName,
                            );

                        openScheduleModal(
                            fileName,
                            test?.schedule,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.deleteGeneratedTestButton',
            )
            .forEach((button) => {

                button.addEventListener(
                    'click',
                    async () => {

                        const fileName =
                            button.getAttribute(
                                'data-file',
                            );

                        if (!fileName) {
                            return;
                        }

                        // Yıkıcı bir işlem — geri alınamaz, bu yüzden native confirm() ile
                        // onay isteniyor (uygulamanın geri kalanında zaten alert() kullanılıyor,
                        // aynı sade yaklaşım).
                        const confirmed =
                            confirm(
                                `Delete "${fileName}"? This cannot be undone.`,
                            );

                        if (!confirmed) {
                            return;
                        }

                        button.disabled =
                            true;

                        try {

                            const response =
                                await fetch(
                                    `/api/generated-tests/${encodeURIComponent(fileName)}`,
                                    {
                                        method: 'DELETE',
                                    },
                                );

                            const result =
                                await response.json();

                            if (!response.ok) {
                                throw new Error(
                                    result.message ||
                                    'Failed to delete test.',
                                );
                            }

                            // Yerelde satırı manuel çıkarıp sayaçları elle güncellemek yerine,
                            // mevcut loadGeneratedTests() ile sunucudan taze listeyi çekiyoruz —
                            // toplam sayı, "Last Generated" ve sayfalama hep tek bir kaynaktan
                            // (backend) senkron kalır.
                            await loadGeneratedTests();

                        } catch (error) {

                            console.error(error);

                            showToast(
                                error instanceof Error
                                    ? error.message
                                    : 'Failed to delete test.',
                                'error',
                            );

                            button.disabled =
                                false;
                        }
                    },
                );
            });

        renderActiveGeneratedTestRuns();
    }


    /**
     * v2.3 — sayfanın üstünde, o an "Run Selected" ile paralel çalışan TÜM koşumları tek bir
     * panelde özetler (bkz. generatedTestsActiveRunsPanel/generatedTestsActiveRunsList,
     * pages/generated-tests.html). Amaç: tabloyu aşağı kaydırmadan, hangi testlerin hâlâ çalıştığını
     * ve (Grid kullanılıyorsa) her birinin kendi "Watch Live" linkini tek bakışta görebilmek — satır
     * başına link zaten var (bkz. renderGeneratedTests içindeki liveViewUrl), bu panel onu
     * TEKRARLAMAZ, sadece dağınık satırları tek yerde toplar. `renderGeneratedTests()`'in sonunda
     * çağrılır, ayrı bir state'i yoktur — `batchRunStatusByFile`/`liveViewUrlByFile`'ı okur.
     */
    function renderActiveGeneratedTestRuns() {

        if (!generatedTestsActiveRunsPanel || !generatedTestsActiveRunsList) {
            return;
        }

        const activeFileNames =
            Array.from(batchRunStatusByFile.keys());

        if (activeFileNames.length === 0) {

            generatedTestsActiveRunsPanel.classList.add('hidden');
            generatedTestsActiveRunsPanel.classList.remove('flex');
            generatedTestsActiveRunsList.innerHTML = '';
            return;
        }

        generatedTestsActiveRunsPanel.classList.remove('hidden');
        generatedTestsActiveRunsPanel.classList.add('flex');

        generatedTestsActiveRunsList.innerHTML =
            activeFileNames
                .map((fileName) => {

                    const status =
                        batchRunStatusByFile.get(fileName);

                    const liveViewUrl =
                        liveViewUrlByFile.get(fileName);

                    return `
                        <div
                                class="
                                    inline-flex items-center gap-sm
                                    px-sm py-xs
                                    rounded-lg
                                    bg-surface-container-lowest
                                    border border-outline-variant
                                "
                        >
                            <span class="font-mono text-[11px] text-on-surface break-all">
                                ${fileName}
                            </span>

                            <span
                                    class="
                                        inline-flex items-center gap-1
                                        px-2 py-[2px]
                                        rounded-full
                                        text-[10px] font-bold uppercase tracking-wider
                                        shrink-0
                                        ${batchStatusBadgeClasses(status.status)}
                                    "
                            >
                                ${batchStatusBadgeLabel(status.status)}
                            </span>

                            ${
                        liveViewUrl
                            ? `
                            <a
                                    href="${liveViewUrl}"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="
                                        inline-flex items-center gap-1
                                        px-2 py-[2px]
                                        rounded-full
                                        text-[10px] font-bold uppercase tracking-wider
                                        shrink-0
                                        bg-primary/15 text-primary
                                        hover:bg-primary/25
                                        transition-colors
                                    "
                            >
                                <span class="material-symbols-outlined text-[12px]">visibility</span>
                                Watch Live
                            </a>
                            `
                            : ''
                    }
                        </div>
                        `;
                })
                .join('');
    }


    async function updateSummary() {

        generatedTestsTotal.textContent =
            allTests.length;


        if (
            allTests.length >
            0
        ) {

            const newestTest =
                [...allTests]
                    .filter(
                        (test) =>
                            typeof test !==
                            'string' &&
                            test.createdAt,
                    )
                    .sort(
                        (a, b) =>
                            new Date(
                                b.createdAt,
                            ) -
                            new Date(
                                a.createdAt,
                            ),
                    )[0];


            generatedTestsLastGenerated.textContent =
                newestTest

                    ? formatDate(
                        newestTest.createdAt,
                    )

                    : '—';

        } else {

            generatedTestsLastGenerated.textContent =
                '—';
        }


        try {

            const response =
                await fetch(
                    '/api/test-runs',
                );


            const result =
                await response.json();


            const runs =
                result.runs ||
                [];


            if (
                runs.length ===
                0
            ) {

                generatedTestsLastRunStatus.textContent =
                    '—';

                return;
            }


            const lastRun =
                runs[0];


            generatedTestsLastRunStatus.textContent =
                lastRun.status;


            if (
                lastRun.status ===
                'passed'
            ) {

                generatedTestsLastRunStatus.className =
                    'text-[24px] leading-tight font-headline-md font-semibold text-secondary';

            } else {

                generatedTestsLastRunStatus.className =
                    'text-[24px] leading-tight font-headline-md font-semibold text-error';
            }

        } catch (error) {

            console.error(
                'Failed to fetch last run status:',
                error,
            );
        }
    }


    /**
     * v2.0 — /api/generated-tests/run-batch ile başlatılmış run'ları CANLI takip eder. Her
     * `runId` için AYRI bir `/ws/runs/:runId` bağlantısı açar (bkz. openLiveLogSocket — aynı
     * protokol/host deseni) — bu, run'ların gerçekten paralel/bağımsız olduğunun frontend
     * tarafındaki karşılığıdır. `step` event'leri liveStepsByFile'a biriktirilip ilgili satırın
     * (otomatik açılan) stepsRow'unda CANLI gösterilir — tek koşumdaki "Execution Log" deneyiminin
     * toplu koşum karşılığı budur (bkz. openLiveLogSocket / formatLiveStepLine). Terminal bir durum
     * geldiğinde (run_finished/run_error/zaten-bitmiş bir run_snapshot) ilgili satırın rozetini
     * günceller; TÜMÜ bittiğinde listeyi sunucudan tazeler (yeni geçmiş kayıtlarının Test
     * Runs/Reports'ta görünmesi için) ve canlı adım arabelleğini temizler.
     */
    function trackBatchRuns(started) {

        let remaining =
            started.length;

        const protocol =
            window.location.protocol ===
            'https:'
                ? 'wss:'
                : 'ws:';

        const settle = (fileName, status) => {

            if (status) {

                batchRunStatusByFile.set(
                    fileName,
                    { status },
                );
            } else {
                // Durum bilinmiyor (ör. WS bağlantı hatası) — run backend'de devam ediyor
                // olabilir, bu yüzden YANLIŞ bir "Error" rozeti basmak yerine rozeti kaldırıyoruz;
                // kullanıcı sonucu Refresh ile (veya toplu çalıştırma bitince otomatik) görecek.
                batchRunStatusByFile.delete(
                    fileName,
                );
            }

            // v2.3 — run bitti (ya da durumu bilinmiyor): Grid session'ı da kapanmış/kapanıyor
            // olacağı için canlı izleme linkini kaldırıyoruz, aksi halde ölü bir link asılı kalır.
            liveViewUrlByFile.delete(
                fileName,
            );

            renderGeneratedTests();

            remaining -= 1;

            if (remaining === 0) {

                batchRunStatusByFile.clear();

                // Canlı adım arabelleğini burada temizliyoruz — az sonra loadGeneratedTests() bu
                // dosyaların KALICI `steps` alanını sunucudan getirecek, bu yüzden canlı kopyaya
                // artık ihtiyaç yok (aksi halde eski canlı liste kalıcı listeyi hep gölgede
                // bırakırdı, bkz. render şablonundaki `isLive` önceliği).
                liveStepsByFile.clear();

                if (runSelectedGeneratedTestsButton) {

                    runSelectedGeneratedTestsButton.disabled =
                        false;
                }

                void loadGeneratedTests();
            }
        };

        started.forEach(({ fileName, runId }) => {

            batchRunStatusByFile.set(
                fileName,
                { status: 'running' },
            );

            // Boş dizi olarak başlatmak (undefined DEĞİL) render şablonundaki `isLive` bayrağını
            // tetikler — satır otomatik olarak "adımlar" bölümünü gösterir hale gelir.
            liveStepsByFile.set(
                fileName,
                [],
            );

            // Kullanıcı canlı ilerlemeyi görebilsin diye satırı otomatik açıyoruz — tek koşumdaki
            // Execution Log paneli her zaman görünür olduğu için buradaki davranış tutarlı.
            expandedGeneratedTestSteps.add(
                fileName,
            );

            const socket =
                new WebSocket(
                    `${protocol}//${window.location.host}/ws/runs/${runId}`,
                );

            const TERMINAL_STATUSES =
                new Set([
                    'passed',
                    'failed',
                    'error',
                    'cancelled',
                ]);

            socket.addEventListener(
                'message',
                (event) => {

                    try {

                        const data =
                            JSON.parse(
                                event.data,
                            );

                        if (data.type === 'step') {

                            // Aynı şekil buildBddSteps() (backend) ile birebir eşleşsin diye —
                            // tek koşumdaki formatLiveStepLine()'ın kullandığı alanlarla aynı.
                            const list =
                                liveStepsByFile.get(
                                    fileName,
                                ) || [];

                            list.push({
                                index: data.step?.stepIndex,
                                action: data.step?.decision?.action,
                                description:
                                    data.step?.decision?.summary?.trim() ||
                                    data.step?.decision?.reasoning ||
                                    '',
                                ok: Boolean(
                                    data.step?.actionResult?.ok,
                                ),
                                // v3.1 — bkz. formatLiveStepLine() dosya başı NOT'u (DECISION_SOURCE_LABELS).
                                decisionSource: data.step?.decision?.decisionSource,
                            });

                            liveStepsByFile.set(
                                fileName,
                                list,
                            );

                            renderGeneratedTests();

                        } else if (data.type === 'replay_retry_started') {

                            // v2.4 — kayıtlı adımlar (Replay/No AI) bu sayfada artık geçerli değil;
                            // backend AYNI runId altında otomatik olarak AI ile yeniden deniyor
                            // (bkz. runManager.startRunWithAutoRetry). Socket'i KAPATMIYORUZ — bu
                            // 'run_finished' DEĞİL, run hâlâ sürüyor, sadece modu değişti. Rozet için
                            // 'retrying' özel durumunu kullanıyoruz (bkz. batchStatusBadgeLabel).
                            batchRunStatusByFile.set(
                                fileName,
                                { status: 'retrying' },
                            );

                            // Başarısız replay denemesinin adımlarını temizliyoruz — AI denemesi
                            // sıfırdan, kendi adım numaralarıyla başlayacak; ikisini üst üste
                            // göstermek kafa karıştırırdı.
                            liveStepsByFile.set(
                                fileName,
                                [],
                            );

                            renderGeneratedTests();

                        } else if (data.type === 'run_finished') {

                            socket.close();
                            settle(fileName, data.status);

                        } else if (data.type === 'run_error') {

                            socket.close();
                            settle(fileName, 'error');

                        } else if (data.type === 'grid_live_view') {

                            // v2.3 — bkz. liveViewUrlByFile dosya başı açıklaması. Tek koşumdaki
                            // gridLiveViewLink'in toplu koşum karşılığı.
                            liveViewUrlByFile.set(
                                fileName,
                                data.url,
                            );

                            renderGeneratedTests();

                        } else if (data.type === 'run_snapshot') {

                            // v2.3 — geç bağlanan bir istemci için: run zaten Grid'e bağlanmışsa
                            // (session açılmışsa) bu bilgi ilk snapshot'ta da taşınır (bkz.
                            // runManager.handleEvent — grid_live_view olayında summary'ye de yazılır).
                            if (data.summary?.seleniumGridLiveViewUrl) {
                                liveViewUrlByFile.set(
                                    fileName,
                                    data.summary.seleniumGridLiveViewUrl,
                                );
                                renderGeneratedTests();
                            }

                            if (TERMINAL_STATUSES.has(data.summary?.status)) {
                                // WS bağlanana kadar run zaten bitmiş olabilir (nadir ama mümkün) —
                                // bu durumda ilk snapshot zaten terminal durumu taşır.
                                socket.close();
                                settle(fileName, data.summary.status);
                            }
                        }

                    } catch (error) {

                        console.error(
                            'Toplu çalıştırma WS mesajı işlenemedi:',
                            error,
                        );
                    }
                },
            );

            socket.addEventListener(
                'error',
                () => {
                    settle(fileName, null);
                },
            );
        });

        renderGeneratedTests();
    }


    async function loadGeneratedTests() {

        refreshGeneratedTestsButton.disabled =
            true;


        try {

            const response =
                await fetch(
                    '/api/generated-tests',
                );


            const result =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    result.message ||
                    'Failed to load generated tests.',
                );
            }


            allTests =
                Array.isArray(
                    result.tests,
                )
                    ? result.tests
                    : [];


            currentPage =
                1;


            await updateSummary();

            renderGeneratedTests();

        } catch (error) {

            console.error(error);


            allTests =
                [];


            generatedTestsTotal.textContent =
                '0';

            generatedTestsLastGenerated.textContent =
                '—';

            generatedTestsTableBody.innerHTML =
                '';


            generatedTestsEmptyState.classList.remove(
                'hidden',
            );

            generatedTestsEmptyState.classList.add(
                'flex',
            );

        } finally {

            refreshGeneratedTestsButton.disabled =
                false;
        }
    }


    generatedTestsSearch.addEventListener(
        'input',
        () => {

            currentPage =
                1;

            renderGeneratedTests();
        },
    );


    generatedTestsSort.addEventListener(
        'change',
        () => {

            currentPage =
                1;

            renderGeneratedTests();
        },
    );


    if (selectAllGeneratedTestsCheckbox) {

        selectAllGeneratedTestsCheckbox.addEventListener(
            'change',
            () => {

                // Sadece bu sayfadaki değil, mevcut filtreye uyan TÜM testler seçilir/bırakılır
                // (bkz. updateSelectAllGeneratedTestsCheckbox dosya başı NOT — "Tümünü Seç" gerçekten
                // tümünü kapsasın diye).
                const fileNames =
                    getVisibleTests().map((test) =>
                        typeof test ===
                        'string'

                            ? test

                            : test.fileName,
                    );

                if (selectAllGeneratedTestsCheckbox.checked) {
                    fileNames.forEach((fileName) =>
                        selectedGeneratedTestFiles.add(
                            fileName,
                        ),
                    );
                } else {
                    fileNames.forEach((fileName) =>
                        selectedGeneratedTestFiles.delete(
                            fileName,
                        ),
                    );
                }

                renderGeneratedTests();
            },
        );
    }


    if (clearGeneratedTestsSelectionButton) {

        clearGeneratedTestsSelectionButton.addEventListener(
            'click',
            () => {

                selectedGeneratedTestFiles.clear();
                renderGeneratedTests();
            },
        );
    }


    if (runSelectedGeneratedTestsButton) {

        runSelectedGeneratedTestsButton.addEventListener(
            'click',
            async () => {

                const fileNames =
                    Array.from(
                        selectedGeneratedTestFiles,
                    );

                if (fileNames.length === 0) {
                    return;
                }

                runSelectedGeneratedTestsButton.disabled =
                    true;

                try {

                    const response =
                        await fetch(
                            '/api/generated-tests/run-batch',
                            {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    fileNames,
                                }),
                            },
                        );

                    const result =
                        await response.json();

                    if (!response.ok) {
                        throw new Error(
                            result.message ||
                            'Failed to start batch run.',
                        );
                    }

                    const results =
                        Array.isArray(result.results)
                            ? result.results
                            : [];

                    const started =
                        results.filter(
                            (r) => r.runId,
                        );

                    const failedToStart =
                        results.filter(
                            (r) => r.error,
                        );

                    if (failedToStart.length > 0) {

                        showToast(
                            `${failedToStart.length} test başlatılamadı: ${failedToStart
                                .map((r) => r.fileName)
                                .join(', ')}`,
                            'error',
                        );
                    }

                    if (started.length === 0) {

                        runSelectedGeneratedTestsButton.disabled =
                            false;

                        return;
                    }

                    const replayCount =
                        started.filter(
                            (r) => r.mode === 'replay',
                        ).length;

                    const runCount =
                        started.length -
                        replayCount;

                    showToast(
                        `${started.length} test paralel olarak başlatıldı` +
                        (replayCount > 0
                            ? ` (${replayCount} Replay, ${runCount} Run)`
                            : ''),
                        'success',
                    );

                    // Seçim, başlatma sonrası temizlenir — takip artık rozetler üzerinden yapılır.
                    selectedGeneratedTestFiles.clear();

                    trackBatchRuns(started);

                } catch (error) {

                    console.error(error);

                    showToast(
                        error instanceof Error
                            ? error.message
                            : 'Failed to start batch run.',
                        'error',
                    );

                    runSelectedGeneratedTestsButton.disabled =
                        false;
                }
            },
        );
    }


    generatedTestsPreviousPage.addEventListener(
        'click',
        () => {

            if (
                currentPage >
                1
            ) {

                currentPage--;

                renderGeneratedTests();
            }
        },
    );


    generatedTestsNextPage.addEventListener(
        'click',
        () => {

            const visibleTests =
                getVisibleTests();


            const totalPages =
                Math.ceil(
                    visibleTests.length /
                    pageSize,
                );


            if (
                currentPage <
                totalPages
            ) {

                currentPage++;

                renderGeneratedTests();
            }
        },
    );


    generatedTestsCreateButton.addEventListener(
        'click',
        () => {

            navigateTo(
                'create',
            );
        },
    );


    refreshGeneratedTestsButton.addEventListener(
        'click',
        loadGeneratedTests,
    );


    if (clearAllGeneratedTestsButton) {

        clearAllGeneratedTestsButton.addEventListener(
            'click',
            async () => {

                if (allTests.length === 0) {
                    return;
                }

                // Yıkıcı ve TOPLU bir işlem — normal silmeden daha net bir onay metni kullanılıyor.
                const confirmed =
                    confirm(
                        `Delete all ${allTests.length} generated tests? This cannot be undone.`,
                    );

                if (!confirmed) {
                    return;
                }

                clearAllGeneratedTestsButton.disabled =
                    true;

                try {

                    const response =
                        await fetch(
                            '/api/generated-tests',
                            {
                                method: 'DELETE',
                            },
                        );

                    const result =
                        await response.json();

                    if (!response.ok) {
                        throw new Error(
                            result.message ||
                            'Failed to clear generated tests.',
                        );
                    }

                    await loadGeneratedTests();

                } catch (error) {

                    console.error(error);

                    showToast(
                        error instanceof Error
                            ? error.message
                            : 'Failed to clear generated tests.',
                        'error',
                    );

                } finally {

                    clearAllGeneratedTestsButton.disabled =
                        false;
                }
            },
        );
    }


    await loadGeneratedTests();
}


/* =========================================================
   OPEN GENERATED TEST CODE
   ------------------------------------------------------
   v3.26 — bkz. sohbet notu: "generated tests sayfasında yer alan view code kısmına tıklandığı
   zaman başka bir sayfaya yönlendirme olmasın. view code içeriği pop up ekranda görünsün. var
   olan yapıyı kesinlikle bozma". ÖNCEDEN bu fonksiyon kodu appState.pendingGeneratedCode/
   pendingGeneratedFile üzerinden Create Test sayfasına TAŞIYIP oraya navigateTo('create') ile
   YÖNLENDİRİYORDU (bkz. initCreateTestPage() "RESTORE GENERATED CODE" bloğu — o blok BİLEREK
   DOKUNULMADI/SİLİNMEDİ, sadece artık hiç tetiklenmiyor çünkü appState.pendingGeneratedCode bir
   daha hiç doldurulmuyor — "var olan yapıyı bozma" ilkesi gereği eski restore mantığı olduğu gibi
   yerinde duruyor). Artık kod, sayfa DEĞİŞTİRİLMEDEN, showCodePopup() ile aynı sayfanın ÜZERİNDE
   bir pop-up'ta gösteriliyor. Bu fonksiyon HEM Generated Tests sayfasındaki (.viewGeneratedTestButton)
   HEM DE Dashboard'daki ("View Code" — initDashboardPage) çağrı noktaları tarafından PAYLAŞILIR —
   ikisi de artık AYNI şekilde pop-up açar, sayfa değiştirmez.
========================================================= */

async function openGeneratedTestCode(
    fileName,
) {

    try {

        const response =
            await fetch(
                `/api/generated-tests/${encodeURIComponent(fileName)}`,
            );


        const result =
            await response.json();


        if (!response.ok) {

            throw new Error(
                result.message ||
                'Failed to load test code.',
            );
        }


        showCodePopup(
            result.fileName ||
            fileName ||
            'generated-test.spec.ts',
            result.code ||
            '',
        );

    } catch (error) {

        console.error(error);


        showToast(
            error instanceof Error
                ? error.message
                : 'Failed to open test code.',
            'error',
        );
    }
}


/**
 * v3.26 — bkz. openGeneratedTestCode() dosya başı NOT'u. Sayfa fragment'larının (generated-tests.html
 * / dashboard.html) HTML'sine YENİ bir modal EKLEMEK yerine (bu, hangi sayfadan çağrıldığına göre
 * modal'ın DOM'da olup olmadığını garanti etmeyi gerektirirdi — ör. Dashboard'da "View Code"
 * butonuna basıldığında generated-tests.html hiç yüklü değildir), pop-up KENDİ DOM'unu ilk açılışta
 * `document.body`'ye BİR KEZ enjekte eder ve sonraki açılışlarda AYNI elementleri yeniden kullanır
 * — böylece hangi sayfada olursa olsun (Generated Tests, Dashboard, ileride eklenecek başka bir
 * sayfa) çalışması garanti edilir, mevcut sayfa HTML'lerine hiç dokunulmaz.
 */
function ensureCodePopupElements() {

    let overlay =
        document.getElementById(
            'viewCodePopupOverlay',
        );

    if (overlay) {
        return overlay;
    }

    document.body.insertAdjacentHTML(
        'beforeend',
        `
        <div
                id="viewCodePopupOverlay"
                class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
        >
            <div class="bg-surface-container rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] border border-outline-variant flex flex-col">

                <div class="bg-surface-container-high px-md py-sm border-b border-[#334155] flex justify-between items-center gap-2 shrink-0 rounded-t-lg">

                    <div class="flex items-center gap-2 min-w-0">
                        <span class="material-symbols-outlined text-secondary text-[16px]">description</span>
                        <span id="viewCodePopupFileName" class="text-on-surface font-code-md text-code-md truncate">generated-test.spec.ts</span>
                    </div>

                    <div class="flex gap-1 shrink-0">
                        <button
                                id="viewCodePopupCopyButton"
                                type="button"
                                class="text-on-surface-variant hover:text-on-surface hover:bg-surface-variant p-1.5 rounded flex items-center gap-1 font-body-sm"
                        >
                            <span class="material-symbols-outlined text-[16px]">content_copy</span>
                            Copy
                        </button>

                        <button
                                id="viewCodePopupCloseButton"
                                type="button"
                                class="text-on-surface-variant hover:text-on-surface hover:bg-surface-variant p-1.5 rounded flex items-center"
                        >
                            <span class="material-symbols-outlined text-[16px]">close</span>
                        </button>
                    </div>

                </div>

                <div class="flex-1 min-h-0 bg-[#0F172A] p-sm overflow-auto rounded-b-lg">
                    <pre
                            id="viewCodePopupOutput"
                            class="text-[#c7c4d8] whitespace-pre-wrap break-words font-mono text-sm leading-7"
                    >No test generated yet.</pre>
                </div>

            </div>
        </div>
        `,
    );

    overlay =
        document.getElementById(
            'viewCodePopupOverlay',
        );

    const closeButton =
        document.getElementById(
            'viewCodePopupCloseButton',
        );

    const copyButton =
        document.getElementById(
            'viewCodePopupCopyButton',
        );

    function closeCodePopup() {
        overlay.classList.add('hidden');
    }

    // Arka plana (backdrop) tıklamak da kapatır — SADECE tıklamanın hedefi doğrudan overlay'in
    // kendisiyse (içerik kutusuna tıklamak kapatmamalı), diğer modallarla (bkz. addToSuiteModal)
    // AYNI davranış.
    overlay.addEventListener(
        'click',
        (event) => {
            if (event.target === overlay) {
                closeCodePopup();
            }
        },
    );

    closeButton.addEventListener(
        'click',
        closeCodePopup,
    );

    document.addEventListener(
        'keydown',
        (event) => {
            if (
                event.key === 'Escape' &&
                !overlay.classList.contains('hidden')
            ) {
                closeCodePopup();
            }
        },
    );

    copyButton.addEventListener(
        'click',
        async () => {

            const code =
                document
                    .getElementById('viewCodePopupOutput')
                    ?.textContent
                    ?.trim() ||
                '';

            if (!code) {
                showToast(
                    'No code available to copy.',
                    'info',
                );
                return;
            }

            try {

                await navigator
                    .clipboard
                    .writeText(code);

                showToast(
                    'Test code copied to clipboard.',
                    'success',
                );

            } catch (error) {

                console.error(error);

                showToast(
                    'Failed to copy code.',
                    'error',
                );
            }
        },
    );

    return overlay;
}

function showCodePopup(
    fileName,
    code,
) {

    const overlay =
        ensureCodePopupElements();

    document.getElementById(
        'viewCodePopupFileName',
    ).textContent =
        fileName ||
        'generated-test.spec.ts';

    document.getElementById(
        'viewCodePopupOutput',
    ).textContent =
        code ||
        'No code available.';

    overlay.classList.remove(
        'hidden',
    );
}


/* =========================================================
   RUN EXISTING TEST
========================================================= */

async function runExistingTest(
    fileName,
    button = null,
    test = null,
) {

    if (button) {

        button.disabled =
            true;

        button.textContent =
            'Running...';
    }


    // v3.12 — bkz. sohbet notu: "generated testten test koştuğumda create test sayfasında olan
    // panelden yine göreyim istiyorum". ÖNCEDEN bu fetch tamamlanana kadar (test bitene kadar)
    // hiçbir yere navigasyon YOKTU — kullanıcı sonucu SADECE bittiğinde görürdü. Artık isteği
    // BAŞLATIP (await ETMEDEN, arka planda devam etsin diye) HEMEN appState.pendingLiveRun ile
    // Create Test sayfasına geçiyoruz — orası açılışta bunu görüp canlı takibi (bkz.
    // initCreateTestPage "PENDING LIVE RUN" bloğu) başlatıyor. Fetch tamamlanınca (aşağıda) asıl
    // sonuç YİNE aynı appState.pendingTestResult köprüsüyle (mevcut/eski davranışla AYNI) ikinci
    // bir navigateTo('create') ile gösterilir.
    //
    // v3.22 — bkz. sohbet notu: "Run butonuna tıklandığı zaman aynı BDD deki gibi açılan ekranda
    // bilgiler gelsin ve bdd deki bilgiler ile koşum yapılsın". Backend zaten HER ZAMAN bu testin
    // kayıtlı BDD verisiyle (meta.scenario) ve değişkenleriyle çalışıyordu (bkz.
    // LegacyTestService.runGeneratedTest) — ama ekranda bu bilgiler hiç GÖRÜNMÜYORDU (Scenario
    // Definition alanları boş/eski kalıyordu, sadece sağdaki Execution Log paneli açılıyordu).
    // `test` verildiyse (bkz. yukarıdaki .runGeneratedTestButton delegasyonu), BDD butonuyla AYNI
    // anlık görüntüyü (bkz. buildScenarioSnapshotFromTest) appState.pendingLiveRun'a koyuyoruz —
    // initCreateTestPage bunu görünce koşum başlamadan ÖNCE Scenario Definition alanlarını bu
    // testin verileriyle doldurup ONDAN SONRA log paneline geçiyor. `test` yoksa (ör. eski bir
    // çağrı yolu) davranış ESKİSİ GİBİ `true` kalır — initCreateTestPage bu durumda alan doldurma
    // adımını atlar (bkz. o bloktaki tip kontrolü).
    // v3.23 — bkz. sohbet notu: "Run butonuna tıklandığında sadece BDD butonundaki veriler ile
    // otomatik koşum başlasın". ÖNCEDEN bu istek gövdesi HER ZAMAN appState.executionSettings
    // (sayfanın üstündeki GENEL "Execution Settings" araç çubuğu) değerlerini gönderiyordu — bu
    // alanlar zod şemasında opsiyonel OLSA da frontend'in kendisi hep somut bir değer (true/false/
    // 'chromium' vb.) yolladığı için backend'deki `overrides.X ?? meta.X` düşüşü FİİLEN hiç devreye
    // girmiyordu: testin KENDİ kayıtlı (BDD ekranındaki) tarayıcı/headed/screenshot/video/trace
    // ayarları yerine, o an sayfanın üstünde açık duran GENEL ayar sessizce kullanılıyordu — bu da
    // ekranda gösterilen (bkz. buildScenarioSnapshotFromTest → Scenario Definition alanları) ile
    // GERÇEKTE koşulan ayarların BİRBİRİNDEN FARKLI olabilmesine yol açıyordu. `test` verildiyse
    // artık BİLEREK bu genel araç çubuğu YERİNE testin kendi kayıtlı ayarlarını (aynı
    // buildScenarioSnapshotFromTest'in okuduğu alanlar) gönderiyoruz — ekranda görünen ile
    // gerçekte koşulan artık HER ZAMAN birebir aynı. `test` yoksa (ör. eski bir çağrı yolu)
    // davranış ESKİSİ GİBİ genel araç çubuğu ayarlarını kullanır.
    // v3.24 — bkz. sohbet notu: "açılan ekrandaki Test Scenario Instructions kısmındaki kısımda
    // ne yazıyorsa ona göre test koşulmalı. önceki eski veriler baz alınarak koşum yapılmamalıdır".
    // Ekranda o alana YAZILAN metin, buildScenarioSnapshotFromTest ile AYNI kaynaktan
    // (test.bddDescription) geliyor — burada da BİREBİR AYNI değeri `scenario` override'ı olarak
    // gönderiyoruz (bkz. LegacyRunExistingOverrides.scenario / LegacyTestService.runGeneratedTest
    // dosya başı açıklamaları) ki backend ARTIK testin İLK üretildiği andaki sabit/"eski"
    // meta.scenario'yu DEĞİL, ekranda gösterilenle AYNI metni koştursun. Henüz hiç bddDescription
    // üretilmemiş bir kayıtta (ör. daha önce hiç başarıyla tamamlanmamış bir test) bu boş olur —
    // bu durumda override GÖNDERİLMEZ, backend kendi eski davranışıyla meta.scenario'ya düşer.
    const runOverrides = test
        ? {
              headed: Boolean(test.headed),
              browser: test.browser || 'chromium',
              screenshot: Boolean(test.screenshot),
              video: Boolean(test.video),
              trace: Boolean(test.trace),
              useSeleniumGrid: Boolean(test.useSeleniumGrid),
              ...(test.bddDescription ? { scenario: test.bddDescription } : {}),
          }
        : {
              headed: appState.executionSettings.headed,
              browser: appState.executionSettings.browser,
              screenshot: appState.executionSettings.screenshot,
              video: appState.executionSettings.video,
              trace: appState.executionSettings.trace,
          };

    const resultPromise =
        fetch(
            '/api/generated-tests/run',
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json',
                },

                body:
                    JSON.stringify({
                        fileName,
                        ...runOverrides,
                    }),
            },
        );


    appState.pendingLiveRun =
        test
            ? buildScenarioSnapshotFromTest(test)
            : true;

    await navigateTo(
        'create',
    );


    try {

        const response =
            await resultPromise;


        const result =
            await response.json();


        const duration =
            Number(
                result.duration ||
                0,
            ).toFixed(2);


        appState.pendingTestResult = {
            result,

            browser:
            appState
                .executionSettings
                .browser,

            duration,
        };


        await navigateTo(
            'create',
        );

    } catch (error) {

        console.error(error);


        showToast(
            error instanceof Error
                ? error.message
                : 'Failed to run test.',
            'error',
        );

    } finally {

        if (button) {

            button.disabled =
                false;

            button.textContent =
                'Run';
        }
    }
}


/* =========================================================
   REPLAY EXISTING TEST (No AI — bkz. backend LegacyTestService.replayGeneratedTest()
   dosya başı açıklaması). Bu, runExistingTest() ile NEREDEYSE AYNIDIR — kasıtlı olarak
   ayrı bir fonksiyon: farklı bir endpoint'e istek atar ve backend'in "replay verisi yok" /
   "zaten aktif bir koşum var" gibi durumlarda döndürdüğü status:'failed' sonucu da (AI
   modunda olduğu gibi) doğrudan sonuç ekranında gösterir — ayrı bir hata akışına gerek yok.
========================================================= */

async function replayExistingTest(
    fileName,
    button = null,
) {

    if (button) {

        button.disabled =
            true;

        button.textContent =
            'Replaying...';
    }


    // v3.12 — bkz. runExistingTest() dosya başı NOT'u — AYNI "önce navigate, sonuç ikinci
    // navigasyonla gelir" deseni, burada da geçerli.
    const resultPromise =
        fetch(
            '/api/generated-tests/replay',
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json',
                },

                body:
                    JSON.stringify({
                        fileName,

                        headed:
                        appState
                            .executionSettings
                            .headed,

                        browser:
                        appState
                            .executionSettings
                            .browser,

                        screenshot:
                        appState
                            .executionSettings
                            .screenshot,

                        video:
                        appState
                            .executionSettings
                            .video,

                        trace:
                        appState
                            .executionSettings
                            .trace,
                    }),
            },
        );


    appState.pendingLiveRun =
        true;

    await navigateTo(
        'create',
    );


    try {

        const response =
            await resultPromise;


        const result =
            await response.json();


        const duration =
            Number(
                result.duration ||
                0,
            ).toFixed(2);


        appState.pendingTestResult = {
            result,

            browser:
            appState
                .executionSettings
                .browser,

            duration,
        };


        await navigateTo(
            'create',
        );

    } catch (error) {

        console.error(error);


        showToast(
            error instanceof Error
                ? error.message
                : 'Failed to replay test.',
            'error',
        );

    } finally {

        if (button) {

            button.disabled =
                false;

            button.textContent =
                'Replay (No AI)';
        }
    }
}


/* =========================================================
   RENAME GENERATED TEST ("senaryo ismi")
   ------------------------------------------------------
   Sadece görüntülenen ismi değiştirir (bkz. backend LegacyGeneratedTestMeta.displayName dosya
   başı açıklaması) — diskteki .spec.ts dosyasının gerçek adı DEĞİŞMEZ, bu yüzden Test Runs
   geçmişi/Run/Delete gibi diğer aksiyonlar etkilenmez. Native prompt() kullanılıyor — bu
   sayfadaki diğer aksiyonlarla (ör. Delete'in confirm()'ü) aynı, basit/bloklayan desen.
========================================================= */

async function renameGeneratedTest(
    fileName,
    currentName,
) {

    const nextName =
        await promptUsername(
            'Bu test için bir isim girin (boş bırakırsan otomatik oluşturulan dosya adı gösterilir):',
            'Test İsmi',
            currentName
        );

    // Kullanıcı iptal ettiyse (Cancel/Esc) prompt() null döner — hiçbir şey yapma. Boş string
    // (kutuyu temizleyip OK'e basmak) GEÇERLİ bir istek: özel ismi kaldırır.
    if (nextName === null) {
        return;
    }

    if (nextName.trim() === currentName.trim()) {
        return;
    }

    try {

        const response =
            await fetch(
                `/api/generated-tests/${encodeURIComponent(fileName)}/name`,
                {
                    method: 'PATCH',

                    headers: {
                        'Content-Type':
                            'application/json',
                    },

                    body:
                        JSON.stringify({
                            displayName: nextName,
                        }),
                },
            );

        const result =
            await response.json();

        if (!response.ok) {
            throw new Error(
                result.message ||
                'Failed to rename test.',
            );
        }

        showToast(
            'Test renamed.',
            'success',
        );

        await loadGeneratedTests();

    } catch (error) {

        console.error(error);

        showToast(
            error instanceof Error
                ? error.message
                : 'Failed to rename test.',
            'error',
        );
    }
}


/* =========================================================
   REPORTS
========================================================= */

async function initReportsPage() {

    const refreshReportsButton =
        document.getElementById(
            'refreshReportsButton',
        );

    const reportTotalRuns =
        document.getElementById(
            'reportTotalRuns',
        );

    const reportPassed =
        document.getElementById(
            'reportPassed',
        );

    const reportFailed =
        document.getElementById(
            'reportFailed',
        );

    const reportSuccessRate =
        document.getElementById(
            'reportSuccessRate',
        );


    const reportChromium =
        document.getElementById(
            'reportChromium',
        );

    const reportFirefox =
        document.getElementById(
            'reportFirefox',
        );

    const reportWebkit =
        document.getElementById(
            'reportWebkit',
        );


    const reportChromiumPercentage =
        document.getElementById(
            'reportChromiumPercentage',
        );

    const reportFirefoxPercentage =
        document.getElementById(
            'reportFirefoxPercentage',
        );

    const reportWebkitPercentage =
        document.getElementById(
            'reportWebkitPercentage',
        );


    const reportChromiumBar =
        document.getElementById(
            'reportChromiumBar',
        );

    const reportFirefoxBar =
        document.getElementById(
            'reportFirefoxBar',
        );

    const reportWebkitBar =
        document.getElementById(
            'reportWebkitBar',
        );


    const historicalPerformanceChart =
        document.getElementById(
            'historicalPerformanceChart',
        );

    const historicalPerformanceLabels =
        document.getElementById(
            'historicalPerformanceLabels',
        );

    const historicalPerformanceEmpty =
        document.getElementById(
            'historicalPerformanceEmpty',
        );


    const recentActivityList =
        document.getElementById(
            'recentActivityList',
        );

    const recentActivityEmpty =
        document.getElementById(
            'recentActivityEmpty',
        );


    const generateAllureButton =
        document.getElementById(
            'generateAllureButton',
        );

    const openAllureButton =
        document.getElementById(
            'openAllureButton',
        );

    const allureReportStatus =
        document.getElementById(
            'allureReportStatus',
        );


    function updateBrowserDistribution(
        runs,
    ) {

        const total =
            runs.length;


        const chromium =
            runs.filter(
                (run) =>
                    run.browser ===
                    'chromium',
            ).length;


        const firefox =
            runs.filter(
                (run) =>
                    run.browser ===
                    'firefox',
            ).length;


        const webkit =
            runs.filter(
                (run) =>
                    run.browser ===
                    'webkit',
            ).length;


        const chromiumPercentage =
            total > 0
                ? (
                    chromium /
                    total *
                    100
                ).toFixed(1)
                : '0.0';


        const firefoxPercentage =
            total > 0
                ? (
                    firefox /
                    total *
                    100
                ).toFixed(1)
                : '0.0';


        const webkitPercentage =
            total > 0
                ? (
                    webkit /
                    total *
                    100
                ).toFixed(1)
                : '0.0';


        reportChromium.textContent =
            `${chromium} runs`;

        reportFirefox.textContent =
            `${firefox} runs`;

        reportWebkit.textContent =
            `${webkit} runs`;


        reportChromiumPercentage.textContent =
            `${chromiumPercentage}%`;

        reportFirefoxPercentage.textContent =
            `${firefoxPercentage}%`;

        reportWebkitPercentage.textContent =
            `${webkitPercentage}%`;


        reportChromiumBar.style.width =
            `${chromiumPercentage}%`;

        reportFirefoxBar.style.width =
            `${firefoxPercentage}%`;

        reportWebkitBar.style.width =
            `${webkitPercentage}%`;
    }


    function renderHistoricalPerformance(
        runs,
    ) {

        const today =
            new Date();


        const lastSevenDays =
            [];


        for (
            let index = 6;
            index >= 0;
            index--
        ) {

            const date =
                new Date(
                    today,
                );


            date.setHours(
                0,
                0,
                0,
                0,
            );


            date.setDate(
                date.getDate() -
                index,
            );


            const nextDate =
                new Date(
                    date,
                );


            nextDate.setDate(
                nextDate.getDate() +
                1,
            );


            const dayRuns =
                runs.filter((run) => {

                    if (
                        !run.createdAt
                    ) {
                        return false;
                    }


                    const runDate =
                        new Date(
                            run.createdAt,
                        );


                    return (
                        runDate >= date &&
                        runDate < nextDate
                    );
                });


            const passed =
                dayRuns.filter(
                    (run) =>
                        run.status ===
                        'passed',
                ).length;


            const failed =
                dayRuns.filter(
                    (run) =>
                        run.status ===
                        'failed',
                ).length;


            const total =
                passed +
                failed;


            const passPercentage =
                total > 0
                    ? passed /
                    total *
                    100
                    : 0;


            const failPercentage =
                total > 0
                    ? failed /
                    total *
                    100
                    : 0;


            lastSevenDays.push({
                date,
                passed,
                failed,
                total,
                passPercentage,
                failPercentage,
            });
        }


        const hasData =
            lastSevenDays.some(
                (day) =>
                    day.total >
                    0,
            );


        if (!hasData) {

            historicalPerformanceChart.innerHTML =
                '';

            historicalPerformanceLabels.innerHTML =
                '';

            historicalPerformanceChart.classList.add(
                'hidden',
            );

            historicalPerformanceLabels.classList.add(
                'hidden',
            );

            historicalPerformanceEmpty.classList.remove(
                'hidden',
            );

            return;
        }


        historicalPerformanceEmpty.classList.add(
            'hidden',
        );

        historicalPerformanceChart.classList.remove(
            'hidden',
        );

        historicalPerformanceLabels.classList.remove(
            'hidden',
        );


        historicalPerformanceChart.innerHTML =
            lastSevenDays
                .map((day) => {

                    const passHeight =
                        day.total > 0

                            ? Math.max(
                                day.passPercentage,
                                day.passed > 0
                                    ? 5
                                    : 0,
                            )

                            : 0;


                    const failHeight =
                        day.total > 0

                            ? Math.max(
                                day.failPercentage,
                                day.failed > 0
                                    ? 5
                                    : 0,
                            )

                            : 0;


                    return `
                        <div
                            class="
                                flex-1
                                h-full
                                flex
                                flex-col
                                justify-end
                                group
                                relative
                            "
                        >

                            <div
                                class="
                                    w-full
                                    h-full
                                    bg-surface-variant
                                    rounded-t-sm
                                    overflow-hidden
                                    flex
                                    flex-col
                                    justify-end
                                "
                            >

                                <div
                                    class="
                                        w-full
                                        bg-error
                                    "
                                    style="
                                        height:
                                        ${failHeight}%;
                                    "
                                ></div>


                                <div
                                    class="
                                        w-full
                                        bg-secondary
                                    "
                                    style="
                                        height:
                                        ${passHeight}%;
                                    "
                                ></div>

                            </div>


                            <div
                                class="
                                    absolute
                                    bottom-full
                                    left-1/2
                                    -translate-x-1/2
                                    mb-2
                                    hidden
                                    group-hover:block
                                    bg-surface-container-highest
                                    border
                                    border-outline-variant
                                    text-xs
                                    px-2
                                    py-1
                                    rounded
                                    whitespace-nowrap
                                    z-10
                                "
                            >
                                Passed: ${day.passed}
                                · Failed: ${day.failed}
                            </div>

                        </div>
                    `;
                })
                .join('');


        historicalPerformanceLabels.innerHTML =
            lastSevenDays
                .map((day) => {

                    const label =
                        day.date
                            .toLocaleDateString(
                                'en-US',
                                {
                                    weekday:
                                        'short',
                                },
                            );


                    return `
                        <span>
                            ${label}
                        </span>
                    `;
                })
                .join('');
    }


    function renderRecentActivity(
        runs,
    ) {

        const recentRuns =
            [...runs]
                .sort(
                    (
                        firstRun,
                        secondRun,
                    ) =>
                        new Date(
                            secondRun.createdAt ||
                            0,
                        ) -
                        new Date(
                            firstRun.createdAt ||
                            0,
                        ),
                )
                .slice(
                    0,
                    6,
                );


        if (
            recentRuns.length ===
            0
        ) {

            recentActivityList.innerHTML =
                '';

            recentActivityEmpty.classList.remove(
                'hidden',
            );

            return;
        }


        recentActivityEmpty.classList.add(
            'hidden',
        );


        recentActivityList.innerHTML =
            recentRuns
                .map((run) => {

                    const passed =
                        run.status ===
                        'passed';


                    const statusIcon =
                        passed
                            ? 'check_circle'
                            : 'cancel';


                    const statusClass =
                        passed
                            ? 'text-secondary'
                            : 'text-error';


                    const badgeClass =
                        passed
                            ? 'text-secondary bg-secondary/10'
                            : 'text-error bg-error/10';


                    const executedDate =
                        run.createdAt

                            ? new Date(
                                run.createdAt,
                            ).toLocaleString(
                                'tr-TR',
                            )

                            : '-';


                    return `
                        <div
                            class="
                                p-md
                                hover:bg-surface-variant/30
                                transition-colors
                                flex
                                gap-3
                                border-b
                                border-outline-variant/50
                            "
                        >

                            <div class="mt-1">

                                <span
                                    class="
                                        material-symbols-outlined
                                        ${statusClass}
                                    "
                                >
                                    ${statusIcon}
                                </span>

                            </div>


                            <div
                                class="
                                    min-w-0
                                "
                            >

                                <div
                                    class="
                                        font-code-md
                                        text-code-md
                                        text-on-surface
                                        mb-1
                                        truncate
                                    "
                                >
                                    ${
                        run.testFile ||
                        '-'
                    }
                                </div>


                                <div
                                    class="
                                        font-body-sm
                                        text-body-sm
                                        text-on-surface-variant
                                        flex
                                        gap-2
                                        items-center
                                        flex-wrap
                                    "
                                >

                                    <span>
                                        ${executedDate}
                                    </span>


                                    <span
                                        class="
                                            ${badgeClass}
                                            px-1.5
                                            rounded-sm
                                        "
                                    >
                                        ${
                        run.status ||
                        '-'
                    }
                                    </span>

                                </div>

                            </div>

                        </div>
                    `;
                })
                .join('');
    }


    async function loadReports() {

        refreshReportsButton.disabled =
            true;


        try {

            const response =
                await fetch(
                    '/api/test-runs',
                );


            const result =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    result.message ||
                    'Report data could not be loaded.',
                );
            }


            const runs =
                Array.isArray(
                    result.runs,
                )
                    ? result.runs
                    : [];


            const total =
                runs.length;


            const passed =
                runs.filter(
                    (run) =>
                        run.status ===
                        'passed',
                ).length;


            const failed =
                runs.filter(
                    (run) =>
                        run.status ===
                        'failed',
                ).length;


            const successRate =
                total > 0

                    ? (
                        passed /
                        total *
                        100
                    ).toFixed(1)

                    : '0.0';


            reportTotalRuns.textContent =
                total;

            reportPassed.textContent =
                passed;

            reportFailed.textContent =
                failed;

            reportSuccessRate.textContent =
                `${successRate}%`;


            updateBrowserDistribution(
                runs,
            );


            renderHistoricalPerformance(
                runs,
            );


            renderRecentActivity(
                runs,
            );

        } catch (error) {

            console.error(
                'Failed to load reports:',
                error,
            );


            reportTotalRuns.textContent =
                '0';

            reportPassed.textContent =
                '0';

            reportFailed.textContent =
                '0';

            reportSuccessRate.textContent =
                '0%';


            recentActivityList.innerHTML =
                '';

            recentActivityEmpty.classList.remove(
                'hidden',
            );


            allureReportStatus.textContent =
                error instanceof Error
                    ? error.message
                    : String(error);


            allureReportStatus.className =
                'font-body-sm text-body-sm text-error mt-4';

        } finally {

            refreshReportsButton.disabled =
                false;
        }
    }


    refreshReportsButton.addEventListener(
        'click',
        loadReports,
    );


    /* =========================================================
       ALLURE REPORT
       ---------------------------------------------------------
       "Generate Report" backend'e (bkz. AllureReportService) her koşum sonunda biriken
       allure-results klasöründen statik bir HTML raporu ürettirir; "Open Last Report" o raporu
       yeni bir sekmede açar. openAllureButton, henüz hiç rapor üretilmemişken 404'lük boş bir
       sekme açmasın diye /api/allure/status ile gerçek durumu öğrenene kadar disabled kalır.
    ========================================================= */

    async function refreshAllureButtonsState() {

        try {

            const response =
                await fetch('/api/allure/status');

            const data =
                await response.json();

            openAllureButton.disabled =
                !data.hasReport;

        } catch (error) {

            console.error(
                'Failed to check Allure report status:',
                error,
            );

            // Sunucudan durum öğrenilemedi — güvenli taraf: butonu disabled bırak (mevcut hâli
            // zaten disabled olduğu için burada ekstra bir şey yapmaya gerek yok).
        }
    }


    generateAllureButton.addEventListener(
        'click',
        async () => {

            generateAllureButton.disabled =
                true;

            allureReportStatus.textContent =
                'Generating Allure report...';

            allureReportStatus.className =
                'font-body-sm text-body-sm text-on-surface-variant mt-4';

            try {

                const response =
                    await fetch(
                        '/api/allure/generate',
                        { method: 'POST' },
                    );

                const data =
                    await response.json();

                allureReportStatus.textContent =
                    data.message;

                allureReportStatus.className =
                    `font-body-sm text-body-sm mt-4 ${data.ok ? 'text-secondary' : 'text-error'}`;

                showToast(
                    data.message,
                    data.ok ? 'success' : 'error',
                );

                await refreshAllureButtonsState();

            } catch (error) {

                const message =
                    error instanceof Error
                        ? error.message
                        : 'Allure report could not be generated.';

                allureReportStatus.textContent =
                    message;

                allureReportStatus.className =
                    'font-body-sm text-body-sm text-error mt-4';

                showToast(message, 'error');

            } finally {

                generateAllureButton.disabled =
                    false;
            }
        },
    );


    openAllureButton.addEventListener(
        'click',
        () => {
            window.open('/allure-report/index.html', '_blank');
        },
    );


    await refreshAllureButtonsState();
    await loadReports();
}


/* =========================================================
   ADMIN PANEL
   ------------------------------------------------------
   v3.0 Faz 1 — Project CRUD. Henüz kimlik doğrulama/rol kontrolü YOK (Faz 2'de eklenecek).
   "New Project" ve "Edit" AYNI modalı kullanır (adminProjectModal) — Edit'te form mevcut proje
   değerleriyle doldurulur, Save PATCH ile TÜM alanları birlikte gönderir (bkz. backend
   adminProjects.ts dosya başı NOT — bu klasik "sadece değişen alan" PATCH'i DEĞİLDİR).
========================================================= */

/* -----------------------------------------------------
   PROJECT MEMBERS PAGE'E GEÇİŞ (v3.1) — "Members" butonuna
   basılınca çağrılır (bkz. wireProjectRowButtons() aşağıda).
   navigateTo()'nun kendisi parametre taşımadığı için,
   testpilot.pendingSuggestion ile AYNI desen: proje id+name
   TEK SEFERLİK sessionStorage'a yazılır, initProjectMembersPage()
   içinde okunup hemen silinir (bkz. o fonksiyon).
----------------------------------------------------- */
function goToProjectMembersPage(project) {
    try {
        window.sessionStorage.setItem(
            'testpilot.pendingProjectMembers',
            JSON.stringify({ id: project.id, name: project.name }),
        );
    } catch (error) {
        console.error(error);
    }
    void navigateTo('projectMembers');
}


async function initAdminPanelPage() {

    // v3.0 Faz 2 — LOGIN GATE elemanları. #adminLoginSection / #adminPanelContent görünürlüğü
    // showLoginGate()/showPanelContent() ile toggle edilir (bkz. dosya sonundaki auth akışı).
    const loginSection = document.getElementById('adminLoginSection');
    const panelContent = document.getElementById('adminPanelContent');
    const loginForm = document.getElementById('adminLoginForm');
    const loginUsernameInput = document.getElementById('adminLoginUsername');
    const loginPasswordInput = document.getElementById('adminLoginPassword');
    const loginError = document.getElementById('adminLoginError');
    const loginSubmitButton = document.getElementById('adminLoginSubmitButton');
    const loggedInAsLabel = document.getElementById('adminLoggedInAs');
    const logoutButton = document.getElementById('adminLogoutButton');

    const tableBody = document.getElementById('adminProjectsTableBody');
    const emptyState = document.getElementById('adminProjectsEmptyState');
    const loadingState = document.getElementById('adminProjectsLoadingState');
    const oracleWarning = document.getElementById('adminOracleNotConfigured');

    const newProjectButton = document.getElementById('newProjectButton');
    const refreshButton = document.getElementById('refreshProjectsButton');

    // v3.0 Faz 2.2/2.3 — TABS (Projects | Users | LDAP) elemanları.
    const tabProjectsButton = document.getElementById('adminTabProjectsButton');
    const tabUsersButton = document.getElementById('adminTabUsersButton');
    const tabLdapButton = document.getElementById('adminTabLdapButton');
    const projectsSection = document.getElementById('adminProjectsSection');
    const usersSection = document.getElementById('adminUsersSection');
    const ldapSection = document.getElementById('adminLdapSection');

    const usersTableBody = document.getElementById('adminUsersTableBody');
    const usersEmptyState = document.getElementById('adminUsersEmptyState');
    const usersLoadingState = document.getElementById('adminUsersLoadingState');
    const refreshUsersButton = document.getElementById('refreshUsersButton');

    // v3.0 Faz 5.1 — "Add User" modalı (bkz. aşağıdaki openUserModal/userForm submit).
    const newUserButton = document.getElementById('newUserButton');
    const userModal = document.getElementById('adminUserModal');
    const closeUserModalButton = document.getElementById('closeAdminUserModal');
    const cancelUserModalButton = document.getElementById('cancelAdminUserModal');
    const userForm = document.getElementById('adminUserForm');
    const userFormError = document.getElementById('adminUserFormError');
    const saveUserButton = document.getElementById('saveAdminUserButton');
    const userUsernameInput = document.getElementById('adminUserUsername');
    const userDisplayNameInput = document.getElementById('adminUserDisplayName');
    const userPasswordInput = document.getElementById('adminUserPassword');
    const userRoleSelect = document.getElementById('adminUserRole');

    // v3.0 Faz 2.3 — LDAP ayarları formu elemanları.
    const ldapForm = document.getElementById('adminLdapForm');
    const ldapUrlInput = document.getElementById('adminLdapUrl');
    const ldapBaseDnInput = document.getElementById('adminLdapBaseDn');
    const ldapManagerDnInput = document.getElementById('adminLdapManagerDn');
    const ldapManagerPasswordInput = document.getElementById('adminLdapManagerPassword');
    const ldapManagerPasswordHint = document.getElementById('adminLdapManagerPasswordHint');
    const ldapUserDnPatternInput = document.getElementById('adminLdapUserDnPattern');
    const ldapUserSearchFilterInput = document.getElementById('adminLdapUserSearchFilter');
    const ldapGroupSearchBaseInput = document.getElementById('adminLdapGroupSearchBase');
    const ldapGroupSearchFilterInput = document.getElementById('adminLdapGroupSearchFilter');
    const ldapPasswordEncoderSelect = document.getElementById('adminLdapPasswordEncoderType');
    const ldapFormError = document.getElementById('adminLdapFormError');
    const ldapFormSuccess = document.getElementById('adminLdapFormSuccess');
    const saveLdapButton = document.getElementById('saveAdminLdapButton');

    // v3.0 Faz 5 — sekmelerin ÜSTÜNDE her zaman görünen, tek/global Grid URL alanı elemanları.
    const globalGridUrlInput = document.getElementById('adminGlobalGridUrl');
    const saveGlobalGridUrlButton = document.getElementById('saveAdminGlobalGridUrlButton');
    const globalGridUrlError = document.getElementById('adminGlobalGridUrlError');
    const globalGridUrlSavedBadge = document.getElementById('adminGlobalGridUrlSavedBadge');

    // v3.1 — Grid URL ile AYNI desen: sekmelerin ÜSTÜNDE her zaman görünen "Delete Old Runs" bakım
    // aracı elemanları (bkz. sohbet notu: "admin panelden eski koşumları şu tarihten itibaren
    // sil"). v3.1.1 — tarih SEÇMEK yerine (bkz. sohbet notu: "default olarak 15 gün falan gibi
    // yapalım tarih girmeyelim") gün SAYISI giriliyor (bkz. aşağıdaki handler).
    const deleteOldRunsDaysInput = document.getElementById('adminDeleteOldRunsDays');
    const deleteOldRunsButton = document.getElementById('adminDeleteOldRunsButton');

    let currentUserId = null; // giriş yapmış kullanıcının id'si — kendi kendini düşürme engeli için (bkz. showPanelContent).
    let usersLoadedOnce = false;
    let ldapLoadedOnce = false;

    const modal = document.getElementById('adminProjectModal');
    const modalTitle = document.getElementById('adminProjectModalTitle');
    const closeModalButton = document.getElementById('closeAdminProjectModal');
    const cancelModalButton = document.getElementById('cancelAdminProjectModal');
    const form = document.getElementById('adminProjectForm');
    const formError = document.getElementById('adminProjectFormError');
    const saveButton = document.getElementById('saveAdminProjectButton');

    const idInput = document.getElementById('adminProjectId');
    const nameInput = document.getElementById('adminProjectName');
    const maxParallelInput = document.getElementById('adminProjectMaxParallel');
    const llmModelInput = document.getElementById('adminProjectLlmModel');

    // Bu sayfaya özel, küçük bir tarih biçimlendirici — formatDate() diğer sayfaların kendi
    // closure'ları içinde tanımlı (ör. Generated Tests), global değil, bu yüzden burada ayrıca
    // (kasıtlı olarak minimal) bir kopyası var.
    function formatAdminDate(value) {
        if (!value) {
            return '-';
        }
        try {
            return new Date(value).toLocaleString('tr-TR');
        } catch (error) {
            return '-';
        }
    }

    let currentProjects = [];

    function openProjectModal(project) {

        formError.classList.add('hidden');
        formError.textContent = '';

        if (project) {
            modalTitle.textContent = 'Edit Project';
            idInput.value = String(project.id);
            nameInput.value = project.name || '';
            maxParallelInput.value = project.maxParallelRuns ?? '';
            llmModelInput.value = project.llmModel || '';
        } else {
            modalTitle.textContent = 'New Project';
            form.reset();
            idInput.value = '';
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
        nameInput.focus();
    }

    function closeProjectModal() {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    function renderAdminProjectsTable(projects) {

        currentProjects = projects;

        if (!projects.length) {
            tableBody.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');

        tableBody.innerHTML = projects.map((project) => `
            <tr class="hover:bg-surface-container-low/50 transition-colors">
                <td class="py-sm px-md">
                    <span class="font-body-md text-on-surface font-semibold">
                        ${escapeHtml(project.name)}
                    </span>
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${project.maxParallelRuns !== null && project.maxParallelRuns !== undefined ? project.maxParallelRuns : '<span class="text-on-surface-variant/50">—</span>'}
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${project.llmModel ? escapeHtml(project.llmModel) : '<span class="text-on-surface-variant/50">—</span>'}
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${formatAdminDate(project.createdAt)}
                </td>
                <td class="py-sm px-md text-right">
                    <div class="flex justify-end gap-sm">
                        <button
                                class="membersProjectButton
                                       inline-flex items-center justify-center
                                       text-on-surface-variant hover:text-on-surface
                                       p-[6px] rounded-lg
                                       border border-outline-variant
                                       transition-colors"
                                data-id="${project.id}"
                                title="Members"
                                aria-label="Manage members of ${escapeHtml(project.name)}"
                                type="button"
                        >
                            <span class="material-symbols-outlined text-[16px]">group</span>
                        </button>

                        <button
                                class="editProjectButton
                                       inline-flex items-center justify-center
                                       text-on-surface-variant hover:text-on-surface
                                       p-[6px] rounded-lg
                                       border border-outline-variant
                                       transition-colors"
                                data-id="${project.id}"
                                title="Edit"
                                aria-label="Edit ${escapeHtml(project.name)}"
                                type="button"
                        >
                            <span class="material-symbols-outlined text-[16px]">edit</span>
                        </button>

                        <button
                                class="deleteProjectButton
                                       inline-flex items-center justify-center
                                       text-on-surface-variant hover:text-error
                                       hover:bg-error/10
                                       p-[6px] rounded-lg
                                       border border-outline-variant
                                       hover:border-error/40
                                       transition-colors"
                                data-id="${project.id}"
                                title="Delete"
                                aria-label="Delete ${escapeHtml(project.name)}"
                                type="button"
                        >
                            <span class="material-symbols-outlined text-[16px]">delete</span>
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');

        wireProjectRowButtons();
    }

    function wireProjectRowButtons() {

        document.querySelectorAll('.membersProjectButton').forEach((button) => {
            button.addEventListener('click', () => {
                const id = Number(button.getAttribute('data-id'));
                const project = currentProjects.find((p) => p.id === id);
                if (project) {
                    goToProjectMembersPage(project);
                }
            });
        });

        document.querySelectorAll('.editProjectButton').forEach((button) => {
            button.addEventListener('click', () => {
                const id = Number(button.getAttribute('data-id'));
                const project = currentProjects.find((p) => p.id === id);
                if (project) {
                    openProjectModal(project);
                }
            });
        });

        document.querySelectorAll('.deleteProjectButton').forEach((button) => {
            button.addEventListener('click', async () => {

                const id = button.getAttribute('data-id');
                const project = currentProjects.find((p) => String(p.id) === id);
                const name = project ? project.name : 'this project';

                const confirmed = confirm(`Delete project "${name}"? This cannot be undone.`);
                if (!confirmed) {
                    return;
                }

                button.disabled = true;

                try {
                    const response = await fetch(`/api/admin/projects/${id}`, { method: 'DELETE' });

                    if (!response.ok) {
                        const result = await response.json().catch(() => ({}));
                        throw new Error(result.error?.message || 'Failed to delete project.');
                    }

                    showToast('Project deleted.', 'success');
                    await loadAdminProjects();

                } catch (error) {
                    console.error(error);
                    showToast(error instanceof Error ? error.message : 'Failed to delete project.', 'error');
                    button.disabled = false;
                }
            });
        });
    }

    async function loadAdminProjects() {

        loadingState.classList.remove('hidden');
        tableBody.innerHTML = '';
        emptyState.classList.add('hidden');
        oracleWarning.classList.add('hidden');

        try {
            const response = await fetch('/api/admin/projects');

            if (response.status === 503) {
                oracleWarning.classList.remove('hidden');
                return;
            }

            // Oturum süresi dolmuş/cookie geçersiz — sessizce hata göstermek yerine kullanıcıyı
            // giriş ekranına geri döndürüyoruz (bkz. showLoginGate() dosya sonunda).
            if (response.status === 401) {
                showLoginGate();
                return;
            }

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to load projects.');
            }

            renderAdminProjectsTable(result.projects || []);

        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to load projects.', 'error');
        } finally {
            loadingState.classList.add('hidden');
        }
    }

    newProjectButton.addEventListener('click', () => openProjectModal(null));
    refreshButton.addEventListener('click', () => loadAdminProjects());
    closeModalButton.addEventListener('click', closeProjectModal);
    cancelModalButton.addEventListener('click', closeProjectModal);

    form.addEventListener('submit', async (event) => {

        event.preventDefault();

        formError.classList.add('hidden');
        formError.textContent = '';

        const id = idInput.value.trim();

        const payload = {
            name: nameInput.value.trim(),
            maxParallelRuns: maxParallelInput.value.trim() ? Number(maxParallelInput.value) : undefined,
            llmModel: llmModelInput.value.trim(),
        };

        saveButton.disabled = true;

        try {
            const response = await fetch(
                id ? `/api/admin/projects/${id}` : '/api/admin/projects',
                {
                    method: id ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
            );

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to save project.');
            }

            showToast(id ? 'Project updated.' : 'Project created.', 'success');
            closeProjectModal();
            await loadAdminProjects();

        } catch (error) {
            console.error(error);
            formError.textContent = error instanceof Error ? error.message : 'Failed to save project.';
            formError.classList.remove('hidden');
        } finally {
            saveButton.disabled = false;
        }
    });


    /* -----------------------------------------------------
       LOGIN GATE — v3.0 Faz 2. Sayfa ilk yüklendiğinde
       GET /api/auth/me ile mevcut oturum kontrol edilir;
       yoksa/süresi geçmişse SADECE login formu gösterilir,
       varsa proje içeriği yüklenir. Login/logout SAYFAYI
       YENİDEN YÜKLEMEZ — sadece iki bölümün görünürlüğünü
       toggler (bkz. showLoginGate()/showPanelContent()).
    ----------------------------------------------------- */

    function showLoginGate() {
        panelContent.classList.add('hidden');
        panelContent.classList.remove('flex');
        loginSection.classList.remove('hidden');
        loginSection.classList.add('flex');
        loginPasswordInput.value = '';
    }

    function showPanelContent(user) {
        loginSection.classList.add('hidden');
        loginSection.classList.remove('flex');
        panelContent.classList.remove('hidden');
        panelContent.classList.add('flex');

        if (user) {
            currentUserId = user.id;

            if (loggedInAsLabel) {
                loggedInAsLabel.textContent = `Signed in as ${user.username}`;
                loggedInAsLabel.classList.remove('hidden');
            }
        }
    }

    loginForm.addEventListener('submit', async (event) => {

        event.preventDefault();

        loginError.classList.add('hidden');
        loginError.textContent = '';
        loginSubmitButton.disabled = true;

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: loginUsernameInput.value.trim(),
                    password: loginPasswordInput.value,
                }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Sign in failed.');
            }

            showPanelContent(result.user);
            await loadAdminProjects();

        } catch (error) {
            console.error(error);
            loginError.textContent = error instanceof Error ? error.message : 'Sign in failed.';
            loginError.classList.remove('hidden');
        } finally {
            loginSubmitButton.disabled = false;
        }
    });

    logoutButton.addEventListener('click', async () => {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch (error) {
            console.error(error);
        }
        loginUsernameInput.value = '';
        // v3.0 Faz 5.2 — global nav/sidebar durumunu da sıfırla (bkz. app.js applyLoggedInUser) —
        // aksi halde bir sonraki (farklı bir kullanıcıyla) girişe kadar eski admin bilgisi sidebar'da
        // kalabilir.
        if (typeof applyLoggedInUser === 'function') {
            applyLoggedInUser(null);
        }
        // Site geneli login gate'i göster (bkz. index.html #appLoginGate) — Admin Panel'in KENDİ
        // login formunu değil, çünkü artık logout TÜM uygulamadan çıkış anlamına geliyor (v3.0
        // Faz 2.1), sadece admin panelden değil.
        if (typeof showAppLoginGate === 'function') {
            showAppLoginGate();
        } else {
            showLoginGate();
        }
    });

    /* -----------------------------------------------------
       USERS TAB — v3.0 Faz 2.2. Liste sadece sekmeye İLK
       geçildiğinde çekilir (usersLoadedOnce), sonraki
       geçişlerde tekrar fetch atılmaz — Refresh butonu
       elle tazeleme için var.
    ----------------------------------------------------- */

    function renderAdminUsersTable(users) {

        if (!users.length) {
            usersTableBody.innerHTML = '';
            usersEmptyState.classList.remove('hidden');
            return;
        }

        usersEmptyState.classList.add('hidden');

        usersTableBody.innerHTML = users.map((user) => {
            const isSelf = user.id === currentUserId;
            const isAdmin = user.role === 'ADMIN';

            return `
            <tr class="hover:bg-surface-container-low/50 transition-colors">
                <td class="py-sm px-md">
                    <span class="font-body-md text-on-surface font-semibold">${escapeHtml(user.username)}</span>
                    ${isSelf ? '<span class="ml-2 text-[10px] uppercase tracking-wider text-on-surface-variant/70">(you)</span>' : ''}
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${user.displayName ? escapeHtml(user.displayName) : '<span class="text-on-surface-variant/50">—</span>'}
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${escapeHtml(user.userType)}
                </td>
                <td class="py-sm px-md">
                    <span class="inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-bold uppercase tracking-wider ${isAdmin ? 'bg-primary/15 text-primary' : 'bg-surface-container-high text-on-surface-variant'}">
                        ${escapeHtml(user.role)}
                    </span>
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${formatAdminDate(user.createdAt)}
                </td>
                <td class="py-sm px-md text-right">
                    <div class="flex justify-end gap-sm">
                        <button
                                class="toggleUserRoleButton
                                       inline-flex items-center gap-1
                                       px-sm py-[6px]
                                       rounded-lg
                                       border border-outline-variant
                                       text-on-surface-variant
                                       hover:text-on-surface
                                       hover:bg-surface-container-high
                                       transition-colors
                                       disabled:opacity-40
                                       disabled:cursor-not-allowed"
                                data-id="${user.id}"
                                data-current-role="${user.role}"
                                ${isSelf ? 'disabled title="You cannot change your own role"' : ''}
                                type="button"
                        >
                            ${isAdmin ? 'Remove Admin' : 'Make Admin'}
                        </button>

                        <button
                                class="deleteUserButton
                                       inline-flex items-center justify-center
                                       text-on-surface-variant hover:text-error
                                       hover:bg-error/10
                                       p-[6px] rounded-lg
                                       border border-outline-variant
                                       hover:border-error/40
                                       transition-colors
                                       disabled:opacity-40
                                       disabled:cursor-not-allowed
                                       disabled:hover:text-on-surface-variant
                                       disabled:hover:bg-transparent"
                                data-id="${user.id}"
                                data-username="${escapeHtml(user.username)}"
                                ${isSelf ? 'disabled title="You cannot delete your own account"' : ''}
                                title="Delete"
                                aria-label="Delete ${escapeHtml(user.username)}"
                                type="button"
                        >
                            <span class="material-symbols-outlined text-[16px]">delete</span>
                        </button>
                    </div>
                </td>
            </tr>
            `;
        }).join('');

        wireUserRoleButtons();
        wireDeleteUserButtons();
    }

    function wireUserRoleButtons() {
        document.querySelectorAll('.toggleUserRoleButton').forEach((button) => {
            button.addEventListener('click', async () => {

                const id = button.getAttribute('data-id');
                const currentRole = button.getAttribute('data-current-role');
                const nextRole = currentRole === 'ADMIN' ? 'MEMBER' : 'ADMIN';

                const confirmed = confirm(
                    nextRole === 'ADMIN'
                        ? 'Grant admin access to this user?'
                        : 'Remove admin access from this user?',
                );
                if (!confirmed) {
                    return;
                }

                button.disabled = true;

                try {
                    const response = await fetch(`/api/admin/users/${id}/role`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role: nextRole }),
                    });

                    const result = await response.json();

                    if (!response.ok) {
                        throw new Error(result.error?.message || 'Failed to update role.');
                    }

                    showToast('User role updated.', 'success');
                    await loadAdminUsers();

                } catch (error) {
                    console.error(error);
                    showToast(error instanceof Error ? error.message : 'Failed to update role.', 'error');
                    button.disabled = false;
                }
            });
        });
    }

    // v3.0 Faz 5.3 — kullanıcı silme (bkz. sohbet notu: "user silme kısmı ekleyelim, eklediğim
    // user'ın şifresini unuttum" — şifre hash'lendiği için geri getirilemez, tek yol sil + doğru
    // şifreyle tekrar oluştur). Kendi kendini silme / son admin'i silme engelleri zaten backend'de
    // (adminUsers.ts) var — buradaki disabled/title'lar sadece erken/UX geri bildirimi, tek
    // güvenlik sınırı backend'dekidir.
    function wireDeleteUserButtons() {
        document.querySelectorAll('.deleteUserButton').forEach((button) => {
            button.addEventListener('click', async () => {

                const id = button.getAttribute('data-id');
                const username = button.getAttribute('data-username');

                const confirmed = confirm(`Delete user "${username}"? This cannot be undone.`);
                if (!confirmed) {
                    return;
                }

                button.disabled = true;

                try {
                    const response = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });

                    if (!response.ok) {
                        const result = await response.json().catch(() => ({}));
                        throw new Error(result.error?.message || 'Failed to delete user.');
                    }

                    showToast('User deleted.', 'success');
                    await loadAdminUsers();

                } catch (error) {
                    console.error(error);
                    showToast(error instanceof Error ? error.message : 'Failed to delete user.', 'error');
                    button.disabled = false;
                }
            });
        });
    }

    // v3.0 Faz 5.1 — "Add User" modalı. Proje modalının AKSİNE (openProjectModal(project)) burada
    // DÜZENLEME modu yok — sadece oluşturma, bu yüzden parametre almıyor, form her açılışta reset.
    function openUserModal() {
        userFormError.classList.add('hidden');
        userFormError.textContent = '';
        userForm.reset();
        userRoleSelect.value = 'MEMBER';

        userModal.classList.remove('hidden');
        userModal.classList.add('flex');
        userUsernameInput.focus();
    }

    function closeUserModal() {
        userModal.classList.add('hidden');
        userModal.classList.remove('flex');
    }

    newUserButton.addEventListener('click', openUserModal);
    closeUserModalButton.addEventListener('click', closeUserModal);
    cancelUserModalButton.addEventListener('click', closeUserModal);

    userForm.addEventListener('submit', async (event) => {

        event.preventDefault();

        userFormError.classList.add('hidden');
        userFormError.textContent = '';

        const payload = {
            username: userUsernameInput.value.trim(),
            displayName: userDisplayNameInput.value.trim(),
            password: userPasswordInput.value,
            role: userRoleSelect.value,
        };

        saveUserButton.disabled = true;

        try {
            const response = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to create user.');
            }

            showToast('User created.', 'success');
            closeUserModal();
            await loadAdminUsers();

        } catch (error) {
            console.error(error);
            userFormError.textContent = error instanceof Error ? error.message : 'Failed to create user.';
            userFormError.classList.remove('hidden');
        } finally {
            saveUserButton.disabled = false;
        }
    });

    async function loadAdminUsers() {

        usersLoadingState.classList.remove('hidden');
        usersTableBody.innerHTML = '';
        usersEmptyState.classList.add('hidden');

        try {
            const response = await fetch('/api/admin/users');

            if (response.status === 503 || response.status === 401) {
                // 503 (Oracle kapalı) zaten Projects sekmesinde gösteriliyor; 401'de global gate
                // zaten devreye girer (bkz. window.fetch sarmalayıcısı) — burada ekstra bir şey
                // göstermeye gerek yok.
                return;
            }

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to load users.');
            }

            usersLoadedOnce = true;
            renderAdminUsersTable(result.users || []);

        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to load users.', 'error');
        } finally {
            usersLoadingState.classList.add('hidden');
        }
    }

    refreshUsersButton.addEventListener('click', () => loadAdminUsers());

    /* -----------------------------------------------------
       LDAP TAB — v3.0 Faz 2.3. Burada yapılandırmayı okur/
       kaydeder; gerçek LDAP BIND doğrulaması Faz 2.4'te
       backend'e (auth.ts + ldapClient.ts) eklendi, normal
       giriş ekranından çalışır. Liste sekmesi gibi sadece
       İLK geçişte fetch atılır.
    ----------------------------------------------------- */

    function applyLdapPasswordHint(managerPasswordConfigured) {
        ldapManagerPasswordHint.textContent = managerPasswordConfigured
            ? 'Kayıtlı bir şifre var — değiştirmek istemiyorsan bu alanı boş bırak.'
            : 'Henüz kayıtlı bir şifre yok.';
    }

    async function loadLdapConfig() {

        ldapFormError.classList.add('hidden');
        ldapFormSuccess.classList.add('hidden');

        try {
            const response = await fetch('/api/admin/ldap-config');

            if (response.status === 503 || response.status === 401) {
                // 503 (Oracle kapalı) zaten Projects sekmesinde gösteriliyor; 401'de global gate
                // zaten devreye girer — burada ekstra bir şey göstermeye gerek yok.
                return;
            }

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to load LDAP configuration.');
            }

            ldapLoadedOnce = true;

            const config = result.config;
            if (!config) {
                // Henüz hiç kaydedilmemiş — form boş, encoder type varsayılanı 'NO' (select'in
                // ilk option'ı).
                applyLdapPasswordHint(false);
                return;
            }

            ldapUrlInput.value = config.url || '';
            ldapBaseDnInput.value = config.baseDn || '';
            ldapManagerDnInput.value = config.managerDn || '';
            ldapUserDnPatternInput.value = config.userDnPattern || '';
            ldapUserSearchFilterInput.value = config.userSearchFilter || '';
            ldapGroupSearchBaseInput.value = config.groupSearchBase || '';
            ldapGroupSearchFilterInput.value = config.groupSearchFilter || '';
            ldapPasswordEncoderSelect.value = config.passwordEncoderType || 'NO';

            applyLdapPasswordHint(config.managerPasswordConfigured);

        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to load LDAP configuration.', 'error');
        }
    }

    ldapForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        ldapFormError.classList.add('hidden');
        ldapFormSuccess.classList.add('hidden');
        saveLdapButton.disabled = true;

        try {
            // ADIM 1: LDAP yapılandırmasını TEST et
            const testUsername = await promptUsername(
                'LDAP yapılandırmasını test etmek için bir test kullanıcı adı girin:',
                'Kullanıcı Adı',
                ''
            );

            if (!testUsername || testUsername.trim() === '') {
                showToast('Test işlemi iptal edildi.', 'info');
                return;
            }

            // Şifre için özel maskelenmiş input kullanan modal oluştur
            const testPassword = await promptPassword(
                'LDAP yapılandırmasını test etmek için test kullanıcının şifresini girin:',
                'Şifre'
            );

            if (!testPassword) {
                showToast('Test işlemi iptal edildi.', 'info');
                return;
            }

            // Test isteği gönder
            const testResponse = await fetch('/api/admin/ldap-test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    testUsername: testUsername.trim(),
                    testPassword: testPassword,
                }),
            });

            const testResult = await testResponse.json();

            if (!testResponse.ok) {
                // Test başarısız - kullanıcıya uyarı ver ve onay al
                const errorMessage = testResult.error?.message || 'LDAP testi başarısız.';
                ldapFormError.textContent = errorMessage;
                ldapFormError.classList.remove('hidden');

                const continueAnyway = window.confirm(
                    `LDAP testi başarısız:\n\n${errorMessage}\n\n\nYine de yapılandırmayı kaydetmek ister misiniz?`
                );

                if (!continueAnyway) {
                    return;
                }
            } else {
                // Test başarılı
                showToast(testResult.message || 'LDAP bağlantısı başarılı!', 'success');
            }

            // ADIM 2: Yapılandırmayı kaydet
            const response = await fetch('/api/admin/ldap-config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: ldapUrlInput.value,
                    baseDn: ldapBaseDnInput.value,
                    managerDn: ldapManagerDnInput.value,
                    // Boş bırakılırsa backend mevcut şifreyi korur (bkz. ldapConfigStore.ts
                    // UpsertLdapConfigInput dosya başı NOT) — bu yüzden burada özel bir "boşsa
                    // gönderme" mantığı YOK, backend zaten boş string'i "değiştirme" olarak ele alıyor.
                    managerPassword: ldapManagerPasswordInput.value,
                    userDnPattern: ldapUserDnPatternInput.value,
                    userSearchFilter: ldapUserSearchFilterInput.value,
                    groupSearchBase: ldapGroupSearchBaseInput.value,
                    groupSearchFilter: ldapGroupSearchFilterInput.value,
                    passwordEncoderType: ldapPasswordEncoderSelect.value,
                }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to save LDAP configuration.');
            }

            ldapLoadedOnce = true;
            ldapManagerPasswordInput.value = '';
            applyLdapPasswordHint(result.config.managerPasswordConfigured);

            ldapFormSuccess.textContent = 'LDAP yapılandırması kaydedildi.';
            ldapFormSuccess.classList.remove('hidden');
            showToast('LDAP configuration saved.', 'success');

        } catch (error) {
            console.error(error);
            ldapFormError.textContent = error instanceof Error ? error.message : 'Failed to save LDAP configuration.';
            ldapFormError.classList.remove('hidden');
        } finally {
            saveLdapButton.disabled = false;
        }
    });

    /* -----------------------------------------------------
       GLOBAL GRID URL — v3.0 Faz 5. Sekmelerin DIŞINDA,
       her zaman görünen tek alan olduğu için tab mantığına
       bağlı DEĞİL — sayfa yüklenince (aşağıdaki initial
       auth check içinde) HER ZAMAN çekilir.
    ----------------------------------------------------- */

    async function loadGlobalGridUrl() {

        globalGridUrlError.classList.add('hidden');

        try {
            const response = await fetch('/api/admin/global-settings');

            if (response.status === 503 || response.status === 401) {
                // 503 (Oracle kapalı) zaten Projects sekmesinde gösteriliyor; 401'de global gate
                // zaten devreye girer — burada ekstra bir şey göstermeye gerek yok.
                return;
            }

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to load Grid URL.');
            }

            globalGridUrlInput.value = result.settings?.gridUrl || '';
            // Sayfa yüklenirken zaten kaydedilmiş bir değer geldiyse (result.settings dolu), rozet
            // baştan "Kaydedildi" göstersin — kullanıcı Save'e basmadan da mevcut durumu görsün.
            setGlobalGridUrlSavedBadge(Boolean(result.settings?.gridUrl));

        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to load Grid URL.', 'error');
        }
    }

    // v3.0 Faz 5 düzeltme — kullanıcı geri bildirimi: "save ediliyor ama kutu hep aynı/açık kalıyor,
    // kaydedildiği belli olmuyor". Toast birkaç saniyede kayboluyor; bunun yanına, Save başarılı
    // olduğu sürece EKRANDA KALICI duran küçük bir "✓ Kaydedildi" rozeti ekliyoruz. Kullanıcı kutuya
    // tekrar yazmaya başlarsa (henüz kaydedilmemiş yeni bir değer demektir) rozet otomatik gizlenir.
    function setGlobalGridUrlSavedBadge(isSaved) {
        globalGridUrlSavedBadge.classList.toggle('hidden', !isSaved);
        globalGridUrlSavedBadge.classList.toggle('flex', isSaved);
    }

    globalGridUrlInput.addEventListener('input', () => {
        setGlobalGridUrlSavedBadge(false);
    });

    saveGlobalGridUrlButton.addEventListener('click', async () => {

        globalGridUrlError.classList.add('hidden');
        saveGlobalGridUrlButton.disabled = true;

        try {
            const response = await fetch('/api/admin/global-settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gridUrl: globalGridUrlInput.value.trim() }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to save Grid URL.');
            }

            globalGridUrlInput.value = result.settings?.gridUrl || '';
            setGlobalGridUrlSavedBadge(Boolean(result.settings?.gridUrl));
            showToast('Grid URL saved.', 'success');

        } catch (error) {
            console.error(error);
            globalGridUrlError.textContent = error instanceof Error ? error.message : 'Failed to save Grid URL.';
            globalGridUrlError.classList.remove('hidden');
            setGlobalGridUrlSavedBadge(false);
        } finally {
            saveGlobalGridUrlButton.disabled = false;
        }
    });

    /* -----------------------------------------------------
       DELETE OLD RUNS — v3.1. Bkz. sohbet notu: "admin panelden eski koşumları şu tarihten
       itibaren sil". Test Runs sayfasındaki "Clear All" ile AYNI confirm()+disable deseni,
       sadece DELETE /api/test-runs?before=<tarih> çağırıyor (bkz. backend legacyTests.ts /
       LegacyTestService.clearTestRunsBefore — hesaplanan tarihten ESKİ, o tarihten ÖNCE
       oluşturulmuş koşumları siler; kesim tarihinin kendisi silinmez). Bu araç TÜM kullanıcıların
       koşumlarını hedefler (Admin Panel zaten ADMIN'e özel), Generated Tests'teki test
       DOSYALARINA dokunmaz.

       v3.1.1 — bkz. sohbet notu: "default olarak 15 gün falan gibi yapalım tarih girmeyelim".
       Kullanıcı artık bir TARİH değil, kaç GÜNDEN eski koşumların silineceğini (varsayılan 15)
       giriyor; kesim tarihi burada ("bugün - N gün") hesaplanıp backend'e AYNI ?before= parametresi
       olarak gönderiliyor — backend HİÇ değişmedi, sadece frontend'in tarihi nasıl ürettiği değişti.
    ----------------------------------------------------- */
    if (deleteOldRunsDaysInput && deleteOldRunsButton) {

        // days -> "YYYY-MM-DD" (yerel gün, saat dilimi kaymasın diye getFullYear/Month/Date ile
        // elle biçimlendiriliyor — toISOString() UTC'ye çevirir, akşam saatlerinde bir gün geride
        // kalabilirdi). Geçersiz/boş/negatif girişte null döner.
        function computeCutoffDate() {
            const days = Number(deleteOldRunsDaysInput.value);
            if (!Number.isFinite(days) || days <= 0) {
                return null;
            }
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            const y = cutoff.getFullYear();
            const m = String(cutoff.getMonth() + 1).padStart(2, '0');
            const d = String(cutoff.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        deleteOldRunsButton.addEventListener('click', async () => {
            const cutoffDate = computeCutoffDate();
            if (!cutoffDate) {
                showToast('Enter a valid number of days.', 'error');
                return;
            }

            const confirmed = confirm(
                `Delete ALL test runs older than ${deleteOldRunsDaysInput.value} days (before ${cutoffDate}, for every user)? This cannot be undone.`,
            );
            if (!confirmed) {
                return;
            }

            deleteOldRunsButton.disabled = true;

            try {
                const response = await fetch(`/api/test-runs?before=${encodeURIComponent(cutoffDate)}`, {
                    method: 'DELETE',
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.message || 'Failed to delete old test runs.');
                }

                showToast(`${result.count ?? 0} old test run(s) deleted.`, 'success');

            } catch (error) {
                console.error(error);
                showToast(error instanceof Error ? error.message : 'Failed to delete old test runs.', 'error');
            } finally {
                deleteOldRunsButton.disabled = false;
            }
        });
    }

    function switchAdminTab(tab) {
        const sections = { projects: projectsSection, users: usersSection, ldap: ldapSection };
        const tabButtons = { projects: tabProjectsButton, users: tabUsersButton, ldap: tabLdapButton };

        Object.keys(sections).forEach((key) => {
            const isActive = key === tab;

            sections[key].classList.toggle('hidden', !isActive);
            sections[key].classList.toggle('flex', isActive);

            tabButtons[key].classList.toggle('text-on-surface', isActive);
            tabButtons[key].classList.toggle('text-on-surface-variant', !isActive);
            tabButtons[key].classList.toggle('border-primary', isActive);
            tabButtons[key].classList.toggle('border-transparent', !isActive);
        });

        if (tab === 'users' && !usersLoadedOnce) {
            void loadAdminUsers();
        }
        if (tab === 'ldap' && !ldapLoadedOnce) {
            void loadLdapConfig();
        }
    }

    tabProjectsButton.addEventListener('click', () => switchAdminTab('projects'));
    tabUsersButton.addEventListener('click', () => switchAdminTab('users'));
    tabLdapButton.addEventListener('click', () => switchAdminTab('ldap'));

    // Sayfa yüklenince mevcut bir oturum var mı diye kontrol et — varsa doğrudan içeriği göster,
    // yoksa login formunda kal.
    try {
        const meResponse = await fetch('/api/auth/me');

        if (meResponse.ok) {
            const meResult = await meResponse.json();
            showPanelContent(meResult.user);
            await loadAdminProjects();
            void loadGlobalGridUrl(); // sekmelerden bağımsız, her zaman görünen alan (bkz. yukarısı) — await beklemeden paralel yüklenebilir.
        } else {
            showLoginGate();
        }
    } catch (error) {
        console.error(error);
        showLoginGate();
    }
}


/* =========================================================
   PROJECT MEMBERS PAGE
   ------------------------------------------------------
   v3.1 — eskiden Admin Panel > Projects tablosundaki "Members"
   butonu küçük bir modal açardı; bu modal LDAP kullanıcı adları
   uzun olduğunda "Add" butonunun görünmez olmasına yol açan bir
   flexbox bug'ı yüzünden VE genel olarak yetersiz alan sağladığı
   için tamamen kaldırıldı (bkz. sohbet notu: "modal tamamen
   kalksın, buton direkt sayfaya götürsün"). Yerine bu ayrı, tam
   sayfalık detay görünümü geldi. Hangi projenin gösterileceği
   goToProjectMembersPage() tarafından sessionStorage'a TEK
   SEFERLİK yazılır (testpilot.pendingSuggestion ile AYNI desen),
   burada okunup hemen silinir.

   Kullanıcının hesap tipi (LDAP/LOCAL) rozeti için backend'e
   YENİ bir alan/route EKLEMEDİK: GET /api/admin/users zaten her
   kullanıcı için userType döndürüyor (bkz. adminUsers.ts), o
   yüzden burada members + tüm kullanıcılar paralel çekilip
   client-side id üzerinden eşleştiriliyor — listProjectMembers()
   SQL'ini değiştirmeye gerek kalmadı.
========================================================= */

async function initProjectMembersPage() {

    const backButton = document.getElementById('projectMembersBackButton');
    const titleEl = document.getElementById('projectMembersPageTitle');
    const subtitleEl = document.getElementById('projectMembersPageSubtitle');

    const loadingState = document.getElementById('projectMembersLoadingState');
    const emptyState = document.getElementById('projectMembersEmptyState');
    const tableBody = document.getElementById('projectMembersTableBody');

    const addSearchInput = document.getElementById('projectMembersAddSearch');
    const addSelect = document.getElementById('projectMembersAddSelect');
    const addButton = document.getElementById('projectMembersAddButton');
    const refreshButton = document.getElementById('projectMembersRefreshButton');

    // "Add Member" dropdown'ındaki İSİM ARAMA kutusu (bkz. sohbet notu: "arama kısmı da
    // yazalım isim yazalım"). Backend'e her tuş vuruşunda ayrı istek atmıyoruz — refreshMembers()
    // zaten TÜM atanabilir kullanıcıları tek seferde çekiyor, burada sadece o listeyi client-side
    // filtreleyip <select>'i yeniden dolduruyoruz (bkz. renderAddSelectOptions).
    let assignableUsers = [];

    // Bu sayfaya özel, küçük bir tarih biçimlendirici — formatAdminDate() Admin Panel'in kendi
    // closure'ı içinde tanımlı, global değil (bkz. initAdminPanelPage), bu yüzden burada da
    // (kasıtlı olarak minimal) ayrı bir kopyası var.
    function formatMemberDate(value) {
        if (!value) {
            return '-';
        }
        try {
            return new Date(value).toLocaleString('tr-TR');
        } catch (error) {
            return '-';
        }
    }

    if (backButton) {
        backButton.addEventListener('click', () => {
            void navigateTo('admin');
        });
    }

    /* -----------------------------------------------------
       PENDING PROJECT HANDOFF — goToProjectMembersPage() tarafından yazılan {id, name} burada
       okunup hemen silinir (bkz. yukarısı "PROJECT MEMBERS PAGE'E GEÇİŞ" notu). Eksikse (ör.
       sayfa doğrudan yenilendiyse) gösterecek proje yok demektir, Admin Panel'e geri dön.
    ----------------------------------------------------- */
    let project = null;
    try {
        const pendingRaw = window.sessionStorage.getItem('testpilot.pendingProjectMembers');
        if (pendingRaw) {
            window.sessionStorage.removeItem('testpilot.pendingProjectMembers');
            project = JSON.parse(pendingRaw);
        }
    } catch (error) {
        console.error(error);
    }

    if (!project || project.id == null) {
        showToast('No project selected.', 'error');
        void navigateTo('admin');
        return;
    }

    if (titleEl) {
        titleEl.textContent = project.name || `Project #${project.id}`;
    }
    if (subtitleEl) {
        subtitleEl.textContent = `Members of ${project.name || `Project #${project.id}`}`;
    }

    function renderMembersTable(members, userTypeById) {
        if (!members.length) {
            tableBody.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');

        tableBody.innerHTML = members.map((member) => {
            const isAdmin = member.role === 'ADMIN';
            const label = member.displayName ? member.displayName : member.username;
            const userType = userTypeById.get(member.id) || 'LOCAL';
            const isLdap = userType === 'LDAP';

            return `
            <tr class="hover:bg-surface-container-low/50 transition-colors">
                <td class="py-sm px-md">
                    <span class="font-body-md text-on-surface font-semibold">${escapeHtml(label)}</span>
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${escapeHtml(member.username)}
                </td>
                <td class="py-sm px-md">
                    <span class="inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-bold uppercase tracking-wider ${isLdap ? 'bg-secondary/15 text-secondary' : 'bg-surface-container-high text-on-surface-variant'}">
                        ${escapeHtml(userType)}
                    </span>
                </td>
                <td class="py-sm px-md">
                    <span class="inline-flex items-center px-2 py-[2px] rounded-full text-[10px] font-bold uppercase tracking-wider ${isAdmin ? 'bg-primary/15 text-primary' : 'bg-surface-container-high text-on-surface-variant'}">
                        ${escapeHtml(member.role)}
                    </span>
                </td>
                <td class="py-sm px-md text-on-surface-variant">
                    ${formatMemberDate(member.assignedAt)}
                </td>
                <td class="py-sm px-md text-right">
                    <button
                            class="removeProjectMemberButton
                                   inline-flex items-center justify-center
                                   text-on-surface-variant hover:text-error
                                   hover:bg-error/10
                                   p-[6px] rounded-lg
                                   border border-outline-variant
                                   transition-colors"
                            data-user-id="${member.id}"
                            title="Remove"
                            aria-label="Remove ${escapeHtml(label)}"
                            type="button"
                    >
                        <span class="material-symbols-outlined text-[16px]">close</span>
                    </button>
                </td>
            </tr>
            `;
        }).join('');

        document.querySelectorAll('.removeProjectMemberButton').forEach((button) => {
            button.addEventListener('click', async () => {
                const userId = button.getAttribute('data-user-id');
                button.disabled = true;
                try {
                    const response = await fetch(`/api/admin/projects/${project.id}/members/${userId}`, {
                        method: 'DELETE',
                    });
                    if (!response.ok && response.status !== 204) {
                        const result = await response.json().catch(() => ({}));
                        throw new Error(result.error?.message || 'Failed to remove member.');
                    }
                    showToast('Member removed.', 'success');
                    await refreshMembers();
                } catch (error) {
                    console.error(error);
                    showToast(error instanceof Error ? error.message : 'Failed to remove member.', 'error');
                    button.disabled = false;
                }
            });
        });
    }

    /** assignableUsers (zaten üye olmayan TÜM kullanıcılar) içinden arama kutusundaki metne göre
     * filtreleyip <select>'i yeniden doldurur — displayName VEYA username'de, büyük/küçük harf
     * duyarsız bir alt-dize eşleşmesi arar. filterText boşsa (ör. sayfa yeni yüklendiğinde veya
     * arama kutusu temizlendiğinde) TÜM liste gösterilir. */
    function renderAddSelectOptions(filterText) {
        if (!assignableUsers.length) {
            addSelect.innerHTML = '<option value="">No more users to add</option>';
            addSelect.disabled = true;
            addButton.disabled = true;
            return;
        }

        const needle = (filterText || '').trim().toLowerCase();
        const filtered = needle
            ? assignableUsers.filter((u) => {
                const haystack = `${u.displayName || ''} ${u.username}`.toLowerCase();
                return haystack.includes(needle);
            })
            : assignableUsers;

        if (!filtered.length) {
            addSelect.innerHTML = `<option value="">No match for "${escapeHtml(filterText)}"</option>`;
            addSelect.disabled = true;
            addButton.disabled = true;
            return;
        }

        addSelect.innerHTML = filtered.map((u) => {
            const label = u.displayName ? `${u.displayName} (${u.username})` : u.username;
            return `<option value="${u.id}">${escapeHtml(label)} — ${escapeHtml(u.userType)} — ${escapeHtml(u.role)}</option>`;
        }).join('');
        addSelect.disabled = false;
        addButton.disabled = false;
    }

    if (addSearchInput) {
        addSearchInput.addEventListener('input', () => {
            renderAddSelectOptions(addSearchInput.value);
        });
    }

    /** Sayfa her açıldığında/yenilendiğinde HEM güncel üye listesini HEM TÜM kullanıcıları (zaten
     * üye olanlar "add" dropdown'ından hariç tutulacak şekilde) yeniden çeker — kasıtlı olarak
     * cache YOK, her zaman en güncel atamayı göstermesi burada modal versiyonundakiyle aynı
     * gerekçeyle daha önemli. */
    async function refreshMembers() {
        loadingState.classList.remove('hidden');
        emptyState.classList.add('hidden');

        addButton.disabled = true;
        addSelect.disabled = true;
        addSelect.innerHTML = '<option value="">Loading...</option>';
        if (addSearchInput) {
            addSearchInput.value = '';
        }

        try {
            const [membersResponse, usersResponse] = await Promise.all([
                fetch(`/api/admin/projects/${project.id}/members`),
                fetch('/api/admin/users'),
            ]);

            if (membersResponse.status === 401 || usersResponse.status === 401) {
                showToast('Session expired, please sign in again.', 'error');
                void navigateTo('admin');
                return;
            }

            const membersResult = await membersResponse.json();
            const usersResult = await usersResponse.json();

            if (!membersResponse.ok) {
                throw new Error(membersResult.error?.message || 'Failed to load members.');
            }
            if (!usersResponse.ok) {
                throw new Error(usersResult.error?.message || 'Failed to load users.');
            }

            const members = membersResult.members || [];
            const allUsers = usersResult.users || [];

            const userTypeById = new Map(allUsers.map((u) => [u.id, u.userType]));

            renderMembersTable(members, userTypeById);

            const memberIds = new Set(members.map((m) => m.id));
            assignableUsers = allUsers.filter((u) => !memberIds.has(u.id));

            renderAddSelectOptions('');

        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to load project members.', 'error');
        } finally {
            loadingState.classList.add('hidden');
        }
    }

    addButton.addEventListener('click', async () => {
        const userId = addSelect.value;
        if (!userId) {
            return;
        }

        addButton.disabled = true;

        try {
            const response = await fetch(`/api/admin/projects/${project.id}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: Number(userId) }),
            });

            const result = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(result.error?.message || 'Failed to add member.');
            }

            showToast('Member added.', 'success');
            await refreshMembers();

        } catch (error) {
            console.error(error);
            showToast(error instanceof Error ? error.message : 'Failed to add member.', 'error');
            addButton.disabled = false;
        }
    });

    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            void refreshMembers();
        });
    }

    await refreshMembers();
}


/* =========================================================
   SETTINGS
========================================================= */

async function initSettingsPage() {

    const settingsBrowserInputs =
        document.querySelectorAll(
            'input[name="settingsBrowser"]',
        );

    const settingsHeadedMode =
        document.getElementById(
            'settingsHeadedMode',
        );

    const settingsScreenshotOption =
        document.getElementById(
            'settingsScreenshotOption',
        );

    const settingsVideoOption =
        document.getElementById(
            'settingsVideoOption',
        );

    const settingsTraceOption =
        document.getElementById(
            'settingsTraceOption',
        );

    // v3.13 — bkz. sohbet notu: "settingsten default ayarlarını düzenliyorduk, oraya selenium
    // gridi de koyalım". Create Test sayfasındaki #useSeleniumGridOption ile birebir aynı
    // desen — bkz. aşağıdaki EXECUTION DEFAULTS bloğu sonundaki kullanılabilirlik mantığı.
    const settingsUseSeleniumGridOption =
        document.getElementById(
            'settingsUseSeleniumGridOption',
        );

    const settingsSeleniumGridHint =
        document.getElementById(
            'settingsSeleniumGridHint',
        );

    const settingsSavedNotice =
        document.getElementById(
            'settingsSavedNotice',
        );

    const settingsLlmInfo =
        document.getElementById(
            'settingsLlmInfo',
        );

    const settingsAgentInfo =
        document.getElementById(
            'settingsAgentInfo',
        );

    // v3.5 — bkz. sohbet notu: "koda gömülü ayarlar ... settings kısmından değiştirilebilir olsun".
    // Agent Behavior artık salt-okunur DEĞİL — bkz. aşağıdaki renderAgentSettingsForm()/
    // saveAgentSettings()/resetAgentSettings().
    const settingsAgentSaveButton = document.getElementById('settingsAgentSaveButton');
    const settingsAgentResetButton = document.getElementById('settingsAgentResetButton');
    const settingsAgentSavedNotice = document.getElementById('settingsAgentSavedNotice');
    const settingsAgentErrorNotice = document.getElementById('settingsAgentErrorNotice');

    const settingsSeleniumGridInfo =
        document.getElementById(
            'settingsSeleniumGridInfo',
        );

    const settingsVectorCacheInfo =
        document.getElementById(
            'settingsVectorCacheInfo',
        );


    /* -----------------------------------------------------
       EXECUTION DEFAULTS (appState.executionSettings ile
       aynı kaynağı paylaşır — bkz. dosya başındaki
       loadStoredExecutionSettings()/persistExecutionSettings()).
    ----------------------------------------------------- */

    const rememberedBrowser =
        document.querySelector(
            `input[name="settingsBrowser"][value="${appState.executionSettings.browser}"]`,
        );

    if (rememberedBrowser) {
        rememberedBrowser.checked = true;
    }

    settingsHeadedMode.checked =
        appState.executionSettings.headed;

    settingsScreenshotOption.checked =
        appState.executionSettings.screenshot;

    settingsVideoOption.checked =
        appState.executionSettings.video;

    settingsTraceOption.checked =
        appState.executionSettings.trace;


    let savedNoticeTimer = null;


    function saveSettingsFromForm() {

        appState.executionSettings.browser =
            document.querySelector(
                'input[name="settingsBrowser"]:checked',
            )?.value || 'chromium';

        appState.executionSettings.headed =
            settingsHeadedMode.checked;

        appState.executionSettings.screenshot =
            settingsScreenshotOption.checked;

        appState.executionSettings.video =
            settingsVideoOption.checked;

        appState.executionSettings.trace =
            settingsTraceOption.checked;

        appState.executionSettings.useSeleniumGrid =
            settingsUseSeleniumGridOption.checked;


        persistExecutionSettings(
            appState.executionSettings,
        );


        // Kısa bir "Kaydedildi" onayı göster, ardından gizle — kullanıcıya sessizce hiçbir şey
        // olmamış izlenimi vermemek için (önceki tasarımdaki "alert() yok" prensibiyle uyumlu:
        // akışı KESMEYEN, kendiliğinden kaybolan bir geri bildirim).
        settingsSavedNotice.classList.remove(
            'hidden',
        );

        if (savedNoticeTimer) {
            clearTimeout(savedNoticeTimer);
        }

        savedNoticeTimer =
            setTimeout(
                () => {
                    settingsSavedNotice.classList.add(
                        'hidden',
                    );
                },
                1500,
            );
    }


    /* -----------------------------------------------------
       SELENIUM GRID AVAILABILITY (v3.13)
       ------------------------------------------------------
       Create Test sayfasındaki updateSeleniumGridAvailability() ile BİREBİR AYNI kural: checkbox
       yalnızca (1) seçili motor "chromium" VE (2) backend'de SELENIUM_GRID_URL yapılandırılmışsa
       tıklanabilir. settingsSeleniumGridConfigured, aşağıdaki GET /api/settings çağrısı sonuçlanınca
       doldurulur (bu sayfa zaten o çağrıyı "Selenium Grid" bilgi kartı için yapıyor — ikinci bir
       istek atmaya gerek yok). Koşul sağlanmıyorsa işaret appState'e YAZILMADAN kaldırılır — kullanıcı
       motoru geri Chromium'a alırsa önceki tercihi (işaretliyse) geri gelir.
    ----------------------------------------------------- */

    let settingsSeleniumGridConfigured = false;

    function updateSettingsSeleniumGridAvailability() {

        const selectedBrowser =
            document.querySelector(
                'input[name="settingsBrowser"]:checked',
            )?.value || 'chromium';

        const available =
            selectedBrowser === 'chromium' &&
            settingsSeleniumGridConfigured;

        settingsUseSeleniumGridOption.disabled =
            !available;

        settingsUseSeleniumGridOption.checked =
            available &&
            appState.executionSettings.useSeleniumGrid;

        if (!settingsSeleniumGridConfigured) {
            settingsSeleniumGridHint.textContent =
                'Selenium Grid is not configured on the backend (SELENIUM_GRID_URL missing).';
        } else if (selectedBrowser !== 'chromium') {
            settingsSeleniumGridHint.textContent =
                'Selenium Grid is only supported with the Chromium engine.';
        } else {
            settingsSeleniumGridHint.textContent = '';
        }
    }


    updateSettingsSeleniumGridAvailability();


    settingsBrowserInputs.forEach(
        (input) => {
            input.addEventListener(
                'change',
                () => {
                    saveSettingsFromForm();
                    updateSettingsSeleniumGridAvailability();
                },
            );
        },
    );

    [
        settingsHeadedMode,
        settingsScreenshotOption,
        settingsVideoOption,
        settingsTraceOption,
        settingsUseSeleniumGridOption,
    ].forEach((input) => {
        input.addEventListener(
            'change',
            saveSettingsFromForm,
        );
    });


    /* -----------------------------------------------------
       AI ENGINE + AGENT BEHAVIOR (salt-okunur, backend'den)
    ----------------------------------------------------- */

    function infoTile(label, value) {

        return `
            <div>
                <span class="font-label-caps text-on-surface-variant">${label}</span>
                <div class="font-body-md text-body-md text-on-surface mt-1">${value}</div>
            </div>
        `;
    }

    // v3.5 — bkz. sohbet notu: "koda gömülü ayarlar ... settings kısmından değiştirilebilir olsun".
    // infoTile() ile AYNI grid hücresi boyutunu kaplayan ama gerçekten düzenlenebilir bir input
    // üreten karşılığı — Agent Behavior formu için.
    const numberFieldClass =
        'w-full bg-[#0F172A] border border-[#334155] rounded-lg px-sm py-2 text-body-md text-on-surface ' +
        'focus:border-primary-container focus:ring-2 focus:ring-primary-container/20 transition-all outline-none';

    function numberField(id, label, value, { step, min, max } = {}) {
        return `
            <div class="flex flex-col gap-1">
                <label for="${id}" class="font-label-caps text-on-surface-variant">${label}</label>
                <input
                        id="${id}"
                        type="number"
                        value="${value}"
                        ${step !== undefined ? `step="${step}"` : ''}
                        ${min !== undefined ? `min="${min}"` : ''}
                        ${max !== undefined ? `max="${max}"` : ''}
                        class="${numberFieldClass}"
                />
            </div>
        `;
    }

    function checkboxField(id, label, checked) {
        return `
            <label class="flex items-center gap-2 cursor-pointer p-1.5 self-end hover:bg-surface-variant rounded transition-colors">
                <input id="${id}" type="checkbox" ${checked ? 'checked' : ''} class="rounded bg-surface-container border-outline-variant text-primary" />
                <span class="font-body-sm text-body-sm text-on-surface">${label}</span>
            </label>
        `;
    }

    function renderAgentSettingsForm(agent, playwright) {
        settingsAgentInfo.innerHTML =
            numberField('agentSettingMinConfidence', 'Min. Confidence (0–1)', agent.minConfidence, { step: 0.01, min: 0, max: 1 }) +
            numberField('agentSettingMaxSteps', 'Max Steps', agent.maxSteps, { step: 1, min: 1, max: 500 }) +
            numberField('agentSettingMaxRepeatedActions', 'Loop Tolerance (repeats)', agent.maxRepeatedActions, { step: 1, min: 1 }) +
            numberField('agentSettingStepTimeoutMs', 'Step Timeout (ms)', agent.stepTimeoutMs, { step: 500, min: 1000 }) +
            numberField('agentSettingMaxElementsPerStep', 'Max Elements / Step', agent.maxElementsPerStep, { step: 1, min: 1, max: 500 }) +
            numberField('agentSettingNavigationTimeoutMs', 'Navigation Timeout (ms)', playwright.navigationTimeoutMs, { step: 500, min: 1000 }) +
            numberField('agentSettingDefaultActionTimeoutMs', 'Action Timeout (ms)', playwright.defaultActionTimeoutMs, { step: 500, min: 1000 }) +
            checkboxField('agentSettingHeadless', 'Headless by default', playwright.headless);
    }


    try {

        const response =
            await fetch('/api/settings');

        if (!response.ok) {
            throw new Error(
                'Failed to load settings.',
            );
        }

        const data =
            await response.json();


        // v2.3 — Ollama yerelde çalışır, bir API anahtarı KAVRAMI yoktur (bkz. settings.ts dosya
        // başı NOT) — bu yüzden "API Key" satırı yerine "yapılandırılmış mı" (model tanımlı mı)
        // durumunu, maskelenmiş bir anahtar göstermeden ayrı bir metinle bildiriyoruz.
        const apiKeyStatus =
            data.llm.provider === 'ollama'
                ? data.llm.apiKeyConfigured
                    ? '<span class="text-secondary">✓ Local (no key needed)</span>'
                    : '<span class="text-error">✗ OLLAMA_MODEL not configured</span>'
                : data.llm.apiKeyConfigured
                    ? `<span class="text-secondary">✓ Configured</span> (${data.llm.apiKeyMasked})`
                    : '<span class="text-error">✗ Not configured</span>';

        settingsLlmInfo.innerHTML =
            infoTile('Provider', data.llm.provider) +
            infoTile('Model', data.llm.model || '—') +
            infoTile('API Key', apiKeyStatus);


        renderAgentSettingsForm(data.agent, data.playwright);

        // v2.0 — bkz. GET /api/settings → seleniumGrid.configured (hub adresinin KENDİSİ BİLEREK
        // dönülmez/gösterilmez, sadece "yapılandırılmış mı" bilgisi).
        const gridStatus =
            data.seleniumGrid?.configured
                ? '<span class="text-secondary">✓ Configured</span>'
                : '<span class="text-on-surface-variant">✗ Not configured</span>';

        settingsSeleniumGridInfo.innerHTML =
            infoTile('Hub Status', gridStatus);

        // v3.13 — Execution Defaults'taki "Run via Selenium Grid" checkbox'ı, tam olarak bu
        // yanıttaki configured bilgisiyle etkin/pasif hale getirilir (bkz. yukarıdaki
        // updateSettingsSeleniumGridAvailability()).
        settingsSeleniumGridConfigured =
            Boolean(data.seleniumGrid?.configured);

        updateSettingsSeleniumGridAvailability();

        // v2.0 Faz 3 — bkz. GET /api/settings → vectorCache (Milvus/Ollama adresleri KENDİLERİ
        // BİLEREK dönülmez/gösterilmez, tıpkı Selenium Grid hub adresinde olduğu gibi — sadece
        // "yapılandırılmış mı" bilgisi + hassas olmayan eşik/model bilgileri gösterilir).
        const vectorWriteStatus =
            data.vectorCache?.writeEnabled
                ? '<span class="text-secondary">✓ Enabled (collecting data)</span>'
                : '<span class="text-on-surface-variant">✗ Disabled</span>';

        const vectorReadStatus =
            data.vectorCache?.readEnabled
                ? '<span class="text-secondary">✓ Enabled (skipping LLM on cache hits)</span>'
                : '<span class="text-on-surface-variant">✗ Disabled</span>';

        settingsVectorCacheInfo.innerHTML =
            infoTile('Write (data collection)', vectorWriteStatus) +
            infoTile('Read (LLM skip)', vectorReadStatus) +
            infoTile('Embedding Model', data.vectorCache?.embeddingModel || '—') +
            infoTile('Min. Similarity', data.vectorCache?.minSimilarity ?? '—');

    } catch (error) {

        console.error(
            'Failed to fetch settings info:',
            error,
        );

        settingsLlmInfo.innerHTML =
            '<div class="col-span-4 text-error font-body-sm text-body-sm">Settings could not be loaded from backend.</div>';

        settingsAgentInfo.innerHTML =
            '<div class="col-span-3 text-error font-body-sm text-body-sm">Settings could not be loaded from backend.</div>';

        settingsSeleniumGridInfo.innerHTML =
            '<div class="text-error font-body-sm text-body-sm">Settings could not be loaded from backend.</div>';

        settingsVectorCacheInfo.innerHTML =
            '<div class="col-span-2 text-error font-body-sm text-body-sm">Settings could not be loaded from backend.</div>';
    }


    /* -----------------------------------------------------
       AGENT BEHAVIOR — SAVE / RESET (v3.5)
    ----------------------------------------------------- */

    let agentSavedNoticeTimer = null;

    function showAgentSavedNotice() {
        settingsAgentErrorNotice.classList.add('hidden');
        settingsAgentSavedNotice.classList.remove('hidden');
        if (agentSavedNoticeTimer) clearTimeout(agentSavedNoticeTimer);
        agentSavedNoticeTimer = setTimeout(() => {
            settingsAgentSavedNotice.classList.add('hidden');
        }, 1500);
    }

    function showAgentErrorNotice(message) {
        settingsAgentSavedNotice.classList.add('hidden');
        settingsAgentErrorNotice.textContent = message;
        settingsAgentErrorNotice.classList.remove('hidden');
    }

    if (settingsAgentSaveButton) {
        settingsAgentSaveButton.addEventListener('click', async () => {
            const payload = {
                minConfidence: Number(document.getElementById('agentSettingMinConfidence')?.value),
                maxSteps: Number(document.getElementById('agentSettingMaxSteps')?.value),
                maxRepeatedActions: Number(document.getElementById('agentSettingMaxRepeatedActions')?.value),
                stepTimeoutMs: Number(document.getElementById('agentSettingStepTimeoutMs')?.value),
                maxElementsPerStep: Number(document.getElementById('agentSettingMaxElementsPerStep')?.value),
                navigationTimeoutMs: Number(document.getElementById('agentSettingNavigationTimeoutMs')?.value),
                defaultActionTimeoutMs: Number(document.getElementById('agentSettingDefaultActionTimeoutMs')?.value),
                headless: Boolean(document.getElementById('agentSettingHeadless')?.checked),
            };

            if (Object.values(payload).some((v) => typeof v === 'number' && Number.isNaN(v))) {
                showAgentErrorNotice('Please fill in every field with a valid number.');
                return;
            }

            settingsAgentSaveButton.disabled = true;
            try {
                const response = await fetch('/api/settings/agent', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.message || 'Failed to save settings.');
                }
                renderAgentSettingsForm(result.agent, result.playwright);
                showAgentSavedNotice();
            } catch (error) {
                console.error(error);
                showAgentErrorNotice(error instanceof Error ? error.message : 'Failed to save settings.');
            } finally {
                settingsAgentSaveButton.disabled = false;
            }
        });
    }

    if (settingsAgentResetButton) {
        settingsAgentResetButton.addEventListener('click', async () => {
            const confirmed = confirm(
                'Reset Agent Behavior settings to the .env defaults? This affects everyone using this app.',
            );
            if (!confirmed) return;

            settingsAgentResetButton.disabled = true;
            try {
                const response = await fetch('/api/settings/agent/reset', { method: 'POST' });
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.message || 'Failed to reset settings.');
                }
                renderAgentSettingsForm(result.agent, result.playwright);
                showAgentSavedNotice();
            } catch (error) {
                console.error(error);
                showAgentErrorNotice(error instanceof Error ? error.message : 'Failed to reset settings.');
            } finally {
                settingsAgentResetButton.disabled = false;
            }
        });
    }
}


/* =========================================================
   DASHBOARD
========================================================= */

async function initDashboardPage() {

    const createButton =
        document.getElementById(
            'dashboardCreateTestButton',
        );

    const runExistingButton =
        document.getElementById(
            'dashboardRunExistingButton',
        );

    const viewAllRunsLink =
        document.getElementById(
            'dashboardViewAllRunsLink',
        );


    const lastRunFile =
        document.getElementById(
            'dashboardLastRunFile',
        );

    const lastRunStatus =
        document.getElementById(
            'dashboardLastRunStatus',
        );

    const lastRunMeta =
        document.getElementById(
            'dashboardLastRunMeta',
        );

    const viewResultButton =
        document.getElementById(
            'dashboardViewResultButton',
        );


    const lastGeneratedFile =
        document.getElementById(
            'dashboardLastGeneratedFile',
        );

    const viewCodeButton =
        document.getElementById(
            'dashboardViewCodeButton',
        );

    const runLastGeneratedButton =
        document.getElementById(
            'dashboardRunLastGeneratedButton',
        );


    createButton.addEventListener(
        'click',
        () => {

            navigateTo(
                'create',
            );
        },
    );


    runExistingButton.addEventListener(
        'click',
        () => {

            navigateTo(
                'generated',
            );
        },
    );


    if (viewAllRunsLink) {

        viewAllRunsLink.addEventListener(
            'click',
            () => {

                navigateTo(
                    'runs',
                );
            },
        );
    }


    viewResultButton.addEventListener(
        'click',
        () => {

            navigateTo(
                'runs',
            );
        },
    );


    /* LAST RUN */

    try {

        const response =
            await fetch(
                '/api/test-runs',
            );


        const result =
            await response.json();


        const runs =
            result.runs ||
            [];


        if (
            runs.length >
            0
        ) {

            const lastRun =
                runs[0];


            lastRunFile.textContent =
                lastRun.testFile;


            lastRunStatus.textContent =
                lastRun.status;


            if (
                lastRun.status ===
                'passed'
            ) {

                lastRunStatus.className =
                    'px-3 py-1 rounded-full bg-secondary/10 text-secondary text-xs';

            } else {

                lastRunStatus.className =
                    'px-3 py-1 rounded-full bg-error/10 text-error text-xs';
            }


            const date =
                new Date(
                    lastRun.createdAt,
                ).toLocaleString(
                    'tr-TR',
                );


            lastRunMeta.textContent =
                `${lastRun.browser} • ${Number(lastRun.duration).toFixed(2)}s • ${date}`;
        }

    } catch (error) {

        console.error(
            'Failed to fetch dashboard last run:',
            error,
        );
    }


    /* LAST GENERATED */

    try {

        const response =
            await fetch(
                '/api/generated-tests',
            );


        const result =
            await response.json();


        const tests =
            result.tests ||
            [];


        if (
            tests.length >
            0
        ) {

            const firstTest =
                tests[0];


            const fileName =
                typeof firstTest ===
                'string'

                    ? firstTest

                    : firstTest.fileName;


            lastGeneratedFile.textContent =
                fileName;


            appState.lastGeneratedFile =
                fileName;


            viewCodeButton.disabled =
                false;

            runLastGeneratedButton.disabled =
                false;

        } else {

            viewCodeButton.disabled =
                true;

            runLastGeneratedButton.disabled =
                true;
        }

    } catch (error) {

        console.error(
            'Failed to fetch dashboard generated test:',
            error,
        );
    }


    viewCodeButton.addEventListener(
        'click',
        async () => {

            if (
                !appState.lastGeneratedFile
            ) {
                return;
            }


            await openGeneratedTestCode(
                appState.lastGeneratedFile,
            );
        },
    );


    runLastGeneratedButton.addEventListener(
        'click',
        async () => {

            if (
                !appState.lastGeneratedFile
            ) {
                return;
            }


            await runExistingTest(
                appState.lastGeneratedFile,
                runLastGeneratedButton,
            );
        },
    );


    await checkSystemStatus();

    await loadDashboardRecentActivity();
}


/* -----------------------------------------------------
   RECENT ACTIVITY
   ------------------------------------------------------
   Quick Actions'tan boşalan alana eklendi. Sidebar'ın veya Quick Actions'ın tekrarı değil —
   sidebar'da hiçbir yerde görünmeyen, gerçekten yeni bir bilgi: son birkaç koşumun geç/kaldı
   özeti, kullanıcı Test Runs sayfasına gitmeden burada görebilsin diye. Reports sayfasındaki
   renderRecentActivity() ile aynı veri kaynağını (/api/test-runs) kullanıyor ama daha kısa bir
   liste (4 kayıt) ve Dashboard'a özgü kompakt bir görünümle.
----------------------------------------------------- */

async function loadDashboardRecentActivity() {

    const list =
        document.getElementById('dashboardRecentActivityList');

    const empty =
        document.getElementById('dashboardRecentActivityEmpty');

    if (!list || !empty) {
        return;
    }

    try {

        const response =
            await fetch('/api/test-runs');

        const result =
            await response.json();

        if (!response.ok) {
            throw new Error(
                result.message ||
                'Failed to load recent activity.',
            );
        }

        const runs =
            Array.isArray(result.runs)
                ? result.runs
                : [];

        const recentRuns =
            [...runs]
                .sort(
                    (firstRun, secondRun) =>
                        new Date(secondRun.createdAt || 0) -
                        new Date(firstRun.createdAt || 0),
                )
                .slice(0, 4);

        if (recentRuns.length === 0) {

            list.innerHTML = '';
            empty.classList.remove('hidden');
            return;
        }

        empty.classList.add('hidden');

        list.innerHTML =
            recentRuns
                .map((run) => {

                    const passed =
                        run.status === 'passed';

                    const statusIcon =
                        passed ? 'check_circle' : 'cancel';

                    const statusClass =
                        passed ? 'text-secondary' : 'text-error';

                    const badgeClass =
                        passed
                            ? 'text-secondary bg-secondary/10'
                            : 'text-error bg-error/10';

                    const executedDate =
                        run.createdAt
                            ? new Date(run.createdAt).toLocaleString('tr-TR')
                            : '-';

                    return `
                        <div
                            class="px-md py-sm
                                   hover:bg-surface-variant/30
                                   transition-colors
                                   flex items-center gap-3
                                   border-b border-outline-variant/50
                                   last:border-b-0"
                        >
                            <span class="material-symbols-outlined ${statusClass}">
                                ${statusIcon}
                            </span>

                            <span
                                class="font-code-md text-code-md
                                       text-on-surface truncate flex-1 min-w-0"
                            >
                                ${run.testFile || '-'}
                            </span>

                            <span
                                class="${badgeClass}
                                       font-body-sm text-body-sm
                                       px-1.5 rounded-sm shrink-0"
                            >
                                ${run.status || '-'}
                            </span>

                            <span
                                class="font-body-sm text-body-sm
                                       text-on-surface-variant shrink-0"
                            >
                                ${executedDate}
                            </span>
                        </div>
                    `;
                })
                .join('');

    } catch (error) {

        console.error(
            'Failed to load dashboard recent activity:',
            error,
        );

        list.innerHTML = '';
        empty.classList.remove('hidden');
        empty.textContent = 'Failed to load recent activity.';
    }
}


/* -----------------------------------------------------
   SYSTEM STATUS (Backend API / AI Provider / Test Runner)
   ------------------------------------------------------
   DÜZELTME: Bu 3 kutu önceden HTML'de sabit ("Ready"/"Online" hardcoded, hep yeşil) yazıyordu —
   backend çökse, API anahtarı silinse ya da bir test o an çalışıyor olsa bile HİÇBİR ŞEY
   değişmiyordu. Artık her Dashboard açılışında gerçek uçlar sorgulanıp duruma göre
   yeşil/kırmızı/mavi renklendiriliyor. "Playwright" kutusu bilinçli olarak DIŞARIDA — backend
   ayaktaysa Playwright zaten kurulu demektir, ayrı bir sağlık kontrolü anlamsız olurdu.
----------------------------------------------------- */

function setStatusTile(dotId, textId, text, colorClass) {

    const dot =
        document.getElementById(dotId);

    const label =
        document.getElementById(textId);

    if (!dot || !label) {
        return;
    }

    dot.className =
        `w-1.5 h-1.5 rounded-full ${colorClass}`;

    label.textContent =
        text;
}


async function checkSystemStatus() {

    /* BACKEND API */

    try {

        const response =
            await fetch('/api/health');

        setStatusTile(
            'statusBackendDot',
            'statusBackendText',
            response.ok ? 'Online' : 'Error',
            response.ok ? 'bg-secondary' : 'bg-error',
        );

    } catch (error) {

        console.error(
            'Backend health check failed:',
            error,
        );

        setStatusTile(
            'statusBackendDot',
            'statusBackendText',
            'Offline',
            'bg-error',
        );
    }


    /* AI PROVIDER */

    try {

        const response =
            await fetch('/api/settings');

        const data =
            await response.json();

        const providerLabel =
            data.llm.provider === 'openrouter'
                ? 'OpenRouter'
                : data.llm.provider === 'gemini'
                    ? 'Gemini'
                    : 'Ollama';

        // v2.3 — Ollama'da eksik olan şey bir "API anahtarı" değil, OLLAMA_MODEL (bkz.
        // settingsLlmInfo bölümündeki AYNI ayrım) — durum etiketini ona göre yazıyoruz.
        const notConfiguredSuffix =
            data.llm.provider === 'ollama'
                ? ' (Not configured)'
                : ' (No API Key)';

        setStatusTile(
            'statusProviderDot',
            'statusProviderText',
            data.llm.apiKeyConfigured
                ? providerLabel
                : `${providerLabel}${notConfiguredSuffix}`,
            data.llm.apiKeyConfigured ? 'bg-secondary' : 'bg-error',
        );

    } catch (error) {

        console.error(
            'Failed to fetch AI provider status:',
            error,
        );

        setStatusTile(
            'statusProviderDot',
            'statusProviderText',
            'Unknown',
            'bg-error',
        );
    }


    /* TEST RUNNER */

    try {

        const response =
            await fetch('/api/tests/current-run-id');

        const data =
            await response.json();

        setStatusTile(
            'statusRunnerDot',
            'statusRunnerText',
            data.runId ? 'Running' : 'Ready',
            data.runId ? 'bg-primary' : 'bg-secondary',
        );

    } catch (error) {

        console.error(
            'Failed to fetch test runner status:',
            error,
        );

        setStatusTile(
            'statusRunnerDot',
            'statusRunnerText',
            'Unknown',
            'bg-error',
        );
    }
}


/* =========================================================
   HEADER ENGINE STATUS (sitewide — her sayfada görünür)
   ------------------------------------------------------
   DÜZELTME: Bu rozet önceden HTML'de sabit ("Engine Online", hep yeşil nokta) yazıyordu —
   backend çökse bile hiçbir şey değişmiyordu. Dashboard'daki 4 durum kutusunu gerçek hale
   getirdiğimizde bu, header'da unutulmuştu. Artık gerçek /api/health uç noktasını kontrol
   edip renkleniyor. Dashboard'daki kutulardan farklı olarak bu rozet TÜM sayfalarda görünür
   olduğu için sadece sayfa açılışında değil, periyodik olarak da (30 saniyede bir) tazeleniyor
   — kullanıcı Dashboard'da olmasa bile backend çökerse fark edebilsin diye.
========================================================= */

async function refreshHeaderEngineStatus() {

    const dot =
        document.getElementById('headerEngineStatusDot');

    const label =
        document.getElementById('headerEngineStatusText');

    // Mobil üst çubuktaki kompakt nokta — metin yok (yer kısıtlı), sadece renk. Masaüstü
    // rozetiyle AYNI /api/health sonucunu yansıtır; iki ayrı fetch atmaya gerek yok.
    const mobileDot =
        document.getElementById('mobileEngineStatusDot');

    if (!dot || !label) {
        return;
    }

    try {

        const response =
            await fetch('/api/health');

        const dotClass =
            `w-2 h-2 rounded-full ${response.ok ? 'bg-secondary' : 'bg-error'}`;

        dot.className =
            dotClass;

        if (mobileDot) {
            mobileDot.className = `${dotClass} shrink-0`;
        }

        label.textContent =
            response.ok ? 'Engine Online' : 'Engine Offline';

    } catch (error) {

        console.error(
            'Failed to check header engine status:',
            error,
        );

        dot.className =
            'w-2 h-2 rounded-full bg-error';

        if (mobileDot) {
            mobileDot.className = 'w-2 h-2 rounded-full bg-error shrink-0';
        }

        label.textContent =
            'Engine Offline';
    }
}


/* =========================================================
   MOBILE NAVIGATION EVENTS
========================================================= */

if (mobileMenuButton) {
    mobileMenuButton.addEventListener('click', () => {
        toggleMobileSidebar();
    });
}

if (closeSidebarButton) {
    closeSidebarButton.addEventListener('click', () => {
        closeMobileSidebar();
    });
}

if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
        closeMobileSidebar();
    });
}

// Tek, kalıcı bir Escape dinleyicisi yeterli (modallerin aksine sidebar sık sık açılıp
// kapandığı için her seferinde addEventListener/removeEventListener yapmaya gerek yok) —
// sadece sidebar GERÇEKTEN açıkken (ekran dışına kaydırılmamışsa) kapatır.
document.addEventListener('keydown', (event) => {

    if (event.key !== 'Escape' || !sidebarNav) {
        return;
    }

    if (!sidebarNav.classList.contains('-translate-x-full')) {
        closeMobileSidebar();
    }
});


/* =========================================================
   SIDEBAR EVENTS
========================================================= */

dashboardMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'dashboard',
        );
    },
);


suitesMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'suites',
        );
    },
);


createTestMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'create',
        );
    },
);


suggestionsMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'suggestions',
        );
    },
);


generatedTestsMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'generated',
        );
    },
);


testRunsMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'runs',
        );
    },
);


reportsMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo(
            'reports',
        );
    },
);


adminPanelMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo('admin');
    },
);


/* =========================================================
   SETTINGS MENU
========================================================= */

settingsMenu.addEventListener(
    'click',
    (event) => {

        event.preventDefault();

        navigateTo('settings');
    },
);


/* =========================================================
   NOT YET IMPLEMENTED
========================================================= */

helpButton.addEventListener(
    'click',
    () => {

        showToast(
            'TestPilot AI help documentation will be added later.',
            'info',
        );
    },
);


/* =========================================================
   APP LOGIN GATE
   ------------------------------------------------------
   v3.0 Faz 2.1 — uygulama başlamadan ÖNCE (navigateTo('dashboard') çağrılmadan önce) oturum
   kontrol edilir. Giriş yoksa TÜM app (sidebar dahil) #appLoginGate'in ARKASINDA kalır — normal
   uygulama başlatma (startApp()) sadece giriş başarılı olduktan SONRA çalışır.
========================================================= */

function hideAppLoginGate() {
    appLoginGate.classList.add('hidden');
}

function showAppLoginGate() {
    appLoginGate.classList.remove('hidden');
    appLoginPasswordInput.value = '';
}

// v3.0 Faz 5.2 — TEK global Logout butonu (bkz. index.html USER CARD NOT'u — eski logout butonu
// sadece admin-panel.html içindeydi, MEMBER kullanıcılar o sayfayı artık hiç görmediği için
// buraya, sidebar'a taşındı/eklendi). admin-panel.html'nin KENDİ logout butonu (adminLogoutButton)
// hâlâ duruyor — admin kullanıcılar için zararsız bir tekrar, kaldırmaya gerek yok.
sidebarLogoutButton.addEventListener('click', async () => {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
        console.error(error);
    }
    applyLoggedInUser(null);
    appLoginUsernameInput.value = '';
    showAppLoginGate();
});

function startApp() {
    navigateTo('dashboard');

    // Header rozeti sayfa açılışında hemen kontrol edilir, ardından kullanıcı hangi sayfada
    // olursa olsun backend durumu güncel kalsın diye periyodik olarak tazelenir.
    void refreshHeaderEngineStatus();

    setInterval(
        refreshHeaderEngineStatus,
        30000,
    );
}

appLoginForm.addEventListener('submit', async (event) => {

    event.preventDefault();

    appLoginError.classList.add('hidden');
    appLoginError.textContent = '';
    appLoginSubmitButton.disabled = true;

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: appLoginUsernameInput.value.trim(),
                password: appLoginPasswordInput.value,
            }),
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error?.message || 'Sign in failed.');
        }

        applyLoggedInUser(result.user);
        hideAppLoginGate();
        startApp();

    } catch (error) {
        console.error(error);
        appLoginError.textContent = error instanceof Error ? error.message : 'Sign in failed.';
        appLoginError.classList.remove('hidden');
    } finally {
        appLoginSubmitButton.disabled = false;
    }
});

// Sayfa yüklenince mevcut bir oturum var mı diye kontrol et — varsa login gate'i hiç göstermeden
// doğrudan uygulamayı başlat, yoksa kullanıcı login formunda kalır (gate zaten varsayılan olarak
// görünür, bkz. index.html).
(async function checkAppAuth() {
    try {
        const response = await fetch('/api/auth/me');

        if (response.ok) {
            const result = await response.json();
            applyLoggedInUser(result.user);
            hideAppLoginGate();
            startApp();
        }
        // response.ok DEĞİLSE hiçbir şey yapma — gate zaten görünür durumda, kullanıcı login
        // formunu dolduracak.
    } catch (error) {
        console.error(error);
        // Backend'e hiç ulaşılamıyorsa da (ör. sunucu henüz ayağa kalkmadı) gate görünür kalır —
        // en azından kullanıcı boş/bozuk bir sayfa yerine anlamlı bir ekranla karşılaşır.
    }
})();