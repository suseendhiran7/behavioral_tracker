# Behavioral Fingerprinting Platform — Internal Technical Audit Notes

**Document Classification:** Internal Technical Audit (Strictly Confidential — Not for External Distribution)  
**Repository:** `behavioral_tracker`  
**Audit Date:** October 2026  
**Auditor:** Senior Solution Architect & Behavioral Biometrics Engineering Review  

---

## 1. Executive Summary of Audit

This internal technical audit provides an authoritative gap analysis and discrepancy report following a comprehensive code-level inspection of the `behavioral_tracker` codebase. The primary objective of this review is to document discrepancies, architectural nuances, missing integration glue, and unverified assumptions before releasing client-facing integration documentation to our banking client.

Overall, the core biometrics capture, event normalization, dual-database abstraction (PostgreSQL + MongoDB), session stitching, and explainable behavioral risk scoring are fully functional and substantiated by code evidence. However, several critical integration gaps, test runner mismatches, and route mounting issues were discovered that require immediate engineering attention.

---

## 2. Discrepancies and Code-Level Inconsistencies

### 2.1 Dual SDK Implementations (Monolithic vs. Modular vs. Modern Analytics)
* **Observed State:** The codebase contains three distinct SDK files across two directories:
  1. `behavioral_tracker_sdk/xylium-bf-v2.js`: Monolithic, browser-global IIFE registering `window.XyliumBF`. Ingests via `POST /collect` with payload `{ tenantId, appId, deviceFingerprint, events }`.
  2. `sdk/`: Modular architecture splitting the monolithic script into `xylium-core.js` and 13 individual pattern files (`xylium-mouse.js`, `xylium-keyboard.js`, etc.) communicating through `window.XyliumBFModules`.
  3. `behavioral_tracker_sdk/analytics-tracker.js`: Modern enterprise SDK (v2.1.0) exporting `BehaviourTracker` and `BehaviorSDK` (with UMD support and `BehaviorSDK.init()`). Emits 16 distinct event categories, derives local velocity/cadence features, supports JWT auth tokens, and ingests via `POST /api/analytics/events/batch` with canonical event schemas.
* **Finding:** `behavioral_tracker_sdk/test-page-v2.html` loads both `xylium-bf-v2.js` and `analytics-tracker.js` concurrently.
* **Impact & Client Guidance:** The client documentation must clearly distinguish these two SDK paradigms. `analytics-tracker.js` should be recommended as the enterprise standard for banking applications, while `sdk/xylium-core.js` is documented as the lightweight, modular alternative.

### 2.2 Unmounted Route: `/ip-intel`
* **Observed State:** The file `src/routes/ipIntel.js` implements a complete `GET /` router with IP rate limiting (`config.ipIntel.rateLimitWindowMs`), tenant verification (`tenantGuard`), client IP extraction, and lookup orchestration through `src/ipIntelService.js`.
* **Discrepancy:** In `src/app.js`, `healthRouter`, `collectRouter`, `identifyRouter`, `analyticsRouter`, and `adminDatabaseRouter` are mounted. However, `app.use('/ip-intel', ...)` is **NOT mounted anywhere in `src/app.js`**.
* **Impact:** Any HTTP GET requests to `/ip-intel` currently return `404 Not Found`. The modular SDK's `xylium-network-risk.js` relies on this endpoint for server-side IP risk signals (`is_vpn`, `is_proxy`, `is_datacenter`, `geo_is_new_country`).
* **Required Engineering Fix:** Add `const ipIntelRouter = require('./routes/ipIntel');` and `app.use('/ip-intel', ipIntelRouter);` to `src/app.js` before deploying network risk features.

### 2.3 Test Suite Framework Incompatibility
* **Observed State:** `package.json` defines `"test": "node --test --test-concurrency=1 tests/*.test.js"`.
* **Verified Test Results:**
  - `tests/analytics.test.js`: 29 subtests — **ALL 29 PASSED** (native `node:test`).
  - `tests/dual-database.test.js`: 16 subtests — **ALL 16 PASSED** (native `node:test`, testing PostgreSQL and MongoDB adapters, atomic switching, concurrency locks, and schema parity).
  - Total Passing Tests: **45 automated tests passing**.
* **Failure Discrepancy:**
  - `tests/collectService.test.js`, `tests/ipIntelService.test.js`, and `tests/validation.test.js` were written using Jest syntax (`jest.mock(...)`, `expect(...)`, `beforeEach(...)`).
  - When invoked by `node --test`, these files fail immediately with `ReferenceError: jest is not defined`.
* **Action Required:** Either convert the legacy Jest tests to Node's native `node:test` runner or install Jest in `devDependencies` and configure a separate npm test script for legacy unit tests.

### 2.4 Custom Pattern Upload Security (`/cp`)
* **Observed State:** `tools/customPatternRoute.js` provides a multipart upload route allowing administrators to upload `.js` behavioral pattern files. Code is validated against AST rules in `validate-custom-pattern.js`.
* **Security Risk:** The authentication middleware (`apiKeyGuard`) in `customPatternRoute.js` is currently commented out (`// router.use(apiKeyGuard);`), allowing unauthenticated uploads if exposed.
* **Audit Note:** This route is an internal developer tool and must **never** be exposed in client-facing environments without strictly enforcing server API key authentication and mutual TLS.

---

## 3. Verified Implementations vs. Architectural Assumptions

| Architectural Component | Verified Implementation in Code | Unverified Assumption / Limitation |
|---|---|---|
| **Dual Database Switching** | Fully verified via `DatabaseRegistry` and `DatabaseSwitchService`. Atomic adapter assignment, health check pre-validation, concurrency locks, and in-memory rollback are confirmed. | Switching changes read/write routing for future requests. **Historical data is not federated or automatically migrated** between databases. A dedicated ETL migration script is required if historical data unification is necessary. |
| **Privacy / PII Exclusion** | Fully verified. Keystrokes are masked to `'char'` or control names. `SENSITIVE_INPUT_REGEX` and `SENSITIVE_PROPERTY_REGEX` strip credentials, passwords, card numbers, OTPs, PINs, and SSNs. Clipboard content is discarded. | If a banking application uses unusual, non-standard field identifiers (e.g. `data-input="acc_secure"`), and omits standard HTML types or `data-bf-field`, field values could theoretically be touched if custom patterns bypass validation. Client must adhere to integration conventions. |
| **Identity Stitching** | Fully verified. Anonymous `sessionId` is created on page load. Once login succeeds, backend calls `/identify` (or `/api/analytics/sessions/link`), which backfills `userId` onto pre-login events in `login_events` and PostgreSQL/MongoDB. | Client backend must explicitly call the identity linking endpoint. If the bank fails to call `/identify`, pre-login events remain anonymous indefinitely. |
| **Behavioral Risk Scoring** | Fully verified in `src/riskService.js`. Computes continuous metrics: pointer velocity, straight-line bot checks, typing flight times, cadence, instant form submissions, and baseline deviations. Generates explainable risk signals (`SUPERHUMAN_TYPING_CADENCE`, etc.). | Risk scoring is probabilistic. It provides risk recommendations (`ALLOW`, `MONITOR`, `MANUAL_REVIEW`, `STEP_UP_AUTH`), but requires 3–5 historical sessions per user to establish individualized baselines. |
| **Network Intelligence** | Implemented in `src/ipIntelService.js` supporting IPQS and IPAPI providers with in-memory caching and private IP short-circuiting. | Unmounted in `app.js` (see Section 2.2). In addition, provider API keys (`IPQS_API_KEY`) require third-party commercial subscriptions not bundled with the application. |
| **Queue / Asynchronous Forwarding** | `src/forward/worker.js` and `queue.js` are stubbed. Forwarding to BullMQ/Redis is disabled. | Ingestion persistence is currently direct/synchronous to the active database. For high-volume banking traffic (>10,000 req/sec), an external message broker (Kafka/RabbitMQ/Redis) should be implemented. |

---

## 4. Outstanding Client Integration Requirements

Prior to production deployment at the client's banking infrastructure, the client must supply or configure the following technical items:

1. **Production Origin Allowlisting:** Provide exact production FQDNs (e.g., `https://online.nexusbank.com`) for configuration in `CORS_ORIGINS`. Wildcards (`*`) must be forbidden in production.
2. **Reverse Proxy & Trust Proxy Config:** Specify proxy hop counts or CIDR subnets (e.g., AWS ALB, Cloudflare, Akamai) for `TRUST_PROXY` to ensure `req.ip` reflects true client IPs rather than load balancer addresses.
3. **Secret API Key Generation:** Generate cryptographically secure 256-bit hex keys for `TENANT_API_KEYS` to authenticate server-to-server calls (`/identify`, `/api/analytics/sessions/link`).
4. **Content Security Policy (CSP) Updates:** Whitelist backend collector URLs in bank application CSP headers:
   - `script-src 'self' https://sdk.xylium-security.com;`
   - `connect-src 'self' https://collector.xylium-security.com;`
5. **Session & User Identifier Mapping:** Agree upon pseudonymous user identifier formats (e.g., internal hashed UUIDs rather than national tax IDs or raw bank account numbers).
6. **Synthetic Test Data:** Construct synthetic test scenarios (legitimate user navigation, simulated bot script with linear cursor paths, fast typing injections) for User Acceptance Testing (UAT).
7. **Database Storage Sizing:** Establish operational retention policies (`RAW_TTL_DAYS`) and database storage scaling based on projected monthly transaction and login volumes.

---

## 5. Summary and Recommendations

The core Behavioral Fingerprinting platform is sound, architecturally robust, and adheres strictly to banking-grade data minimization standards. The client-facing documentation should provide complete transparency regarding the dual SDK architecture, copy-ready code snippets for both MPA and SPA frameworks, complete database configuration details, and an honest representation of current capabilities versus integration prerequisites.
