const fs = require('fs');
const path = require('path');
const docx = require('docx');
const {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  ImageRun,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  TableOfContents,
  Packer,
} = docx;

const {
  p,
  h1,
  h2,
  h3,
  bullet,
  callout,
  codeBlock,
  createTable,
  COLOR_PRIMARY,
  COLOR_NAVY,
  COLOR_BLUE,
  COLOR_MUTED,
  COLOR_TEXT,
  COLOR_BORDER,
} = require('./doc_helpers');

function buildDocument() {
  const children = [];

  // ==========================================
  // COVER PAGE
  // ==========================================
  children.push(
    new Paragraph({
      spacing: { before: 1800, after: 200 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: 'BEHAVIORAL FINGERPRINTING SDK',
          font: 'Arial',
          size: 44, // 22 pt
          bold: true,
          color: COLOR_NAVY,
          characterSpacing: 40,
        }),
      ],
    })
  );

  children.push(
    new Paragraph({
      spacing: { before: 0, after: 800 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: 'Technical Overview, SDK Integration and Enterprise Banking Deployment Guide',
          font: 'Arial',
          size: 24, // 12 pt
          color: COLOR_BLUE,
          bold: true,
        }),
      ],
    })
  );

  // Decorative divider
  children.push(
    new Table({
      width: { size: 40, type: WidthType.PERCENTAGE },
      alignment: AlignmentType.CENTER,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 12, color: COLOR_BLUE },
        bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE },
        right: { style: BorderStyle.NONE },
      },
      rows: [new TableRow({ children: [new TableCell({ children: [] })] })],
    })
  );

  // Metadata block
  children.push(
    new Paragraph({
      spacing: { before: 1400, after: 120 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'Prepared for: ', font: 'Arial', size: 22, bold: true, color: COLOR_MUTED }),
        new TextRun({ text: 'Banking Client Technical Architecture & Security Review Team', font: 'Arial', size: 22, bold: true, color: COLOR_PRIMARY }),
      ],
    })
  );

  children.push(
    new Paragraph({
      spacing: { before: 100, after: 100 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'SDK Specification Version: ', font: 'Arial', size: 20, color: COLOR_MUTED }),
        new TextRun({ text: 'v2.1.0 (Enterprise GA)', font: 'Arial', size: 20, bold: true, color: COLOR_TEXT }),
      ],
    })
  );

  children.push(
    new Paragraph({
      spacing: { before: 100, after: 100 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'Document Date: ', font: 'Arial', size: 20, color: COLOR_MUTED }),
        new TextRun({ text: 'October 2026', font: 'Arial', size: 20, bold: true, color: COLOR_TEXT }),
      ],
    })
  );

  children.push(
    new Paragraph({
      spacing: { before: 100, after: 1600 },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: 'Document Reference: ', font: 'Arial', size: 20, color: COLOR_MUTED }),
        new TextRun({ text: 'XYL-BF-ARCH-2026-V2.1', font: 'Consolas', size: 20, color: COLOR_MUTED }),
      ],
    })
  );

  // Confidentiality Notice
  children.push(
    callout(
      'COMMERCIAL CONFIDENTIALITY NOTICE',
      'This document contains proprietary technical architecture, API specifications, and behavioral security integration guidelines prepared exclusively for authorized technical evaluation by the Banking Client. Unauthorized reproduction, transmission, distribution, or public disclosure without prior written consent is strictly prohibited.',
      'warn'
    )
  );

  // Page break after cover
  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // TABLE OF CONTENTS
  // ==========================================
  children.push(h1('Table of Contents'));
  children.push(
    p(
      'This document provides an end-to-end technical reference for integrating, configuring, deploying, and operating the Behavioral Fingerprinting Platform in enterprise banking environments. In Microsoft Word, right-click the table below and select "Update Field" to refresh page numbers.',
      { italics: true, color: COLOR_MUTED }
    )
  );

  children.push(
    new TableOfContents('Table of Contents', {
      hyperlink: true,
      headingStyleRange: '1-3',
    })
  );

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 1. EXECUTIVE SUMMARY
  // ==========================================
  children.push(h1('1. Executive Summary'));

  children.push(
    p(
      'The Behavioral Fingerprinting Platform is a bank-grade client security telemetry and biometrics intelligence solution designed to safeguard customer sessions against automated attacks, synthetic bot interaction, credential stuffing, and unauthorized account takeovers (ATO). By unobtrusively capturing continuous user interaction dynamics—such as micro-pointer trajectories, typing flight/hold cadences, touch pressures, scroll kinematics, and device contexts—the platform constructs an explainable, continuous behavioral profile without introducing frictional CAPTCHAs or interrupting legitimate digital banking journeys.'
    )
  );

  children.push(h2('1.1 Why a Bank Uses Behavioral Biometrics'));
  children.push(
    p(
      'Traditional banking perimeter defenses (e.g., passwords, SMS OTPs, and device cookies) operate deterministically at discrete authentication gates. However, modern adversary toolkits routinely circumvent these static controls via credential stuffing, phishing proxies (Evilginx), SIM-swapping, and session-token hijacking. The Behavioral Fingerprinting Platform addresses these challenges by introducing continuous, post-login behavioral verification:'
    )
  );

  children.push(bullet('Detects automated headless browsers (Puppeteer, Selenium, Playwright) and scripted injection attacks through millisecond-level motor rhythm analysis and cursor trajectory curvature evaluation.', 'Automated Threat Neutralization:'));
  children.push(bullet('Identifies when a compromised session is taken over by an unauthorized third party whose typing cadence, mouse dynamics, and navigational rhythm deviate sharply from the established customer profile.', 'Account Takeover (ATO) Prevention:'));
  children.push(bullet('Flags high-value wire transfers, beneficiary updates, and checkout completions that execute instantly without preceding cursor movement, tactile touches, or visual focus events.', 'Fraudulent Payment & Transfer Defense:'));
  children.push(bullet('Operates entirely in the background without requiring user prompts, biometric hardware scanners, or intrusive challenge screens.', 'Frictionless Customer Experience:'));

  children.push(h2('1.2 Platform Component Roles'));
  children.push(
    p(
      'The complete end-to-end architecture is comprised of four tightly integrated tiers verified in the codebase:'
    )
  );

  children.push(createTable(
    ['Tier / Component', 'Physical Source Location', 'Primary Enterprise Responsibility'],
    [
      ['Client-Side SDK', 'behavioral_tracker_sdk/analytics-tracker.js & sdk/xylium-core.js', 'Captures passive interaction dynamics, enforces strict client-side PII stripping, normalizes telemetry, and manages buffered, resilient HTTPS transmission.'],
      ['Ingestion API Gateway', 'src/app.js & src/routes/collect.js & src/routes/analytics.js', 'Enforces tenant authorization (tenantGuard), API rate limiting, trusted-proxy extraction, JSON body validation via Zod, and beacon parsing.'],
      ['Identity Stitching & Risk Engine', 'src/collectService.js & src/riskService.js', 'Performs server-to-server identity linking, backfills pre-login interaction telemetry, computes biometric features, and outputs explainable risk scores.'],
      ['Dual Database Layer', 'src/database/adapters/ (PostgreSQL + MongoDB)', 'Provides an enterprise database-agnostic repository interface supporting both ACID relational storage (PostgreSQL) and JSON document collections (MongoDB) with zero-downtime hot-switching.'],
      ['Administration & Visualizer Dashboards', 'behavioral_tracker_sdk/ (admin-database.html, user-inspector.html)', 'Permits authorized administrators to monitor adapter latency, execute live database switches, inspect single-user journeys, and review real-time biometric risk signals.']
    ],
    [25, 30, 45]
  ));

  children.push(
    callout(
      'CRITICAL PRINCIPLE: PROBABILISTIC NATURE OF BEHAVIORAL BIOMETRICS',
      'Behavioral biometrics produce probabilistic anomaly indicators, risk scores, and confidence intervals—they do not provide deterministic, legally conclusive proof of a user’s identity or fraud. Legitimate human variability (e.g., hand fatigue, mobile versus desktop usage, trackpad transitions, or assistive technologies) can influence interaction cadence. Consequently, high behavioral risk scores must trigger adaptive verification (such as step-up multi-factor authentication or manual fraud review) rather than automated, punitive account terminations.',
      'info'
    )
  );

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 2. SYSTEM OVERVIEW AND ARCHITECTURE
  // ==========================================
  children.push(h1('2. System Overview and Architecture'));

  children.push(
    p(
      'The Behavioral Fingerprinting architecture follows a decoupled, resilient ingestion pattern specifically tailored for banking web applications and single-page applications (SPAs). Telemetry flows strictly unidirectionally from the client browser to the backend ingestion layer, where it is validated, tenant-scoped, and persisted into the active database adapter.'
    )
  );

  // Insert Architecture Diagram Image if exists
  const diagramPath = path.join(__dirname, 'architecture_diagram.png');
  if (fs.existsSync(diagramPath)) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 120 },
        children: [
          new ImageRun({
            data: fs.readFileSync(diagramPath),
            transformation: {
              width: 620, // max width for A4 with 1-inch margins (approx 6.2 inches)
              height: 380,
            },
          }),
        ],
      })
    );
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 200 },
        children: [
          new TextRun({
            text: 'Figure 2.1: End-to-End Behavioral Fingerprinting Platform Architecture & Ingestion Flow',
            font: 'Arial',
            size: 18,
            italics: true,
            color: COLOR_MUTED,
          }),
        ],
      })
    );
  }

  children.push(h2('2.1 Verified Component Breakdown and Event Flow'));
  children.push(
    p(
      'The verified application contains the following architectural components and boundaries:'
    )
  );

  children.push(bullet('The client-facing banking portal (HTML/CSS/JS or React/Next.js SPA) hosting user sessions, authentication forms, account dashboards, and financial transfer flows.', '1. Bank Website / Application:'));
  children.push(bullet('The embedded script (analytics-tracker.js or modular xylium-core.js) executing passively in the browser runtime under strict isolation.', '2. Embedded Behavioral SDK:'));
  children.push(bullet('Initialization settings verifying tenantId, appId, batch thresholds, sampling rates, and privacy consent status before attaching global DOM listeners.', '3. SDK Config & Consent Gate:'));
  children.push(bullet('Normalizes raw DOM interactions into canonical schemas (event.schema.js), calculates local feature vectors (cadence, velocity), and scrubs all sensitive values.', '4. Client Event Normalization:'));
  children.push(bullet('Transmits batches via HTTPS POST using keepalive fetch, falling back to navigator.sendBeacon during page unload and tab hidden states.', '5. Resilient Network Transport:'));
  children.push(bullet('Express server parsing application/json and text/plain beacon payloads, enforcing IP rate limits (3,000 req/min) and Zod schema validation.', '6. Backend Gateway & Parser:'));
  children.push(bullet('tenantGuard validates the tenantId against the configured ALLOWED_TENANTS allowlist. Server-to-server endpoints enforce apiKeyGuard with timing-safe comparisons.', '7. Tenant Authorization Guard:'));
  children.push(bullet('DatabaseRegistry delegates event persistence to the currently active adapter (PostgreSQLAdapter or MongoDBAdapter), preserving tenant isolation.', '8. Dual Persistence Layer:'));
  children.push(bullet('Consumes stored telemetry to extract trajectory straightness, superhuman typing speeds, and baseline deviations, yielding 0–100 risk evaluations.', '9. Behavioral Risk Scoring Engine:'));
  children.push(bullet('Web interfaces (admin-database.html, user-inspector.html) allowing operations teams to manage database health, switch storage engines, and inspect user risk profiles.', '10. Operations & Admin Dashboards:'));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 3. HOW THE APPLICATION WORKS
  // ==========================================
  children.push(h1('3. How the Application Works'));

  children.push(
    p(
      'The complete operational lifecycle spans client-side instrumentation, asynchronous transmission, server-side identity resolution, and behavioral risk evaluation. Below is the precise 10-step lifecycle followed by a concrete banking scenario.'
    )
  );

  children.push(h2('3.1 The 10-Step Operational Lifecycle'));

  children.push(bullet('The bank embeds the verified SDK script (analytics-tracker.js or modular xylium-core.js) on authorized login, dashboard, and payment pages.', 'Step 1: Client Embedding.'));
  children.push(bullet('The SDK initializes with the bank’s tenantId, appId, collector endpoint URL, batchSize, and flush intervals.', 'Step 2: Initialization & Identity Setup.'));
  children.push(bullet('The SDK generates an anonymous sessionId (persisted in sessionStorage) and anonymousId (persisted in localStorage). A cryptographic device fingerprint is derived from hardware properties.', 'Step 3: Anonymous Pseudonymization.'));
  children.push(bullet('If requireConsent is active, the SDK suppresses capture until window.XyliumBF.grantConsent() is invoked. Upon consent, initial device and time context snapshots are generated.', 'Step 4: Consent Verification.'));
  children.push(bullet('As the user interacts, passive listeners capture pointer movements, keypress flight times, scroll milestones, and form focus events. Raw typed values are immediately masked to generic tokens.', 'Step 5: Event Capture & Normalization.'));
  children.push(bullet('Events accumulate in an in-memory ring buffer (up to batchSize = 25 or 100). When the buffer fills or the flush timer expires (5,000ms), events are dispatched over HTTPS.', 'Step 6: Buffered Dispatch.'));
  children.push(bullet('The backend gateway parses incoming payloads, verifies tenant legitimacy, validates event properties with Zod, and resolves the client’s real IP address via trusted reverse-proxy headers.', 'Step 7: Gateway Validation.'));
  children.push(bullet('When credentials are verified on the bank’s core authentication server, the bank’s backend calls POST /identify (or /sessions/link) server-to-server. The collector binds the canonical customer userId and backfills it onto pre-login events.', 'Step 8: Authoritative Identity Stitching.'));
  children.push(bullet('The EventService stores normalized event documents in the active database (PostgreSQL table events or MongoDB collection behaviour_events).', 'Step 9: Database Persistence.'));
  children.push(bullet('The bank queries GET /api/analytics/sessions/:sessionId/risk to retrieve explainable anomaly signals (e.g. superhuman cadence, linear cursor trajectory) to drive step-up authentication decisions.', 'Step 10: Behavioral Risk Analysis.'));

  children.push(h2('3.2 Realistic Banking User Session Walkthrough'));
  children.push(
    p(
      'To illustrate the operational flow in practice, consider a customer named Alice accessing her online banking portal:'
    )
  );

  children.push(bullet('Alice arrives at https://online.nexusbank.com/login. The SDK initializes anonymously with sessionId="sess_9b8a2f" and userId=null. The SDK captures her screen resolution (1920x1080), browser locale, and battery level (84%, discharging).', 'Phase 1: Anonymous Login Navigation.'));
  children.push(bullet('Alice types her username "alice_smith". The SDK records keydown and keyup events with keyMasked="char", holdTimeMs=85, and flightTimeMs=120. Next, she clicks the password field (fieldId="password"). She types her 16-character password; the SDK captures 16 keypress events with keyMasked="char" and hold times. Zero password characters or strings are ever captured or stored in memory.', 'Phase 2: Typing Biometrics & Privacy Scrubbing.'));
  children.push(bullet('Alice moves her cursor toward the "Sign In" button. The SDK records a curved trajectory across 42 sample points, an approach angle of 34 degrees, and a 380ms hover dwell time before clicking. A batch of 35 events flushes to POST /collect.', 'Phase 3: Pointer Trajectory & Flush.'));
  children.push(bullet('The bank’s core identity service validates Alice’s credentials. Upon successful authentication, the bank’s server issues a POST /identify request to the collector with sessionId="sess_9b8a2f" and verified userId="cust_84920". The collector marks the session authenticated and updates all earlier pre-login events with cust_84920.', 'Phase 4: Server-Side Identity Stitching.'));
  children.push(bullet('Alice navigates to /transfers/international and initiates a $5,000 wire transfer. The SDK fires account_page_view and payment_flow_start. The risk engine evaluates her session: motor jitter is natural, typing cadence is 4.2 keys/sec (consistent with human baseline), and trajectory curvature is organic. The resulting risk score is 12/100 (LOW, ALLOW).', 'Phase 5: Authenticated Banking & Low Risk Verdict.'));
  children.push(bullet('Contrast scenario: If an automated script had injected Alice’s credentials, submitted the login form in 18ms with 0 pointer movements, and triggered an immediate wire transfer, the risk engine flags SYNTHETIC_POINTER_TRAJECTORY and AUTOMATED_FORM_INJECTION, yielding a risk score of 85/100 (CRITICAL, STEP_UP_AUTH). The bank prompts for hardware security key verification, successfully thwarting account takeover.', 'Phase 6: Automated Attack Mitigation.'));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 4. DATA COLLECTION AND PRIVACY
  // ==========================================
  children.push(h1('4. Data Collection and Privacy'));

  children.push(
    p(
      'Data minimization and privacy-by-design are central to the Behavioral Fingerprinting SDK. The system captures how a user interacts with a page, rather than what data the user enters. The table below details every data category, verified against the actual schema and SDK code.'
    )
  );

  children.push(h2('4.1 Verified Data Collection Matrix'));

  children.push(createTable(
    ['Data Category', 'Example Data Fields in Code', 'Biometric / Operational Purpose', 'Collection Mechanism', 'Req / Opt', 'Status in Code'],
    [
      ['Session Identity', 'sessionId, anonymousId, tenantId, clientId, userId (post-auth)', 'Binds interaction sequences to session lifecycles and customer profiles.', 'sessionStorage / localStorage UUID generation.', 'Required', 'Fully Implemented'],
      ['Pointer Dynamics', 'pointerX, pointerY, speedPxPerMs, angleDeg, isStraightLine, hoverDurationMs', 'Evaluates human motor tremor, trajectory curvature, bot straightness, and dwell.', 'Throttled pointermove (50ms), pointerdown, mouseover listeners.', 'Required', 'Fully Implemented'],
      ['Keyboard Dynamics', 'keyMasked, flightTimeMs, holdTimeMs, keysPerSecond, isTypingPause', 'Captures keystroke rhythms, inter-key flight times, and typing cadences.', 'keydown, keyup event listeners with performance.now() deltas.', 'Required', 'Fully Implemented'],
      ['Form Interactions', 'fieldId, fieldCategory, fromField, toField, durationMs, pasteDetected', 'Tracks focus order, dwell time per field, and non-typed paste injections.', 'focusin, focusout, paste, and CSS animation autofill watcher.', 'Required', 'Fully Implemented'],
      ['Scroll Kinematics', 'scrollY, scrollDirection, scrollDeltaPx, scrollDepthPercent, scrollMilestone', 'Measures reading speeds, navigational acceleration, and page consumption.', 'Throttled window scroll listener (100ms) with depth calculation.', 'Optional', 'Fully Implemented'],
      ['Touch & Mobile', 'touchCount, durationMs, gestureType, swipeDirection, swipeDistancePx, orientation', 'Captures touch contact duration, swipe velocity, and device screen rotation.', 'touchstart, touchmove, touchend, and orientationchange listeners.', 'Optional', 'Fully Implemented'],
      ['Lifecycle & Nav', 'fromRoute, toRoute, navigationMethod, visibilityState, idleDurationMs, pageLoadTimeMs', 'Monitors SPA view switches, tab backgrounding, idle intervals, and load latency.', 'visibilitychange, pagehide, popstate, performance.timing APIs.', 'Required', 'Fully Implemented'],
      ['Banking Workflow', 'flowType, paymentId, paymentAmount, paymentCurrency, recipientType, challengeType', 'Correlates behavioral anomalies with high-risk financial workflow steps.', 'Explicit SDK calls (trackPaymentFlowStart, trackPaymentConfirmation).', 'Optional', 'Fully Implemented'],
      ['Device Metadata', 'deviceCategory, deviceOs, screenWidth, screenHeight, batteryLevel, isCharging', 'Establishes device baselines and flags virtualization or battery spoofing.', 'navigator.userAgent, window.screen, navigator.getBattery() API.', 'Optional', 'Fully Implemented'],
      ['Network Risk', 'isVpn, isProxy, isDatacenter, geoIsNewCountry, clientIp', 'Identifies commercial VPNs, proxies, and TOR exit nodes server-side.', 'Backend IP intelligence provider lookup (IPQS/IPAPI) on client IP.', 'Optional', 'Partially Implemented (Route unmounted in app.js)']
    ],
    [18, 22, 24, 18, 8, 10]
  ));

  children.push(h2('4.2 Sensitive Data Exclusions and Privacy Guarantees'));
  children.push(
    p(
      'Code inspection of analytics-tracker.js, xylium-bf-v2.js, and event.schema.js verifies the following strict privacy guarantees:'
    )
  );

  children.push(bullet('The maskKey() function inspects every keypress. If e.key is a printable character (length 1), it returns "char". If it is a navigation key (Backspace, Enter, Tab), it returns the key name. The actual character typed is never captured, buffered, or transmitted.', 'Zero Keystroke Content Capture:'));
  children.push(bullet('Verified regex SENSITIVE_INPUT_REGEX (/password|passwd|secret|cvv|cvc|card|credit|token|otp|pin|ssn|auth|account_?no/i) checks input element attributes (type, id, name). Any matching field has its fieldId redacted to "redacted_sensitive_field", and properties are scrubbed.', 'Credential and PIN Shielding:'));
  children.push(bullet('The paste event listener measures pastedText.length and detects whitespace/non-printable flags, but completely discards pastedText. No clipboard strings ever leave the browser.', 'Clipboard Content Exclusion:'));
  children.push(bullet('All events are transmitted over HTTPS/TLS, validated against Zod strict schemas, and stored with tenant scoping. Data can be permanently purged using the implemented DELETE /api/analytics/users/:userId endpoint.', 'Encryption and Right-to-be-Forgotten:'));

  children.push(
    callout(
      'BANKING DEPLOYMENT PRE-REQUISITE: CUSTOM INPUT FIELD NAMING CONVENTIONS',
      'While the SDK’s regex comprehensively filters standard HTML forms (type="password", name="cvv", etc.), banking clients utilizing proprietary custom Web Components must ensure that custom input elements either specify standard input types or include the attribute data-bf-field="password" or data-bf-field="sensitive". This ensures complete privacy shielding regardless of custom styling frameworks.',
      'warn'
    )
  );

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 5. COMPLETE EVENT CATALOGUE
  // ==========================================
  children.push(h1('5. Complete Event Catalogue'));

  children.push(
    p(
      'Every behavioral event supported across analytics-tracker.js, xylium-bf-v2.js, and the modular sdk/ pattern modules is categorized below. Each event includes its trigger condition, captured fields, and implementation location.'
    )
  );

  children.push(h2('5.1 Verified Event Inventory'));

  children.push(createTable(
    ['Event Name', 'Category', 'Trigger Condition', 'Captured Fields & Metrics', 'Code Location', 'Status'],
    [
      ['pointer_move / mousemove', 'pointer', 'Mouse or stylus moves across DOM viewport.', 'pointerX, pointerY, sampledIntervalMs', 'analytics-tracker.js:423, xylium-mouse.js', 'Fully Implemented'],
      ['pointer_velocity', 'pointer', 'Derived locally from consecutive cursor coordinates.', 'speedPxPerMs, angleDeg, isStraightLine, distancePx', 'analytics-tracker.js:436', 'Fully Implemented'],
      ['pointer_down / pointer_up', 'pointer', 'Primary pointer button pressed or released.', 'pointerX, pointerY, holdDurationMs, targetCategory, targetId', 'analytics-tracker.js:348, xylium-mouse.js', 'Fully Implemented'],
      ['pointer_click / click', 'pointer', 'Mouse click or pointer tap completed.', 'pointerX, pointerY, targetCategory, targetId, textPreview', 'analytics-tracker.js:372, xylium-mouse.js', 'Fully Implemented'],
      ['hover / hover_before_click', 'pointer', 'Cursor dwells over CTA or button before click.', 'targetId, targetCategory, hoverDurationMs, isZeroHover', 'analytics-tracker.js:460, xylium-bf-v2.js:327', 'Fully Implemented'],
      ['mouse_trajectory', 'pointer', 'Continuous drag or movement between down and up.', 'straightnessIndex, actualPathPx, straightLinePx, maxDeviationPx', 'xylium-bf-v2.js:243, xylium-mouse.js', 'Fully Implemented'],
      ['overshoot', 'pointer', 'Pointer travels past clickable target before correction.', 'didOvershoot, overshootPx, correctionMs, approachAngleDeg', 'xylium-bf-v2.js:299, xylium-mouse.js', 'Fully Implemented'],
      ['mouse_entropy', 'pointer', '50-sample cursor window angle variation analysis.', 'entropy, avgAngleChangeDeg, stdAngleChangeDeg', 'xylium-bf-v2.js:410, xylium-mouse.js', 'Fully Implemented'],
      ['key_down / keydown', 'keyboard', 'Key pressed down on keyboard.', 'keyMasked ("char"/control), fieldCategory, flightTimeMs', 'analytics-tracker.js:498, xylium-keyboard.js', 'Fully Implemented'],
      ['key_up / keyup', 'keyboard', 'Key released on keyboard.', 'keyMasked, fieldCategory', 'analytics-tracker.js:521, xylium-keyboard.js', 'Fully Implemented'],
      ['typing_dynamics / keytiming', 'keyboard', 'Flight time between successive keystrokes.', 'flightTimeMs, holdTimeMs, keysPerSecond, isTypingPause', 'analytics-tracker.js:506, xylium-bf-v2.js:450', 'Fully Implemented'],
      ['correction_key', 'keyboard', 'Backspace or Delete pressed during input.', 'key, holdTimeMs, isHeld, gapFromLastMs, burstIndex', 'xylium-bf-v2.js:473, xylium-keyboard.js', 'Fully Implemented'],
      ['field_focused / focus_change', 'form', 'User focuses an input field or switches fields.', 'fieldId, fieldCategory, fromField, toField', 'analytics-tracker.js:541, xylium-form.js', 'Fully Implemented'],
      ['field_interaction / field_time_spent', 'form', 'User blurs field after active editing.', 'fieldId, fieldCategory, durationMs, focusCount', 'analytics-tracker.js:562, xylium-bf-v2.js:632', 'Fully Implemented'],
      ['paste_detected / paste', 'form', 'Paste shortcut or context menu paste triggered.', 'pasteDetected, fieldId, isPasswordField, pastedLength', 'analytics-tracker.js:583, xylium-bf-v2.js:787', 'Fully Implemented'],
      ['autofill / autofill_summary', 'form', 'Browser autofill triggered on login inputs.', 'field, fillTimeMs, username_autofilled, password_autofilled', 'xylium-bf-v2.js:974, xylium-form.js', 'Fully Implemented'],
      ['scroll / scroll_milestone', 'scroll', 'Page scrolled to 25%, 50%, 75%, or 100% depth.', 'scrollY, scrollDirection, scrollDeltaPx, scrollMilestone', 'analytics-tracker.js:676, xylium-scroll.js', 'Fully Implemented'],
      ['touch_start / touch_end / swipe', 'touch', 'Touch gesture contact and swipe trajectory.', 'touchCount, durationMs, gestureType, swipeDirection, swipeDistancePx', 'analytics-tracker.js:608, xylium-touch.js', 'Fully Implemented'],
      ['session_start / session_end', 'lifecycle', 'Session initiated or terminated via pagehide.', 'sessionId, userAgent, referrer, reason', 'analytics-tracker.js:870, analytics-tracker.js:336', 'Fully Implemented'],
      ['page_navigation / page_entered', 'navigation', 'SPA route transition executed.', 'fromRoute, toRoute, navigationMethod, pageViewId', 'analytics-tracker.js:910, analytics-tracker.js:923', 'Fully Implemented'],
      ['login_attempt / login_success / login_failure', 'auth', 'Authentication workflow outcomes.', 'userId, method, reasonCode, route', 'analytics-tracker.js:956, analytics-tracker.js:972', 'Fully Implemented'],
      ['account_page_view', 'banking', 'Customer visits balance, transactions, or statements.', 'accountCategory, viewType, route', 'analytics-tracker.js:1007', 'Fully Implemented'],
      ['payment_flow_start / payment_confirmation', 'banking', 'Payment workflow initiated or completed.', 'flowType, paymentId, paymentAmount, paymentCurrency, paymentStatus', 'analytics-tracker.js:1015, analytics-tracker.js:1024', 'Fully Implemented'],
      ['transaction_failure', 'banking', 'Financial transfer rejected or failed.', 'reasonCode, flowType, route', 'analytics-tracker.js:1034', 'Fully Implemented'],
      ['step_up_auth_required', 'banking', '2FA challenge triggered by policy or risk score.', 'challengeType, trigger, route', 'analytics-tracker.js:1049', 'Fully Implemented']
    ],
    [18, 10, 22, 28, 14, 8]
  ));

  children.push(h2('5.2 Sanitized Real Event Payload Example'));
  children.push(
    p(
      'The JSON payload below represents a sanitized event batch generated by analytics-tracker.js and validated by event.schema.js during a high-value payment workflow:'
    )
  );

  children.push(
    codeBlock([
      '{',
      '  "events": [',
      '    {',
      '      "eventId": "evt_7f8a9b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c",',
      '      "sessionId": "sess_89a0b1c2-d3e4-5f6a-7b8c-9d0e1f2a3b4c",',
      '      "tenantId": "nexus_bank",',
      '      "clientId": "client_nexus_portal",',
      '      "userId": "cust_84920",',
      '      "eventName": "pointer_velocity",',
      '      "eventCategory": "pointer",',
      '      "timestamp": "2026-10-21T06:15:30.142Z",',
      '      "sequenceNumber": 142,',
      '      "page": "/transfers/international",',
      '      "sanitizedRoute": "/transfers/international",',
      '      "pointerX": 482,',
      '      "pointerY": 614,',
      '      "pointerSpeedPxPerMs": 1.28,',
      '      "pointerAngleDeg": 42,',
      '      "pointerDistancePx": 64,',
      '      "isStraightLine": false,',
      '      "deviceCategory": "desktop",',
      '      "deviceOs": "windows",',
      '      "deviceBrowser": "chrome",',
      '      "screenWidth": 1920,',
      '      "screenHeight": 1080,',
      '      "sdkVersion": "2.1.0",',
      '      "schemaVersion": "2.0"',
      '    },',
      '    {',
      '      "eventId": "evt_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",',
      '      "sessionId": "sess_89a0b1c2-d3e4-5f6a-7b8c-9d0e1f2a3b4c",',
      '      "tenantId": "nexus_bank",',
      '      "clientId": "client_nexus_portal",',
      '      "userId": "cust_84920",',
      '      "eventName": "payment_flow_start",',
      '      "eventCategory": "banking",',
      '      "timestamp": "2026-10-21T06:15:32.890Z",',
      '      "sequenceNumber": 143,',
      '      "page": "/transfers/international",',
      '      "sanitizedRoute": "/transfers/international",',
      '      "flowType": "wire_transfer",',
      '      "paymentAmount": 5000.00,',
      '      "paymentCurrency": "USD",',
      '      "recipientType": "international",',
      '      "sdkVersion": "2.1.0",',
      '      "schemaVersion": "2.0"',
      '    }',
      '  ]',
      '}'
    ])
  );

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 6. SDK INTEGRATION GUIDE FOR THE CLIENT
  // ==========================================
  children.push(h1('6. SDK Integration Guide for the Client'));

  children.push(
    p(
      'The bank can integrate the Behavioral Fingerprinting SDK using either the unified enterprise build (analytics-tracker.js) or the modular drop-in script (xylium-core.js). Both approaches run in all modern browsers (Chrome, Edge, Safari, Firefox) and require zero changes to existing banking business logic.'
    )
  );

  children.push(h2('6.1 Integration Option A: Unified Enterprise SDK (analytics-tracker.js)'));
  children.push(
    p(
      'Recommended for modern banking web portals and Single Page Applications (SPAs). This version bundles the full 16-category biometrics suite, JWT authentication handling, automatic flush management, and banking lifecycle methods.'
    )
  );

  children.push(h3('HTML Integration Example'));
  children.push(
    codeBlock([
      '<!-- 1. Include the SDK script -->',
      '<script src="https://cdn.nexusbank.com/sdk/analytics-tracker.js"></script>',
      '',
      '<!-- 2. Initialize the SDK singleton -->',
      '<script>',
      '  const tracker = BehaviorSDK.init({',
      '    apiEndpoint: "https://collector.nexusbank.com/api/analytics",',
      '    tenantId: "nexus_bank",',
      '    clientId: "portal_web",',
      '    batchSize: 25,',
      '    flushIntervalMs: 5000,',
      '    idleThresholdMs: 5000,',
      '    consent: true, // Set to false if awaiting explicit banner consent',
      '  });',
      '',
      '  // Wire up post-login identity linking',
      '  function onUserLoginSuccess(userId, jwtToken) {',
      '    tracker.loginSuccess(userId, jwtToken);',
      '  }',
      '',
      '  // Wire up banking workflow tracking',
      '  function onTransferInitiated(amount, currency) {',
      '    tracker.trackPaymentFlowStart("wire_transfer", currency, "domestic");',
      '  }',
      '</script>'
    ])
  );

  children.push(h3('React / Next.js Hook Integration'));
  children.push(
    codeBlock([
      'import { useEffect, useRef } from "react";',
      'import { usePathname } from "next/navigation";',
      '',
      'export function useBehavioralTracker({ tenantId, apiEndpoint, userId }) {',
      '  const trackerRef = useRef(null);',
      '  const pathname = usePathname();',
      '',
      '  useEffect(() => {',
      '    // Initialize SDK singleton on client mount',
      '    if (typeof window !== "undefined" && window.BehaviorSDK) {',
      '      trackerRef.current = window.BehaviorSDK.init({',
      '        apiEndpoint: apiEndpoint || "https://collector.nexusbank.com/api/analytics",',
      '        tenantId: tenantId || "nexus_bank",',
      '        clientId: "portal_nextjs",',
      '        consent: true,',
      '      });',
      '    }',
      '    return () => {',
      '      if (trackerRef.current) trackerRef.current.stop();',
      '    };',
      '  }, [tenantId, apiEndpoint]);',
      '',
      '  // Track SPA client-side route changes',
      '  useEffect(() => {',
      '    if (trackerRef.current && pathname) {',
      '      trackerRef.current.trackPageView(pathname);',
      '    }',
      '  }, [pathname]);',
      '',
      '  // Link authenticated customer identifier',
      '  useEffect(() => {',
      '    if (trackerRef.current && userId) {',
      '      trackerRef.current.identify(userId);',
      '    }',
      '  }, [userId]);',
      '',
      '  return trackerRef.current;',
      '}'
    ])
  );

  children.push(h2('6.2 Integration Option B: Modular SDK (sdk/xylium-core.js)'));
  children.push(
    p(
      'Recommended for multi-page banking applications or where selective behavioral signal loading is required. Configuration is passed via data-* attributes on the landing script.'
    )
  );

  children.push(
    codeBlock([
      '<!-- Landing Core File: Reads config, manages session, exposes window.XyliumBF -->',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-core.js"',
      '        data-tenant-id="nexus_bank"',
      '        data-app-id="banking_portal"',
      '        data-api-endpoint="https://collector.nexusbank.com"',
      '        data-capture-geo="false"></script>',
      '',
      '<!-- Selective behavioral pattern modules (load order does not matter) -->',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-mouse.js"></script>',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-keyboard.js"></script>',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-form.js"></script>',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-navigation.js"></script>',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-device.js"></script>',
      '<script src="https://cdn.nexusbank.com/sdk/xylium-identity.js"></script>',
      '',
      '<script>',
      '  // Grant consent to start event collection',
      '  window.addEventListener("load", () => {',
      '    if (window.XyliumBF) {',
      '      window.XyliumBF.grantConsent();',
      '    }',
      '  });',
      '</script>'
    ])
  );

  children.push(h2('6.3 Configuration Parameters Reference'));
  children.push(createTable(
    ['Parameter Name', 'Type', 'Default Value', 'Description & Banking Guidance'],
    [
      ['apiEndpoint', 'String', 'http://localhost:8080/api/analytics', 'Base HTTPS URL of the backend ingestion server.'],
      ['tenantId', 'String', 'default', 'Tenant identifier. Must match an entry in the backend ALLOWED_TENANTS config.'],
      ['clientId / appId', 'String', 'banking_app', 'Client application identifier distinguishing web portals from mobile web.'],
      ['batchSize', 'Number', '25', 'Number of events buffered before flushing an HTTPS batch (max: 100).'],
      ['flushIntervalMs', 'Number', '5000', 'Periodic interval in milliseconds for flushing pending events (recommended: 3000–5000).'],
      ['maxQueueSize', 'Number', '500', 'Maximum in-memory ring buffer size. Discards oldest events if backend is unreachable.'],
      ['maxRetries', 'Number', '4', 'Maximum retry attempts with exponential jitter before discarding a failed batch.'],
      ['idleThresholdMs', 'Number', '5000', 'Inactivity duration in milliseconds before firing idle_start.'],
      ['consent', 'Boolean', 'true', 'If false, SDK suppresses all collection until grantConsent() is invoked.']
    ],
    [22, 12, 22, 44]
  ));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 7. API DOCUMENTATION
  // ==========================================
  children.push(h1('7. API Documentation'));

  children.push(
    p(
      'This section documents all active HTTP endpoints exposed by the backend service. Endpoints are organized by responsibility: Ingestion, Identity Resolution, Analytics & Risk, and Database Administration.'
    )
  );

  children.push(h2('7.1 Public SDK Ingestion Endpoints'));

  children.push(h3('POST /collect (Legacy / Modular Ingestion)'));
  children.push(p('Receives event batches from xylium-bf-v2.js or xylium-core.js. Enforces tenant authorization via tenantGuard.'));
  children.push(bullet('Headers: Content-Type: application/json (or text/plain for sendBeacon)'));
  children.push(bullet('Auth: None (Protected by tenantId validation against ALLOWED_TENANTS)'));
  children.push(bullet('Request Body: { "tenantId": "nexus_bank", "appId": "portal", "deviceFingerprint": "fp_8471", "events": [...] }'));
  children.push(bullet('Response 202 Accepted: { "ok": true }'));
  children.push(bullet('Response 403 Forbidden: { "error": "unknown tenant" }'));

  children.push(h3('POST /api/analytics/events/batch (Modern Ingestion)'));
  children.push(p('Receives event batches conforming to the canonical event.schema.js specification.'));
  children.push(bullet('Headers: Content-Type: application/json, Authorization: Bearer <JWT> (optional)'));
  children.push(bullet('Auth: optionalAuth (derives canonical userId if authenticated)'));
  children.push(bullet('Request Body: { "events": [ { "eventId": "evt_...", "sessionId": "...", "eventName": "...", ... } ] }'));
  children.push(bullet('Response 202 Accepted: { "ok": true, "acceptedCount": 25, "insertedCount": 25, "activeDatabase": "postgresql" }'));
  children.push(bullet('Response 400 Bad Request: { "error": "invalid payload", "details": { ... } }'));

  children.push(h2('7.2 Authoritative Server-to-Server Identity Endpoints'));

  children.push(h3('POST /identify'));
  children.push(p('Called strictly by the bank’s core authentication backend after verifying customer credentials. Links anonymous sessionId to verified customer userId.'));
  children.push(bullet('Headers: Content-Type: application/json, x-tenant-id: nexus_bank, x-api-key: <SECRET_KEY>'));
  children.push(bullet('Auth: apiKeyGuard (enforces timing-safe crypto comparison against TENANT_API_KEYS)'));
  children.push(bullet('Request Body: { "sessionId": "sess_89a0b1c2", "userId": "cust_84920" }'));
  children.push(bullet('Response 200 OK: { "ok": true }'));
  children.push(bullet('Response 401 Unauthorized: { "error": "unauthorized" }'));

  children.push(h3('POST /api/analytics/sessions/link'));
  children.push(p('Alternative server-to-server linking endpoint requiring server API key or admin role.'));
  children.push(bullet('Headers: Content-Type: application/json, x-tenant-id: nexus_bank, x-api-key: <SECRET_KEY>'));
  children.push(bullet('Auth: requireServerOrAdmin'));
  children.push(bullet('Request Body: { "sessionId": "sess_89a0b1c2", "userId": "cust_84920", "anonymousId": "anon_..." }'));
  children.push(bullet('Response 200 OK: { "ok": true, "sessionId": "sess_89a0b1c2", "userId": "cust_84920" }'));

  children.push(h2('7.3 Analytics & Behavioral Risk Endpoints'));

  children.push(h3('GET /api/analytics/sessions/:sessionId/risk'));
  children.push(p('Evaluates session biometrics against human physiological thresholds and returns explainable risk signals.'));
  children.push(bullet('Headers: Authorization: Bearer <JWT> or x-api-key'));
  children.push(bullet('Auth: requireAuth'));
  children.push(bullet('Response 200 OK:'));
  children.push(
    codeBlock([
      '{',
      '  "sessionId": "sess_89a0b1c2",',
      '  "userId": "cust_84920",',
      '  "riskScore": 15,',
      '  "riskLevel": "LOW",',
      '  "confidence": 0.90,',
      '  "recommendedAction": "ALLOW",',
      '  "signals": [',
      '    {',
      '      "code": "DEVIATION_FROM_HISTORICAL_BASELINE",',
      '      "severity": "INFO",',
      '      "description": "Interaction patterns consistent with established baseline"',
      '    }',
      '  ],',
      '  "featuresSummary": {',
      '    "eventCount": 42,',
      '    "meanPointerSpeed": 1.42,',
      '    "meanFlightTime": 118,',
      '    "meanCadence": 4.1',
      '  }',
      '}'
    ])
  );

  children.push(h3('GET /api/analytics/users/:userId/summary'));
  children.push(p('Retrieves aggregate journey statistics, total sessions, and interaction category distributions for a customer.'));
  children.push(bullet('Headers: Authorization: Bearer <JWT>'));
  children.push(bullet('Auth: requireUserOrAdmin (ensures customers cannot read other customers’ data)'));
  children.push(bullet('Response 200 OK: { "userId": "cust_84920", "totalEvents": 412, "totalSessions": 8, "categories": { ... } }'));

  children.push(h3('DELETE /api/analytics/users/:userId (GDPR Erasure)'));
  children.push(p('Permanently deletes all stored behavioral events, sessions, and engagement records for a user.'));
  children.push(bullet('Headers: Authorization: Bearer <JWT> (Admin or Customer)'));
  children.push(bullet('Response 200 OK: { "ok": true, "deletedCount": 412, "userId": "cust_84920" }'));

  children.push(h2('7.4 Admin Database Management Endpoints'));

  children.push(h3('GET /api/admin/database/status'));
  children.push(p('Returns operational health, ping latencies, and active adapter status across PostgreSQL and MongoDB.'));
  children.push(bullet('Auth: requireServerOrAdmin'));
  children.push(bullet('Response 200 OK: { "activeDatabase": "postgresql", "databases": { "postgresql": { "status": "healthy", "latencyMs": 2 }, "mongodb": { "status": "healthy", "latencyMs": 4 } } }'));

  children.push(h3('POST /api/admin/database/switch'));
  children.push(p('Executes an atomic hot-switch between PostgreSQL and MongoDB with pre-flight health validation.'));
  children.push(bullet('Auth: requireServerOrAdmin'));
  children.push(bullet('Request Body: { "database": "postgresql" }'));
  children.push(bullet('Response 200 OK: { "ok": true, "previousDatabase": "mongodb", "activeDatabase": "postgresql", "status": "healthy" }'));
  children.push(bullet('Response 409 Conflict: { "error": "A database switch is already in progress" }'));
  children.push(bullet('Response 502 Bad Gateway: { "error": "Cannot switch: database is unhealthy" }'));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 8. DATABASE DESIGN AND CONFIGURATION
  // ==========================================
  children.push(h1('8. Database Design and Configuration'));

  children.push(
    p(
      'The platform features a dual-database architecture supporting PostgreSQL (for enterprise relational compliance, strict ACID transactions, and existing corporate relational footprints) and MongoDB (for agile JSON document querying and massive vertical ingest scalability).'
    )
  );

  children.push(h2('8.1 PostgreSQL Relational Design & DDL'));
  children.push(
    p(
      'The PostgreSQL adapter (src/database/adapters/postgresql.adapter.js) initializes the schema automatically upon connection if the events table does not exist. The exact verified DDL is provided below:'
    )
  );

  children.push(
    codeBlock([
      'CREATE TABLE IF NOT EXISTS events (',
      '  event_id VARCHAR(255) NOT NULL,',
      '  tenant_id VARCHAR(255) NOT NULL DEFAULT \'default\',',
      '  client_id VARCHAR(255),',
      '  user_id VARCHAR(255),',
      '  session_id VARCHAR(255) NOT NULL,',
      '  event_name VARCHAR(255) NOT NULL,',
      '  event_type VARCHAR(255),',
      '  event_category VARCHAR(100) NOT NULL,',
      '  event_timestamp TIMESTAMPTZ NOT NULL,',
      '  server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
      '  sequence_number BIGINT DEFAULT 0,',
      '  page TEXT,',
      '  sanitized_route TEXT DEFAULT \'/\',',
      '  sdk_version VARCHAR(50) DEFAULT \'2.1.0\',',
      '  schema_version VARCHAR(50) DEFAULT \'2.0\',',
      '  properties JSONB DEFAULT \'{}\'::jsonb,',
      '  device JSONB DEFAULT \'{}\'::jsonb,',
      '  pointer_x DOUBLE PRECISION,',
      '  pointer_y DOUBLE PRECISION,',
      '  pointer_speed_px_per_ms DOUBLE PRECISION,',
      '  pointer_angle_deg DOUBLE PRECISION,',
      '  pointer_distance_px DOUBLE PRECISION,',
      '  is_straight_line BOOLEAN,',
      '  pointer_hold_duration_ms DOUBLE PRECISION,',
      '  hover_duration_ms DOUBLE PRECISION,',
      '  target_category TEXT,',
      '  target_id TEXT,',
      '  text_preview TEXT,',
      '  key_masked TEXT,',
      '  flight_time_ms DOUBLE PRECISION,',
      '  hold_time_ms DOUBLE PRECISION,',
      '  keys_per_second DOUBLE PRECISION,',
      '  is_typing_pause BOOLEAN,',
      '  field_id TEXT,',
      '  field_category TEXT,',
      '  from_field TEXT,',
      '  to_field TEXT,',
      '  field_duration_ms DOUBLE PRECISION,',
      '  paste_detected BOOLEAN,',
      '  form_id TEXT,',
      '  scroll_y DOUBLE PRECISION,',
      '  scroll_direction TEXT,',
      '  scroll_delta_px DOUBLE PRECISION,',
      '  scroll_depth_percent DOUBLE PRECISION,',
      '  scroll_milestone INTEGER,',
      '  touch_count INTEGER,',
      '  touch_duration_ms DOUBLE PRECISION,',
      '  gesture_type TEXT,',
      '  swipe_direction TEXT,',
      '  swipe_distance_px DOUBLE PRECISION,',
      '  orientation TEXT,',
      '  from_route TEXT,',
      '  to_route TEXT,',
      '  navigation_method TEXT,',
      '  visibility_state TEXT,',
      '  tab_active BOOLEAN,',
      '  idle_duration_ms DOUBLE PRECISION,',
      '  page_load_time_ms DOUBLE PRECISION,',
      '  dom_content_loaded_ms DOUBLE PRECISION,',
      '  ttfb_ms DOUBLE PRECISION,',
      '  flow_type TEXT,',
      '  payment_id TEXT,',
      '  payment_amount NUMERIC,',
      '  payment_currency TEXT,',
      '  recipient_type TEXT,',
      '  payment_status TEXT,',
      '  reason_code TEXT,',
      '  challenge_type TEXT,',
      '  account_category TEXT,',
      '  device_category TEXT,',
      '  device_os TEXT,',
      '  device_browser TEXT,',
      '  screen_width INTEGER,',
      '  screen_height INTEGER,',
      '  battery_level DOUBLE PRECISION,',
      '  is_charging BOOLEAN,',
      '  created_at TIMESTAMPTZ DEFAULT NOW(),',
      '  CONSTRAINT pk_events PRIMARY KEY (tenant_id, event_id)',
      ');',
      '',
      '-- B-Tree Performance Indexes',
      'CREATE INDEX IF NOT EXISTS idx_events_tenant_user_time ON events (tenant_id, user_id, event_timestamp DESC);',
      'CREATE INDEX IF NOT EXISTS idx_events_tenant_session_time ON events (tenant_id, session_id, event_timestamp DESC);',
      'CREATE INDEX IF NOT EXISTS idx_events_tenant_type_time ON events (tenant_id, event_type, event_timestamp DESC);',
      'CREATE INDEX IF NOT EXISTS idx_events_tenant_session_seq ON events (tenant_id, session_id, sequence_number ASC);'
    ])
  );

  children.push(h2('8.2 MongoDB Collections and Compound Indexes'));
  children.push(
    p(
      'The MongoDB adapter (src/database/adapters/mongodb.adapter.js) stores documents in the behaviour_events collection with the following verified indexes:'
    )
  );

  children.push(createTable(
    ['Index Key Specification', 'Index Options', 'Query Optimization Purpose'],
    [
      ['{ tenantId: 1, eventId: 1 }', 'unique: true', 'Enforces cross-tenant idempotency and prevents duplicate event insertion.'],
      ['{ tenantId: 1, userId: 1, timestamp: -1 }', 'sparse: false', 'Accelerates customer chronological journey lookups and historical baselining.'],
      ['{ tenantId: 1, sessionId: 1, timestamp: -1 }', 'sparse: false', 'Accelerates session-level risk scoring feature extraction.'],
      ['{ tenantId: 1, eventType: 1, timestamp: -1 }', 'sparse: false', 'Optimizes category-specific analytics queries.'],
      ['{ tenantId: 1, sessionId: 1, sequenceNumber: 1 }', 'sparse: false', 'Enforces strict chronological sequence ordering for trajectory reconstruction.'],
      ['{ receivedAt: 1 }', 'expireAfterSeconds: RAW_TTL_DAYS * 86400', 'Automated data lifecycle expiration on event_batches (if TTL > 0).']
    ],
    [35, 25, 40]
  ));

  children.push(h2('8.3 Zero-Downtime Hot-Switching Architecture'));
  children.push(
    p(
      'The platform implements a Gang-of-Four Adapter and Abstract Factory pattern enabling hot switching between PostgreSQL and MongoDB without application restarts:'
    )
  );

  children.push(bullet('Both PostgreSQLAdapter and MongoDBAdapter extend the common abstract base class EventRepository (src/database/interfaces/event.repository.js), guaranteeing 100% method signature parity.', 'Adapter Parity:'));
  children.push(bullet('When a switch request is posted to POST /api/admin/database/switch, the service acquires an in-memory lock (databaseRegistry.acquireSwitchLock()). Concurrent attempts receive an immediate HTTP 409 Conflict.', 'Concurrency Locking:'));
  children.push(bullet('Before any pointer is switched, the candidate database executes a SELECT 1 or ping command. If the health check fails, the switch is aborted, the lock is released, and the previous database remains 100% active.', 'Pre-Flight Health Validation:'));
  children.push(bullet('In-flight requests hold references to the active adapter instance and complete safely. Subsequent incoming requests immediately bind to the new adapter.', 'In-Flight Safety:'));
  children.push(bullet('Every switch event (timestamp, admin username, fromDatabase, toDatabase, latency, error) is recorded in an in-memory audit ring buffer accessible via GET /api/admin/database/switch-history.', 'Audit Logging:'));

  children.push(
    callout(
      'DATA PRESERVATION NOTE UPON DATABASE SWITCHING',
      'Switching active database routes all new writes and reads strictly to the newly chosen database. Historical records stored in the previous database are completely preserved and never deleted, but are not automatically federated or queried by the new adapter. If unified cross-database historical querying is desired, an asynchronous ETL pipeline must be configured.',
      'info'
    )
  );

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 9. INSTALLATION AND LOCAL SETUP
  // ==========================================
  children.push(h1('9. Installation and Local Setup'));

  children.push(
    p(
      'Follow these step-by-step instructions to set up, configure, and verify the platform on a developer machine or staging environment.'
    )
  );

  children.push(h2('9.1 Prerequisites'));
  children.push(bullet('Node.js: v18.0.0+ (Tested and verified on Node.js v22.22.0)', 'Runtime:'));
  children.push(bullet('npm: v10.0.0+', 'Package Manager:'));
  children.push(bullet('MongoDB: v6.0+ or v7.0+ (Default port: 27017)', 'Document Store:'));
  children.push(bullet('PostgreSQL: v14.0+ or v16.0+ (Default port: 5432)', 'Relational Store:'));

  children.push(h2('9.2 Setup Instructions'));

  children.push(h3('Step 1: Install Dependencies'));
  children.push(codeBlock(['npm install']));

  children.push(h3('Step 2: Environment Configuration'));
  children.push(
    codeBlock([
      'cp .env.example .env',
      '# Edit .env with your local credentials:',
      '# ACTIVE_DATABASE=mongodb (or postgresql)',
      '# POSTGRES_USER=postgres',
      '# POSTGRES_PASSWORD=your_password',
      '# POSTGRES_DATABASE=behavioral_events'
    ])
  );

  children.push(h3('Step 3: Database Initialization'));
  children.push(
    p(
      'For MongoDB, ensure the daemon is running (mongod). Collections and compound indexes are created automatically on startup.\nFor PostgreSQL, create the target database if not using the postgres superuser:'
    )
  );
  children.push(codeBlock(['psql -U postgres -c "CREATE DATABASE behavioral_events;"']));
  children.push(p('The application automatically executes the CREATE TABLE IF NOT EXISTS events and index statements during boot.'));

  children.push(h3('Step 4: Launching the Backend Server'));
  children.push(
    codeBlock([
      '# Development mode with file watching:',
      'npm run dev',
      '',
      '# Production daemon:',
      'npm start'
    ])
  );
  children.push(p('Console output will confirm database connection and port binding:'));
  children.push(
    codeBlock([
      '[XyliumIngestion] connected to Mongo',
      '[DatabaseRegistry] Active database initialized: MONGODB',
      '[server] Active database (mongodb) verified healthy (2ms)',
      '[XyliumIngestion] listening on :8080'
    ])
  );

  children.push(h3('Step 5: Verifying Health and Ingestion'));
  children.push(
    codeBlock([
      '# 1. Health check',
      'curl http://localhost:8080/health',
      '# Output: {"status":"ok","ts":"..."}',
      '',
      '# 2. Open Test Suite in Browser',
      '# Navigate to: http://localhost:8080/test-page-v2.html',
      '',
      '# 3. Open Admin Database Switcher Dashboard',
      '# Navigate to: http://localhost:8080/admin-database.html',
      '',
      '# 4. Open User Risk Inspector',
      '# Navigate to: http://localhost:8080/user-inspector.html'
    ])
  );

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 10. ENVIRONMENT CONFIGURATION
  // ==========================================
  children.push(h1('10. Environment Configuration'));

  children.push(
    p(
      'All environment variables defined in .env.example and consumed by src/config/index.js and src/config/database.config.js are documented below:'
    )
  );

  children.push(createTable(
    ['Variable Name', 'Type', 'Default', 'Req / Opt', 'Purpose & Security Guidance'],
    [
      ['PORT', 'Integer', '8080', 'Optional', 'TCP listening port for Express backend.'],
      ['ACTIVE_DATABASE', 'Enum', 'mongodb', 'Required', 'Active database selection on boot: mongodb or postgresql.'],
      ['MONGO_URI', 'String', 'mongodb://localhost:27017/xylium', 'Conditional', 'MongoDB connection URI. Use authenticated replica sets in production.'],
      ['MONGODB_DATABASE', 'String', 'xylium', 'Optional', 'MongoDB target database name.'],
      ['MONGO_MAX_POOL', 'Integer', '20', 'Optional', 'Maximum concurrent connection pool size for MongoDB.'],
      ['POSTGRES_HOST', 'String', 'localhost', 'Conditional', 'PostgreSQL hostname or RDS endpoint.'],
      ['POSTGRES_PORT', 'Integer', '5432', 'Optional', 'PostgreSQL TCP port.'],
      ['POSTGRES_DATABASE', 'String', 'behavioral_events', 'Conditional', 'Target PostgreSQL database name.'],
      ['POSTGRES_USER', 'String', 'postgres', 'Conditional', 'PostgreSQL username.'],
      ['POSTGRES_PASSWORD', 'String', '""', 'Conditional', 'PostgreSQL password. Masked in all logs and API responses.'],
      ['POSTGRES_SSL', 'Boolean', 'false', 'Optional', 'Enable SSL/TLS for PostgreSQL connections (required for RDS/Cloud SQL).'],
      ['POSTGRES_MAX_POOL', 'Integer', '20', 'Optional', 'Maximum concurrent pool size for pg.Pool.'],
      ['ALLOWED_TENANTS', 'List', 'acme_corp', 'Required', 'Comma-separated allowlist of valid tenant IDs. Empty = allow all (dev only).'],
      ['CORS_ORIGINS', 'List', '""', 'Required', 'Comma-separated allowed browser origins. NEVER use * in banking production.'],
      ['TENANT_API_KEYS', 'JSON', '{}', 'Required', 'JSON map {"tenant_id":"hex_key"} for authenticating server-to-server calls.'],
      ['MAX_BATCH_EVENTS', 'Integer', '500', 'Optional', 'Maximum events accepted per single batch payload.'],
      ['MAX_PAYLOAD_BYTES', 'Integer', '262144', 'Optional', 'Maximum body size (256 KB). Rejects oversized payloads with HTTP 413.'],
      ['RAW_TTL_DAYS', 'Integer', '0', 'Optional', 'Auto-expiration days for raw event_batches (0 = keep forever).'],
      ['RATE_LIMIT_WINDOW_MS', 'Integer', '60000', 'Optional', 'Sliding rate limit window in milliseconds (1 minute).'],
      ['RATE_LIMIT_MAX', 'Integer', '3000', 'Optional', 'Maximum requests per IP per window.'],
      ['JWT_SECRET', 'String', 'xylium-default-dev...', 'Required', 'Secret key for signing and verifying customer authentication tokens.']
    ],
    [22, 10, 20, 10, 38]
  ));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 11. CLIENT-SIDE INTEGRATION REQUIREMENTS
  // ==========================================
  children.push(h1('11. Client-Side Integration Requirements'));

  children.push(
    p(
      'To ensure a seamless, secure rollout, the banking client’s engineering and security teams must fulfill the following operational prerequisites prior to deployment.'
    )
  );

  children.push(h2('11.1 Banking Client Pre-Deployment Checklist'));

  children.push(bullet('Furnish all production, UAT, and staging origin domains (e.g., https://app.nexusbank.com) to populate CORS_ORIGINS.', '1. Origin Registration:'));
  children.push(bullet('Configure the bank’s Content Security Policy (CSP) headers to allow script execution and outbound telemetry transmission:', '2. Content Security Policy (CSP):'));
  children.push(
    codeBlock([
      "Content-Security-Policy: script-src 'self' https://cdn.nexusbank.com;",
      "connect-src 'self' https://collector.nexusbank.com;"
    ])
  );
  children.push(bullet('Generate high-entropy 256-bit hexadecimal secrets for TENANT_API_KEYS to authenticate backend identity linking calls.', '3. API Secret Generation:'));
  children.push(bullet('Implement the server-side POST /identify call in the bank’s authentication microservice immediately following credential validation.', '4. Identity Linking Hook:'));
  children.push(bullet('Confirm that pseudonymous user IDs (e.g. internal hashed UUIDs) are supplied rather than unencrypted Social Security Numbers or primary bank account numbers.', '5. User ID Hashing:'));
  children.push(bullet('Verify that all custom transaction forms conform to data-bf-field privacy tagging.', '6. Sensitive Form Audit:'));
  children.push(bullet('Supply synthetic test credentials and test scenarios for automated UAT verification.', '7. Synthetic Test Accounts:'));

  children.push(h2('11.2 Stakeholder Responsibility Matrix'));

  children.push(createTable(
    ['Operational Activity', 'Bank Client Engineering', 'SDK Provider / Vendor', 'SecOps & Compliance'],
    [
      ['SDK Script Embedding & SPA Hooking', 'R (Responsible)', 'C (Consulted)', 'I (Informed)'],
      ['CSP & Network Proxy Allowlisting', 'R (Responsible)', 'C (Consulted)', 'A (Accountable)'],
      ['Server-to-Server /identify Call', 'R (Responsible)', 'C (Consulted)', 'I (Informed)'],
      ['Backend Ingestion & Database Infrastructure', 'C (Consulted)', 'R (Responsible)', 'A (Accountable)'],
      ['Biometric Risk Baseline Tuning', 'I (Informed)', 'R (Responsible)', 'A (Accountable)'],
      ['Privacy & Data Minimization Sign-off', 'C (Consulted)', 'I (Informed)', 'R / A (Accountable)'],
      ['Incident Management & Escalation', 'R (Responsible)', 'R (Responsible)', 'A (Accountable)']
    ],
    [32, 22, 22, 24]
  ));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 12. TESTING AND ACCEPTANCE CRITERIA
  // ==========================================
  children.push(h1('12. Testing and Acceptance Criteria'));

  children.push(
    p(
      'The platform includes an automated test suite executed via node --test. Automated test verification results and the formal client acceptance checklist are detailed below.'
    )
  );

  children.push(h2('12.1 Automated Test Suite Verification'));
  children.push(
    p(
      'Automated testing was conducted using Node’s native test runner against the codebase. Two core enterprise suites achieved 100% pass rates across 45 verified test specifications:'
    )
  );

  children.push(bullet('29 of 29 subtests passed (duration: 488ms). Validated event batch ingestion, anonymous session tracking, retroactive user linking, pointer dynamics sequencing, cadence flight times, password shielding, banking workflows, and explainable risk scoring.', 'tests/analytics.test.js:'));
  children.push(bullet('16 of 16 subtests passed (duration: 683ms). Validated PostgreSQL and MongoDB adapter parity, ACID event persistence, tenant isolation, idempotency without duplicate inserts, graceful connection recovery, atomic database hot-switching, concurrency locks, and audit history.', 'tests/dual-database.test.js:'));

  children.push(h2('12.2 Client User Acceptance Testing (UAT) Checklist'));

  children.push(createTable(
    ['Verification Item', 'Acceptance Criteria', 'Verification Status', 'Evidence Source'],
    [
      ['SDK Script Loading', 'SDK loads cleanly in <50ms without console errors or blocking DOM rendering.', 'Verified', 'test-page-v2.html:169'],
      ['Biometric Event Capture', 'Cursor movements, key flight times, and scroll milestones fire as expected.', 'Verified', 'analytics.test.js:23'],
      ['Sensitive Value Shielding', 'Password and card inputs produce keyMasked="char"; zero characters captured.', 'Verified', 'analytics.test.js:24'],
      ['Payload Validation', 'Malformed schemas or oversized batches are rejected with HTTP 400/413.', 'Verified', 'dual-database.test.js:3'],
      ['Server Identity Linking', 'POST /identify binds userId and backfills pre-login batches.', 'Verified', 'analytics.test.js:18'],
      ['Dual Database Persistence', 'Valid events store accurately in both PostgreSQL and MongoDB.', 'Verified', 'dual-database.test.js:2'],
      ['Hot Database Switching', 'Active database switches atomically under load without dropping requests.', 'Verified', 'dual-database.test.js:9,11'],
      ['Audit Logging', 'All database switches record admin ID, timestamps, and health status.', 'Verified', 'dual-database.test.js:16'],
      ['Behavioral Risk Scoring', 'Calculates explainable risk signals (0–100) and step-up recommendations.', 'Verified', 'analytics.test.js:27'],
      ['Right-to-be-Forgotten', 'DELETE /api/analytics/users/:userId purges all historical customer data.', 'Verified', 'analytics.test.js:20'],
      ['Network Risk / IP Intel', 'Detects commercial VPN/proxy IPs via server lookup.', 'Pending Fix', 'Route unmounted in app.js']
    ],
    [24, 38, 16, 22]
  ));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 13. SECURITY, COMPLIANCE, AND LIMITATIONS
  // ==========================================
  children.push(h1('13. Security, Compliance, and Limitations'));

  children.push(
    p(
      'Enterprise security controls, legal data minimization, accessibility considerations, and operational boundaries are summarized below:'
    )
  );

  children.push(h2('13.1 Implemented Security Controls'));
  children.push(bullet('All communication requires TLS 1.2 or TLS 1.3 encryption. Unencrypted HTTP is rejected.', 'Transport Layer Security (TLS):'));
  children.push(bullet('Server-to-server API key comparisons use crypto.timingSafeEqual to prevent side-channel timing attacks.', 'Timing-Safe Authentication:'));
  children.push(bullet('Every database query and index is strictly scoped to tenantId. Cross-tenant data leakage is structurally impossible.', 'Tenant Isolation:'));
  children.push(bullet('The backend enforces per-IP sliding rate limits (3,000 requests/minute) across all public endpoints.', 'Rate Limiting:'));
  children.push(bullet('Express handles text/plain payloads from sendBeacon gracefully, preventing body-parser dropouts upon page unload.', 'Beacon Body Parsing:'));

  children.push(h2('13.2 Accessibility and Legitimate Human Variability'));
  children.push(
    p(
      'A primary concern for financial institutions is ensuring that users with disabilities or varying physical capabilities are not unfairly penalized. The platform incorporates specific accommodations:'
    )
  );
  children.push(bullet('Users who navigate via screen readers or TAB keys emit linear focus events. The risk engine differentiates keyboard-only navigation from automated bot injections by checking focus dwell intervals.', 'Assistive Technologies:'));
  children.push(bullet('Motor tremors, unsteady pointer movement, or variable keystroke speeds do not elevate risk scores—irregular human motion is recognized as organic, whereas inhumanly linear paths elevate bot risk.', 'Motor Tremors:'));

  children.push(h2('13.3 Known System Limitations'));
  children.push(bullet('Behavioral biometric scores are probabilistic indicators. They must never be used as the sole factor to deny access; they should trigger step-up MFA or manual review.', 'Probabilistic Boundary:'));
  children.push(bullet('Accurate individual baseline comparison requires 3 to 5 prior sessions. New customer sessions are evaluated against global population baselines.', 'Baseline Maturation:'));
  children.push(bullet('In high-volume enterprise deployments (>10,000 req/sec), synchronous database writes should be decoupled using an external message queue (e.g. Apache Kafka or AWS SQS).', 'Ingest Decoupling:'));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 14. TROUBLESHOOTING
  // ==========================================
  children.push(h1('14. Troubleshooting'));

  children.push(
    p(
      'This diagnostic guide provides remediation steps for common operational issues encountered during integration and staging.'
    )
  );

  children.push(createTable(
    ['Observed Issue / Error', 'Root Cause', 'Diagnostic Command / Log Indicator', 'Recommended Remediation'],
    [
      ['SDK fails to load in browser', 'Blocked by Content Security Policy or 404 URL path.', 'DevTools Console: Refused to load script due to CSP directive.', 'Add CDN domain to CSP script-src; verify static asset URL.'],
      ['Events not being captured', 'User consent not granted, or requireConsent is true.', 'Console: [XyliumBF v2] init (no further log)', 'Call window.XyliumBF.grantConsent() or pass consent: true in init().'],
      ['HTTP 400 Bad Request', 'Payload fails Zod schema validation; missing required field.', 'Response: {"error":"invalid payload","details":{...}}', 'Inspect request body against event.schema.js; verify sessionId.'],
      ['HTTP 401 Unauthorized', 'Missing or invalid Bearer JWT token or x-api-key header.', 'Response: {"error":"unauthorized"}', 'Supply valid x-api-key matching TENANT_API_KEYS map.'],
      ['HTTP 403 Forbidden', 'tenantId is missing or not present in ALLOWED_TENANTS.', 'Response: {"error":"unknown tenant"}', 'Add tenantId to ALLOWED_TENANTS list in backend .env.'],
      ['HTTP 404 on /ip-intel', 'Route is implemented but unmounted in src/app.js.', 'Response: {"error":"not found"}', 'Mount ipIntelRouter in src/app.js (see Section 2.2 of Audit Notes).'],
      ['HTTP 409 Conflict on DB switch', 'Another database switch is currently executing.', 'Response: {"error":"A database switch is already in progress"}', 'Wait for existing switch to complete; retry after 2 seconds.'],
      ['HTTP 413 Payload Too Large', 'Flushed batch exceeds MAX_PAYLOAD_BYTES (256 KB).', 'Response: {"error":"payload too large"}', 'Reduce SDK batchSize option from 100 to 25.'],
      ['HTTP 429 Too Many Requests', 'Client IP exceeded rate limit (3,000 req/min).', 'Response: Too many requests, please try again later.', 'Verify TRUST_PROXY configuration so load balancer IP is not shared.'],
      ['PostgreSQL connection timeout', 'DB host unreachable or connection pool exhausted.', 'Log: [PostgreSQLAdapter] Connection timeout', 'Verify POSTGRES_HOST and port 5432; check pool usage in pg_stat_activity.']
    ],
    [22, 24, 26, 28]
  ));

  children.push(new Paragraph({ pageBreakBefore: true }));

  // ==========================================
  // 15. GO-LIVE CHECKLIST AND NEXT STEPS
  // ==========================================
  children.push(h1('15. Go-Live Checklist and Next Steps'));

  children.push(
    p(
      'To guide bank executives and technical leads toward successful production launch, the table below delineates completed platform capabilities, outstanding engineering items, and the phased onboarding roadmap.'
    )
  );

  children.push(h2('15.1 Production Readiness Status'));

  children.push(createTable(
    ['Capability / Requirement', 'Category', 'Status', 'Remediation / Implementation Ownership'],
    [
      ['Client Biometrics SDK', 'Client Tier', 'Production Ready', 'Completed. Verified in analytics-tracker.js and modular sdk/.'],
      ['Zero PII / Credential Shielding', 'Security', 'Production Ready', 'Completed. Verified via maskKey() and SENSITIVE_INPUT_REGEX.'],
      ['Dual Database Abstraction', 'Database', 'Production Ready', 'Completed. PostgreSQL and MongoDB adapters verified in unit tests.'],
      ['Zero-Downtime Hot Switching', 'Operations', 'Production Ready', 'Completed. Tested with concurrency locks and audit history.'],
      ['Server Identity Stitching', 'Identity', 'Production Ready', 'Completed. Verified via /identify and /sessions/link.'],
      ['Explainable Behavioral Risk Scoring', 'Analytics', 'Production Ready', 'Completed. Verified via riskService.js scoring rules.'],
      ['Mount /ip-intel Route', 'Backend Gateway', 'Engineering Item', 'Outstanding. Requires adding app.use("/ip-intel", ...) in src/app.js.'],
      ['Enable Auth on /cp Route', 'Security', 'Engineering Item', 'Outstanding. Uncomment apiKeyGuard in tools/customPatternRoute.js.'],
      ['Production CORS Allowlist', 'Client Setup', 'Client Action', 'Awaiting Bank Input. Provide production FQDNs for CORS_ORIGINS.'],
      ['CSP Header Deployment', 'Client Setup', 'Client Action', 'Awaiting Bank Input. Deploy script-src and connect-src headers.'],
      ['Server-to-Server Hook in Auth Backend', 'Client Setup', 'Client Action', 'Awaiting Bank Input. Call POST /identify upon verified login.']
    ],
    [26, 18, 18, 38]
  ));

  children.push(h2('15.2 Recommended Phased Onboarding Roadmap'));

  children.push(bullet('Finalize architectural alignment, provision sandbox environments, exchange API keys, and test health endpoints.', 'Phase 1: Architecture Alignment & Sandbox (Weeks 1–2):'));
  children.push(bullet('Embed SDK in staging environments, execute synthetic test cases (human vs. bot), verify sensitive data exclusion, and test identity stitching.', 'Phase 2: Staging Integration & UAT (Weeks 3–4):'));
  children.push(bullet('Deploy SDK to production in passive "shadow mode" (score without blocking). Collect baseline data for 2 weeks to tune risk scoring thresholds against legitimate user behavior.', 'Phase 3: Shadow Mode & Baseline Calibration (Weeks 5–6):'));
  children.push(bullet('Activate adaptive enforcement. High-risk sessions trigger step-up authentication. Establish operational monitoring and 24/7 incident response runbooks.', 'Phase 4: Full Production Go-Live (Week 7+):'));

  // ==========================================
  // DOCUMENT ASSEMBLY & STYLING
  // ==========================================
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: 'Arial',
            size: 21,
            color: COLOR_TEXT,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: 11906, // A4 width in twips (210 mm)
              height: 16838, // A4 height in twips (297 mm)
            },
            margin: {
              top: 1440, // 1 inch
              bottom: 1440,
              left: 1440,
              right: 1440,
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                spacing: { after: 100 },
                children: [
                  new TextRun({
                    text: 'Behavioral Fingerprinting SDK — Client Technical Integration Guide',
                    font: 'Arial',
                    size: 16, // 8 pt
                    color: COLOR_MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.JUSTIFIED,
                children: [
                  new TextRun({
                    text: 'Commercial Confidential — Prepared for Banking Client Technical Review',
                    font: 'Arial',
                    size: 16,
                    color: COLOR_MUTED,
                  }),
                  new TextRun({
                    text: '\tPage ',
                    font: 'Arial',
                    size: 16,
                    color: COLOR_MUTED,
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: 'Arial',
                    size: 16,
                    bold: true,
                    color: COLOR_NAVY,
                  }),
                  new TextRun({
                    text: ' of ',
                    font: 'Arial',
                    size: 16,
                    color: COLOR_MUTED,
                  }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    font: 'Arial',
                    size: 16,
                    bold: true,
                    color: COLOR_NAVY,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return doc;
}

async function main() {
  console.log('Generating Behavioral Fingerprinting SDK Client Documentation (.docx)...');
  const doc = buildDocument();
  const buffer = await Packer.toBuffer(doc);
  const outPath = path.join(__dirname, 'Behavioral_Fingerprinting_SDK_Client_Documentation.docx');
  fs.writeFileSync(outPath, buffer);
  console.log(`Successfully generated Word document at: ${outPath} (${buffer.length} bytes)`);
}

main().catch((err) => {
  console.error('Fatal document generation error:', err);
  process.exit(1);
});
