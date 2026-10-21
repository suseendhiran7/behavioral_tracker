const mongoose = require('mongoose');
const BehaviourEvent = require('./models/BehaviourEvent');
const BehaviourSession = require('./models/BehaviourSession');
const PageEngagement = require('./models/PageEngagement');
const PaymentRecord = require('./models/PaymentRecord');
const databaseRegistry = require('./config/database-registry');

class AnalyticsService {
  /**
   * Batch ingest events with idempotency and canonical userId enforcement.
   */
  async ingestEvents({ events, clientIp, authenticatedUser }) {
    if (!events || events.length === 0) return { ok: true, count: 0 };

    const now = new Date();
    const ops = [];
    const eventDocs = [];
    const sessionUpdates = new Map();
    const pageEngagements = [];

    for (const evt of events) {
      // Security: derive canonical userId from verified auth principal; fall back to client userId if unauthenticated
      const effectiveUserId = authenticatedUser && authenticatedUser.userId ? authenticatedUser.userId : (evt.userId || null);

      const eventDoc = {
        eventId: evt.eventId,
        sessionId: evt.sessionId,
        anonymousId: evt.anonymousId || null,
        userId: effectiveUserId,
        tenantId: evt.tenantId || (authenticatedUser && authenticatedUser.tenantId) || 'default',
        clientId: evt.clientId || null,
        sequenceNumber: typeof evt.sequenceNumber === 'number' ? evt.sequenceNumber : 0,
        eventName: evt.eventName,
        eventType: evt.eventType || evt.eventName,
        eventCategory: evt.eventCategory,
        timestamp: evt.timestamp || now,
        serverReceivedAt: now,
        pageId: evt.pageId || null,
        page: evt.page || evt.sanitizedRoute || '/',
        sanitizedRoute: evt.sanitizedRoute || evt.page || '/',

        // Individual top-level fields
        pointerX: evt.pointerX ?? null,
        pointerY: evt.pointerY ?? null,
        pointerSpeedPxPerMs: evt.pointerSpeedPxPerMs ?? null,
        pointerAngleDeg: evt.pointerAngleDeg ?? null,
        pointerDistancePx: evt.pointerDistancePx ?? null,
        isStraightLine: evt.isStraightLine ?? null,
        pointerHoldDurationMs: evt.pointerHoldDurationMs ?? null,
        hoverDurationMs: evt.hoverDurationMs ?? null,
        targetCategory: evt.targetCategory ?? null,
        targetId: evt.targetId ?? null,
        textPreview: evt.textPreview ?? null,

        keyMasked: evt.keyMasked ?? null,
        flightTimeMs: evt.flightTimeMs ?? null,
        holdTimeMs: evt.holdTimeMs ?? null,
        keysPerSecond: evt.keysPerSecond ?? null,
        isTypingPause: evt.isTypingPause ?? null,

        fieldId: evt.fieldId ?? null,
        fieldCategory: evt.fieldCategory ?? null,
        fromField: evt.fromField ?? null,
        toField: evt.toField ?? null,
        fieldDurationMs: evt.fieldDurationMs ?? null,
        pasteDetected: evt.pasteDetected ?? null,
        formId: evt.formId ?? null,

        scrollY: evt.scrollY ?? null,
        scrollDirection: evt.scrollDirection ?? null,
        scrollDeltaPx: evt.scrollDeltaPx ?? null,
        scrollDepthPercent: evt.scrollDepthPercent ?? null,
        scrollMilestone: evt.scrollMilestone ?? null,

        touchCount: evt.touchCount ?? null,
        touchDurationMs: evt.touchDurationMs ?? null,
        gestureType: evt.gestureType ?? null,
        swipeDirection: evt.swipeDirection ?? null,
        swipeDistancePx: evt.swipeDistancePx ?? null,
        orientation: evt.orientation ?? null,

        fromRoute: evt.fromRoute ?? null,
        toRoute: evt.toRoute ?? null,
        navigationMethod: evt.navigationMethod ?? null,
        visibilityState: evt.visibilityState ?? null,
        tabActive: evt.tabActive ?? null,
        idleDurationMs: evt.idleDurationMs ?? null,
        pageLoadTimeMs: evt.pageLoadTimeMs ?? null,
        domContentLoadedMs: evt.domContentLoadedMs ?? null,
        ttfbMs: evt.ttfbMs ?? null,

        flowType: evt.flowType ?? null,
        paymentId: evt.paymentId ?? null,
        paymentAmount: evt.paymentAmount ?? null,
        paymentCurrency: evt.paymentCurrency ?? null,
        recipientType: evt.recipientType ?? null,
        paymentStatus: evt.paymentStatus ?? null,
        reasonCode: evt.reasonCode ?? null,
        challengeType: evt.challengeType ?? null,
        accountCategory: evt.accountCategory ?? null,

        deviceCategory: evt.deviceCategory || evt.device?.category || 'unknown',
        deviceOs: evt.deviceOs || evt.device?.os || 'unknown',
        deviceBrowser: evt.deviceBrowser || evt.device?.browser || 'unknown',
        screenWidth: evt.screenWidth ?? evt.device?.screenWidth ?? null,
        screenHeight: evt.screenHeight ?? evt.device?.screenHeight ?? null,
        batteryLevel: evt.batteryLevel ?? evt.device?.batteryLevel ?? null,
        isCharging: evt.isCharging ?? evt.device?.isCharging ?? null,

        properties: evt.properties || {},
        device: evt.device || {},
        sdkVersion: evt.sdkVersion || '2.1.0',
        schemaVersion: evt.schemaVersion || '2.0',
      };

      eventDocs.push(eventDoc);

      // Idempotent upsert by eventId
      ops.push({
        updateOne: {
          filter: { eventId: evt.eventId },
          update: { $setOnInsert: eventDoc },
          upsert: true,
        },
      });

      // Track session metrics to update in bulk
      const sessKey = evt.sessionId;
      if (!sessionUpdates.has(sessKey)) {
        sessionUpdates.set(sessKey, {
          sessionId: evt.sessionId,
          tenantId: eventDoc.tenantId,
          clientId: eventDoc.clientId,
          userId: effectiveUserId,
          anonymousId: evt.anonymousId || null,
          device: evt.device || {},
          interactionCount: 0,
          maxScrollDepth: 0,
          routes: new Set(),
        });
      }
      const sData = sessionUpdates.get(sessKey);
      if (['pointer', 'keyboard', 'touch', 'form', 'navigation', 'auth', 'banking', 'checkout'].includes(evt.eventCategory)) {
        sData.interactionCount += 1;
      }
      const scrollDepth = typeof evt.scrollDepthPercent === 'number'
        ? evt.scrollDepthPercent
        : (evt.properties && typeof evt.properties.scrollDepth === 'number' ? evt.properties.scrollDepth : null);
      if (scrollDepth !== null) {
        sData.maxScrollDepth = Math.max(sData.maxScrollDepth, scrollDepth);
      }
      if (evt.sanitizedRoute) {
        sData.routes.add(evt.sanitizedRoute);
      }

      // If page engagement event, prepare doc
      if (evt.eventCategory === 'engagement' && evt.properties && evt.properties.pageViewId) {
        pageEngagements.push({
          pageViewId: evt.properties.pageViewId,
          sessionId: evt.sessionId,
          userId: effectiveUserId,
          tenantId: eventDoc.tenantId,
          pageId: evt.pageId || null,
          sanitizedRoute: evt.sanitizedRoute || '/',
          entryTimestamp: evt.properties.entryTimestamp ? new Date(evt.properties.entryTimestamp) : now,
          exitTimestamp: evt.properties.exitTimestamp ? new Date(evt.properties.exitTimestamp) : null,
          elapsedDurationMs: Number(evt.properties.elapsedDurationMs) || 0,
          activeDurationMs: Number(evt.properties.activeDurationMs) || 0,
          visibleDurationMs: Number(evt.properties.visibleDurationMs) || 0,
          idleDurationMs: Number(evt.properties.idleDurationMs) || 0,
          maxScrollDepth: Number(evt.properties.maxScrollDepth) || 0,
          interactionCount: Number(evt.properties.interactionCount) || 0,
          navigationSource: evt.properties.navigationSource || null,
          exitReason: evt.properties.exitReason || null,
        });
      }
    }

    // Persist events through active database adapter
    const activeType = databaseRegistry.getActiveType();
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      await activeAdapter.saveEvents(eventDocs);
    } else {
      // Execute bulk write for Mongo events
      if (ops.length > 0) {
        await BehaviourEvent.bulkWrite(ops, { ordered: false });
      }
    }

    // Upsert sessions if Mongo is available
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      for (const [, sData] of sessionUpdates.entries()) {
        await BehaviourSession.updateOne(
          { sessionId: sData.sessionId },
          {
            $setOnInsert: {
              sessionId: sData.sessionId,
              tenantId: sData.tenantId,
              anonymousId: sData.anonymousId,
              startedAt: now,
              deviceMetadata: sData.device,
              ipAddress: clientIp,
            },
            $set: {
              lastActivityAt: now,
              status: 'active',
              ...(sData.userId ? { userId: sData.userId } : {}),
            },
            $inc: {
              'sessionSummary.interactionCount': sData.interactionCount,
              'sessionSummary.pageCount': sData.routes.size,
            },
            $max: {
              'sessionSummary.maxScrollDepth': sData.maxScrollDepth,
            },
          },
          { upsert: true }
        );
      }

      // Upsert page engagements if any
      for (const pe of pageEngagements) {
        await PageEngagement.updateOne(
          { pageViewId: pe.pageViewId },
          {
            $setOnInsert: {
              pageViewId: pe.pageViewId,
              sessionId: pe.sessionId,
              tenantId: pe.tenantId,
              pageId: pe.pageId,
              sanitizedRoute: pe.sanitizedRoute,
              entryTimestamp: pe.entryTimestamp,
            },
            $set: {
              exitTimestamp: pe.exitTimestamp,
              elapsedDurationMs: pe.elapsedDurationMs,
              activeDurationMs: pe.activeDurationMs,
              visibleDurationMs: pe.visibleDurationMs,
              idleDurationMs: pe.idleDurationMs,
              maxScrollDepth: pe.maxScrollDepth,
              interactionCount: pe.interactionCount,
              navigationSource: pe.navigationSource,
              exitReason: pe.exitReason,
              ...(pe.userId ? { userId: pe.userId } : {}),
            },
          },
          { upsert: true }
        );
      }
    }

    return { ok: true, acceptedCount: events.length, activeDatabase: activeType };
  }

  /**
   * Start a session explicitly.
   */
  async startSession({ sessionId, anonymousId, tenantId, startedAt, deviceMetadata, authenticatedUser, ipAddress }) {
    const now = startedAt || new Date();
    const effectiveUserId = authenticatedUser && authenticatedUser.userId ? authenticatedUser.userId : null;

    const session = await BehaviourSession.findOneAndUpdate(
      { sessionId },
      {
        $setOnInsert: {
          sessionId,
          tenantId: tenantId || (authenticatedUser && authenticatedUser.tenantId) || 'default',
          anonymousId: anonymousId || null,
          startedAt: now,
          deviceMetadata: deviceMetadata || {},
          ipAddress: ipAddress || null,
        },
        $set: {
          lastActivityAt: now,
          status: 'active',
          ...(effectiveUserId ? { userId: effectiveUserId } : {}),
        },
      },
      { upsert: true, new: true }
    );

    return { ok: true, session };
  }

  /**
   * End a session explicitly.
   */
  async endSession({ sessionId, endedAt, summary }) {
    const now = endedAt || new Date();
    const session = await BehaviourSession.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          endedAt: now,
          lastActivityAt: now,
          status: 'ended',
          ...(summary ? { 'sessionSummary.finalSummary': summary } : {}),
        },
      },
      { new: true }
    );

    return { ok: true, session };
  }

  /**
   * Securely link an anonymous pre-login session to an authenticated user account.
   */
  async linkSession({ sessionId, userId, anonymousId }) {
    const now = new Date();

    // 1. Update session record
    const session = await BehaviourSession.findOneAndUpdate(
      { sessionId },
      {
        $set: {
          userId,
          linkedAt: now,
          ...(anonymousId ? { anonymousId } : {}),
        },
      },
      { new: true, upsert: true }
    );

    // 2. Backfill userId on all pre-login events for this session
    const activeType = databaseRegistry.getActiveType();
    let backfilledCount = 0;
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      const linkRes = await activeAdapter.linkSessionEvents(sessionId, userId, 'default');
      backfilledCount = linkRes.modifiedCount;
    } else {
      const eventResult = await BehaviourEvent.updateMany(
        { sessionId, userId: null },
        { $set: { userId } }
      );
      backfilledCount = eventResult.modifiedCount;
    }

    // 3. Backfill page engagements
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      await PageEngagement.updateMany(
        { sessionId, userId: null },
        { $set: { userId } }
      );

      // 4. Record audit event for identity linking
      await BehaviourEvent.create({
        eventId: `link_${sessionId}_${Date.now()}`,
        sessionId,
        userId,
        anonymousId: anonymousId || null,
        tenantId: session ? (session.tenantId || 'default') : 'default',
        eventName: 'session_linked',
        eventCategory: 'session',
        timestamp: now,
        serverReceivedAt: now,
        sanitizedRoute: '/auth/login',
        properties: {
          linkedAt: now.toISOString(),
          backfilledEventsCount: backfilledCount,
        },
        device: session ? (session.deviceMetadata || {}) : {},
      });
    }

    return {
      ok: true,
      sessionId,
      userId,
      backfilledCount,
    };
  }

  /**
   * Query events for a user with pagination and filters.
   */
  async getUserEvents({ userId, tenantId, page = 1, limit = 50, startDate, endDate, eventCategory, sessionId }) {
    const activeType = databaseRegistry.getActiveType();
    const effectiveTenantId = tenantId || 'default';
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      let res = await activeAdapter.getUserEvents(userId, effectiveTenantId, {
        sessionId,
        eventCategory,
        startDate,
        endDate,
      }, { page, limit });
      if ((!res.events || res.events.length === 0) && effectiveTenantId !== 'default') {
        const fallback = await activeAdapter.getUserEvents(userId, 'default', {
          sessionId,
          eventCategory,
          startDate,
          endDate,
        }, { page, limit });
        if (fallback.events && fallback.events.length > 0) return fallback;
      }
      return res;
    }

    const query = { userId };

    if (sessionId) {
      query.sessionId = sessionId;
    }
    if (eventCategory) {
      query.eventCategory = eventCategory;
    }
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const safePage = Math.max(1, Number(page) || 1);
    const skip = (safePage - 1) * safeLimit;

    const [events, total] = await Promise.all([
      BehaviourEvent.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      BehaviourEvent.countDocuments(query),
    ]);

    return {
      events,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Query sessions for a user.
   */
  async getUserSessions({ userId, page = 1, limit = 20 }) {
    const query = { userId };
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const safePage = Math.max(1, Number(page) || 1);
    const skip = (safePage - 1) * safeLimit;

    const [sessions, total] = await Promise.all([
      BehaviourSession.find(query)
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
      BehaviourSession.countDocuments(query),
    ]);

    return {
      sessions,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Compute comprehensive behavioural summary for a user.
   */
  async getUserSummary({ userId, tenantId }) {
    const activeType = databaseRegistry.getActiveType();
    const effectiveTenantId = tenantId || 'default';
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      return await activeAdapter.getUserSummary(userId, effectiveTenantId);
    }

    const [eventsCount, sessions, pageEngagements, payments, categoryStats] = await Promise.all([
      BehaviourEvent.countDocuments({ userId }),
      BehaviourSession.find({ userId }).sort({ startedAt: -1 }).lean(),
      PageEngagement.find({ userId }).sort({ entryTimestamp: -1 }).lean(),
      PaymentRecord.find({ userId }).sort({ createdAt: -1 }).lean(),
      BehaviourEvent.aggregate([
        { $match: { userId } },
        { $group: { _id: '$eventCategory', count: { $sum: 1 } } },
      ]),
    ]);

    // Aggregate category counts
    const categoryBreakdown = {};
    for (const stat of categoryStats) {
      categoryBreakdown[stat._id] = stat.count;
    }

    // Aggregate visited pages and times
    const pageVisits = {};
    let totalActiveDurationMs = 0;
    let maxOverallScrollDepth = 0;

    for (const pe of pageEngagements) {
      pageVisits[pe.sanitizedRoute] = (pageVisits[pe.sanitizedRoute] || 0) + 1;
      totalActiveDurationMs += pe.activeDurationMs || 0;
      maxOverallScrollDepth = Math.max(maxOverallScrollDepth, pe.maxScrollDepth || 0);
    }

    // Payment journey summary
    const paymentSummary = {
      totalTransactions: payments.length,
      succeeded: payments.filter((p) => p.status === 'succeeded').length,
      failed: payments.filter((p) => p.status === 'failed').length,
      pending: payments.filter((p) => p.status === 'pending').length,
      cancelled: payments.filter((p) => p.status === 'cancelled').length,
      recentRecords: payments.slice(0, 5),
    };

    return {
      userId,
      totalEvents: eventsCount,
      totalSessions: sessions.length,
      firstSeenAt: sessions.length > 0 ? sessions[sessions.length - 1].startedAt : null,
      lastSeenAt: sessions.length > 0 ? sessions[0].lastActivityAt : null,
      categoryBreakdown,
      pageVisits,
      engagement: {
        totalActiveDurationMs,
        maxScrollDepth: maxOverallScrollDepth,
        recordedPageEngagementsCount: pageEngagements.length,
      },
      paymentSummary,
    };
  }

  /**
   * Get events for a specific session with authorization check.
   */
  async getSessionEvents({ sessionId, page = 1, limit = 100, authenticatedUser }) {
    const session = await BehaviourSession.findOne({ sessionId }).lean();
    if (!session) {
      return { session: null, events: [], pagination: { total: 0, page: 1, limit, totalPages: 0 } };
    }

    // If requester is a standard user, ensure session belongs to them
    if (
      authenticatedUser &&
      authenticatedUser.role !== 'admin' &&
      authenticatedUser.role !== 'service' &&
      session.userId &&
      session.userId !== authenticatedUser.userId
    ) {
      const err = new Error('Forbidden: session belongs to another user');
      err.status = 403;
      throw err;
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const safePage = Math.max(1, Number(page) || 1);
    const skip = (safePage - 1) * safeLimit;

    let events;
    let total;

    const activeType = databaseRegistry.getActiveType();
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      const res = await activeAdapter.getSessionEvents(sessionId, 'default', { page: safePage, limit: safeLimit });
      events = res.events;
      total = res.pagination.total;
    } else {
      const [mEvents, mTotal] = await Promise.all([
        BehaviourEvent.find({ sessionId })
          .sort({ timestamp: 1 })
          .skip(skip)
          .limit(safeLimit)
          .lean(),
        BehaviourEvent.countDocuments({ sessionId }),
      ]);
      events = mEvents;
      total = mTotal;
    }

    return {
      session,
      events,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
      },
    };
  }

  /**
   * Backend payment verification (authoritative callback or verification).
   */
  async verifyPayment(dto) {
    const now = new Date();

    const payment = await PaymentRecord.findOneAndUpdate(
      { paymentId: dto.paymentId },
      {
        $set: {
          orderId: dto.orderId,
          userId: dto.userId,
          sessionId: dto.sessionId,
          tenantId: dto.tenantId || 'default',
          amount: dto.amount,
          currency: dto.currency || 'USD',
          status: dto.status,
          paymentMethodCategory: dto.paymentMethodCategory || 'card',
          failureReason: dto.failureReason || null,
          verifiedAt: now,
          verifiedBy: 'server_verification',
          metadata: dto.metadata || {},
        },
      },
      { upsert: true, new: true }
    );

    // Emit verified payment event
    await BehaviourEvent.create({
      eventId: `pay_${dto.paymentId}_${Date.now()}`,
      sessionId: dto.sessionId,
      userId: dto.userId,
      tenantId: dto.tenantId || 'default',
      eventName: `payment_${dto.status}`,
      eventCategory: 'payment',
      timestamp: now,
      serverReceivedAt: now,
      sanitizedRoute: '/checkout/payment',
      properties: {
        paymentId: dto.paymentId,
        orderId: dto.orderId,
        amount: dto.amount,
        currency: dto.currency || 'USD',
        status: dto.status,
        paymentMethodCategory: dto.paymentMethodCategory,
        failureReason: dto.failureReason || null,
        serverVerified: true,
      },
    });

    // Update session payment status
    await BehaviourSession.updateOne(
      { sessionId: dto.sessionId },
      { $set: { 'sessionSummary.paymentStatus': dto.status } }
    );

    return { ok: true, payment };
  }

  /**
   * Delete user data for privacy / GDPR right to be forgotten.
   */
  async deleteUserData({ userId }) {
    const activeType = databaseRegistry.getActiveType();
    let deletedEvents = 0;
    if (activeType === 'postgresql') {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      const res = await activeAdapter.deleteUserData(userId, 'default');
      deletedEvents = res.deletedCount;
    } else {
      const eventsDel = await BehaviourEvent.deleteMany({ userId });
      deletedEvents = eventsDel.deletedCount;
    }

    let peDelCount = 0;
    let payDelCount = 0;
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      const [peDel, payDel] = await Promise.all([
        PageEngagement.deleteMany({ userId }),
        PaymentRecord.deleteMany({ userId }),
        BehaviourSession.updateMany({ userId }, { $set: { userId: null, anonymousId: 'anonymized' } }),
      ]);
      peDelCount = peDel.deletedCount;
      payDelCount = payDel.deletedCount;
    }

    return {
      ok: true,
      deletedEvents,
      deletedEngagements: peDelCount,
      deletedPayments: payDelCount,
    };
  }
}

module.exports = new AnalyticsService();
