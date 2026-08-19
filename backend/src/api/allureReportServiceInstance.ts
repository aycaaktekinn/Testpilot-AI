import { AllureReportService } from '../core/legacy/AllureReportService.js';

// legacyTestServiceInstance.ts ile aynı desen: süreç ömrü boyunca yaşayan tek bir paylaşılan
// örnek — hem LegacyTestService (her run sonunda sonuç yazmak için) hem allure route'u (rapor
// üretmek/durumunu sorgulamak için) AYNI örneği kullanır.
export const allureReportService = new AllureReportService();
