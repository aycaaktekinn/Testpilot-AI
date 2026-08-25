-- =====================================================================
-- v3.0 Faz 2.3 — LDAP yapılandırması (Admin Panel "LDAP" sekmesi).
--
-- TEK SATIR deseni: şirketin LDAP sunucusu tektir, bu yüzden "birden
-- fazla LDAP config" kavramı yok — CONFIG_ID her zaman 1 olacak şekilde
-- CHECK constraint ile zorlanır (ldapConfigStore.ts bunu bir upsert/MERGE
-- ile kullanır, birden fazla satır asla oluşmaz).
--
-- MANAGER_PASSWORD asla düz metin (plaintext) SAKLANMAZ — uygulama
-- katmanında (secretCrypto.ts, AES-256-GCM) şifrelendikten SONRA buraya
-- yazılır, bu yüzden sütun adı bilerek MANAGER_PASSWORD_ENCRYPTED.
-- =====================================================================

CREATE TABLE LDAP_CONFIG (
  CONFIG_ID                  NUMBER PRIMARY KEY,
  LDAP_URL                   VARCHAR2(500),
  BASE_DN                    VARCHAR2(500),
  MANAGER_DN                 VARCHAR2(500),
  -- Şifreli değer + IV + auth tag birlikte tek metin sütununda tutulur (bkz. secretCrypto.ts
  -- encryptSecret() çıktı formatı) — ayrı sütunlara bölmek okunabilirlik/rotasyon açısından
  -- bir kazanç sağlamıyor, tek sütun daha az yer kaplıyor.
  MANAGER_PASSWORD_ENCRYPTED VARCHAR2(1000),
  USER_DN_PATTERN            VARCHAR2(500),
  USER_SEARCH_FILTER         VARCHAR2(500),
  GROUP_SEARCH_BASE          VARCHAR2(500),
  GROUP_SEARCH_FILTER        VARCHAR2(500),
  PASSWORD_ENCODER_TYPE      VARCHAR2(20) DEFAULT 'NO' NOT NULL,
  UPDATED_AT                 TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  UPDATED_BY                 NUMBER,
  CONSTRAINT CK_LDAP_CONFIG_SINGLETON CHECK (CONFIG_ID = 1),
  CONSTRAINT CK_LDAP_CONFIG_ENCODER CHECK (
    PASSWORD_ENCODER_TYPE IN ('NO', 'PLAIN', 'SHA', 'LDAP_SHA', 'MD4', 'MD5')
  ),
  CONSTRAINT FK_LDAP_CONFIG_UPDATED_BY FOREIGN KEY (UPDATED_BY) REFERENCES USERS (USER_ID)
);
