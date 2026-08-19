import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { AgentDecision, ReplayStep, RunArtifacts, RunOptions, RunReport, StepLogEntry } from '../../domain/types.js';
import { BrowserManager } from '../browser/BrowserManager.js';
import { dismissConsentBanners } from '../browser/ConsentBannerHandler.js';
import { DomAnalyzer } from '../dom/DomAnalyzer.js';
import { ActionExecutor } from '../actions/ActionExecutor.js';
import { SecretsVault } from '../secrets/SecretsVault.js';
import { RunLogger } from '../logging/RunLogger.js';
import { LoopGuard } from './LoopGuard.js';
import type { LlmProvider } from '../llm/LlmProvider.js';
import { buildSystemMessage, buildUserMessage, type HistoryEntry } from '../llm/PromptBuilder.js';
import { parseAgentDecision } from '../llm/ResponseParser.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';
import type { AgentEventListener } from './types.js';
import { LlmConfigurationError } from '../../domain/errors.js';

const log = createLogger('AgentLoop');

const TERMINAL_ACTIONS = new Set(['finish_success', 'finish_failure', 'ask_clarification']);
const MAX_LLM_RETRIES_PER_STEP = 2;

export interface AgentLoopInput {
  runId: string;
  url: string;
  scenario: string;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  options: RunOptions;
  /**
   * Verilirse, AgentLoop LLM'e HİÇ danışmaz — bunun yerine bu diziyi sırayla, aynen kaydedildiği
   * gibi oynatır ("Replay (No AI)"). Her adımdan önce yine de canlı bir DOM taraması yapılır
   * (Playwright'ın gerçek, o anki elementlere ihtiyacı vardır) ve hedef elementin kimliği
   * (`ReplayTargetSnapshot`) doğrulanır — uyuşmazlık ya da eksik element varsa run güvenli
   * şekilde ve hemen (bir sonraki adıma geçmeden) durdurulur, çünkü LLM'in aksine burada
   * adapte olabilecek bir karar verici yoktur.
   */
  replaySteps?: ReplayStep[];
}

export class AgentLoop {
  constructor(
    private readonly llm: LlmProvider,
    private readonly onEvent?: AgentEventListener,
  ) {}

  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  async run(input: AgentLoopInput): Promise<RunReport> {
    const { runId, url, scenario, options } = input;
    const vault = new SecretsVault(input.variables, input.secrets);
    const runLogger = new RunLogger(runId, url, scenario, new Date().toISOString());
    const loopGuard = new LoopGuard(options.maxRepeatedActions);
    const browserManager = new BrowserManager();
    const domAnalyzer = new DomAnalyzer();
    const executor = new ActionExecutor();

    const history: HistoryEntry[] = [];
    let llmCallCount = 0;

    // "Replay (No AI)" modu: girdi olarak kayıtlı bir karar dizisi verilmişse LLM'e HİÇ danışılmaz
    // (bkz. AgentLoopInput.replaySteps dosya başı açıklaması). Normal (AI) modda ise, run PASSED
    // ile biterse bu run'ın adımlarından ileride replay için kullanılabilecek bir dizi burada
    // toplanır (bkz. aşağıdaki "REPLAY ADIMI TOPLAMA" bloğu).
    const isReplay = Boolean(input.replaySteps && input.replaySteps.length > 0);
    const collectedReplaySteps: ReplayStep[] = [];

    // Tüm çıkış yolları (PASS/FAIL/ERROR/CANCELLED) buradan geçer, böylece 'run_finished'
    // olayının her koşulda tam olarak bir kez yayınlanması garanti edilir.
    const finishRun = async (status: RunReport['status'], failureReason?: string): Promise<RunReport> => {
      // replaySteps SADECE run PASSED ile bittiyse eklenir (bkz. RunReport.replaySteps dosya başı
      // açıklaması) — replay modundaysak zaten kullandığımız diziyi olduğu gibi geri taşırız (bu
      // sayede bir replay'in kendisi de PASSED biterse, TEKRAR replay edilebilir kalır).
      const replayStepsForReport = status === 'passed' ? (isReplay ? input.replaySteps : collectedReplaySteps) : undefined;
      const report = await runLogger.finalize(status, llmCallCount, failureReason, replayStepsForReport);
      this.emit({ type: 'run_finished', runId, status, report });
      return report;
    };

    this.emit({ type: 'run_started', runId, url, scenario });

    const artifactsDir = path.join(path.resolve(env.ARTIFACTS_DIR), runId);
    const videoDir = path.join(artifactsDir, 'video');
    const screenshotPath = path.join(artifactsDir, 'screenshot.png');
    const tracePath = path.join(artifactsDir, 'trace.zip');
    const needsArtifactsDir = options.captureScreenshot || options.captureVideo || options.captureTrace;

    try {
      // LLM yapılandırmasını (API anahtarı + modelin bu hesap/endpoint için gerçekten kullanılabilir
      // olduğunu) DOĞRULA — Playwright/tarayıcıyı hiç başlatmadan ÖNCE. Böylece geçersiz/artık
      // kullanılamayan bir model (örn. 404 model_not_found) yüzünden gereksiz yere gerçek bir
      // tarayıcı oturumu açılıp hemen ardından hata ile kapatılmaz. Hata `LlmConfigurationError`
      // ise aşağıdaki catch bloğu bunu 'configuration_error:' öneki ile işler.
      // Replay modunda LLM'e HİÇ danışılmayacağı için (bkz. isReplay), bir LLM yapılandırma
      // doğrulamasına da gerek yoktur — bu sayede API anahtarı geçersiz/tükenmiş olsa bile
      // daha önce başarıyla tamamlanmış bir testi AI'sız tekrar oynatmak çalışmaya devam eder.
      if (!isReplay && this.llm.validateConfig) {
        await this.llm.validateConfig();
      }

      if (needsArtifactsDir) {
        await mkdir(options.captureVideo ? videoDir : artifactsDir, { recursive: true });
      }

      // `let`: bir click aksiyonu YENİ bir sekme açarsa (bkz. BrowserManager.adoptNewestPageIfOpened
      // dosya başındaki NOT), aktif sayfa referansı bu döngü boyunca değişebilir.
      let page = await browserManager.launch(options, videoDir);
      await page.goto(url, { timeout: options.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
      // İlk yüklemeden hemen sonra görünen çerez/onay banner'larını temizle (bkz. dosya başındaki NOT).
      await dismissConsentBanners(page);

      for (let stepIndex = 0; stepIndex < options.maxSteps; stepIndex++) {
        if (this.cancelled) {
          return await finishRun('cancelled', 'Kullanıcı tarafından iptal edildi');
        }

        // hepsiburada.com üzerinde canlı olarak gözlemlendi: banner ilk yüklemede DEĞİL, birkaç
        // saniye SONRA (ör. bir kullanıcı etkileşiminin ardından) beliriyor ve sonraki adımdaki
        // click/press_key işlemlerini "element etkileşilebilir değil" TIMEOUT'una düşürüyor. Bu
        // yüzden temizliği tek seferlik değil, HER ADIMDAN ÖNCE tekrarlıyoruz — banner yoksa bu
        // çağrı neredeyse anında (birkaç ms) döner, normal akışı YAVAŞLATMAZ.
        await dismissConsentBanners(page);

        const stepStarted = Date.now();
        const { snapshot, registry } = await domAnalyzer.analyze(page, options);

        let decision: AgentDecision | null = null;

        if (isReplay) {
          // Kayıtlı adımlar bittiyse ama henüz bir terminal karara (finish_success/finish_failure)
          // ulaşılmadıysa — normalde OLMAMASI gereken, savunma amaçlı bir durum (bkz.
          // ReplayStep dosya başı açıklaması: son adım her zaman terminal bir karar olmalı).
          const recorded = input.replaySteps![stepIndex];
          if (!recorded) {
            return await finishRun('error', 'replay_exhausted: kayıtlı adımlar bir terminal karara ulaşmadan bitti');
          }
          // confidence: 1 — replay'de gerçek bir LLM güveni yok; bunu 1 vererek aşağıdaki
          // "Güvenlik kapısı 1" (düşük güven) kodunu HİÇ değiştirmeden, doğal olarak atlatıyoruz.
          decision = {
            action: recorded.action,
            targetRef: recorded.targetRef,
            value: recorded.value,
            confidence: 1,
            reasoning: 'Kayıtlı adım yeniden oynatılıyor (AI çağrısı yapılmadı)',
          };
        } else {
          let lastParseError = '';

          for (let attempt = 0; attempt <= MAX_LLM_RETRIES_PER_STEP; attempt++) {
            const messages = [
              buildSystemMessage(),
              buildUserMessage({
                scenario,
                startUrl: url,
                snapshot,
                history,
                vault,
                stepIndex,
                maxSteps: options.maxSteps,
              }),
            ];
            if (attempt > 0) {
              messages.push({
                role: 'user',
                content: `Önceki yanıtın geçersizdi: ${lastParseError}. Lütfen SADECE geçerli JSON döndür.`,
              });
            }

            llmCallCount++;
            let raw: string;
            try {
              raw = await this.llm.complete(messages);
            } catch (err) {
              if (err instanceof LlmConfigurationError) {
                // Yapılandırma hataları (örn. model artık kullanılamıyor) RETRY EDİLEMEZ — aynı
                // isteği tekrar göndermek aynı sonucu üretir. 3 kez denemek yerine hemen dışarı
                // fırlat; dış try/catch bloğu bunu 'configuration_error:' öneki ile işleyip run'ı
                // anında 'error' durumunda sonlandırır.
                throw err;
              }
              // Ağ hatası / zaman aşımı: JSON-doğrulama hatalarıyla aynı yeniden deneme yoluna
              // düşür — tek bir yavaş/başarısız istek yüzünden tüm run'ı hemen "error" ile bitirme.
              lastParseError = err instanceof Error ? err.message : String(err);
              log.warn({ runId, stepIndex, attempt, error: lastParseError }, 'LLM çağrısı başarısız, tekrar deneniyor');
              continue;
            }

            const parsed = parseAgentDecision(raw);

            if (parsed.ok) {
              decision = parsed.decision;
              break;
            }
            lastParseError = parsed.error;
            // NOT: modelin ürettiği ham metni loglamak GÜVENLİDİR — secret DEĞERLERİ hiçbir zaman
            // LLM'e gönderilmiyor (sadece "{{secret.AD}}" gibi placeholder adları), dolayısıyla
            // model çıktısında da gerçek bir secret değeri asla olamaz. Bu, "neden geçersiz JSON
            // üretti" sorusunu tahmin etmek yerine loglardan doğrudan görebilmek için ekli.
            log.warn(
              { runId, stepIndex, attempt, error: parsed.error, rawResponsePreview: raw.slice(0, 800) },
              'LLM yanıtı doğrulanamadı, tekrar deneniyor',
            );
          }

          if (!decision) {
            return await finishRun('error', `LLM geçerli bir karar üretemedi: ${lastParseError}`);
          }
        }

        // İptal isteği (Stop) LLM çağrısı SÜRERKEN gelmiş olabilir — `this.cancelled` daha önce
        // sadece adım DÖNGÜSÜNÜN BAŞINDA kontrol ediliyordu, yani Stop'a basıldıktan sonra bile
        // LLM çağrısı BİTMİŞ olsa dahi aksiyon (potansiyel olarak yavaş, stepTimeoutMs'e kadar
        // sürebilen bir Playwright işlemi) YİNE DE çalıştırılıyordu — kullanıcı arayüzünde "durdu"
        // yazsa bile ajanın bir süre daha çalışmaya devam ettiği izlenimine yol açıyordu (canlıda
        // gözlemlendi). Aksiyonu hiç ÇALIŞTIRMADAN önce burada tekrar kontrol ederek bu süreyi
        // kısaltıyoruz. (LLM çağrısının kendisini yarıda kesmek LlmProvider'a bir AbortController
        // geçirmeyi gerektirir — bu ayrı ve daha büyük bir değişiklik; burada asıl kazanç, LLM
        // yanıtı geldikten SONRA en azından bir sonraki yavaş adımı hiç başlatmamak.)
        if (this.cancelled) {
          return await finishRun('cancelled', 'Kullanıcı tarafından iptal edildi');
        }

        // Güvenlik kapısı 1: düşük güven -> yanlış elemente dokunmak yerine güvenli dur.
        if (decision.confidence < options.minConfidence && !TERMINAL_ACTIONS.has(decision.action)) {
          const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, {
            ok: false,
            message: 'Güven eşiğinin altında; güvenlik nedeniyle durduruldu',
            errorCode: 'INVALID_ACTION',
          }, Date.now() - stepStarted);
          runLogger.addStep(stepLog);
          this.emit({ type: 'step', runId, step: stepLog });
          return await finishRun('failed', `ambiguous_step: güven=${decision.confidence.toFixed(2)} - ${decision.reasoning}`);
        }

        // Güvenlik kapısı 2: bilinmeyen secret/variable referansı -> çalıştırma, güvenli dur.
        const unknownRefs = vault.findUnknownReferences(decision.value);
        if (unknownRefs.length > 0) {
          const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, {
            ok: false,
            message: `Tanımsız referans(lar): ${unknownRefs.join(', ')}`,
            errorCode: 'INVALID_ACTION',
          }, Date.now() - stepStarted);
          runLogger.addStep(stepLog);
          this.emit({ type: 'step', runId, step: stepLog });
          return await finishRun('failed', `unknown_reference: ${unknownRefs.join(', ')}`);
        }

        // REPLAY ADIMI TOPLAMA (sadece AI modunda): gate 1 ve 2'yi geçmiş, gerçek/geçerli her karar
        // (terminal kararlar dahil) burada toplanır. Run PASSED ile biterse (bkz. finishRun), bu
        // dizi RunReport.replaySteps olarak dışarı taşınır — run FAILED/ERROR ile biterse hiç
        // kullanılmaz (finishRun zaten status !== 'passed' olduğunda bu diziyi rapora eklemez).
        if (!isReplay) {
          const targetEl = decision.targetRef ? snapshot.elements.find((e) => e.ref === decision.targetRef) : undefined;
          collectedReplaySteps.push({
            action: decision.action,
            targetRef: decision.targetRef,
            value: decision.value,
            targetElementSnapshot: targetEl
              ? { tag: targetEl.tag, role: targetEl.role, accessibleName: targetEl.accessibleName }
              : undefined,
          });
        }

        if (TERMINAL_ACTIONS.has(decision.action)) {
          const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, {
            ok: true,
            message: decision.summary ?? decision.reasoning,
          }, Date.now() - stepStarted);
          runLogger.addStep(stepLog);
          this.emit({ type: 'step', runId, step: stepLog });

          if (decision.action === 'finish_success') {
            return await finishRun('passed');
          }
          const reason = decision.summary ?? decision.reasoning;
          return await finishRun('failed', reason);
        }

        // Güvenlik kapısı 3 (SADECE replay modunda): kayıtlı hedef element hâlâ aynı mı? Sayfa
        // yapısı orijinal koşumdan bu yana değiştiyse (ör. yeni bir element eklendi, sıralama
        // kaydı), aynı ref numarası artık FARKLI bir elemente karşılık gelebilir — LLM'in aksine
        // burada adapte olabilecek bir karar verici olmadığından, bu durumda YANLIŞ elemente
        // aksiyon uygulamak yerine run hemen ve güvenli şekilde durdurulur.
        if (isReplay && decision.targetRef) {
          const recorded = input.replaySteps![stepIndex];
          const currentEl = snapshot.elements.find((e) => e.ref === decision.targetRef);
          const expected = recorded?.targetElementSnapshot;
          const mismatch =
            !currentEl ||
            (expected !== undefined &&
              (currentEl.tag !== expected.tag ||
                currentEl.role !== expected.role ||
                currentEl.accessibleName !== expected.accessibleName));

          if (mismatch) {
            const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, {
              ok: false,
              message: 'Kayıtlı hedef element bu sayfada artık bulunamadı ya da değişmiş görünüyor',
              errorCode: 'ELEMENT_NOT_FOUND',
            }, Date.now() - stepStarted);
            runLogger.addStep(stepLog);
            this.emit({ type: 'step', runId, step: stepLog });
            return await finishRun(
              'failed',
              'replay_mismatch: sayfa değişmiş olabilir, kayıtlı adım güvenli şekilde tekrar oynatılamadı — "Run" (AI ile) ile tekrar deneyin.',
            );
          }
        }

        // Güvenlik kapısı 4: döngü / tekrar tespiti.
        const { stuck } = loopGuard.record(decision, snapshot.stateHash);
        if (stuck) {
          const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, {
            ok: false,
            message: 'Aynı aksiyon sayfa durumu değişmeden tekrar edildi (döngü tespit edildi)',
            errorCode: 'INVALID_ACTION',
          }, Date.now() - stepStarted);
          runLogger.addStep(stepLog);
          this.emit({ type: 'step', runId, step: stepLog });
          return await finishRun('failed', 'loop_detected: aynı aksiyon tekrar tekrar deneniyor');
        }

        const urlBeforeAction = snapshot.url;
        const resolvedValue = vault.resolve(decision.value);
        const actionResult = await this.withTimeout(
          executor.execute(page, decision, resolvedValue, registry, options),
          options.stepTimeoutMs,
        );

        // Replay modunda bir aksiyon başarısız olursa devam ETMEYİZ: normal AI modunda LLM bir
        // sonraki adımda bunu görüp farklı bir yol deneyebilir, ama replay'de sabit bir senaryoyu
        // körü körüne oynatıyoruz — bir adım beklenmedik şekilde başarısız olduysa (sayfa
        // değişmiş, geçici bir hata vb.) kalan adımları da büyük ihtimalle bozacaktır. Bu yüzden
        // ilk başarısızlıkta hemen ve anlaşılır bir mesajla durup AI'lı "Run"a yönlendiriyoruz.
        if (isReplay && !actionResult.ok) {
          const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, actionResult, Date.now() - stepStarted);
          runLogger.addStep(stepLog);
          this.emit({ type: 'step', runId, step: stepLog });
          return await finishRun(
            'failed',
            `replay_step_failed: ${actionResult.message} — sayfa değişmiş olabilir, "Run" (AI ile) ile tekrar deneyin.`,
          );
        }

        // hepsiburada.com üzerinde canlı olarak gözlemlendi: bir click sayfa navigasyonuna yol
        // açtığında (ör. giriş sayfasına geçiş), BİR SONRAKİ adımın DOM taraması navigasyondan
        // hemen sonra, SPA (React/Vue vb.) daha hiç render/hydrate OLMADAN çalışıyordu — element
        // listesi boş dönüyor, model de bunu "captcha/engel olabilir" diye yorumlayıp düşük bir
        // confidence veriyor ve güvenlik eşiği run'ı durduruyordu (yanlış negatif — sayfa aslında
        // engellenmiş değildi, sadece henüz yüklenmemişti). URL bu aksiyon sırasında değiştiyse,
        // bir sonraki DOM taramasından ÖNCE kısa bir "yerleşme" payı veriyoruz. Bu ekstra bir LLM
        // çağrısı GEREKTİRMEZ (LLM'e hiç danışılmaz) ve URL değişmediyse (elementler arası normal
        // tıklamalarda) devreye hiç girmez.
        //
        // hepsiburada.com üzerinde AYRICA canlı olarak gözlemlendi: bir ürün kartı linki
        // `target="_blank"` ile YENİ BİR SEKMEDE açılıyordu — bu durumda orijinal sayfanın URL'si
        // HİÇ DEĞİŞMİYOR (yukarıdaki kontrol bunu yakalayamaz), ajan hâlâ eski (artık arkaplanda
        // kalmış) sekmeyi taramaya devam ediyor, orada hiçbir şey değişmediği için aynı elemente
        // tekrar tekrar tıklayıp döngü korumasına takılıyordu. `adoptNewestPageIfOpened()` yeni bir
        // sekme açıldıysa aktif `page` referansını ona geçirir (LLM'e danışmadan, otomatik).
        const switchedTab = await browserManager.adoptNewestPageIfOpened();
        if (switchedTab) {
          page = browserManager.getPage();
          log.debug({ runId, stepIndex, newUrl: page.url() }, 'Aksiyon yeni bir sekme açtı; aktif sekme değiştirildi');
        }

        if (switchedTab || page.url() !== urlBeforeAction) {
          await page.waitForLoadState('domcontentloaded', { timeout: options.navigationTimeoutMs }).catch(() => undefined);
          await page.waitForTimeout(500);
        } else if (decision.action === 'press_key' && (resolvedValue ?? '').toLowerCase() === 'enter') {
          // hepsiburada.com üzerinde canlı olarak gözlemlendi: bir arama kutusunda Enter'a basmak
          // URL'i HER ZAMAN anında değiştirmiyor — SPA arama sonucunu asenkron (AJAX/history API ile
          // biraz GECİKMELİ) getirebiliyor. Yukarıdaki URL-değişti kontrolü bu durumu YAKALAYAMAZ
          // (URL henüz değişmemiştir), bir sonraki adımın DOM taraması güncelleme tamamlanmadan ÖNCE
          // çalışır, model hâlâ eski (sonuçsuz) sayfayı görüp "sonuç gelmedi, Enter'a tekrar basayım"
          // diye karar verir — aynı Enter gereksiz yere art arda birkaç kez daha denenir (canlıda
          // gözlemlendi: aynı arama kutusuna 3 kez üst üste Enter). URL değişmese bile Enter'dan
          // sonra kısa bir yerleşme payı vererek bu gereksiz tekrarları azaltıyoruz — LLM'e hiç
          // danışılmaz (ekstra bir LLM çağrısı YOKTUR), ve Enter DIŞINDAKİ aksiyonları etkilemez.
          await page.waitForTimeout(800);
        }

        const stepLog = this.buildStepLog(stepIndex, snapshot.url, decision, vault, actionResult, Date.now() - stepStarted);
        runLogger.addStep(stepLog);
        this.emit({ type: 'step', runId, step: stepLog });

        history.push({
          stepIndex,
          decision: { action: decision.action, targetRef: decision.targetRef, reasoning: decision.reasoning },
          maskedValue: vault.maskForLog(decision.value),
          resultOk: actionResult.ok,
          resultMessage: actionResult.message,
        });
        // Prompt boyutunu kontrol altında tutmak için geçmişi sınırla.
        if (history.length > 12) history.shift();
      }

      return await finishRun('failed', 'max_steps_reached: azami adım sayısına ulaşıldı');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // LlmConfigurationError'lar 'configuration_error:' öneki ile işaretlenir — böylece hem
      // loglarda hem de frontend'e dönen sonuçta bunun bir SİTE/SENARYO hatası değil, .env
      // yapılandırma hatası olduğu bariz olur.
      const prefixedMessage = err instanceof LlmConfigurationError ? `configuration_error: ${message}` : message;
      log.error({ err, runId }, 'AgentLoop beklenmeyen hata ile durdu');
      this.emit({ type: 'run_error', runId, message: prefixedMessage });
      return await finishRun('error', prefixedMessage);
    } finally {
      // Kanıt yakalama en iyi çaba (best-effort) prensibiyle çalışır: herhangi bir aşaması
      // başarısız olursa run'ın PASS/FAIL sonucunu asla etkilemez, sadece loglanır.
      try {
        const artifacts: RunArtifacts = {};

        if (options.captureScreenshot) {
          const ok = await browserManager.captureScreenshot(screenshotPath);
          if (ok) artifacts.screenshotPath = screenshotPath;
        }
        if (options.captureTrace) {
          const ok = await browserManager.stopTracing(tracePath);
          if (ok) artifacts.tracePath = tracePath;
        }

        const closeResult = await browserManager.close();
        if (closeResult.videoPath) artifacts.videoPath = closeResult.videoPath;

        // NOT: 'run_finished' WS olayı bu bloktan ÖNCE, finishRun() içinde yayınlanmıştı — bu yüzden
        // canlı WS aboneleri kanıt yollarını göremeyebilir. attachArtifacts() zaten döndürülmüş olan
        // rapor nesnesini (aynı referans) yerinde günceller ve diskteki JSON'ı yeniden yazar; bu sayede
        // GET /api/runs/:id/report ile sonradan sorgulayan ya da run() Promise'ini await eden çağıranlar
        // (örn. legacy uyum katmanı) kanıt yollarını eksiksiz görür.
        await runLogger.attachArtifacts(artifacts);
      } catch (artifactErr) {
        log.warn({ artifactErr, runId }, 'Kanıt (screenshot/video/trace) yakalama sırasında hata (yok sayıldı)');
        await browserManager.close().catch(() => undefined);
      }
    }
  }

  private buildStepLog(
    stepIndex: number,
    url: string,
    decision: AgentDecision,
    vault: SecretsVault,
    actionResult: StepLogEntry['actionResult'],
    durationMs: number,
  ): StepLogEntry {
    return {
      stepIndex,
      timestamp: new Date().toISOString(),
      url,
      decision: {
        ...decision,
        reasoning: vault.redactSecretValuesFromText(decision.reasoning),
        value: decision.value ? vault.maskForLog(decision.value) : undefined,
      },
      maskedValue: vault.maskForLog(decision.value),
      actionResult: {
        ...actionResult,
        message: vault.redactSecretValuesFromText(actionResult.message),
      },
      durationMs,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    // Zaman aşımı durumunda orijinal promise arka planda devam edebilir (Playwright bunu iptal etmez);
    // bu yüzden olası bir reddi burada yakalayıp "unhandled rejection" uyarısını engelliyoruz.
    promise.catch(() => undefined);

    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Adım zaman aşımına uğradı (${ms}ms)`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private emit(event: Parameters<AgentEventListener>[0]): void {
    this.onEvent?.(event);
  }
}
