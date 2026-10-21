const BehaviourEvent = require('./models/BehaviourEvent');
const BehaviourSession = require('./models/BehaviourSession');

const databaseRegistry = require('./config/database-registry');

class RiskService {
  /**
   * Extract interpretable behavioral biometric features from a stream of events.
   */
  extractFeatures(events) {
    const features = {
      eventCount: events.length,
      pointerEventCount: 0,
      pointerSpeeds: [],
      pointerDirectionChanges: 0,
      typingFlightTimes: [],
      typingCadences: [],
      fieldInteractions: 0,
      pasteCount: 0,
      touchEventCount: 0,
      scrollCount: 0,
      instantSubmissions: 0,
      sessionDurationMs: 0,
      hasStraightLinePointer: false,
    };

    if (events.length === 0) return features;

    const firstTime = new Date(events[0].timestamp).getTime();
    const lastTime = new Date(events[events.length - 1].timestamp).getTime();
    features.sessionDurationMs = Math.max(0, lastTime - firstTime);

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      const props = evt.properties || {};

      // Pointer dynamics
      if (['pointer_move', 'mousemove', 'pointer_velocity'].includes(evt.eventName) || evt.eventCategory === 'pointer') {
        features.pointerEventCount++;
        const speed = typeof evt.pointerSpeedPxPerMs === 'number'
          ? evt.pointerSpeedPxPerMs
          : (typeof props.speedPxPerMs === 'number' ? props.speedPxPerMs : (typeof props.velocity === 'number' ? props.velocity : null));
        if (speed !== null) {
          features.pointerSpeeds.push(speed);
        }
        if (props.directionChange || (typeof evt.pointerAngleDeg === 'number' && evt.pointerAngleDeg !== 0)) {
          features.pointerDirectionChanges++;
        }
        if (evt.isStraightLine === true || props.isStraightLine === true) {
          features.hasStraightLinePointer = true;
        }
      }

      // Typing dynamics
      if (['key_down', 'keyup', 'typing_dynamics', 'keytiming'].includes(evt.eventName) || evt.eventCategory === 'keyboard') {
        const ft = typeof evt.flightTimeMs === 'number' ? evt.flightTimeMs : (typeof props.flightTimeMs === 'number' ? props.flightTimeMs : null);
        if (ft !== null && ft > 0 && ft < 5000) {
          features.typingFlightTimes.push(ft);
        }
        const cadence = typeof evt.keysPerSecond === 'number' ? evt.keysPerSecond : (typeof props.keysPerSecond === 'number' ? props.keysPerSecond : null);
        if (cadence !== null) {
          features.typingCadences.push(cadence);
        }
      }

      // Form interactions
      if (['field_focused', 'field_blurred', 'focus_change', 'field_interaction'].includes(evt.eventName) || evt.eventCategory === 'form') {
        features.fieldInteractions++;
        const dur = typeof evt.fieldDurationMs === 'number' ? evt.fieldDurationMs : (typeof props.durationMs === 'number' ? props.durationMs : null);
        if (dur !== null && dur < 100 && evt.eventName === 'form_submitted') {
          features.instantSubmissions++;
        }
      }

      // Pastes
      if (['paste_detected', 'paste'].includes(evt.eventName) || evt.pasteDetected === true || props.pasteDetected === true) {
        features.pasteCount++;
      }

      // Touch
      if (evt.eventCategory === 'touch' || ['touch_start', 'touch_end', 'touch_move', 'swipe'].includes(evt.eventName)) {
        features.touchEventCount++;
      }

      // Scroll
      if (evt.eventCategory === 'scroll' || evt.eventName === 'scroll' || evt.eventName === 'scroll_milestone') {
        features.scrollCount++;
      }
    }

    // Compute summary stats
    features.meanPointerSpeed = features.pointerSpeeds.length > 0
      ? features.pointerSpeeds.reduce((a, b) => a + b, 0) / features.pointerSpeeds.length
      : 0;

    features.meanFlightTime = features.typingFlightTimes.length > 0
      ? features.typingFlightTimes.reduce((a, b) => a + b, 0) / features.typingFlightTimes.length
      : 0;

    features.meanCadence = features.typingCadences.length > 0
      ? features.typingCadences.reduce((a, b) => a + b, 0) / features.typingCadences.length
      : 0;

    return features;
  }

  /**
   * Evaluate session risk against legitimate baselines and behavioral anomaly patterns.
   */
  async evaluateSessionRisk(sessionId) {
    const session = await BehaviourSession.findOne({ sessionId }).lean();
    if (!session) {
      return { error: 'session not found' };
    }

    // Retrieve events sorted by sequenceNumber or timestamp via active adapter
    const activeType = databaseRegistry.getActiveType();
    let events;
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      const res = await activeAdapter.getSessionEvents(sessionId, 'default', { limit: 500 });
      events = res.events;
    } else {
      events = await BehaviourEvent.find({ sessionId }).sort({ sequenceNumber: 1, timestamp: 1 }).lean();
    }
    const features = this.extractFeatures(events);

    const signals = [];
    let riskScore = 10; // Default clean baseline

    // Check confidence level based on data completeness
    let confidence = 0.5;
    if (events.length >= 20) confidence = 0.9;
    else if (events.length >= 8) confidence = 0.75;
    else if (events.length < 3) confidence = 0.3;

    // Signal 1: Super-human typing cadence (> 20 keys/sec)
    if (features.meanCadence > 20 || features.typingFlightTimes.some((t) => t < 15)) {
      riskScore += 35;
      signals.push({
        code: 'SUPERHUMAN_TYPING_CADENCE',
        severity: 'HIGH',
        description: 'Typing cadence exceeded physiological human maximums (>20 keys/sec)',
        metric: { meanCadence: Math.round(features.meanCadence * 10) / 10 },
      });
    }

    // Signal 2: Unnaturally straight pointer trajectories (bot / synthetic script indicator)
    if (features.hasStraightLinePointer && features.pointerDirectionChanges === 0 && features.pointerEventCount > 4) {
      riskScore += 30;
      signals.push({
        code: 'SYNTHETIC_POINTER_TRAJECTORY',
        severity: 'HIGH',
        description: 'Pointer trajectories exhibit perfectly linear motion lacking human motor tremor',
      });
    }

    // Signal 3: Instant form submission without interaction
    if (features.instantSubmissions > 0 || (events.some((e) => e.eventName === 'form_submitted') && features.fieldInteractions === 0 && features.pasteCount === 0)) {
      riskScore += 25;
      signals.push({
        code: 'AUTOMATED_FORM_INJECTION',
        severity: 'MEDIUM',
        description: 'Form submission occurred without organic field focus or typing interactions',
      });
    }

    // Signal 4: Critical banking action with zero pointer or scroll trajectory
    const hasBankingAction = events.some((e) => ['payment_flow_start', 'payment_initiated', 'payment_confirmation'].includes(e.eventName));
    if (hasBankingAction && features.pointerEventCount === 0 && features.touchEventCount === 0 && features.scrollCount === 0) {
      riskScore += 30;
      signals.push({
        code: 'HEADLESS_WORKFLOW_EXECUTION',
        severity: 'HIGH',
        description: 'High-value banking transaction executed without tactile or cursor navigation',
      });
    }

    // Signal 5: Compare against user historical baseline if user authenticated
    if (session.userId) {
      const historicalSessions = await BehaviourSession.find({
        userId: session.userId,
        sessionId: { $ne: sessionId },
        status: { $in: ['active', 'ended'] },
      }).limit(10).lean();

      if (historicalSessions.length >= 3) {
        // We have an established baseline
        const avgHistInteractions = historicalSessions.reduce((acc, s) => acc + (s.sessionSummary?.interactionCount || 0), 0) / historicalSessions.length;
        if (avgHistInteractions > 15 && features.eventCount < 3 && hasBankingAction) {
          riskScore += 20;
          signals.push({
            code: 'DEVIATION_FROM_HISTORICAL_BASELINE',
            severity: 'MEDIUM',
            description: 'Interaction patterns deviate significantly from user historical behavioral profile',
          });
        }
      } else {
        signals.push({
          code: 'NEW_USER_INSUFFICIENT_HISTORY',
          severity: 'INFO',
          description: 'User has fewer than 3 historical sessions; evaluated against generic baselines',
        });
      }
    } else {
      signals.push({
        code: 'ANONYMOUS_PRE_LOGIN_SESSION',
        severity: 'INFO',
        description: 'Session has not yet been linked to an authenticated user account',
      });
    }

    // Bound riskScore between 0 and 100
    riskScore = Math.min(100, Math.max(0, riskScore));

    let riskLevel = 'LOW';
    let recommendedAction = 'ALLOW';

    if (riskScore >= 75) {
      riskLevel = 'CRITICAL';
      recommendedAction = 'STEP_UP_AUTH'; // e.g. Step-up 2FA, never silent block
    } else if (riskScore >= 50) {
      riskLevel = 'HIGH';
      recommendedAction = 'MANUAL_REVIEW';
    } else if (riskScore >= 30) {
      riskLevel = 'MEDIUM';
      recommendedAction = 'MONITOR';
    }

    const evaluation = {
      sessionId,
      userId: session.userId || null,
      riskScore,
      riskLevel,
      confidence,
      recommendedAction,
      signals,
      featuresSummary: {
        eventCount: features.eventCount,
        pointerEventCount: features.pointerEventCount,
        meanPointerSpeed: Math.round(features.meanPointerSpeed * 100) / 100,
        meanFlightTimeMs: Math.round(features.meanFlightTime),
        meanCadenceKeysPerSec: Math.round(features.meanCadence * 10) / 10,
        sessionDurationMs: features.sessionDurationMs,
      },
      evaluatedAt: new Date(),
    };

    // Persist risk assessment onto session
    await BehaviourSession.updateOne(
      { sessionId },
      {
        $set: {
          'riskSummary.riskScore': riskScore,
          'riskSummary.riskLevel': riskLevel,
          'riskSummary.confidence': confidence,
          'riskSummary.evaluatedAt': evaluation.evaluatedAt,
          'riskSummary.signals': signals,
        },
      }
    );

    return evaluation;
  }
}

module.exports = new RiskService();
