-- =====================================================================
-- v3.0 Faz 5 — WEB_GLOBAL_SETTINGS: proje bazlı OLMAYAN, tüm sisteme ait tek
-- bir yapılandırma satırı. İLK KULLANIMI: Grid URL.
--
-- NEDEN: WEB_PROJECTS.GRID_URL (Faz 1'de eklenmişti) sohbette fark edildi ki
-- run yürütme koduna (BrowserManager.ts) HİÇ BAĞLANMAMIŞTI — sadece
-- .env'deki SELENIUM_GRID_URL kullanılıyordu. Kullanıcı proje bazlı Grid
-- URL yerine TEK/sabit bir Grid URL istedi; bu tablo o tek değeri
-- Admin Panel üzerinden (backend'i yeniden başlatmadan) değiştirilebilir
-- kılar. WEB_LDAP_CONFIG İLE AYNI TEK SATIR deseni (CONFIG_ID her zaman 1).
-- =====================================================================

CREATE TABLE WEB_GLOBAL_SETTINGS (
  CONFIG_ID   NUMBER PRIMARY KEY,
  GRID_URL    VARCHAR2(500),
  UPDATED_AT  TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  UPDATED_BY  NUMBER,
  CONSTRAINT CK_GLOBAL_SETTINGS_SINGLETON CHECK (CONFIG_ID = 1),
  CONSTRAINT FK_GLOBAL_SETTINGS_UPDATED_BY FOREIGN KEY (UPDATED_BY) REFERENCES WEB_USERS (USER_ID)
);
