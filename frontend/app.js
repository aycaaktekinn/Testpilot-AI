console.log('TESTPILOT AI APP LOADED');


/* =========================================================
   GLOBAL ELEMENTS
========================================================= */

const pageContent = document.getElementById('pageContent');
const pageSubtitle = document.getElementById('pageSubtitle');

const dashboardMenu = document.getElementById('dashboardMenu');
const createTestMenu = document.getElementById('createTestMenu');
const suggestionsMenu = document.getElementById('suggestionsMenu');
const generatedTestsMenu = document.getElementById('generatedTestsMenu');
const testRunsMenu = document.getElementById('testRunsMenu');
const reportsMenu = document.getElementById('reportsMenu');

const settingsMenu = document.getElementById('settingsMenu');
const helpButton = document.getElementById('helpButton');

// Mobil navigasyon (hamburger menü / kayar sidebar) için — bkz. dosya sonundaki
// "MOBILE NAVIGATION" bölümü.
const sidebarNav = document.getElementById('sidebarNav');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const mobileMenuButton = document.getElementById('mobileMenuButton');
const closeSidebarButton = document.getElementById('closeSidebarButton');


/* =========================================================
   UTILITIES
========================================================= */

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
        createTestMenu,
        suggestionsMenu,
        generatedTestsMenu,
        testRunsMenu,
        reportsMenu,
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

    if (pageName === 'settings') {
        await initSettingsPage();
    }
}


/* =========================================================
   CREATE TEST PAGE
========================================================= */

function initCreateTestPage() {

    const targetUrlInput =
        document.getElementById('targetUrl');

    const testScenarioInput =
        document.getElementById('testScenario');


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


    const generatedCodePanel =
        document.getElementById('generatedCodePanel');

    const executionLogPanel =
        document.getElementById('executionLogPanel');

    const testResultPanel =
        document.getElementById('testResultPanel');


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


    function formatLiveStepLine(step) {

        const target =
            step.decision?.targetRef
                ? ` -> ${step.decision.targetRef}`
                : '';

        const status =
            step.actionResult?.ok
                ? 'OK'
                : 'FAIL';

        return `[Step ${step.stepIndex + 1}] ${step.decision?.action}${target} | ${status}: ${step.actionResult?.message}`;
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

    showPanel('code');
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


                    // "Replay (No AI)" butonu SADECE bu testi üreten koşum PASSED ile bittiyse ve
                    // kayıtlı replaySteps varsa gösterilir (bkz. backend LegacyGeneratedTestMeta.replaySteps
                    // dosya başı açıklaması) — bu şekilde kullanıcı hangi testlerin AI'sız tekrar
                    // oynatılabileceğini butonun varlığından anlar, ayrıca bir açıklamaya gerek kalmaz.
                    const hasReplay =
                        typeof test !==
                        'string' &&
                        Array.isArray(
                            test.replaySteps,
                        ) &&
                        test.replaySteps.length >
                        0;

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
                                                    font-mono
                                                    text-sm
                                                    text-primary-fixed
                                                    break-all
                                                "
                                            >
                                                ${fileName}
                                            </span>

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


                                    ${
                                        hasReplay
                                            ? `
                                    <button
                                        class="
                                            replayGeneratedTestButton
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
                                        title="Re-run this test's recorded steps without calling the AI"
                                        type="button"
                                    >

                                        <span
                                            class="
                                                material-symbols-outlined
                                                text-[16px]
                                            "
                                        >
                                            replay
                                        </span>

                                        Replay (No AI)

                                    </button>
                                    `
                                            : ''
                                    }


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


                        await runExistingTest(
                            fileName,
                            button,
                        );
                    },
                );
            });


        document
            .querySelectorAll(
                '.replayGeneratedTestButton',
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


                        await replayExistingTest(
                            fileName,
                            button,
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
                            });

                            liveStepsByFile.set(
                                fileName,
                                list,
                            );

                            renderGeneratedTests();

                        } else if (data.type === 'batch_retry_started') {

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


        appState.pendingGeneratedCode =
            result.code;


        appState.pendingGeneratedFile =
            result.fileName;


        await navigateTo(
            'create',
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


/* =========================================================
   RUN EXISTING TEST
========================================================= */

async function runExistingTest(
    fileName,
    button = null,
) {

    if (button) {

        button.disabled =
            true;

        button.textContent =
            'Running...';
    }


    try {

        const response =
            await fetch(
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


    try {

        const response =
            await fetch(
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


    settingsBrowserInputs.forEach(
        (input) => {
            input.addEventListener(
                'change',
                saveSettingsFromForm,
            );
        },
    );

    [
        settingsHeadedMode,
        settingsScreenshotOption,
        settingsVideoOption,
        settingsTraceOption,
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
            infoTile('API Key', apiKeyStatus) +
            infoTile('Headless (default)', data.playwright.headless ? 'Yes' : 'No');


        settingsAgentInfo.innerHTML =
            infoTile('Min. Confidence', data.agent.minConfidence) +
            infoTile('Max Steps', data.agent.maxSteps) +
            infoTile('Loop Tolerance', `${data.agent.maxRepeatedActions} repeats`) +
            infoTile('Step Timeout', `${data.agent.stepTimeoutMs} ms`) +
            infoTile('Navigation Timeout', `${data.playwright.navigationTimeoutMs} ms`) +
            infoTile('Action Timeout', `${data.playwright.defaultActionTimeoutMs} ms`);

        // v2.0 — bkz. GET /api/settings → seleniumGrid.configured (hub adresinin KENDİSİ BİLEREK
        // dönülmez/gösterilmez, sadece "yapılandırılmış mı" bilgisi).
        const gridStatus =
            data.seleniumGrid?.configured
                ? '<span class="text-secondary">✓ Configured</span>'
                : '<span class="text-on-surface-variant">✗ Not configured</span>';

        settingsSeleniumGridInfo.innerHTML =
            infoTile('Hub Status', gridStatus);

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
   APPLICATION START
========================================================= */

navigateTo('dashboard');

// Header rozeti sayfa açılışında hemen kontrol edilir, ardından kullanıcı hangi sayfada
// olursa olsun backend durumu güncel kalsın diye periyodik olarak tazelenir.
void refreshHeaderEngineStatus();

setInterval(
    refreshHeaderEngineStatus,
    30000,
);